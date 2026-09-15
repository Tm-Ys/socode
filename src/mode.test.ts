import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  harnessModeMessage,
  insertCurrentMode,
  lastHarnessMode,
  parseHarnessMode,
} from "./mode.js";

describe("harness mode messages", () => {
  it("parses the mode id", () => {
    const message = harnessModeMessage("plan");
    assert.equal(parseHarnessMode(message), "plan");
  });

  it("inserts a notice before the latest user message when mode changes", () => {
    const ask = harnessModeMessage("ask");
    const history = [ask, { role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "ok" }];
    const next = insertCurrentMode([...history, { role: "user", content: "now plan" }], "plan");
    assert.equal(lastHarnessMode(next), "plan");
    assert.equal(next.at(-1)?.content, "now plan");
    assert.equal(next.filter((message) => parseHarnessMode(message)).length, 2);
  });

  it("does not duplicate the current mode notice", () => {
    const ask = harnessModeMessage("ask");
    const once = insertCurrentMode([ask, { role: "user", content: "hi" }], "ask");
    assert.equal(once.filter((message) => parseHarnessMode(message)).length, 1);
  });
});
