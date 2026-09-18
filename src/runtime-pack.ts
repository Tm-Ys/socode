import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { payloadHasSecrets } from "./remote-protocol.js";
import { userSocodeDir } from "./provider.js";

const FORBIDDEN_BASENAMES = new Set([
  "providers.json",
  ".env",
  ".env.local",
  ".env.production",
  ".DS_Store",
]);
const FORBIDDEN_DIR_NAMES = new Set(["node_modules", ".git", ".socode", "src", "docs", "release"]);
const TEST_FILE = /\.test\.[cm]?[jt]s$/i;
const PACK_FILE = /\.([cm]?js|json|md|txt|mjs)$/i;

export type PackedRuntime = {
  stamp: string;
  tarPath: string;
  files: string[];
};

export function defaultProjectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function runtimeCacheDir() {
  return join(userSocodeDir(), "cache", "runtime");
}

export function runtimeTarName(stamp: string) {
  return `socode-runtime-${stamp}.tar.gz`;
}

export function isForbiddenRel(rel: string) {
  const parts = rel.split(/[/\\]/).filter(Boolean);
  const base = parts.at(-1) ?? rel;
  if (FORBIDDEN_BASENAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (TEST_FILE.test(base)) return true;
  return parts.some((part) => FORBIDDEN_DIR_NAMES.has(part));
}

export function runtimeListingProblem(files: string[]): string | null {
  for (const raw of files) {
    const rel = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (!rel || rel === ".") continue;
    if (isForbiddenRel(rel)) return rel;
  }
  return null;
}

export function makeStamp(version: string, hash: string) {
  return `${version}+${hash}`;
}

export function hashFiles(root: string, files: string[]) {
  const hash = createHash("sha256");
  const rels = files
    .map((file) => relative(root, file).split(sep).join("/"))
    .filter(Boolean)
    .sort();
  for (const rel of rels) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(join(root, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 7);
}

export function listTarFiles(tarPath: string) {
  const listed = spawnSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  if (listed.status !== 0) {
    throw new Error(listed.stderr || `无法列出 ${tarPath}`);
  }
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function extractRuntime(tarPath: string, dest: string) {
  mkdirSync(dest, { recursive: true });
  const extracted = spawnSync("tar", ["-xzf", tarPath, "-C", dest], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (extracted.status !== 0) {
    throw new Error(extracted.stderr || `无法解压 ${tarPath}`);
  }
  return dest;
}

export function readRuntimeStamp(root = defaultProjectRoot()) {
  const stampFile = join(root, "runtime-stamp.json");
  if (existsSync(stampFile)) {
    try {
      const data = JSON.parse(readFileSync(stampFile, "utf8")) as { stamp?: unknown };
      if (typeof data.stamp === "string" && data.stamp.trim()) return data.stamp.trim();
    } catch {
      /* fall through */
    }
  }
  return readPackageVersion(root);
}

export function packRuntime(opts?: {
  projectRoot?: string;
  outDir?: string;
  distDir?: string;
  skillsDir?: string;
  workerEntry?: string;
  reuseCached?: boolean;
}): PackedRuntime {
  const projectRoot = resolve(opts?.projectRoot ?? defaultProjectRoot());
  const distDir = resolve(opts?.distDir ?? join(projectRoot, "dist"));
  const skillsDir = resolve(opts?.skillsDir ?? join(projectRoot, "skills"));
  const workerEntry = resolve(opts?.workerEntry ?? join(projectRoot, "bin", "worker-entry.mjs"));
  const version = readPackageVersion(projectRoot);

  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    throw new Error("找不到 dist/。请先运行 npm run build。");
  }
  if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
    throw new Error("找不到 skills/。runtime 需要基础 skill。");
  }
  if (!existsSync(workerEntry)) {
    throw new Error("找不到 bin/worker-entry.mjs。");
  }

  const stage = join(tmpdir(), `socode-runtime-stage-${process.pid}-${Date.now()}`);
  mkdirSync(stage, { recursive: true });
  try {
    copyPackedTree(distDir, join(stage, "dist"), (rel) => PACK_FILE.test(rel) && !rel.endsWith(".map"));
    copyPackedTree(skillsDir, join(stage, "skills"));
    mkdirSync(join(stage, "bin"), { recursive: true });
    cpSync(workerEntry, join(stage, "bin", "worker-entry.mjs"));
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify(
        {
          name: "socode-runtime",
          version,
          type: "module",
          engines: { node: ">=22" },
        },
        null,
        2,
      )}\n`,
    );

    const stagedFiles = walkFiles(stage);
    const secret = stagedSecret(stage, stagedFiles);
    if (secret) throw new Error(`runtime 含密钥 ${secret}`);
    const stamp = makeStamp(version, hashFiles(stage, stagedFiles));
    writeFileSync(join(stage, "runtime-stamp.json"), `${JSON.stringify({ stamp, version }, null, 2)}\n`);

    const files = walkFiles(stage).map((file) => relative(stage, file).split(sep).join("/")).sort();
    const listingHit = runtimeListingProblem(files);
    if (listingHit) throw new Error(`runtime 含禁止文件 ${listingHit}`);

    const outDir = resolve(opts?.outDir ?? runtimeCacheDir());
    mkdirSync(outDir, { recursive: true });
    const tarPath = join(outDir, runtimeTarName(stamp));
    if (opts?.reuseCached !== false && existsSync(tarPath)) {
      const cached = listTarFiles(tarPath);
      const cachedHit = runtimeListingProblem(cached);
      if (cachedHit) throw new Error(`缓存 runtime 含禁止文件 ${cachedHit}`);
      return { stamp, tarPath, files: cached };
    }

    const packed = spawnSync(
      "tar",
      ["-czf", tarPath, "-C", stage, "dist", "skills", "package.json", "runtime-stamp.json", "bin"],
      { encoding: "utf8", env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    if (packed.status !== 0) {
      throw new Error(packed.stderr || "打包 socode-runtime 失败");
    }
    const tarFiles = listTarFiles(tarPath);
    const tarHit = runtimeListingProblem(tarFiles);
    if (tarHit) {
      rmSync(tarPath, { force: true });
      throw new Error(`runtime 含禁止文件 ${tarHit}`);
    }
    return { stamp, tarPath, files: tarFiles };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function readPackageVersion(root: string) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`找不到 ${pkgPath}`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error("package.json 缺少 version");
  }
  return pkg.version.trim();
}

function copyPackedTree(from: string, to: string, extraKeep?: (rel: string) => boolean) {
  mkdirSync(to, { recursive: true });
  for (const file of walkFiles(from)) {
    const rel = relative(from, file).split(sep).join("/");
    if (isForbiddenRel(rel)) continue;
    if (extraKeep && !extraKeep(rel)) continue;
    const dest = join(to, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(file, dest);
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (FORBIDDEN_DIR_NAMES.has(name) || name === "." || name === "..") continue;
      out.push(...walkFiles(full));
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function stagedSecret(stage: string, files: string[]) {
  for (const file of files) {
    const rel = relative(stage, file).split(sep).join("/");
    if (rel.startsWith("dist/")) continue;
    const text = readFileSync(file, "utf8");
    const hit = payloadHasSecrets(text);
    if (hit) return `${rel}: ${hit}`;
  }
  return null;
}

export function nodeWorkerEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_UNIQUE_ID;
  delete env.NODE_OPTIONS;
  return env;
}

export function packRuntimeCli() {
  const packed = packRuntime({ reuseCached: false });
  process.stdout.write(`${packed.stamp}\n${packed.tarPath}\n`);
}

if (process.argv.includes("--pack-runtime")) {
  packRuntimeCli();
}
