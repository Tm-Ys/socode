import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canCompress, shouldAutoCompress, splitForCompress } from "./compress.js";
import { harnessModeMessage } from "./mode.js";
import type { Message } from "./db.js";
import { applyTaskPatch, emptyTaskState, isTaskStateMessage, lastTaskState, taskStateMessage } from "./task-state.js";

function user(content: string): Message {
  return { role: "user", content };
}

function assistant(content: string): Message {
  return { role: "assistant", content };
}

describe("splitForCompress", () => {
  it("pins the latest TaskState and harness mode into keep", () => {
    const filler = "token ".repeat(400);
    const task = taskStateMessage(applyTaskPatch(emptyTaskState(), { goal: "keep-me" }));
    const history: Message[] = [
      harnessModeMessage("long"),
      task,
      user(`one ${filler}`),
      assistant("ok1"),
      user("two"),
      assistant("ok2"),
      user("three"),
    ];
    const { stale, keep } = splitForCompress(history);
    assert.ok(stale.length > 0);
    assert.equal(lastTaskState(keep)?.goal, "keep-me");
    assert.equal(keep.filter(isTaskStateMessage).length, 1);
    assert.equal(keep.some((message) => message.content.startsWith("【harness mode】long")), true);
    assert.equal(stale.some(isTaskStateMessage), false);
  });
});

describe("shouldAutoCompress", () => {
  it("requires both compressible history and context pressure", () => {
    const filler = "token ".repeat(1200);
    const history: Message[] = [
      user(`one ${filler}`),
      assistant("ok1"),
      user("two"),
      assistant("ok2"),
      user("three"),
    ];
    assert.equal(canCompress(history), true);
    assert.equal(shouldAutoCompress({ history }), false);
    assert.equal(
      shouldAutoCompress({
        history,
        report: {
          window: 1000,
          maxOutput: 100,
          budget: 744,
          system: 10,
          tools: 10,
          messages: 900,
          messageCount: 5,
          keptCount: 3,
          droppedCount: 2,
          droppedTokens: 200,
          used: 920,
          free: 0,
          slices: [],
        },
      }),
      true,
    );
  });
});
