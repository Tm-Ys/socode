import { completeChat } from "./chat.js";
import type { Message } from "./db.js";
import { pickJudgeProvider, type ChatFn } from "./long-approve.js";
import type { AgentMode } from "./mode.js";
import type { Provider } from "./provider.js";
import type { SkillRecord } from "./skills.js";

export const BASE_SKILL_NAMES = ["brainstorm", "grill-me", "ponytail", "superpowers"] as const;
export type BaseSkillName = (typeof BASE_SKILL_NAMES)[number];

export const SKILL_ACTIVATE_TIMEOUT_MS = 8_000;
export const SKILL_ACTIVATE_MAX = 2;
const USER_PROMPT_MAX = 500;

const WHEN: Record<BaseSkillName, string> = {
  brainstorm: "新功能/改行为/架构且设计未定。一行明确小改不要。",
  "grill-me": "需求含糊、要追问决策。任务已具体不要。不要和 brainstorm 同时选，除非用户都点名。",
  ponytail: "本轮会写/改/删/重构/review 代码。纯讨论或只提问不要。",
  superpowers: "修 bug、多步实现、需要验证。单行改动或纯设计对话不要。",
};

export type SkillActivation = {
  activate: string[];
  reasons: Record<string, string>;
};

export const EMPTY_SKILL_ACTIVATION: SkillActivation = { activate: [], reasons: {} };

export const SKILL_ACTIVATE_PROMPT = `你是 socode 的 skill 激活器，不是助手。
只判断：这句话是不是软件工程任务，以及候选 skill 里哪几个本轮必须注入全文。

默认 activate=[]。宁可漏、不要滥。最多 2 个，用户点名的除外。
闲聊、问时间、翻译、计算、与写代码/改仓库/设计软件无关 → 空数组。

- 用户点名的 skill 必须加入。
- brainstorm：设计未定的功能/行为/架构。
- grill-me：需求含糊要追问。已有方向用 brainstorm，不要两个一起。
- ponytail：本轮要动代码。
- superpowers：要系统验证的工程任务，不是每个改动都开。

只输出 JSON，不要 markdown：
{"activate":["ponytail"],"reasons":{"ponytail":"一句中文"}}
activate 只能是候选名。reasons 只给激活项，每条不超过 40 字。`;

export function parseActivateReply(text: string, allowed: string[]): SkillActivation {
  const names = new Set(allowed);
  const trimmed = text.trim();
  if (!trimmed) return EMPTY_SKILL_ACTIVATION;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return EMPTY_SKILL_ACTIVATION;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return EMPTY_SKILL_ACTIVATION;
  }
  const raw = data.activate ?? data.Activate ?? data["激活"];
  const list = Array.isArray(raw) ? raw : [];
  const reasonMap = asStringMap(data.reasons ?? data.Reasons ?? data["理由"] ?? data["原因"]);
  const activate: string[] = [];
  const reasons: Record<string, string> = {};
  for (const item of list) {
    const name = String(item).trim();
    if (!names.has(name) || activate.includes(name)) continue;
    const reason = (reasonMap[name] ?? "").trim().slice(0, 80);
    if (!reason) continue;
    activate.push(name);
    reasons[name] = reason;
  }
  return { activate, reasons };
}

export function mentionedBaseSkills(prompt: string, allowed: string[]) {
  const lower = prompt.toLowerCase();
  return allowed.filter((name) => lower.includes(name.toLowerCase()));
}

export function skipSkillActivate(prompt: string) {
  return /^(你好|嗨|哈喽|hello|hi|hey|thanks|thank you|谢谢|好的|ok|嗯+)[！!。.\s]*$/i.test(prompt.trim());
}

export function capActivated(decision: SkillActivation, prompt: string, allowed: string[]): SkillActivation {
  const forced = mentionedBaseSkills(prompt, allowed);
  const rest = decision.activate.filter((name) => !forced.includes(name));
  const activate = [...forced, ...rest].filter((name, i, all) => all.indexOf(name) === i);
  const max = Math.max(SKILL_ACTIVATE_MAX, forced.length);
  const kept = activate.slice(0, max);
  const reasons: Record<string, string> = {};
  for (const name of kept) {
    reasons[name] = decision.reasons[name] ?? (forced.includes(name) ? "用户点名" : "");
  }
  return { activate: kept.filter((name) => reasons[name]), reasons };
}

export function mergeForcedSkills(
  decision: SkillActivation,
  forced: string[],
  allowed: string[],
  reason = "用户 /setplan 强制",
): SkillActivation {
  const names = forced.filter((name) => allowed.includes(name));
  if (!names.length) return decision;
  let activate = [...names, ...decision.activate.filter((name) => !names.includes(name))];
  const reasons: Record<string, string> = { ...decision.reasons };
  if (names.includes("grill-me") && !names.includes("brainstorm")) {
    activate = activate.filter((name) => name !== "brainstorm");
    delete reasons.brainstorm;
  }
  for (const name of activate) {
    reasons[name] = names.includes(name) ? reason : reasons[name] ?? "";
  }
  return { activate: activate.filter((name) => reasons[name]), reasons };
}

export function formatActivateUser(prompt: string, mode: AgentMode, candidates: SkillRecord[]) {
  const cards = candidates.map((skill) => {
    const when = WHEN[skill.name as BaseSkillName] ?? skill.description.slice(0, 80);
    const desc = clip(skill.description.replace(/\s+/g, " "), 120);
    return `- ${skill.name}: ${desc}\n  when: ${when}`;
  });
  return [`mode: ${mode}`, `user: ${clip(prompt, USER_PROMPT_MAX)}`, "skills:", ...cards].join("\n");
}

export async function activateBaseSkills(params: {
  prompt: string;
  mode: AgentMode;
  skills: SkillRecord[];
  provider: Provider;
  complete?: ChatFn;
  timeoutMs?: number;
  signal?: AbortSignal;
  force?: string[];
}): Promise<SkillActivation> {
  const allowed = params.skills
    .map((skill) => skill.name)
    .filter((name): name is BaseSkillName => (BASE_SKILL_NAMES as readonly string[]).includes(name));
  const unique = [...new Set(allowed)];
  const prompt = params.prompt.trim();
  const forced = (params.force ?? []).filter((name) => unique.includes(name));
  if (!unique.length || (!prompt && !forced.length)) return EMPTY_SKILL_ACTIVATION;
  const mentioned = mentionedBaseSkills(prompt, unique);
  if (skipSkillActivate(prompt) && !mentioned.length && !forced.length) return EMPTY_SKILL_ACTIVATION;
  if (!params.provider.url || !params.provider.api || !params.provider.model) {
    return mergeForcedSkills(namedOnly(mentioned), forced, unique);
  }
  if (skipSkillActivate(prompt) && forced.length && !mentioned.length) {
    return mergeForcedSkills(EMPTY_SKILL_ACTIVATION, forced, unique);
  }
  const candidates = unique
    .map((name) => params.skills.find((skill) => skill.name === name))
    .filter((skill): skill is SkillRecord => Boolean(skill));
  const timeoutMs = params.timeoutMs ?? SKILL_ACTIVATE_TIMEOUT_MS;
  const complete = params.complete ?? defaultComplete;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  params.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await complete({
      provider: {
        ...pickJudgeProvider(params.provider),
        maxOutput: Math.min(180, Math.max(80, params.provider.maxOutput || 180)),
      },
      stream: false,
      signal: controller.signal,
      messages: [
        { role: "system", content: SKILL_ACTIVATE_PROMPT },
        { role: "user", content: formatActivateUser(prompt, params.mode, candidates) },
      ],
    });
    const parsed = parseActivateReply(result.content ?? "", unique);
    return mergeForcedSkills(capActivated(parsed, prompt, unique), forced, unique);
  } catch {
    return mergeForcedSkills(namedOnly(mentioned), forced, unique);
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener("abort", onAbort);
  }
}

export function logSkillActivate(decision: SkillActivation) {
  for (const name of decision.activate) {
    const reason = decision.reasons[name];
    console.log(`skill  ${name}${reason ? `  ${reason}` : ""}`);
  }
}

function namedOnly(names: string[]): SkillActivation {
  const reasons: Record<string, string> = {};
  for (const name of names) reasons[name] = "用户点名";
  return { activate: names, reasons };
}

function asStringMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim()) out[key] = item.trim();
  }
  return out;
}

function defaultComplete(params: {
  provider: Provider;
  messages: Message[];
  stream?: boolean;
  signal?: AbortSignal;
}) {
  return completeChat(params);
}

function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
