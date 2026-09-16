import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  emptyBudgetSegment,
  hasProgress,
  noteBudgetTool,
  notSpinning,
  parseLongBudgetPolicy,
  resolveLongBudget,
  shouldExtend,
  turnsLeftReminder,
} from "./long-budget.js";
import { applyTaskPatch, emptyTaskState } from "./task-state.js";

describe("resolveLongBudget", () => {
  it("defaults to Dynamic P50→P75 of --steps", () => {
    const plan = resolveLongBudget(80);
    assert.equal(plan.policy, "dynamic");
    assert.equal(plan.p100, 80);
    assert.equal(plan.x, 40);
    assert.equal(plan.y, 60);
    assert.equal(plan.reminder, true);
  });

  it("uses P75 as both caps for fixed, and the hard top for unlimited", () => {
    assert.deepEqual(resolveLongBudget(80, { policy: "fixed" }).x, 60);
    assert.equal(resolveLongBudget(80, { policy: "unlimited" }).y, 80);
    assert.equal(parseLongBudgetPolicy("nope"), "dynamic");
  });

  it("accepts Dynamic 25-50", () => {
    const plan = resolveLongBudget(80, { dynamic: "25-50" });
    assert.equal(plan.x, 20);
    assert.equal(plan.y, 40);
  });
});

describe("shouldExtend", () => {
  it("extends only with write/milestone/verify progress and no spinning", () => {
    const start = emptyTaskState();
    const now = applyTaskPatch(start, { addDone: "ship" });
    const segment = emptyBudgetSegment();
    noteBudgetTool(segment, "write", { path: "/tmp/a.ts" }, "已写入");
    const ok = shouldExtend({ policy: "dynamic", extensionsUsed: 0, segment, start, now });
    assert.equal(ok.allow, true);

    const reads = emptyBudgetSegment();
    for (const name of ["read", "search", "read", "search", "read", "search"]) {
      noteBudgetTool(reads, name, {}, "ok");
    }
    const denied = shouldExtend({
      policy: "dynamic",
      extensionsUsed: 0,
      segment: reads,
      start,
      now: start,
    });
    assert.equal(denied.allow, false);
    assert.match(denied.reason, /无验证|空转/);
  });

  it("refuses fixed policy, second extend, and doom", () => {
    const start = emptyTaskState();
    const segment = emptyBudgetSegment();
    noteBudgetTool(segment, "write", { path: "/x" }, "ok");
    assert.equal(
      shouldExtend({ policy: "fixed", extensionsUsed: 0, segment, start, now: start }).allow,
      false,
    );
    assert.equal(
      shouldExtend({ policy: "dynamic", extensionsUsed: 1, segment, start, now: start }).allow,
      false,
    );
    const doom = emptyBudgetSegment();
    doom.doomTriggered = true;
    doom.successfulWrites = 1;
    assert.equal(
      shouldExtend({ policy: "dynamic", extensionsUsed: 0, segment: doom, start, now: start }).allow,
      false,
    );
  });

  it("treats listed verify bash exit=0 as progress", () => {
    const start = applyTaskPatch(emptyTaskState(), { addVerifyCommand: "npm test" });
    const segment = emptyBudgetSegment();
    noteBudgetTool(segment, "bash", { command: "npm test" }, "exit=0\nok", start.verifyCommands);
    assert.equal(hasProgress(segment, start, start), true);
    assert.equal(notSpinning(segment), true);
  });
});

describe("turnsLeftReminder", () => {
  it("embeds the paper reminder sentence", () => {
    const message = turnsLeftReminder(3, 40, 37, "dynamic");
    assert.match(message.content, /You have 3 turns left/);
    assert.match(message.content, /【turn budget】/);
  });
});
