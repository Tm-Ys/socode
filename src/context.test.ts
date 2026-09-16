import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "./db.js";
import {
  compactTokens,
  formatContextMeter,
  formatContextReport,
  measureContext,
} from "./context.js";
import { historyAfterTurn } from "./recap.js";

describe("compactTokens", () => {
  it("uses K/M for thousands", () => {
    assert.equal(compactTokens(512), "512");
    assert.equal(compactTokens(50_000), "50K");
    assert.equal(compactTokens(128_000), "128K");
    assert.equal(compactTokens(1500), "1.5K");
    assert.equal(compactTokens(2_000_000), "2M");
  });
});

describe("formatContextMeter", () => {
  it("matches the prompt occupancy copy", () => {
    assert.equal(formatContextMeter(50_000, 128_000), "context 39%(50K / 128K)");
    assert.equal(formatContextMeter(6400, 128_000), "context 5%(6.4K / 128K)");
  });
});

describe("measureContext recap", () => {
  it("counts recapped turns as the short recap, not the tool traces", () => {
    const user: Message = { role: "user", content: "go" };
    const fat: Message[] = [];
    for (let i = 1; i <= 7; i += 1) {
      fat.push(
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: String(i), name: "read", arguments: "{}" }],
        },
        { role: "tool", content: "x".repeat(4000), toolCallId: String(i) },
      );
    }
    fat.push({ role: "assistant", content: "done" });
    const params = { maxMessages: 80, contextWindow: 128000, maxOutput: 8192 };
    const before = measureContext({ history: [user, ...fat], ...params });
    const after = measureContext({ history: historyAfterTurn(user, fat), ...params });
    assert.ok(after.used < before.used);
    assert.equal(after.recapCount, 1);
    assert.match(formatContextReport(after, 40, false), /recap 1 轮/);
  });
});
