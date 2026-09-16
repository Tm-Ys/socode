import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSubagentUi,
  formatSubagentBanner,
  formatSubagentHud,
  formatSubagentList,
  formatSubagentLog,
  parseSeesubagent,
} from "./subagent-ui.js";

describe("parseSeesubagent", () => {
  it("parses list, watch, off, and help", () => {
    assert.deepEqual(parseSeesubagent("/seesubagent"), { kind: "list" });
    assert.deepEqual(parseSeesubagent("/seesubagent 2"), { kind: "watch", index: 2 });
    assert.deepEqual(parseSeesubagent("/seesubagent off"), { kind: "off" });
    assert.deepEqual(parseSeesubagent("/seesubagent hide"), { kind: "off" });
    assert.deepEqual(parseSeesubagent("/seesubagent nope"), { kind: "help" });
    assert.equal(parseSeesubagent("/task"), null);
  });
});

describe("subagent ui copy", () => {
  it("announces how many are running without dumping process", () => {
    assert.match(formatSubagentBanner(3), /3 个子代理在跑/);
    assert.equal(formatSubagentHud([{ phase: "running" }, { phase: "pending" }, { phase: "done" }]), "子代理 2/3 在跑");
    assert.equal(formatSubagentHud([{ phase: "done" }, { phase: "error" }]), "");
  });

  it("lists jobs and formats a captured log", () => {
    const jobs = [
      {
        id: 1,
        kind: "explorer",
        label: "find-auth",
        phase: "done" as const,
        events: [
          { type: "tool_call" as const, name: "read", arguments: JSON.stringify({ path: "/tmp/a.ts" }) },
          { type: "tool_result" as const, name: "read", result: "ok\nline2\nline3\nline4" },
          { type: "delta" as const, text: "找到入口" },
        ],
      },
    ];
    assert.match(formatSubagentList(jobs), /1\. done\s+explorer/);
    assert.match(formatSubagentLog(jobs[0]), /# 1\. explorer {2}find-auth {2}done/);
    assert.match(formatSubagentLog(jobs[0]), /● read/);
    assert.match(formatSubagentLog(jobs[0]), /找到入口/);
  });
});

describe("createSubagentUi", () => {
  it("hides live events unless that index is watched", () => {
    const chunks: string[] = [];
    const ui = createSubagentUi({
      write: (text) => chunks.push(text),
      tty: () => false,
    });
    ui.startBatch([
      { id: 1, kind: "explorer", label: "a" },
      { id: 2, kind: "worker", label: "b" },
    ]);
    ui.jobStart(1);
    assert.equal(ui.record(1, { type: "delta", text: "secret-a" }), false);
    ui.watch(2);
    ui.jobStart(2);
    assert.equal(ui.record(2, { type: "delta", text: "live-b" }), true);
    assert.match(chunks.join(""), /2 个子代理在跑/);
    assert.equal(chunks.join("").includes("secret-a"), false);
    assert.match(ui.logText(1), /secret-a/);
    ui.jobDone({ id: 1, status: "done", result: "ok-a" });
    ui.jobDone({ id: 2, status: "done", result: "ok-b" });
    assert.match(ui.listText(), /1\. done/);
  });
});
