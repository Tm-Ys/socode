import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession, sessionHasChat } from "./db.js";

describe("session persistence helpers", () => {
  it("treats a fresh session as unsaved and empty of chat", () => {
    const session = emptySession();
    assert.equal(session.persisted, false);
    assert.equal(session.id, "");
    assert.equal(sessionHasChat(session.messages), false);
    assert.equal(sessionHasChat([{ role: "system", content: "【harness mode】ask" }]), false);
    assert.equal(sessionHasChat([{ role: "user", content: "hi" }]), true);
  });
});
