import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createPolicy } from "./permissions.js";
import { createSubagentStore } from "./subagent-plan.js";
import { createTaskStore } from "./task-state.js";
import { createPlanStore } from "./plan.js";
import { executeTool, toolSpecs } from "./tools.js";

const ws = process.cwd();

describe("task_state tool", () => {
  it("is advertised only in Long", () => {
    assert.equal(toolSpecs("long").some((tool) => tool.name === "task_state"), true);
    assert.equal(toolSpecs("long").some((tool) => tool.name === "context_compress"), true);
    assert.equal(toolSpecs("ask").some((tool) => tool.name === "context_compress"), false);
    assert.equal(toolSpecs("long", { nested: true }).some((tool) => tool.name === "context_compress"), false);
    assert.equal(toolSpecs("ask").some((tool) => tool.name === "task_state"), false);
    assert.equal(toolSpecs("full").some((tool) => tool.name === "task_state"), false);
    assert.equal(toolSpecs("plan").some((tool) => tool.name === "task_state"), false);
  });

  it("plan still hides write/bash", () => {
    const names = toolSpecs("plan").map((tool) => tool.name);
    assert.equal(names.includes("write"), false);
    assert.equal(names.includes("edit"), false);
    assert.equal(names.includes("bash"), false);
    assert.equal(names.includes("read"), true);
    assert.equal(names.includes("search"), true);
    assert.equal(names.includes("glob"), true);
    assert.equal(names.includes("plan"), true);
    assert.equal(names.includes("question"), true);
  });

  it("updates TaskState in Long", async () => {
    const tasks = createTaskStore();
    const policy = createPolicy(ws, () => "long", tasks);
    const out = await executeTool("task_state", JSON.stringify({ goal: "ship long mode", add_done: "docs" }), undefined, policy);
    assert.match(out, /ship long mode/);
    assert.equal(tasks.get().goal, "ship long mode");
    assert.deepEqual(tasks.get().done, ["docs"]);
  });

  it("runs verifyCommands when a milestone is marked done", async () => {
    const tasks = createTaskStore();
    tasks.patch({ addVerifyCommand: "true" });
    const policy = createPolicy(ws, () => "long", tasks);
    const out = await executeTool("task_state", JSON.stringify({ add_done: "ship" }), undefined, policy);
    assert.match(out, /验证通过/);
    assert.deepEqual(tasks.get().done, ["ship"]);
  });

  it("reverts done and records failure when verifyCommands fail", async () => {
    const tasks = createTaskStore();
    tasks.patch({ addVerifyCommand: "false" });
    const policy = createPolicy(ws, () => "long", tasks);
    const out = await executeTool("task_state", JSON.stringify({ add_done: "ship" }), undefined, policy);
    assert.match(out, /验证失败/);
    assert.deepEqual(tasks.get().done, []);
    assert.match(tasks.get().failures.join(" "), /verify 失败/);
  });

  it("does not treat verifyCommands as an arbitrary bash bypass", async () => {
    const tasks = createTaskStore();
    tasks.patch({ addVerifyCommand: "curl https://example.test" });
    const policy = createPolicy(ws, () => "long", tasks);
    const out = await executeTool("task_state", JSON.stringify({ add_done: "ship" }), undefined, policy);
    assert.match(out, /验证失败/);
    assert.match(out, /任意 bash/);
    assert.deepEqual(tasks.get().done, []);
  });

  it("blocks add_done when rubric fails closed", async () => {
    const tasks = createTaskStore();
    tasks.patch({ addVerifyCommand: "true" });
    const policy = createPolicy(ws, () => "long", tasks, {
      longRubric: {
        ensure: async () => ({ error: "准则太少（0）" }),
        score: async () => ({
          at: new Date().toISOString(),
          milestone: "ship",
          score: 0,
          pass: false,
          items: [],
          failClosedReason: "还没有 rubric",
        }),
      },
    });
    const out = await executeTool("task_state", JSON.stringify({ add_done: "ship" }), undefined, policy);
    assert.match(out, /评分失败|未过/);
    assert.deepEqual(tasks.get().done, []);
  });

  it("refuses task_state outside Long", async () => {
    const policy = createPolicy(ws, () => "ask");
    const out = await executeTool("task_state", JSON.stringify({ goal: "x" }), undefined, policy);
    assert.match(out, /权限拒绝/);
  });
});

describe("subagent tools", () => {
  it("is advertised in Ask/Full/Long but not Plan or nested children", () => {
    for (const mode of ["ask", "full", "long"] as const) {
      const names = toolSpecs(mode).map((tool) => tool.name);
      assert.equal(names.includes("subagent_plan"), true);
      assert.equal(names.includes("subagent"), true);
    }
    assert.equal(toolSpecs("plan").some((tool) => tool.name === "subagent"), false);
    assert.equal(toolSpecs("ask", { nested: true }).some((tool) => tool.name === "subagent"), false);
    const explorer = toolSpecs("ask", { nested: true, role: "explorer" }).map((tool) => tool.name);
    assert.deepEqual(explorer.sort(), ["calculate", "get_current_time", "glob", "read", "search"]);
    const verify = toolSpecs("long", { nested: true, role: "verify" }).map((tool) => tool.name);
    assert.equal(verify.includes("bash"), true);
    assert.equal(verify.includes("write"), false);
  });

  it("stores a plan then requires the runner to execute", async () => {
    const store = createSubagentStore();
    const policy = createPolicy(ws, () => "ask", undefined, { subagents: store });
    const planned = await executeTool(
      "subagent_plan",
      JSON.stringify({
        goal: "split work",
        agents: [
          { kind: "explorer", label: "look", prompt: "find authorize" },
          { kind: "worker", prompt: "edit one file" },
        ],
      }),
      undefined,
      policy,
    );
    assert.match(planned, /2 个任务/);
    assert.equal(store.get()?.jobs.length, 2);
    const missing = await executeTool("subagent", "{}", undefined, policy);
    assert.match(missing, /运行器未配置/);
    policy.spawnSubagent = async () => "ran-2";
    const ran = await executeTool("subagent", "{}", undefined, policy);
    assert.equal(ran, "ran-2");
  });

  it("refuses planning in Plan mode", async () => {
    const policy = createPolicy(ws, () => "plan", undefined, { subagents: createSubagentStore() });
    const out = await executeTool(
      "subagent_plan",
      JSON.stringify({ agents: [{ prompt: "x" }] }),
      undefined,
      policy,
    );
    assert.match(out, /权限拒绝|Plan/);
  });
});

describe("edit tool", () => {
  it("replaces a unique snippet and refuses ambiguous matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-edit-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "const a = 1;\nconst b = 1;\n");
    const policy = createPolicy(dir, () => "full");
    try {
      const once = await executeTool(
        "edit",
        JSON.stringify({ path: file, old_string: "const a = 1;", new_string: "const a = 2;" }),
        undefined,
        policy,
      );
      assert.match(once, /已编辑/);
      assert.equal(readFileSync(file, "utf8"), "const a = 2;\nconst b = 1;\n");
      const amb = await executeTool(
        "edit",
        JSON.stringify({ path: file, old_string: " = ", new_string: " := " }),
        undefined,
        policy,
      );
      assert.match(amb, /找到 2 处|工具执行失败/);
      const all = await executeTool(
        "edit",
        JSON.stringify({ path: file, old_string: "const ", new_string: "let ", replace_all: true }),
        undefined,
        policy,
      );
      assert.match(all, /2 处/);
      assert.equal(readFileSync(file, "utf8"), "let a = 2;\nlet b = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan tool", () => {
  it("is advertised in Ask/Full/Long/Plan but not nested children", () => {
    for (const mode of ["ask", "full", "long", "plan"] as const) {
      assert.equal(toolSpecs(mode).some((tool) => tool.name === "plan"), true);
    }
    assert.equal(toolSpecs("ask", { nested: true }).some((tool) => tool.name === "plan"), false);
  });

  it("writes items, checks them off, and requires review before finishing", async () => {
    const plans = createPlanStore();
    const policy = createPolicy(ws, () => "ask", undefined, { plans });
    const created = await executeTool(
      "plan",
      JSON.stringify({ goal: "加计划", items: ["拆", "接", "审"] }),
      undefined,
      policy,
    );
    assert.match(created, /1\. 拆/);
    await executeTool("plan", JSON.stringify({ done: [1, 2] }), undefined, policy);
    const last = await executeTool("plan", JSON.stringify({ done: 3 }), undefined, policy);
    assert.match(last, /全部勾完/);
    assert.match(last, /写入 review/);
    const reviewed = await executeTool("plan", JSON.stringify({ review: "对照过了" }), undefined, policy);
    assert.match(reviewed, /审查已记录/);
    assert.match(plans.get().review, /对照过了/);
  });

  it("refuses review while items remain", async () => {
    const plans = createPlanStore();
    const policy = createPolicy(ws, () => "ask", undefined, { plans });
    await executeTool("plan", JSON.stringify({ items: ["a", "b"], done: 1 }), undefined, policy);
    const out = await executeTool("plan", JSON.stringify({ review: "too soon" }), undefined, policy);
    assert.match(out, /未勾选/);
    assert.equal(plans.get().review, "");
  });
});

describe("question tool", () => {
  const payload = {
    questions: [
      {
        question: "用哪种存储？",
        header: "存储",
        options: [
          { label: "SQLite (Recommended)", description: "本地文件" },
          { label: "PostgreSQL", description: "已有库" },
        ],
      },
    ],
  };

  it("is advertised in Ask/Full/Long/Plan but not nested children", () => {
    for (const mode of ["ask", "full", "long", "plan"] as const) {
      assert.equal(toolSpecs(mode).some((tool) => tool.name === "question"), true);
    }
    assert.equal(toolSpecs("ask", { nested: true }).some((tool) => tool.name === "question"), false);
    assert.equal(toolSpecs("ask", { nested: true, role: "explorer" }).some((tool) => tool.name === "question"), false);
  });

  it("returns the user's answers", async () => {
    const policy = createPolicy(ws, () => "ask", undefined, {
      askQuestions: async () => [["SQLite (Recommended)"]],
    });
    const out = await executeTool("question", JSON.stringify(payload), undefined, policy);
    assert.match(out, /SQLite \(Recommended\)/);
    assert.match(out, /User has answered your questions/);
  });

  it("is allowed in Plan mode", async () => {
    const policy = createPolicy(ws, () => "plan", undefined, {
      askQuestions: async () => [["PostgreSQL"]],
    });
    const out = await executeTool("question", JSON.stringify(payload), undefined, policy);
    assert.match(out, /PostgreSQL/);
  });

  it("reports dismiss without assuming answers", async () => {
    const policy = createPolicy(ws, () => "ask", undefined, {
      askQuestions: async () => "reject",
    });
    const out = await executeTool("question", JSON.stringify(payload), undefined, policy);
    assert.match(out, /取消了问卷/);
  });

  it("refuses nested subagents", async () => {
    const policy = createPolicy(ws, () => "ask", undefined, { nested: true });
    const out = await executeTool("question", JSON.stringify(payload), undefined, policy);
    assert.match(out, /子代理不能向用户提问/);
  });
});
