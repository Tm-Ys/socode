import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const INSTRUCTION_MAX_BYTES = 16_384;
export const SKILL_BODY_MAX_BYTES = 8_192;
export const SKILLS_BODY_BUDGET = 24_576;

/** Same directory: later files override earlier ones in the concatenated prompt. */
export const INSTRUCTION_BASENAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  "Claude.md",
  join(".claude", "CLAUDE.md"),
  "AGENTS.override.md",
  "CLAUDE.local.md",
  "AGENTS.local.md",
] as const;

export type InstructionFile = {
  path: string;
  label: string;
  scope: "user" | "project";
  body: string;
};

export type SkillRecord = {
  name: string;
  description: string;
  path: string;
  scope: "base" | "user" | "project";
  auto: boolean;
  body: string;
};

export type SkillBundle = {
  instructions: InstructionFile[];
  skills: SkillRecord[];
};

export function loadSkillBundle(workspace: string, opts?: { home?: string | null; bundled?: boolean }): SkillBundle {
  const root = resolve(workspace);
  const home = opts?.home === undefined ? homedir() : opts.home || "";
  const seen = new Set<string>();
  const instructions: InstructionFile[] = [];
  for (const file of instructionCandidates(root, home)) {
    const real = realPath(file.path);
    if (!real || seen.has(real)) continue;
    let body = readCapped(real, INSTRUCTION_MAX_BYTES);
    if (!body) continue;
    seen.add(real);
    body = expandIncludes(real, body, seen, 0);
    if (!body.trim()) continue;
    instructions.push({
      path: real,
      label: instructionLabel(file.path),
      scope: file.scope,
      body,
    });
  }
  return { instructions, skills: discoverSkills(root, home, opts?.bundled !== false) };
}

export function formatSkillPrompt(bundle: SkillBundle, workspace: string, activated: string[] = []) {
  const parts: string[] = [];
  if (bundle.instructions.length) {
    parts.push("# 项目说明");
    parts.push("按优先级从宽到窄排列，后者更具体。与系统提示或用户要求冲突时，以系统提示和用户为准。");
    for (const file of bundle.instructions) {
      const where = displayPath(workspace, file.path);
      parts.push(`## ${file.label} (\`${where}\`)\n\n${file.body}`);
    }
  }
  if (bundle.skills.length) {
    const loaded = pickLoadedSkills(bundle.skills, activated);
    const loadedPaths = new Set(loaded.map((skill) => skill.path));
    parts.push("# Skills");
    parts.push(
      "下列技能已发现。需要时用 `read` 读取对应 SKILL.md。已载入全文的技能直接遵守。",
    );
    for (const skill of bundle.skills) {
      const flag = loadedPaths.has(skill.path) ? " · 已载入全文" : "";
      const where = displayPath(workspace, skill.path);
      parts.push(`- \`${skill.name}\` — ${skill.description || "（无 description）"} (\`${where}\`${flag})`);
    }
    for (const skill of loaded) {
      parts.push(`## Skill: ${skill.name}\n\n${skill.body}`);
    }
  }
  return parts.join("\n\n");
}

export function formatSkillsCli(bundle: SkillBundle, workspace: string) {
  const lines: string[] = [];
  if (bundle.instructions.length) {
    lines.push("说明文件（已注入，后者优先）:");
    bundle.instructions.forEach((file, index) => {
      lines.push(`${index + 1}. ${displayPath(workspace, file.path)}  [${file.scope}]`);
    });
  } else {
    lines.push("说明文件: 未找到 AGENTS.md / CLAUDE.md");
  }
  lines.push("");
  if (!bundle.skills.length) {
    lines.push("Skills: 无。可放在 .socode/skills/<name>/SKILL.md、.claude/skills、.cursor/skills。");
    return lines.join("\n");
  }
  lines.push("Skills:");
  if (bundle.skills.some((skill) => skill.scope === "base")) {
    lines.push("基础 skill 默认不注入全文；软件工程请求会另询一次 LLM，最多激活 2 个。");
  }
  for (const skill of bundle.skills) {
    const flag = skill.auto ? "auto" : skill.scope === "base" ? "base" : "on-demand";
    lines.push(`- ${skill.name}  ${flag}  ${displayPath(workspace, skill.path)}`);
    if (skill.description) lines.push(`  ${skill.description}`);
  }
  return lines.join("\n");
}

export function parseSkillMarkdown(text: string, fallbackName: string) {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return { name: fallbackName, description: "", auto: true, body: trimmed.trim() };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end < 0) {
    return { name: fallbackName, description: "", auto: true, body: trimmed.trim() };
  }
  const raw = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\s+/, "");
  const meta = parseFrontmatter(raw);
  const name = sanitizeSkillName(meta.name) || fallbackName;
  const disabled = isTruthy(meta["disable-model-invocation"]) || isTruthy(meta.disable_model_invocation);
  return {
    name,
    description: (meta.description ?? "").trim(),
    auto: !disabled,
    body: body.trim(),
  };
}

function instructionLabel(path: string) {
  const base = basename(path);
  const parent = basename(dirname(path));
  if (parent.startsWith(".")) return `${parent}/${base}`;
  return base;
}

function instructionCandidates(workspace: string, home: string) {
  const out: Array<{ path: string; scope: "user" | "project" }> = [];
  if (home) {
    out.push(
      { path: join(home, ".claude", "CLAUDE.md"), scope: "user" },
      { path: join(home, ".socode", "AGENTS.md"), scope: "user" },
      { path: join(home, ".socode", "CLAUDE.md"), scope: "user" },
    );
  }
  const chain = directoryChain(workspace, home);
  for (const dir of chain) {
    for (const name of INSTRUCTION_BASENAMES) {
      if (name === "Claude.md" && existsSync(join(dir, "CLAUDE.md"))) continue;
      out.push({ path: join(dir, name), scope: "project" });
    }
  }
  return out;
}

function directoryChain(workspace: string, home: string) {
  const dirs: string[] = [];
  const root = resolve(workspace);
  const homeRoot = home ? resolve(home) : "";
  let current = root;
  for (let i = 0; i < 12; i += 1) {
    if (homeRoot && current === homeRoot && current !== root) break;
    dirs.push(current);
    const git = join(current, ".git");
    if (existsSync(git)) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs.reverse();
}

function discoverSkills(workspace: string, home: string, bundled: boolean) {
  const byName = new Map<string, SkillRecord>();
  const dirs: Array<{ dir: string; scope: SkillRecord["scope"] }> = [];
  if (bundled) dirs.push({ dir: bundledSkillsDir(), scope: "base" });
  if (home) {
    dirs.push(
      { dir: join(home, ".claude", "skills"), scope: "user" },
      { dir: join(home, ".cursor", "skills"), scope: "user" },
      { dir: join(home, ".socode", "skills"), scope: "user" },
    );
  }
  dirs.push(
    { dir: join(workspace, ".agents", "skills"), scope: "project" },
    { dir: join(workspace, ".claude", "skills"), scope: "project" },
    { dir: join(workspace, ".cursor", "skills"), scope: "project" },
    { dir: join(workspace, ".socode", "skills"), scope: "project" },
  );
  for (const { dir, scope } of dirs) {
    if (basename(dirname(dir)) === "skills-cursor") continue;
    for (const skill of readSkillDir(dir, scope)) {
      byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillDir(dir: string, scope: SkillRecord["scope"]): SkillRecord[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMd = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const raw = readCapped(skillMd, SKILL_BODY_MAX_BYTES + 2048);
    if (!raw) continue;
    const parsed = parseSkillMarkdown(raw, sanitizeSkillName(entry.name) || "skill");
    out.push({
      name: parsed.name,
      description: parsed.description,
      path: realPath(skillMd) || skillMd,
      scope,
      auto: parsed.auto,
      body: cap(parsed.body, SKILL_BODY_MAX_BYTES),
    });
  }
  return out;
}

function pickLoadedSkills(skills: SkillRecord[], activated: string[]) {
  const want = new Set(activated);
  const named = skills.filter((skill) => want.has(skill.name));
  const namedNames = new Set(named.map((skill) => skill.name));
  const auto = pickAutoSkills(skills.filter((skill) => !namedNames.has(skill.name)));
  return [...named, ...auto];
}

function bundledSkillsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../skills");
}

function pickAutoSkills(skills: SkillRecord[]) {
  const auto = skills.filter((skill) => skill.auto && skill.body);
  const picked: SkillRecord[] = [];
  let used = 0;
  for (const skill of auto) {
    const size = Buffer.byteLength(skill.body, "utf8");
    if (used + size > SKILLS_BODY_BUDGET) break;
    picked.push(skill);
    used += size;
  }
  return picked;
}

function expandIncludes(fromFile: string, body: string, seen: Set<string>, depth: number): string {
  if (depth >= 4) return body;
  return body.replace(/^@([^\s]+\.md)\s*$/gm, (_all, rel: string) => {
    const target = isAbsolute(rel) ? rel : join(dirname(fromFile), rel);
    const real = realPath(target);
    if (!real || seen.has(real)) return "";
    const included = readCapped(real, INSTRUCTION_MAX_BYTES);
    if (!included) return "";
    seen.add(real);
    return expandIncludes(real, included, seen, depth + 1);
  });
}

function parseFrontmatter(raw: string) {
  const meta: Record<string, string> = {};
  let key = "";
  for (const line of raw.split("\n")) {
    const folded = line.match(/^\s{2,}(.*)$/);
    if (folded && key) {
      meta[key] = `${meta[key]} ${folded[1].trim()}`.trim();
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith(">-") || value.startsWith(">")) value = value.replace(/^>-?\s*/, "");
    meta[key] = value;
  }
  return meta;
}

function sanitizeSkillName(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isTruthy(value: string | undefined) {
  if (!value) return false;
  return /^(true|yes|1)$/i.test(value.trim());
}

function readCapped(path: string, maxBytes: number) {
  try {
    if (!statSync(path).isFile()) return "";
    const text = readFileSync(path, "utf8").trim();
    if (!text) return "";
    return cap(text, maxBytes);
  } catch {
    return "";
  }
}

function cap(text: string, maxBytes: number) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n\n[已截断]`;
}

function realPath(path: string) {
  try {
    if (!existsSync(path)) return "";
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function displayPath(workspace: string, path: string) {
  const root = resolve(workspace);
  const rel = relative(root, path);
  if (rel && !rel.startsWith(`..${sep}`) && rel !== "..") return rel || ".";
  const home = homedir();
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}
