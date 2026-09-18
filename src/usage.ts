import { compactTokens } from "./context.js";

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  promptIncludesCache?: boolean;
};

/** 人民币 / 百万 token。展示用；models.dev 的美元价会先按汇率换算。 */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export function emptyTokenUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    promptIncludesCache: false,
  };
}

export function addTokenUsage(total: TokenUsage, next?: TokenUsage) {
  if (!next) return;
  total.promptTokens += next.promptTokens;
  total.completionTokens += next.completionTokens;
  total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0);
  total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0);
  total.reasoningTokens = (total.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0);
  total.promptIncludesCache = Boolean(total.promptIncludesCache || next.promptIncludesCache);
}

export function usageHasTokens(usage?: TokenUsage): usage is TokenUsage {
  if (!usage) return false;
  return (
    usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    (usage.cacheReadTokens ?? 0) > 0 ||
    (usage.cacheWriteTokens ?? 0) > 0 ||
    (usage.reasoningTokens ?? 0) > 0
  );
}

export function parseTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const details = asRecord(row.prompt_tokens_details);
  const completionDetails = asRecord(row.completion_tokens_details);
  const promptTokens = num(
    row.prompt_tokens ?? row.input_tokens ?? row.promptTokens ?? row.inputTokens,
  );
  const completionTokens = num(
    row.completion_tokens ?? row.output_tokens ?? row.completionTokens ?? row.outputTokens,
  );
  const cacheReadTokens = num(
    details?.cached_tokens ??
      details?.cachedTokens ??
      row.prompt_cache_hit_tokens ??
      row.cache_read_input_tokens ??
      row.cacheReadInputTokens ??
      row.cached_tokens,
  );
  const cacheWriteTokens = num(
    row.cache_creation_input_tokens ??
      row.cacheWriteInputTokens ??
      details?.cache_write_tokens ??
      details?.cache_creation_input_tokens,
  );
  const reasoningTokens = num(
    completionDetails?.reasoning_tokens ??
      completionDetails?.reasoningTokens ??
      row.reasoning_tokens ??
      row.completion_reason_tokens,
  );
  if (
    promptTokens <= 0 &&
    completionTokens <= 0 &&
    cacheReadTokens <= 0 &&
    cacheWriteTokens <= 0 &&
    reasoningTokens <= 0
  ) {
    return undefined;
  }
  const anthropicCache = "cache_read_input_tokens" in row || "cache_creation_input_tokens" in row;
  return {
    promptTokens: Math.max(0, promptTokens),
    completionTokens: Math.max(0, completionTokens),
    cacheReadTokens: Math.max(0, cacheReadTokens),
    cacheWriteTokens: Math.max(0, cacheWriteTokens),
    reasoningTokens: Math.max(0, reasoningTokens),
    promptIncludesCache: cacheReadTokens > 0 && cacheReadTokens <= promptTokens && !anthropicCache,
  };
}

export function lookupModelPrice(model: string, pricing: Record<string, ModelPrice> | undefined) {
  if (!pricing) return undefined;
  const exact = pricing[model];
  if (exact) return normalizePrice(exact);
  const lower = model.toLowerCase();
  for (const [key, value] of Object.entries(pricing)) {
    if (key.toLowerCase() === lower) return normalizePrice(value);
  }
  return undefined;
}

export function estimateUsageCny(usage: TokenUsage, price?: ModelPrice) {
  if (!price) return undefined;
  const cached = usage.cacheReadTokens ?? 0;
  const created = usage.cacheWriteTokens ?? 0;
  const uncached = usage.promptIncludesCache
    ? Math.max(0, usage.promptTokens - cached)
    : usage.promptTokens;
  const input = uncached * price.input;
  const output = usage.completionTokens * price.output;
  const cacheRead = cached * (price.cacheRead ?? price.input);
  const cacheWrite = created * (price.cacheWrite ?? price.input);
  const cny = (input + output + cacheRead + cacheWrite) / 1_000_000;
  if (!Number.isFinite(cny) || cny < 0) return undefined;
  return cny;
}

/** @deprecated 金额已改为人民币，请用 estimateUsageCny */
export const estimateUsageUsd = estimateUsageCny;

export function formatUsageLine(
  usage: TokenUsage,
  opts?: { price?: ModelPrice; cny?: number; session?: TokenUsage; sessionCny?: number; color?: boolean },
) {
  const parts = [
    `入 ${compactTokens(usage.promptTokens)}`,
    usage.cacheReadTokens ? `缓存 ${compactTokens(usage.cacheReadTokens)}` : "",
    usage.cacheWriteTokens ? `写缓存 ${compactTokens(usage.cacheWriteTokens)}` : "",
    `出 ${compactTokens(usage.completionTokens)}`,
    usage.reasoningTokens ? `思考 ${compactTokens(usage.reasoningTokens)}` : "",
  ].filter(Boolean);
  const cny = opts?.cny !== undefined ? opts.cny : estimateUsageCny(usage, opts?.price);
  if (cny !== undefined) parts.push(formatCny(cny));
  else if (opts?.price === undefined) parts.push("未标价");
  const line = `tokens  ${parts.join("  ")}`;
  const dim = opts?.color ? "\x1b[2m" : "";
  const reset = opts?.color ? "\x1b[0m" : "";
  return `${dim}${line}${reset}`;
}

export function formatSessionUsage(usage: TokenUsage, cny?: number, color = false) {
  const parts = [
    `入 ${compactTokens(usage.promptTokens)}`,
    usage.cacheReadTokens ? `缓存 ${compactTokens(usage.cacheReadTokens)}` : "",
    usage.cacheWriteTokens ? `写缓存 ${compactTokens(usage.cacheWriteTokens)}` : "",
    `出 ${compactTokens(usage.completionTokens)}`,
    cny !== undefined ? `累计 ${formatCny(cny)}` : "",
  ].filter(Boolean);
  const dim = color ? "\x1b[2m" : "";
  const reset = color ? "\x1b[0m" : "";
  return `${dim}本会话  ${parts.join("  ")}${reset}`;
}

export function formatCny(amount: number) {
  if (amount > 0 && amount < 0.0001) return "<¥0.0001";
  if (amount < 0.01) return `¥${amount.toFixed(4)}`;
  if (amount < 1) return `¥${amount.toFixed(3)}`;
  return `¥${amount.toFixed(2)}`;
}

function normalizePrice(price: ModelPrice): ModelPrice | undefined {
  if (!Number.isFinite(price.input) || price.input < 0) return undefined;
  if (!Number.isFinite(price.output) || price.output < 0) return undefined;
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead !== undefined && price.cacheRead >= 0 ? price.cacheRead : undefined,
    cacheWrite: price.cacheWrite !== undefined && price.cacheWrite >= 0 ? price.cacheWrite : undefined,
  };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function num(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
