import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clipToWidth,
  confirmQuit,
  paintPromptStatus,
  promptStatusLine,
  setQuitBlocked,
  takeForcedQuit,
  visualRows,
} from "./prompt.js";

describe("slash menu layout", () => {
  it("clips hints to a single terminal row", () => {
    const line = clipToWidth("  /seesubagent      查看子代理过程（默认隐藏）", 24);
    assert.ok([...line].length > 0);
    assert.ok(line.endsWith("…"));
    assert.ok(visibleAsciiWidth(line) <= 24);
  });

  it("counts wrapped input rows without treating the menu as extra prompt rows", () => {
    assert.equal(visualRows(10, 80), 1);
    assert.equal(visualRows(80, 80), 1);
    assert.equal(visualRows(81, 80), 2);
  });
});

describe("prompt status", () => {
  it("joins model and thinking effort", () => {
    assert.equal(promptStatusLine("deepseek-flash", "medium"), "deepseek-flash · medium");
    assert.equal(
      promptStatusLine("deepseek-flash", "medium", { session: "new" }),
      "deepseek-flash · medium · new",
    );
    assert.equal(
      promptStatusLine("", "medium", { session: "new" }),
      "未配置模型 · medium · new",
    );
    assert.match(paintPromptStatus("deepseek-flash · medium", true), /\x1b\[38;5;208mdeepseek-flash · medium\x1b\[0m/);
    assert.equal(paintPromptStatus("deepseek-flash · medium", false), "deepseek-flash · medium");
  });

  it("right-aligns context occupancy on the model line", () => {
    const line = promptStatusLine("deepseek-flash", "medium", {
      session: "new",
      context: "context 5%(6.4K / 128K)",
      columns: 60,
    });
    assert.ok(line.length < 60);
    assert.ok(line.startsWith("deepseek-flash · medium · new"));
    assert.ok(line.endsWith("context 5%(6.4K / 128K)"));
    assert.match(line, /new {2,}context/);
  });

  it("leaves a margin so the terminal does not wrap the status row", () => {
    const line = promptStatusLine("deepseek-flash", "medium", {
      context: "context 0%(4.5K / 1M)",
      columns: 80,
    });
    assert.ok(line.length <= 78);
    assert.ok(line.startsWith("deepseek-flash · medium"));
    assert.ok(line.endsWith("context 0%(4.5K / 1M)"));
  });
});

describe("remote quit guard", () => {
  it("never confirms quit while a remote session is open", () => {
    setQuitBlocked(true);
    try {
      assert.equal(confirmQuit(), false);
      assert.equal(confirmQuit(), false);
      assert.equal(takeForcedQuit(), false);
    } finally {
      setQuitBlocked(false);
    }
  });
});

function visibleAsciiWidth(text: string) {
  let width = 0;
  for (const char of text) {
    width += char === "…" || char.codePointAt(0)! <= 127 ? 1 : 2;
  }
  return width;
}
