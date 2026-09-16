import type { Message } from "./db.js";
import type { TaskState } from "./task-state.js";

export const TURN_BUDGET_PREFIX = "【turn budget】";

export const LONG_BUDGET_FAIL_RATIO = 0.5;
export const LONG_BUDGET_MAX_EXTEND = 1;
const READ_TOOLS = new Set(["read", "search", "get_current_time", "calculate", "context_compress"]);

export type LongBudgetPolicyName = "unlimited" | "fixed" | "dynamic";

export type LongBudgetPlan = {
  policy: LongBudgetPolicyName;
  p25: number;
  p50: number;
  p75: number;
  p100: number;
  x: number;
  y: number;
  reminder: boolean;
};

export type BudgetSegment = {
  successfulVerifyCmd: number;
  successfulWrites: number;
  writePaths: string[];
  toolNames: string[];
  toolCalls: number;
  failCount: number;
  doomTriggered: boolean;
  verifyClosedFail: boolean;
  milestoneHit: boolean;
};

export type ExtendVerdict = {
  allow: boolean;
  reason: string;
};

export function emptyBudgetSegment(): BudgetSegment {
  return {
    successfulVerifyCmd: 0,
    successfulWrites: 0,
    writePaths: [],
    toolNames: [],
    toolCalls: 0,
    failCount: 0,
    doomTriggered: false,
    verifyClosedFail: false,
    milestoneHit: false,
  };
}

export function parseLongBudgetPolicy(raw?: string): LongBudgetPolicyName {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "unlimited" || key === "fixed" || key === "dynamic") return key;
  return "dynamic";
}

export function resolveLongBudget(
  maxSteps: number,
  opts?: {
    policy?: string;
    dynamic?: string;
    p25?: number;
    p50?: number;
    p75?: number;
    reminder?: boolean;
  },
): LongBudgetPlan {
  const p100 = Math.max(1, Math.floor(maxSteps));
  const p25 = clampStep(opts?.p25, Math.ceil(p100 * 0.25), p100);
  const p50 = clampStep(opts?.p50, Math.ceil(p100 * 0.5), p100);
  const p75 = clampStep(opts?.p75, Math.ceil(p100 * 0.75), p100);
  const ordered = orderPercentiles(p25, p50, p75, p100);
  const policy = parseLongBudgetPolicy(opts?.policy);
  const pair = parseDynamicPair(opts?.dynamic, ordered);
  let x = ordered.p50;
  let y = ordered.p75;
  if (policy === "fixed") {
    x = ordered.p75;
    y = ordered.p75;
  } else if (policy === "unlimited") {
    x = ordered.p100;
    y = ordered.p100;
  } else if (pair) {
    x = pair.x;
    y = pair.y;
  }
  const reminder = opts?.reminder ?? policy !== "unlimited";
  return { policy, ...ordered, x, y, reminder };
}

export function resolveLongBudgetFromEnv(maxSteps: number): LongBudgetPlan {
  return resolveLongBudget(maxSteps, {
    policy: process.env.LONG_BUDGET_POLICY,
    dynamic: process.env.LONG_BUDGET_DYNAMIC,
    p25: envInt(process.env.LONG_BUDGET_P25),
    p50: envInt(process.env.LONG_BUDGET_P50),
    p75: envInt(process.env.LONG_BUDGET_P75),
    reminder: envFlag(process.env.LONG_BUDGET_REMINDER),
  });
}

export function isTurnBudgetMessage(message: Message) {
  return message.role === "system" && message.content.startsWith(TURN_BUDGET_PREFIX);
}

export function turnsLeftReminder(remaining: number, currentCap: number, used: number, policy: string): Message {
  return {
    role: "system",
    content: `${TURN_BUDGET_PREFIX}ENVIRONMENT REMINDER: You have ${Math.max(0, remaining)} turns left to complete the current Long run. 当前 cap=${currentCap}，已用=${used}，策略=${policy}。`,
  };
}

export function extendReminder(delta: number, currentCap: number): Message {
  return {
    role: "system",
    content: `${TURN_BUDGET_PREFIX}ENVIRONMENT REMINDER: You have used up all turns but have not yet completed the task. You are granted an additional ${delta} turns. 延长条件：本段有验证/里程碑/有效写入进展，且非空转。新 cap=${currentCap}。`,
  };
}

export function dropTurnBudgetMessages(messages: Message[], keepLatest = false) {
  const filtered = messages.filter((message) => !isTurnBudgetMessage(message));
  if (!keepLatest) return filtered;
  const latest = [...messages].reverse().find(isTurnBudgetMessage);
  return latest ? [...filtered, latest] : filtered;
}

export function hasProgress(segment: BudgetSegment, start: TaskState, now: TaskState) {
  if (segment.successfulVerifyCmd >= 1) return true;
  if (segment.milestoneHit) return true;
  if (now.done.length > start.done.length) return true;
  if (now.done.some((item) => !start.done.includes(item))) return true;
  if (segment.successfulWrites < 1) return false;
  if (start.keyFiles.length === 0) return true;
  return segment.writePaths.some((path) => now.keyFiles.includes(path) || start.keyFiles.includes(path));
}

export function notSpinning(segment: BudgetSegment) {
  if (segment.doomTriggered) return false;
  if (segment.toolCalls >= 4 && segment.failCount / segment.toolCalls >= LONG_BUDGET_FAIL_RATIO) return false;
  const last = segment.toolNames.slice(-6);
  if (last.length >= 6 && last.every((name) => READ_TOOLS.has(name))) return false;
  return true;
}

export function shouldExtend(params: {
  policy: LongBudgetPolicyName;
  extensionsUsed: number;
  segment: BudgetSegment;
  start: TaskState;
  now: TaskState;
}): ExtendVerdict {
  if (params.policy !== "dynamic") return { allow: false, reason: "非 dynamic 策略" };
  if (params.extensionsUsed >= LONG_BUDGET_MAX_EXTEND) return { allow: false, reason: "已延期一次" };
  if (params.segment.doomTriggered) return { allow: false, reason: "doom loop" };
  if (params.segment.verifyClosedFail) return { allow: false, reason: "验证门已关闭" };
  if (!hasProgress(params.segment, params.start, params.now)) {
    return { allow: false, reason: "本段无验证/里程碑/有效写入" };
  }
  if (!notSpinning(params.segment)) return { allow: false, reason: "空转或失败率过高" };
  return { allow: true, reason: progressReason(params.segment, params.start, params.now) };
}

export function noteBudgetTool(
  segment: BudgetSegment,
  name: string,
  args: Record<string, unknown>,
  output: string,
  verifyCommands: string[] = [],
) {
  segment.toolCalls += 1;
  segment.toolNames.push(name);
  const failed =
    output.startsWith("权限拒绝") ||
    output.startsWith("工具执行失败") ||
    output.includes("验证失败") ||
    /^exit=[1-9]/m.test(output);
  if (failed) {
    segment.failCount += 1;
    if (output.includes("验证失败")) segment.verifyClosedFail = true;
    return;
  }
  if (name === "write" || name === "edit" || name === "delete") {
    segment.successfulWrites += 1;
    if (typeof args.path === "string" && args.path.trim()) segment.writePaths.push(args.path.trim());
  }
  if (name === "task_state" && (typeof args.add_done === "string" || Array.isArray(args.done))) {
    if (!output.includes("验证失败")) segment.milestoneHit = true;
  }
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    const listed = verifyCommands.some((item) => item.trim() === command);
    if (listed && /^exit=0(\n|$)/m.test(output)) segment.successfulVerifyCmd += 1;
  }
}

function progressReason(segment: BudgetSegment, start: TaskState, now: TaskState) {
  if (segment.successfulVerifyCmd) return "本段验证命令通过";
  if (segment.milestoneHit || now.done.length > start.done.length) return "本段里程碑前进";
  return "本段有有效写入";
}

function parseDynamicPair(raw: string | undefined, p: { p25: number; p50: number; p75: number }) {
  const key = (raw ?? "50-75").trim();
  if (key === "25-50") return { x: p.p25, y: p.p50 };
  if (key === "50-75") return { x: p.p50, y: p.p75 };
  return { x: p.p50, y: p.p75 };
}

function orderPercentiles(p25: number, p50: number, p75: number, p100: number) {
  const steps = [p25, p50, p75, p100].map((n) => Math.min(p100, Math.max(1, n)));
  steps.sort((a, b) => a - b);
  return { p25: steps[0], p50: steps[1], p75: steps[2], p100: steps[3] };
}

function clampStep(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value) || value < 1) return Math.min(max, Math.max(1, fallback));
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function envInt(raw?: string) {
  if (!raw?.trim()) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function envFlag(raw?: string) {
  if (raw === undefined) return undefined;
  const key = raw.trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(key)) return false;
  if (["1", "true", "on", "yes"].includes(key)) return true;
}
