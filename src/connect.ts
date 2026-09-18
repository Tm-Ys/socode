import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stdin as input, stderr } from "node:process";
import { JsonRpcPeer } from "./jsonrpc-peer.js";
import { useColor } from "./markdown.js";
import { dumpProviderStore } from "./provider.js";
import { handshakeRemote, isForcedQuit, runRemoteRepl } from "./remote-client.js";
import {
  extractScript,
  installNodeScript,
  listWorkspacesScript,
  parseNodeInstall,
  parseProbe,
  parseWorkspaceList,
  probeScript,
  normalizeAbsPath,
  resolveWorkerNode,
  runtimeRoot,
  scpArgs,
  sessionProviderPath,
  shQuote,
  sshBatchArgs,
  sshDestination,
  sshExecArgs,
  sshMasterArgs,
  wipeSessionProviderScript,
  workerScript,
  type ProbeResult,
  type SshMux,
} from "./remote-install.js";
import { rememberSshHost } from "./ssh-history.js";
import { nodeWorkerEnv, packRuntime, runtimeTarName } from "./runtime-pack.js";
import { expandWorkareaPath } from "./workarea.js";

export function parseConnectTarget(raw: string): { user: string; host: string; path: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "缺少目标。用法: socode connect user@host:/abs/path" };
  const sep = trimmed.lastIndexOf(":");
  if (sep <= 0 || sep === trimmed.length - 1) {
    return { error: "目标必须是 user@host:/绝对路径" };
  }
  const dest = trimmed.slice(0, sep);
  const path = trimmed.slice(sep + 1);
  if (!path.startsWith("/")) return { error: "工作区必须是远端绝对路径" };
  if (path.includes("\\") || path === "/") return { error: "工作区必须是远端仓库的绝对路径" };
  const at = dest.lastIndexOf("@");
  const user = at >= 0 ? dest.slice(0, at) : "";
  const host = at >= 0 ? dest.slice(at + 1) : dest;
  if (!host) return { error: "缺少主机名" };
  if (at >= 0 && !user) return { error: "缺少用户名" };
  return { user: user || process.env.USER || "user", host, path };
}

export type ConnectLogLevel = "info" | "ok" | "err";
export type ConnectLogger = {
  info: (message: string) => void;
  ok: (message: string) => void;
  err: (message: string) => void;
};

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

export function paintConnectLog(level: ConnectLogLevel, message: string, color = false) {
  if (!color) {
    const mark = level === "ok" ? "ok " : level === "err" ? "err" : "·· ";
    return `${mark} ${message}`;
  }
  if (level === "ok") return `${GREEN}✓ ${message}${RESET}`;
  if (level === "err") return `${RED}✗ ${message}${RESET}`;
  return `${DIM}· ${message}${RESET}`;
}

export function defaultConnectLogger(): ConnectLogger {
  const color = useColor(Boolean(process.stderr.isTTY || process.stdout.isTTY));
  const write = (level: ConnectLogLevel, message: string) => {
    process.stderr.write(`${paintConnectLog(level, message, color)}\n`);
  };
  return {
    info: (message) => write("info", message),
    ok: (message) => write("ok", message),
    err: (message) => write("err", message),
  };
}

export type SshSession = {
  dest: string;
  user: string;
  host: string;
  mux: SshMux;
  close: () => void;
};

export type ConnectAuth = {
  password?: string;
  identityFile?: string;
  preferPassword?: boolean;
};

function logRemoteStream(log: ConnectLogger, stdout: string, stderrText: string) {
  const text = `${stdout}\n${stderrText}`.replace(/\r/g, "\n");
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#+/.test(line) && !/\d/.test(line)) continue;
    if (line.startsWith("TRY ")) {
      log.info(`探测镜像 ${line.slice(4)}`);
      continue;
    }
    if (line.startsWith("NET ok ")) {
      log.ok(`远端出网 ${line.slice(7)}`);
      continue;
    }
    if (line.startsWith("NET skip")) {
      log.ok("远端已有 Node 22，跳过下载");
      continue;
    }
    if (line.startsWith("GET ")) {
      log.info(`开始下载 ${line.slice(4)}`);
      continue;
    }
    if (line.startsWith("FETCHER ")) {
      log.info(`远端下载工具 ${line.slice(8)}`);
      continue;
    }
    if (line.startsWith("PLATFORM ")) {
      log.info(`远端系统 ${line.slice(9)}`);
      continue;
    }
    if (line.startsWith("UNAME ")) {
      log.info(`uname ${line.slice(6)}`);
      continue;
    }
    if (line.startsWith("NODE_REL ")) {
      log.info(`将安装 Node ${line.slice(9)}`);
      continue;
    }
    if (/%/.test(line) && /#/.test(line)) {
      log.info(`下载进度 ${line.replace(/#+/g, "").trim() || line}`);
      continue;
    }
    if (line.startsWith("SOCODE_") || line.startsWith("DIR ") || line.startsWith("HOME ") || line.startsWith("NODE_BIN ")) continue;
  }
}

function sshRun(
  dest: string,
  script: string,
  mux: SshMux,
  opts?: { env?: NodeJS.ProcessEnv; timeout?: number; log?: ConnectLogger },
) {
  const result = spawnSync("ssh", sshBatchArgs(dest, script, mux), {
    encoding: "utf8",
    env: opts?.env ?? nodeWorkerEnv(),
    timeout: opts?.timeout,
  });
  if (opts?.log) logRemoteStream(opts.log, result.stdout || "", result.stderr || "");
  return {
    code: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function scpFile(localPath: string, dest: string, remotePath: string, mux: SshMux) {
  const copied = spawnSync("scp", scpArgs(localPath, dest, remotePath, mux), {
    encoding: "utf8",
    env: nodeWorkerEnv(),
  });
  return { code: copied.status ?? 1, stderr: copied.stderr || "" };
}

async function promptSshPassword(dest: string) {
  const fromEnv = process.env.SOCODE_SSH_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!input.isTTY) {
    throw new Error("SSH 需要密码，但本机没有 TTY。可设 SOCODE_SSH_PASSWORD，或配置公钥。");
  }
  stderr.write(`SSH 密码 ${dest}: `);
  return await readSecret();
}

function readSecret() {
  return new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const wasRaw = input.isTTY ? Boolean((input as typeof input & { isRaw?: boolean }).isRaw) : false;
    if (input.isTTY) input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.off("data", onData);
      try {
        if (input.isTTY) input.setRawMode(wasRaw);
      } catch {
        /* ignore */
      }
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (text === "\x03") {
        cleanup();
        stderr.write("\n");
        reject(new Error("已取消"));
        return;
      }
      if (text === "\n" || text === "\r" || text === "\r\n") {
        cleanup();
        stderr.write("\n");
        resolve(chunks.join(""));
        return;
      }
      if (text === "\x7f" || text === "\b") {
        chunks.pop();
        return;
      }
      if (text.startsWith("\x1b")) return;
      chunks.push(text);
    };
    input.on("data", onData);
  });
}

function writeAskPass(password: string) {
  const dir = mkdtempSync(join(tmpdir(), "socode-askpass-"));
  chmodSync(dir, 0o700);
  const secret = join(dir, "p");
  writeFileSync(secret, password, { mode: 0o600 });
  const script = join(dir, "askpass.sh");
  writeFileSync(script, `#!/bin/sh\nexec cat ${shQuote(secret)}\n`, { mode: 0o700 });
  return {
    script,
    env: {
      DISPLAY: process.env.DISPLAY || "none",
      SSH_ASKPASS: script,
      SSH_ASKPASS_REQUIRE: "force",
    } as NodeJS.ProcessEnv,
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function openMaster(
  dest: string,
  controlPath: string,
  env?: NodeJS.ProcessEnv,
  opts?: { password?: boolean; identityFile?: string },
) {
  try {
    rmSync(controlPath, { force: true });
  } catch {
    /* ignore stale mux socket */
  }
  const password = Boolean(opts?.password);
  return spawnSync(
    "ssh",
    sshMasterArgs(dest, controlPath, {
      batch: !password,
      password,
      identityFile: opts?.identityFile,
    }),
    {
      encoding: "utf8",
      env: nodeWorkerEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function muxAlive(dest: string, controlPath: string) {
  const check = spawnSync("ssh", ["-O", "check", "-o", `ControlPath=${controlPath}`, dest], {
    encoding: "utf8",
    env: nodeWorkerEnv(),
  });
  return check.status === 0;
}

function closeMaster(dest: string, controlPath: string) {
  spawnSync("ssh", ["-O", "exit", "-o", `ControlPath=${controlPath}`, dest], {
    encoding: "utf8",
    env: nodeWorkerEnv(),
  });
}

async function passwordLogin(dest: string, controlPath: string, password: string, log: ConnectLogger) {
  const askpass = writeAskPass(password);
  try {
    const authed = openMaster(dest, controlPath, askpass.env, { password: true });
    if (authed.status !== 0) {
      throw new Error(authed.stderr || authed.stdout || `ssh ${dest} 密码登录失败`);
    }
    if (!muxAlive(dest, controlPath)) {
      throw new Error("SSH 主连接没有保持。密码登录后无法复用会话。");
    }
    log.ok(`密码登录成功 ${dest}`);
  } finally {
    askpass.dispose();
  }
}

export async function openSshSession(opts: {
  user: string;
  host: string;
  auth?: ConnectAuth;
  log?: ConnectLogger;
}): Promise<SshSession> {
  const log = opts.log ?? defaultConnectLogger();
  const dest = sshDestination(opts.user, opts.host);
  const controlPath = join(tmpdir(), `socode-ssh-${process.pid}-${Date.now()}`);
  mkdirSync(join(tmpdir()), { recursive: true });
  const identity = opts.auth?.identityFile ? expandWorkareaPath(opts.auth.identityFile) : "";
  if (identity && !existsSync(identity)) {
    throw new Error(`找不到 SSH 密钥: ${identity}`);
  }

  log.info(`连接 ${dest}…`);
  if (identity) {
    log.info(`使用密钥 ${identity}`);
    const keyed = openMaster(dest, controlPath, undefined, { identityFile: identity });
    if (keyed.status !== 0 || !muxAlive(dest, controlPath)) {
      throw new Error(keyed.stderr || keyed.stdout || `ssh ${dest} 密钥登录失败`);
    }
    log.ok(`密钥登录成功 ${dest}`);
  } else if (opts.auth?.preferPassword && opts.auth.password) {
    await passwordLogin(dest, controlPath, opts.auth.password, log);
  } else {
    log.info("尝试默认公钥…");
    const keyed = openMaster(dest, controlPath);
    if (keyed.status === 0 && muxAlive(dest, controlPath)) {
      log.ok(`公钥登录成功 ${dest}`);
    } else {
      log.info("公钥不可用，改用密码登录…");
      const password = opts.auth?.password || (await promptSshPassword(dest));
      await passwordLogin(dest, controlPath, password, log);
    }
  }

  return {
    dest,
    user: opts.user,
    host: opts.host,
    mux: { controlPath, batch: true, master: "no" },
    close: () => closeMaster(dest, controlPath),
  };
}

export async function listRemoteWorkspaces(session: SshSession, opts?: { dir?: string; log?: ConnectLogger }) {
  const logger = opts?.log ?? defaultConnectLogger();
  const dir = opts?.dir;
  logger.info(dir ? `读取 ${dir}…` : "读取远端家目录…");
  const listed = sshRun(session.dest, listWorkspacesScript(dir), session.mux, { log: logger });
  if (listed.code !== 0) {
    throw new Error(listed.stderr || listed.stdout || "列出远端目录失败");
  }
  const parsed = parseWorkspaceList(listed.stdout);
  if ("error" in parsed) throw new Error(`${parsed.error}\n${listed.stdout}`);
  logger.ok(`当前 ${parsed.cwd}，${parsed.dirs.length} 个子目录`);
  return parsed;
}

async function ensureRemoteNode(dest: string, probe: ProbeResult, mux: SshMux, log: ConnectLogger) {
  const existing = resolveWorkerNode(probe);
  if (existing) {
    log.ok(`使用远端 Node ${probe.portableNodeVersion || probe.nodeVersion}（${existing}）`);
    return existing;
  }
  log.info("检查远端出网和系统，准备在对方机器安装 Node 22…");
  const installed = sshRun(dest, installNodeScript(), mux, { timeout: 10 * 60 * 1000, log });
  if (installed.code !== 0) {
    throw new Error(
      installed.stderr ||
        installed.stdout ||
        "远端无法安装 Node 22。请确认对方能访问 nodejs.org 或镜像，并有 curl/wget。",
    );
  }
  const parsed = parseNodeInstall(installed.stdout);
  if ("error" in parsed) {
    throw new Error(`${parsed.error}\nstderr=${installed.stderr}\nstdout=${installed.stdout}`);
  }
  log.ok(`远端 Node ${parsed.version} 就绪（${parsed.net || "ok"}）`);
  return parsed.bin;
}

function waitForHello(child: ChildProcess, peer: JsonRpcPeer, stamp: string) {
  return new Promise<Awaited<ReturnType<typeof handshakeRemote>>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("远端 worker 握手超时")), 60_000);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`远端 worker 退出 (${code ?? signal ?? "?"})`));
    };
    child.once("exit", onExit);
    handshakeRemote(peer, stamp).then(
      (hello) => {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve(hello);
      },
      (error) => {
        clearTimeout(timer);
        child.off("exit", onExit);
        reject(error);
      },
    );
  });
}

function injectSessionProvider(session: SshSession, home: string, log: ConnectLogger) {
  const leftover = sshRun(session.dest, wipeSessionProviderScript(home), session.mux);
  if (leftover.code !== 0) {
    throw new Error(leftover.stderr || "无法清理远端上次留下的会话 Provider");
  }
  const store = dumpProviderStore();
  if (!store) {
    log.info("本机没有 Provider，跳过注入");
    return false;
  }
  const remotePath = sessionProviderPath(home);
  const dir = `${home}/.socode-server/session`;
  const prepared = sshRun(
    session.dest,
    `mkdir -p ${shQuote(dir)} && chmod 700 ${shQuote(dir)}`,
    session.mux,
  );
  if (prepared.code !== 0) throw new Error(prepared.stderr || "无法创建远端会话目录");
  const tmp = mkdtempSync(join(tmpdir(), "socode-provider-"));
  const localPath = join(tmp, "providers.json");
  try {
    writeFileSync(localPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(localPath, 0o600);
    const copied = scpFile(localPath, session.dest, remotePath, session.mux);
    if (copied.code !== 0) throw new Error(copied.stderr || "注入 Provider 失败");
    const locked = sshRun(session.dest, `chmod 600 ${shQuote(remotePath)}`, session.mux);
    if (locked.code !== 0) throw new Error(locked.stderr || "无法限制远端 Provider 文件权限");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  log.ok(`已注入本机 ${store.providers.length} 个 Provider（会话结束会删除）`);
  return true;
}

function wipeSessionProvider(session: SshSession, home: string, log: ConnectLogger) {
  log.info("清理远端会话 Provider…");
  const wiped = sshRun(session.dest, wipeSessionProviderScript(home), session.mux);
  if (wiped.code !== 0) {
    log.err(wiped.stderr || "清理远端 Provider 失败，请手动删除 ~/.socode-server/session/providers.json");
    return;
  }
  log.ok("远端会话 Provider 已删除");
}

export async function attachRemoteWorker(
  session: SshSession,
  workspace: string,
  opts?: {
    handshakeOnly?: boolean;
    log?: ConnectLogger;
    beforeRepl?: () => void;
  },
) {
  const log = opts?.log ?? defaultConnectLogger();
  workspace = normalizeAbsPath(workspace);
  log.info("打包 socode-runtime…");
  const packed = packRuntime();
  log.ok(`runtime stamp ${packed.stamp}`);
  log.info(`探测远端 ${session.dest}，工作区 ${workspace}`);
  const probed = sshRun(session.dest, probeScript(workspace), session.mux, { log });
  if (probed.code !== 0) throw new Error(probed.stderr || probed.stdout || `ssh ${session.dest} 失败（exit ${probed.code}）`);
  const probe = parseProbe(probed.stdout);
  if ("error" in probe) {
    throw new Error(`${probe.error}\nstderr=${probed.stderr}\nstdout=${probed.stdout}`);
  }
  log.ok(`远端 ${probe.platform.os}-${probe.platform.arch}，HOME ${probe.home}，系统 Node ${probe.nodeVersion || "无"}`);
  if (!probe.workspaceOk) throw new Error(`远端工作区不存在或不是目录: ${workspace}`);
  log.ok(`工作区可用 ${workspace}`);
  const nodePath = await ensureRemoteNode(session.dest, probe, session.mux, log);
  if (probe.runtimeStamp === packed.stamp) {
    log.ok(`使用缓存 runtime ${packed.stamp}`);
  } else {
    log.info(`上传 runtime ${packed.stamp}…`);
    const remoteTar = `${probe.home}/.socode-server/runtime/${runtimeTarName(packed.stamp)}`;
    const mkdir = sshRun(session.dest, `mkdir -p ${shQuote(`${probe.home}/.socode-server/runtime`)}`, session.mux, { log });
    if (mkdir.code !== 0) throw new Error(mkdir.stderr || "无法创建 ~/.socode-server");
    const copied = scpFile(packed.tarPath, session.dest, remoteTar, session.mux);
    if (copied.code !== 0) throw new Error(copied.stderr || `scp 失败: ${packed.tarPath}`);
    const extracted = sshRun(session.dest, extractScript(probe.home, packed.stamp, runtimeTarName(packed.stamp)), session.mux, { log });
    if (extracted.code !== 0) throw new Error(extracted.stderr || "解压 socode-runtime 失败");
    log.ok(`runtime ${packed.stamp} 已安装`);
  }
  let remoteHome = "";
  let child: ChildProcess | undefined;
  let peer: JsonRpcPeer | undefined;
  try {
    remoteHome = probe.home;
    const injected = injectSessionProvider(session, probe.home, log);
    const launch = workerScript({
      nodePath,
      runtimeRoot: runtimeRoot(probe.home, packed.stamp),
      workspace,
      env: injected ? { SOCODE_PROVIDER_STORE: sessionProviderPath(probe.home) } : undefined,
    });
    log.info("启动远端 worker…");
    child = spawn("ssh", sshExecArgs(session.dest, launch, session.mux), {
      env: nodeWorkerEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let replStarted = false;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (replStarted) {
        process.stderr.write(chunk);
        return;
      }
      for (const line of chunk.split(/\r?\n/)) {
        const text = line.trim();
        if (text) log.info(text);
      }
    });
    peer = new JsonRpcPeer(child.stdout!, child.stdin!);
    log.info("等待握手…");
    const hello = await waitForHello(child, peer, packed.stamp);
    log.ok(`握手成功 protocol=${hello.protocol} node=${hello.node} workspace=${hello.workspace}`);
    if (opts?.handshakeOnly) {
      await peer.request("shutdown", {}).catch(() => undefined);
      return hello;
    }
    opts?.beforeRepl?.();
    replStarted = true;
    await runRemoteRepl(peer, hello, { host: session.host, home: probe.home });
    log.info("远程会话已结束");
    return hello;
  } finally {
    peer?.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (remoteHome) {
      try {
        wipeSessionProvider(session, remoteHome, log);
      } catch (error) {
        log.err(error instanceof Error ? error.message : String(error));
      }
    }
  }
}

function fail(message: string): never {
  process.stderr.write(`${paintConnectLog("err", message, useColor())}\n`);
  process.exit(2);
}

export async function runConnect(raw: string, opts?: { handshakeOnly?: boolean; log?: ConnectLogger }) {
  const target = parseConnectTarget(raw);
  if ("error" in target) fail(target.error);
  const log = opts?.log ?? defaultConnectLogger();
  let session: SshSession | undefined;
  let forcedQuit = false;
  try {
    session = await openSshSession({ user: target.user, host: target.host, log });
    rememberSshHost({ user: target.user, host: target.host, lastWorkspace: target.path });
    return await attachRemoteWorker(session, target.path, { handshakeOnly: opts?.handshakeOnly, log });
  } catch (error) {
    if (isForcedQuit(error)) {
      forcedQuit = true;
    } else {
      const message = error instanceof Error ? error.message : String(error);
      log.err(message);
      process.exitCode = 2;
    }
  } finally {
    session?.close();
  }
  if (forcedQuit) process.exit(130);
  if (process.exitCode === 2) process.exit(2);
}
