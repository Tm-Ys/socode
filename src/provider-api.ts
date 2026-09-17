import {
  DEFAULT_THINKING_EFFORT,
  isThinkingEffort,
  openaiBaseUrl,
  THINKING_EFFORTS,
  type Provider,
  type ThinkingEffort,
} from "./provider.js";

export type ModelCatalog = {
  models: string[];
  efforts: ThinkingEffort[];
  apiEffort?: ThinkingEffort;
  source: "api" | "fallback";
};

export type ModelPickState = {
  providers: Provider[];
  providerIndex: number;
  modelIndex: number;
};

const FETCH_MS = 8000;

export function modelsUrl(base: string) {
  return `${openaiBaseUrl(base)}/models`;
}

export function parseModelCatalog(raw: unknown, currentModel: string): ModelCatalog {
  const models: string[] = [];
  const current = findModelRecord(raw, currentModel);
  collectModelIds(raw, models);
  const efforts = uniqueEfforts([
    ...readEfforts(current),
    ...readEfforts(raw),
  ]);
  const apiEffort = readEffort(current) ?? readEffort(raw);
  return {
    models,
    efforts: efforts.length ? efforts : [...THINKING_EFFORTS],
    apiEffort,
    source: current || models.length || efforts.length || apiEffort ? "api" : "fallback",
  };
}

export async function fetchModelCatalog(provider: Provider, signal?: AbortSignal): Promise<ModelCatalog> {
  if (!provider.url || !provider.api) {
    return { models: provider.model ? [provider.model] : [], efforts: [...THINKING_EFFORTS], source: "fallback" };
  }
  const timeout = AbortSignal.timeout(FETCH_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch(modelsUrl(provider.url), {
      headers: {
        Authorization: `Bearer ${provider.api}`,
      },
      signal: combined,
    });
    if (!response.ok) {
      return {
        models: provider.model ? [provider.model] : [],
        efforts: [...THINKING_EFFORTS],
        source: "fallback",
      };
    }
    const json: unknown = await response.json();
    return parseModelCatalog(json, provider.model);
  } catch {
    return {
      models: provider.model ? [provider.model] : [],
      efforts: [...THINKING_EFFORTS],
      source: "fallback",
    };
  }
}

export function modelsForProvider(selected: Provider, all: Provider[]) {
  const models: string[] = [];
  for (const item of all) {
    if (item.url !== selected.url) continue;
    if (item.model && !models.includes(item.model)) models.push(item.model);
  }
  if (selected.model && !models.includes(selected.model)) models.unshift(selected.model);
  return models.length ? models : selected.model ? [selected.model] : [];
}

export function createModelPickState(providers: Provider[], current: Provider): ModelPickState {
  const rows = providers.length ? providers : [current];
  let providerIndex = rows.findIndex((item) => item.name === current.name);
  if (providerIndex < 0) providerIndex = 0;
  const selected = rows[providerIndex] ?? current;
  const models = modelsForProvider(selected, rows);
  let modelIndex = models.indexOf(selected.model);
  if (modelIndex < 0) modelIndex = 0;
  return { providers: rows, providerIndex, modelIndex };
}

export function currentModelPick(state: ModelPickState) {
  const provider = state.providers[state.providerIndex] ?? state.providers[0];
  const models = provider ? modelsForProvider(provider, state.providers) : [];
  const model = models[state.modelIndex] ?? provider?.model ?? "";
  return { provider, model, models };
}

export function applyModelPickKey(state: ModelPickState, raw: string) {
  const key = raw === "\r\n" || raw === "\n" ? "\r" : raw;
  if (key === "\x1b" || key === "\x1b\x1b") return { type: "cancel" as const };
  if (key === "\r") return { type: "submit" as const, ...currentModelPick(state) };
  if (key === "\x1b[C" || key === "l") return { type: "state" as const, state: shiftProvider(state, 1) };
  if (key === "\x1b[D" || key === "h") return { type: "state" as const, state: shiftProvider(state, -1) };
  if (key === "\x1b[B" || key === "j") return { type: "state" as const, state: shiftModel(state, 1) };
  if (key === "\x1b[A" || key === "k") return { type: "state" as const, state: shiftModel(state, -1) };
  return { type: "state" as const, state };
}

export function applyProviderListKey(selected: number, total: number, raw: string) {
  const key = raw === "\r\n" || raw === "\n" ? "\r" : raw;
  if (key === "\x1b" || key === "\x1b\x1b") return { type: "cancel" as const };
  if (key === "\r") return { type: "switch" as const };
  if (key === "e" || key === "E") return { type: "edit" as const };
  if (key === "n" || key === "N") return { type: "new" as const };
  if (key === "\x1b[B" || key === "j" || key === "\x1b[C" || key === "l") {
    return { type: "index" as const, index: wrapIndex(selected + 1, Math.max(1, total)) };
  }
  if (key === "\x1b[A" || key === "k" || key === "\x1b[D" || key === "h") {
    return { type: "index" as const, index: wrapIndex(selected - 1, Math.max(1, total)) };
  }
  const digit = /^[1-9]$/.exec(key);
  if (digit) {
    const index = Number(digit[0]) - 1;
    if (index < total) return { type: "index" as const, index };
  }
  return { type: "index" as const, index: selected };
}

export function applyEffortKey(selected: number, total: number, raw: string) {
  const key = raw === "\r\n" || raw === "\n" ? "\r" : raw;
  if (key === "\x1b" || key === "\x1b\x1b") return { type: "cancel" as const };
  if (key === "\r") return { type: "submit" as const };
  if (key === "\x1b[C" || key === "\x1b[B" || key === "l" || key === "j") {
    return { type: "index" as const, index: wrapIndex(selected + 1, total) };
  }
  if (key === "\x1b[D" || key === "\x1b[A" || key === "h" || key === "k") {
    return { type: "index" as const, index: wrapIndex(selected - 1, total) };
  }
  const digit = /^[1-9]$/.exec(key);
  if (digit) {
    const index = Number(digit[0]) - 1;
    if (index < total) return { type: "index" as const, index };
  }
  return { type: "index" as const, index: selected };
}

export function defaultEffortIndex(efforts: ThinkingEffort[], current?: string) {
  const fromCurrent = current && isThinkingEffort(current) ? efforts.indexOf(current) : -1;
  if (fromCurrent >= 0) return fromCurrent;
  const medium = efforts.indexOf(DEFAULT_THINKING_EFFORT);
  return medium >= 0 ? medium : 0;
}

function shiftProvider(state: ModelPickState, delta: number): ModelPickState {
  const providerIndex = wrapIndex(state.providerIndex + delta, state.providers.length);
  const provider = state.providers[providerIndex];
  if (!provider) return { ...state, providerIndex };
  const models = modelsForProvider(provider, state.providers);
  let modelIndex = models.indexOf(provider.model);
  if (modelIndex < 0) modelIndex = 0;
  return { providers: state.providers, providerIndex, modelIndex };
}

function shiftModel(state: ModelPickState, delta: number): ModelPickState {
  const provider = state.providers[state.providerIndex];
  if (!provider) return state;
  const models = modelsForProvider(provider, state.providers);
  if (!models.length) return state;
  return { ...state, modelIndex: wrapIndex(state.modelIndex + delta, models.length) };
}

function wrapIndex(index: number, total: number) {
  if (total <= 0) return 0;
  return (index + total) % total;
}

function findModelRecord(raw: unknown, currentModel: string): unknown {
  if (!currentModel) return undefined;
  const rows = modelRows(raw);
  return rows.find((row) => idOf(row) === currentModel) ?? rows.find((row) => idOf(row).endsWith(`/${currentModel}`));
}

function collectModelIds(raw: unknown, out: string[]) {
  for (const row of modelRows(raw)) {
    const id = idOf(row);
    if (id && !out.includes(id)) out.push(id);
  }
}

function modelRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.models)) return record.models;
  if (typeof record.id === "string") return [record];
  return [];
}

function idOf(row: unknown) {
  if (!row || typeof row !== "object") return "";
  const id = (row as Record<string, unknown>).id;
  return typeof id === "string" ? id : "";
}

function readEffort(raw: unknown): ThinkingEffort | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  for (const key of ["reasoning_effort", "default_reasoning_effort", "thinking_effort", "effort"]) {
    const value = record[key];
    if (typeof value === "string" && isThinkingEffort(value)) return value;
  }
  const reasoning = record.reasoning;
  if (reasoning && typeof reasoning === "object") {
    const effort = (reasoning as Record<string, unknown>).effort;
    if (typeof effort === "string" && isThinkingEffort(effort)) return effort;
  }
  return undefined;
}

function readEfforts(raw: unknown): ThinkingEffort[] {
  if (!raw) return [];
  if (typeof raw === "string" && isThinkingEffort(raw)) return [raw];
  if (Array.isArray(raw)) return uniqueEfforts(raw.flatMap((item) => readEfforts(item)));
  if (typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const buckets: unknown[] = [
    record.supported_reasoning_efforts,
    record.reasoning_efforts,
    record.thinking_efforts,
  ];
  if (record.reasoning && typeof record.reasoning === "object") {
    const nested = record.reasoning as Record<string, unknown>;
    buckets.push(nested.supported_efforts, nested.efforts, nested.effort);
  }
  const found = uniqueEfforts(buckets.flatMap((item) => readEfforts(item)));
  const single = readEffort(raw);
  return single ? uniqueEfforts([...found, single]) : found;
}

function uniqueEfforts(values: ThinkingEffort[]) {
  return THINKING_EFFORTS.filter((item) => values.includes(item));
}
