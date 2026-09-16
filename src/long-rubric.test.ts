import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLongRubric, goalHash, parseRubricItems, parseRubricScore } from "./long-rubric.js";
import { emptyTaskState, type VerifyRubric } from "./task-state.js";

const ITEMS = {
  items: [
    { id: "fc-1", axis: "file_change", text: "只改 src/agent.ts 的 runAgent", weight: 3 },
    { id: "fc-2", axis: "file_change", text: "不改 src/sandbox.ts", weight: 2 },
    { id: "sa-1", axis: "spec_alignment", text: "shouldExtend 无进展不延期", weight: 3 },
    { id: "sa-2", axis: "spec_alignment", text: "reminder 含 You have X turns left", weight: 2 },
    { id: "in-1", axis: "integrity", text: "不削弱 src/agent.test.ts 断言", weight: 3 },
    { id: "in-2", axis: "integrity", text: "不提交密钥", weight: 1 },
    { id: "rt-1", axis: "runtime", text: "npm test 仍绿", weight: 2 },
    { id: "rt-2", axis: "runtime", text: "npx tsx --test src/long-budget.test.ts", weight: 1 },
  ],
};

describe("parseRubricItems", () => {
  it("accepts grounded four-axis JSON", () => {
    const parsed = parseRubricItems(JSON.stringify(ITEMS));
    assert.equal("items" in parsed, true);
    if ("items" in parsed) assert.equal(parsed.items.length, 8);
  });

  it("fails closed on vague items", () => {
    const parsed = parseRubricItems(
      JSON.stringify({
        items: Array.from({ length: 8 }, (_, i) => ({
          id: `x-${i}`,
          axis: ["file_change", "spec_alignment", "integrity", "runtime"][i % 4],
          text: "代码应该正确",
          weight: 1,
        })),
      }),
    );
    assert.equal("error" in parsed, true);
  });
});

describe("parseRubricScore", () => {
  it("requires weight-3 items and a 0.7 average", () => {
    const rubric = parseRubricItems(JSON.stringify(ITEMS)) as VerifyRubric;
    const pass = parseRubricScore(
      JSON.stringify({
        items: ITEMS.items.map((item) => ({ id: item.id, s: 1, note: "ok" })),
      }),
      rubric,
      "m1",
    );
    assert.equal(pass.pass, true);
    const fail = parseRubricScore(
      JSON.stringify({
        items: ITEMS.items.map((item) => ({ id: item.id, s: item.weight === 3 ? 0 : 1, note: "no" })),
      }),
      rubric,
      "m1",
    );
    assert.equal(fail.pass, false);
  });
});

describe("createLongRubric", () => {
  it("round-trips generate then score via mocked chat", async () => {
    const rubric = createLongRubric(
      () => ({
        name: "t",
        url: "http://x",
        api: "k",
        model: "m",
        contextWindow: 1000,
        maxOutput: 256,
        thinkingEffort: "none",
      }),
      async ({ messages }) => {
        const last = messages[messages.length - 1]?.content ?? "";
        if (last.includes("workspace:")) return { content: JSON.stringify(ITEMS) };
        return {
          content: JSON.stringify({
            items: ITEMS.items.map((item) => ({ id: item.id, s: 1, note: "ok" })),
          }),
        };
      },
    );
    const state = { ...emptyTaskState(), goal: "动态预算" };
    const generated = await rubric.ensure(state, { workspace: "/tmp" });
    assert.equal("items" in generated, true);
    if ("error" in generated) throw new Error(generated.error);
    assert.equal(generated.goalHash, goalHash("动态预算"));
    const scored = await rubric.score({
      state: { ...state, verifyRubric: generated },
      milestone: "m1",
    });
    assert.equal(scored.pass, true);
  });
});
