import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_OUTPUT = 8192;
export const THINKING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "medium";

export type Provider = {
  name: string;
  url: string;
  api: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  thinkingEffort: ThinkingEffort;
};

type ProviderStore = {
  active: string;
  providers: Provider[];
};

const STORE_PATH = resolve(process.cwd(), "providers.json");
const ENV_PATH = resolve(process.cwd(), ".env");

export function chatCompletionsUrl(base: string) {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

export function openaiBaseUrl(base: string) {
  return chatCompletionsUrl(base).replace(/\/chat\/completions$/, "");
}

export function isThinkingEffort(value: string): value is ThinkingEffort {
  return (THINKING_EFFORTS as readonly string[]).includes(value);
}

export function loadProvider(): Provider {
  const store = readStore();
  const fromEnv = providerFromEnv();
  const wanted = process.env.PROVIDER_NAME?.trim() || store?.active || fromEnv.name;
  const saved = wanted ? store?.providers.find((item) => item.name === wanted) : undefined;
  if (saved) return normalizeProvider(saved);
  return normalizeProvider({
    name: fromEnv.name || wanted || "default",
    url: fromEnv.url || "",
    api: fromEnv.api || "",
    model: fromEnv.model || "",
    contextWindow: fromEnv.contextWindow || DEFAULT_CONTEXT_WINDOW,
    maxOutput: fromEnv.maxOutput || DEFAULT_MAX_OUTPUT,
    thinkingEffort: fromEnv.thinkingEffort || DEFAULT_THINKING_EFFORT,
  });
}

export function listProviders(current?: Provider): Provider[] {
  const store = readStore();
  const active = current ?? loadProvider();
  const seen = new Set<string>();
  const rows: Provider[] = [];
  for (const item of [active, ...(store?.providers ?? [])]) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    rows.push(item);
  }
  return rows;
}

export type ProviderDraft = {
  name: string;
  url: string;
  api: string;
  model: string;
  contextWindow: string;
  maxOutput: string;
  thinkingEffort: string;
};

export function emptyProvider(): Provider {
  return {
    name: "",
    url: "",
    api: "",
    model: "",
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutput: DEFAULT_MAX_OUTPUT,
    thinkingEffort: DEFAULT_THINKING_EFFORT,
  };
}

export function providerReady(provider: Provider) {
  return Boolean(provider.url && provider.api && provider.model);
}

export function resolveFieldInput(raw: string, current = "", required = false) {
  const value = raw.trim();
  if (value) return { ok: true as const, value };
  if (current || !required) return { ok: true as const, value: current };
  return { ok: false as const };
}

export function findProvider(name: string, current?: Provider) {
  const key = name.trim();
  if (!key) return undefined;
  return listProviders(current).find((item) => item.name === key);
}

export function hasSavedProvider(name: string) {
  const key = name.trim();
  if (!key) return false;
  return Boolean(readStore()?.providers.some((item) => item.name === key));
}

export function applyProviderDraft(draft: ProviderDraft, fallback?: Provider): Provider {
  const contextRaw = draft.contextWindow.trim();
  const outputRaw = draft.maxOutput.trim();
  const effortRaw = draft.thinkingEffort.trim().toLowerCase();
  if (contextRaw && (!Number.isFinite(Number(contextRaw)) || Number(contextRaw) <= 0)) {
    throw new Error("上下文窗口必须是正数");
  }
  if (outputRaw && (!Number.isFinite(Number(outputRaw)) || Number(outputRaw) <= 0)) {
    throw new Error("最大输出必须是正数");
  }
  if (effortRaw && !isThinkingEffort(effortRaw)) {
    throw new Error("思考强度必须是 none | minimal | low | medium | high | xhigh");
  }
  return normalizeProvider({
    name: draft.name,
    url: draft.url,
    api: draft.api,
    model: draft.model,
    contextWindow: numberOr(contextRaw, fallback?.contextWindow || DEFAULT_CONTEXT_WINDOW),
    maxOutput: numberOr(outputRaw, fallback?.maxOutput || DEFAULT_MAX_OUTPUT),
    thinkingEffort: isThinkingEffort(effortRaw) ? effortRaw : (fallback?.thinkingEffort ?? DEFAULT_THINKING_EFFORT),
  });
}

export function saveProvider(provider: Provider, opts?: { replaceName?: string }) {
  const normalized = requireComplete(normalizeProvider(provider));
  const store = readStore() ?? { active: normalized.name, providers: [] };
  const from = opts?.replaceName?.trim();
  if (from && from !== normalized.name) {
    if (store.providers.some((item) => item.name === normalized.name)) {
      throw new Error(`已有同名 Provider: ${normalized.name}。换个名字，或先 /provider ${normalized.name} 再 /provider edit`);
    }
    store.providers = store.providers.filter((item) => item.name !== from);
  }
  const index = store.providers.findIndex((item) => item.name === normalized.name);
  if (index >= 0) store.providers[index] = normalized;
  else store.providers.push(normalized);
  store.active = normalized.name;
  writeFileSync(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  applyToProcessEnv(normalized);
  writeEnv({
    PROVIDER_NAME: normalized.name,
    BASE_URL: normalized.url.replace(/\/chat\/completions$/, ""),
    api_key: normalized.api,
    MODEL: normalized.model,
    CONTEXT_WINDOW: String(normalized.contextWindow),
    MAX_OUTPUT: String(normalized.maxOutput),
    THINKING_EFFORT: normalized.thinkingEffort,
  });
  return normalized;
}

export function addProvider(provider: Provider) {
  const normalized = requireComplete(normalizeProvider(provider));
  if (hasSavedProvider(normalized.name)) {
    throw new Error(`已有同名 Provider: ${normalized.name}。换个名字，或先 /provider ${normalized.name} 再 /provider edit`);
  }
  return saveProvider(normalized);
}

export function switchProvider(name: string) {
  const store = readStore();
  const found = store?.providers.find((item) => item.name === name);
  if (!found) throw new Error(`找不到 Provider: ${name}`);
  return saveProvider(found);
}

export function formatProvider(provider: Provider, maskKey = true) {
  const key = maskKey ? maskApiKey(provider.api) : provider.api;
  return [
    `Provider: ${provider.name}`,
    `API URL: ${provider.url}`,
    `API: ${key}`,
    `模型: ${provider.model}`,
    `上下文窗口: ${provider.contextWindow}`,
    `最大输出: ${provider.maxOutput}`,
    `思考强度: ${provider.thinkingEffort}`,
  ].join("\n");
}

export function maskApiKey(api: string) {
  if (api.length <= 8) return "****";
  return `${api.slice(0, 4)}...${api.slice(-4)}`;
}

function applyToProcessEnv(provider: Provider) {
  process.env.PROVIDER_NAME = provider.name;
  process.env.BASE_URL = provider.url.replace(/\/chat\/completions$/, "");
  process.env.api_key = provider.api;
  process.env.MODEL = provider.model;
  process.env.CONTEXT_WINDOW = String(provider.contextWindow);
  process.env.MAX_OUTPUT = String(provider.maxOutput);
  process.env.THINKING_EFFORT = provider.thinkingEffort;
}

function providerFromEnv(): Partial<Provider> {
  const effort = (process.env.THINKING_EFFORT ?? "").trim().toLowerCase();
  return {
    name: process.env.PROVIDER_NAME?.trim() || "",
    url: process.env.BASE_URL ?? process.env.LLM_URL ?? "",
    api: process.env.api_key ?? process.env.LLM_API ?? "",
    model: process.env.MODEL ?? process.env.LLM_MODEL ?? "",
    contextWindow: numberOr(process.env.CONTEXT_WINDOW, 0),
    maxOutput: numberOr(process.env.MAX_OUTPUT, 0),
    thinkingEffort: isThinkingEffort(effort) ? effort : undefined,
  };
}

function requireComplete(provider: Provider) {
  if (!provider.name || !provider.url || !provider.api || !provider.model) {
    throw new Error("Provider 需要名称、API URL、API Key、模型");
  }
  return provider;
}

function normalizeProvider(input: Provider): Provider {
  const rawName = input.name.trim();
  const name =
    (rawName && rawName !== "default" ? rawName : "") || hostnameName(input.url) || "default";
  const thinking = isThinkingEffort(input.thinkingEffort) ? input.thinkingEffort : DEFAULT_THINKING_EFFORT;
  return {
    name,
    url: input.url.trim(),
    api: input.api.trim(),
    model: input.model.trim(),
    contextWindow: Math.max(1024, Math.floor(input.contextWindow || DEFAULT_CONTEXT_WINDOW)),
    maxOutput: Math.max(16, Math.floor(input.maxOutput || DEFAULT_MAX_OUTPUT)),
    thinkingEffort: thinking,
  };
}

function hostnameName(url: string) {
  try {
    const host = new URL(url).hostname.replace(/^api\./, "");
    return host.split(".")[0] || "";
  } catch {
    return "";
  }
}

function numberOr(value: string | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readStore(): ProviderStore | null {
  if (!existsSync(STORE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8")) as ProviderStore;
  } catch {
    return null;
  }
}

function writeEnv(updates: Record<string, string>) {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const lines = existing.split("\n");
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return line;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${quoteEnv(updates[key])}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push(`${key}=${quoteEnv(value)}`);
  }
  writeFileSync(ENV_PATH, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

function quoteEnv(value: string) {
  if (/[\s#"']/.test(value)) return `"${value.replaceAll('"', '\\"')}"`;
  return value;
}
