import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deleteAbsoluteFile, editAbsoluteFile, writeAbsoluteFile } from "./fs-tools.js";
import { beginUndoTurn, bindUndoStore, pendingUndo, resetUndoForTests, undoLastTurn } from "./undo.js";

describe("undo last turn", () => {
  it("restores edit/write/delete from the latest writing turn only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-undo-"));
    const kept = join(dir, "kept.txt");
    const edited = join(dir, "edited.ts");
    const created = join(dir, "new.ts");
    const removed = join(dir, "old.txt");
    resetUndoForTests();
    try {
      writeFileSync(kept, "user dirty\n");
      writeFileSync(edited, "const n = 1;\n");
      writeFileSync(removed, "bye\n");

      beginUndoTurn();
      await editAbsoluteFile(edited, "const n = 1;", "const n = 2;");
      await writeAbsoluteFile(created, "hello\n");
      await deleteAbsoluteFile(removed);
      assert.equal(pendingUndo().length, 3);

      beginUndoTurn();
      assert.equal(readFileSync(edited, "utf8"), "const n = 2;\n");
      const text = await undoLastTurn();
      assert.match(text, /恢复/);
      assert.match(text, /删除/);
      assert.equal(readFileSync(edited, "utf8"), "const n = 1;\n");
      assert.equal(readFileSync(kept, "utf8"), "user dirty\n");
      assert.equal(readFileSync(removed, "utf8"), "bye\n");
      assert.throws(() => readFileSync(created, "utf8"), /ENOENT/);
    } finally {
      resetUndoForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a later writing turn replace the previous snapshot bag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-undo-"));
    const first = join(dir, "a.ts");
    const second = join(dir, "b.ts");
    resetUndoForTests();
    try {
      writeFileSync(first, "one\n");
      writeFileSync(second, "two\n");
      beginUndoTurn();
      await editAbsoluteFile(first, "one", "ONE");
      beginUndoTurn();
      await editAbsoluteFile(second, "two", "TWO");
      await undoLastTurn();
      assert.equal(readFileSync(first, "utf8"), "ONE\n");
      assert.equal(readFileSync(second, "utf8"), "two\n");
    } finally {
      resetUndoForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloads the last writing turn from .socode/undo after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-undo-"));
    const edited = join(dir, "kept.ts");
    resetUndoForTests();
    try {
      writeFileSync(edited, "const n = 1;\n");
      await bindUndoStore(dir);
      beginUndoTurn();
      await editAbsoluteFile(edited, "const n = 1;", "const n = 2;");
      assert.equal(readFileSync(edited, "utf8"), "const n = 2;\n");
      resetUndoForTests();
      await bindUndoStore(dir);
      assert.equal(pendingUndo().length, 1);
      await undoLastTurn();
      assert.equal(readFileSync(edited, "utf8"), "const n = 1;\n");
    } finally {
      resetUndoForTests();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
