import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookupModelsDevUsd, parseModelsDevApi, usdToCny } from "./models-dev.js";

const SAMPLE = {
  openai: {
    id: "openai",
    models: {
      "gpt-4o": { cost: { input: 2.5, output: 10, cache_read: 1.25 } },
      "gpt-4.1-nano": { cost: { input: 0.1, output: 0.4 } },
    },
  },
  deepseek: {
    id: "deepseek",
    models: {
      "deepseek-chat": { cost: { input: 0.27, output: 1.1, cache_read: 0.07 } },
    },
  },
};

describe("models.dev catalog", () => {
  it("parses usd prices and matches by model id or provider hint", () => {
    const prices = parseModelsDevApi(SAMPLE);
    assert.equal(prices.length, 3);
    const chat = lookupModelsDevUsd("deepseek-chat", "deepseek", prices);
    assert.deepEqual(chat, {
      providerId: "deepseek",
      modelId: "deepseek-chat",
      input: 0.27,
      output: 1.1,
      cacheRead: 0.07,
    });
    const gpt = lookupModelsDevUsd("GPT-4o", "openai", prices);
    assert.equal(gpt?.input, 2.5);
    assert.equal(lookupModelsDevUsd("nope", "", prices), undefined);
  });

  it("converts usd per 1M into cny per 1M", () => {
    const cny = usdToCny({ input: 1, output: 2, cacheRead: 0.1 }, 7.2);
    assert.deepEqual(cny, { input: 7.2, output: 14.4, cacheRead: 0.72, cacheWrite: undefined });
  });
});
