import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

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

export function resolvePath(input: string) {
  const path = input.trim();
  if (!path) throw new Error("缺少路径");
  if (!isAbsolute(path)) throw new Error(`必须是绝对路径，收到: ${path}`);
  return normalize(path);
}

export function isInsideWorkspace(workspace: string, path: string) {
  const root = normalize(resolve(workspace));
  const target = normalize(path);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function denyReason(path: string): string | null {
  const target = normalize(path);
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

const READONLY_HEAD =
  /^(ls|pwd|whoami|date|uname|which|type|file|stat|head|tail|wc|echo|printf|cat|rg|find|tree|du|df|env|id|hostname|realpath|dirname|basename|git\s+(status|log|diff|show|branch|rev-parse|ls-files|blame)(\s|$))/;

export function classifyBash(command: string): { readonly: boolean; op: FileOp } {
  const text = command.trim();
  if (!text) return { readonly: true, op: "exec" };
  if (/\b(rm|rmdir|unlink|shred)\b/.test(text) || /\bgit\s+clean\b/.test(text)) {
    return { readonly: false, op: "delete" };
  }
  if (
    /(^|[\s;&|])>(?!>)|>>/.test(text) ||
    /\b(tee|sed\s+-i|perl\s+-pi)\b/.test(text) ||
    /\b(mv|cp|chmod|chown|ln|truncate)\b/.test(text) ||
    /\bgit\s+(commit|reset|checkout|stash|rebase|push|add|mv|rm)\b/.test(text)
  ) {
    return { readonly: false, op: "modify" };
  }
  if (
    /\b(mkdir|touch|install)\b/.test(text) ||
    /\b(npm|pnpm|yarn|bun|pip|cargo|brew)\s+(i|install|add|uninstall|remove)\b/.test(text)
  ) {
    return { readonly: false, op: "create" };
  }
  if (
    /\b(kill|pkill|reboot|shutdown|dd|mkfs|sudo|su)\b/.test(text) ||
    /\b(curl|wget)\b[\s\S]*\|\s*(ba)?sh\b/.test(text)
  ) {
    return { readonly: false, op: "exec" };
  }

  const chunks = text.split(/\s*(?:&&|\|\||;|\n)\s*/).filter(Boolean);
  const allReadonly = chunks.every((chunk) => {
    const pipes = chunk.split("|").map((part) => part.trim());
    return pipes.every((part) => READONLY_HEAD.test(part) && !/(^|[\s;&|])>(?!>)|>>/.test(part));
  });
  if (allReadonly) return { readonly: true, op: "exec" };
  return { readonly: false, op: "exec" };
}

export function opLabel(op: FileOp) {
  if (op === "create") return "创建文件";
  if (op === "modify") return "修改文件";
  if (op === "delete") return "删除文件";
  return "执行命令";
}

export function bashSpawn(command: string): {
  file: string;
  args: string[];
  fallback?: { file: string; args: string[] };
} {
  const direct = { file: "/bin/bash", args: ["-c", command] };
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) return direct;
  return {
    file: "/usr/bin/sandbox-exec",
    args: ["-p", seatbeltProfile(), "/bin/bash", "-c", command],
    fallback: direct,
  };
}

export function shouldFallbackSandbox(stderr: string, code: number | null) {
  return code === 71 || /sandbox_apply|sandbox-exec:/i.test(stderr);
}

function seatbeltProfile() {
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
  return `(version 1)(allow default)(deny file-write* ${denyWrite})(deny file-read* ${denySecretDirs} ${denySecretFiles})(deny file-write* ${denySecretFiles})`;
}

function sb(path: string) {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function joinHome(home: string, name: string) {
  return home ? `${home}${sep}${name}` : "";
}
