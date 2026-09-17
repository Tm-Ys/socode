import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  discardEmptySession,
  emptySession,
  listConversations,
  loadSession,
  openConversation,
  openSessionStore,
  persistSession,
  replaceMessages,
  saveMessages,
  sessionsDir,
  updateConversationTitle,
} from "./db.js";

function tmpWorkspace() {
  return mkdtempSync(join(tmpdir(), "socode-db-"));
}

describe("workspace session store", () => {
  it("creates .socode/sessions and keeps chats inside that workspace", async () => {
    const a = tmpWorkspace();
    const b = tmpWorkspace();
    try {
      const storeA = await openSessionStore(a);
      const storeB = await openSessionStore(b);
      assert.equal(existsSync(join(a, ".socode", ".gitignore")), true);
      assert.match(readFileSync(join(a, ".socode", ".gitignore"), "utf8"), /sessions/);
      assert.equal(existsSync(join(sessionsDir(a), ".gitignore")), true);

      const session = emptySession();
      session.messages.push({ role: "system", content: "mode" });
      await persistSession(storeA, session, "demo-model");
      await saveMessages(storeA, session.id, [{ role: "user", content: "hello from A" }]);
      await updateConversationTitle(storeA, session.id, "A chat");

      const listedA = await listConversations(storeA);
      const listedB = await listConversations(storeB);
      assert.equal(listedA.length, 1);
      assert.equal(listedA[0].title, "A chat");
      assert.equal(listedA[0].first_user, "hello from A");
      assert.equal(listedB.length, 0);
      await assert.rejects(() => loadSession(storeB, session.id), /找不到会话/);

      const loaded = await loadSession(storeA, session.id);
      assert.equal(loaded.messages.at(-1)?.content, "hello from A");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("appends, replaces, and drops empty sessions", async () => {
    const dir = tmpWorkspace();
    try {
      const store = await openSessionStore(dir);
      const session = emptySession();
      await persistSession(store, session, "demo-model");
      await saveMessages(store, session.id, [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
      ]);
      await replaceMessages(store, session.id, [{ role: "user", content: "kept" }]);
      const loaded = await loadSession(store, session.id);
      assert.deepEqual(loaded.messages.map((message) => message.content), ["kept"]);

      const empty = emptySession();
      await persistSession(store, empty, "demo-model");
      empty.messages.push({ role: "system", content: "harness" });
      await discardEmptySession(store, empty);
      assert.equal(empty.persisted, false);
      assert.equal((await listConversations(store)).length, 1);

      const resumed = await openConversation(store, { model: "demo-model", resume: true });
      assert.equal(resumed.id, session.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
