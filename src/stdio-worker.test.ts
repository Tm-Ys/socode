import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TurnAborted } from "./abort.js";
import { JsonRpcPeer, pairedPeers } from "./jsonrpc-peer.js";
import { emptyProvider } from "./provider.js";
import { payloadHasSecrets, SOCODE_REMOTE_PROTOCOL } from "./remote-protocol.js";
import { waitForPushedHello } from "./remote-client.js";
import { attachWorkerServer, createRpcHost, parseListenBind, runWorkerListen, workerHelloPayload } from "./stdio-worker.js";
import { openLocalWorker } from "./worker.js";

const provider = {
  ...emptyProvider(),
  name: "test",
  url: "https://example.test/v1",
  api: "dummy",
  model: "dummy",
};

async function startPair(dir: string, complete: NonNullable<Parameters<typeof openLocalWorker>[0]["complete"]>) {
  const { left: client, right: server } = pairedPeers();
  const events: Array<Record<string, unknown>> = [];
  let clientAsk: "allow" | "deny" | "always" = "allow";
  client.handle("event", (_method, params) => {
    events.push(params as Record<string, unknown>);
  });
  client.handle("turn/end", (_method, params) => {
    events.push({ type: "turn/end", ...(params as object) });
  });
  client.handle("ask", async () => ({ answer: clientAsk }));
  const worker = await openLocalWorker({
    host: createRpcHost(server),
    workspace: dir,
    provider,
    mode: "ask",
    agentEnabled: true,
    skipSkills: true,
    skipTitle: true,
    maxMessages: 20,
    maxSteps: 8,
    stream: false,
    complete,
  });
  attachWorkerServer(server, async () => worker);
  return {
    client,
    server,
    worker,
    events,
    setAsk(answer: "allow" | "deny" | "always") {
      clientAsk = answer;
    },
    async close() {
      await worker.close();
      client.close();
      server.close();
    },
  };
}

describe("stdio worker protocol", () => {
  it("handshakes without secrets, streams delta, writes on Ask allow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-rpc-"));
    const file = join(dir, "note.txt");
    let calls = 0;
    const pair = await startPair(dir, async ({ onDelta }) => {
      calls += 1;
      if (calls === 1) {
        onDelta?.("will write");
        return {
          content: "",
          toolCalls: [{ id: "1", name: "write", arguments: JSON.stringify({ path: file, content: "hello" }) }],
        };
      }
      return { content: "done", toolCalls: [] };
    });
    try {
      const hello = await pair.client.request("initialize", {
        protocol: SOCODE_REMOTE_PROTOCOL,
        clientVersion: "0.1.2",
      });
      assert.equal(payloadHasSecrets(hello), null);
      assert.equal((hello as { protocol: string }).protocol, SOCODE_REMOTE_PROTOCOL);
      assert.equal((hello as { workspace: string }).workspace, dir);

      pair.setAsk("allow");
      const result = (await pair.client.request("turn/start", { text: "写文件" })) as { error?: string };
      assert.equal(result.error, undefined);
      assert.equal(readFileSync(file, "utf8"), "hello");
      assert.equal(
        pair.events.some((event) => event.type === "delta" && event.text === "will write"),
        true,
      );
    } finally {
      await pair.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pushes hello so a client can handshake without writing stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-rpc-"));
    const { left: client, right: server } = pairedPeers();
    const worker = await openLocalWorker({
      host: createRpcHost(server),
      workspace: dir,
      provider,
      mode: "ask",
      agentEnabled: false,
      skipSkills: true,
      skipTitle: true,
      maxMessages: 20,
      maxSteps: 8,
      stream: false,
      complete: async () => ({ content: "ok", toolCalls: [] }),
    });
    attachWorkerServer(server, async () => worker);
    try {
      const hello = waitForPushedHello(client);
      server.notify("hello", workerHelloPayload(worker));
      const got = await hello;
      assert.equal(got.protocol, SOCODE_REMOTE_PROTOCOL);
      assert.equal(got.workspace, dir);
      assert.equal(payloadHasSecrets(got), null);
    } finally {
      await worker.close();
      client.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the file unchanged when Ask denies, then undoes an allowed write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-rpc-"));
    const file = join(dir, "note.txt");
    let calls = 0;
    const pair = await startPair(dir, async () => {
      calls += 1;
      if (calls % 2 === 1) {
        return {
          content: "",
          toolCalls: [
            {
              id: String(calls),
              name: "write",
              arguments: JSON.stringify({ path: file, content: calls === 1 ? "nope" : "hello" }),
            },
          ],
        };
      }
      return { content: "ok", toolCalls: [] };
    });
    try {
      await pair.client.request("initialize", { protocol: SOCODE_REMOTE_PROTOCOL, clientVersion: "test" });
      pair.setAsk("deny");
      await pair.client.request("turn/start", { text: "拒绝写入" });
      assert.equal(existsSafe(file), false);

      pair.setAsk("allow");
      await pair.client.request("turn/start", { text: "允许写入" });
      assert.equal(readFileSync(file, "utf8"), "hello");

      const undone = (await pair.client.request("command", { line: "/undo" })) as { text: string };
      assert.match(undone.text, /撤回|恢复|删除/);
      assert.equal(existsSafe(file), false);
    } finally {
      await pair.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aborts an in-flight turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-rpc-"));
    const pair = await startPair(dir, async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(new TurnAborted());
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
      return { content: "should not", toolCalls: [] };
    });
    try {
      await pair.client.request("initialize", { protocol: SOCODE_REMOTE_PROTOCOL, clientVersion: "test" });
      const pending = pair.client.request("turn/start", { text: "卡住" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await pair.client.request("abort", {});
      const result = (await pending) as { aborted?: boolean };
      assert.equal(result.aborted, true);
    } finally {
      await pair.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listen worker", () => {
  it("parses loopback binds only", () => {
    assert.deepEqual(parseListenBind("127.0.0.1:0"), { host: "127.0.0.1", port: 0 });
    assert.equal("error" in parseListenBind("0.0.0.0:80"), true);
    assert.equal("error" in parseListenBind("127.0.0.1"), true);
  });

  it("pushes hello over a loopback socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-listen-"));
    const portFile = join(dir, "rpc.port");
    const running = runWorkerListen({
      workspace: dir,
      flags: { "no-stream": "true", "no-agent": "true" },
      provider,
      bind: "127.0.0.1:0",
      portFile,
      skipSkills: true,
      skipTitle: true,
    });
    try {
      let port = 0;
      for (let i = 0; i < 50; i++) {
        try {
          port = Number(readFileSync(portFile, "utf8").trim());
          if (port > 0) break;
        } catch {
          /* not yet */
        }
        await sleep(50);
      }
      assert.equal(port > 0, true);
      const socket = createConnection({ host: "127.0.0.1", port });
      const peer = new JsonRpcPeer(socket, socket);
      const hello = await waitForPushedHello(peer);
      assert.equal(hello.protocol, SOCODE_REMOTE_PROTOCOL);
      assert.equal(hello.workspace, dir);
      peer.close();
      socket.end();
    } finally {
      await Promise.race([running, sleep(2000)]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function existsSafe(path: string) {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
