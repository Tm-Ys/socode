import type { AgentEvent } from "./agent.js";
import { summarizeTool } from "./tool-ui.js";
import type { SubagentJob } from "./subagent-plan.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const ERASE_LINE = "\x1b[2K";

export type SubagentUiPhase = "pending" | "running" | "done" | "error";

export type SubagentUiJob = {
  id: number;
  kind: string;
  label: string;
  phase: SubagentUiPhase;
  events: AgentEvent[];
  result?: string;
};

export type SeesubagentCommand =
  | { kind: "list" }
  | { kind: "off" }
  | { kind: "watch"; index: number }
  | { kind: "help" };

export function parseSeesubagent(input: string): SeesubagentCommand | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/seesubagent(?:\s+(.*))?$/i);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "list" };
  if (rest === "off" || rest === "hide" || rest === "0") return { kind: "off" };
  const index = Number(rest);
  if (!Number.isInteger(index) || index < 1) return { kind: "help" };
  return { kind: "watch", index };
}

export function formatSubagentBanner(count: number) {
  const n = Math.max(0, count);
  return `  ● ${n} 个子代理在跑    /seesubagent [序号] 查看过程`;
}

export function formatSubagentHud(jobs: Pick<SubagentUiJob, "phase">[]) {
  const total = jobs.length;
  if (!total) return "";
  const active = jobs.filter((job) => job.phase === "running" || job.phase === "pending").length;
  if (!active) return "";
  return `子代理 ${active}/${total} 在跑`;
}

export function formatSubagentList(jobs: SubagentUiJob[]) {
  if (!jobs.length) {
    return "还没有子代理。模型调用 subagent 之后，再用 /seesubagent [序号] 查看过程。";
  }
  const lines = ["子代理（默认隐藏过程，右下角显示在跑）", "用法: /seesubagent [序号]    /seesubagent off"];
  for (const job of jobs) {
    lines.push(`${job.id}. ${job.phase.padEnd(7)} ${job.kind.padEnd(8)} ${job.label}`);
  }
  return lines.join("\n");
}

export function formatSubagentLog(job: SubagentUiJob) {
  const header = `# ${job.id}. ${job.kind}  ${job.label}  ${job.phase}`;
  const chunks: string[] = [];
  let inText = false;
  for (const event of job.events) {
    if (event.type === "delta" && event.text) {
      if (!inText) {
        chunks.push(chunks.length ? "\n" : "");
        inText = true;
      }
      chunks.push(event.text);
      continue;
    }
    inText = false;
    if (event.type === "tool_call") {
      const detail = summarizeTool(event.name, event.arguments);
      chunks.push(`\n  ● ${event.name}${detail ? `  ${detail}` : ""}`);
      continue;
    }
    if (event.type === "tool_result") {
      const body = event.result.replace(/\s+$/u, "");
      if (body) chunks.push(`\n    ${body.split("\n").slice(-3).join("\n    ")}`);
      continue;
    }
    if (event.type === "compress" && event.saved) {
      chunks.push(`\n  压缩上下文，大约省下 ${event.saved.toLocaleString("en-US")} tokens`);
    }
  }
  const body = chunks.join("").trim();
  if (body) return `${header}\n${body}`;
  if (job.result?.trim()) return `${header}\n${job.result.trim()}`;
  return `${header}\n（还没有过程）`;
}

export function createSubagentUi(opts?: {
  write?: (text: string) => void;
  columns?: () => number;
  rows?: () => number;
  tty?: () => boolean;
}) {
  const write = opts?.write ?? ((text: string) => process.stdout.write(text));
  const columns = opts?.columns ?? (() => process.stdout.columns ?? 80);
  const rows = opts?.rows ?? (() => process.stdout.rows ?? 24);
  const tty = opts?.tty ?? (() => Boolean(process.stdout.isTTY));

  let jobs: SubagentUiJob[] = [];
  let watching: number | null = null;
  let hud = "";

  const find = (id: number) => jobs.find((job) => job.id === id);

  const paintHud = () => {
    if (!tty()) return;
    const next = formatSubagentHud(jobs);
    if (!next && !hud) return;
    const col = Math.max(1, columns() - visibleWidth(next || hud) + 1);
    write(`${SAVE}\x1b[${rows()};1H${ERASE_LINE}`);
    if (next) write(`\x1b[${rows()};${col}H${DIM}${next}${RESET}`);
    write(RESTORE);
    hud = next;
  };

  const hideHud = () => {
    if (!tty() || !hud) return;
    write(`${SAVE}\x1b[${rows()};1H${ERASE_LINE}${RESTORE}`);
    hud = "";
  };

  return {
    jobs: () => jobs.map((job) => ({ ...job, events: [...job.events] })),
    watching: () => watching,
    listText: () => formatSubagentList(jobs),
    logText: (id: number) => {
      const job = find(id);
      return job ? formatSubagentLog(job) : "";
    },
    startBatch(batch: Array<Pick<SubagentJob, "id" | "kind" | "label">>) {
      jobs = batch.map((job) => ({
        id: job.id,
        kind: job.kind,
        label: job.label,
        phase: "pending",
        events: [],
      }));
      hideHud();
      write(`\n${formatSubagentBanner(batch.length)}\n`);
      paintHud();
    },
    jobStart(id: number) {
      const job = find(id);
      if (!job || job.phase === "done" || job.phase === "error") return;
      job.phase = "running";
      paintHud();
    },
    record(id: number, event: AgentEvent) {
      const job = find(id);
      if (!job) return false;
      job.events.push(event);
      return watching === id;
    },
    jobDone(job: Pick<SubagentJob, "id" | "status" | "result">) {
      const current = find(job.id);
      if (!current) return;
      current.phase = job.status === "error" ? "error" : "done";
      current.result = job.result;
      paintHud();
      if (jobs.every((item) => item.phase === "done" || item.phase === "error")) {
        hideHud();
      }
    },
    watch(index: number | null) {
      if (index == null || index < 1) {
        watching = null;
        return undefined;
      }
      const job = find(index);
      watching = job ? index : null;
      return job;
    },
    guard(fn: () => void) {
      hideHud();
      try {
        fn();
      } finally {
        paintHud();
      }
    },
    refresh() {
      paintHud();
    },
  };
}

function visibleWidth(text: string) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += (char.codePointAt(0) ?? 0) > 127 ? 2 : 1;
  }
  return width;
}
