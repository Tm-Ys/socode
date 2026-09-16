import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeChat } from "./chat.js";
import type { Provider } from "./provider.js";

const provider: Provider = {
  name: "t",
  url: "http://localhost",
  api: "k",
  model: "m",
  contextWindow: 8000,
  maxOutput: 256,
  thinkingEffort: "medium",
};

function sseResponse(events: unknown[]) {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n")}\ndata: [DONE]\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("completeChat thinking", () => {
  it("streams reasoning apart from the assistant body", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      sseResponse([
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "hi" } }] },
      ]);
    try {
      const thinking: string[] = [];
      const text: string[] = [];
      const result = await completeChat({
        provider,
        messages: [{ role: "user", content: "x" }],
        onThinking: (chunk) => thinking.push(chunk),
        onDelta: (chunk) => text.push(chunk),
      });
      assert.equal(thinking.join(""), "hmm");
      assert.equal(text.join(""), "hi");
      assert.equal(result.content, "hi");
      assert.equal(result.thinking, "hmm");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("keeps tagged thinking out of stored content", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () =>
      sseResponse([
        { choices: [{ delta: { content: "<think>why</think>" } }] },
        { choices: [{ delta: { content: "done" } }] },
      ]);
    try {
      const thinking: string[] = [];
      const result = await completeChat({
        provider,
        messages: [{ role: "user", content: "x" }],
        onThinking: (chunk) => thinking.push(chunk),
      });
      assert.equal(thinking.join(""), "why");
      assert.equal(result.content, "done");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
