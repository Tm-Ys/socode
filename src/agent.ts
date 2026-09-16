import { isTurnAborted, throwIfAborted, TurnAborted, TurnFailed } from "./abort.js";
import { compressAgentMessages, LONG_COMPRESS_RATIO, splitLiveToolTurn } from "./compress.js";
import { completeChat, type ChatResult, type TokenUsage } from "./chat.js";
import { messageTokens } from "./context.js";
import type { Policy } from "./permissions.js";
import {
  dropTurnBudgetMessages,
  emptyBudgetSegment,
  extendReminder,
  noteBudgetTool,
  resolveLongBudget,
  shouldExtend,
  turnsLeftReminder,
  type LongBudgetPlan,
} from "./long-budget.js";
import { checkpointReply, cloneTaskState, emptyTaskState } from "./task-state.js";
import { PLAN_REVIEW_NUDGE, SETPLAN_NUDGE, shouldHoldForPlanReview, shouldHoldForSetplan } from "./plan.js";
import { isToolError } from "./tool-ui.js";
import { executeTool, toolSpecs, type ToolSpec } from "./tools.js";
import { writeAudit } from "./audit.js";
import type { Message } from "./db.js";
import type { Provider } from "./provider.js";

export const DEFAULT_MAX_AGENT_STEPS = 80;
const REPEAT_LIMIT = 3;

export type BudgetStop = "steps" | "tokens" | "context";

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "compress"; saved: number }
  | { type: "notice"; text: string };

export type AgentOutcome = {
  reply: string;
  trace: Message[];
  usage?: TokenUsage;
  stopped?: BudgetStop;
};

export function usageTotal(usage?: TokenUsage) {
  if (!usage) return 0;
  return usage.promptTokens + usage.completionTokens;
}

export function budgetStopReason(params: {
  step: number;
  maxSteps: number;
  usage: TokenUsage;
  maxTokens?: number;
  contextTokens?: number;
  maxContextTokens?: number;
}): BudgetStop | null {
  if (params.maxTokens && params.maxTokens > 0 && usageTotal(params.usage) >= params.maxTokens) {
    return "tokens";
  }
  if (
    params.maxContextTokens &&
    params.maxContextTokens > 0 &&
    (params.contextTokens ?? 0) >= params.maxContextTokens
  ) {
    return "context";
  }
  if (params.step >= params.maxSteps) return "steps";
  return null;
}

export function closeIncompleteTrace(trace: Message[]): Message[] {
  const out = trace.map((message) =>
    message.toolCalls?.length ? { ...message, toolCalls: [...message.toolCalls] } : { ...message },
  );
  while (out.length) {
    const last = out[out.length - 1];
    if (last.role === "assistant" && !last.toolCalls?.length) {
      out.pop();
      continue;
    }
    if (last.role === "assistant" && last.toolCalls?.length) {
      out.pop();
      continue;
    }
    if (last.role === "tool") {
      let i = out.length - 1;
      while (i >= 0 && out[i].role === "tool") i -= 1;
      const assistant = i >= 0 ? out[i] : undefined;
      const tools = out.slice(i + 1);
      if (!assistant || assistant.role !== "assistant" || !assistant.toolCalls?.length) {
        out.length = i + 1;
        continue;
      }
      const ids = new Set(tools.map((item) => item.toolCallId).filter(Boolean));
      assistant.toolCalls = assistant.toolCalls.filter((call) => ids.has(call.id));
      if (assistant.toolCalls.length === 0) {
        out.length = i;
        continue;
      }
      break;
    }
    break;
  }
  return out;
}

export async function runAgent(params: {
  provider: Provider;
  messages: Message[];
  stream?: boolean;
  maxSteps?: number;
  maxTokens?: number;
  maxContextTokens?: number;
  useTools?: boolean;
  signal?: AbortSignal;
  policy?: Policy;
  onEvent?: (event: AgentEvent) => void;
  requirePlan?: boolean;
  complete?: (params: {
    provider: Provider;
    messages: Message[];
    tools?: ToolSpec[];
    stream?: boolean;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onThinking?: (text: string) => void;
  }) => Promise<Pick<ChatResult, "content" | "toolCalls" | "usage">>;
}): Promise<AgentOutcome> {
  const maxSteps = Math.max(1, params.maxSteps ?? DEFAULT_MAX_AGENT_STEPS);
  const messages = [...params.messages];
  const trace: Message[] = [];
  const tools = params.useTools === false ? [] : toolSpecs(params.policy?.mode, {
    nested: params.policy?.nested,
    role: params.policy?.role,
    extra: params.policy?.mcp?.specs({ mode: params.policy?.mode, role: params.policy?.role }),
  });
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  const longHorizon = params.policy?.mode === "long";
  const parentLong = longHorizon && !params.policy?.nested;
  const budget: LongBudgetPlan = params.policy?.longBudget ?? resolveLongBudget(maxSteps);
  const loopLimit = parentLong ? budget.y : maxSteps;
  let currentCap = parentLong ? budget.x : maxSteps;
  let extensionsUsed = 0;
  const segment = emptyBudgetSegment();
  const startState = params.policy?.tasks ? cloneTaskState(params.policy.tasks.get()) : emptyTaskState();
  let lastCompressStep = -8;
  let lastSig = "";
  let sameCount = 0;
  let failName = "";
  let failCount = 0;
  const chat = params.complete ?? completeChat;

  const fail = (error: unknown): never => {
    if (error instanceof TurnFailed) throw error;
    const closed = closeIncompleteTrace(trace);
    if (isTurnAborted(error) || params.signal?.aborted) {
      throw new TurnAborted(closed);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new TurnFailed(message, closed);
  };

  try {
    for (let step = 0; step < loopLimit; step += 1) {
      throwIfAborted(params.signal);
      if (parentLong && step >= currentCap) {
        const now = params.policy?.tasks?.get() ?? startState;
        const verdict = shouldExtend({
          policy: budget.policy,
          extensionsUsed,
          segment,
          start: startState,
          now,
        });
        if (verdict.allow) {
          const from = currentCap;
          currentCap = budget.y;
          extensionsUsed += 1;
          const delta = Math.max(1, currentCap - from);
          replaceTurnReminder(messages, extendReminder(delta, currentCap));
          params.onEvent?.({ type: "notice", text: `步数预算延期 ${from}→${currentCap}：${verdict.reason}` });
          params.policy?.tasks?.patch({
            notes: [now.notes, `budget-extend: ${from}→${currentCap} because ${verdict.reason}`]
              .filter(Boolean)
              .join("\n")
              .slice(-2000),
          });
          if (params.policy?.workspace) {
            writeAudit({
              workspace: params.policy.workspace,
              mode: "long",
              tool: "turn_budget",
              decision: "allow",
              detail: `${from}->${currentCap} ${verdict.reason}`,
            });
          }
        } else {
          return stopForBudget("steps", trace, usage, params.policy);
        }
      }
      if (parentLong && params.maxContextTokens) {
        const used = messages.reduce((sum, message) => sum + messageTokens(message), 0);
        if (used >= params.maxContextTokens * LONG_COMPRESS_RATIO) {
          const compressed = await compressAgentMessages({
            provider: params.provider,
            messages,
            signal: params.signal,
          });
          if (compressed) {
            messages.length = 0;
            messages.push(...compressed.messages);
            lastCompressStep = step;
            params.onEvent?.({ type: "compress", saved: compressed.saved });
          }
          const still =
            messages.reduce((sum, message) => sum + messageTokens(message), 0) >= params.maxContextTokens;
          if (still) {
            return stopForBudget("context", trace, usage, params.policy);
          }
        }
      }
      const allowTools = tools.length > 0 && step < loopLimit - 1;
      const result = await chat({
        provider: params.provider,
        messages,
        tools: allowTools ? tools : undefined,
        stream: params.stream,
        signal: params.signal,
        onDelta: (text) => params.onEvent?.({ type: "delta", text }),
        onThinking: (text) => params.onEvent?.({ type: "thinking", text }),
      }).catch(fail);
      addUsage(usage, result.usage);
      throwIfAborted(params.signal);

      if (result.toolCalls.length === 0) {
        const reply = result.content.trim();
        if (!reply) return fail(new Error("模型没有给出最终回复"));
        const canStillTool = tools.length > 0 && step < loopLimit - 1;
        if (shouldHoldForSetplan(trace, Boolean(params.requirePlan), canStillTool)) {
          messages.push({ role: "assistant", content: reply });
          messages.push({ role: "user", content: SETPLAN_NUDGE });
          params.onEvent?.({ type: "notice", text: "/setplan：请先调用 plan 写出目标，再按 grill-me 追问。" });
          continue;
        }
        if (shouldHoldForPlanReview(params.policy?.plans?.get(), canStillTool)) {
          messages.push({ role: "assistant", content: reply });
          messages.push({ role: "user", content: PLAN_REVIEW_NUDGE });
          params.onEvent?.({ type: "notice", text: "计划已全部勾完，尚未审查。请先调用 plan 写入 review。" });
          continue;
        }
        const assistant: Message = { role: "assistant", content: reply };
        trace.push(assistant);
        return { reply, trace, usage: nonemptyUsage(usage) };
      }

      const assistant: Message = {
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      };
      messages.push(assistant);
      trace.push(assistant);

      let doom = false;
      for (const call of result.toolCalls) {
        throwIfAborted(params.signal);
        params.onEvent?.({ type: "tool_call", name: call.name, arguments: call.arguments });
        const sig = `${call.name}\0${call.arguments}`;
        sameCount = sig === lastSig ? sameCount + 1 : 1;
        lastSig = sig;
        let output: string;
        let args: Record<string, unknown> = {};
        try {
          args = call.arguments.trim() ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        if (sameCount >= REPEAT_LIMIT) {
          output = `权限拒绝: 同一工具连续调用 ${REPEAT_LIMIT} 次，已停止以免空转。请换一种做法或直接回复用户。`;
          doom = true;
        } else if (call.name === "context_compress" && parentLong) {
          output = await runContextCompress({
            provider: params.provider,
            messages,
            args,
            signal: params.signal,
            step,
            lastCompressStep,
          });
          if (!output.startsWith("工具执行失败") && !output.startsWith("权限拒绝")) lastCompressStep = step;
        } else {
          output = await executeTool(call.name, call.arguments, params.signal, params.policy).catch(fail);
        }
        noteBudgetTool(segment, call.name, args, output, params.policy?.tasks?.get().verifyCommands ?? []);
        if (isToolError(output)) {
          failCount = call.name === failName ? failCount + 1 : 1;
          failName = call.name;
          if (failCount >= REPEAT_LIMIT) {
            doom = true;
            if (!output.includes("连续失败")) {
              output = `${output}\n连续失败 ${REPEAT_LIMIT} 次，已停止以免空转。`;
            }
          }
        } else {
          failName = "";
          failCount = 0;
        }
        throwIfAborted(params.signal);
        params.onEvent?.({ type: "tool_result", name: call.name, result: output });
        const toolMessage: Message = {
          role: "tool",
          content: output,
          toolCallId: call.id,
        };
        messages.push(toolMessage);
        trace.push(toolMessage);
        if (doom) break;
      }

      if (doom) {
        segment.doomTriggered = true;
        const done = new Set(
          trace.filter((message) => message.role === "tool").map((message) => message.toolCallId),
        );
        for (const call of result.toolCalls) {
          if (done.has(call.id)) continue;
          const output = "权限拒绝: 因重复调用已跳过";
          params.onEvent?.({ type: "tool_result", name: call.name, result: output });
          const skipped: Message = { role: "tool", content: output, toolCallId: call.id };
          messages.push(skipped);
          trace.push(skipped);
        }
        const reply = "检测到重复或连续失败的工具调用，已停止以免空转。";
        const stop: Message = { role: "assistant", content: reply };
        const closed = closeIncompleteTrace(trace);
        closed.push(stop);
        return { reply, trace: closed, usage: nonemptyUsage(usage) };
      }

      if (parentLong) {
        if (budget.reminder) {
          replaceTurnReminder(messages, turnsLeftReminder(currentCap - step - 1, currentCap, step + 1, budget.policy));
        }
        const reason = budgetStopReason({
          step: step + 1,
          maxSteps: loopLimit + 1,
          usage,
          maxTokens: params.maxTokens,
          contextTokens: messages.reduce((sum, message) => sum + messageTokens(message), 0),
          maxContextTokens: params.maxContextTokens,
        });
        if (reason === "tokens") {
          return stopForBudget(reason, trace, usage, params.policy);
        }
      }
    }

    const over = budgetStopReason({
      step: loopLimit,
      maxSteps: loopLimit,
      usage,
      maxTokens: params.maxTokens,
      contextTokens: messages.reduce((sum, message) => sum + messageTokens(message), 0),
      maxContextTokens: params.maxContextTokens,
    });
    if (parentLong) {
      return stopForBudget(over ?? "steps", trace, usage, params.policy);
    }
    return fail(new Error(`超过最大工具步数 ${maxSteps}`));
  } catch (error) {
    return fail(error);
  }
}

function replaceTurnReminder(messages: Message[], next: Message) {
  const kept = dropTurnBudgetMessages(messages);
  messages.length = 0;
  messages.push(...kept, next);
}

async function runContextCompress(params: {
  provider: Provider;
  messages: Message[];
  args: Record<string, unknown>;
  signal?: AbortSignal;
  step: number;
  lastCompressStep: number;
}) {
  if (params.step - params.lastCompressStep < 2) {
    return "工具执行失败: 刚刚压缩过，先继续做事再压";
  }
  const keepTurns = clampKeepTurns(params.args.keep_turns);
  const note = typeof params.args.note === "string" ? params.args.note : undefined;
  const reason = typeof params.args.reason === "string" ? params.args.reason : "context_pressure";
  const { rest, live } = splitLiveToolTurn(params.messages);
  const compressed = await compressAgentMessages({
    provider: params.provider,
    messages: rest,
    signal: params.signal,
    keepTurns,
    note,
  });
  if (!compressed) return "工具执行失败: 对话还不够长，无需压缩";
  params.messages.length = 0;
  params.messages.push(...compressed.messages, ...live);
  return `[context_compress] ok  reason=${reason}  saved≈${compressed.saved} tokens  keep=${keepTurns}\n摘要已写入会话（【会话摘要】）。TaskState 与 harness mode 仍钉在原文。继续当前 goal，不要重做 done。`;
}

function clampKeepTurns(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.min(8, Math.max(2, Math.floor(n)));
}

function stopForBudget(
  reason: BudgetStop,
  trace: Message[],
  usage: TokenUsage,
  policy?: Policy,
): AgentOutcome {
  const closed = closeIncompleteTrace(trace);
  const detail =
    reason === "tokens"
      ? "累计 token 已达上限。"
      : reason === "context"
        ? "上下文接近窗口上限。"
        : "工具步数已达上限。";
  const state = policy?.tasks?.get();
  const reply = state
    ? checkpointReply(state, "budget", detail)
    : `${detail} 任务未完成。同一会话继续即可接着做。`;
  if (state) {
    policy?.tasks?.patch({ notes: [state.notes, `checkpoint: ${reason}`].filter(Boolean).join("\n").slice(-2000) });
  }
  closed.push({ role: "assistant", content: reply });
  return { reply, trace: closed, usage: nonemptyUsage(usage), stopped: reason };
}

function addUsage(total: TokenUsage, next?: TokenUsage) {
  if (!next) return;
  total.promptTokens += next.promptTokens;
  total.completionTokens += next.completionTokens;
}

function nonemptyUsage(usage: TokenUsage): TokenUsage | undefined {
  if (usage.promptTokens <= 0 && usage.completionTokens <= 0) return undefined;
  return usage;
}
