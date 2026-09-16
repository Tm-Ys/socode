import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSubagentStore,
  formatSubagentBatch,
  formatSubagentPlan,
  jobsToRun,
  parseSubagentKind,
  parseSubagentPlan,
} from "./subagent-plan.js";
import { createSubagentRunner } from "./subagent.js";
import { createPolicy } from "./permissions.js";

describe("subagent plan", () => {
  it("parses N explorer/worker jobs", () => {
    const plan = parseSubagentPlan({
      goal: "摸清权限再改",
      agents: [
        { kind: "explorer", label: "find-auth", prompt: "找出 authorize 入口" },
        { kind: "执行", prompt: "只改 src/permissions.ts 加上注释" },
      ],
    });
    assert.equal(plan.jobs.length, 2);
    assert.equal(plan.jobs[0].kind, "explorer");
    assert.equal(plan.jobs[1].kind, "worker");
    assert.match(formatSubagentPlan(plan), /2 个任务/);
  });

  it("rejects empty or oversized batches", () => {
    assert.throws(() => parseSubagentPlan({ agents: [] }), /非空/);
    assert.throws(
      () =>
        parseSubagentPlan({
          agents: Array.from({ length: 7 }, (_, i) => ({ prompt: `t${i}` })),
        }),
      /最多/,
    );
  });

  it("runs pending jobs, then can select by index", () => {
    const store = createSubagentStore(
      parseSubagentPlan({
        agents: [
          { kind: "explorer", prompt: "a" },
          { kind: "worker", prompt: "b" },
        ],
      }),
    );
    const plan = store.get();
    assert.ok(plan);
    assert.equal(jobsToRun(plan, {}).length, 2);
    store.updateJob(1, { status: "done", result: "ok-a" });
    const left = jobsToRun(store.get()!, {});
    assert.equal(left.length, 1);
    assert.equal(left[0].id, 2);
    const one = jobsToRun(store.get()!, { index: 1 });
    assert.equal(one[0].result, "ok-a");
    const batch = formatSubagentBatch(store.get()!, one);
    assert.match(batch, /ok-a/);
    assert.match(batch, /pending/);
  });

  it("defaults unknown kinds to worker", () => {
    assert.equal(parseSubagentKind("nope"), "worker");
    assert.equal(parseSubagentKind("explore"), "explorer");
  });

  it("refuses to run before a plan exists", async () => {
    const store = createSubagentStore();
    const policy = createPolicy(process.cwd(), () => "ask", undefined, { subagents: store });
    const run = createSubagentRunner({
      getProvider: () => {
        throw new Error("should not call provider");
      },
      getPolicy: () => policy,
      workspace: process.cwd(),
    });
    const out = await run({});
    assert.match(out, /还没有子代理规划/);
  });

  it("runs explorers in parallel, including alongside one worker", async () => {
    const { run, store, peak } = timedRunner([
      { kind: "explorer", prompt: "a" },
      { kind: "worker", prompt: "b" },
    ]);
    const out = await run({});
    assert.equal(peak(), 2);
    assert.match(out, /ok-a/);
    assert.match(out, /ok-b/);
    assert.equal(store.get()?.jobs.every((job) => job.status === "done"), true);
  });

  it("serializes workers so they do not write the same workspace at once", async () => {
    const { run, peak } = timedRunner([
      { kind: "worker", prompt: "a" },
      { kind: "worker", prompt: "b" },
    ]);
    const out = await run({});
    assert.equal(peak(), 1);
    assert.match(out, /ok-a/);
    assert.match(out, /ok-b/);
  });

  it("notifies the UI when a batch starts", async () => {
    const started: string[] = [];
    const { run } = timedRunner(
      [
        { kind: "explorer", prompt: "a" },
        { kind: "worker", prompt: "b" },
      ],
      {
        onBatch: (jobs) => started.push(jobs.map((job) => job.kind).join(",")),
      },
    );
    await run({});
    assert.deepEqual(started, ["explorer,worker"]);
  });
});

function timedRunner(
  agents: Array<{ kind: string; prompt: string }>,
  hooks?: { onBatch?: (jobs: { kind: string }[]) => void },
) {
  const store = createSubagentStore(parseSubagentPlan({ agents }));
  const policy = createPolicy(process.cwd(), () => "ask", undefined, { subagents: store });
  let running = 0;
  let peak = 0;
  const run = createSubagentRunner({
    getProvider: () => ({
      name: "t",
      url: "",
      api: "",
      model: "",
      contextWindow: 0,
      maxOutput: 0,
      thinkingEffort: "none",
    }),
    getPolicy: () => policy,
    workspace: process.cwd(),
    onBatch: hooks?.onBatch,
    execute: async ({ prompt }) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return `ok-${prompt}`;
    },
  });
  return { run, store, peak: () => peak };
}
