import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  classifyBash,
  denyReason,
  isInsideWorkspace,
  mutationDenied,
} from "./sandbox.js";

const ws = "/Users/demo/proj";

describe("isInsideWorkspace", () => {
  it("accepts the root and nested files", () => {
    assert.equal(isInsideWorkspace(ws, ws), true);
    assert.equal(isInsideWorkspace(ws, `${ws}/src/index.ts`), true);
  });

  it("rejects siblings and parent escapes", () => {
    assert.equal(isInsideWorkspace(ws, "/Users/demo/other"), false);
    assert.equal(isInsideWorkspace(ws, "/tmp/file"), false);
    assert.equal(isInsideWorkspace(ws, `${ws}/../secret`), false);
  });
});

describe("denyReason", () => {
  it("blocks system and secret paths", () => {
    assert.match(denyReason("/etc/passwd") ?? "", /受保护/);
    assert.match(denyReason(join(homedir(), ".ssh/id_rsa")) ?? "", /受保护/);
  });

  it("allows workspace files", () => {
    assert.equal(denyReason(`${ws}/src/index.ts`), null);
  });
});

describe("mutationDenied", () => {
  it("blocks Ask writes outside the workspace", () => {
    const denied = mutationDenied("ask", ws, "/tmp/outside.txt", "create");
    assert.match(denied ?? "", /工作区外/);
  });

  it("allows Ask writes inside the workspace", () => {
    assert.equal(mutationDenied("ask", ws, `${ws}/src/a.ts`, "modify"), null);
  });

  it("blocks Plan writes even inside the workspace", () => {
    assert.match(mutationDenied("plan", ws, `${ws}/src/a.ts`, "modify") ?? "", /Plan/);
  });

  it("allows Full writes outside except denylist", () => {
    assert.equal(mutationDenied("full", ws, "/tmp/outside.txt", "create"), null);
    assert.match(mutationDenied("full", ws, "/etc/x", "create") ?? "", /受保护/);
  });
});

describe("classifyBash", () => {
  it("treats listing as readonly and git as needing approval", () => {
    assert.equal(classifyBash("ls -la").readonly, true);
    assert.equal(classifyBash("git status").readonly, false);
    assert.equal(classifyBash("git log -1").readonly, false);
  });

  it("treats rm, redirects and npm install as mutating", () => {
    assert.equal(classifyBash("rm file").readonly, false);
    assert.equal(classifyBash("echo x > f").readonly, false);
    assert.equal(classifyBash("npm install").readonly, false);
    assert.equal(classifyBash("python3 foo.py").readonly, false);
  });
});
