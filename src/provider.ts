import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export function userSocodeDir() {
  const override = process.env.SOCODE_HOME?.trim();
  return override || join(homedir(), ".socode");
}

export function providerStorePath() {
  return join(userSocodeDir(), "providers.json");
}

function legacyProviderStorePath() {
  return resolve(process.cwd(), "providers.json");
}

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
  if (store?.providers.length) {
    const saved =
      store.providers.find((item) => item.name === store.active) ?? store.providers[0];
    if (saved) {
      const normalized = normalizeProvider(saved);
      applyToProcessEnv(normalized);
      return normalized;
    }
  }
  return emptyProvider();
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
  writeStore(store);
  applyToProcessEnv(normalized);
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

export function importProviderFromValues(values: Record<string, string>) {
  if (existsSync(providerStorePath())) return loadProvider();
  const effort = (values.THINKING_EFFORT ?? "").trim().toLowerCase();
  const provider = normalizeProvider({
    name: values.PROVIDER_NAME?.trim() || "",
    url: values.BASE_URL ?? values.LLM_URL ?? "",
    api: values.api_key ?? values.LLM_API ?? "",
    model: values.MODEL ?? values.LLM_MODEL ?? "",
    contextWindow: numberOr(values.CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW),
    maxOutput: numberOr(values.MAX_OUTPUT, DEFAULT_MAX_OUTPUT),
    thinkingEffort: isThinkingEffort(effort) ? effort : DEFAULT_THINKING_EFFORT,
  });
  if (!providerReady(provider) || !provider.name) return null;
  return saveProvider(provider);
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
  const path = providerStorePath();
  if (existsSync(path)) return parseStoreFile(path);
  const legacy = legacyProviderStorePath();
  if (!existsSync(legacy)) return null;
  const migrated = parseStoreFile(legacy);
  if (!migrated) return null;
  writeStore(migrated);
  return migrated;
}

function writeStore(store: ProviderStore) {
  mkdirSync(userSocodeDir(), { recursive: true });
  writeFileSync(providerStorePath(), `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function parseStoreFile(path: string): ProviderStore | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as ProviderStore;
    if (!data || !Array.isArray(data.providers)) return null;
    return {
      active: typeof data.active === "string" ? data.active : data.providers[0]?.name ?? "",
      providers: data.providers,
    };
  } catch {
    return null;
  }
}

function applyToProcessEnv(provider: Provider) {
  process.env.PROVIDER_NAME = provider.name;
  process.env.BASE_URL = provider.url;
  process.env.LLM_URL = provider.url;
  process.env.api_key = provider.api;
  process.env.LLM_API = provider.api;
  process.env.OPENAI_API_KEY = provider.api;
  process.env.MODEL = provider.model;
  process.env.LLM_MODEL = provider.model;
  process.env.CONTEXT_WINDOW = String(provider.contextWindow);
  process.env.MAX_OUTPUT = String(provider.maxOutput);
  process.env.THINKING_EFFORT = provider.thinkingEffort;
}
