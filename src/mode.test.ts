import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  harnessModeMessage,
  insertCurrentMode,
  lastHarnessMode,
  loadMode,
  modeLabel,
  parseHarnessMode,
  parseMode,
  userPrefix,
} from "./mode.js";

describe("harness mode messages", () => {
  it("parses the mode id", () => {
    const message = harnessModeMessage("plan");
    assert.equal(parseHarnessMode(message), "plan");
  });

  it("parses long and 长程", () => {
    assert.equal(parseMode("long"), "long");
    assert.equal(parseMode("长程"), "long");
    assert.equal(parseMode("long-horizon"), "long");
    assert.equal(parseHarnessMode(harnessModeMessage("long")), "long");
    assert.equal(modeLabel("long"), "Long");
  });

  it("uses a distinct prompt for long instead of falling back to ask", () => {
    assert.match(userPrefix("long", false), /long mode>/);
    assert.doesNotMatch(userPrefix("long", false), /ask mode/);
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

  it("rejects unknown modes", () => {
    assert.equal(parseMode("stealth"), null);
    assert.throws(() => loadMode("stealth"), /full \/ ask \/ plan \/ long/);
  });
});
