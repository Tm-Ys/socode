import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "./db.js";
import {
  PLAN_PREFIX,
  allPlanItemsDone,
  applyPlanPatch,
  createPlanStore,
  emptyPlan,
  formatPlanCli,
  isPlanMessage,
  lastPlan,
  parseSeeplan,
  parseSetplan,
  patchFromPlanArgs,
  planMessage,
  planNeedsReview,
  setplanUserContent,
  shouldHoldForPlanReview,
  shouldHoldForSetplan,
} from "./plan.js";

describe("applyPlanPatch", () => {
  it("splits items and checks them off by index or title", () => {
    let plan = applyPlanPatch(emptyPlan(), {
      goal: "加 plan",
      items: ["拆状态", "接工具", "TUI"],
    });
    assert.equal(plan.items.length, 3);
    assert.equal(allPlanItemsDone(plan), false);
    plan = applyPlanPatch(plan, { done: [1, "接工具"] });
    assert.equal(plan.items[0]?.done, true);
    assert.equal(plan.items[1]?.done, true);
    assert.equal(plan.items[2]?.done, false);
    assert.equal(planNeedsReview(plan), false);
  });

  it("preserves checks when replacing with the same titles", () => {
    let plan = applyPlanPatch(emptyPlan(), { items: ["a", "b"] });
    plan = applyPlanPatch(plan, { done: [1] });
    plan = applyPlanPatch(plan, { items: ["a", "b", "c"] });
    assert.equal(plan.items[0]?.done, true);
    assert.equal(plan.items[1]?.done, false);
    assert.equal(plan.items[2]?.title, "c");
  });

  it("rejects review until every item is checked", () => {
    const plan = applyPlanPatch(emptyPlan(), { items: ["a", "b"] });
    assert.throws(() => applyPlanPatch(plan, { review: "看起来行" }), /未勾选/);
  });

  it("accepts review after all items are done", () => {
    let plan = applyPlanPatch(emptyPlan(), { items: ["a", "b"] });
    plan = applyPlanPatch(plan, { done: [1, 2], review: "对照过了，测试过了" });
    assert.equal(planNeedsReview(plan), false);
    assert.match(plan.review, /对照过了/);
    assert.equal(shouldHoldForPlanReview(plan, true), false);
  });

  it("clears review if a new pending item is added", () => {
    let plan = applyPlanPatch(emptyPlan(), { items: ["a"], done: [1], review: "ok" });
    plan = applyPlanPatch(plan, { add: "b" });
    assert.equal(plan.review, "");
    assert.equal(plan.items[1]?.title, "b");
  });
});

describe("plan persistence", () => {
  it("round-trips through a system message", () => {
    const store = createPlanStore();
    store.patch({ goal: "ship", items: ["one", "two"], done: [1] });
    const message = planMessage(store.get());
    assert.equal(isPlanMessage(message), true);
    assert.ok(message.content.startsWith(PLAN_PREFIX));
    assert.equal(lastPlan([message])?.items[0]?.done, true);
  });
});

describe("formatPlanCli / seeplan", () => {
  it("renders a boxed plan with emoji", () => {
    const plan = applyPlanPatch(emptyPlan(), { goal: "demo", items: ["read", "edit"], done: [1] });
    const text = formatPlanCli(plan, { color: false, width: 56 });
    assert.match(text, /📋 Plan  1\/2/);
    assert.match(text, /🎯 {2}demo/);
    assert.match(text, /✅ {2}1\. read/);
    assert.match(text, /👉 {2}2\. edit/);
    assert.match(text, /📝/);
    assert.match(text, /╭/);
    assert.match(text, /╰/);
    const lines = text.split("\n");
    assert.equal(lines[0]?.startsWith("╭"), true);
    assert.equal(lines.at(-1)?.startsWith("╰"), true);
    assert.ok(lines.every((line) => /[╭│╰]/.test(line[0] ?? "") && /[╮│╯]/.test(line.at(-1) ?? "")));
  });

  it("parses /seeplan", () => {
    assert.equal(parseSeeplan("/seeplan"), true);
    assert.equal(parseSeeplan("/seeplan  "), true);
    assert.equal(parseSeeplan("/seesubagent"), false);
  });
});

describe("setplan", () => {
  it("parses /setplan and wraps a forced-plan user message", () => {
    assert.equal(parseSetplan("/seeplan"), null);
    assert.deepEqual(parseSetplan("/setplan"), { prompt: "" });
    assert.deepEqual(parseSetplan("/setplan  做登录页"), { prompt: "做登录页" });
    const body = setplanUserContent("做登录页");
    assert.match(body, /【setplan】/);
    assert.match(body, /grill-me/);
    assert.match(body, /做登录页/);
  });

  it("holds the turn until plan is actually called", () => {
    const trace: Message[] = [{ role: "assistant", content: "先问两个问题" }];
    assert.equal(shouldHoldForSetplan(trace, true, true), true);
    assert.equal(shouldHoldForSetplan(trace, true, false), false);
    const called: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "1", name: "plan", arguments: "{}" }],
      },
    ];
    assert.equal(shouldHoldForSetplan(called, true, true), false);
  });
});

describe("patchFromPlanArgs", () => {
  it("coerces done from number, string, or array", () => {
    assert.deepEqual(patchFromPlanArgs({ done: 2 }).done, [2]);
    assert.deepEqual(patchFromPlanArgs({ done: "TUI" }).done, ["TUI"]);
    assert.deepEqual(patchFromPlanArgs({ done: [1, "x"] }).done, [1, "x"]);
  });
});

describe("shouldHoldForPlanReview", () => {
  it("holds only when all items are done, review is empty, and tools are still allowed", () => {
    const ready = applyPlanPatch(emptyPlan(), { items: ["a"], done: [1] });
    assert.equal(planNeedsReview(ready), true);
    assert.equal(shouldHoldForPlanReview(ready, true), true);
    assert.equal(shouldHoldForPlanReview(ready, false), false);
    assert.equal(shouldHoldForPlanReview(emptyPlan(), true), false);
  });
});
