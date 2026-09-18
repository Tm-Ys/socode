import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig, migrateLegacyDotenv, resetConfigCache, saveConfig } from "./config.js";
import { loadProvider } from "./provider.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "socode-cfg-"));
  const prev = process.env.SOCODE_HOME;
  process.env.SOCODE_HOME = home;
  resetConfigCache();
  try {
    return fn(home);
  } finally {
    resetConfigCache();
    if (prev === undefined) delete process.env.SOCODE_HOME;
    else process.env.SOCODE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  it("uses built-in defaults when config.json is missing", () => {
    withHome(() => {
      const cfg = loadConfig();
      assert.equal(cfg.mode, "ask");
      assert.equal(cfg.systemPrompt, "");
      assert.equal(cfg.maxContextMessages, 200);
      assert.equal(cfg.maxAgentSteps, 80);
      assert.equal(cfg.subagentSteps, 24);
      assert.equal(cfg.judgeModel, "");
      assert.equal(cfg.longBudgetPolicy, "dynamic");
      assert.equal(cfg.longBudgetDynamic, "50-75");
      assert.equal(cfg.usdCny, 7.2);
      assert.deepEqual(cfg.modelPricing, {});
    });
  });

  it("persists ~/.socode/config.json", () => {
    withHome((home) => {
      saveConfig({ mode: "plan", maxAgentSteps: 12, judgeModel: "lite", usdCny: 7.1 });
      resetConfigCache();
      const cfg = loadConfig();
      assert.equal(cfg.mode, "plan");
      assert.equal(cfg.maxAgentSteps, 12);
      assert.equal(cfg.judgeModel, "lite");
      assert.equal(cfg.usdCny, 7.1);
      assert.match(readFileSync(join(home, "config.json"), "utf8"), /"plan"/);
    });
  });

  it("keeps modelPricing as USD per 1M tokens", () => {
    withHome((home) => {
      saveConfig({
        modelPricing: {
          "deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07 },
          skip: { input: 0, output: 1 },
        },
      });
      resetConfigCache();
      const cfg = loadConfig();
      assert.deepEqual(cfg.modelPricing, {
        "deepseek-chat": { input: 0.27, output: 1.1, cacheRead: 0.07 },
      });
      assert.match(readFileSync(join(home, "config.json"), "utf8"), /cacheRead/);
    });
  });
});

describe("migrateLegacyDotenv", () => {
  it("copies leftover workspace .env once and never loads it into process.env", () => {
    withHome(() => {
      const ws = mkdtempSync(join(tmpdir(), "socode-ws-"));
      const prevMode = process.env.MODE;
      const prevPrompt = process.env.SYSTEM_PROMPT;
      delete process.env.MODE;
      delete process.env.SYSTEM_PROMPT;
      try {
        writeFileSync(
          join(ws, ".env"),
          [
            'PROVIDER_NAME="migrated"',
            'MODEL="flash"',
            'api_key="sk-mig"',
            'BASE_URL="https://api.example.test/v1"',
            'MODE="long"',
            'SYSTEM_PROMPT="from env"',
            'MAX_AGENT_STEPS="40"',
            'LONG_APPROVE_MODEL="judge-lite"',
            "",
          ].join("\n"),
        );
        migrateLegacyDotenv(ws);
        const cfg = loadConfig();
        assert.equal(cfg.mode, "long");
        assert.equal(cfg.systemPrompt, "from env");
        assert.equal(cfg.maxAgentSteps, 40);
        assert.equal(cfg.judgeModel, "judge-lite");
        assert.equal(process.env.MODE, undefined);
        assert.equal(process.env.SYSTEM_PROMPT, undefined);
        const provider = loadProvider();
        assert.equal(provider.name, "migrated");
        assert.equal(provider.api, "sk-mig");

        writeFileSync(join(ws, ".env"), 'MODE="full"\nSYSTEM_PROMPT="changed"\nMAX_AGENT_STEPS="99"\n');
        resetConfigCache();
        migrateLegacyDotenv(ws);
        const again = loadConfig();
        assert.equal(again.mode, "long");
        assert.equal(again.systemPrompt, "from env");
        assert.equal(again.maxAgentSteps, 40);
      } finally {
        if (prevMode === undefined) delete process.env.MODE;
        else process.env.MODE = prevMode;
        if (prevPrompt === undefined) delete process.env.SYSTEM_PROMPT;
        else process.env.SYSTEM_PROMPT = prevPrompt;
        rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
