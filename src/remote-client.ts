import { createStdioHost, printBanner, printErr } from "./display.js";
import { JsonRpcPeer } from "./jsonrpc-peer.js";
import { formatContextMeter } from "./context.js";
import { parseMode, userPrefix, type AgentMode } from "./mode.js";
import {
  confirmQuit,
  promptYou,
  promptStatusLine,
  REMOTE_QUIT_HINT,
  restoreTerminal,
  setQuitBlocked,
  watchTurnAbort,
} from "./prompt.js";
import type { PermissionAnswer } from "./prompt.js";
import type { QuestionInfo, QuestionOutcome } from "./question.js";
import { SOCODE_REMOTE_PROTOCOL, type RemoteHello, type RemoteSnapshot } from "./remote-protocol.js";
import { workareaPlaceholder } from "./workarea.js";
import type { AgentEvent } from "./agent.js";
import { handleSeesubagent } from "./worker.js";
import type { TurnResult } from "./worker.js";

const ANSWERS = new Set<PermissionAnswer>(["allow", "deny", "always"]);

export function bindDisplayHost(peer: JsonRpcPeer, host: ReturnType<typeof createStdioHost>) {
  peer.handle("event", (_method, params) => {
    const event = params as AgentEvent & { tag?: string };
    host.emitEvent(event, event.tag ? { tag: event.tag } : undefined);
  });
  peer.handle("ask", async (_method, params) => {
    const payload = params as { title?: string; detail?: string; diff?: string };
    const answer = await host.askPermission(payload.title ?? "权限", payload.detail ?? "", payload.diff);
    return { answer: ANSWERS.has(answer) ? answer : "deny" };
  });
  peer.handle("question", async (_method, params) => {
    const payload = params as { questions?: QuestionInfo[] };
    const outcome = (await host.askQuestions(payload.questions ?? [])) as QuestionOutcome;
    return { outcome };
  });
}

export class ForcedQuitError extends Error {
  readonly exitCode = 130;
  constructor() {
    super("forced quit");
    this.name = "ForcedQuitError";
  }
}

export function isForcedQuit(error: unknown): error is ForcedQuitError {
  return error instanceof ForcedQuitError;
}

export async function handshakeRemote(peer: JsonRpcPeer, clientVersion: string) {
  return (await peer.request("initialize", {
    protocol: SOCODE_REMOTE_PROTOCOL,
    clientVersion,
    columns: process.stdout.columns ?? 80,
  })) as RemoteHello & RemoteSnapshot;
}

export function waitForPushedHello(peer: JsonRpcPeer) {
  return new Promise<RemoteHello & RemoteSnapshot>((resolve, reject) => {
    if (peer.isClosed) {
      reject(new Error("JSON-RPC 连接已关闭"));
      return;
    }
    let settled = false;
    let off = () => {};
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      off();
      fn();
    };
    off = peer.onClose((error) => {
      finish(() => reject(error));
    });
    peer.handle("hello", (_method, params) => {
      const hello = params as RemoteHello & RemoteSnapshot;
      if (!hello || hello.protocol !== SOCODE_REMOTE_PROTOCOL) {
        finish(() => reject(new Error(`远端协议不匹配: ${hello?.protocol ?? "无"}`)));
        return;
      }
      finish(() => resolve(hello));
    });
  });
}

export async function runRemoteRepl(
  peer: JsonRpcPeer,
  hello: RemoteHello & RemoteSnapshot,
  view?: { host: string; home: string },
): Promise<"sshquit" | undefined> {
  let snap: RemoteSnapshot = hello;
  const host = createStdioHost(() => parseMode(snap.mode) ?? "ask");
  bindDisplayHost(peer, host);
  if (peer.isClosed) throw new Error("JSON-RPC 连接已关闭");
  printBanner(
    { title: snap.title },
    {
      mode: (parseMode(snap.mode) ?? "ask") as AgentMode,
      workspace: snap.workspace,
      mcpCount: snap.mcpCount,
      remoteHost: view?.host,
      remoteHome: view?.home,
    },
  );
  if (!snap.providerReady) {
    console.log("没有可用 Provider。请先在本机配好，远程会话会注入一份并在断开前删掉。\n");
  }

  const stop = new AbortController();
  const offClose = peer.onClose((error) => {
    stop.abort(error);
  });
  const onSigint = () => {
    confirmQuit();
  };
  process.on("SIGINT", onSigint);
  setQuitBlocked(true);
  try {
    while (true) {
      if (peer.isClosed) throw new Error("JSON-RPC 连接已关闭");
      const mode = parseMode(snap.mode) ?? "ask";
      const prompt = (
        await promptYou(userPrefix(mode), {
          hint: workareaPlaceholder(snap.workspace, view ? { host: view.host, home: view.home } : undefined),
          status: promptStatusLine(snap.model, snap.thinkingEffort, {
            session: snap.sessionLabel,
            context: formatContextMeter(snap.contextUsed, snap.contextWindow),
            columns: process.stdout.columns ?? 80,
          }),
          signal: stop.signal,
        })
      ).trim();
      if (!prompt) continue;
      if (prompt === "/sshquit" || prompt.startsWith("/sshquit ")) {
        await peer.request("shutdown", {}).catch(() => undefined);
        return "sshquit";
      }
      if (prompt === "/exit" || prompt === "/quit") {
        console.log(`\n${REMOTE_QUIT_HINT}\n`);
        continue;
      }
      if (prompt === "/seesubagent" || prompt.startsWith("/seesubagent ")) {
        handleSeesubagent(host, prompt);
        continue;
      }
      if (
        prompt === "/provider" ||
        prompt.startsWith("/provider ") ||
        prompt === "/model" ||
        prompt.startsWith("/model ") ||
        prompt === "/effort" ||
        prompt.startsWith("/effort ") ||
        prompt === "/setworkarea" ||
        prompt.startsWith("/setworkarea ") ||
        prompt === "/remote-ssh" ||
        prompt === "/ssh" ||
        prompt.startsWith("/ssh ")
      ) {
        console.log("\n已经在远程会话里。要断开请 /sshquit，会先删掉远端注入的 Provider。\n");
        continue;
      }
      host.beginTurn();
      host.startLoad();
      const watch = watchTurnAbort();
      const aborting = () => {
        void peer.request("abort", {}).catch(() => undefined);
      };
      watch.signal.addEventListener("abort", aborting);
      try {
        if (prompt.startsWith("/")) {
          const result = (await peer.request("command", { line: prompt })) as {
            text?: string;
            error?: string;
            snapshot?: RemoteSnapshot;
            aborted?: boolean;
          };
          if (result.snapshot) snap = result.snapshot;
          if (result.error) printErr(result.error);
          else if (result.text) console.log(`\n${result.text}\n`);
          continue;
        }
        const result = (await peer.request("turn/start", { text: prompt })) as TurnResult;
        const next = await peer.request("session/open", {}).catch(() => undefined);
        if (next && typeof next === "object") snap = { ...snap, ...(next as RemoteSnapshot) };
        if (result.reply !== undefined) process.stdout.write(result.endedNewline ? "\n" : "\n\n");
        if (result.recap) process.stdout.write(`\n${result.recap}\n`);
        if (result.usageLine) process.stdout.write(`${result.usageLine}\n`);
        if (result.checkpoint) process.stdout.write(`\n${result.checkpoint}\n`);
        if (result.error) printErr(result.error);
        if (result.aborted) process.stdout.write("\n已中止\n");
      } finally {
        watch.signal.removeEventListener("abort", aborting);
        watch.dispose();
        host.stopLoad();
        restoreTerminal();
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    setQuitBlocked(false);
    restoreTerminal();
    offClose();
  }
}
