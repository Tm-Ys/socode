import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activateBaseSkills,
  capActivated,
  formatActivateUser,
  parseActivateReply,
  skipSkillActivate,
} from "./skill-activate.js";
import type { Provider } from "./provider.js";
import type { SkillRecord } from "./skills.js";

const provider: Provider = {
  name: "test",
  url: "https://example.test/v1",
  api: "sk-test",
  model: "big-model",
  contextWindow: 128000,
  maxOutput: 8192,
  thinkingEffort: "high",
};

const candidates: SkillRecord[] = [
  {
    name: "ponytail",
    description: "最小实现",
    path: "/skills/ponytail/SKILL.md",
    scope: "base",
    auto: false,
    body: "lazy",
  },
  {
    name: "brainstorm",
    description: "先设计",
    path: "/skills/brainstorm/SKILL.md",
    scope: "base",
    auto: false,
    body: "design",
  },
];

describe("parseActivateReply", () => {
  it("keeps allowed names that have reasons", () => {
    const parsed = parseActivateReply(
      '{"activate":["ponytail","nope"],"reasons":{"ponytail":"要改代码"}}',
      ["ponytail", "brainstorm"],
    );
    assert.deepEqual(parsed.activate, ["ponytail"]);
    assert.equal(parsed.reasons.ponytail, "要改代码");
  });

  it("fails closed on garbage or missing reasons", () => {
    assert.deepEqual(parseActivateReply("nope", ["ponytail"]).activate, []);
    assert.deepEqual(parseActivateReply('{"activate":["ponytail"]}', ["ponytail"]).activate, []);
  });
});

describe("capActivated", () => {
  it("keeps at most two unless the user named more", () => {
    const capped = capActivated(
      {
        activate: ["brainstorm", "grill-me", "ponytail", "superpowers"],
        reasons: {
          brainstorm: "a",
          "grill-me": "b",
          ponytail: "c",
          superpowers: "d",
        },
      },
      "加一个登录",
      ["brainstorm", "grill-me", "ponytail", "superpowers"],
    );
    assert.deepEqual(capped.activate, ["brainstorm", "grill-me"]);
  });

  it("always includes skills the user named", () => {
    const capped = capActivated(
      { activate: ["brainstorm"], reasons: { brainstorm: "设计" } },
      "用 ponytail 和 superpowers 做",
      ["brainstorm", "ponytail", "superpowers"],
    );
    assert.deepEqual(capped.activate, ["ponytail", "superpowers"]);
  });
});

describe("skipSkillActivate", () => {
  it("skips greetings but not engineering asks", () => {
    assert.equal(skipSkillActivate("你好"), true);
    assert.equal(skipSkillActivate("加一个登录页"), false);
  });
});

describe("formatActivateUser", () => {
  it("sends compact cards not full bodies", () => {
    const text = formatActivateUser("实现 skill 激活器", "ask", candidates);
    assert.match(text, /user: 实现 skill 激活器/);
    assert.match(text, /ponytail:/);
    assert.doesNotMatch(text, /\blazy\b/);
  });
});

describe("activateBaseSkills", () => {
  it("does not call the model for greetings", async () => {
    let called = false;
    const decision = await activateBaseSkills({
      prompt: "你好",
      mode: "ask",
      skills: candidates,
      provider,
      complete: async () => {
        called = true;
        return { content: '{"activate":["ponytail"],"reasons":{"ponytail":"x"}}' };
      },
    });
    assert.equal(called, false);
    assert.deepEqual(decision.activate, []);
  });

  it("asks the model and injects only returned skills", async () => {
    const decision = await activateBaseSkills({
      prompt: "给 write 工具加一个校验",
      mode: "ask",
      skills: candidates,
      provider,
      complete: async () => ({
        content: '{"activate":["ponytail"],"reasons":{"ponytail":"本轮改代码"}}',
      }),
    });
    assert.deepEqual(decision.activate, ["ponytail"]);
    assert.equal(decision.reasons.ponytail, "本轮改代码");
  });

  it("falls back to named skills when the model fails", async () => {
    const decision = await activateBaseSkills({
      prompt: "用 brainstorm 想一想",
      mode: "ask",
      skills: candidates,
      provider,
      complete: async () => {
        throw new Error("boom");
      },
    });
    assert.deepEqual(decision.activate, ["brainstorm"]);
    assert.equal(decision.reasons.brainstorm, "用户点名");
  });
});
