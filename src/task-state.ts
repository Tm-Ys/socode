import type { Message } from "./db.js";

export const TASK_STATE_PREFIX = "【task state】";
export const CHECKPOINT_PREFIX = "【checkpoint】";

const MAX_LIST = 40;
const MAX_TEXT = 2000;

export type RubricAxis = "file_change" | "spec_alignment" | "integrity" | "runtime";

export type RubricItem = {
  id: string;
  axis: RubricAxis;
  text: string;
  weight: 1 | 2 | 3;
};

export type VerifyRubric = {
  version: 1;
  goalHash: string;
  items: RubricItem[];
  createdAt: string;
};

export type RubricScore = {
  at: string;
  milestone: string;
  score: number;
  pass: boolean;
  items: { id: string; s: 0 | 1; note: string }[];
  failClosedReason?: string;
};

export type LastVerify = {
  ok: boolean;
  at: string;
  source: "harness" | "subagent";
  command?: string;
  logTail?: string;
};

export type TaskState = {
  goal: string;
  milestones: string[];
  done: string[];
  failures: string[];
  keyFiles: string[];
  verifyCommands: string[];
  notes: string;
  updatedAt: string;
  lastVerify?: LastVerify;
  verifyRubric?: VerifyRubric;
  lastRubricScore?: RubricScore;
};

export type TaskPatch = {
  goal?: string;
  milestones?: string[];
  done?: string[];
  failures?: string[];
  keyFiles?: string[];
  verifyCommands?: string[];
  notes?: string;
  addMilestone?: string;
  addDone?: string;
  addFailure?: string;
  addKeyFile?: string;
  addVerifyCommand?: string;
  lastVerify?: LastVerify | null;
  verifyRubric?: VerifyRubric | null;
  lastRubricScore?: RubricScore | null;
};

export type TaskStore = {
  get(): TaskState;
  patch(patch: TaskPatch): TaskState;
  replace(next: TaskState): TaskState;
};

export type CheckpointReason = "budget" | "abort" | "milestone" | "manual" | "compress";

export function emptyTaskState(now = new Date()): TaskState {
  return {
    goal: "",
    milestones: [],
    done: [],
    failures: [],
    keyFiles: [],
    verifyCommands: [],
    notes: "",
    updatedAt: now.toISOString(),
  };
}

export function cloneTaskState(state: TaskState): TaskState {
  return {
    goal: state.goal,
    milestones: [...state.milestones],
    done: [...state.done],
    failures: [...state.failures],
    keyFiles: [...state.keyFiles],
    verifyCommands: [...state.verifyCommands],
    notes: state.notes,
    updatedAt: state.updatedAt,
    lastVerify: state.lastVerify ? { ...state.lastVerify } : undefined,
    verifyRubric: state.verifyRubric ? cloneRubric(state.verifyRubric) : undefined,
    lastRubricScore: state.lastRubricScore ? cloneScore(state.lastRubricScore) : undefined,
  };
}

export function isEmptyTaskState(state: TaskState) {
  return (
    !state.goal.trim() &&
    state.milestones.length === 0 &&
    state.done.length === 0 &&
    state.failures.length === 0 &&
    state.keyFiles.length === 0 &&
    state.verifyCommands.length === 0 &&
    !state.notes.trim()
  );
}

export function taskStateEqual(a: TaskState, b: TaskState) {
  return (
    a.goal === b.goal &&
    a.notes === b.notes &&
    sameList(a.milestones, b.milestones) &&
    sameList(a.done, b.done) &&
    sameList(a.failures, b.failures) &&
    sameList(a.keyFiles, b.keyFiles) &&
    sameList(a.verifyCommands, b.verifyCommands) &&
    JSON.stringify(a.lastVerify ?? null) === JSON.stringify(b.lastVerify ?? null) &&
    JSON.stringify(a.verifyRubric ?? null) === JSON.stringify(b.verifyRubric ?? null) &&
    JSON.stringify(a.lastRubricScore ?? null) === JSON.stringify(b.lastRubricScore ?? null)
  );
}

export function normalizeTaskState(input: Partial<TaskState> | null | undefined, now = new Date()): TaskState {
  const base = emptyTaskState(now);
  if (!input || typeof input !== "object") return base;
  return {
    goal: clipText(str(input.goal), 400),
    milestones: cleanList(input.milestones),
    done: cleanList(input.done),
    failures: cleanList(input.failures),
    keyFiles: cleanList(input.keyFiles),
    verifyCommands: cleanList(input.verifyCommands),
    notes: clipText(str(input.notes), MAX_TEXT),
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt.trim() ? input.updatedAt : now.toISOString(),
    lastVerify: normalizeLastVerify(input.lastVerify),
    verifyRubric: normalizeRubric(input.verifyRubric),
    lastRubricScore: normalizeScore(input.lastRubricScore),
  };
}

export function applyTaskPatch(state: TaskState, patch: TaskPatch, now = new Date()): TaskState {
  const next = cloneTaskState(state);
  if (patch.goal !== undefined) next.goal = clipText(patch.goal, 400);
  if (patch.notes !== undefined) next.notes = clipText(patch.notes, MAX_TEXT);
  if (patch.milestones) next.milestones = cleanList(patch.milestones);
  if (patch.done) next.done = cleanList(patch.done);
  if (patch.failures) next.failures = cleanList(patch.failures);
  if (patch.keyFiles) next.keyFiles = cleanList(patch.keyFiles);
  if (patch.verifyCommands) next.verifyCommands = cleanList(patch.verifyCommands);
  pushUnique(next.milestones, patch.addMilestone);
  pushUnique(next.done, patch.addDone);
  pushUnique(next.failures, patch.addFailure);
  pushUnique(next.keyFiles, patch.addKeyFile);
  pushUnique(next.verifyCommands, patch.addVerifyCommand);
  if (patch.lastVerify === null) next.lastVerify = undefined;
  else if (patch.lastVerify) next.lastVerify = patch.lastVerify;
  if (patch.verifyRubric === null) next.verifyRubric = undefined;
  else if (patch.verifyRubric) next.verifyRubric = patch.verifyRubric;
  if (patch.lastRubricScore === null) next.lastRubricScore = undefined;
  else if (patch.lastRubricScore) next.lastRubricScore = patch.lastRubricScore;
  next.updatedAt = now.toISOString();
  return next;
}

export function createTaskStore(initial?: TaskState | null): TaskStore {
  let state = normalizeTaskState(initial ?? undefined);
  return {
    get() {
      return cloneTaskState(state);
    },
    patch(patch) {
      state = applyTaskPatch(state, patch);
      return cloneTaskState(state);
    },
    replace(next) {
      state = normalizeTaskState(next);
      return cloneTaskState(state);
    },
  };
}

export function isTaskStateMessage(message: Message) {
  return message.role === "system" && message.content.startsWith(TASK_STATE_PREFIX);
}

export function parseTaskStateMessage(message: Message): TaskState | null {
  if (!isTaskStateMessage(message)) return null;
  const raw = message.content.slice(TASK_STATE_PREFIX.length).trim();
  try {
    return normalizeTaskState(JSON.parse(raw) as Partial<TaskState>);
  } catch {
    return null;
  }
}

export function lastTaskState(messages: Message[]): TaskState | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parsed = parseTaskStateMessage(messages[i]);
    if (parsed) return parsed;
  }
}

export function taskStateMessage(state: TaskState): Message {
  return {
    role: "system",
    content: `${TASK_STATE_PREFIX}\n${JSON.stringify(normalizeTaskState(state))}`,
  };
}

export function patchFromToolArgs(args: Record<string, unknown>): TaskPatch {
  const patch: TaskPatch = {};
  if (typeof args.goal === "string") patch.goal = args.goal;
  if (typeof args.notes === "string") patch.notes = args.notes;
  if (isStringArray(args.milestones)) patch.milestones = args.milestones;
  if (isStringArray(args.done)) patch.done = args.done;
  if (isStringArray(args.failures)) patch.failures = args.failures;
  if (isStringArray(args.key_files) || isStringArray(args.keyFiles)) {
    patch.keyFiles = (args.key_files ?? args.keyFiles) as string[];
  }
  if (isStringArray(args.verify_commands) || isStringArray(args.verifyCommands)) {
    patch.verifyCommands = (args.verify_commands ?? args.verifyCommands) as string[];
  }
  if (typeof args.add_milestone === "string") patch.addMilestone = args.add_milestone;
  if (typeof args.add_done === "string") patch.addDone = args.add_done;
  if (typeof args.add_failure === "string") patch.addFailure = args.add_failure;
  if (typeof args.add_key_file === "string") patch.addKeyFile = args.add_key_file;
  if (typeof args.add_verify_command === "string") patch.addVerifyCommand = args.add_verify_command;
  return patch;
}

export function formatTaskStateCli(state: TaskState) {
  const lines = [
    "--- TaskState ---",
    `目标: ${state.goal.trim() || "（未设定，下一句用户输入会当作目标）"}`,
    `里程碑: ${listOrDash(state.milestones)}`,
    `已完成: ${listOrDash(state.done)}`,
    `失败: ${listOrDash(state.failures)}`,
    `关键文件: ${listOrDash(state.keyFiles)}`,
    `验证命令: ${listOrDash(state.verifyCommands)}`,
  ];
  if (state.notes.trim()) lines.push(`备注: ${state.notes.trim()}`);
  if (state.updatedAt) lines.push(`更新: ${state.updatedAt}`);
  lines.push("-----------------");
  return lines.join("\n");
}

export function formatTaskStateSummary(state: TaskState) {
  const goal = state.goal.trim() || "（无目标）";
  const short = goal.length > 48 ? `${goal.slice(0, 47)}…` : goal;
  return `${short}  完成 ${state.done.length}  里程碑 ${state.milestones.length}`;
}

export function formatTaskStateForPrompt(state: TaskState) {
  return [
    "goal: " + (state.goal.trim() || "(empty)"),
    "milestones: " + jsonList(state.milestones),
    "done: " + jsonList(state.done),
    "failures: " + jsonList(state.failures),
    "keyFiles: " + jsonList(state.keyFiles),
    "verifyCommands: " + jsonList(state.verifyCommands),
    "notes: " + (state.notes.trim() || "(empty)"),
    "updatedAt: " + state.updatedAt,
    "lastVerify: " + (state.lastVerify ? `${state.lastVerify.ok ? "ok" : "fail"} ${state.lastVerify.source}` : "(none)"),
    "rubric: " +
      (state.verifyRubric
        ? `${state.verifyRubric.items.length} items, last ${state.lastRubricScore ? (state.lastRubricScore.pass ? "pass" : "fail") : "unscored"}`
        : "(none)"),
  ].join("\n");
}

export function checkpointReply(state: TaskState, reason: CheckpointReason, detail = "") {
  const why =
    reason === "budget"
      ? "已达到步数或 token 预算"
      : reason === "abort"
        ? "用户中止了本轮"
        : reason === "compress"
          ? "上下文已压缩"
          : reason === "milestone"
            ? "里程碑已记录"
            : "已保存检查点";
  const extra = detail.trim() ? ` ${detail.trim()}` : "";
  const next = state.milestones[0] ?? "（未指定，请先确认目标）";
  return [
    `${CHECKPOINT_PREFIX}${why}，任务状态已保存（不是工作区文件快照，也不是 /undo）。${extra}`,
    `目标: ${state.goal.trim() || "（未设定）"}`,
    `已完成: ${listOrDash(state.done)}`,
    `下一步: ${next}`,
    "同一会话继续即可接着做，不必重述全部背景。",
  ].join("\n");
}

export function seedGoalFromUser(state: TaskState, userText: string) {
  if (state.goal.trim()) return state;
  const goal = userText.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!goal) return state;
  return applyTaskPatch(state, { goal });
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

function clipText(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function cleanList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = clipText(item, 240);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

function pushUnique(list: string[], value?: string) {
  const text = value ? clipText(value, 240) : "";
  if (!text || list.includes(text)) return;
  list.push(text);
  if (list.length > MAX_LIST) list.splice(0, list.length - MAX_LIST);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function listOrDash(items: string[]) {
  return items.length ? items.join(" · ") : "—";
}

function jsonList(items: string[]) {
  return items.length ? JSON.stringify(items) : "[]";
}

function cloneRubric(rubric: VerifyRubric): VerifyRubric {
  return {
    version: 1,
    goalHash: rubric.goalHash,
    createdAt: rubric.createdAt,
    items: rubric.items.map((item) => ({ ...item })),
  };
}

function cloneScore(score: RubricScore): RubricScore {
  return {
    ...score,
    items: score.items.map((item) => ({ ...item })),
  };
}

function normalizeLastVerify(value: unknown): LastVerify | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const source = rec.source === "subagent" ? "subagent" : rec.source === "harness" ? "harness" : undefined;
  if (!source || typeof rec.ok !== "boolean") return undefined;
  return {
    ok: rec.ok,
    at: typeof rec.at === "string" && rec.at.trim() ? rec.at : new Date().toISOString(),
    source,
    command: typeof rec.command === "string" ? rec.command.slice(0, 240) : undefined,
    logTail: typeof rec.logTail === "string" ? rec.logTail.slice(0, 800) : undefined,
  };
}

function normalizeRubric(value: unknown): VerifyRubric | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (!Array.isArray(rec.items)) return undefined;
  const items: RubricItem[] = [];
  for (const row of rec.items) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    const axis = item.axis;
    const weight = Number(item.weight);
    if (axis !== "file_change" && axis !== "spec_alignment" && axis !== "integrity" && axis !== "runtime") continue;
    if (![1, 2, 3].includes(weight)) continue;
    const id = typeof item.id === "string" ? item.id.trim().slice(0, 24) : "";
    const text = typeof item.text === "string" ? item.text.trim().slice(0, 200) : "";
    if (!id || !text) continue;
    items.push({ id, axis, text, weight: weight as 1 | 2 | 3 });
  }
  if (!items.length) return undefined;
  return {
    version: 1,
    goalHash: typeof rec.goalHash === "string" ? rec.goalHash : "",
    items,
    createdAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
  };
}

function normalizeScore(value: unknown): RubricScore | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  if (typeof rec.score !== "number" || typeof rec.pass !== "boolean") return undefined;
  return {
    at: typeof rec.at === "string" ? rec.at : new Date().toISOString(),
    milestone: typeof rec.milestone === "string" ? rec.milestone : "",
    score: rec.score,
    pass: rec.pass,
    items: Array.isArray(rec.items)
      ? rec.items.flatMap((row) => {
          if (!row || typeof row !== "object" || Array.isArray(row)) return [];
          const item = row as Record<string, unknown>;
          if (typeof item.id !== "string") return [];
          return [{ id: item.id, s: item.s === 1 ? 1 : 0, note: typeof item.note === "string" ? item.note : "" }];
        })
      : [],
    failClosedReason: typeof rec.failClosedReason === "string" ? rec.failClosedReason : undefined,
  };
}
