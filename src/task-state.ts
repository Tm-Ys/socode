import type { Message } from "./db.js";

export const TASK_STATE_PREFIX = "【task state】";
export const CHECKPOINT_PREFIX = "【checkpoint】";

const MAX_LIST = 40;
const MAX_TEXT = 2000;

export type TaskState = {
  goal: string;
  milestones: string[];
  done: string[];
  failures: string[];
  keyFiles: string[];
  verifyCommands: string[];
  notes: string;
  updatedAt: string;
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
    sameList(a.verifyCommands, b.verifyCommands)
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
    `${CHECKPOINT_PREFIX}${why}，任务状态已保存。${extra}`,
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
