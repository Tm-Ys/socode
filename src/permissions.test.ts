import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPolicy } from "./permissions.js";

const ws = process.cwd();

describe("createPolicy", () => {
  it("denies Ask writes outside the workspace without prompting", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("write", {
      path: "/tmp/socode-outside.txt",
      content: "x",
    });
    assert.match(denied ?? "", /工作区外/);
  });

  it("denies Plan writes inside the workspace", async () => {
    const policy = createPolicy(ws, () => "plan");
    const denied = await policy.authorize("write", {
      path: `${ws}/src/index.ts`,
      content: "x",
    });
    assert.match(denied ?? "", /Plan/);
  });

  it("denies Ask bash cwd outside the workspace", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: "/tmp", command: "ls" });
    assert.match(denied ?? "", /工作区内/);
  });

  it("denies mutating bash outside the workspace in Ask", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: "/tmp", command: "mkdir x" });
    assert.match(denied ?? "", /工作区/);
  });

  it("denies Ask bash redirects to /tmp even with workspace cwd", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", {
      cwd: ws,
      command: "echo hi > /tmp/socode-audit-pwned",
    });
    assert.match(denied ?? "", /工作区外|受保护/);
  });

  it("denies Ask read of workspace .env", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("read", { path: `${ws}/.env` });
    assert.match(denied ?? "", /受保护/);
  });

  it("requires approval for git in Ask even when cwd is inside the workspace", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: ws, command: "git status" });
    assert.match(denied ?? "", /用户拒绝了执行命令|工作区外/);
  });

  it("blocks denylist paths even in Full", async () => {
    const policy = createPolicy(ws, () => "full");
    const denied = await policy.authorize("write", { path: "/etc/socode-test", content: "x" });
    assert.match(denied ?? "", /受保护/);
  });

  it("allows readonly ls in Ask inside the workspace", async () => {
    const policy = createPolicy(ws, () => "ask");
    assert.equal(await policy.authorize("bash", { cwd: ws, command: "ls" }), null);
  });

  it("hard-denies sudo in Ask", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: ws, command: "sudo ls" });
    assert.match(denied ?? "", /禁止 sudo/);
  });

  it("denies Ask bash reading .env", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: ws, command: "cat .env" });
    assert.match(denied ?? "", /受保护/);
  });

  it("denies Ask read through a symlink to /etc/passwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-"));
    const link = join(dir, "link");
    try {
      symlinkSync("/etc/passwd", link);
      const policy = createPolicy(dir, () => "ask");
      const denied = await policy.authorize("read", { path: link });
      assert.match(denied ?? "", /受保护|工作区内/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
