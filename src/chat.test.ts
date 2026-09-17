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

describe("completeChat retry", () => {
  it("retries 429 twice then succeeds without a second user-visible stream", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    const sleeps: number[] = [];
    globalThis.fetch = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return sseResponse([{ choices: [{ delta: { content: "ok" } }] }]);
    };
    try {
      const result = await completeChat({
        provider,
        messages: [{ role: "user", content: "x" }],
        sleepForRetry: async (ms) => {
          sleeps.push(ms);
        },
      });
      assert.equal(calls, 3);
      assert.equal(result.content, "ok");
      assert.deepEqual(sleeps, [0, 0]);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("retries fetch failures from network jitter", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("fetch failed");
        (error as { code?: string }).code = "ECONNRESET";
        throw error;
      }
      return sseResponse([{ choices: [{ delta: { content: "hi" } }] }]);
    };
    try {
      const result = await completeChat({
        provider,
        messages: [{ role: "user", content: "x" }],
        sleepForRetry: async () => undefined,
      });
      assert.equal(calls, 2);
      assert.equal(result.content, "hi");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("does not retry 401", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
    };
    try {
      await assert.rejects(
        () =>
          completeChat({
            provider,
            messages: [{ role: "user", content: "x" }],
            sleepForRetry: async () => {
              throw new Error("should not sleep");
            },
          }),
        /Invalid API key/,
      );
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

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
