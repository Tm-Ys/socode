import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canCompress, peelAgentPrefix, shouldAutoCompress, splitForCompress } from "./compress.js";
import { harnessModeMessage } from "./mode.js";
import type { Message } from "./db.js";
import { applyTaskPatch, emptyTaskState, isTaskStateMessage, lastTaskState, taskStateMessage } from "./task-state.js";
import { applyPlanPatch, emptyPlan, isPlanMessage, lastPlan, planMessage } from "./plan.js";
import { TURN_BUDGET_PREFIX } from "./long-budget.js";
import { harnessModeMessage } from "./mode.js";
import type { Message } from "./db.js";
import { applyTaskPatch, emptyTaskState, isTaskStateMessage, lastTaskState, taskStateMessage } from "./task-state.js";
import { applyPlanPatch, emptyPlan, isPlanMessage, lastPlan, planMessage } from "./plan.js";

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

  it("pins the latest Plan into keep", () => {
    const filler = "token ".repeat(400);
    const plan = planMessage(applyPlanPatch(emptyPlan(), { goal: "plan-me", items: ["a", "b"] }));
    const history: Message[] = [
      harnessModeMessage("ask"),
      plan,
      user(`one ${filler}`),
      assistant("ok1"),
      user("two"),
      assistant("ok2"),
      user("three"),
    ];
    const { stale, keep } = splitForCompress(history);
    assert.ok(stale.length > 0);
    assert.equal(lastPlan(keep)?.goal, "plan-me");
    assert.equal(keep.filter(isPlanMessage).length, 1);
    assert.equal(stale.some(isPlanMessage), false);
  });

  it("drops turn-budget reminders and can split by ReAct steps", () => {
    const filler = "token ".repeat(400);
    const steps: Message[] = [];
    for (let i = 0; i < 6; i += 1) {
      steps.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id: String(i), name: "read", arguments: "{}" }],
      });
      steps.push({ role: "tool", content: filler, toolCallId: String(i) });
    }
    steps.push({ role: "system", content: `${TURN_BUDGET_PREFIX}You have 1 turns left` });
    const history: Message[] = [user("go"), ...steps];
    const { stale, keep } = splitForCompress(history, { unit: "react", keepTurns: 2 });
    assert.ok(stale.length > 0);
    assert.equal(
      keep.filter((message) => message.role === "assistant" && message.toolCalls?.length).length,
      2,
    );
    assert.equal(
      [...stale, ...keep].some((message) => message.content.startsWith(TURN_BUDGET_PREFIX)),
      false,
    );
  });
});

describe("peelAgentPrefix", () => {
  it("keeps the main system prompt out of the compressed slice", () => {
    const filler = "token ".repeat(400);
    const messages: Message[] = [
      { role: "system", content: "you are socode" },
      user(`one ${filler}`),
      assistant("ok1"),
      user("two"),
    ];
    const { head, rest } = peelAgentPrefix(messages);
    assert.equal(head[0]?.content, "you are socode");
    assert.equal(rest[0]?.role, "user");
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
