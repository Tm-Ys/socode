import { formatToolCallLine, formatToolResultLines } from "./tool-ui.js";
import {
  assistantPrefix,
  harnessModeMessage,
  insertCurrentMode,
  isHarnessModeMessage,
  lastHarnessMode,
  modeHint,
  modeLabel,
  paintMode,
  parseHarnessMode,
  userPrefix,
  type AgentMode,
} from "./mode.js";
import { formatTaskStateSummary, isTaskStateMessage, parseTaskStateMessage } from "./task-state.js";
import type { Message } from "./db.js";
import type { ToolSpec } from "./tools.js";

export const COMPRESSED_PREFIX = "【会话摘要】";

export function normalizeHistory(history: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    if (message.role === "system") {
      if (isHarnessModeMessage(message) || isTaskStateMessage(message)) out.push({ ...message });
      continue;
    }
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

function cappedHistory(history: Message[], maxMessages: number) {
  let out = normalizeHistory(history);
  const max = Math.max(2, maxMessages);
  if (out.length > max) {
    out = out.slice(-max);
    while (out[0]?.role !== "user") out.shift();
  }
  return out;
}

function fitHistory(history: Message[], overhead: number, extra: number, budget: number) {
  const out = [...history];
  while (out.length > 0) {
    const tokens = overhead + extra + out.reduce((sum, message) => sum + messageTokens(message), 0);
    if (tokens <= budget) break;
    out.shift();
    while (out[0]?.role !== "user" && out.length > 0) out.shift();
  }
  return out;
}

export function buildApiMessages(params: {
  history: Message[];
  user: Message;
  systemPrompt?: string;
  maxMessages: number;
  contextWindow?: number;
  maxOutput?: number;
  toolsTokens?: number;
  mode?: AgentMode;
}): Message[] {
  let history = cappedHistory(params.history, params.maxMessages);
  if (history.at(-1)?.role === "user") history = history.slice(0, -1);

  const system = params.systemPrompt
    ? ({ role: "system", content: params.systemPrompt } as Message)
    : undefined;
  const user: Message = { role: "user", content: params.user.content };
  const window = params.contextWindow ?? 128000;
  const maxOutput = params.maxOutput ?? 8192;
  const budget = Math.max(512, window - maxOutput - 256);
  const modeNotice = params.mode ? harnessModeMessage(params.mode) : undefined;
  const modeExtra =
    modeNotice && lastHarnessMode(history) !== params.mode ? messageTokens(modeNotice) : 0;
  const overhead = (system ? messageTokens(system) : 0) + (params.toolsTokens ?? 0);
  history = fitHistory(history, overhead, messageTokens(user) + modeExtra, budget);

  const messages: Message[] = [];
  if (system) messages.push(system);
  messages.push(...history, user);
  return params.mode ? insertCurrentMode(messages, params.mode) : messages;
}

export function toolsTokensFromSpecs(specs: ToolSpec[]) {
  if (specs.length === 0) return 0;
  const payload = specs.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
  return estimateTokens(JSON.stringify(payload)) + specs.length * 8;
}

export type ContextSlice = {
  key: "system" | "tools" | "messages" | "output" | "free";
  label: string;
  tokens: number;
  color: string;
};

export type ContextReport = {
  window: number;
  maxOutput: number;
  budget: number;
  system: number;
  tools: number;
  messages: number;
  messageCount: number;
  keptCount: number;
  droppedCount: number;
  droppedTokens: number;
  used: number;
  free: number;
  slices: ContextSlice[];
};

const SLICE_META: Record<ContextSlice["key"], { label: string; color: string; ascii: string }> = {
  system: { label: "system", color: "\x1b[46m", ascii: "S" },
  tools: { label: "tools", color: "\x1b[45m", ascii: "T" },
  messages: { label: "context", color: "\x1b[43m", ascii: "C" },
  output: { label: "output", color: "\x1b[47m\x1b[30m", ascii: "O" },
  free: { label: "free", color: "\x1b[100m", ascii: "." },
};

export function measureContext(params: {
  history: Message[];
  systemPrompt?: string;
  toolsTokens?: number;
  maxMessages: number;
  contextWindow: number;
  maxOutput: number;
  mode?: AgentMode;
}): ContextReport {
  const window = Math.max(1024, params.contextWindow);
  const maxOutput = Math.max(0, params.maxOutput);
  const budget = Math.max(512, window - maxOutput - 256);
  const system = params.systemPrompt ? estimateTokens(params.systemPrompt) + 8 : 0;
  const tools = params.toolsTokens ?? 0;
  const full = normalizeHistory(params.history);
  const fullTokens = full.reduce((sum, message) => sum + messageTokens(message), 0);
  const capped = cappedHistory(full, params.maxMessages);
  const modeNotice =
    params.mode && lastHarnessMode(capped) !== params.mode
      ? harnessModeMessage(params.mode)
      : undefined;
  const kept = fitHistory(capped, system + tools, modeNotice ? messageTokens(modeNotice) : 0, budget);
  const messages =
    kept.reduce((sum, message) => sum + messageTokens(message), 0) +
    (modeNotice && lastHarnessMode(kept) !== params.mode ? messageTokens(modeNotice) : 0);
  const droppedCount = Math.max(0, full.length - kept.length);
  const droppedTokens = Math.max(0, fullTokens - messages);
  const used = system + tools + messages;
  const free = Math.max(0, window - used - maxOutput);

  const slices: ContextSlice[] = (
    [
      ["system", system],
      ["tools", tools],
      ["messages", messages],
      ["output", maxOutput],
      ["free", free],
    ] as const
  ).map(([key, tokens]) => ({
    key,
    label: SLICE_META[key].label,
    tokens,
    color: SLICE_META[key].color,
  }));

  return {
    window,
    maxOutput,
    budget,
    system,
    tools,
    messages,
    messageCount: full.length,
    keptCount: kept.length,
    droppedCount,
    droppedTokens,
    used,
    free,
    slices,
  };
}

export function formatContextReport(report: ContextReport, width = 40, color = true) {
  const barWidth = Math.max(16, Math.min(width, 56));
  const occupied = report.used + report.maxOutput;
  const total = Math.max(1, report.window, occupied);
  const counts = allocate(report.slices.map((slice) => slice.tokens), barWidth, total);
  const bar = report.slices
    .map((slice, i) => {
      const n = counts[i];
      if (n <= 0) return "";
      if (!color) return SLICE_META[slice.key].ascii.repeat(n);
      return `${slice.color}${" ".repeat(n)}\x1b[0m`;
    })
    .join("");
  const pct = ((report.used / Math.max(1, report.window)) * 100).toFixed(1);
  const over = occupied > report.window ? "    超出窗口" : "";
  const legend = report.slices
    .map((slice) => {
      const swatch = color
        ? `${slice.color}  \x1b[0m`
        : SLICE_META[slice.key].ascii;
      return `${swatch} ${slice.label.padEnd(8)} ${fmt(slice.tokens)}`;
    })
    .join("\n");
  const dropped =
    report.droppedCount > 0
      ? `\n发送时丢弃更早 ${report.droppedCount} 条（约 ${fmt(report.droppedTokens)} tokens）`
      : "";
  return [
    `上下文  ${fmt(report.used)} / ${fmt(report.window)}  ${pct}%    预算 ${fmt(report.budget)}${over}`,
    bar,
    legend,
    `对话 ${report.keptCount}/${report.messageCount} 条${dropped}`,
  ].join("\n");
}

function allocate(values: number[], width: number, total: number) {
  const raw = values.map((value) => (value / total) * width);
  const counts = raw.map((value) => Math.floor(value));
  let leftover = width - counts.reduce((sum, n) => sum + n, 0);
  const order = raw
    .map((value, i) => ({ i, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (const item of order) {
    if (leftover <= 0) break;
    if (values[item.i] <= 0) continue;
    counts[item.i] += 1;
    leftover -= 1;
  }
  if (leftover > 0) counts[counts.length - 1] += leftover;
  return counts;
}

function fmt(n: number) {
  return Math.round(n).toLocaleString("en-US");
}

export function previewMessages(history: Message[], limit = 8) {
  const normalized = normalizeHistory(history);
  const recent = normalized.slice(-limit);
  const skipped = normalized.length - recent.length;
  return { recent, skipped };
}

export function formatPreviewLine(message: Message, mode: AgentMode = "ask") {
  if (isHarnessModeMessage(message)) {
    const noticed = parseHarnessMode(message) ?? mode;
    return `${paintMode(noticed, `harness  ${modeLabel(noticed)}`)}  ${modeHint(noticed)}`;
  }
  if (isTaskStateMessage(message)) {
    const state = parseTaskStateMessage(message);
    const summary = state ? formatTaskStateSummary(state) : "（无法解析）";
    return `task  ${summary}`;
  }
  const prefix = assistantPrefix(mode);
  if (message.role === "user") return `${userPrefix(mode)}${message.content}`;
  if (message.role === "tool") return formatToolResultLines(message.content).join("\n");
  if (message.toolCalls?.length) {
    const calls = message.toolCalls
      .map((call) => formatToolCallLine(call.name, call.arguments))
      .join("\n");
    const text = message.content.trim();
    return text ? `${prefix}${text}\n${calls}` : calls;
  }
  return `${prefix}${message.content}`;
}
