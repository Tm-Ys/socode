import type { Message } from "./db.js";

export function normalizeHistory(history: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    if (message.role === "system") continue;
    const content = message.content.trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last?.role === message.role) {
      last.content = `${last.content}\n${content}`;
      continue;
    }
    out.push({ role: message.role, content });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

export function buildApiMessages(params: {
  history: Message[];
  user: Message;
  systemPrompt?: string;
  maxMessages: number;
}): Message[] {
  const max = Math.max(2, params.maxMessages);
  let history = normalizeHistory(params.history);
  if (history.length > max) {
    history = history.slice(-max);
    while (history[0]?.role === "assistant") history.shift();
  }
  if (history.at(-1)?.role === "user") history = history.slice(0, -1);

  const messages: Message[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push(...history, { role: "user", content: params.user.content });
  return messages;
}

export function previewMessages(history: Message[], limit = 6) {
  const normalized = normalizeHistory(history);
  const recent = normalized.slice(-limit);
  const skipped = normalized.length - recent.length;
  return { recent, skipped };
}
