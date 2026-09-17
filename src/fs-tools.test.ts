import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { editAbsoluteFile, globAbsoluteDir, writeAbsoluteFile } from "./fs-tools.js";

function tmpWorkspace() {
  return mkdtempSync(join(tmpdir(), "socode-fs-"));
}

describe("globAbsoluteDir", () => {
  it("lists matching files with absolute paths and skips ignore dirs", async () => {
    const dir = tmpWorkspace();
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(dir, ".hidden"));
      writeFileSync(join(dir, "src", "a.ts"), "a");
      writeFileSync(join(dir, "src", "b.ts"), "b");
      writeFileSync(join(dir, "src", "c.js"), "c");
      writeFileSync(join(dir, "node_modules", "pkg", "x.ts"), "x");
      writeFileSync(join(dir, ".hidden", "y.ts"), "y");
      const out = await globAbsoluteDir(dir, "*.ts");
      assert.match(out, /src\/a\.ts/);
      assert.match(out, /src\/b\.ts/);
      assert.equal(out.includes("c.js"), false);
      assert.equal(out.includes("node_modules"), false);
      assert.equal(out.includes(".hidden"), false);
      assert.match(out, /\(2 files\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a relative directory", async () => {
    await assert.rejects(() => globAbsoluteDir("src", "*.ts"), /绝对/);
  });

  it("truncates long listings", async () => {
    const dir = tmpWorkspace();
    try {
      for (let i = 0; i < 205; i += 1) {
        writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");
      }
      const out = await globAbsoluteDir(dir, "*.txt");
      assert.match(out, /\+5 files/);
      assert.match(out, /\(205 files\)/);
      assert.equal(out.split("\n").filter((line) => line.endsWith(".txt")).length, 200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("editAbsoluteFile", () => {
  it("writes atomically and returns the read-back diff", async () => {
    const dir = tmpWorkspace();
    const file = join(dir, "n.ts");
    try {
      writeFileSync(file, "const n = 1;  \nconst m = 2;\n");
      const out = await editAbsoluteFile(file, "const n = 1;\nconst m = 2;", "const n = 2;\nconst m = 2;");
      assert.equal(readFileSync(file, "utf8"), "const n = 2;\nconst m = 2;\n");
      assert.match(out, /匹配=trim/);
      assert.match(out, /-const n = 1; {2}/);
      assert.match(out, /\+const n = 2;/);
      assert.equal(
        readdirSync(dir).some((name) => name.includes(".tmp")),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeAbsoluteFile", () => {
  it("replaces the target without leaving a tmp sibling", async () => {
    const dir = tmpWorkspace();
    const file = join(dir, "w.txt");
    try {
      const out = await writeAbsoluteFile(file, "hello");
      assert.match(out, /已写入/);
      assert.equal(readFileSync(file, "utf8"), "hello");
      assert.equal(
        readdirSync(dir).some((name) => name.includes(".tmp")),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
