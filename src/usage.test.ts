import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addTokenUsage,
  emptyTokenUsage,
  estimateUsageCny,
  formatCny,
  formatUsageLine,
  parseTokenUsage,
  lookupModelPrice,
} from "./usage.js";

describe("parseTokenUsage", () => {
  it("reads OpenAI cached_tokens without double-counting cache in cost", () => {
    const usage = parseTokenUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    assert.equal(usage?.promptTokens, 1000);
    assert.equal(usage?.cacheReadTokens, 800);
    assert.equal(usage?.reasoningTokens, 10);
    assert.equal(usage?.promptIncludesCache, true);
    const cny = estimateUsageCny(usage!, { input: 1, output: 2, cacheRead: 0.1 });
    assert.equal(cny, (200 * 1 + 50 * 2 + 800 * 0.1) / 1_000_000);
  });

  it("keeps Anthropic cache fields outside input tokens", () => {
    const usage = parseTokenUsage({
      prompt_tokens: 200,
      completion_tokens: 20,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    });
    assert.equal(usage?.promptIncludesCache, false);
    const cny = estimateUsageCny(usage!, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
    assert.equal(cny, (200 * 1 + 20 * 2 + 800 * 0.1 + 40 * 1.25) / 1_000_000);
  });

  it("reads DeepSeek prompt cache hits", () => {
    const usage = parseTokenUsage({
      prompt_tokens: 500,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 400,
    });
    assert.equal(usage?.cacheReadTokens, 400);
    assert.equal(usage?.promptIncludesCache, true);
  });
});

describe("formatUsageLine", () => {
  it("omits yuan when no price is configured", () => {
    const usage = emptyTokenUsage();
    usage.promptTokens = 1200;
    usage.completionTokens = 80;
    assert.match(formatUsageLine(usage), /入 1\.2K/);
    assert.match(formatUsageLine(usage), /未标价/);
    assert.doesNotMatch(formatUsageLine(usage, { price: { input: 1, output: 2 } }), /未标价/);
    assert.match(formatUsageLine(usage, { price: { input: 1, output: 2 } }), /¥/);
    assert.match(formatUsageLine(usage, { cny: 1.234 }), /¥1\.23/);
    assert.equal(formatCny(0.002), "¥0.0020");
  });

  it("adds cache and sums turns", () => {
    const total = emptyTokenUsage();
    addTokenUsage(total, {
      promptTokens: 10,
      completionTokens: 2,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      promptIncludesCache: true,
    });
    addTokenUsage(total, {
      promptTokens: 5,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      promptIncludesCache: false,
    });
    assert.equal(total.promptTokens, 15);
    assert.equal(total.cacheReadTokens, 8);
    assert.match(formatUsageLine(total), /缓存 8/);
  });
});

describe("lookupModelPrice", () => {
  it("matches model ids without inventing a price", () => {
    const pricing = { "DeepSeek-Chat": { input: 0.27, output: 1.1, cacheRead: 0.07 } };
    assert.deepEqual(lookupModelPrice("deepseek-chat", pricing), {
      input: 0.27,
      output: 1.1,
      cacheRead: 0.07,
      cacheWrite: undefined,
    });
    assert.equal(lookupModelPrice("other", pricing), undefined);
    assert.equal(lookupModelPrice("deepseek-chat", {}), undefined);
  });
});
