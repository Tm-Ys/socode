import { formatToolCallLine, formatToolResultLines } from "./tool-ui.js";
import { ASSISTANT_PREFIX, USER_PROMPT } from "./prompt.js";
import type { Message } from "./db.js";

export function normalizeHistory(history: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      out.push({ ...message });
      continue;
    }
    const content = message.content.trim();
    if (!content && !message.toolCalls?.length) continue;
    const last = out[out.length - 1];
    const canMerge =
      last?.role === "user" &&
      message.role === "user" &&
      !last.toolCalls?.length &&
      !message.toolCalls?.length;
    if (canMerge && last) {
      last.content = `${last.content}\n${content}`;
      continue;
    }
    out.push({ ...message, content: content || message.content });
  }
  while (out[0]?.role === "assistant" || out[0]?.role === "tool") out.shift();
  return out;
}

export function estimateTokens(text: string) {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

export function messageTokens(message: Message) {
  let tokens = estimateTokens(message.content) + 8;
  if (message.toolCalls?.length) tokens += estimateTokens(JSON.stringify(message.toolCalls));
  if (message.toolCallId) tokens += 8;
  return tokens;
}

export function buildApiMessages(params: {
  history: Message[];
  user: Message;
  systemPrompt?: string;
  maxMessages: number;
  contextWindow?: number;
  maxOutput?: number;
}): Message[] {
  const max = Math.max(2, params.maxMessages);
  let history = normalizeHistory(params.history);
  if (history.length > max) {
    history = history.slice(-max);
    while (history[0]?.role !== "user") history.shift();
  }
  if (history.at(-1)?.role === "user") history = history.slice(0, -1);

  const system = params.systemPrompt
    ? ({ role: "system", content: params.systemPrompt } as Message)
    : undefined;
  const user: Message = { role: "user", content: params.user.content };
  const budget = Math.max(
    512,
    (params.contextWindow ?? 128000) - (params.maxOutput ?? 8192) - 256,
  );

  while (history.length > 0) {
    const tokens =
      (system ? messageTokens(system) : 0) +
      history.reduce((sum, message) => sum + messageTokens(message), 0) +
      messageTokens(user);
    if (tokens <= budget) break;
    history.shift();
    while (history[0]?.role !== "user" && history.length > 0) history.shift();
  }

  const messages: Message[] = [];
  if (system) messages.push(system);
  messages.push(...history, user);
  return messages;
}

export function previewMessages(history: Message[], limit = 8) {
  const normalized = normalizeHistory(history);
  const recent = normalized.slice(-limit);
  const skipped = normalized.length - recent.length;
  return { recent, skipped };
}

export function formatPreviewLine(message: Message) {
  if (message.role === "user") return `${USER_PROMPT}${message.content}`;
  if (message.role === "tool") return formatToolResultLines(message.content).join("\n");
  if (message.toolCalls?.length) {
    const calls = message.toolCalls
      .map((call) => formatToolCallLine(call.name, call.arguments))
      .join("\n");
    const text = message.content.trim();
    return text ? `${ASSISTANT_PREFIX}${text}\n${calls}` : calls;
  }
  return `${ASSISTANT_PREFIX}${message.content}`;
}
