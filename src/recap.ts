import { completeChat } from "./chat.js";
import type { Message } from "./db.js";
import { providerForRole, type Provider } from "./provider.js";
import { summarizeTool } from "./tool-ui.js";
import type { TokenUsage } from "./usage.js";

export const RECAP_TOOL_LIMIT = 6;
export const RECAP_TEXT_CHARS = 2400;
export const RECAP_PREFIX = "【recap】";
export const RECAP_HINT = "本轮次对话已用 recap 压缩，需要具体细节请自行 grep。";
const LINE_MAX = 140;

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export type RecapCall = { name: string; detail: string };

export type RecapStats = {
  tools: RecapCall[];
  assistantChars: number;
};

export function recapStats(trace: Message[]): RecapStats {
  const tools: RecapCall[] = [];
  let assistantChars = 0;
  for (const message of trace) {
    if (message.role !== "assistant") continue;
    assistantChars += message.content?.length ?? 0;
    for (const call of message.toolCalls ?? []) {
      tools.push({
        name: call.name,
        detail: summarizeTool(call.name, call.arguments),
      });
    }
  }
  return { tools, assistantChars };
}

export function shouldRecap(stats: RecapStats): boolean {
  return stats.tools.length > RECAP_TOOL_LIMIT || stats.assistantChars >= RECAP_TEXT_CHARS;
}

export function formatRecap(stats: RecapStats): string {
  const groups = groupTools(stats.tools);
  const counts = groups
    .map((group) => (group.count > 1 ? `${group.name}×${group.count}` : group.name))
    .join("  ");
  const details: string[] = [];
  for (const group of groups) {
    for (const detail of group.details) {
      if (detail && !details.includes(detail)) details.push(detail);
    }
  }
  const n = stats.tools.length;
  const long = stats.assistantChars >= RECAP_TEXT_CHARS;
  const many = n > RECAP_TOOL_LIMIT;
  const head = many && long ? `${n} 个工具 · 长输出` : many ? `${n} 个工具` : "长输出";
  const body = [counts, details.join(", ")].filter(Boolean).join("  ·  ");
  return clipLine(`  recap  ${head}${body ? `  ${body}` : ""}`, LINE_MAX);
}

export function recapLine(trace: Message[], opts?: { color?: boolean }): string | null {
  const stats = recapStats(trace);
  if (!shouldRecap(stats)) return null;
  const text = formatRecap(stats);
  return opts?.color ? `${DIM}${text}${RESET}` : text;
}

export function isRecapMessage(message: Message) {
  return message.role === "assistant" && message.content.startsWith(RECAP_PREFIX);
}

export function recapHistoryMessage(trace: Message[]): Message | null {
  const stats = recapStats(trace);
  if (!shouldRecap(stats)) return null;
  return {
    role: "assistant",
    content: `${RECAP_PREFIX}\n${formatRecap(stats).trim()}\n${RECAP_HINT}`,
  };
}

/** 本轮若触发 recap，历史只保留用户原话和 recap，丢掉工具轨迹与长回复。 */
export function historyAfterTurn(user: Message, trace: Message[]): Message[] {
  const recap = recapHistoryMessage(trace);
  if (!recap) return [user, ...trace];
  return [user, recap];
}

export async function historyAfterTurnAsync(
  user: Message,
  trace: Message[],
  provider: Provider,
): Promise<{ messages: Message[]; usage?: TokenUsage }> {
  const local = recapHistoryMessage(trace);
  if (!local) return { messages: [user, ...trace] };
  try {
    const llm = providerForRole(provider, "recap");
    const result = await completeChat({
      provider: { ...llm, maxOutput: Math.min(512, Math.max(128, llm.maxOutput)), thinkingEffort: "none" },
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "你是回合摘要器。根据本轮工具与回复写一段不超过 8 行的中文 recap，供后续接着干活。保留改过的文件、关键结论、未完成事项。不要客套，不要 markdown 标题。",
        },
        { role: "user", content: recapPrompt(trace, local.content) },
      ],
    });
    const text = result.content.trim();
    if (!text) return { messages: [user, local], usage: result.usage };
    return {
      messages: [user, { role: "assistant" as const, content: `${RECAP_PREFIX}\n${text}\n${RECAP_HINT}` }],
      usage: result.usage,
    };
  } catch {
    return { messages: [user, local] };
  }
}

function recapPrompt(trace: Message[], local: string) {
  const bits = [`本地提纲：\n${local}`];
  for (const message of trace) {
    if (message.role === "assistant") {
      if (message.content.trim()) bits.push(`助手: ${clipRecap(message.content, 800)}`);
      for (const call of message.toolCalls ?? []) {
        bits.push(`调用 ${call.name}: ${clipRecap(call.arguments, 200)}`);
      }
    } else if (message.role === "tool") {
      bits.push(`工具结果: ${clipRecap(message.content, 400)}`);
    }
  }
  const text = bits.join("\n");
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n…` : text;
}

function clipRecap(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function groupTools(tools: RecapCall[]) {
  const groups: Array<{ name: string; count: number; details: string[] }> = [];
  const index = new Map<string, number>();
  for (const tool of tools) {
    let at = index.get(tool.name);
    if (at === undefined) {
      at = groups.length;
      index.set(tool.name, at);
      groups.push({ name: tool.name, count: 0, details: [] });
    }
    const group = groups[at];
    group.count += 1;
    if (tool.detail && !group.details.includes(tool.detail)) group.details.push(tool.detail);
  }
  return groups;
}

function clipLine(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}
