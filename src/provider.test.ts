import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  applyProviderDraft,
  dumpProviderStore,
  emptyProvider,
  findProvider,
  loadProvider,
  providerReady,
  providerStorePath,
  resolveFieldInput,
  saveProvider,
  switchProvider,
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

describe("user-level provider store", () => {
  it("writes ~/.socode/providers.json and ignores workspace .env", () => {
    const home = mkdtempSync(join(tmpdir(), "socode-prov-"));
    const prevHome = process.env.SOCODE_HOME;
    const prevName = process.env.PROVIDER_NAME;
    process.env.SOCODE_HOME = home;
    const envFile = join(process.cwd(), ".env");
    const beforeEnv = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
    try {
      const saved = saveProvider({
        name: "shared",
        url: "https://api.example.test/v1",
        api: "sk-shared",
        model: "demo",
        contextWindow: 128000,
        maxOutput: 8192,
        thinkingEffort: "medium",
      });
      assert.equal(saved.name, "shared");
      const path = providerStorePath();
      assert.equal(path, join(home, "providers.json"));
      assert.equal(existsSync(path), true);
      assert.match(readFileSync(path, "utf8"), /sk-shared/);
      if (beforeEnv !== null) assert.equal(readFileSync(envFile, "utf8"), beforeEnv);

      process.env.PROVIDER_NAME = "from-env";
      const loaded = loadProvider();
      assert.equal(loaded.name, "shared");
      assert.equal(loaded.api, "sk-shared");
    } finally {
      if (prevHome === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prevHome;
      if (prevName === undefined) delete process.env.PROVIDER_NAME;
      else process.env.PROVIDER_NAME = prevName;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps multiple providers in the same user store", () => {
    const home = mkdtempSync(join(tmpdir(), "socode-prov-"));
    const prevHome = process.env.SOCODE_HOME;
    process.env.SOCODE_HOME = home;
    try {
      saveProvider({
        name: "one",
        url: "https://one.example.test/v1",
        api: "sk-one",
        model: "m1",
        contextWindow: 128000,
        maxOutput: 8192,
        thinkingEffort: "none",
      });
      saveProvider({
        name: "two",
        url: "https://two.example.test/v1",
        api: "sk-two",
        model: "m2",
        contextWindow: 128000,
        maxOutput: 8192,
        thinkingEffort: "low",
      });
      const switched = switchProvider("one");
      assert.equal(switched.name, "one");
      const store = JSON.parse(readFileSync(join(home, "providers.json"), "utf8")) as {
        active: string;
        providers: { name: string }[];
      };
      assert.equal(store.active, "one");
      assert.equal(store.providers.some((item) => item.name === "one"), true);
      assert.equal(store.providers.some((item) => item.name === "two"), true);
    } finally {
      if (prevHome === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lets SOCODE_PROVIDER_STORE override the file worker reads", () => {
    const home = mkdtempSync(join(tmpdir(), "socode-prov-"));
    const prevHome = process.env.SOCODE_HOME;
    const prevStore = process.env.SOCODE_PROVIDER_STORE;
    process.env.SOCODE_HOME = home;
    delete process.env.SOCODE_PROVIDER_STORE;
    try {
      saveProvider({
        name: "home",
        url: "https://home.example.test/v1",
        api: "sk-home",
        model: "demo",
        contextWindow: 128000,
        maxOutput: 8192,
        thinkingEffort: "medium",
      });
      assert.equal(providerStorePath(), join(home, "providers.json"));
      const dumped = dumpProviderStore(home);
      assert.equal(dumped?.active, "home");
      assert.equal(dumped?.providers.length, 1);
      assert.equal(dumped?.providers[0]?.api, "sk-home");
      const sessionPath = join(home, "session-providers.json");
      writeFileSync(
        sessionPath,
        `${JSON.stringify({
          active: "sess",
          providers: [
            {
              name: "sess",
              url: "https://sess.example.test/v1",
              api: "sk-session",
              model: "sess-model",
              contextWindow: 128000,
              maxOutput: 8192,
              thinkingEffort: "low",
            },
          ],
        })}\n`,
      );
      process.env.SOCODE_PROVIDER_STORE = sessionPath;
      assert.equal(providerStorePath(), sessionPath);
      const loaded = loadProvider();
      assert.equal(loaded.name, "sess");
      assert.equal(loaded.api, "sk-session");
      const stillHome = dumpProviderStore(home);
      assert.equal(stillHome?.providers.length, 1);
      assert.equal(stillHome?.providers[0]?.api, "sk-home");
    } finally {
      if (prevHome === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prevHome;
      if (prevStore === undefined) delete process.env.SOCODE_PROVIDER_STORE;
      else process.env.SOCODE_PROVIDER_STORE = prevStore;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not import cwd providers.json into a redirected SOCODE_HOME", () => {
    const home = mkdtempSync(join(tmpdir(), "socode-prov-"));
    const prevHome = process.env.SOCODE_HOME;
    const prevStore = process.env.SOCODE_PROVIDER_STORE;
    process.env.SOCODE_HOME = home;
    delete process.env.SOCODE_PROVIDER_STORE;
    try {
      saveProvider({
        name: "isolated",
        url: "https://isolated.example.test/v1",
        api: "sk-isolated",
        model: "demo",
        contextWindow: 128000,
        maxOutput: 8192,
        thinkingEffort: "none",
      });
      const store = JSON.parse(readFileSync(join(home, "providers.json"), "utf8")) as {
        active: string;
        providers: { name: string; api: string }[];
      };
      assert.equal(store.active, "isolated");
      assert.equal(store.providers.length, 1);
      assert.equal(store.providers[0]?.api, "sk-isolated");
      assert.equal(dumpProviderStore()?.providers.length, 1);
    } finally {
      if (prevHome === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prevHome;
      if (prevStore === undefined) delete process.env.SOCODE_PROVIDER_STORE;
      else process.env.SOCODE_PROVIDER_STORE = prevStore;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
