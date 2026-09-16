export const SUBAGENT_KINDS = ["explorer", "worker"] as const;
export type SubagentKind = (typeof SUBAGENT_KINDS)[number];

export const MAX_SUBAGENTS = 6;
export const MAX_SUBAGENT_REPLY = 6_000;

const KIND_ALIASES: Record<string, SubagentKind> = {
  explorer: "explorer",
  explore: "explorer",
  探索: "explorer",
  readonly: "explorer",
  read: "explorer",
  worker: "worker",
  default: "worker",
  general: "worker",
  执行: "worker",
  implement: "worker",
};

export type SubagentJob = {
  id: number;
  kind: SubagentKind;
  label: string;
  prompt: string;
  status: "pending" | "done" | "error";
  result?: string;
};

export type SubagentPlan = {
  goal: string;
  jobs: SubagentJob[];
};

export type SubagentStore = {
  get: () => SubagentPlan | null;
  replace: (plan: SubagentPlan | null) => SubagentPlan | null;
  setPlan: (plan: SubagentPlan) => SubagentPlan;
  updateJob: (id: number, patch: Pick<SubagentJob, "status" | "result">) => SubagentJob | undefined;
};

export function parseSubagentKind(input: string | undefined): SubagentKind {
  if (!input) return "worker";
  const key = input.trim().toLowerCase();
  return KIND_ALIASES[key] ?? "worker";
}

export function parseSubagentPlan(args: Record<string, unknown>, max = MAX_SUBAGENTS): SubagentPlan {
  const goal = text(args.goal) || text(args.reason) || "";
  const raw = args.agents ?? args.tasks ?? args.subagents;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("subagent_plan 需要非空 agents 数组");
  }
  if (raw.length > max) {
    throw new Error(`一次最多规划 ${max} 个子代理`);
  }
  const jobs = raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`agents[${index}] 必须是对象`);
    }
    const rec = item as Record<string, unknown>;
    const prompt = text(rec.prompt) || text(rec.task);
    if (!prompt) throw new Error(`agents[${index}] 缺少 prompt`);
    const kind = parseSubagentKind(text(rec.kind) || text(rec.type));
    const label = text(rec.label) || text(rec.name) || `${kind}-${index + 1}`;
    return { id: index + 1, kind, label, prompt, status: "pending" as const };
  });
  return { goal, jobs };
}

export function formatSubagentPlan(plan: SubagentPlan) {
  const lines = [
    `[subagent_plan] ${plan.jobs.length} 个任务${plan.goal ? `  goal: ${plan.goal}` : ""}`,
    "下一步调用 subagent（不传参数则跑完全部 pending：explorer 并行，worker 彼此串行以免抢同一文件）。可用 index 只跑其中一个。",
  ];
  for (const job of plan.jobs) {
    lines.push(`${job.id}. ${job.status}  ${job.kind}  ${job.label}`);
    lines.push(`   ${clipReply(job.prompt, 240)}`);
  }
  return lines.join("\n");
}

export function formatSubagentBatch(plan: SubagentPlan, ran: SubagentJob[]) {
  const blocks = ran.map((job) => {
    const body = job.result?.trim() || "（无结果）";
    return `## ${job.id}. ${job.kind}  ${job.label}  ${job.status}\n${body}`;
  });
  const pending = plan.jobs.filter((job) => job.status === "pending").length;
  const footer = pending ? `\n还有 ${pending} 个 pending，再调用 subagent 继续。` : "";
  return `[subagent] 已执行 ${ran.length}/${plan.jobs.length}\n\n${blocks.join("\n\n")}${footer}`;
}

export function createSubagentStore(initial?: SubagentPlan | null): SubagentStore {
  let plan = initial ?? null;
  return {
    get: () => plan,
    replace: (next) => {
      plan = next;
      return plan;
    },
    setPlan: (next) => {
      plan = {
        goal: next.goal,
        jobs: next.jobs.map((job) => ({ ...job })),
      };
      return plan;
    },
    updateJob: (id, patch) => {
      if (!plan) return undefined;
      const job = plan.jobs.find((item) => item.id === id);
      if (!job) return undefined;
      job.status = patch.status;
      job.result = patch.result;
      return job;
    },
  };
}

export function jobsToRun(plan: SubagentPlan, args: Record<string, unknown>): SubagentJob[] {
  const retry = args.retry === true;
  const index = num(args.index) ?? num(args.id);
  if (index !== undefined) {
    const job = plan.jobs.find((item) => item.id === index);
    if (!job) throw new Error(`没有 index=${index} 的子代理`);
    if (!retry && job.status === "done" && job.result) return [job];
    return [{ ...job, status: "pending", result: undefined }];
  }
  const pending = plan.jobs.filter((job) => retry || job.status === "pending");
  if (pending.length === 0) return plan.jobs.filter((job) => job.result);
  return pending;
}

export function clipReply(text: string, max = MAX_SUBAGENT_REPLY) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function num(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.floor(n);
  }
}
