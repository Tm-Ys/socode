import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeIncompleteTrace } from "./agent.js";
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
