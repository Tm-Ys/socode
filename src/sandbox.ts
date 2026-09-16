import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { AgentMode } from "./mode.js";
import { workspaceModeLabel } from "./mode.js";

export type FileOp = "create" | "modify" | "delete" | "exec";

const DENY_WRITE_DIRS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/private/etc",
  "/dev",
  "/proc",
  "/sys",
  "/root",
];

const SECRET_DIR_NAMES = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".config/gcloud"];
const SECRET_FILE_NAMES = [".netrc", ".npmrc", ".pypirc", ".git-credentials"];
const SECRET_REL_FILES = [".docker/config.json"];
const SECRET_BASENAMES = new Set([".env", "providers.json"]);

const SHELL_META = /[;&|`$()<>\n]|&&|\|\|/;
const READONLY_BINS = new Set([
  "ls",
  "pwd",
  "whoami",
  "date",
  "uname",
  "which",
  "true",
  "false",
  "hostname",
  "id",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "file",
  "stat",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "paste",
  "comm",
  "cmp",
  "diff",
  "md5",
  "md5sum",
  "sha256sum",
  "shasum",
  "cksum",
  "seq",
  "sleep",
  "test",
  "[",
  "[[",
  "type",
  "jq",
]);
const DELETE_BINS = new Set(["rm", "rmdir", "unlink", "shred"]);
const MODIFY_BINS = new Set(["mv", "cp", "chmod", "chown", "ln", "truncate", "tee", "install"]);
const CREATE_BINS = new Set(["mkdir", "touch", "install"]);
const NEVER_READONLY_BINS = new Set([
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "osascript",
  "curl",
  "wget",
  "git",
  "kill",
  "pkill",
  "sudo",
  "su",
  "dd",
  "mkfs",
]);
const SHELL_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "time",
  "coproc",
  "{",
  "}",
  "(",
  "[[",
]);

const HARD_DENY_BINS = new Set(["sudo", "su", "dd", "mkfs", "reboot", "shutdown"]);
const NEVER_ALWAYS_BINS = new Set([
  "sudo",
  "su",
  "dd",
  "mkfs",
  "curl",
  "wget",
  "python",
  "python3",
  "node",
  "perl",
  "ruby",
  "osascript",
  "kill",
  "pkill",
]);
const WRAPPER_BINS = new Set([
  "env",
  "xargs",
  "nohup",
  "nice",
  "timeout",
  "watch",
  "stdbuf",
  "bash",
  "sh",
  "zsh",
  "dash",
  "command",
  "eval",
  "exec",
]);

export function resolvePath(input: string) {
  const path = input.trim();
  if (!path) throw new Error("缺少路径");
  if (!isAbsolute(path)) throw new Error(`必须是绝对路径，收到: ${path}`);
  return normalize(path);
}

export function realExistingPath(input: string) {
  const path = resolvePath(input);
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  let real = current;
  try {
    if (existsSync(current)) real = realpathSync(current);
  } catch {
    real = current;
  }
  return missing.reduce((dir, name) => join(dir, name), real);
}

export function isInsideWorkspace(workspace: string, path: string) {
  const root = normalize(resolve(workspace));
  const target = normalize(path);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function denyReason(path: string): string | null {
  const target = normalize(path);
  const base = basename(target);
  if (SECRET_BASENAMES.has(base) || (/^\.env\./.test(base) && base !== ".env.example")) {
    return `拒绝访问受保护文件: ${base}`;
  }
  const home = homedir();
  for (const dir of [
    ...DENY_WRITE_DIRS,
    ...SECRET_DIR_NAMES.map((name) => joinHome(home, name)),
  ]) {
    if (!dir) continue;
    if (target === dir || target.startsWith(`${dir}${sep}`)) {
      return `拒绝访问受保护路径: ${dir}`;
    }
  }
  for (const file of [
    ...SECRET_FILE_NAMES.map((name) => joinHome(home, name)),
    ...SECRET_REL_FILES.map((name) => joinHome(home, name)),
  ]) {
    if (file && target === file) return `拒绝访问受保护文件: ${file}`;
  }
  return null;
}

export function displayPath(workspace: string, path: string) {
  if (isInsideWorkspace(workspace, path)) {
    const rel = relative(workspace, path);
    return rel || ".";
  }
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}${sep}`)) return `~${path.slice(home.length)}`;
  return path;
}

export function writeKind(path: string): Exclude<FileOp, "exec" | "delete"> {
  return existsSync(path) ? "modify" : "create";
}

export function mutationDenied(
  mode: AgentMode,
  workspace: string,
  path: string,
  op: FileOp,
): string | null {
  const blocked = denyReason(path);
  if (blocked) return blocked;
  if (mode === "plan") {
    return `当前是 Plan 模式，不能${opLabel(op)}。请只给出计划，或让用户输入 /mode ask、/mode long 或 /mode full 后再执行。`;
  }
  if (mode !== "full" && !isInsideWorkspace(workspace, path)) {
    return `${workspaceModeLabel(mode)} 模式不能在工作区外${opLabel(op)}。路径: ${path}。需要的话请 /mode full。`;
  }
  return null;
}

export function classifyBash(command: string): { readonly: boolean; op: FileOp } {
  const text = command.trim();
  if (!text) return { readonly: true, op: "exec" };
  const parsed = parseBash(text);
  if (!parsed.ok) return { readonly: false, op: "exec" };
  let readonly = true;
  let op: FileOp = "exec";
  for (const argv of parsed.commands) {
    const kind = classifyArgv(argv, 0);
    if (!kind.readonly) readonly = false;
    op = worseOp(op, kind.op);
  }
  if (parsed.redirects) {
    readonly = false;
    op = worseOp(op, "modify");
  }
  return { readonly, op };
}

export function commandHead(command: string) {
  const parsed = parseBash(command);
  if (parsed.ok && parsed.commands[0]?.length) {
    const argv = unwrapArgv(parsed.commands[0]);
    const bin = argv[0] === "__script__" ? "sh" : argv[0];
    if (bin) return bin.replace(/^.*\//, "") || "sh";
  }
  const token = command.trim().split(/\s+/)[0] ?? "";
  return token.replace(/^.*\//, "") || "sh";
}

type BashParse = { ok: true; commands: string[][]; redirects: boolean } | { ok: false };

function parseBash(input: string): BashParse {
  const commands: string[][] = [];
  let cur: string[] = [];
  let token = "";
  let quote: "" | "'" | '"' = "";
  let redirects = false;
  let i = 0;
  const flushToken = () => {
    if (token !== "") {
      cur.push(token);
      token = "";
    }
  };
  const flushCmd = () => {
    flushToken();
    if (cur.length) commands.push(cur);
    cur = [];
  };
  const skipRedirectTarget = () => {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (input[i] === "&") {
      i += 1;
      while (i < input.length && /[0-9]/.test(input[i])) i += 1;
      return true;
    }
    if (i >= input.length) return false;
    const start = i;
    const one = readUnquotedToken();
    if (one === null) {
      i = start;
      return false;
    }
    return true;
  };
  const readUnquotedToken = (): string | null => {
    if (i >= input.length) return null;
    const c = input[i];
    if (/[\s;&|<>]/.test(c) || c === "\n") return null;
    let out = "";
    let q: "" | "'" | '"' = "";
    while (i < input.length) {
      const ch = input[i];
      if (q === "'") {
        if (ch === "'") q = "";
        else out += ch;
        i += 1;
        continue;
      }
      if (q === '"') {
        if (ch === '"') {
          q = "";
          i += 1;
          continue;
        }
        if (ch === "`" || (ch === "$" && input[i + 1] === "(")) return null;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        q = ch;
        i += 1;
        continue;
      }
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (/[\s;&|<>]/.test(ch) || ch === "\n") break;
      if (ch === "`" || (ch === "$" && input[i + 1] === "(") || (ch === "<" && input[i + 1] === "(") || (ch === ">" && input[i + 1] === "(")) {
        return null;
      }
      out += ch;
      i += 1;
    }
    if (q) return null;
    return out;
  };

  while (i < input.length) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else token += c;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = "";
        i += 1;
        continue;
      }
      if (c === "\\" && i + 1 < input.length) {
        token += input[i + 1];
        i += 2;
        continue;
      }
      if (c === "`" || (c === "$" && input[i + 1] === "(")) return { ok: false };
      token += c;
      i += 1;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      token += input[i + 1];
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === "`" || (c === "$" && input[i + 1] === "(") || (c === "<" && input[i + 1] === "(") || (c === ">" && input[i + 1] === "(")) {
      return { ok: false };
    }
    if (c === "#" && token === "" && (i === 0 || /\s/.test(input[i - 1]))) {
      while (i < input.length && input[i] !== "\n") i += 1;
      continue;
    }
    if (c === "\n" || c === ";") {
      flushCmd();
      i += 1;
      continue;
    }
    if (c === "&") {
      flushCmd();
      i += input[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "|") {
      flushCmd();
      i += input[i + 1] === "|" ? 2 : 1;
      continue;
    }
    const fdRedirect = token === "" && /[0-9]/.test(c) && (input[i + 1] === ">" || input[i + 1] === "<");
    if (c === "<" || c === ">" || fdRedirect) {
      redirects = true;
      flushToken();
      if (fdRedirect) i += 1;
      if (input[i] === ">" && input[i + 1] === ">") i += 2;
      else if (input[i] === "<" && input[i + 1] === "<") i += 2;
      else i += 1;
      if (input[i] === "&" || input[i] === ">" || input[i] === "|") i += 1;
      if (!skipRedirectTarget()) return { ok: false };
      continue;
    }
    if (/\s/.test(c)) {
      flushToken();
      i += 1;
      continue;
    }
    token += c;
    i += 1;
  }
  if (quote) return { ok: false };
  flushCmd();
  return { ok: true, commands, redirects };
}

function unwrapArgv(argv: string[]): string[] {
  const a = [...argv];
  while (a[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
  if (!a.length) return a;
  const bin = a[0].replace(/^.*\//, "");
  if (bin === "env") {
    a.shift();
    while (a[0] && /^-/.test(a[0])) {
      if ((a[0] === "-u" || a[0] === "--unset" || a[0] === "-C" || a[0] === "-S") && a[1]) {
        a.splice(0, 2);
        continue;
      }
      if (a[0] === "-i" || a[0] === "--ignore-environment") return ["__script__", ""];
      a.shift();
    }
    while (a[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
    return unwrapArgv(a);
  }
  if (bin === "timeout") {
    a.shift();
    while (a[0]?.startsWith("-")) {
      if (/^-[ks]$/.test(a[0]) && a[1]) {
        a.splice(0, 2);
        continue;
      }
      a.shift();
    }
    if (a[0] && /^\d/.test(a[0])) a.shift();
    return unwrapArgv(a);
  }
  if (bin === "xargs") {
    a.shift();
    while (a[0]?.startsWith("-")) {
      if (["-I", "-i", "-n", "-P", "-L", "-E", "-s"].includes(a[0]) && a[1]) {
        a.splice(0, 2);
        continue;
      }
      a.shift();
    }
    return unwrapArgv(a);
  }
  if (WRAPPER_BINS.has(bin) && bin !== "eval" && !["bash", "sh", "zsh", "dash"].includes(bin)) {
    a.shift();
    while (a[0]?.startsWith("-")) {
      if (bin === "stdbuf" && /^-[ioe]$/.test(a[0]) && a[1]) {
        a.splice(0, 2);
        continue;
      }
      a.shift();
    }
    return unwrapArgv(a);
  }
  if (["bash", "sh", "zsh", "dash"].includes(bin)) {
    const cAt = a.findIndex((item) => item === "-c");
    if (cAt >= 0 && a[cAt + 1] !== undefined) return ["__script__", a[cAt + 1]];
  }
  if (bin === "eval") return ["__script__", a.slice(1).join(" ")];
  return a;
}

function classifyArgv(argv: string[], depth: number): { readonly: boolean; op: FileOp } {
  if (depth > 4) return { readonly: false, op: "exec" };
  const unwrapped = unwrapArgv(argv);
  if (!unwrapped.length) return { readonly: false, op: "exec" };
  if (unwrapped[0] === "__script__") {
    const script = unwrapped[1] ?? "";
    if (!script.trim()) return { readonly: false, op: "exec" };
    const inner = parseBash(script);
    if (!inner.ok) return { readonly: false, op: "exec" };
    let readonly = !inner.redirects;
    let op: FileOp = inner.redirects ? "modify" : "exec";
    for (const innerArgv of inner.commands) {
      const kind = classifyArgv(innerArgv, depth + 1);
      if (!kind.readonly) readonly = false;
      op = worseOp(op, kind.op);
    }
    return { readonly, op };
  }
  const bin = unwrapped[0].replace(/^.*\//, "") || "sh";
  const rest = unwrapped.slice(1);
  if (SHELL_KEYWORDS.has(bin) && bin !== "[[") return { readonly: false, op: "exec" };
  if (HARD_DENY_BINS.has(bin)) return { readonly: false, op: "exec" };
  if (DELETE_BINS.has(bin) || (bin === "git" && rest[0] === "clean")) return { readonly: false, op: "delete" };
  if (bin === "git" && ["rm", "mv", "checkout", "reset", "stash", "rebase", "commit", "add", "push"].includes(rest[0] ?? "")) {
    return { readonly: false, op: "modify" };
  }
  if (
    (bin === "sed" && rest.some((arg) => arg === "-i" || arg.startsWith("-i"))) ||
    (bin === "perl" && rest.some((arg) => arg === "-pi" || arg.startsWith("-i"))) ||
    (bin === "find" && rest.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-ok" || arg === "-fprint"))
  ) {
    return { readonly: false, op: "modify" };
  }
  if (MODIFY_BINS.has(bin)) return { readonly: false, op: "modify" };
  if (
    CREATE_BINS.has(bin) ||
    (["npm", "pnpm", "yarn", "bun", "pip", "cargo", "brew"].includes(bin) &&
      ["i", "install", "add", "uninstall", "remove"].includes(rest[0] ?? ""))
  ) {
    return { readonly: false, op: "create" };
  }
  if (NEVER_READONLY_BINS.has(bin)) return { readonly: false, op: "exec" };
  if (["awk", "sed"].includes(bin) && rest.some((arg) => arg.includes(">"))) return { readonly: false, op: "modify" };
  if (READONLY_BINS.has(bin) || bin === "sed" || bin === "awk" || bin === "find") {
    return { readonly: true, op: "exec" };
  }
  return { readonly: false, op: "exec" };
}

function worseOp(current: FileOp, next: FileOp): FileOp {
  const rank = { exec: 0, create: 1, modify: 2, delete: 3 };
  return rank[next] >= rank[current] ? next : current;
}

export function bashAlwaysAsk(command: string) {
  if (SHELL_META.test(command)) return true;
  const head = commandHead(command);
  if (NEVER_ALWAYS_BINS.has(head) || WRAPPER_BINS.has(head)) return true;
  for (const bin of NEVER_ALWAYS_BINS) {
    if (new RegExp(`(?:^|[\\s;/])${bin}(?:\\s|$)`).test(command)) return true;
  }
  return false;
}

export function bashHardDenied(mode: AgentMode, command: string): string | null {
  if (mode === "full") return null;
  const head = commandHead(command);
  if (HARD_DENY_BINS.has(head)) {
    return `${workspaceModeLabel(mode)} 模式禁止 ${head}。需要的话请 /mode full。`;
  }
  for (const bin of HARD_DENY_BINS) {
    if (new RegExp(`(?:^|[\\s;/])${bin}(?:\\s|$)`).test(command)) {
      return `${workspaceModeLabel(mode)} 模式禁止 ${bin}。需要的话请 /mode full。`;
    }
  }
  return null;
}

export function extractAbsolutePaths(command: string, cwd: string) {
  const found: string[] = [];
  const home = homedir();
  const add = (raw: string) => {
    if (!raw) return;
    found.push(raw);
  };
  const re = /(?:^|[\s"'=<>])(~(?:\/[^\s"';|&<>]*)?|\/[^\s"';|&<>]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) {
    let raw = match[1];
    if (raw === "~") raw = home;
    else if (raw.startsWith("~/")) raw = `${home}${raw.slice(1)}`;
    if (isAbsolute(raw)) add(raw);
  }
  if (/(^|[\s;&|])>(?!>)/.test(command) || />>/.test(command)) {
    const redirect = command.match(/(?:^|[\s;&|])>>?\s*([^\s;&|]+)/);
    if (redirect?.[1] && !redirect[1].startsWith("/") && !redirect[1].startsWith("~")) {
      add(join(cwd, redirect[1]));
    }
  }
  for (const token of command.match(/[^\s;|&<>`]+/g) ?? []) {
    if (!token || token.startsWith("-")) continue;
    const cleaned = token.replace(/^['"]|['"]$/g, "");
    const base = basename(cleaned.replace(/\/+$/, ""));
    const looksSecret = SECRET_BASENAMES.has(base) || (/^\.env\./.test(base) && base !== ".env.example");
    const looksPath =
      cleaned.startsWith("/") ||
      cleaned.startsWith("~") ||
      cleaned.startsWith(".") ||
      cleaned.includes("/");
    if (!looksSecret && !looksPath) continue;
    let raw = cleaned;
    if (raw === "~") raw = home;
    else if (raw.startsWith("~/")) raw = `${home}${raw.slice(1)}`;
    else if (!isAbsolute(raw)) raw = join(cwd, raw);
    add(raw);
  }
  return found;
}

export function bashEscapesWorkspace(mode: AgentMode, workspace: string, cwd: string, command: string) {
  if (mode === "full") {
    for (const path of extractAbsolutePaths(command, cwd)) {
      const real = realExistingPath(path);
      const blocked = denyReason(real);
      if (blocked) return blocked;
    }
    return null;
  }
  for (const path of extractAbsolutePaths(command, cwd)) {
    const real = realExistingPath(path);
    const blocked = mutationDenied(mode, workspace, real, classifyBash(command).op);
    if (blocked) return blocked;
  }
  return null;
}

export function opLabel(op: FileOp) {
  if (op === "create") return "创建文件";
  if (op === "modify") return "修改文件";
  if (op === "delete") return "删除文件";
  return "执行命令";
}

export type BashSandbox = {
  workspace?: string;
  cwd?: string;
  confineWrites?: boolean;
};

export function bashSpawn(command: string, sandbox?: BashSandbox): {
  file: string;
  args: string[];
  fallback?: { file: string; args: string[] };
  unavailable?: string;
} {
  const direct = { file: "/bin/bash", args: ["-c", command] };
  if (!sandbox?.confineWrites) {
    if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
      return {
        file: "/usr/bin/sandbox-exec",
        args: ["-p", seatbeltProfile(sandbox), "/bin/bash", "-c", command],
        fallback: { ...direct, args: ["-c", `${command}`] },
      };
    }
    return { ...direct, fallback: undefined, unavailable: undefined };
  }

  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-p", seatbeltProfile(sandbox), "/bin/bash", "-c", command],
    };
  }
  if (process.platform === "linux" && existsSync("/usr/bin/bwrap") && sandbox.workspace) {
    const root = normalize(resolve(sandbox.workspace));
    const cwd = sandbox.cwd ?? root;
    return {
      file: "/usr/bin/bwrap",
      args: [
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--bind",
        root,
        root,
        "--chdir",
        cwd,
        "/bin/bash",
        "-c",
        command,
      ],
    };
  }
  return {
    ...direct,
    unavailable: "Ask 模式无法启用 OS 沙箱（需要 macOS sandbox-exec 或 Linux bwrap），已拒绝执行",
  };
}

export function shouldFallbackSandbox(stderr: string, code: number | null) {
  return code === 71 || /sandbox_apply|sandbox-exec:/i.test(stderr);
}

export function scrubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^(api_key|API|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|DATABASE_URL)$/i.test(key)) {
      continue;
    }
    if (/(secret|token|password|api[_-]?key)/i.test(key) && !/^PATH|HOME|USER|SHELL|TERM|TMPDIR|LANG|LC_/i.test(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function seatbeltProfile(sandbox?: BashSandbox) {
  const home = homedir();
  const writeDirs = [
    ...DENY_WRITE_DIRS,
    ...SECRET_DIR_NAMES.map((name) => joinHome(home, name)),
  ].filter(Boolean);
  const secretFiles = [
    ...SECRET_FILE_NAMES.map((name) => joinHome(home, name)),
    ...SECRET_REL_FILES.map((name) => joinHome(home, name)),
  ].filter(Boolean);
  const denyWrite = writeDirs.map((dir) => `(subpath ${sb(dir)})`).join(" ");
  const denySecretDirs = SECRET_DIR_NAMES.map((name) => joinHome(home, name))
    .filter(Boolean)
    .map((dir) => `(subpath ${sb(dir)})`)
    .join(" ");
  const denySecretFiles = secretFiles.map((file) => `(literal ${sb(file)})`).join(" ");
  const secrets = `(deny file-read* ${denySecretDirs} ${denySecretFiles})(deny file-write* ${denySecretFiles})`;
  if (sandbox?.confineWrites && sandbox.workspace) {
    const root = normalize(resolve(sandbox.workspace));
    return `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${sb(root)}))${secrets}`;
  }
  return `(version 1)(allow default)(deny file-write* ${denyWrite})${secrets}`;
}

function sb(path: string) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\)/g, "\\)")}"`;
}

function joinHome(home: string, name: string) {
  return home ? `${home}${sep}${name}` : "";
}
