import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  displayWorkarea,
  expandWorkareaPath,
  inputPlaceholder,
  parseSetworkarea,
  resolveWorkarea,
  workareaPlaceholder,
} from "./workarea.js";

describe("parseSetworkarea", () => {
  it("parses empty and path forms", () => {
    assert.equal(parseSetworkarea("/seeplan"), null);
    assert.deepEqual(parseSetworkarea("/setworkarea"), { path: "" });
    assert.deepEqual(parseSetworkarea("/setworkarea  /tmp/proj"), { path: "/tmp/proj" });
  });
});

describe("resolveWorkarea", () => {
  it("accepts an existing absolute directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-wa-"));
    try {
      const resolved = resolveWorkarea(dir);
      assert.equal("path" in resolved, true);
      if ("path" in resolved) assert.equal(resolved.path, realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects files and missing paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-wa-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "x");
    try {
      assert.match((resolveWorkarea(file) as { error: string }).error, /不是文件夹/);
      assert.match((resolveWorkarea(join(dir, "nope")) as { error: string }).error, /不存在/);
      assert.match((resolveWorkarea("relative/path") as { error: string }).error, /绝对路径/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workarea display", () => {
  it("shows on-path placeholder only when the buffer is empty", () => {
    const hint = workareaPlaceholder("/tmp/demo");
    assert.equal(hint, "on /tmp/demo");
    assert.equal(inputPlaceholder("", hint), "on /tmp/demo");
    assert.equal(inputPlaceholder("hello", hint), "");
    assert.equal(inputPlaceholder("/", hint), "");
  });

  it("shortens home to tilde", () => {
    const home = expandWorkareaPath("~");
    assert.ok(home.length > 1);
    assert.equal(displayWorkarea(home), "~");
  });
});
