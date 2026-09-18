import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  bashAlwaysAsk,
  bashEscapesWorkspace,
  bashHardDenied,
  bashNeedsNetwork,
  bashSpawn,
  bashTouchesOutside,
  classifyBash,
  denyReason,
  extraWritableRoots,
  isInsideWorkspace,
  mutationDenied,
  protectedWritePaths,
  resolveBashSandbox,
  scrubEnv,
  tmpWritableRoots,
  writableRoots,
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

  it("allows a project under /root but still blocks root secrets", () => {
    assert.equal(denyReason("/root/server/minecraft_server/server.properties"), null);
    assert.equal(denyReason("/root/app/src/index.ts"), null);
    assert.match(denyReason("/root/.ssh/id_rsa") ?? "", /受保护/);
    assert.match(denyReason("/root/.socode/providers.json") ?? "", /受保护/);
  });

  it("allows workspace files", () => {
    assert.equal(denyReason(`${ws}/src/index.ts`), null);
  });

  it("blocks workspace .env and providers.json", () => {
    assert.match(denyReason(`${ws}/.env`) ?? "", /受保护/);
    assert.match(denyReason(`${ws}/providers.json`) ?? "", /受保护/);
  });

  it("blocks user ~/.socode config and providers", () => {
    assert.match(denyReason(join(homedir(), ".socode/config.json")) ?? "", /受保护/);
    assert.match(denyReason(join(homedir(), ".socode/providers.json")) ?? "", /受保护/);
  });

  it("blocks workspace session files", () => {
    assert.match(denyReason(`${ws}/.socode/sessions/abc.json`) ?? "", /会话目录/);
    assert.equal(denyReason(`${ws}/.socode/skills/review/SKILL.md`), null);
  });
});

describe("mutationDenied", () => {
  it("does not hard-deny Ask writes outside the workspace", () => {
    assert.equal(mutationDenied("ask", ws, "/tmp/outside.txt", "create"), null);
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

  it("does not treat Long outside-workspace writes as a local hard deny", () => {
    assert.equal(mutationDenied("long", ws, "/tmp/outside.txt", "create"), null);
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
  });

  it("classifies pipelines by every stage and fails closed on substitutions", () => {
    assert.equal(classifyBash("ls | wc -l").readonly, true);
    assert.equal(classifyBash("cat src/a.ts | rg foo").readonly, true);
    assert.equal(classifyBash("ls | tee out.txt").readonly, false);
    assert.equal(classifyBash("ls | tee out.txt").op, "modify");
    assert.equal(classifyBash("find . | xargs rm").readonly, false);
    assert.equal(classifyBash("find . | xargs rm").op, "delete");
    assert.equal(classifyBash("echo hi > /tmp/x").readonly, false);
    assert.equal(classifyBash("bash -c 'ls'").readonly, true);
    assert.equal(classifyBash("bash -c 'rm file'").readonly, false);
    assert.equal(classifyBash("echo $(rm -rf x)").readonly, false);
  });
});

describe("bashAlwaysAsk", () => {
  it("does not persist grants for wrappers, meta, or interpreters", () => {
    assert.equal(bashAlwaysAsk("ls"), false);
    assert.equal(bashAlwaysAsk("env python3 script.py"), true);
    assert.equal(bashAlwaysAsk("echo $(curl https://evil.test)"), true);
    assert.equal(bashAlwaysAsk("python3 -c 'print(1)'"), true);
    assert.equal(bashAlwaysAsk("git status"), true);
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
  it("still blocks secret files, and leaves outside-workspace paths for Ask", () => {
    assert.equal(bashEscapesWorkspace("ask", ws, ws, "echo hi > /tmp/x"), null);
    assert.match(bashEscapesWorkspace("ask", ws, ws, "cat .env") ?? "", /受保护/);
    assert.match(bashEscapesWorkspace("ask", ws, ws, "cat /etc/passwd") ?? "", /受保护/);
  });
});

describe("bashTouchesOutside", () => {
  it("detects cwd and redirects that leave the workspace", () => {
    assert.equal(bashTouchesOutside(ws, ws, "ls"), false);
    assert.equal(bashTouchesOutside(ws, "/tmp", "ls"), true);
    assert.equal(bashTouchesOutside(ws, ws, "echo hi > /tmp/x"), true);
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

describe("Codex-style workspace-write sandbox", () => {
  it("treats tmp as a writable root", () => {
    assert.equal(tmpWritableRoots().includes("/tmp"), true);
    assert.equal(writableRoots({ workspace: ws, confineWrites: true }).includes("/tmp"), true);
    assert.equal(writableRoots({ workspace: ws, confineWrites: true }).includes(ws), true);
  });

  it("keeps network off for local commands and on for curl/git fetch/npm install", () => {
    assert.equal(bashNeedsNetwork("ls"), false);
    assert.equal(bashNeedsNetwork("npm test"), false);
    assert.equal(bashNeedsNetwork("npm run lint"), false);
    assert.equal(bashNeedsNetwork("curl https://example.test"), true);
    assert.equal(bashNeedsNetwork("git fetch origin"), true);
    assert.equal(bashNeedsNetwork("git status"), false);
    assert.equal(bashNeedsNetwork("npm install"), true);
    assert.equal(bashNeedsNetwork("bash -c 'curl https://example.test'"), true);
  });

  it("Ask/Long stay confined; git and /tmp do not unsandbox the whole command", () => {
    const askLs = resolveBashSandbox("ask", ws, ws, "ls");
    assert.equal(askLs.confineWrites, true);
    assert.equal(askLs.allowNetwork, false);
    assert.equal(askLs.protectGit, true);

    const askGit = resolveBashSandbox("ask", ws, ws, "git commit -m x");
    assert.equal(askGit.confineWrites, true);
    assert.equal(askGit.protectGit, false);
    assert.equal(askGit.allowNetwork, false);

    const askCurl = resolveBashSandbox("long", ws, ws, "curl -o out https://example.test");
    assert.equal(askCurl.confineWrites, true);
    assert.equal(askCurl.allowNetwork, true);

    const askTmp = resolveBashSandbox("ask", ws, ws, "echo hi > /tmp/x");
    assert.equal(askTmp.confineWrites, true);
    assert.deepEqual(askTmp.extraWritable, []);

    const full = resolveBashSandbox("full", ws, ws, "curl https://example.test");
    assert.equal(full.confineWrites, false);
    assert.equal(full.allowNetwork, true);
  });

  it("adds an approved outside directory without using / as a writable root", () => {
    const roots = extraWritableRoots(ws, ws, `echo hi > ${homedir()}/outside-socode-test.txt`);
    assert.equal(roots.includes("/"), false);
    assert.equal(roots.includes(homedir()), true);
  });

  it("re-mounts .git and sessions read-only unless git is approved", () => {
    const root = mkdtempSync(join(tmpdir(), "socode-sbx-"));
    try {
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, ".socode", "sessions"), { recursive: true });
      writeFileSync(join(root, "a.ts"), "export {}\n");
      const protectedPaths = protectedWritePaths({ workspace: root, confineWrites: true, protectGit: true });
      assert.equal(protectedPaths.includes(join(root, ".git")), true);
      assert.equal(protectedPaths.includes(join(root, ".socode", "sessions")), true);
      assert.equal(protectedWritePaths({ workspace: root, protectGit: false }).includes(join(root, ".git")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits a confined seatbelt/bwrap policy with tmp, no network, and git carveout", () => {
    const root = mkdtempSync(join(tmpdir(), "socode-sbx-"));
    try {
      mkdirSync(join(root, ".git"));
      const spec = bashSpawn("ls", {
        workspace: root,
        cwd: root,
        confineWrites: true,
        allowNetwork: false,
        protectGit: true,
      });
      const blob = spec.args.join(" ");
      if (process.platform === "darwin") {
        assert.equal(spec.file, "/usr/bin/sandbox-exec");
        assert.match(blob, /deny network\*/);
        assert.match(blob, /\/tmp/);
        assert.match(blob, /\.git/);
        assert.doesNotMatch(blob, /allow network-outbound\)/);
      }
      if (process.platform === "linux") {
        assert.equal(spec.file, "/usr/bin/bwrap");
        assert.equal(spec.args.includes("--unshare-net"), true);
        assert.equal(spec.args.includes("/tmp"), true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
