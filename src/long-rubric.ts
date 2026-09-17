import { completeChat } from "./chat.js";
import { loadConfig } from "./config.js";
import type { Message } from "./db.js";
import { listProviders, type Provider } from "./provider.js";
import type { LastVerify, RubricScore, TaskState, VerifyRubric } from "./task-state.js";

export const RUBRIC_AXES = ["file_change", "spec_alignment", "integrity", "runtime"] as const;
export type RubricAxis = (typeof RUBRIC_AXES)[number];

const GENERATE_TIMEOUT_MS = 20_000;
const SCORE_TIMEOUT_MS = 15_000;
const MIN_ITEMS = 8;
const MAX_ITEMS = 32;
const PASS_SCORE = 0.7;

export type LongRubric = {
  ensure: (state: TaskState, params: { workspace: string; force?: boolean }) => Promise<VerifyRubric | { error: string }>;
  score: (params: {
    state: TaskState;
    milestone: string;
    verify?: LastVerify;
  }) => Promise<RubricScore>;
};

type ChatFn = (params: {
  provider: Provider;
  messages: Message[];
  stream?: boolean;
  signal?: AbortSignal;
}) => Promise<{ content: string }>;

const GENERATE_PROMPT = `你是 socode Long 模式的里程碑评分准则生成器。根据目标和关键文件写出仓库接地的二值准则。
只输出 JSON：{"items":[{"id":"fc-1","axis":"file_change|spec_alignment|integrity|runtime","text":"短准则","weight":1|2|3}]}
要求：8–26 条；四轴都要有；weight 只能是 1/2/3；至少一半条目包含路径或标识符；禁止空话（「代码应该正确」）。`;

const SCORE_PROMPT = `你是 socode Long 模式的里程碑评分器。对照准则逐条打 0 或 1。
只输出 JSON：{"items":[{"id":"fc-1","s":0或1,"note":"一句"}]}
每条准则都必须出现。不要编造未提供的测试结果。`;

export function goalHash(goal: string) {
  const text = goal.trim().replace(/\s+/g, " ");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function parseRubricItems(text: string): VerifyRubric | { error: string } {
  const data = parseObject(text);
  if (!data) return { error: "rubric 不是 JSON" };
  const raw = data.items;
  if (!Array.isArray(raw)) return { error: "缺少 items" };
  const items: VerifyRubric["items"] = [];
  const axes = new Set<string>();
  let grounded = 0;
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const axis = String(rec.axis ?? "");
    if (!RUBRIC_AXES.includes(axis as RubricAxis)) continue;
    const id = String(rec.id ?? `${axis}-${items.length + 1}`).trim().slice(0, 24);
    const textItem = String(rec.text ?? rec["准则"] ?? "").trim().slice(0, 200);
    const weight = Number(rec.weight);
    if (!id || !textItem || ![1, 2, 3].includes(weight)) continue;
    if (/[./_A-Za-z]/.test(textItem) && /src\/|[A-Za-z_][A-Za-z0-9_]+/.test(textItem)) grounded += 1;
    axes.add(axis);
    items.push({ id, axis: axis as RubricAxis, text: textItem, weight: weight as 1 | 2 | 3 });
    if (items.length >= MAX_ITEMS) break;
  }
  if (items.length < MIN_ITEMS) return { error: `准则太少（${items.length}）` };
  if (axes.size < 4) return { error: "四轴必须都有条目" };
  if (grounded < items.length / 2) return { error: "准则没有落到路径或符号上" };
  return {
    version: 1,
    goalHash: "",
    items,
    createdAt: new Date().toISOString(),
  };
}

export function parseRubricScore(text: string, rubric: VerifyRubric, milestone: string): RubricScore {
  const closed = (reason: string): RubricScore => ({
    at: new Date().toISOString(),
    milestone,
    score: 0,
    pass: false,
    items: [],
    failClosedReason: reason,
  });
  const data = parseObject(text);
  if (!data) return closed("评分不是 JSON");
  const raw = data.items;
  if (!Array.isArray(raw)) return closed("评分缺少 items");
  const byId = new Map<string, { s: 0 | 1; note: string }>();
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const id = String(rec.id ?? "").trim();
    const s = rec.s === 1 || rec.s === true ? 1 : rec.s === 0 || rec.s === false ? 0 : undefined;
    const note = String(rec.note ?? "").trim().slice(0, 160);
    if (!id || s === undefined) continue;
    byId.set(id, { s, note });
  }
  const items = rubric.items.map((item) => {
    const hit = byId.get(item.id);
    return { id: item.id, s: (hit?.s ?? 0) as 0 | 1, note: hit?.note ?? "缺评分，记 0" };
  });
  if (items.length !== rubric.items.length) return closed("评分条数不完整");
  const weight3Fail = rubric.items.some((item) => item.weight === 3 && items.find((row) => row.id === item.id)?.s !== 1);
  const total = rubric.items.reduce((sum, item) => sum + item.weight, 0);
  const got = rubric.items.reduce((sum, item) => {
    const row = items.find((entry) => entry.id === item.id);
    return sum + item.weight * (row?.s ?? 0);
  }, 0);
  const score = total > 0 ? got / total : 0;
  const pass = !weight3Fail && score >= PASS_SCORE;
  return {
    at: new Date().toISOString(),
    milestone,
    score,
    pass,
    items,
    failClosedReason: pass ? undefined : weight3Fail ? "权重 3 的准则未全过" : `得分 ${score.toFixed(2)} < ${PASS_SCORE}`,
  };
}

export function createLongRubric(provider: () => Provider, complete?: ChatFn): LongRubric {
  return {
    async ensure(state, params) {
      const hash = goalHash(state.goal);
      if (state.verifyRubric && state.verifyRubric.goalHash === hash && state.verifyRubric.items.length) {
        return state.verifyRubric;
      }
      if (!state.goal.trim()) return { error: "goal 为空，无法生成 rubric" };
      const reply = await callJudge({
        provider: pickRubricProvider(provider()),
        complete,
        timeoutMs: GENERATE_TIMEOUT_MS,
        system: GENERATE_PROMPT,
        user: [
          `workspace: ${params.workspace}`,
          `goal: ${state.goal}`,
          `milestones: ${JSON.stringify(state.milestones)}`,
          `keyFiles: ${JSON.stringify(state.keyFiles)}`,
        ].join("\n"),
      });
      if ("error" in reply) return reply;
      const parsed = parseRubricItems(reply.content);
      if ("error" in parsed) return parsed;
      parsed.goalHash = hash;
      return parsed;
    },
    async score(params) {
      const rubric = params.state.verifyRubric;
      if (!rubric?.items.length) {
        return {
          at: new Date().toISOString(),
          milestone: params.milestone,
          score: 0,
          pass: false,
          items: [],
          failClosedReason: "还没有 rubric",
        };
      }
      const reply = await callJudge({
        provider: pickRubricProvider(provider()),
        complete,
        timeoutMs: SCORE_TIMEOUT_MS,
        system: SCORE_PROMPT,
        user: [
          `goal: ${params.state.goal}`,
          `milestone: ${params.milestone}`,
          `keyFiles: ${JSON.stringify(params.state.keyFiles)}`,
          `verify: ${JSON.stringify(params.verify ?? params.state.lastVerify ?? null)}`,
          `items: ${JSON.stringify(rubric.items)}`,
        ].join("\n"),
      });
      if ("error" in reply) {
        return {
          at: new Date().toISOString(),
          milestone: params.milestone,
          score: 0,
          pass: false,
          items: [],
          failClosedReason: reply.error,
        };
      }
      return parseRubricScore(reply.content, rubric, params.milestone);
    },
  };
}

function pickRubricProvider(base: Provider): Provider {
  const model = loadConfig().judgeModel;
  const named = listProviders(base).find((item) => /^(judge|fast|cheap|mini)$/i.test(item.name));
  const source = named && named.url && named.api ? named : base;
  return {
    ...source,
    model: model || source.model,
    thinkingEffort: "none",
    maxOutput: Math.min(2048, Math.max(512, source.maxOutput || 1024)),
  };
}

async function callJudge(params: {
  provider: Provider;
  complete?: ChatFn;
  timeoutMs: number;
  system: string;
  user: string;
}): Promise<{ content: string } | { error: string }> {
  if (!params.provider.url || !params.provider.api || !params.provider.model) {
    return { error: "评分器缺少 Provider" };
  }
  const complete = params.complete ?? ((opts) => completeChat(opts));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const result = await complete({
      provider: params.provider,
      stream: false,
      signal: controller.signal,
      messages: [
        { role: "system", content: params.system },
        { role: "user", content: params.user },
      ],
    });
    const content = result.content?.trim() ?? "";
    if (!content) return { error: "评分器返回为空" };
    return { content };
  } catch (error) {
    const aborted =
      (typeof error === "object" && error && "name" in error && String((error as { name: unknown }).name) === "AbortError") ||
      (error instanceof Error && /aborted|超时|timeout/i.test(error.message));
    return { error: aborted ? "评分超时" : `评分调用失败: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}
