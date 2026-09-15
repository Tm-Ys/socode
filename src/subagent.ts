import { isTurnAborted, throwIfAborted, TurnAborted, TurnFailed } from "./abort.js";
import { runAgent, type AgentEvent, type AgentOutcome } from "./agent.js";
import type { Message } from "./db.js";
import { createPolicy, type Policy } from "./permissions.js";
import type { Provider } from "./provider.js";
import {
  clipReply,
  formatSubagentBatch,
  jobsToRun,
  type SubagentJob,
  type SubagentKind,
} from "./subagent-plan.js";

export {
  MAX_SUBAGENTS,
  MAX_SUBAGENT_REPLY,
  createSubagentStore,
  formatSubagentBatch,
  formatSubagentPlan,
  jobsToRun,
  parseSubagentKind,
  parseSubagentPlan,
  type SubagentJob,
  type SubagentKind,
  type SubagentPlan,
  type SubagentStore,
} from "./subagent-plan.js";

export const DEFAULT_SUBAGENT_STEPS = 24;

export function buildSubagentPrompt(workspace: string, kind: SubagentKind) {
  const tools =
    kind === "explorer"
      ? "`read`、`search`、`calculate`、`get_current_time`"
      : "`read`、`write`、`delete`、`bash`、`search`、`calculate`、`get_current_time`";
  const role =
    kind === "explorer"
      ? "你是只读探索子代理。只搜集和总结，不能改文件、不能跑有副作用的命令。"
      : "你是执行子代理。在权限允许的范围内完成指派任务，改动要小、可核对。";
  return `你是 socode 的 ${kind} 子代理，工作目录 \`${workspace}\`。${role}

# 约束

- 可用工具：${tools}。path / cwd / directory 必须是绝对路径，以 \`${workspace}/\` 为前缀。
- 没有父对话历史。任务说明里缺的信息，用工具自己查，不要向用户提问。
- 不能调用 \`subagent_plan\` / \`subagent\`，不能再开子代理。
- 先 search 再 read。explorer 只返回发现；worker 做完后说明改了哪些文件、怎么验证。
- 最终回复给父代理看：短、具体、带路径。不要把大段文件内容贴回去。`;
}

export function formatSubagentResult(kind: SubagentKind, outcome: AgentOutcome, label?: string) {
  const who = label ? `${kind}:${label}` : kind;
  const body = clipReply(outcome.reply.trim() || "（子代理没有给出摘要）");
  const stopped = outcome.stopped ? `\nstatus: budget-${outcome.stopped}` : "\nstatus: done";
  return `[subagent ${who}]${stopped}\n---\n${body}`;
}

export function childPolicy(parent: Policy, kind: SubagentKind): Policy {
  return createPolicy(parent.workspace, () => parent.mode, undefined, {
    nested: true,
    role: kind,
    mcp: parent.mcp,
  });
}

export async function runSubagent(params: {
  provider: Provider;
  workspace: string;
  kind: SubagentKind;
  prompt: string;
  policy: Policy;
  label?: string;
  signal?: AbortSignal;
  stream?: boolean;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}): Promise<string> {
  const prompt = params.prompt.trim();
  if (!prompt) throw new Error("缺少 prompt");
  const messages: Message[] = [
    { role: "system", content: buildSubagentPrompt(params.workspace, params.kind) },
    { role: "user", content: prompt },
  ];
  try {
    const outcome = await runAgent({
      provider: params.provider,
      messages,
      stream: params.stream,
      maxSteps: Math.max(1, params.maxSteps ?? DEFAULT_SUBAGENT_STEPS),
      policy: params.policy,
      signal: params.signal,
      onEvent: params.onEvent,
    });
    return formatSubagentResult(params.kind, outcome, params.label);
  } catch (error) {
    if (isTurnAborted(error) || params.signal?.aborted) throw new TurnAborted();
    const message =
      error instanceof TurnFailed || error instanceof Error ? error.message : String(error);
    return `工具执行失败: 子代理 ${params.kind} 失败: ${message}`;
  }
}

export type SubagentJobEvent = {
  job: SubagentJob;
  index: number;
  total: number;
};

export function createSubagentRunner(opts: {
  getProvider: () => Provider;
  getPolicy: () => Policy;
  workspace: string;
  maxSteps?: number;
  stream?: boolean;
  onEvent?: (meta: SubagentJobEvent, event: AgentEvent) => void;
}) {
  return async (args: Record<string, unknown>, signal?: AbortSignal) => {
    const parent = opts.getPolicy();
    if (parent.nested) {
      return "权限拒绝: 子代理不能再派生子代理（max_depth=1）";
    }
    const store = parent.subagents;
    const plan = store?.get();
    if (!store || !plan) {
      return "权限拒绝: 还没有子代理规划。先调用 subagent_plan，再调用 subagent。";
    }
    const selected = jobsToRun(plan, args);
    if (selected.length === 0) {
      return formatSubagentBatch(plan, plan.jobs);
    }
    const ran: SubagentJob[] = [];
    for (let i = 0; i < selected.length; i += 1) {
      throwIfAborted(signal);
      const job = selected[i];
      if (job.status === "done" && job.result && args.retry !== true) {
        ran.push(job);
        continue;
      }
      const meta = { job, index: i + 1, total: selected.length };
      const result = await runSubagent({
        provider: opts.getProvider(),
        workspace: opts.workspace,
        kind: job.kind,
        prompt: job.prompt,
        label: job.label,
        policy: childPolicy(parent, job.kind),
        signal,
        stream: opts.stream,
        maxSteps: opts.maxSteps,
        onEvent: (event) => opts.onEvent?.(meta, event),
      });
      const status = result.startsWith("工具执行失败") ? "error" : "done";
      const updated = store.updateJob(job.id, { status, result }) ?? { ...job, status, result };
      ran.push(updated);
    }
    return formatSubagentBatch(store.get() ?? plan, ran);
  };
}
