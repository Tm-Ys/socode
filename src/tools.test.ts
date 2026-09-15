import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPolicy } from "./permissions.js";
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
