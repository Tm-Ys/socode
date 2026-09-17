import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applySnippetEdit, formatEditDiff } from "./patch.js";

describe("applySnippetEdit", () => {
  it("replaces an exact unique snippet", () => {
    const result = applySnippetEdit("alpha\nbeta\ngamma\n", "beta", "BETA");
    assert.equal(result.next, "alpha\nBETA\ngamma\n");
    assert.equal(result.count, 1);
    assert.equal(result.strategy, "exact");
  });

  it("normalizes CRLF when the file uses carriage returns", () => {
    const result = applySnippetEdit("alpha\r\nbeta\r\n", "alpha\nbeta", "alpha\nBETA");
    assert.equal(result.next, "alpha\r\nBETA\r\n");
    assert.equal(result.strategy, "crlf");
  });

  it("matches after trimming trailing whitespace on each line", () => {
    const result = applySnippetEdit("foo  \nbar\n", "foo\nbar", "foo\nbaz");
    assert.equal(result.next, "foo\nbaz\n");
    assert.equal(result.strategy, "trim");
  });

  it("replace_all hits every exact occurrence", () => {
    const result = applySnippetEdit("x = 1; x = 2;", "x =", "y =", true);
    assert.equal(result.next, "y = 1; y = 2;");
    assert.equal(result.count, 2);
  });

  it("refuses an empty old_string", () => {
    assert.throws(() => applySnippetEdit("abc", "", "x"), /不能为空/);
  });

  it("refuses a non-unique snippet unless replace_all", () => {
    assert.throws(() => applySnippetEdit("aa aa", "aa", "bb"), /2 处/);
  });

  it("hints at a nearby line when the snippet is missing", () => {
    assert.throws(
      () => applySnippetEdit("function runAgent() {\n  return 1;\n}\n", "function runAgent() {\n  return 2;\n}", "x"),
      /接近的片段[\s\S]*runAgent/,
    );
  });
});

describe("formatEditDiff", () => {
  it("returns a clipped unified hunk", () => {
    const diff = formatEditDiff("/tmp/a.ts", "a\nb\nc\n", "a\nB\nc\n");
    assert.match(diff, /--- \/tmp\/a\.ts/);
    assert.match(diff, /-b/);
    assert.match(diff, /\+B/);
  });
});
