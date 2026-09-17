import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatJudgeUser,
  judgeLongApprove,
  parseJudgeReply,
  pickJudgeProvider,
  summarizeApproveArgs,
} from "./long-approve.js";
import type { Provider } from "./provider.js";

const provider: Provider = {
  name: "test",
  url: "https://example.test/v1",
  api: "sk-test",
  model: "big-model",
  contextWindow: 128000,
  maxOutput: 8192,
  thinkingEffort: "high",
};

const req = {
  tool: "bash",
  args: { cwd: "/workspace", command: "npm test" },
  workspace: "/workspace",
  goal: "加 Long 审批",
};

describe("parseJudgeReply", () => {
  it("accepts allow/reason JSON", () => {
    assert.deepEqual(parseJudgeReply('{"allow": true, "reason": "跑测试"}'), {
      allow: true,
      reason: "跑测试",
    });
  });

  it("accepts Chinese keys and ignores markdown fences", () => {
    const text = "```json\n{\"允许\": false, \"原因\": \"会删数据\"}\n```";
    assert.deepEqual(parseJudgeReply(text), { allow: false, reason: "会删数据" });
  });

  it("fails closed on garbage, missing boolean, or string allow", () => {
    assert.equal(parseJudgeReply("not json").allow, false);
    assert.equal(parseJudgeReply('{"reason":"x"}').allow, false);
    assert.equal(parseJudgeReply('{"allow":"true","reason":"x"}').allow, false);
    assert.equal(parseJudgeReply('{"allow":true}').allow, false);
  });
});

describe("summarizeApproveArgs", () => {
  it("clips write content instead of sending the whole file", () => {
    const summary = summarizeApproveArgs("write", {
      path: "/workspace/a.ts",
      content: "hello ".repeat(400),
    });
    const preview = String(summary.preview ?? "");
    assert.ok(preview.length <= 400);
    assert.equal(summary.bytes, Buffer.byteLength("hello ".repeat(400), "utf8"));
    assert.equal("content" in summary, false);
  });
});

describe("formatJudgeUser", () => {
  it("sends only mode, workspace, goal, and the pending tool", () => {
    const text = formatJudgeUser(req);
    assert.match(text, /mode: long/);
    assert.match(text, /goal: 加 Long 审批/);
    assert.match(text, /tool: bash/);
    assert.doesNotMatch(text, /chat history|previous|【harness mode】/i);
  });
});

describe("pickJudgeProvider", () => {
  it("keeps the same endpoint and shrinks output, honoring judgeModel", () => {
    const judge = pickJudgeProvider(provider, { judgeModel: "flash-lite" });
    assert.equal(judge.model, "flash-lite");
    assert.equal(judge.url, provider.url);
    assert.equal(judge.api, provider.api);
    assert.equal(judge.thinkingEffort, "none");
    assert.equal(judge.maxOutput, 256);
  });
});

describe("judgeLongApprove", () => {
  it("returns the mocked JSON verdict without chat history", async () => {
    const seen: unknown[] = [];
    const verdict = await judgeLongApprove(req, {
      provider,
      complete: async (params) => {
        seen.push(params.messages);
        assert.equal(params.stream, false);
        assert.equal(params.messages.length, 2);
        assert.equal(params.messages[0]?.role, "system");
        return { content: '{"allow":true,"reason":"与目标相关的测试"}' };
      },
    });
    assert.deepEqual(verdict, { allow: true, reason: "与目标相关的测试" });
    assert.equal((seen[0] as { length: number }).length, 2);
  });

  it("fails closed when the judge throws, times out, or returns invalid JSON", async () => {
    const errored = await judgeLongApprove(req, {
      provider,
      complete: async () => {
        throw new Error("boom");
      },
    });
    assert.equal(errored.allow, false);
    assert.match(errored.reason, /boom/);

    const bad = await judgeLongApprove(req, {
      provider,
      complete: async () => ({ content: "sure, go ahead" }),
    });
    assert.equal(bad.allow, false);

    const timed = await judgeLongApprove(req, {
      provider,
      timeoutMs: 20,
      complete: async ({ signal }) => {
        await new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("should not finish")), 1000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
        return { content: "" };
      },
    });
    assert.equal(timed.allow, false);
    assert.match(timed.reason, /超时/);
  });

  it("fails closed when Provider is missing", async () => {
    const verdict = await judgeLongApprove(req, {
      provider: { ...provider, api: "" },
      complete: async () => {
        throw new Error("should not call");
      },
    });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /Provider/);
  });
});
