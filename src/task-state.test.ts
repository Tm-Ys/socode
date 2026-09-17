import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyTaskPatch,
  checkpointReply,
  createTaskStore,
  emptyTaskState,
  lastTaskState,
  parseTaskStateMessage,
  patchFromToolArgs,
  seedGoalFromUser,
  taskStateMessage,
} from "./task-state.js";

describe("TaskState", () => {
  it("round-trips through a conversation system message", () => {
    const state = applyTaskPatch(emptyTaskState(), {
      goal: "加 Long 模式",
      addMilestone: "写测试",
      addKeyFile: "src/mode.ts",
    });
    const parsed = parseTaskStateMessage(taskStateMessage(state));
    assert.equal(parsed?.goal, "加 Long 模式");
    assert.deepEqual(parsed?.milestones, ["写测试"]);
    assert.deepEqual(parsed?.keyFiles, ["src/mode.ts"]);
  });

  it("keeps the latest snapshot from history", () => {
    const first = taskStateMessage(applyTaskPatch(emptyTaskState(), { goal: "old" }));
    const second = taskStateMessage(applyTaskPatch(emptyTaskState(), { goal: "new" }));
    assert.equal(lastTaskState([first, { role: "user", content: "hi" }, second])?.goal, "new");
  });

  it("seeds an empty goal from the first user turn", () => {
    const seeded = seedGoalFromUser(emptyTaskState(), "实现长程 harness");
    assert.equal(seeded.goal, "实现长程 harness");
    assert.equal(seedGoalFromUser(seeded, "ignored").goal, "实现长程 harness");
  });

  it("applies tool-style patches", () => {
    const store = createTaskStore();
    store.patch(patchFromToolArgs({ goal: "done", add_done: "tests", add_verify_command: "npm test" }));
    assert.equal(store.get().goal, "done");
    assert.deepEqual(store.get().done, ["tests"]);
    assert.deepEqual(store.get().verifyCommands, ["npm test"]);
  });

  it("formats a resume checkpoint", () => {
    const state = applyTaskPatch(emptyTaskState(), { goal: "long mode", addMilestone: "PR" });
    const text = checkpointReply(state, "budget", "工具步数已达上限。");
    assert.match(text, /【checkpoint】/);
    assert.match(text, /任务状态已保存/);
    assert.match(text, /不是工作区文件快照/);
    assert.match(text, /long mode/);
    assert.match(text, /PR/);
  });
});
