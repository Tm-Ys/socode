import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { userSocodeDir } from "./provider.js";

export type RemoteOs = "linux" | "darwin";
export type RemoteArch = "x64" | "arm64";

export type RemotePlatform = {
  os: RemoteOs;
  arch: RemoteArch;
};

export type ProbeResult = {
  platform: RemotePlatform;
  home: string;
  nodeVersion: string | null;
  nodePath: string | null;
  portableNodeVersion: string | null;
  portableNodePath: string | null;
  workspaceOk: boolean;
  runtimeStamp: string | null;
};

export type SshMux = {
  controlPath: string;
  batch?: boolean;
  master?: "yes" | "no" | "auto";
};

export function shQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sshDestination(user: string, host: string) {
  return user ? `${user}@${host}` : host;
}

/** sshd 用登录壳 `$SHELL -c command`。带换行的 argv 会被拆成多条命令。 */
export function wrapRemoteScript(script: string) {
  const b64 = Buffer.from(`${script}\n`, "utf8").toString("base64");
  const inner = [
    "f=${TMPDIR:-/tmp}/socode-cmd-$$",
    `printf '%s' ${shQuote(b64)} | (base64 -d 2>/dev/null || base64 -D) > "$f" || exit 1`,
    'exec bash --noprofile --norc "$f"',
  ].join("; ");
  return `bash --noprofile --norc -c ${shQuote(inner)}`;
}

export function sshMuxArgs(mux?: SshMux) {
  const args: string[] = ["-o", "ClearAllForwardings=yes", "-T"];
  if (mux?.batch !== false) args.push("-o", "BatchMode=yes");
  if (mux?.controlPath) {
    args.push(
      "-o",
      `ControlMaster=${mux.master ?? "auto"}`,
      "-o",
      `ControlPath=${mux.controlPath}`,
      "-o",
      "ControlPersist=600",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=6",
    );
  }
  return args;
}

export function sshWorkerArgs(
  dest: string,
  command: string,
  opts?: { identityFile?: string; password?: boolean },
) {
  const args = [
    "-o",
    "ClearAllForwardings=yes",
    "-T",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=6",
  ];
  if (!opts?.password) args.push("-o", "BatchMode=yes");
  if (opts?.identityFile) {
    args.push("-i", opts.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (opts?.password) {
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  args.push(dest, `bash --noprofile --norc -c ${shQuote(command)}`);
  return args;
}

export function sshMasterArgs(dest: string, controlPath: string, opts?: { batch?: boolean; password?: boolean; identityFile?: string }) {
  const args = sshMuxArgs({
    controlPath,
    batch: opts?.batch !== false && !opts?.password,
    master: "yes",
  });
  if (opts?.identityFile) {
    args.push("-i", opts.identityFile, "-o", "IdentitiesOnly=yes");
  }
  if (opts?.password) {
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  args.push("-fN", dest);
  return args;
}

export function sshBatchArgs(dest: string, script: string, mux?: SshMux) {
  const args = sshMuxArgs(mux);
  args.push(dest, wrapRemoteScript(script));
  return args;
}

/** 单行 exec。套 noprofile bash，避免登录壳吃掉 stdin；不要再走写临时文件的 wrapRemoteScript。 */
export function sshExecArgs(dest: string, command: string, mux?: SshMux) {
  const args = sshMuxArgs(mux);
  args.push(dest, `bash --noprofile --norc -c ${shQuote(command)}`);
  return args;
}

export function scpArgs(localPath: string, dest: string, remotePath: string, mux?: SshMux) {
  const args = ["-o", "ClearAllForwardings=yes"];
  if (mux?.batch !== false) args.push("-o", "BatchMode=yes");
  if (mux?.controlPath) {
    args.push(
      "-o",
      `ControlMaster=${mux.master ?? "auto"}`,
      "-o",
      `ControlPath=${mux.controlPath}`,
      "-o",
      "ControlPersist=600",
    );
  }
  args.push(localPath, `${dest}:${remotePath}`);
  return args;
}

export function parseUname(raw: string): RemotePlatform | { error: string } {
  const line = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !/^warning:/i.test(item));
  if (!line) return { error: "无法读取远端 uname" };
  const [sys, mach] = line.split(/\s+/);
  const os = sys?.toLowerCase();
  const machine = mach?.toLowerCase();
  if (os !== "linux" && os !== "darwin") {
    return { error: `不支持的远端系统 ${sys ?? raw.trim()}。只要 Linux / macOS。` };
  }
  let arch: RemoteArch | undefined;
  if (machine === "x86_64" || machine === "amd64") arch = "x64";
  if (machine === "arm64" || machine === "aarch64") arch = "arm64";
  if (!arch) return { error: `不支持的远端架构 ${mach ?? ""}。只要 x86_64 / arm64。` };
  return { os, arch };
}

export function parseNodeMajor(raw: string | null) {
  if (!raw) return null;
  const match = raw.trim().match(/v?(\d+)/);
  return match ? Number(match[1]) : null;
}

export function nodeIsUsable(version: string | null) {
  const major = parseNodeMajor(version);
  return major !== null && major >= 22;
}

export function shouldUploadNode(probe: Pick<ProbeResult, "nodeVersion" | "portableNodeVersion">, force = false) {
  return shouldInstallNode(probe, force);
}

export function shouldInstallNode(probe: Pick<ProbeResult, "nodeVersion" | "portableNodeVersion">, force = false) {
  if (force) return true;
  return !nodeIsUsable(probe.portableNodeVersion) && !nodeIsUsable(probe.nodeVersion);
}

export function resolveWorkerNode(probe: {
  nodeVersion: string | null;
  nodePath?: string | null;
  portableNodeVersion: string | null;
  portableNodePath?: string | null;
}) {
  if (nodeIsUsable(probe.portableNodeVersion) && probe.portableNodePath) return probe.portableNodePath;
  if (nodeIsUsable(probe.nodeVersion) && probe.nodePath) return probe.nodePath;
  return null;
}

export function officialNodeTarball(version: string, platform: RemotePlatform) {
  const os = platform.os === "darwin" ? "darwin" : "linux";
  const file = `node-v${version}-${os}-${platform.arch}.tar.gz`;
  return {
    file,
    url: `https://nodejs.org/dist/v${version}/${file}`,
  };
}

export function nodeCacheDir() {
  return join(userSocodeDir(), "cache", "node");
}

export function nodeBinPath(home: string, version: string, platform: RemotePlatform) {
  const os = platform.os === "darwin" ? "darwin" : "linux";
  return `${home}/.socode-server/node/node-v${version}-${os}-${platform.arch}/bin/node`;
}

export function probeScript(workspace: string) {
  return [
    "echo SOCODE_PROBE_V1",
    "echo UNAME $(uname -s -m)",
    "echo HOME \"$HOME\"",
    "if command -v node >/dev/null 2>&1; then",
    "  echo NODE $(node -p process.versions.node 2>/dev/null)",
    "  echo NODE_PATH $(command -v node)",
    "else",
    "  echo NODE",
    "  echo NODE_PATH",
    "fi",
    "portable=\"\"",
    "for n in \"$HOME/.socode-server/node/\"*/bin/node; do",
    "  if [ -x \"$n\" ]; then portable=$n; break; fi",
    "done",
    "if [ -n \"$portable\" ]; then",
    "  echo PORTABLE_NODE $($portable -p process.versions.node 2>/dev/null)",
    "  echo PORTABLE_NODE_PATH $portable",
    "else",
    "  echo PORTABLE_NODE",
    "  echo PORTABLE_NODE_PATH",
    "fi",
    `if [ -d ${shQuote(workspace)} ]; then echo WORKSPACE ok; else echo WORKSPACE missing; fi`,
    "echo RUNTIME $(cat \"$HOME/.socode-server/runtime/current-stamp\" 2>/dev/null)",
  ].join("\n");
}

export function parseProbe(stdout: string): ProbeResult | { error: string } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes("SOCODE_PROBE_V1")) {
    return { error: "远端探测失败（没有 probe 标记）。检查 SSH 和 bash --noprofile。" };
  }
  const value = (key: string) => {
    const line = lines.find((item) => item.startsWith(`${key} `) || item === key);
    if (!line) return "";
    return line.slice(key.length).trim();
  };
  const platform = parseUname(value("UNAME") || "");
  if ("error" in platform) return platform;
  const home = value("HOME");
  if (!home.startsWith("/")) return { error: "无法读取远端 HOME" };
  return {
    platform,
    home,
    nodeVersion: value("NODE") || null,
    nodePath: value("NODE_PATH") || null,
    portableNodeVersion: value("PORTABLE_NODE") || null,
    portableNodePath: value("PORTABLE_NODE_PATH") || null,
    workspaceOk: value("WORKSPACE") === "ok",
    runtimeStamp: value("RUNTIME") || null,
  };
}

export function listWorkspacesScript(dir?: string) {
  const root = dir ? shQuote(dir) : '"$HOME"';
  return [
    "echo SOCODE_DIRS_V1",
    "echo HOME \"$HOME\"",
    `root=${root}`,
    'if [ ! -d "$root" ]; then echo ERROR not-dir "$root"; exit 2; fi',
    'echo CWD "$root"',
    'for d in "$root"/*; do',
    '  [ -d "$d" ] || continue',
    '  base=$(basename "$d")',
    '  case "$base" in .*) continue ;; esac',
    "  echo DIR \"$d\"",
    "done",
  ].join("\n");
}

export function parseWorkspaceList(stdout: string): { home: string; cwd: string; dirs: string[] } | { error: string } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes("SOCODE_DIRS_V1")) {
    return { error: "无法列出远端目录。" };
  }
  const value = (key: string) => {
    const line = lines.find((item) => item.startsWith(`${key} `) || item === key);
    if (!line) return "";
    return line.slice(key.length).trim();
  };
  const failed = value("ERROR");
  if (failed) return { error: `无法列出远端目录: ${failed}` };
  const home = value("HOME");
  if (!home.startsWith("/")) return { error: "无法读取远端 HOME" };
  const cwd = value("CWD") || home;
  if (!cwd.startsWith("/")) return { error: "无法读取当前目录" };
  const dirs: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("DIR ")) continue;
    const dir = line.slice(4).trim();
    if (!dir.startsWith("/") || dirs.includes(dir) || dir === cwd) continue;
    dirs.push(dir);
    if (dirs.length >= 80) break;
  }
  return { home, cwd, dirs };
}

export function parentDir(path: string) {
  const trimmed = normalizeAbsPath(path);
  if (trimmed === "/") return "/";
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

export function normalizeAbsPath(path: string) {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) return trimmed;
  const body = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  return body ? `/${body}` : "/";
}

export function extractScript(home: string, stamp: string, tarName: string) {
  const root = `${home}/.socode-server/runtime/${stamp}`;
  return [
    `mkdir -p ${shQuote(root)} ${shQuote(`${home}/.socode-server/runtime`)}`,
    `tar -xzf ${shQuote(`${home}/.socode-server/runtime/${tarName}`)} -C ${shQuote(root)}`,
    `printf %s ${shQuote(stamp)} > ${shQuote(`${home}/.socode-server/runtime/current-stamp`)}`,
  ].join("\n");
}

export function killRemoteWorkersScript(home: string) {
  const pidFile = `${home}/.socode-server/session/worker.pid`;
  const runtime = `${home}/.socode-server/runtime/`;
  return [
    `pidf=${shQuote(pidFile)}`,
    'if [ -f "$pidf" ]; then kill "$(cat "$pidf")" 2>/dev/null || true; rm -f "$pidf"; fi',
    `pkill -f ${shQuote(runtime)} 2>/dev/null || true`,
    "sleep 0.2 2>/dev/null || true",
  ].join("\n");
}

export function replaceRuntimeScript(home: string, stamp: string, tarName: string) {
  const runtime = `${home}/.socode-server/runtime`;
  const root = `${runtime}/${stamp}`;
  const tar = `${runtime}/${tarName}`;
  return [
    killRemoteWorkersScript(home),
    `runtime=${shQuote(runtime)}`,
    `keep=${shQuote(tarName)}`,
    `root=${shQuote(root)}`,
    `tar=${shQuote(tar)}`,
    'mkdir -p "$runtime"',
    'for item in "$runtime"/* "$runtime"/.[!.]*; do',
    '  [ -e "$item" ] || continue',
    '  [ "$(basename "$item")" = "$keep" ] && continue',
    '  rm -rf "$item"',
    "done",
    'mkdir -p "$root"',
    'tar -xzf "$tar" -C "$root"',
    `printf %s ${shQuote(stamp)} > ${shQuote(`${runtime}/current-stamp`)}`,
    `echo SOCODE_RUNTIME_REPLACED ${shQuote(stamp)}`,
  ].join("\n");
}

export function runtimeEntryReadyScript(home: string, stamp: string) {
  const root = runtimeRoot(home, stamp);
  return `if [ -f ${shQuote(`${root}/bin/worker-entry.mjs`)} ] && [ -f ${shQuote(`${root}/dist/stdio-worker.js`)} ]; then echo RUNTIME_ENTRY ok; else echo RUNTIME_ENTRY missing; fi`;
}

export function parseListenStart(stdout: string): { pid: number; port: number } | { error: string } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes("SOCODE_LISTEN_V1")) {
    return { error: "远端 worker 没有听端口（没有 listen 标记）。" };
  }
  const value = (key: string) => {
    const line = lines.find((item) => item.startsWith(`${key} `) || item === key);
    if (!line) return "";
    return line.slice(key.length).trim();
  };
  const failed = value("ERROR");
  if (failed) return { error: `远端 worker 启动失败: ${failed}` };
  const pid = Number(value("PID"));
  const port = Number(value("PORT"));
  if (!Number.isInteger(pid) || pid <= 0) return { error: "远端 worker pid 无效" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "远端 worker 端口无效" };
  return { pid, port };
}

export function startListenWorkerScript(opts: {
  nodePath: string;
  runtimeRoot: string;
  workspace: string;
  home: string;
  env?: Record<string, string>;
}) {
  const session = `${opts.home}/.socode-server/session`;
  const portFile = `${session}/rpc.port`;
  const pidFile = `${session}/worker.pid`;
  const logFile = `${session}/worker.log`;
  const assigns = Object.entries(opts.env ?? {})
    .map(([key, value]) => `${key}=${shQuote(value)}`)
    .join(" ");
  const prefix = assigns ? `env ${assigns} ` : "";
  const launch = `${prefix}${shQuote(opts.nodePath)} ${shQuote(`${opts.runtimeRoot}/bin/worker-entry.mjs`)} --listen 127.0.0.1:0 --port-file ${shQuote(portFile)} --workspace ${shQuote(opts.workspace)}`;
  return [
    killRemoteWorkersScript(opts.home),
    `session=${shQuote(session)}`,
    `portf=${shQuote(portFile)}`,
    `pidf=${shQuote(pidFile)}`,
    `logf=${shQuote(logFile)}`,
    'mkdir -p "$session"',
    'rm -f "$portf"',
    `nohup ${launch} > "$logf" 2>&1 &`,
    'echo $! > "$pidf"',
    "i=0",
    'while [ "$i" -lt 100 ]; do',
    '  if [ -s "$portf" ]; then',
    "    echo SOCODE_LISTEN_V1",
    '    echo PID $(cat "$pidf")',
    '    echo PORT $(cat "$portf")',
    "    exit 0",
    "  fi",
    '  if ! kill -0 "$(cat "$pidf")" 2>/dev/null; then',
    "    echo SOCODE_LISTEN_V1",
    "    echo ERROR worker-exited",
    '    echo LOG',
    '    tail -n 40 "$logf" 2>/dev/null || true',
    "    exit 1",
    "  fi",
    "  sleep 0.1",
    '  i=$((i+1))',
    "done",
    "echo SOCODE_LISTEN_V1",
    "echo ERROR listen-timeout",
    "echo LOG",
    'tail -n 40 "$logf" 2>/dev/null || true',
    "exit 1",
  ].join("\n");
}

export function sshForwardArgs(dest: string, port: number, mux?: SshMux) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效转发端口 ${port}`);
  }
  const args = sshMuxArgs(mux);
  args.push("-W", `127.0.0.1:${port}`, dest);
  return args;
}

export function extractNodeScript(home: string, tarName: string) {
  const dir = `${home}/.socode-server/node`;
  return [
    `mkdir -p ${shQuote(dir)}`,
    `tar -xzf ${shQuote(`${dir}/${tarName}`)} -C ${shQuote(dir)}`,
  ].join("\n");
}

export function nodeDistMirrors() {
  return [
    "https://nodejs.org/dist",
    "https://npmmirror.com/mirrors/node",
    "https://mirrors.cloud.tencent.com/nodejs-release",
  ];
}

export function installNodeScript() {
  const mirrors = nodeDistMirrors().map((url) => shQuote(url)).join(" ");
  return [
    "echo SOCODE_NODE_V1",
    "sys=$(uname -s)",
    "mach=$(uname -m)",
    "echo UNAME $sys $mach",
    'os=""',
    'arch=""',
    'case "$sys" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo ERROR unsupported-os $sys; exit 3 ;; esac',
    'case "$mach" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) echo ERROR unsupported-arch $mach; exit 3 ;; esac',
    "echo PLATFORM $os-$arch",
    'dir="$HOME/.socode-server/node"',
    'mkdir -p "$dir"',
    'portable=""',
    'for n in "$dir"/*/bin/node; do',
    '  if [ -x "$n" ]; then portable=$n; break; fi',
    "done",
    'if [ -n "$portable" ]; then',
    '  ver=$($portable -p process.versions.node 2>/dev/null || true)',
    '  major=$(printf "%s" "$ver" | tr -d v | cut -d. -f1)',
    '  if [ -n "$major" ] && [ "$major" -ge 22 ] 2>/dev/null; then',
    "    echo NET skip",
    "    echo NODE_BIN $portable",
    "    echo NODE_VER $ver",
    "    exit 0",
    "  fi",
    "fi",
    'fetcher=""',
    "if command -v curl >/dev/null 2>&1; then fetcher=curl",
    "elif command -v wget >/dev/null 2>&1; then fetcher=wget",
    "else echo FETCHER none; echo NET fail; echo ERROR no-curl-wget; exit 2; fi",
    "echo FETCHER $fetcher",
    "fetch() {",
    "  url=$1; out=$2; timeout=$3",
    '  if [ "$fetcher" = curl ]; then',
    '    curl -fL --connect-timeout 10 --max-time "$timeout" --progress-bar -o "$out" "$url"',
    "  else",
    '    wget -q --timeout="$timeout" --tries=1 -O "$out" "$url"',
    "  fi",
    "}",
    'idx="$dir/index.json"',
    'base=""',
    `for candidate in ${mirrors}; do`,
    "  echo TRY $candidate",
    '  if fetch "$candidate/index.json" "$idx" 20; then',
    "    base=$candidate",
    "    break",
    "  fi",
    "done",
    'if [ -z "$base" ]; then echo NET fail; echo ERROR unreachable-node-dist; exit 2; fi',
    "echo NET ok $base",
    `ver=$(grep -oE 'v22\\.[0-9]+\\.[0-9]+' "$idx" | head -n 1 | tr -d v)`,
    'if [ -z "$ver" ]; then echo ERROR no-node-22; exit 2; fi',
    "echo NODE_REL $ver",
    "file=node-v${ver}-${os}-${arch}.tar.gz",
    "url=$base/v${ver}/$file",
    "echo GET $url",
    'fetch "$url" "$dir/$file.part" 600',
    'mv "$dir/$file.part" "$dir/$file"',
    'tar -xzf "$dir/$file" -C "$dir"',
    "bin=$dir/node-v${ver}-${os}-${arch}/bin/node",
    'if [ ! -x "$bin" ]; then echo ERROR missing-bin $bin; exit 2; fi',
    "echo NODE_BIN $bin",
    "echo NODE_VER $($bin -p process.versions.node)",
  ].join("\n");
}

export function parseNodeInstall(stdout: string): { bin: string; version: string; net: string } | { error: string } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes("SOCODE_NODE_V1")) {
    return { error: "远端安装 Node 失败（没有标记）。检查 SSH 和 bash --noprofile。" };
  }
  const value = (key: string) => {
    const line = lines.find((item) => item.startsWith(`${key} `) || item === key);
    if (!line) return "";
    return line.slice(key.length).trim();
  };
  const failed = value("ERROR");
  if (failed) return { error: `远端安装 Node 失败: ${failed}` };
  const bin = value("NODE_BIN");
  if (!bin.startsWith("/")) return { error: "远端没有可用的 Node 22" };
  return { bin, version: value("NODE_VER"), net: value("NET") };
}

export function sessionProviderPath(home: string) {
  return `${home}/.socode-server/session/providers.json`;
}

export function wipeSessionProviderScript(home: string) {
  const path = sessionProviderPath(home);
  return `rm -f ${shQuote(path)}`;
}

export function workerScript(opts: {
  nodePath: string;
  runtimeRoot: string;
  workspace: string;
  env?: Record<string, string>;
}) {
  const assigns = Object.entries(opts.env ?? {})
    .map(([key, value]) => `${key}=${shQuote(value)}`)
    .join(" ");
  const prefix = assigns ? `env ${assigns} ` : "";
  return [
    `exec ${prefix}${shQuote(opts.nodePath)} ${shQuote(`${opts.runtimeRoot}/bin/worker-entry.mjs`)} --stdio --workspace ${shQuote(opts.workspace)}`,
  ].join("\n");
}

export function runtimeRoot(home: string, stamp: string) {
  return `${home}/.socode-server/runtime/${stamp}`;
}

export async function latestNode22Version(fetchFn: typeof fetch = fetch) {
  const response = await fetchFn("https://nodejs.org/dist/index.json");
  if (!response.ok) throw new Error(`无法读取 Node 版本列表 (${response.status})`);
  const rows = (await response.json()) as Array<{ version?: string }>;
  const row = rows.find((item) => typeof item.version === "string" && /^v22\./.test(item.version));
  if (!row?.version) throw new Error("找不到 Node 22 发行版");
  return row.version.replace(/^v/, "");
}

export async function ensureCachedNodeTarball(
  platform: RemotePlatform,
  opts?: { version?: string; cacheDir?: string; fetch?: typeof fetch },
) {
  const fetchFn = opts?.fetch ?? fetch;
  const version = opts?.version ?? (await latestNode22Version(fetchFn));
  const { file, url } = officialNodeTarball(version, platform);
  const cacheDir = opts?.cacheDir ?? nodeCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const tarPath = join(cacheDir, file);
  if (existsSync(tarPath)) return { version, file, tarPath, url };
  const response = await fetchFn(url);
  if (!response.ok || !response.body) {
    throw new Error(`下载 Node ${version} 失败 (${response.status}) ${url}`);
  }
  const tmp = `${tarPath}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp));
  await chmod(tmp, 0o644);
  renameSync(tmp, tarPath);
  return { version, file, tarPath, url };
}
