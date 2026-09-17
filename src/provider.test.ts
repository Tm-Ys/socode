import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyProviderDraft,
  emptyProvider,
  findProvider,
  providerReady,
  resolveFieldInput,
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

  it("keeps the current value when the field is left empty", () => {
    assert.deepEqual(resolveFieldInput("", "deepseek", true), { ok: true, value: "deepseek" });
    assert.deepEqual(resolveFieldInput("  ", "https://api.example.test", true), { ok: true, value: "https://api.example.test" });
    assert.deepEqual(resolveFieldInput("openai", "deepseek", true), { ok: true, value: "openai" });
    assert.deepEqual(resolveFieldInput("", "", true), { ok: false });
    assert.deepEqual(resolveFieldInput("", "", false), { ok: true, value: "" });
  });

  it("finds a named provider from the current list", () => {
    const current = applyProviderDraft({
      name: "deepseek",
      url: "https://api.deepseek.com/v1",
      api: "sk-test",
      model: "deepseek-flash",
      contextWindow: "",
      maxOutput: "",
      thinkingEffort: "",
    });
    assert.equal(findProvider("deepseek", current)?.name, "deepseek");
    assert.equal(findProvider("  deepseek  ", current)?.model, "deepseek-flash");
    assert.equal(findProvider("", current), undefined);
    assert.equal(findProvider("definitely-not-a-saved-provider-xyzzy", current), undefined);
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
