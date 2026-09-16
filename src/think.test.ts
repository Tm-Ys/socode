import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  absorbChatDelta,
  finishThinkStream,
  newThinkSplitState,
  newThinkStream,
  splitThinkChunk,
  reasoningFromUnknown,
} from "./think.js";

describe("splitThinkChunk", () => {
  it("splits think tags from the assistant body", () => {
    const state = newThinkSplitState();
    const first = splitThinkChunk(state, "<think>hmm</think>hi");
    assert.equal(first.thinking, "hmm");
    assert.equal(first.text, "hi");
  });

  it("handles tags split across chunks and case variants", () => {
    const state = newThinkSplitState();
    assert.deepEqual(splitThinkChunk(state, "<th"), { thinking: "", text: "" });
    assert.deepEqual(splitThinkChunk(state, "ink>why"), { thinking: "why", text: "" });
    const last = splitThinkChunk(state, "</THINK>\nOK");
    assert.equal(last.thinking, "");
    assert.equal(last.text, "\nOK");
  });
});

describe("absorbChatDelta", () => {
  it("reads reasoning_content without mixing it into text", () => {
    const stream = newThinkStream();
    const thought = absorbChatDelta(stream, { reasoning_content: "plan", content: "answer" });
    assert.equal(thought.thinking, "plan");
    assert.equal(thought.text, "answer");
  });

  it("reads nested reasoning objects", () => {
    const stream = newThinkStream();
    const thought = absorbChatDelta(stream, {
      reasoning: { summary: [{ text: "a" }, { content: "b" }] },
      content: "c",
    });
    assert.equal(thought.thinking, "ab");
    assert.equal(thought.text, "c");
  });

  it("does not duplicate tagged thinking when a reasoning field exists", () => {
    const stream = newThinkStream();
    const first = absorbChatDelta(stream, {
      reasoning_content: "plan",
      content: "<think>plan</think>answer",
    });
    assert.equal(first.thinking, "plan");
    assert.equal(first.text, "answer");
  });

  it("flushes a held partial tag into the current bucket", () => {
    const think = newThinkStream();
    const mid = absorbChatDelta(think, { content: "<think>x<" });
    assert.equal(mid.thinking, "x");
    const rest = finishThinkStream(think);
    assert.equal(rest.thinking, "<");
    assert.equal(rest.text, "");

    const open = newThinkStream();
    const part = absorbChatDelta(open, { content: "hi<" });
    assert.equal(part.text, "hi");
    const flushed = finishThinkStream(open);
    assert.equal(flushed.text, "<");
  });
});

describe("reasoningFromUnknown", () => {
  it("prefers reasoning_content", () => {
    assert.equal(reasoningFromUnknown({ reasoning_content: "x", thinking: "y" }), "x");
    assert.equal(reasoningFromUnknown({ reasoning: "z" }), "z");
  });
});
