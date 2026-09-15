import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join } from "node:path";
import { throwIfAborted, TurnAborted } from "./abort.js";
import { bashSpawn, denyReason, realExistingPath, scrubEnv, shouldFallbackSandbox, type BashSandbox } from "./sandbox.js";

const MAX_READ_BYTES = 200_000;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_SEARCH_HITS = 80;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", "coverage"]);

export function requireAbsolutePath(input: string, label: string) {
  const path = input.trim();
  if (!path) throw new Error(`缺少 ${label}`);
  if (!isAbsolute(path)) throw new Error(`${label} 必须是绝对路径，收到: ${path}`);
  const resolved = realExistingPath(path);
  const blocked = denyReason(resolved);
  if (blocked) throw new Error(blocked);
  return resolved;
}

export async function requireAbsoluteDir(input: string, label: string) {
  const path = requireAbsolutePath(input, label);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`${label} 目录不存在: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`${label} 必须是绝对目录: ${path}`);
  return path;
}

export async function readAbsoluteFile(path: string, offset?: number, limit?: number) {
  const file = requireAbsolutePath(path, "path");
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`path 必须是文件: ${file}`);
  const toRead = Math.min(info.size, MAX_READ_BYTES);
  const handle = await open(file, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(toRead);
    const got = await handle.read(buf, 0, toRead, 0);
    buf = buf.subarray(0, got.bytesRead);
  } finally {
    await handle.close();
  }
  if (buf.includes(0)) throw new Error(`拒绝读取二进制文件: ${file}`);
  const text = buf.toString("utf8");
  const truncated = info.size > MAX_READ_BYTES;
  const lines = text.split("\n");
  const start = Math.max(1, offset ?? 1);
  const end = limit && limit > 0 ? Math.min(lines.length, start - 1 + limit) : lines.length;
  const slice = lines.slice(start - 1, end);
  const body = slice.map((line, i) => `${String(start + i).padStart(6)}|${line}`).join("\n");
  const header = `${file} (${lines.length} lines, bytes=${info.size}${truncated ? ", truncated" : ""})`;
  return clip(`${header}\n${body}`);
}

export async function writeAbsoluteFile(path: string, content: string) {
  const file = requireAbsolutePath(path, "path");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return `已写入 ${file} (${Buffer.byteLength(content, "utf8")} bytes)`;
}

export async function deleteAbsoluteFile(path: string) {
  const file = requireAbsolutePath(path, "path");
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new Error(`文件不存在: ${file}`);
  }
  if (!info.isFile()) throw new Error(`delete 只能删文件，不是目录: ${file}`);
  await unlink(file);
  return `已删除 ${file}`;
}

export async function runBash(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
  sandbox?: BashSandbox,
) {
  const dir = await requireAbsoluteDir(cwd, "cwd");
  if (!command.trim()) throw new Error("缺少 command");
  throwIfAborted(signal);
  const spec = bashSpawn(command, { ...sandbox, cwd: dir });
  if (spec.unavailable) throw new Error(spec.unavailable);
  const first = await runBashProcess(spec.file, spec.args, dir, timeoutMs, signal, command);
  if (
    spec.fallback &&
    shouldFallbackSandbox(first.stderr, first.code) &&
    !first.stdout.trim()
  ) {
    const retry = await runBashProcess(
      spec.fallback.file,
      spec.fallback.args,
      dir,
      timeoutMs,
      signal,
      command,
    );
    return `警告: OS 沙箱未能启用，已裸跑 bash\n${formatBashResult(retry)}`;
  }
  return formatBashResult(first);
}

function formatBashResult(result: { code: number | null; stdout: string; stderr: string }) {
  const out = [
    `exit=${result.code ?? "null"}`,
    result.stdout && `stdout:\n${result.stdout}`,
    result.stderr && `stderr:\n${result.stderr}`,
  ]
    .filter(Boolean)
    .join("\n");
  return clip(out || "(无输出)");
}

function runBashProcess(
  file: string,
  args: string[],
  dir: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  command: string,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: dir,
      env: scrubEnv(process.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (drainTimer) clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const finishOk = (code: number | null) => {
      settle(() => {
        if (signal?.aborted) {
          reject(new TurnAborted());
          return;
        }
        resolve({ code, stdout, stderr });
      });
    };
    const onAbort = () => {
      killProcessTree(child);
      settle(() => reject(new TurnAborted()));
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      settle(() => reject(new Error(`命令超时 ${timeoutMs}ms: ${command}`)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stdout.length);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stderr.length);
    });
    child.on("error", (error) => {
      settle(() => reject(signal?.aborted ? new TurnAborted() : error));
    });
    child.on("close", (code) => {
      finishOk(code);
    });
    child.on("exit", (code) => {
      drainTimer = setTimeout(() => finishOk(code), 80);
    });
  });
}

export async function searchAbsoluteDir(
  directory: string,
  pattern: string,
  glob?: string,
  signal?: AbortSignal,
) {
  const dir = await requireAbsoluteDir(directory, "directory");
  if (!pattern) throw new Error("缺少 pattern");
  throwIfAborted(signal);
  const viaRg = await searchWithRg(dir, pattern, glob, signal);
  if (viaRg !== null) return viaRg;
  return await searchByWalk(dir, pattern, glob, signal);
}

async function searchWithRg(dir: string, pattern: string, glob?: string, signal?: AbortSignal) {
  return await new Promise<string | null>((resolve, reject) => {
    const args = [
      "-n",
      "--no-heading",
      "--hidden",
      "--glob",
      "!.git/**",
      "--glob",
      "!node_modules/**",
    ];
    if (glob) args.push("--glob", glob);
    args.push("-m", String(MAX_SEARCH_HITS), "--", pattern, dir);
    if (signal?.aborted) {
      reject(new TurnAborted());
      return;
    }
    const child = spawn("rg", args, { cwd: dir });
    let stdout = "";
    let finished = false;
    const settle = (fn: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      settle(() => reject(new TurnAborted()));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stdout.length);
      }
    });
    child.stderr.resume();
    child.on("error", () => settle(() => resolve(null)));
    child.on("close", (code) => {
      settle(() => {
        if (signal?.aborted) {
          reject(new TurnAborted());
          return;
        }
        if (code === 0 || code === 1) resolve(clip(stdout.trim() || `无匹配: ${pattern} in ${dir}`));
        else resolve(null);
      });
    });
  });
}

async function searchByWalk(dir: string, pattern: string, glob?: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
  const files: string[] = [];
  await walkFiles(dir, files, 0, glob, signal);
  const hits: string[] = [];
  for (const file of files) {
    throwIfAborted(signal);
    if (hits.length >= MAX_SEARCH_HITS) break;
    let text: string;
    try {
      const buf = await readFile(file);
      if (buf.includes(0) || buf.length > MAX_READ_BYTES) continue;
      text = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!regex.test(lines[i])) continue;
      hits.push(`${file}:${i + 1}:${lines[i]}`);
      if (hits.length >= MAX_SEARCH_HITS) break;
    }
  }
  return clip(hits.join("\n") || `无匹配: ${pattern} in ${dir}`);
}

async function walkFiles(
  dir: string,
  files: string[],
  depth: number,
  glob?: string,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  if (depth > 10 || files.length > 5000) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, files, depth + 1, glob, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    if (glob && !globMatch(entry.name, glob) && !globMatch(full, glob)) continue;
    files.push(full);
  }
}

function globMatch(name: string, glob: string) {
  if (glob.startsWith("*.") && name.endsWith(glob.slice(1))) return true;
  if (glob.includes("*")) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(name) || new RegExp(escaped).test(name);
  }
  return name === glob || extname(name) === glob;
}

function clip(text: string) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n... [truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}

function killProcessTree(child: ChildProcess) {
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // process group already gone
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already exited
  }
}
