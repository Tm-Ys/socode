import assert from "node:assert/strict";
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

  it("allows readonly bash outside the workspace in Ask", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: "/tmp", command: "ls" });
    assert.equal(denied, null);
  });

  it("denies mutating bash outside the workspace in Ask", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: "/tmp", command: "mkdir x" });
    assert.match(denied ?? "", /工作区外/);
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
});
