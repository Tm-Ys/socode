import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { JsonRpcPeer, RpcError } from "./jsonrpc-peer.js";
import { parseMode } from "./mode.js";
import { loadProvider, type Provider } from "./provider.js";
import type { PermissionAnswer } from "./prompt.js";
import type { QuestionInfo, QuestionOutcome } from "./question.js";
import {
  handshakeResult,
  payloadHasSecrets,
  publicSnapshot,
  REMOTE_ERROR,
  SOCODE_REMOTE_PROTOCOL,
  type RemoteHello,
} from "./remote-protocol.js";
import { readRuntimeStamp } from "./runtime-pack.js";
import { silentHost, type WorkerHost } from "./worker-host.js";
import { openLocalWorker, type LocalWorker } from "./worker.js";

const ANSWERS = new Set<PermissionAnswer>(["allow", "deny", "always"]);

export function createRpcHost(peer: JsonRpcPeer): WorkerHost {
  const base = silentHost();
  return {
    ...base,
    emitEvent(event, opts) {
      const payload = opts?.tag ? { ...event, tag: opts.tag } : event;
      peer.notify("event", payload);
    },
    async askPermission(title, detail, diff) {
      const reply = await peer.request("ask", { title, detail, diff });
      const answer = (reply as { answer?: unknown })?.answer;
      return typeof answer === "string" && ANSWERS.has(answer as PermissionAnswer)
        ? (answer as PermissionAnswer)
        : "deny";
    },
    async askQuestions(questions: QuestionInfo[], _signal?: AbortSignal): Promise<QuestionOutcome> {
      const reply = await peer.request("question", { questions });
      if (reply === "reject" || reply === "unavailable") return reply;
      if (Array.isArray(reply)) return reply as QuestionOutcome;
      const outcome = (reply as { outcome?: unknown })?.outcome;
      if (outcome === "reject" || outcome === "unavailable") return outcome;
      if (Array.isArray(outcome)) return outcome as QuestionOutcome;
      return "unavailable";
    },
    subagent: {
      ...base.subagent,
      record(id, event) {
        peer.notify("event", { ...event, tag: String(id) });
        return false;
      },
    },
  };
}

export function attachWorkerServer(peer: JsonRpcPeer, getWorker: () => Promise<LocalWorker>) {
  peer.handle("initialize", async (_method, params) => {
    const hs = handshakeResult(params);
    if (!hs.ok) throw new RpcError(hs.code, hs.message);
    return workerHelloPayload(await getWorker());
  });

  peer.handle("session/open", async () => {
    const worker = await getWorker();
    return publicSnapshot(worker.snapshot());
  });

  peer.handle("session/list", async () => {
    const worker = await getWorker();
    return worker.listSessions();
  });

  peer.handle("turn/start", async (_method, params) => {
    const worker = await getWorker();
    const text = typeof (params as { text?: unknown })?.text === "string" ? (params as { text: string }).text : "";
    if (!text.trim()) throw new RpcError(REMOTE_ERROR.protocol, "turn/start 缺少 text");
    const modeRaw = (params as { mode?: unknown })?.mode;
    if (typeof modeRaw === "string" && modeRaw.trim()) {
      const next = parseMode(modeRaw);
      if (!next) throw new RpcError(REMOTE_ERROR.protocol, `未知模式: ${modeRaw}`);
      if (next !== worker.mode) await worker.setMode(next);
    }
    const result = await worker.turn(text);
    peer.notify("turn/end", result);
    return result;
  });

  peer.handle("command", async (_method, params) => {
    const worker = await getWorker();
    const line = typeof (params as { line?: unknown })?.line === "string" ? (params as { line: string }).line : "";
    return await dispatchCommand(worker, line);
  });

  peer.handle("abort", async () => {
    const worker = await getWorker();
    worker.abort();
    return {};
  });

  peer.handle("shutdown", async () => {
    const worker = await getWorker();
    await worker.close();
    queueMicrotask(() => peer.close());
    return {};
  });
}

export async function dispatchCommand(worker: LocalWorker, line: string) {
  const prompt = line.trim();
  if (!prompt.startsWith("/")) return { error: "不是斜杠命令" };
  if (prompt === "/undo") return { text: await worker.undo() };
  if (prompt === "/doctor") return { text: await worker.doctor() };
  if (prompt === "/context") return { text: worker.contextText() };
  if (prompt === "/usage") return { text: worker.usageText() };
  if (prompt === "/mcp") return { text: worker.mcpText() };
  if (prompt === "/skills") return { text: worker.skillsText() };
  if (prompt === "/seeplan" || prompt.startsWith("/seeplan ")) return { text: worker.seeplanText() };
  if (prompt === "/task" || prompt.startsWith("/task ")) {
    return { text: await worker.task(prompt.slice("/task".length).trim()) };
  }
  if (prompt === "/mode" || prompt.startsWith("/mode ")) {
    const result = worker.modeText(prompt.slice("/mode".length).trim());
    if (result.changed) await worker.setMode(result.mode);
    return { text: result.text, snapshot: publicSnapshot(worker.snapshot()) };
  }
  if (prompt === "/new") {
    await worker.newSession();
    return { text: "", snapshot: publicSnapshot(worker.snapshot()) };
  }
  if (prompt === "/compress") {
    const result = await worker.compress();
    return { text: result.reply || result.error || "", aborted: result.aborted };
  }
  return { error: `worker 不支持 ${prompt.split(/\s/)[0]}` };
}

export function redirectConsoleToStderr() {
  const write = (...args: unknown[]) => {
    process.stderr.write(`${args.map((item) => String(item)).join(" ")}\n`);
  };
  console.log = write;
  console.info = write;
  console.debug = write;
  console.warn = write;
}

export function parseListenBind(raw: string): { host: string; port: number } | { error: string } {
  const trimmed = raw.trim();
  const sep = trimmed.lastIndexOf(":");
  if (sep <= 0 || sep === trimmed.length - 1) return { error: "listen 必须是 127.0.0.1:端口" };
  const host = trimmed.slice(0, sep);
  const port = Number(trimmed.slice(sep + 1));
  if (host !== "127.0.0.1" && host !== "::1") return { error: "listen 只允许 127.0.0.1" };
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: "listen 端口无效" };
  return { host, port };
}

export async function runWorkerStdio(opts: { workspace: string; flags: Record<string, string>; provider?: Provider }) {
  process.stdin.resume();
  process.stdin.ref?.();
  const peer = new JsonRpcPeer(process.stdin, process.stdout);
  await bootWorkerPeer(peer, opts);
  if (process.stdin.readableEnded) {
    process.stderr.write("socode-runtime: stdin closed after handshake\n");
    return;
  }
  await waitStreamEnd(process.stdin, "stdin closed");
}

export async function runWorkerListen(opts: {
  workspace: string;
  flags: Record<string, string>;
  provider?: Provider;
  bind?: string;
  portFile?: string;
  skipSkills?: boolean;
  skipTitle?: boolean;
}) {
  const parsed = parseListenBind(opts.bind ?? opts.flags.listen ?? "127.0.0.1:0");
  if ("error" in parsed) throw new Error(parsed.error);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsed.port, parsed.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : parsed.port;
  const portFile = opts.portFile ?? opts.flags["port-file"];
  if (portFile) {
    mkdirSync(dirname(portFile), { recursive: true });
    writeFileSync(portFile, `${port}\n`, { encoding: "utf8", mode: 0o600 });
  }
  process.stderr.write(`socode-runtime: listen ${parsed.host}:${port}\n`);
  const socket = await new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待本机转发超时")), 60_000);
    server.once("connection", (sock) => {
      clearTimeout(timer);
      resolve(sock);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  server.close();
  const peer = new JsonRpcPeer(socket, socket);
  await bootWorkerPeer(peer, opts);
  await waitStreamEnd(socket, "rpc socket closed");
}

async function bootWorkerPeer(
  peer: JsonRpcPeer,
  opts: { workspace: string; flags: Record<string, string>; provider?: Provider; skipSkills?: boolean; skipTitle?: boolean },
) {
  redirectConsoleToStderr();
  let workspace: string;
  try {
    workspace = resolveWorkspace(opts.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
    return;
  }
  const cfg = loadConfig();
  const provider = opts.provider ?? loadProvider();
  const host = createRpcHost(peer);
  const workerPromise = openLocalWorker({
    host,
    workspace,
    provider,
    mode: parseMode(opts.flags.mode ?? "") ?? cfg.mode,
    userSystem: opts.flags.system ?? cfg.systemPrompt,
    agentEnabled: opts.flags["no-agent"] !== "true",
    skipSkills: opts.skipSkills,
    skipTitle: opts.skipTitle ?? opts.skipSkills,
    maxMessages: Number(opts.flags.max) || cfg.maxContextMessages,
    maxSteps: Number(opts.flags.steps) || cfg.maxAgentSteps,
    maxTokens: Number(opts.flags.budget) || cfg.maxAgentTokens,
    stream: opts.flags["no-stream"] !== "true",
    conversationId: opts.flags.id,
    resume: opts.flags.resume === "true",
    fresh: opts.flags.new === "true",
  });
  attachWorkerServer(peer, () => workerPromise);
  const worker = await workerPromise;
  if (!peer.isClosed) peer.notify("hello", workerHelloPayload(worker));
}

function waitStreamEnd(stream: NodeJS.ReadableStream, message: string) {
  return new Promise<void>((resolve) => {
    const done = () => resolve();
    stream.once("end", () => {
      process.stderr.write(`socode-runtime: ${message}\n`);
      done();
    });
    stream.once("close", done);
  });
}

export function workerHelloPayload(worker: LocalWorker) {
  const snap = publicSnapshot(worker.snapshot());
  const hello: RemoteHello = {
    protocol: SOCODE_REMOTE_PROTOCOL,
    runtimeStamp: readRuntimeStamp(),
    node: process.versions.node,
    platform: process.platform,
    workspace: snap.workspace,
  };
  const payload = { ...hello, ...snap };
  const secret = payloadHasSecrets(payload);
  if (secret) throw new RpcError(REMOTE_ERROR.protocol, `握手载荷含密钥字段 ${secret}`);
  return payload;
}

function resolveWorkspace(raw: string) {
  const workspace = resolve(raw);
  if (!isAbsolute(workspace)) {
    throw new RpcError(REMOTE_ERROR.workspace, "工作区必须是绝对路径");
  }
  if (!existsSync(workspace) || !lstatSync(workspace).isDirectory()) {
    throw new RpcError(REMOTE_ERROR.workspace, `工作区不存在或不是目录: ${workspace}`);
  }
  return workspace;
}
