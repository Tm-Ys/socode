import type { Message } from "./db.js";
import { useColor } from "./markdown.js";

export const PLAN_PREFIX = "【plan】";
export const PLAN_REVIEW_NUDGE =
  "【harness】计划已全部勾完，但还没有审查。请先调用 plan 写入 review（对照每项目标查漏、确认改动和验证），然后再给用户最终结果。不要直接收工。";
export const SETPLAN_PREFIX = "【setplan】";
export const SETPLAN_NUDGE =
  "【harness】/setplan 要求本轮必须先调用 plan，根据用户请求写出可勾选目标。写好计划后再按 grill-me 追问，不要直接收工。";

const MAX_ITEMS = 12;
const MAX_TITLE = 160;
const MAX_TEXT = 2000;

export type PlanItem = {
  id: number;
  title: string;
  done: boolean;
};

export type WorkPlan = {
  goal: string;
  items: PlanItem[];
  review: string;
  updatedAt: string;
};

export type PlanPatch = {
  goal?: string;
  items?: string[];
  add?: string;
  done?: Array<number | string>;
  review?: string;
  clear?: boolean;
};

export type PlanStore = {
  get(): WorkPlan;
  patch(patch: PlanPatch): WorkPlan;
  replace(next: WorkPlan): WorkPlan;
};

export function emptyPlan(now = new Date()): WorkPlan {
  return { goal: "", items: [], review: "", updatedAt: now.toISOString() };
}

export function clonePlan(plan: WorkPlan): WorkPlan {
  return {
    goal: plan.goal,
    items: plan.items.map((item) => ({ ...item })),
    review: plan.review,
    updatedAt: plan.updatedAt,
  };
}

export function isEmptyPlan(plan: WorkPlan) {
  return !plan.goal.trim() && plan.items.length === 0 && !plan.review.trim();
}

export function planEqual(a: WorkPlan, b: WorkPlan) {
  return (
    a.goal === b.goal &&
    a.review === b.review &&
    a.items.length === b.items.length &&
    a.items.every((item, i) => item.title === b.items[i].title && item.done === b.items[i].done)
  );
}

export function allPlanItemsDone(plan: WorkPlan) {
  return plan.items.length > 0 && plan.items.every((item) => item.done);
}

export function planNeedsReview(plan: WorkPlan) {
  return allPlanItemsDone(plan) && !plan.review.trim();
}

export function shouldHoldForPlanReview(plan: WorkPlan | undefined, canStillTool: boolean) {
  return Boolean(canStillTool && plan && planNeedsReview(plan));
}

export function turnCalledPlan(trace: Message[]) {
  return trace.some(
    (message) => message.role === "assistant" && message.toolCalls?.some((call) => call.name === "plan"),
  );
}

export function shouldHoldForSetplan(trace: Message[], requirePlan: boolean, canStillTool: boolean) {
  return Boolean(requirePlan && canStillTool && !turnCalledPlan(trace));
}

export function parseSetplan(input: string) {
  const match = input.trim().match(/^\/setplan(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { prompt: (match[1] ?? "").trim() };
}

export function setplanUserContent(prompt: string) {
  return `${SETPLAN_PREFIX}本轮强制：
1. 先调用 plan，根据下面的请求拆成 2–8 个可勾选目标（即使看起来很短也要拆）。
2. 已强制激活 grill-me：按该 skill 一轮一轮追问决策。未达成共识前不要改代码、不要写文件。

${prompt.trim()}`;
}

export function planProgress(plan: WorkPlan) {
  const total = plan.items.length;
  const done = plan.items.filter((item) => item.done).length;
  return { done, total };
}

export function normalizePlan(input: Partial<WorkPlan> | null | undefined, now = new Date()): WorkPlan {
  const base = emptyPlan(now);
  if (!input || typeof input !== "object") return base;
  const items = Array.isArray(input.items) ? input.items : [];
  return {
    goal: clipText(str(input.goal), 400),
    items: items
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const title = clipText(str((item as PlanItem).title), MAX_TITLE);
        if (!title) return null;
        return { id: index + 1, title, done: Boolean((item as PlanItem).done) };
      })
      .filter((item): item is PlanItem => Boolean(item))
      .slice(0, MAX_ITEMS),
    review: clipText(str(input.review), MAX_TEXT),
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt.trim() ? input.updatedAt : now.toISOString(),
  };
}

export function applyPlanPatch(plan: WorkPlan, patch: PlanPatch, now = new Date()): WorkPlan {
  if (patch.clear) return emptyPlan(now);
  const next = clonePlan(plan);
  if (patch.goal !== undefined) next.goal = clipText(patch.goal, 400);
  if (patch.items) {
    const titles = uniqueTitles(patch.items);
    next.items = titles.map((title, index) => {
      const prev = plan.items.find((item) => item.title === title);
      return { id: index + 1, title, done: prev?.done ?? false };
    });
  }
  if (patch.add) {
    const title = clipText(patch.add, MAX_TITLE);
    if (title && !next.items.some((item) => item.title === title) && next.items.length < MAX_ITEMS) {
      next.items.push({ id: next.items.length + 1, title, done: false });
    }
  }
  if (patch.done?.length) markDone(next, patch.done);
  reindex(next);
  if (patch.review !== undefined) {
    if (!allPlanItemsDone(next)) {
      throw new Error("还有未勾选项，不能写入 review");
    }
    next.review = clipText(patch.review, MAX_TEXT);
  } else if (!allPlanItemsDone(next)) {
    next.review = "";
  }
  next.updatedAt = now.toISOString();
  return next;
}

export function createPlanStore(initial?: WorkPlan | null): PlanStore {
  let state = normalizePlan(initial ?? undefined);
  return {
    get() {
      return clonePlan(state);
    },
    patch(patch) {
      state = applyPlanPatch(state, patch);
      return clonePlan(state);
    },
    replace(next) {
      state = normalizePlan(next);
      return clonePlan(state);
    },
  };
}

export function isPlanMessage(message: Message) {
  return message.role === "system" && message.content.startsWith(PLAN_PREFIX);
}

export function parsePlanMessage(message: Message): WorkPlan | null {
  if (!isPlanMessage(message)) return null;
  const raw = message.content.slice(PLAN_PREFIX.length).trim();
  try {
    return normalizePlan(JSON.parse(raw) as Partial<WorkPlan>);
  } catch {
    return null;
  }
}

export function lastPlan(messages: Message[]): WorkPlan | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parsed = parsePlanMessage(messages[i]);
    if (parsed) return parsed;
  }
}

export function planMessage(plan: WorkPlan): Message {
  return {
    role: "system",
    content: `${PLAN_PREFIX}\n${JSON.stringify(normalizePlan(plan))}`,
  };
}

export function patchFromPlanArgs(args: Record<string, unknown>): PlanPatch {
  const patch: PlanPatch = {};
  if (args.clear === true) patch.clear = true;
  if (typeof args.goal === "string") patch.goal = args.goal;
  if (isStringArray(args.items)) patch.items = args.items;
  if (typeof args.add === "string") patch.add = args.add;
  if (args.done !== undefined) patch.done = coerceRefs(args.done);
  if (typeof args.review === "string") patch.review = args.review;
  return patch;
}

export function planCliWidth(columns = process.stdout.columns ?? 60) {
  return Math.max(42, Math.min(72, Math.max(20, columns) - 2));
}

export function formatPlanCli(plan: WorkPlan, opts?: { width?: number; color?: boolean }) {
  const color = opts?.color ?? useColor();
  const boxWidth = opts?.width ?? planCliWidth();
  const inner = boxWidth - 4;
  const { done, total } = planProgress(plan);
  const dim = color ? "\x1b[2m" : "";
  const bold = color ? "\x1b[1m" : "";
  const reset = color ? "\x1b[0m" : "";

  let title = total ? `📋 Plan  ${done}/${total}` : "📋 Plan";
  if (planNeedsReview(plan)) title += "  🔍 待审查";
  else if (plan.review.trim()) title += "  ✨ 已审查";

  const body: string[] = [];
  body.push(...wrapLabeled("🎯", plan.goal.trim() || "（未设定）", inner));
  if (total) {
    const barWidth = Math.min(12, Math.max(8, inner - 18));
    const filled = Math.round((done / total) * barWidth);
    const bar = `${"█".repeat(filled)}${"░".repeat(barWidth - filled)}`;
    body.push(clipCells(`📊  ${bar}  ${done}/${total}`, inner));
  }
  body.push("");

  if (!plan.items.length) {
    body.push(...wrapLabeled("📭", "还没有拆分项。模型会用 plan 工具写入。", inner));
  } else {
    const nextId = plan.items.find((item) => !item.done)?.id;
    for (const item of plan.items) {
      const mark = item.done ? "✅" : item.id === nextId ? "👉" : "⬜";
      const wrapped = wrapCells(`${mark}  ${item.id}. ${item.title}`, inner);
      if (color && item.done) body.push(...wrapped.map((row) => `${dim}${row}${reset}`));
      else if (color && item.id === nextId) body.push(...wrapped.map((row) => `${bold}${row}${reset}`));
      else body.push(...wrapped);
    }
  }

  body.push("");
  body.push(...wrapLabeled("📝", plan.review.trim() || "（未审查）", inner));
  if (planNeedsReview(plan)) body.push(...wrapLabeled("🔍", "对照目标审查，再用 plan 写入 review。", inner));
  else if (plan.review.trim()) body.push(...wrapLabeled("✨", "已审查，可以给最终结果。", inner));
  else if (total) body.push(...wrapLabeled("👉", "完成下一项并勾选。", inner));

  return drawBox(title, body, boxWidth, { dim, reset });
}

export function formatPlanForPrompt(plan: WorkPlan) {
  const { done, total } = planProgress(plan);
  const items = plan.items.length
    ? plan.items.map((item) => `${item.done ? "[x]" : "[ ]"} ${item.id}. ${item.title}`).join("\n")
    : "(empty)";
  return [
    `goal: ${plan.goal.trim() || "(empty)"}`,
    `progress: ${done}/${total}`,
    items,
    `review: ${plan.review.trim() || "(empty)"}`,
  ].join("\n");
}

export function parseSeeplan(input: string) {
  return /^\/seeplan(?:\s.*)?$/i.test(input.trim());
}

function markDone(plan: WorkPlan, refs: Array<number | string>) {
  for (const ref of refs) {
    const item =
      typeof ref === "number"
        ? plan.items.find((entry) => entry.id === ref) ?? plan.items[ref - 1]
        : findByTitle(plan, ref);
    if (item) item.done = true;
  }
}

function findByTitle(plan: WorkPlan, raw: string) {
  const text = raw.trim();
  if (!text) return;
  const asNum = Number(text);
  if (Number.isInteger(asNum) && asNum >= 1) {
    return plan.items.find((item) => item.id === asNum) ?? plan.items[asNum - 1];
  }
  return plan.items.find((item) => item.title === text) ?? plan.items.find((item) => item.title.includes(text));
}

function reindex(plan: WorkPlan) {
  plan.items.forEach((item, index) => {
    item.id = index + 1;
  });
}

function uniqueTitles(items: string[]) {
  const out: string[] = [];
  for (const item of items) {
    const title = clipText(item, MAX_TITLE);
    if (!title || out.includes(title)) continue;
    out.push(title);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function coerceRefs(value: unknown): Array<number | string> {
  const raw = Array.isArray(value) ? value : [value];
  const out: Array<number | string> = [];
  for (const item of raw) {
    if (typeof item === "number" && Number.isInteger(item)) out.push(item);
    else if (typeof item === "string" && item.trim()) out.push(item.trim());
  }
  return out;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function str(value: unknown) {
  return typeof value === "string" ? value : "";
}

function clipText(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function drawBox(title: string, rows: string[], width: number, paint: { dim: string; reset: string }) {
  const inner = width - 4;
  const clippedTitle = clipCells(title, width - 6);
  const dash = Math.max(1, width - lineWidth(clippedTitle) - 5);
  const top = `${paint.dim}╭─ ${paint.reset}${clippedTitle}${paint.dim} ${"─".repeat(dash)}╮${paint.reset}`;
  const bottom = `${paint.dim}╰${"─".repeat(width - 2)}╯${paint.reset}`;
  const middle = rows.map((row) => `${paint.dim}│${paint.reset} ${padPainted(row, inner)} ${paint.dim}│${paint.reset}`);
  return [top, ...middle, bottom].join("\n");
}

function wrapLabeled(emoji: string, text: string, width: number) {
  const prefix = `${emoji}  `;
  const indent = " ".repeat(lineWidth(prefix));
  const chunks = text.split(/\n/).flatMap((line) => wrapCells(line || " ", Math.max(8, width - lineWidth(prefix))));
  return chunks.map((chunk, index) => `${index === 0 ? prefix : indent}${chunk}`);
}

function wrapCells(text: string, width: number) {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const char of text) {
    const size = cellWidth(char);
    if (used + size > width && current) {
      lines.push(current);
      current = char;
      used = size;
      continue;
    }
    current += char;
    used += size;
  }
  lines.push(current);
  return lines.length ? lines : [""];
}

function clipCells(text: string, width: number) {
  if (lineWidth(text) <= width) return text;
  const budget = Math.max(1, width - 1);
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = cellWidth(char);
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

function padCells(text: string, width: number) {
  const clipped = clipCells(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - lineWidth(clipped)))}`;
}

function padPainted(text: string, width: number) {
  const match = /^(\x1b\[[0-9;]*m)?([\s\S]*?)(\x1b\[0m)?$/.exec(text);
  if (!match?.[1]) return padCells(text, width);
  return `${match[1]}${padCells(match[2] ?? "", width)}${match[3] ?? ""}`;
}

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function lineWidth(text: string) {
  let width = 0;
  for (const char of stripAnsi(text)) width += cellWidth(char);
  return width;
}

function cellWidth(char: string) {
  const cp = char.codePointAt(0) ?? 0;
  if (cp <= 0x1f || cp === 0x7f) return 0;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp >= 0x2500 && cp <= 0x259f) return 1;
  if (cp >= 0x1f000) return 2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 2;
  if (cp >= 0x2b00 && cp <= 0x2bff) return 2;
  if (cp > 127) return 2;
  return 1;
}
