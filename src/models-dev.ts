import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userSocodeDir } from "./provider.js";
import type { ModelPrice } from "./usage.js";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_FILE = "models-dev.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FETCH_MS = 8000;

export type ModelsDevUsdPrice = ModelPrice & { providerId: string; modelId: string };

type CacheFile = {
  fetchedAt: number;
  prices: ModelsDevUsdPrice[];
};

let memory: ModelsDevUsdPrice[] | undefined;
let inflight: Promise<void> | undefined;

export function modelsDevCachePath() {
  return join(userSocodeDir(), CACHE_FILE);
}

export function resetModelsDevCache() {
  memory = undefined;
  inflight = undefined;
}

export function parseModelsDevApi(raw: unknown): ModelsDevUsdPrice[] {
  if (!raw || typeof raw !== "object") return [];
  const out: ModelsDevUsdPrice[] = [];
  for (const [providerId, provider] of Object.entries(raw as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as { models?: unknown }).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, model] of Object.entries(models as Record<string, unknown>)) {
      const price = parseCost(model);
      if (!price) continue;
      out.push({ providerId, modelId, ...price });
    }
  }
  return out;
}

export function lookupModelsDevUsd(
  model: string,
  hint = "",
  catalog = memory,
): ModelsDevUsdPrice | undefined {
  const id = model.trim();
  if (!id || !catalog?.length) return undefined;
  const lower = id.toLowerCase();
  const hits = catalog.filter(
    (row) => row.modelId.toLowerCase() === lower || `${row.providerId}/${row.modelId}`.toLowerCase() === lower,
  );
  if (!hits.length) return undefined;
  const needle = hint.trim().toLowerCase();
  if (needle) {
    const named = hits.find(
      (row) => needle.includes(row.providerId.toLowerCase()) || row.providerId.toLowerCase().includes(needle),
    );
    if (named) return named;
  }
  return hits[0];
}

export function usdToCny(price: ModelPrice, usdCny: number): ModelPrice | undefined {
  const rate = usdCny > 0 ? usdCny : 0;
  if (!rate) return undefined;
  const input = roundYuan(price.input * rate);
  const output = roundYuan(price.output * rate);
  if (input === undefined || output === undefined) return undefined;
  return {
    input,
    output,
    cacheRead: price.cacheRead !== undefined && price.cacheRead >= 0 ? roundYuan(price.cacheRead * rate) : undefined,
    cacheWrite:
      price.cacheWrite !== undefined && price.cacheWrite >= 0 ? roundYuan(price.cacheWrite * rate) : undefined,
  };
}

function roundYuan(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function ensureModelsDevCatalog(opts?: {
  fetchImpl?: typeof fetch;
  now?: number;
  force?: boolean;
}): Promise<ModelsDevUsdPrice[]> {
  if (memory && !opts?.force) return memory;
  if (inflight && !opts?.force) {
    await inflight;
    return memory ?? [];
  }
  inflight = (async () => {
    const now = opts?.now ?? Date.now();
    const cached = readCache();
    if (!opts?.force && cached && now - cached.fetchedAt < MAX_AGE_MS) {
      memory = cached.prices;
      return;
    }
    try {
      const fetchImpl = opts?.fetchImpl ?? fetch;
      const response = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_MS) });
      if (!response.ok) throw new Error(String(response.status));
      const prices = parseModelsDevApi(await response.json());
      if (!prices.length) throw new Error("empty");
      memory = prices;
      writeCache({ fetchedAt: now, prices });
    } catch {
      if (cached?.prices.length) memory = cached.prices;
      else memory = memory ?? [];
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = undefined;
  }
  return memory ?? [];
}

function parseCost(model: unknown): ModelPrice | undefined {
  if (!model || typeof model !== "object") return undefined;
  const cost = (model as { cost?: unknown }).cost;
  if (!cost || typeof cost !== "object") return undefined;
  const row = cost as Record<string, unknown>;
  const input = num(row.input);
  const output = num(row.output);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = num(row.cache_read);
  const cacheWrite = num(row.cache_write);
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function num(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readCache(): CacheFile | null {
  const path = modelsDevCachePath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (!Array.isArray(data.prices) || typeof data.fetchedAt !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

function writeCache(data: CacheFile) {
  try {
    mkdirSync(userSocodeDir(), { recursive: true });
    writeFileSync(modelsDevCachePath(), `${JSON.stringify(data)}\n`, "utf8");
  } catch {
    // cache is optional
  }
}
