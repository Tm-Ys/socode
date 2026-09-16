import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "./db.js";
import {
  RECAP_HINT,
  RECAP_PREFIX,
  RECAP_TEXT_CHARS,
  formatRecap,
  historyAfterTurn,
  recapLine,
  recapStats,
  shouldRecap,
} from "./recap.js";

function call(name: string, args: Record<string, unknown>, id: string): Message {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}

function tool(id: string, content = "ok"): Message {
  return { role: "tool", content, toolCallId: id };
}

describe("shouldRecap", () => {
  it("stays quiet for six tools and a short reply", () => {
    const trace: Message[] = [];
    for (let i = 1; i <= 6; i += 1) {
      trace.push(call("read", { path: `/tmp/a${i}.ts` }, String(i)), tool(String(i)));
    }
    trace.push({ role: "assistant", content: "好了" });
    const stats = recapStats(trace);
    assert.equal(stats.tools.length, 6);
    assert.equal(shouldRecap(stats), false);
    assert.equal(recapLine(trace), null);
  });

  it("fires after more than six tools", () => {
    const trace: Message[] = [];
    for (let i = 1; i <= 7; i += 1) {
      trace.push(call("read", { path: `/workspace/src/f${i}.ts` }, String(i)), tool(String(i)));
    }
    trace.push({ role: "assistant", content: "看完了" });
    assert.equal(shouldRecap(recapStats(trace)), true);
    const line = recapLine(trace);
    assert.ok(line);
    assert.match(line, /^ {2}recap  7 个工具  read×7/);
  });

  it("fires on a long assistant reply even with few tools", () => {
    const trace: Message[] = [
      call("read", { path: "/tmp/a.ts" }, "1"),
      tool("1"),
      { role: "assistant", content: "字".repeat(RECAP_TEXT_CHARS) },
    ];
    assert.equal(shouldRecap(recapStats(trace)), true);
    assert.match(recapLine(trace) ?? "", /长输出/);
  });
});

describe("formatRecap", () => {
  it("groups tools and unique details", () => {
    const stats = recapStats([
      call("read", { path: `${process.cwd()}/src/a.ts` }, "1"),
      tool("1"),
      call("read", { path: `${process.cwd()}/src/b.ts` }, "2"),
      tool("2"),
      call("edit", { path: `${process.cwd()}/src/a.ts`, old_string: "x", new_string: "y" }, "3"),
      tool("3"),
      call("bash", { command: "npm test" }, "4"),
      tool("4"),
      call("bash", { command: "npm test" }, "5"),
      tool("5"),
      call("search", { pattern: "recap", directory: process.cwd() }, "6"),
      tool("6"),
      call("read", { path: `${process.cwd()}/src/c.ts` }, "7"),
      tool("7"),
      { role: "assistant", content: "改完了" },
    ]);
    const line = formatRecap(stats);
    assert.match(line, /7 个工具/);
    assert.match(line, /read×3/);
    assert.match(line, /edit/);
    assert.match(line, /bash×2/);
    assert.match(line, /search/);
    assert.match(line, /src\/a\.ts/);
    assert.match(line, /npm test/);
  });

  it("wraps the line in dim when color is on", () => {
    const trace: Message[] = [];
    for (let i = 1; i <= 7; i += 1) {
      trace.push(call("read", { path: `/tmp/${i}.ts` }, String(i)), tool(String(i)));
    }
    const line = recapLine(trace, { color: true });
    assert.ok(line?.startsWith("\x1b[2m"));
    assert.ok(line?.endsWith("\x1b[0m"));
  });
});

describe("historyAfterTurn", () => {
  const user: Message = { role: "user", content: "修一下 recap" };

  it("keeps the full trace when recap does not fire", () => {
    const trace: Message[] = [
      call("read", { path: "/tmp/a.ts" }, "1"),
      tool("1"),
      { role: "assistant", content: "改好了" },
    ];
    const stored = historyAfterTurn(user, trace);
    assert.equal(stored.length, 4);
    assert.equal(stored[0], user);
    assert.equal(stored[3]?.content, "改好了");
  });

  it("replaces a long turn with recap plus a grep hint", () => {
    const trace: Message[] = [];
    for (let i = 1; i <= 7; i += 1) {
      trace.push(call("read", { path: `/tmp/${i}.ts` }, String(i)), tool(String(i), "file body ".repeat(20)));
    }
    trace.push({ role: "assistant", content: "看完了，改了很多地方。" });
    const stored = historyAfterTurn(user, trace);
    assert.equal(stored.length, 2);
    assert.equal(stored[0], user);
    assert.equal(stored[1]?.role, "assistant");
    assert.ok(stored[1]?.content.startsWith(RECAP_PREFIX));
    assert.ok(stored[1]?.content.includes(RECAP_HINT));
    assert.ok(stored[1]?.content.includes("7 个工具"));
    assert.ok(!stored[1]?.content.includes("file body"));
    assert.ok(!stored[1]?.content.includes("看完了"));
  });
});
