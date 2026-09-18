import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pairedPeers } from "./jsonrpc-peer.js";

describe("JsonRpcPeer", () => {
  it("round-trips a request and a nested ask", async () => {
    const { left, right } = pairedPeers();
    right.handle("ask", async (_method, params) => {
      const title = (params as { title?: string }).title;
      assert.equal(title, "写入");
      return { answer: "allow" };
    });
    right.handle("tools/call", async () => "ok");
    left.handle("tools/call", async () => {
      const reply = (await left.request("ask", { title: "写入" })) as { answer: string };
      assert.equal(reply.answer, "allow");
      return "wrote";
    });

    const result = await right.request("tools/call", { name: "write" });
    assert.equal(result, "wrote");
    left.close();
    right.close();
  });

  it("rejects pending calls when the peer closes", async () => {
    const { left, right } = pairedPeers();
    left.handle("sleep", () => new Promise(() => undefined));
    const pending = right.request("sleep", {});
    left.close(new Error("boom"));
    await assert.rejects(pending, /boom|已关闭/);
    right.close();
  });

  it("notifies onClose listeners", async () => {
    const { left, right } = pairedPeers();
    const closed = new Promise<string>((resolve) => left.onClose((error) => resolve(error.message)));
    right.close(new Error("gone"));
    assert.match(await closed, /gone|已关闭/);
    left.close();
  });

  it("returns method-not-found for unknown requests", async () => {
    const { left, right } = pairedPeers();
    await assert.rejects(left.request("nope"), /未知方法/);
    left.close();
    right.close();
  });

  it("skips non-JSON lines so SSH motd does not drop the next message", async () => {
    const { PassThrough } = await import("node:stream");
    const { JsonRpcPeer } = await import("./jsonrpc-peer.js");
    const input = new PassThrough();
    const output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);
    const sent = new Promise<string>((resolve) => output.once("data", (chunk) => resolve(String(chunk))));
    const got = peer.request("ping", {});
    input.write("Welcome to Ubuntu\n");
    input.write("Last login: Fri Sep 18\n");
    const msg = JSON.parse((await sent).trim()) as { id: number };
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } })}\n`);
    const result = await got;
    assert.deepEqual(result, { ok: true });
    peer.close();
  });
});
