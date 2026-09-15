import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPolicy } from "./permissions.js";
import { createSubagentStore } from "./subagent-plan.js";
import { createTaskStore } from "./task-state.js";
import { executeTool, toolSpecs } from "./tools.js";

const ws = process.cwd();

describe("task_state tool", () => {
  it("is advertised only in Long", () => {
    assert.equal(toolSpecs("long").some((tool) => tool.name === "task_state"), true);
    assert.equal(toolSpecs("ask").some((tool) => tool.name === "task_state"), false);
    assert.equal(toolSpecs("full").some((tool) => tool.name === "task_state"), false);
    assert.equal(toolSpecs("plan").some((tool) => tool.name === "task_state"), false);
  });

  it("plan still hides write/bash", () => {
    const names = toolSpecs("plan").map((tool) => tool.name);
    assert.equal(names.includes("write"), false);
    assert.equal(names.includes("bash"), false);
    assert.equal(names.includes("read"), true);
  });

  it("updates TaskState in Long", async () => {
    const tasks = createTaskStore();
    const policy = createPolicy(ws, () => "long", tasks);
    const out = await executeTool("task_state", JSON.stringify({ goal: "ship long mode", add_done: "docs" }), undefined, policy);
    assert.match(out, /ship long mode/);
    assert.equal(tasks.get().goal, "ship long mode");
    assert.deepEqual(tasks.get().done, ["docs"]);
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
    assert.deepEqual(explorer.sort(), ["calculate", "get_current_time", "read", "search"]);
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
