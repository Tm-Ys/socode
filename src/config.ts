import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseLongBudgetPolicy, resolveLongBudget, type LongBudgetPolicyName } from "./long-budget.js";
import { isAgentMode, parseMode, type AgentMode } from "./mode.js";
import { importProviderFromValues, providerStorePath, userSocodeDir } from "./provider.js";
import type { ModelPrice } from "./usage.js";

export type SocodeConfig = {
  mode: AgentMode;
  systemPrompt: string;
  maxContextMessages: number;
  maxAgentSteps: number;
  maxAgentTokens?: number;
  subagentSteps: number;
  judgeModel: string;
  longBudgetPolicy: LongBudgetPolicyName;
  longBudgetDynamic: string;
  /** USD per 1M tokens, keyed by model id. Missing price → show tokens only. */
  modelPricing: Record<string, ModelPrice>;
};

const DEFAULTS: SocodeConfig = {
  mode: "ask",
  systemPrompt: "",
  maxContextMessages: 200,
  maxAgentSteps: 80,
  subagentSteps: 24,
  judgeModel: "",
  longBudgetPolicy: "dynamic",
  longBudgetDynamic: "50-75",
  modelPricing: {},
};

let cached: SocodeConfig | undefined;

export function configPath() {
  return join(userSocodeDir(), "config.json");
}

export function resetConfigCache() {
  cached = undefined;
}

export function loadConfig(): SocodeConfig {
  if (cached) return cached;
  cached = readConfigFile() ?? { ...DEFAULTS };
  return cached;
}

export function saveConfig(patch: Partial<SocodeConfig>): SocodeConfig {
  const next = normalizeConfig({ ...loadConfig(), ...patch });
  mkdirSync(userSocodeDir(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  cached = next;
  return next;
}

export function migrateLegacyDotenv(workspace = process.cwd()) {
  const envPath = resolve(workspace, ".env");
  if (!existsSync(envPath)) return;
  const env = parseDotenvFile(envPath);
  if (!existsSync(providerStorePath())) importProviderFromValues(env);
  if (!existsSync(configPath())) saveConfig(configFromEnvMap(env));
}

export function parseDotenvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).replaceAll('\\"', '"');
    }
    if (key) out[key] = value;
  }
  return out;
}

export function longBudgetFromConfig(maxSteps: number) {
  const cfg = loadConfig();
  return resolveLongBudget(maxSteps, {
    policy: cfg.longBudgetPolicy,
    dynamic: cfg.longBudgetDynamic,
  });
}

function configFromEnvMap(env: Record<string, string>): Partial<SocodeConfig> {
  const mode = parseMode(env.MODE ?? "");
  const judgeModel = (env.LONG_APPROVE_MODEL ?? env.JUDGE_MODEL ?? env.LONG_RUBRIC_MODEL ?? "").trim();
  return {
    ...(mode ? { mode } : {}),
    ...(env.SYSTEM_PROMPT !== undefined ? { systemPrompt: env.SYSTEM_PROMPT } : {}),
    maxContextMessages: positiveInt(env.MAX_CONTEXT_MESSAGES),
    maxAgentSteps: positiveInt(env.MAX_AGENT_STEPS),
    maxAgentTokens: positiveInt(env.MAX_AGENT_TOKENS),
    subagentSteps: positiveInt(env.SUBAGENT_STEPS),
    ...(judgeModel ? { judgeModel } : {}),
    ...(env.LONG_BUDGET_POLICY ? { longBudgetPolicy: parseLongBudgetPolicy(env.LONG_BUDGET_POLICY) } : {}),
    longBudgetDynamic: env.LONG_BUDGET_DYNAMIC?.trim() || undefined,
  };
}

function readConfigFile(): SocodeConfig | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<SocodeConfig>;
    return normalizeConfig({ ...DEFAULTS, ...data });
  } catch {
    return { ...DEFAULTS };
  }
}

function normalizeConfig(input: Partial<SocodeConfig>): SocodeConfig {
  const mode = input.mode && isAgentMode(input.mode) ? input.mode : DEFAULTS.mode;
  const maxAgentTokens =
    typeof input.maxAgentTokens === "number" && input.maxAgentTokens > 0
      ? Math.floor(input.maxAgentTokens)
      : undefined;
  return {
    mode,
    systemPrompt: typeof input.systemPrompt === "string" ? input.systemPrompt : "",
    maxContextMessages: floorOr(input.maxContextMessages, DEFAULTS.maxContextMessages),
    maxAgentSteps: floorOr(input.maxAgentSteps, DEFAULTS.maxAgentSteps),
    maxAgentTokens,
    subagentSteps: floorOr(input.subagentSteps, DEFAULTS.subagentSteps),
    judgeModel: typeof input.judgeModel === "string" ? input.judgeModel.trim() : "",
    longBudgetPolicy: parseLongBudgetPolicy(input.longBudgetPolicy),
    longBudgetDynamic: (input.longBudgetDynamic ?? DEFAULTS.longBudgetDynamic).trim() || DEFAULTS.longBudgetDynamic,
    modelPricing: normalizePricing(input.modelPricing),
  };
}

function normalizePricing(input: Record<string, ModelPrice> | undefined): Record<string, ModelPrice> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(input)) {
    if (!model.trim() || !price || typeof price !== "object") continue;
    if (!(price.input > 0) || !(price.output > 0)) continue;
    out[model] = {
      input: price.input,
      output: price.output,
      ...(price.cacheRead !== undefined && price.cacheRead >= 0 ? { cacheRead: price.cacheRead } : {}),
      ...(price.cacheWrite !== undefined && price.cacheWrite >= 0 ? { cacheWrite: price.cacheWrite } : {}),
    };
  }
  return out;
}

function floorOr(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function positiveInt(raw?: string) {
  if (!raw?.trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
