import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatDoctor, runDoctor } from "./doctor.js";
import { emptyProvider } from "./provider.js";

describe("runDoctor", () => {
  it("fails closed without a provider and does not print secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "socode-doc-"));
    const ws = mkdtempSync(join(tmpdir(), "socode-docws-"));
    const prev = process.env.SOCODE_HOME;
    process.env.SOCODE_HOME = home;
    try {
      const report = await runDoctor({
        workspace: ws,
        mode: "ask",
        provider: emptyProvider(),
      });
      assert.equal(report.ok, false);
      const provider = report.checks.find((item) => item.name === "Provider");
      assert.equal(provider?.ok, false);
      const text = formatDoctor(report);
      assert.match(text, /socode doctor/);
      assert.match(text, /失败/);
      assert.doesNotMatch(text, /sk-/);
    } finally {
      if (prev === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("reports a configured provider without echoing the key", async () => {
    const home = mkdtempSync(join(tmpdir(), "socode-doc-"));
    const ws = mkdtempSync(join(tmpdir(), "socode-docws-"));
    const prev = process.env.SOCODE_HOME;
    process.env.SOCODE_HOME = home;
    try {
      const report = await runDoctor({
        workspace: ws,
        mode: "ask",
        provider: {
          name: "deepseek",
          url: "https://api.example.test/v1",
          api: "sk-secret-should-not-print",
          model: "flash",
          contextWindow: 128000,
          maxOutput: 8192,
          thinkingEffort: "medium",
        },
      });
      const provider = report.checks.find((item) => item.name === "Provider");
      assert.equal(provider?.ok, true);
      const text = formatDoctor(report);
      assert.match(text, /deepseek 已配置/);
      assert.doesNotMatch(text, /sk-secret/);
      assert.equal(report.checks.find((item) => item.name === "会话目录")?.ok, true);
    } finally {
      if (prev === undefined) delete process.env.SOCODE_HOME;
      else process.env.SOCODE_HOME = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
