import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  formatSkillPrompt,
  loadSkillBundle,
  parseSkillMarkdown,
} from "./skills.js";

describe("skill loader", () => {
  it("loads AGENTS.md then CLAUDE.md so Claude-specific text wins on conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-skills-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "use bun");
      writeFileSync(join(dir, "CLAUDE.md"), "use npm");
      const bundle = loadSkillBundle(dir, { home: null, bundled: false });
      assert.deepEqual(
        bundle.instructions.map((file) => file.label),
        ["AGENTS.md", "CLAUDE.md"],
      );
      const prompt = formatSkillPrompt(bundle, dir);
      assert.ok(prompt.indexOf("use bun") < prompt.indexOf("use npm"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("walks parent directories first, workspace last", () => {
    const root = mkdtempSync(join(tmpdir(), "socode-skills-"));
    const child = join(root, "app");
    mkdirSync(child);
    writeFileSync(join(root, ".git"), "");
    writeFileSync(join(root, "AGENTS.md"), "root-agents");
    writeFileSync(join(child, "CLAUDE.md"), "child-claude");
    try {
      const bundle = loadSkillBundle(child, { home: null, bundled: false });
      assert.equal(bundle.instructions[0]?.body, "root-agents");
      assert.equal(bundle.instructions.at(-1)?.body, "child-claude");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("expands @AGENTS.md inside CLAUDE.md without duplicating", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-skills-"));
    try {
      writeFileSync(join(dir, "AGENTS.md"), "shared-rules");
      writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\nclaude-only");
      const bundle = loadSkillBundle(dir, { home: null, bundled: false });
      const claude = bundle.instructions.find((file) => file.label === "CLAUDE.md");
      assert.match(claude?.body ?? "", /claude-only/);
      assert.doesNotMatch(claude?.body ?? "", /shared-rules/);
      assert.equal(bundle.instructions.filter((file) => file.body.includes("shared-rules")).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets project skills override user skills of the same name", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-skills-"));
    const home = join(dir, "home");
    mkdirSync(join(home, ".socode", "skills", "review"), { recursive: true });
    mkdirSync(join(dir, ".socode", "skills", "review"), { recursive: true });
    writeFileSync(
      join(home, ".socode", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: user review\n---\nuser body",
    );
    writeFileSync(
      join(dir, ".socode", "skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: project review\n---\nproject body",
    );
    try {
      const bundle = loadSkillBundle(dir, { home, bundled: false });
      assert.equal(bundle.skills.length, 1);
      assert.equal(bundle.skills[0].description, "project review");
      assert.match(bundle.skills[0].body, /project body/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps disable-model-invocation skills on-demand", () => {
    const parsed = parseSkillMarkdown(
      "---\nname: commit\ndescription: Write commits\ndisable-model-invocation: true\n---\nUse conventional commits.",
      "commit",
    );
    assert.equal(parsed.auto, false);
    assert.equal(parsed.name, "commit");
    assert.match(parsed.body, /conventional/);
  });

  it("loads bundled base skills without injecting their bodies until activated", () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-skills-"));
    try {
      const bundle = loadSkillBundle(dir, { home: null });
      const names = bundle.skills.map((skill) => skill.name);
      for (const name of ["brainstorm", "grill-me", "ponytail", "superpowers"]) {
        assert.ok(names.includes(name), name);
      }
      const catalog = formatSkillPrompt(bundle, dir);
      assert.match(catalog, /`ponytail`/);
      assert.doesNotMatch(catalog, /## Skill: ponytail/);
      const injected = formatSkillPrompt(bundle, dir, ["ponytail"]);
      assert.match(injected, /## Skill: ponytail/);
      assert.match(injected, /懒的资深工程师/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
