import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPolicy } from "./permissions.js";

const ws = process.cwd();

describe("createPolicy", () => {
  it("uses injected askPermission instead of the TTY prompt", async () => {
    const titles: string[] = [];
    const policy = createPolicy(ws, () => "ask", undefined, {
      askPermission: async (title) => {
        titles.push(title);
        return "allow";
      },
    });
    assert.equal(
      await policy.authorize("write", { path: `${ws}/src/mode.ts`, content: "x" }),
      null,
    );
    assert.equal(titles.length, 1);
    assert.match(titles[0] ?? "", /写入|修改/);
  });

  it("asks Ask writes outside the workspace instead of hard-denying", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("write", {
      path: "/tmp/socode-outside.txt",
      content: "x",
    });
    assert.match(denied ?? "", /用户拒绝了/);
  });

  it("denies Plan writes inside the workspace", async () => {
    const policy = createPolicy(ws, () => "plan");
    const denied = await policy.authorize("write", {
      path: `${ws}/src/index.ts`,
      content: "x",
    });
    assert.match(denied ?? "", /Plan/);
  });

  it("asks Ask bash cwd outside the workspace instead of hard-denying", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: "/tmp", command: "ls" });
    assert.match(denied ?? "", /用户拒绝了/);
  });

  it("asks mutating bash outside the workspace in Ask", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: "/tmp", command: "mkdir x" });
    assert.match(denied ?? "", /用户拒绝了/);
  });

  it("asks Ask bash redirects to /tmp even with workspace cwd", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", {
      cwd: ws,
      command: "echo hi > /tmp/socode-audit-pwned",
    });
    assert.match(denied ?? "", /用户拒绝了/);
  });

  it("denies Ask read of workspace .env", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("read", { path: `${ws}/.env` });
    assert.match(denied ?? "", /受保护/);
  });

  it("requires approval for git in Ask even when cwd is inside the workspace", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("bash", { cwd: ws, command: "git status" });
    assert.match(denied ?? "", /用户拒绝了执行命令|用户拒绝了git/);
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

  it("auto-allows Long workspace reads but not unjudged writes", async () => {
    const policy = createPolicy(ws, () => "long");
    assert.equal(await policy.authorize("read", { path: `${ws}/src/mode.ts` }), null);
    assert.equal(await policy.authorize("search", { directory: `${ws}/src`, pattern: "AGENT_MODES" }), null);
    assert.equal(await policy.authorize("glob", { directory: `${ws}/src`, pattern: "*.ts" }), null);
    const denied = await policy.authorize("write", { path: `${ws}/src/mode.ts`, content: "x" });
    assert.match(denied ?? "", /审批器未配置|审批拒绝/);
  });

  it("does not treat Long as Full for deletes or secrets", async () => {
    const policy = createPolicy(ws, () => "long");
    const deleted = await policy.authorize("delete", { path: `${ws}/README.md` });
    assert.match(deleted ?? "", /审批器未配置|审批拒绝/);
    const secret = await policy.authorize("read", { path: `${ws}/.env` });
    assert.match(secret ?? "", /受保护/);
    const outside = await policy.authorize("write", { path: "/tmp/socode-outside.txt", content: "x" });
    assert.match(outside ?? "", /用户拒绝了/);
  });

  it("uses the Long LLM judge for in-workspace side effects", async () => {
    const calls: string[] = [];
    const policy = createPolicy(ws, () => "long", undefined, {
      longApprove: async (req) => {
        calls.push(req.tool);
        return { allow: req.tool === "write", reason: req.tool === "write" ? "小范围修改" : "太危险" };
      },
    });
    assert.equal(
      await policy.authorize("write", { path: `${ws}/src/mode.ts`, content: "x" }),
      null,
    );
    const denied = await policy.authorize("bash", { cwd: ws, command: "npm test" });
    assert.match(denied ?? "", /Long 审批拒绝: 太危险/);
    assert.deepEqual(calls, ["write", "bash"]);
  });

  it("asks the user for Long git instead of the LLM judge", async () => {
    let called = 0;
    const policy = createPolicy(ws, () => "long", undefined, {
      longApprove: async () => {
        called += 1;
        return { allow: true, reason: "should not run" };
      },
    });
    const denied = await policy.authorize("bash", { cwd: ws, command: "git status" });
    assert.match(denied ?? "", /用户拒绝了/);
    assert.equal(called, 0);
  });

  it("does not call the Long judge for secrets or sudo", async () => {
    let called = 0;
    const policy = createPolicy(ws, () => "long", undefined, {
      longApprove: async () => {
        called += 1;
        return { allow: true, reason: "should not run" };
      },
    });
    assert.match(
      (await policy.authorize("write", { path: "/tmp/socode-outside.txt", content: "x" })) ?? "",
      /用户拒绝了/,
    );
    assert.match((await policy.authorize("read", { path: `${ws}/.env` })) ?? "", /受保护/);
    assert.match((await policy.authorize("bash", { cwd: ws, command: "sudo ls" })) ?? "", /sudo/);
    assert.equal(called, 0);
  });

  it("Ask side effects still use human y/n, not the Long judge", async () => {
    let called = 0;
    const policy = createPolicy(ws, () => "ask", undefined, {
      longApprove: async () => {
        called += 1;
        return { allow: true, reason: "should not run" };
      },
    });
    const denied = await policy.authorize("write", { path: `${ws}/src/mode.ts`, content: "x" });
    assert.match(denied ?? "", /用户拒绝了/);
    assert.equal(called, 0);
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
      assert.match(denied ?? "", /受保护|用户拒绝了/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows parent subagent tools but not nested children", async () => {
    const parent = createPolicy(ws, () => "ask");
    assert.equal(await parent.authorize("subagent_plan", { agents: [{ prompt: "x" }] }), null);
    const child = createPolicy(ws, () => "ask", undefined, { nested: true, role: "worker" });
    assert.match((await child.authorize("subagent", {})) ?? "", /不能再派生/);
  });

  it("allows question in Ask/Plan and denies it for nested children", async () => {
    assert.equal(await createPolicy(ws, () => "ask").authorize("question", { questions: [] }), null);
    assert.equal(await createPolicy(ws, () => "plan").authorize("question", { questions: [] }), null);
    const child = createPolicy(ws, () => "ask", undefined, { nested: true });
    assert.match((await child.authorize("question", { questions: [] })) ?? "", /不能向用户提问/);
  });

  it("asks Ask glob outside the workspace instead of hard-denying", async () => {
    const policy = createPolicy(ws, () => "ask");
    const denied = await policy.authorize("glob", { directory: "/tmp", pattern: "*" });
    assert.match(denied ?? "", /用户拒绝了/);
  });

  it("keeps explorer subagents read-only", async () => {
    const policy = createPolicy(ws, () => "ask", undefined, { nested: true, role: "explorer" });
    assert.match(
      (await policy.authorize("write", { path: `${ws}/src/mode.ts`, content: "x" })) ?? "",
      /只读/,
    );
    assert.match(
      (await policy.authorize("edit", { path: `${ws}/src/mode.ts`, old_string: "a", new_string: "b" })) ?? "",
      /只读/,
    );
    assert.equal(await policy.authorize("read", { path: `${ws}/src/mode.ts` }), null);
    assert.equal(await policy.authorize("glob", { directory: `${ws}/src`, pattern: "*.ts" }), null);
    assert.match(
      (await policy.authorize("bash", { cwd: ws, command: "rm file" })) ?? "",
      /只读/,
    );
  });

  it("lets verify subagents run tests but not write", async () => {
    const policy = createPolicy(ws, () => "long", undefined, { nested: true, role: "verify" });
    assert.match(
      (await policy.authorize("write", { path: `${ws}/src/mode.ts`, content: "x" })) ?? "",
      /只读/,
    );
    assert.equal(await policy.authorize("bash", { cwd: ws, command: "npm test" }), null);
    assert.match(
      (await policy.authorize("bash", { cwd: ws, command: "curl https://example.test" })) ?? "",
      /测试\/类型检查|只读/,
    );
  });
});
