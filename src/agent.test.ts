import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeIncompleteTrace, budgetStopReason } from "./agent.js";
import type { Message } from "./db.js";

describe("closeIncompleteTrace", () => {
  it("drops a trailing text assistant with no tools", () => {
    const trace: Message[] = [{ role: "assistant", content: "partial" }];
    assert.deepEqual(closeIncompleteTrace(trace), []);
  });

  it("keeps completed tool pairs", () => {
    const trace: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
      { role: "tool", content: "ok", toolCallId: "1" },
    ];
    assert.equal(closeIncompleteTrace(trace).length, 2);
  });

  it("keeps finished tools in a partial parallel batch", () => {
    const trace: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "1", name: "write", arguments: "{}" },
          { id: "2", name: "read", arguments: "{}" },
        ],
      },
      { role: "tool", content: "wrote", toolCallId: "1" },
    ];
    const closed = closeIncompleteTrace(trace);
    assert.equal(closed[0]?.toolCalls?.length, 1);
    assert.equal(closed[0]?.toolCalls?.[0]?.id, "1");
    assert.equal(closed[1]?.toolCallId, "1");
  });
});

describe("budgetStopReason", () => {
  it("stops Long on token or context budgets before max steps", () => {
    const usage = { promptTokens: 800, completionTokens: 250 };
    assert.equal(
      budgetStopReason({ step: 3, maxSteps: 80, usage, maxTokens: 1000 }),
      "tokens",
    );
    assert.equal(
      budgetStopReason({
        step: 3,
        maxSteps: 80,
        usage: { promptTokens: 10, completionTokens: 10 },
        maxContextTokens: 100,
        contextTokens: 120,
      }),
      "context",
    );
    assert.equal(
      budgetStopReason({
        step: 80,
        maxSteps: 80,
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
      "steps",
    );
    assert.equal(
      budgetStopReason({
        step: 3,
        maxSteps: 80,
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
      null,
    );
  });
});
