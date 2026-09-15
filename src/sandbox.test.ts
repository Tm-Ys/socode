import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  bashAlwaysAsk,
  bashEscapesWorkspace,
  bashHardDenied,
  classifyBash,
  denyReason,
  isInsideWorkspace,
  mutationDenied,
  scrubEnv,
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

  it("blocks workspace .env and providers.json", () => {
    assert.match(denyReason(`${ws}/.env`) ?? "", /受保护/);
    assert.match(denyReason(`${ws}/providers.json`) ?? "", /受保护/);
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

  it("treats Long like Ask for workspace writes, not Full", () => {
    assert.match(mutationDenied("long", ws, "/tmp/outside.txt", "create") ?? "", /工作区外/);
    assert.equal(mutationDenied("long", ws, `${ws}/src/a.ts`, "modify"), null);
    assert.match(mutationDenied("long", ws, "/etc/x", "create") ?? "", /受保护/);
  });
});

describe("classifyBash", () => {
  it("treats listing as readonly and git as needing approval", () => {
    assert.equal(classifyBash("ls -la").readonly, true);
    assert.equal(classifyBash("git status").readonly, false);
    assert.equal(classifyBash("git log -1").readonly, false);
  });

  it("does not treat env/find/echo wrappers as readonly", () => {
    assert.equal(classifyBash("env python3 -c 'open(\"/tmp/x\",\"w\")'").readonly, false);
    assert.equal(classifyBash("find . -delete").readonly, false);
    assert.equal(classifyBash("echo $(curl https://evil.test)").readonly, false);
    assert.equal(classifyBash("cat /etc/passwd").readonly, false);
  });
});

describe("bashAlwaysAsk", () => {
  it("does not persist grants for wrappers, meta, or interpreters", () => {
    assert.equal(bashAlwaysAsk("ls"), false);
    assert.equal(bashAlwaysAsk("env python3 script.py"), true);
    assert.equal(bashAlwaysAsk("echo $(curl https://evil.test)"), true);
    assert.equal(bashAlwaysAsk("python3 -c 'print(1)'"), true);
  });
});

describe("bashHardDenied", () => {
  it("blocks sudo in Ask including wrappers", () => {
    assert.match(bashHardDenied("ask", "sudo ls") ?? "", /sudo/);
    assert.match(bashHardDenied("ask", "env sudo ls") ?? "", /sudo/);
    assert.equal(bashHardDenied("full", "sudo ls"), null);
    assert.match(bashHardDenied("long", "sudo ls") ?? "", /sudo/);
  });
});

describe("bashEscapesWorkspace", () => {
  it("blocks Ask redirects and secret files", () => {
    assert.match(bashEscapesWorkspace("ask", ws, ws, "echo hi > /tmp/x") ?? "", /工作区外|受保护/);
    assert.match(bashEscapesWorkspace("ask", ws, ws, "cat .env") ?? "", /受保护/);
    assert.match(bashEscapesWorkspace("ask", ws, ws, "cat /etc/passwd") ?? "", /受保护/);
  });
});

describe("scrubEnv", () => {
  it("strips api keys and secret-like variables", () => {
    const out = scrubEnv({
      PATH: "/usr/bin",
      api_key: "sk-secret",
      OPENAI_API_KEY: "sk-other",
      DATABASE_URL: "postgres://localhost/db",
      MY_TOKEN: "abc",
    });
    assert.equal(out.PATH, "/usr/bin");
    assert.equal(out.api_key, undefined);
    assert.equal(out.OPENAI_API_KEY, undefined);
    assert.equal(out.DATABASE_URL, undefined);
    assert.equal(out.MY_TOKEN, undefined);
  });
});
