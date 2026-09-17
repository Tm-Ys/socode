import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatAskDiff, paintAskDiff } from "./ask-diff.js";

describe("formatAskDiff", () => {
  it("shows a unified diff when overwriting an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-ask-"));
    const file = join(dir, "a.ts");
    try {
      writeFileSync(file, "const n = 1;\n");
      const diff = formatAskDiff("write", file, { content: "const n = 2;\n" });
      assert.match(diff, /--- /);
      assert.match(diff, /\+\+\+ /);
      assert.match(diff, /-const n = 1;/);
      assert.match(diff, /\+const n = 2;/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies edit in memory so Ask can show the real hunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-ask-"));
    const file = join(dir, "b.ts");
    try {
      writeFileSync(file, "alpha\nbeta\ngamma\n");
      const diff = formatAskDiff("edit", file, { old_string: "beta", new_string: "BETA" });
      assert.match(diff, /-beta/);
      assert.match(diff, /\+BETA/);
      assert.equal(readFileSync(file, "utf8"), "alpha\nbeta\ngamma\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews delete as removing the file contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-ask-"));
    const file = join(dir, "gone.txt");
    try {
      writeFileSync(file, "keep me\n");
      const diff = formatAskDiff("delete", file, {});
      assert.match(diff, /\+\+\+ \/dev\/null/);
      assert.match(diff, /-keep me/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paintAskDiff", () => {
  it("colors added and removed lines", () => {
    const painted = paintAskDiff("-old\n+new", true);
    assert.match(painted, /\x1b\[31m-old/);
    assert.match(painted, /\x1b\[32m\+new/);
  });
});
