import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipToWidth, visualRows } from "./prompt.js";

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

function visibleAsciiWidth(text: string) {
  let width = 0;
  for (const char of text) {
    width += char === "…" || char.codePointAt(0)! <= 127 ? 1 : 2;
  }
  return width;
}
