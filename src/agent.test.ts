import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeIncompleteTrace, budgetStopReason, runAgent } from "./agent.js";
import type { Message } from "./db.js";
import { createPolicy } from "./permissions.js";
import { resolveLongBudget } from "./long-budget.js";
import { createTaskStore } from "./task-state.js";

describe("closeIncompleteTrace", () => {
  it("drops a trailing text assistant with no tools", () => {
    const trace: Message[] = [{ role: "assistant", content: "partial" }];
    assert.deepEqual(closeIncompleteTrace(trace), []);
  });

  it("keeps completed tool pairs", () => {
    const trace: Message[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", arguments: "{}" }] },
      { role: "tool", content: "ok", toolCallId: "1" },
    ];
    assert.equal(closeIncompleteTrace(trace).length, 2);
  });

  it("keeps finished tools in a partial parallel batch", () => {
    const trace: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "1", name: "write", arguments: "{}" },
          { id: "2", name: "read", arguments: "{}" },
        ],
      },
      { role: "tool", content: "wrote", toolCallId: "1" },
    ];
    const closed = closeIncompleteTrace(trace);
    assert.equal(closed[0]?.toolCalls?.length, 1);
    assert.equal(closed[0]?.toolCalls?.[0]?.id, "1");
    assert.equal(closed[1]?.toolCallId, "1");
  });
});

describe("budgetStopReason", () => {
  it("stops Long on token or context budgets before max steps", () => {
    const usage = { promptTokens: 800, completionTokens: 250 };
    assert.equal(
      budgetStopReason({ step: 3, maxSteps: 80, usage, maxTokens: 1000 }),
      "tokens",
    );
    assert.equal(
      budgetStopReason({
        step: 3,
        maxSteps: 80,
        usage: { promptTokens: 10, completionTokens: 10 },
        maxContextTokens: 100,
        contextTokens: 120,
      }),
      "context",
    );
    assert.equal(
      budgetStopReason({
        step: 80,
        maxSteps: 80,
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
      "steps",
    );
    assert.equal(
      budgetStopReason({
        step: 3,
        maxSteps: 80,
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
      null,
    );
  });
});

const dummyProvider = {
  name: "t",
  url: "http://localhost",
  api: "k",
  model: "m",
  contextWindow: 8000,
  maxOutput: 256,
  thinkingEffort: "none" as const,
};

describe("runAgent Long budget", () => {
  it("Ask still throws when steps are exhausted", async () => {
    let n = 0;
    await assert.rejects(
      () =>
        runAgent({
          provider: dummyProvider,
          messages: [{ role: "user", content: "hi" }],
          maxSteps: 2,
          policy: createPolicy(process.cwd(), () => "ask"),
          complete: async () => {
            n += 1;
            return {
              content: "",
              toolCalls: [{ id: String(n), name: "calculate", arguments: '{"expression":"1+1"}' }],
            };
          },
        }),
      /超过最大工具步数/,
    );
  });

  it("does not extend Dynamic P50 when the segment only reads", async () => {
    const policy = createPolicy(process.cwd(), () => "long", undefined, {
      longBudget: resolveLongBudget(8),
    });
    let n = 0;
    const seen: string[] = [];
    const out = await runAgent({
      provider: dummyProvider,
      messages: [{ role: "user", content: "hi" }],
      maxSteps: 8,
      policy,
      complete: async ({ messages }) => {
        for (const message of messages) {
          if (typeof message.content === "string" && message.content.includes("turns left")) {
            seen.push(message.content);
          }
        }
        n += 1;
        return {
          content: "",
          toolCalls: [{ id: String(n), name: "calculate", arguments: `{"expression":"1+${n}"}` }],
        };
      },
    });
    assert.equal(out.stopped, "steps");
    assert.match(out.reply, /工具步数已达上限|【checkpoint】/);
    assert.equal(n, 4);
    assert.ok(seen.some((line) => /You have \d+ turns left/.test(line)));
  });

  it("extends once when a milestone moved", async () => {
    const tasks = createTaskStore();
    const policy = createPolicy(process.cwd(), () => "long", tasks, {
      longBudget: resolveLongBudget(8),
    });
    let n = 0;
    const out = await runAgent({
      provider: dummyProvider,
      messages: [{ role: "user", content: "hi" }],
      maxSteps: 8,
      policy,
      complete: async () => {
        n += 1;
        if (n === 1) {
          return {
            content: "",
            toolCalls: [{ id: "1", name: "task_state", arguments: '{"add_done":"ship"}' }],
          };
        }
        return {
          content: "",
          toolCalls: [{ id: String(n), name: "calculate", arguments: `{"expression":"${n}+1"}` }],
        };
      },
    });
    assert.equal(out.stopped, "steps");
    assert.equal(n, 6);
    assert.match(tasks.get().notes, /budget-extend/);
  });
});
