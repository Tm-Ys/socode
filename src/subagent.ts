import { isTurnAborted, TurnAborted, TurnFailed } from "./abort.js";
import { runAgent, type AgentEvent, type AgentOutcome } from "./agent.js";
import type { Message } from "./db.js";
import { createPolicy, type Policy } from "./permissions.js";
import type { Provider } from "./provider.js";
import {
  clipReply,
  formatSubagentBatch,
  isReadonlyKind,
  isVerifyKind,
  isWriteKind,
  jobsToRun,
  PARENT_SUBAGENT_REPLY,
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
  isReadonlyKind,
  isWriteKind,
  isVerifyKind,
  type SubagentJob,
  type SubagentKind,
  type SubagentPlan,
  type SubagentStore,
} from "./subagent-plan.js";

export const DEFAULT_SUBAGENT_STEPS = 24;

export function buildSubagentPrompt(workspace: string, kind: SubagentKind) {
  const json = schemaHint(kind);
  if (isReadonlyKind(kind)) {
    return `你是 socode 的 ${kind} 子代理，工作目录 \`${workspace}\`。只读定位：找出相关文件、符号、调用点。不能改文件、不能跑有副作用的命令。

# 约束

- 可用工具：\`read\`、\`search\`、\`glob\`、\`calculate\`、\`get_current_time\`。path / directory 必须是绝对路径，以 \`${workspace}/\` 为前缀。
- 没有父对话。缺的信息自己查。不能调用 \`subagent_plan\` / \`subagent\` / \`task_state\` / \`context_compress\`。
- 最终只输出一个 JSON 对象，不要前后文：
${json}`;
  }
  if (isVerifyKind(kind)) {
    return `你是 socode 的 verify 子代理，工作目录 \`${workspace}\`。只跑测试/类型检查，不能改文件，不能为了让测试变绿去改断言。

# 约束

- 可用工具：\`read\`、\`search\`、\`glob\`、\`bash\`（仅测试命令，如 npm test / npx tsc）。cwd 必须是 \`${workspace}\`。
- 没有父对话。不能再开子代理，不能标里程碑 done。
- 最终只输出一个 JSON 对象：
${json}
ok 必须与命令退出码一致，你不能嘴炮通过。`;
  }
  return `你是 socode 的 ${kind} 子代理，工作目录 \`${workspace}\`。按指派做小补丁。改动要小、可核对。不要自己宣称测试通过，不要标里程碑 done。

# 约束

- 可用工具：\`read\`、\`write\`、\`edit\`、\`delete\`、\`bash\`、\`search\`、\`glob\`、\`calculate\`、\`get_current_time\`。path / cwd 必须是绝对路径，以 \`${workspace}/\` 为前缀。
- 没有父对话。不能再开子代理。写入仍走父级 Long 审批（若在 Long）。
- 最终只输出一个 JSON 对象：
${json}`;
}

function schemaHint(kind: SubagentKind) {
  if (isReadonlyKind(kind)) {
    return `{"role":"${kind === "explorer" ? "explorer" : "localize"}","ok":true,"files":["src/a.ts"],"symbols":["runAgent"],"rationale":"一句理由","uncertain":[]}`;
  }
  if (isVerifyKind(kind)) {
    return `{"role":"verify","ok":false,"command":"npm test","exit":1,"failed_tests":[],"log_tail":"...","reflect":"下一步改哪里"}`;
  }
  return `{"role":"${kind === "worker" ? "worker" : "edit"}","ok":true,"changed":["src/a.ts"],"summary":"改了什么","unverified":true,"blocked_by_approve":false}`;
}

export function formatSubagentResult(kind: SubagentKind, outcome: AgentOutcome, label?: string) {
  const who = label ? `${kind}:${label}` : kind;
  const stopped = outcome.stopped ? `budget-${outcome.stopped}` : "done";
  const parsed = parseJsonObject(outcome.reply);
  if (!parsed) {
    if (kind === "localize" || kind === "edit" || kind === "verify") {
      const body = clipReply(
        JSON.stringify({
          role: kind,
          ok: false,
          status: "error",
          raw: clipReply(outcome.reply.trim() || "（子代理没有给出摘要）", 800),
        }),
        PARENT_SUBAGENT_REPLY,
      );
      return `[subagent ${who}]\nstatus: error\n---\n${body}`;
    }
    const body = clipReply(outcome.reply.trim() || "（子代理没有给出摘要）", PARENT_SUBAGENT_REPLY);
    return `[subagent ${who}]\nstatus: ${stopped}\n---\n${body}`;
  }
  const payload = overlayRuntime(kind, parsed, outcome);
  const body = clipReply(JSON.stringify(payload, null, 2), PARENT_SUBAGENT_REPLY);
  const status = payload.ok === false ? "error" : stopped;
  return `[subagent ${who}]\nstatus: ${status}\n---\n${body}`;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function overlayRuntime(kind: SubagentKind, parsed: Record<string, unknown>, outcome: AgentOutcome) {
  const changed = pathsFromTrace(outcome.trace);
  if (isVerifyKind(kind)) {
    const bash = lastBash(outcome.trace);
    const ok = bash ? bash.exit === 0 : parsed.ok === true;
    return {
      role: "verify",
      ok,
      command: bash?.command ?? parsed.command ?? "",
      exit: bash?.exit ?? (ok ? 0 : 1),
      failed_tests: Array.isArray(parsed.failed_tests) ? parsed.failed_tests : [],
      log_tail: clipReply(bash?.log ?? String(parsed.log_tail ?? ""), 800),
      reflect: String(parsed.reflect ?? "").slice(0, 400),
    };
  }
  if (isWriteKind(kind)) {
    const listed = Array.isArray(parsed.changed) ? parsed.changed.filter((item) => typeof item === "string") : [];
    const real = listed.length ? listed.filter((path) => changed.includes(path)) : changed;
    return {
      role: kind === "worker" ? "worker" : "edit",
      ok: parsed.ok === true && real.length > 0,
      changed: real,
      summary: String(parsed.summary ?? "").slice(0, 400),
      unverified: true,
      blocked_by_approve: outcome.trace.some(
        (message) => message.role === "tool" && /审批拒绝|权限拒绝/.test(message.content),
      ),
    };
  }
  return {
    role: kind === "explorer" ? "explorer" : "localize",
    ok: parsed.ok !== false,
    files: Array.isArray(parsed.files) ? parsed.files.filter((item) => typeof item === "string").slice(0, 20) : [],
    symbols: Array.isArray(parsed.symbols) ? parsed.symbols.filter((item) => typeof item === "string").slice(0, 20) : [],
    rationale: String(parsed.rationale ?? "").slice(0, 400),
    uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain.filter((item) => typeof item === "string").slice(0, 12) : [],
  };
}

function pathsFromTrace(trace: Message[]) {
  const out: string[] = [];
  for (const message of trace) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      if (call.name !== "write" && call.name !== "edit" && call.name !== "delete") continue;
      try {
        const args = JSON.parse(call.arguments) as { path?: unknown };
        if (typeof args.path === "string" && args.path.trim() && !out.includes(args.path)) out.push(args.path);
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function lastBash(trace: Message[]) {
  const calls: Array<{ id: string; command: string }> = [];
  for (const message of trace) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const call of message.toolCalls) {
      if (call.name !== "bash") continue;
      try {
        const args = JSON.parse(call.arguments) as { command?: unknown };
        if (typeof args.command === "string") calls.push({ id: call.id, command: args.command });
      } catch {
        // ignore
      }
    }
  }
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const message = trace[i];
    if (message.role !== "tool" || !message.toolCallId) continue;
    const call = calls.find((item) => item.id === message.toolCallId);
    if (!call) continue;
    const match = message.content.match(/^exit=(\d+)/m);
    return { command: call.command, exit: match ? Number(match[1]) : /工具执行失败|权限拒绝/.test(message.content) ? 1 : 0, log: message.content };
  }
}

export function childPolicy(parent: Policy, kind: SubagentKind): Policy {
  return createPolicy(parent.workspace, () => parent.mode, undefined, {
    nested: true,
    role: kind,
    mcp: parent.mcp,
    longApprove: parent.longApprove,
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
  onBatch?: (jobs: SubagentJob[]) => void;
  onJobStart?: (job: SubagentJob) => void;
  onJobDone?: (job: SubagentJob) => void;
  shouldStream?: (job: SubagentJob) => boolean;
  execute?: typeof runSubagent;
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
    const retry = args.retry === true;
    const live = selected.filter((job) => !(job.status === "done" && job.result && !retry));
    const readers = live.filter((job) => isReadonlyKind(job.kind));
    const writers = live.filter((job) => isWriteKind(job.kind));
    const verifiers = live.filter((job) => isVerifyKind(job.kind));
    const overlapping = readers.length + Math.min(writers.length, 1) > 1;
    const exec = opts.execute ?? runSubagent;
    if (live.length) opts.onBatch?.(live);
    const start = (job: SubagentJob) => {
      const meta = { job, index: selected.indexOf(job) + 1, total: selected.length };
      opts.onJobStart?.(job);
      return exec({
        provider: opts.getProvider(),
        workspace: parent.workspace,
        kind: job.kind,
        prompt: job.prompt,
        label: job.label,
        policy: childPolicy(parent, job.kind),
        signal,
        stream: opts.shouldStream?.(job) ?? (overlapping ? false : opts.stream),
        maxSteps: opts.maxSteps,
        onEvent: (event) => opts.onEvent?.(meta, event),
      })
        .then((result) => {
          const status: SubagentJob["status"] = result.startsWith("工具执行失败") ? "error" : "done";
          const ran = store.updateJob(job.id, { status, result }) ?? { ...job, status, result };
          if (isVerifyKind(job.kind)) rememberVerify(parent, result);
          opts.onJobDone?.(ran);
          return ran;
        })
        .catch((error) => {
          if (isTurnAborted(error) || signal?.aborted) throw new TurnAborted();
          const message = error instanceof Error ? error.message : String(error);
          const result = `工具执行失败: ${message}`;
          const ran = store.updateJob(job.id, { status: "error", result }) ?? { ...job, status: "error" as const, result };
          opts.onJobDone?.(ran);
          return ran;
        });
    };
    try {
      const finished = new Map<number, SubagentJob>();
      for (const job of selected) {
        if (job.status === "done" && job.result && !retry) finished.set(job.id, job);
      }
      await Promise.all([
        mapPool(readers, parent.mode === "long" ? 2 : readers.length, (job) =>
          start(job).then((ran) => finished.set(ran.id, ran)),
        ),
        (async () => {
          for (const job of writers) {
            finished.set(job.id, await start(job));
          }
          for (const job of verifiers) {
            finished.set(job.id, await start(job));
          }
        })(),
      ]);
      const ran = selected.map((job) => finished.get(job.id) ?? job);
      return formatSubagentBatch(store.get() ?? plan, ran);
    } catch (error) {
      if (isTurnAborted(error) || signal?.aborted) throw new TurnAborted();
      throw error;
    }
  };
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>) {
  if (!items.length) return;
  const queue = [...items];
  const n = Math.max(1, Math.min(limit || 1, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item) await fn(item);
      }
    }),
  );
}

function rememberVerify(parent: Policy, result: string) {
  if (!parent.tasks) return;
  const parsed = parseJsonObject(result);
  const ok = parsed?.ok === true;
  parent.tasks.patch({
    lastVerify: {
      ok,
      at: new Date().toISOString(),
      source: "subagent",
      command: typeof parsed?.command === "string" ? parsed.command : undefined,
      logTail: typeof parsed?.log_tail === "string" ? parsed.log_tail.slice(0, 800) : result.slice(0, 800),
    },
  });
}
