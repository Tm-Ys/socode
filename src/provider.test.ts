import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyProviderDraft,
  emptyProvider,
  providerReady,
} from "./provider.js";

describe("provider draft", () => {
  it("starts new providers with empty required fields and numeric defaults", () => {
    const blank = emptyProvider();
    assert.equal(blank.name, "");
    assert.equal(blank.url, "");
    assert.equal(blank.api, "");
    assert.equal(blank.model, "");
    assert.equal(blank.contextWindow, 128000);
    assert.equal(blank.maxOutput, 8192);
    assert.equal(blank.thinkingEffort, "medium");
    assert.equal(providerReady(blank), false);
  });

  it("builds a provider from user-entered fields", () => {
    const provider = applyProviderDraft({
      name: "deepseek",
      url: "https://api.deepseek.com/v1",
      api: "sk-test",
      model: "deepseek-flash",
      contextWindow: "",
      maxOutput: "",
      thinkingEffort: "",
    });
    assert.equal(provider.name, "deepseek");
    assert.equal(provider.url, "https://api.deepseek.com/v1");
    assert.equal(provider.api, "sk-test");
    assert.equal(provider.model, "deepseek-flash");
    assert.equal(provider.contextWindow, 128000);
    assert.equal(provider.maxOutput, 8192);
    assert.equal(provider.thinkingEffort, "medium");
    assert.equal(providerReady(provider), true);
  });

  it("rejects invalid optional fields", () => {
    assert.throws(
      () =>
        applyProviderDraft({
          name: "x",
          url: "https://example.test",
          api: "k",
          model: "m",
          contextWindow: "abc",
          maxOutput: "",
          thinkingEffort: "",
        }),
      /上下文窗口/,
    );
    assert.throws(
      () =>
        applyProviderDraft({
          name: "x",
          url: "https://example.test",
          api: "k",
          model: "m",
          contextWindow: "",
          maxOutput: "0",
          thinkingEffort: "",
        }),
      /最大输出/,
    );
    assert.throws(
      () =>
        applyProviderDraft({
          name: "x",
          url: "https://example.test",
          api: "k",
          model: "m",
          contextWindow: "",
          maxOutput: "",
          thinkingEffort: "ultra",
        }),
      /思考强度/,
    );
  });
});
