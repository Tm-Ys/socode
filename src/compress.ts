import { completeChat } from "./chat.js";
import { COMPRESSED_PREFIX, messageTokens, normalizeHistory, type ContextReport } from "./context.js";
import type { Message } from "./db.js";
import { harnessModeMessage, isHarnessModeMessage, lastHarnessMode } from "./mode.js";
import type { Provider } from "./provider.js";
import { isTaskStateMessage, lastTaskState, taskStateMessage } from "./task-state.js";
import { isPlanMessage, lastPlan, planMessage } from "./plan.js";

const KEEP_USER_TURNS = 2;
const MIN_STALE_TOKENS = 1200;
const TRANSCRIPT_MAX_CHARS = 80_000;

export function splitForCompress(history: Message[]) {
  const normalized = normalizeHistory(history);
  const userAt = normalized
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  if (userAt.length <= KEEP_USER_TURNS) {
    return { stale: [] as Message[], keep: normalized };
  }
  const cut = userAt[userAt.length - KEEP_USER_TURNS];
  let stale = normalized.slice(0, cut);
  let keep = normalized.slice(cut);
  stale = stale.filter((message) => !isPinnedControl(message));
  keep = keep.filter((message) => !isPinnedControl(message));
  const head: Message[] = [];
  const mode = lastHarnessMode(normalized);
  if (mode) head.push(harnessModeMessage(mode));
  const task = lastTaskState(normalized);
  if (task) head.push(taskStateMessage(task));
  const plan = lastPlan(normalized);
  if (plan) head.push(planMessage(plan));
  return { stale, keep: [...head, ...keep] };
}

function isPinnedControl(message: Message) {
  return message.role === "system";
}

export const LONG_COMPRESS_RATIO = 0.82;

export function shouldAutoCompress(params: {
  history: Message[];
  report?: ContextReport;
  ratio?: number;
}) {
  if (!canCompress(params.history)) return false;
  const report = params.report;
  if (!report) return false;
  const ratio = params.ratio ?? LONG_COMPRESS_RATIO;
  if (report.droppedCount > 0) return true;
  const pressure = report.used / Math.max(1, report.window);
  return pressure >= ratio || report.free < Math.min(4000, Math.max(512, report.maxOutput / 2));
}

export function canCompress(history: Message[]) {
  const { stale } = splitForCompress(history);
  const tokens = stale.reduce((sum, message) => sum + messageTokens(message), 0);
  return stale.length > 0 && tokens >= MIN_STALE_TOKENS;
}

export function peelAgentPrefix(messages: Message[]) {
  const head: Message[] = [];
  let i = 0;
  while (
    i < messages.length &&
    messages[i].role === "system" &&
    !isHarnessModeMessage(messages[i]) &&
    !isTaskStateMessage(messages[i]) &&
    !isPlanMessage(messages[i])
  ) {
    head.push(messages[i]);
    i += 1;
  }
  return { head, rest: messages.slice(i) };
}

export async function compressAgentMessages(params: {
  provider: Provider;
  messages: Message[];
  signal?: AbortSignal;
}): Promise<{ messages: Message[]; saved: number } | null> {
  const { head, rest } = peelAgentPrefix(params.messages);
  if (!canCompress(rest)) return null;
  try {
    const result = await compressHistory({
      provider: params.provider,
      history: rest,
      signal: params.signal,
      stream: false,
    });
    if (result.saved < 200) return null;
    return { messages: [...head, ...result.messages], saved: result.saved };
  } catch {
    return null;
  }
}

export async function compressHistory(params: {
  provider: Provider;
  history: Message[];
  signal?: AbortSignal;
  stream?: boolean;
  onDelta?: (text: string) => void;
}): Promise<{ messages: Message[]; saved: number; summaryTokens: number }> {
  const { stale, keep } = splitForCompress(params.history);
  const staleTokens = stale.reduce((sum, message) => sum + messageTokens(message), 0);
  if (stale.length === 0 || staleTokens < MIN_STALE_TOKENS) {
    throw new Error("对话还不够长，无需压缩");
  }

  const result = await completeChat({
    provider: {
      ...params.provider,
      maxOutput: Math.min(4096, Math.max(1024, params.provider.maxOutput)),
    },
    stream: params.stream ?? true,
    signal: params.signal,
    onDelta: params.onDelta,
    messages: [
      {
        role: "system",
        content:
          "你是会话压缩器。把对话压成一份中文摘要，供后续继续工作使用。保留：目标、已做决策、改过的文件与路径、关键结论、未完成事项、用户偏好。丢掉：客套、重复工具输出、大段代码（只留路径和要点）。不要 markdown 标题堆砌，直接输出摘要正文。",
      },
      {
        role: "user",
        content: `请压缩以下对话：\n\n${toTranscript(stale)}`,
      },
    ],
  });

  const summary = result.content.trim();
  if (!summary) throw new Error("模型没有给出摘要");
  const summaryMessage: Message = {
    role: "user",
    content: `${COMPRESSED_PREFIX}\n${summary}`,
  };
  const messages = [summaryMessage, ...keep];
  const after = messages.reduce((sum, message) => sum + messageTokens(message), 0);
  const before = staleTokens + keep.reduce((sum, message) => sum + messageTokens(message), 0);
  return { messages, saved: Math.max(0, before - after), summaryTokens: messageTokens(summaryMessage) };
}

function toTranscript(messages: Message[]) {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      parts.push(`用户: ${clip(message.content, 8000)}`);
      continue;
    }
    if (message.role === "system") {
      parts.push(`系统: ${clip(message.content, 2000)}`);
      continue;
    }
    if (message.role === "tool") {
      parts.push(`工具结果: ${clip(message.content, 1500)}`);
      continue;
    }
    const calls = message.toolCalls?.length
      ? `\n调用: ${message.toolCalls.map((call) => call.name).join(", ")}`
      : "";
    parts.push(`助手: ${clip(message.content, 4000)}${calls}`);
  }
  const text = parts.join("\n\n");
  if (text.length <= TRANSCRIPT_MAX_CHARS) return text;
  const keep = Math.floor(TRANSCRIPT_MAX_CHARS / 2) - 20;
  return `${text.slice(0, keep)}\n\n…(中间已省略 ${text.length - keep * 2} 字)…\n\n${text.slice(-keep)}`;
}

function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…`;
}
