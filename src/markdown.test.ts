import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  displayRows,
  finishMarkdownLive,
  newMarkdownLive,
  paintMarkdownDelta,
  renderMarkdown,
} from "./markdown.js";

describe("renderMarkdown", () => {
  it("strips markers without color and paints with color", () => {
    assert.equal(renderMarkdown("**bold** and `code`"), "bold and code");
    assert.match(renderMarkdown("**bold**", { color: true }), /\x1b\[1mbold\x1b\[0m/);
    assert.match(renderMarkdown("`x`", { color: true }), /\x1b\[36mx\x1b\[0m/);
    assert.equal(renderMarkdown("file_name.ts"), "file_name.ts");
    assert.equal(renderMarkdown("*hi*"), "hi");
  });

  it("renders headings, lists, quotes, fences, and links", () => {
    const src = ["# Title", "", "- item", "> note", "```", "const a = 1", "```", "[docs](https://x.test)"].join("\n");
    const plain = renderMarkdown(src);
    assert.match(plain, /Title/);
    assert.match(plain, /• item/);
    assert.match(plain, /note/);
    assert.match(plain, /const a = 1/);
    assert.match(plain, /docs https:\/\/x\.test/);
    const color = renderMarkdown("## Head", { color: true });
    assert.match(color, /\x1b\[1m/);
  });

  it("keeps an open fence until it closes", () => {
    assert.equal(renderMarkdown("```\nnot done"), "not done");
  });
});

describe("markdown live reprint", () => {
  it("rewinds previous rows then writes the rendered body", () => {
    const chunks: string[] = [];
    const live = newMarkdownLive();
    paintMarkdownDelta({
      live,
      chunk: "**a**",
      prefix: "P ",
      write: (text) => chunks.push(text),
      columns: 80,
      color: false,
    });
    assert.equal(chunks.join(""), "P a");
    assert.equal(live.rows, 1);
    chunks.length = 0;
    paintMarkdownDelta({
      live,
      chunk: "**b**",
      prefix: "P ",
      write: (text) => chunks.push(text),
      columns: 80,
      color: false,
    });
    assert.equal(chunks[0], "\r");
    assert.equal(chunks.at(-1), "P ab");
    finishMarkdownLive(live);
    assert.equal(live.raw, "");
  });

  it("counts wrapped rows", () => {
    assert.equal(displayRows("abcd", 2), 2);
    assert.equal(displayRows("a\nb", 80), 2);
  });
});
