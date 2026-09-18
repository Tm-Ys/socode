import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelPrice } from "./usage.js";
import { lookupModelPrice } from "./usage.js";

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_OUTPUT = 8192;
export const THINKING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "medium";

export type ProviderPricing = {
  /** 人民币 / 百万 token */
  input: number;
  cacheInput?: number;
  output: number;
};

export const LLM_ROLES = ["main", "subagent", "title", "recap", "approve", "compress"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export const AUX_LLM_ROLES = ["subagent", "title", "recap", "approve", "compress"] as const;
export type AuxLlmRole = (typeof AUX_LLM_ROLES)[number];

export type RoleLlm = {
  model?: string;
  pricing?: ProviderPricing;
};

export type ProviderLlms = Partial<Record<AuxLlmRole, RoleLlm>>;

export type Provider = {
  name: string;
  url: string;
  api: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  thinkingEffort: ThinkingEffort;
  pricing?: ProviderPricing;
  llms?: ProviderLlms;
};

export type ProviderStore = {
  active: string;
  providers: Provider[];
};

export function userSocodeDir() {
  const override = process.env.SOCODE_HOME?.trim();
  return override || join(homedir(), ".socode");
}

export function providerStorePath() {
  const override = process.env.SOCODE_PROVIDER_STORE?.trim();
  if (override) return override;
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

export type RoleLlmDraft = {
  model?: string;
  inputPrice?: string;
  cacheInputPrice?: string;
  outputPrice?: string;
};

export type ProviderDraft = {
  name: string;
  url: string;
  api: string;
  model: string;
  contextWindow: string;
  maxOutput: string;
  thinkingEffort: string;
  inputPrice?: string;
  cacheInputPrice?: string;
  outputPrice?: string;
  subagent?: RoleLlmDraft;
  title?: RoleLlmDraft;
  recap?: RoleLlmDraft;
  approve?: RoleLlmDraft;
  compress?: RoleLlmDraft;
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
  const pricing = parseProviderPricing(
    {
      input: draft.inputPrice,
      cacheInput: draft.cacheInputPrice,
      output: draft.outputPrice,
    },
    fallback?.pricing,
  );
  return normalizeProvider({
    name: draft.name,
    url: draft.url,
    api: draft.api,
    model: draft.model,
    contextWindow: numberOr(contextRaw, fallback?.contextWindow || DEFAULT_CONTEXT_WINDOW),
    maxOutput: numberOr(outputRaw, fallback?.maxOutput || DEFAULT_MAX_OUTPUT),
    thinkingEffort: isThinkingEffort(effortRaw) ? effortRaw : (fallback?.thinkingEffort ?? DEFAULT_THINKING_EFFORT),
    pricing,
    llms: {
      subagent: parseRoleSlot(draft.subagent, fallback?.llms?.subagent),
      title: parseRoleSlot(draft.title, fallback?.llms?.title),
      recap: parseRoleSlot(draft.recap, fallback?.llms?.recap),
      approve: parseRoleSlot(draft.approve, fallback?.llms?.approve),
      compress: parseRoleSlot(draft.compress, fallback?.llms?.compress),
    },
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
    `主模型: ${provider.model}`,
    `上下文窗口: ${provider.contextWindow}`,
    `最大输出: ${provider.maxOutput}`,
    `思考强度: ${provider.thinkingEffort}`,
    `主定价: ${formatProviderPricing(provider.pricing)}`,
    ...AUX_LLM_ROLES.map((role) => formatRoleLine(provider, role)),
  ].join("\n");
}

function formatRoleLine(provider: Provider, role: AuxLlmRole) {
  const own = provider.llms?.[role];
  const resolved = providerForRole(provider, role);
  if (own?.model?.trim()) {
    const pricing = own.pricing ? formatProviderPricing(own.pricing) : "models.dev（人民币 / 百万 token）";
    return `${roleLabel(role)}: ${own.model.trim()}  ${pricing}`;
  }
  const inherited = role === "approve" ? inheritLabel(provider, "recap") : `同主模型（${provider.model}）`;
  const pricing = own?.pricing ? formatProviderPricing(own.pricing) : formatProviderPricing(resolved.pricing);
  return `${roleLabel(role)}: ${inherited}  ${pricing}`;
}

function inheritLabel(provider: Provider, role: AuxLlmRole) {
  const model = provider.llms?.[role]?.model?.trim();
  if (model) return `同${roleLabel(role)}（${model}）`;
  return `同主模型（${provider.model}）`;
}

export function roleLabel(role: LlmRole) {
  if (role === "main") return "主模型";
  if (role === "subagent") return "子代理";
  if (role === "title") return "标题";
  if (role === "recap") return "Recap";
  if (role === "approve") return "审批";
  return "压缩";
}

/** 空角色用主模型；审批空则用 Recap，再空才用主模型。没自设单价时，模型若仍是回落模型则跟其定价，否则走 models.dev。 */
export function providerForRole(provider: Provider, role: LlmRole): Provider {
  const resolved = resolveRole(provider, role);
  return { ...provider, model: resolved.model, pricing: resolved.pricing };
}

function resolveRole(provider: Provider, role: LlmRole): { model: string; pricing?: ProviderPricing } {
  if (role === "main") return { model: provider.model, pricing: provider.pricing };
  const slot = provider.llms?.[role as AuxLlmRole];
  const parent = role === "approve" ? resolveRole(provider, "recap") : { model: provider.model, pricing: provider.pricing };
  const model = slot?.model?.trim() || parent.model;
  const pricing = slot?.pricing ?? (model === parent.model ? parent.pricing : undefined);
  return { model, pricing };
}

export function formatProviderPricing(pricing?: ProviderPricing) {
  if (!pricing) return "models.dev（人民币 / 百万 token）";
  const cache = pricing.cacheInput !== undefined ? ` / 缓存入 ${pricing.cacheInput}` : "";
  return `自设 入 ${pricing.input}${cache} / 出 ${pricing.output}  元/百万token`;
}

export function providerModelPrice(provider: Provider): ModelPrice | undefined {
  if (!provider.pricing) return undefined;
  return lookupModelPrice("own", {
    own: {
      input: provider.pricing.input,
      output: provider.pricing.output,
      cacheRead: provider.pricing.cacheInput,
    },
  });
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
  const llms = normalizeLlms(input.llms);
  return {
    name,
    url: input.url.trim(),
    api: input.api.trim(),
    model: input.model.trim(),
    contextWindow: Math.max(1024, Math.floor(input.contextWindow || DEFAULT_CONTEXT_WINDOW)),
    maxOutput: Math.max(16, Math.floor(input.maxOutput || DEFAULT_MAX_OUTPUT)),
    thinkingEffort: thinking,
    ...(normalizeSavedPricing(input.pricing) ? { pricing: normalizeSavedPricing(input.pricing) } : {}),
    ...(llms ? { llms } : {}),
  };
}

function parseRoleSlot(draft: RoleLlmDraft | undefined, fallback?: RoleLlm): RoleLlm | undefined {
  if (!draft) return normalizeRoleLlm(fallback);
  const model = parseOptionalModel(draft.model, fallback?.model);
  const pricing = parseProviderPricing(
    {
      input: draft.inputPrice,
      cacheInput: draft.cacheInputPrice,
      output: draft.outputPrice,
    },
    fallback?.pricing,
  );
  return normalizeRoleLlm({ model, pricing });
}

function parseOptionalModel(raw: string | undefined, fallback?: string) {
  if (raw === undefined) return fallback ?? "";
  const text = raw.trim();
  if (!text) return fallback ?? "";
  if (text === "-" || text.toLowerCase() === "auto") return "";
  return text;
}

function normalizeLlms(input?: ProviderLlms): ProviderLlms | undefined {
  if (!input) return undefined;
  const llms: ProviderLlms = {};
  for (const role of AUX_LLM_ROLES) {
    const slot = normalizeRoleLlm(input[role]);
    if (slot) llms[role] = slot;
  }
  return Object.keys(llms).length ? llms : undefined;
}

function normalizeRoleLlm(slot?: RoleLlm): RoleLlm | undefined {
  if (!slot || typeof slot !== "object") return undefined;
  const model = slot.model?.trim() ?? "";
  const pricing = normalizeSavedPricing(slot.pricing);
  if (!model && !pricing) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

function parseProviderPricing(
  fields: { input?: string; cacheInput?: string; output?: string },
  fallback?: ProviderPricing,
): ProviderPricing | undefined {
  const input = parseYuanField(fields.input, fallback?.input);
  const output = parseYuanField(fields.output, fallback?.output);
  const cacheInput = parseYuanField(fields.cacheInput, fallback?.cacheInput);
  if (input === undefined && output === undefined) return undefined;
  if (input === undefined || output === undefined) {
    throw new Error("自设定价需要同时填输入和输出（人民币 / 百万 token）；缓存输入可空。用 - 表示跟 models.dev");
  }
  return {
    input,
    output,
    ...(cacheInput !== undefined ? { cacheInput } : {}),
  };
}

function parseYuanField(raw: string | undefined, fallback?: number) {
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  if (text === "-" || text.toLowerCase() === "auto") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error("单价必须是 ≥ 0 的数字，单位是人民币 / 百万 token");
  return n;
}

function normalizeSavedPricing(pricing?: ProviderPricing): ProviderPricing | undefined {
  if (!pricing || typeof pricing !== "object") return undefined;
  if (!Number.isFinite(pricing.input) || pricing.input < 0) return undefined;
  if (!Number.isFinite(pricing.output) || pricing.output < 0) return undefined;
  return {
    input: pricing.input,
    output: pricing.output,
    ...(pricing.cacheInput !== undefined && pricing.cacheInput >= 0 ? { cacheInput: pricing.cacheInput } : {}),
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
  if (!shouldMigrateLegacyCwdStore()) return null;
  const legacy = legacyProviderStorePath();
  if (!existsSync(legacy)) return null;
  const migrated = parseStoreFile(legacy);
  if (!migrated) return null;
  writeStore(migrated);
  return migrated;
}

function shouldMigrateLegacyCwdStore() {
  if (process.env.SOCODE_PROVIDER_STORE?.trim()) return false;
  if (process.env.SOCODE_HOME?.trim()) return false;
  return true;
}

function writeStore(store: ProviderStore) {
  const path = providerStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

export function dumpProviderStore(dir?: string): ProviderStore | null {
  const store = dir ? parseStoreFile(join(dir, "providers.json")) : readStore();
  if (!store?.providers.length) return null;
  return {
    active: store.active,
    providers: store.providers.map((item) => normalizeProvider(item)),
  };
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
