import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipToWidth, paintPromptStatus, promptStatusLine, visualRows } from "./prompt.js";

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
    assert.match(paintPromptStatus("deepseek-flash · medium", true), /\x1b\[38;5;208mdeepseek-flash · medium\x1b\[0m/);
    assert.equal(paintPromptStatus("deepseek-flash · medium", false), "deepseek-flash · medium");
  });

  it("right-aligns context occupancy on the model line", () => {
    const line = promptStatusLine("deepseek-flash", "medium", {
      context: "context 5%(6.4K / 128K)",
      columns: 60,
    });
    assert.equal(line.length, 60);
    assert.ok(line.startsWith("deepseek-flash · medium"));
    assert.ok(line.endsWith("context 5%(6.4K / 128K)"));
    assert.match(line, /medium {2,}context/);
  });
});

function visibleAsciiWidth(text: string) {
  let width = 0;
  for (const char of text) {
    width += char === "…" || char.codePointAt(0)! <= 127 ? 1 : 2;
  }
  return width;
}
