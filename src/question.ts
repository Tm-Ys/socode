export const CUSTOM_LABEL = "Type your own answer";
export const SUBMIT_LABEL = "提交答案";

const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 8;
const CATCH_ALL = new Set([
  "type your own answer",
  "other",
  "other...",
  "其它",
  "其他",
  "自定义",
  "自己输入",
  "submit answers",
  "submit",
  "提交答案",
  "提交",
]);

export type QuestionOption = {
  label: string;
  description: string;
};

export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple: boolean;
};

export type QuestionnaireState = {
  questions: QuestionInfo[];
  tab: number;
  selected: number;
  answers: string[][];
  custom: string[];
  draft: string;
  editing: boolean;
};

export type QuestionOutcome = string[][] | "reject" | "unavailable";

export type QuestionKeyResult =
  | { type: "state"; state: QuestionnaireState }
  | { type: "submit"; answers: string[][] }
  | { type: "reject" };

export function parseQuestions(args: Record<string, unknown>): QuestionInfo[] {
  if (!Array.isArray(args.questions)) throw new Error("缺少 questions");
  if (args.questions.length < 1) throw new Error("至少需要 1 个问题");
  if (args.questions.length > MAX_QUESTIONS) throw new Error(`最多 ${MAX_QUESTIONS} 个问题`);
  return args.questions.map((raw, index) => parseQuestion(raw, index));
}

export function isSingleQuestion(questions: QuestionInfo[]) {
  return questions.length === 1 && questions[0]?.multiple !== true;
}

export function tabCount(questions: QuestionInfo[]) {
  return questions.length === 1 ? 1 : questions.length + 1;
}

export function isConfirmTab(state: QuestionnaireState) {
  return state.questions.length > 1 && state.tab === state.questions.length;
}

export function optionCount(question: QuestionInfo) {
  return question.options.length + 1 + (question.multiple ? 1 : 0);
}

export function isCustomIndex(question: QuestionInfo, selected: number) {
  return selected === question.options.length;
}

export function isSubmitIndex(question: QuestionInfo, selected: number) {
  return question.multiple && selected === question.options.length + 1;
}

export function filledAnswers(state: QuestionnaireState) {
  return state.questions.map((_, index) => [...(state.answers[index] ?? [])]);
}

export function createQuestionnaireState(questions: QuestionInfo[]): QuestionnaireState {
  if (!questions.length) throw new Error("至少需要 1 个问题");
  return {
    questions,
    tab: 0,
    selected: 0,
    answers: questions.map(() => []),
    custom: questions.map(() => ""),
    draft: "",
    editing: false,
  };
}

export function applyQuestionKey(state: QuestionnaireState, raw: string): QuestionKeyResult {
  const key = raw === "\r\n" || raw === "\n" ? "\r" : raw;
  if (state.editing) return applyEditingKey(state, key);
  if (isEscape(key)) return { type: "reject" };
  if (isConfirmTab(state)) return applyConfirmKey(state, key);
  if (key === "\t" || key === "\x1b[C" || key === "l") return keep(selectTab(state, 1));
  if (key === "\x1b[Z" || key === "\x1b[D" || key === "h") return keep(selectTab(state, -1));
  const question = state.questions[state.tab];
  if (!question) return keep(state);
  const total = optionCount(question);
  if (key === "\x1b[A" || key === "k") return keep(moveSelected(state, -1, total));
  if (key === "\x1b[B" || key === "j") return keep(moveSelected(state, 1, total));
  if (key === "\r") return selectOption(state);
  const digit = /^[1-9]$/.exec(key);
  if (digit) {
    const index = Number(digit[0]) - 1;
    if (index >= total) return keep(state);
    return selectOption({ ...clone(state), selected: index });
  }
  return keep(state);
}

export function formatQuestionResult(questions: QuestionInfo[], answers: string[][]) {
  const lines = questions.map((question, index) => {
    const value = answers[index]?.length ? answers[index].join(", ") : "（未答）";
    return `- ${question.header}: ${value}`;
  });
  const formatted = questions
    .map((question, index) => {
      const value = answers[index]?.length ? answers[index].join(", ") : "Unanswered";
      return `"${question.question}"="${value}"`;
    })
    .join(", ");
  return `${lines.join("\n")}\n\nUser has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

export function formatQuestionFrame(state: QuestionnaireState, opts?: { color?: boolean; columns?: number }) {
  const color = Boolean(opts?.color);
  const columns = Math.max(40, opts?.columns ?? 80);
  const yellow = color ? "\x1b[33m" : "";
  const dim = color ? "\x1b[2m" : "";
  const bold = color ? "\x1b[1m" : "";
  const cyan = color ? "\x1b[36m" : "";
  const reset = color ? "\x1b[0m" : "";
  const lines: string[] = [];
  const total = state.questions.length;
  lines.push(`${yellow}? 问卷${reset}${total > 1 ? `  ${Math.min(state.tab + 1, total)}/${total}` : ""}`);

  if (state.questions.length > 1) {
    const tabs = state.questions.map((question, index) => {
      const active = index === state.tab;
      const answered = (state.answers[index]?.length ?? 0) > 0;
      const label = clip(question.header, 16);
      const mark = answered ? "*" : "";
      const body = `${label}${mark}`;
      return active ? `${bold}${cyan}${body}${reset}` : `${dim}${body}${reset}`;
    });
    const confirmActive = isConfirmTab(state);
    tabs.push(confirmActive ? `${bold}${cyan}Confirm${reset}` : `${dim}Confirm${reset}`);
    lines.push(`  ${tabs.join("  ")}`);
    lines.push("");
  }

  if (isConfirmTab(state)) {
    lines.push(`${bold}Review${reset}`);
    for (const [index, question] of state.questions.entries()) {
      const value = state.answers[index]?.length ? state.answers[index].join(", ") : "（未答）";
      lines.push(`  ${question.header}: ${value}`);
    }
    lines.push("");
    lines.push(`  ${dim}enter 提交   tab 返回   esc 取消${reset}`);
    return lines.join("\n");
  }

  const question = state.questions[state.tab];
  if (!question) return lines.join("\n");
  const suffix = question.multiple ? " (可多选)" : "";
  lines.push(`${question.question}${suffix}`);
  lines.push("");

  for (const [index, option] of question.options.entries()) {
    lines.push(...optionLines(question, state, index, option.label, option.description, columns, { bold, dim, reset }));
  }
  const customDesc = state.editing ? `> ${state.draft}` : (state.custom[state.tab] ?? "").trim();
  lines.push(...optionLines(question, state, question.options.length, CUSTOM_LABEL, customDesc, columns, { bold, dim, reset }));
  if (question.multiple) {
    lines.push(...optionLines(question, state, question.options.length + 1, SUBMIT_LABEL, "", columns, { bold, dim, reset }));
  }
  lines.push("");
  lines.push(`  ${dim}${footerHint(state)}${reset}`);
  return lines.join("\n");
}

function parseQuestion(raw: unknown, index: number): QuestionInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`问题 ${index + 1} 无效`);
  const item = raw as Record<string, unknown>;
  const question = trimStr(item.question);
  if (!question) throw new Error(`问题 ${index + 1} 缺少 question`);
  const header = clip(trimStr(item.header) || `Q${index + 1}`, 30);
  if (!Array.isArray(item.options)) throw new Error(`问题 ${index + 1} 缺少 options`);
  const options: QuestionOption[] = [];
  for (const entry of item.options) {
    const option = parseOption(entry);
    if (!option) continue;
    if (isCatchAll(option.label)) continue;
    options.push(option);
    if (options.length >= MAX_OPTIONS) break;
  }
  if (!options.length) throw new Error(`问题 ${index + 1} 至少需要一个预设选项`);
  return {
    question,
    header,
    options,
    multiple: item.multiple === true,
  };
}

function parseOption(raw: unknown): QuestionOption | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  const label = trimStr(item.label);
  if (!label) return undefined;
  return { label: clip(label, 48), description: trimStr(item.description) };
}

function isCatchAll(label: string) {
  return CATCH_ALL.has(label.trim().toLowerCase());
}

function applyConfirmKey(state: QuestionnaireState, key: string): QuestionKeyResult {
  if (key === "\r") return { type: "submit", answers: filledAnswers(state) };
  if (key === "\t" || key === "\x1b[C" || key === "l") return keep(selectTab(state, 1));
  if (key === "\x1b[Z" || key === "\x1b[D" || key === "h") return keep(selectTab(state, -1));
  return keep(state);
}

function applyEditingKey(state: QuestionnaireState, key: string): QuestionKeyResult {
  if (isEscape(key)) return keep({ ...clone(state), editing: false, draft: "" });
  if (key === "\r") return submitCustom(state);
  if (key === "\x7f" || key === "\b") {
    const next = clone(state);
    next.draft = [...next.draft].slice(0, -1).join("");
    return keep(next);
  }
  if (key.startsWith("\x1b")) return keep(state);
  if (key === "\x03" || key === "\x04") return keep(state);
  if (![...key].every((ch) => ch >= " " || ch === "\t")) return keep(state);
  const next = clone(state);
  next.draft = `${next.draft}${key}`.slice(0, 200);
  return keep(next);
}

function submitCustom(state: QuestionnaireState): QuestionKeyResult {
  const question = state.questions[state.tab];
  if (!question) return keep({ ...clone(state), editing: false, draft: "" });
  const text = state.draft.trim();
  const previous = state.custom[state.tab] ?? "";
  if (!text) {
    const next = clone(state);
    if (previous) {
      next.answers[next.tab] = (next.answers[next.tab] ?? []).filter((item) => item !== previous);
      next.custom[next.tab] = "";
    }
    next.editing = false;
    next.draft = "";
    return keep(next);
  }
  if (question.multiple) {
    const next = clone(state);
    const existing = [...(next.answers[next.tab] ?? [])];
    if (previous) {
      const at = existing.indexOf(previous);
      if (at !== -1) existing.splice(at, 1);
    }
    if (!existing.includes(text)) existing.push(text);
    next.answers[next.tab] = existing;
    next.custom[next.tab] = text;
    next.editing = false;
    next.draft = "";
    return keep(next);
  }
  return pick(state, text, true);
}

function selectOption(state: QuestionnaireState): QuestionKeyResult {
  const question = state.questions[state.tab];
  if (!question) return keep(state);
  if (isSubmitIndex(question, state.selected)) return confirmMultiple(state);
  if (isCustomIndex(question, state.selected)) {
    if (!question.multiple) return keep(beginEdit(state));
    const value = state.custom[state.tab] ?? "";
    if (value && (state.answers[state.tab] ?? []).includes(value)) return keep(toggleAnswer(state, value));
    return keep(beginEdit(state));
  }
  const option = question.options[state.selected];
  if (!option) return keep(state);
  if (question.multiple) return keep(toggleAnswer(state, option.label));
  return pick(state, option.label);
}

function confirmMultiple(state: QuestionnaireState): QuestionKeyResult {
  const next = clone(state);
  next.editing = false;
  next.draft = "";
  if (next.questions.length === 1) return { type: "submit", answers: filledAnswers(next) };
  next.tab += 1;
  next.selected = 0;
  return keep(next);
}

function pick(state: QuestionnaireState, answer: string, custom = false): QuestionKeyResult {
  const next = clone(state);
  next.answers[next.tab] = [answer];
  if (custom) next.custom[next.tab] = answer;
  next.editing = false;
  next.draft = "";
  if (isSingleQuestion(next.questions)) return { type: "submit", answers: filledAnswers(next) };
  next.tab += 1;
  next.selected = 0;
  return keep(next);
}

function toggleAnswer(state: QuestionnaireState, answer: string) {
  const next = clone(state);
  const existing = [...(next.answers[next.tab] ?? [])];
  const at = existing.indexOf(answer);
  if (at === -1) existing.push(answer);
  else existing.splice(at, 1);
  next.answers[next.tab] = existing;
  return next;
}

function selectTab(state: QuestionnaireState, delta: number) {
  const next = clone(state);
  const total = tabCount(next.questions);
  next.tab = (next.tab + delta + total) % total;
  next.selected = 0;
  next.editing = false;
  next.draft = "";
  return next;
}

function beginEdit(state: QuestionnaireState) {
  const next = clone(state);
  next.editing = true;
  next.draft = next.custom[next.tab] ?? "";
  return next;
}

function moveSelected(state: QuestionnaireState, delta: number, total: number) {
  const next = clone(state);
  next.selected = (next.selected + delta + total) % total;
  return next;
}

function optionLines(
  question: QuestionInfo,
  state: QuestionnaireState,
  index: number,
  label: string,
  description: string,
  columns: number,
  paint: { bold: string; dim: string; reset: string },
) {
  const active = state.selected === index;
  const submit = isSubmitIndex(question, index);
  const custom = isCustomIndex(question, index);
  const picked = question.multiple
    ? !submit &&
      (state.answers[state.tab] ?? []).includes(custom ? (state.custom[state.tab] ?? "") : label) &&
      (!custom || Boolean((state.custom[state.tab] ?? "").trim()))
    : (state.answers[state.tab] ?? []).includes(label);
  const marker = active ? ">" : " ";
  const box = question.multiple && !submit ? `[${picked ? "x" : " "}] ` : "";
  const tick = !question.multiple && picked ? " ✓" : "";
  const head = `${index + 1}. ${marker} ${box}${label}${tick}`;
  const lines = [`  ${active ? paint.bold : ""}${head}${active ? paint.reset : ""}`];
  if (description.trim()) {
    lines.push(`       ${paint.dim}${clip(description.trim(), Math.max(20, columns - 10))}${paint.reset}`);
  }
  return lines;
}

function footerHint(state: QuestionnaireState) {
  if (state.editing) return "enter 提交自定义   esc 取消输入";
  const current = state.questions[state.tab];
  if (current && isSubmitIndex(current, state.selected)) {
    return "↑↓ 选择   1-9 快捷   enter 提交答案   tab 下一题   esc 取消";
  }
  if (current?.multiple) return "↑↓ 选择   1-9 快捷   enter 勾选   tab 下一题   esc 取消";
  return "↑↓ 选择   1-9 快捷   enter 确认   tab 下一题   esc 取消";
}

function clone(state: QuestionnaireState): QuestionnaireState {
  return {
    questions: state.questions,
    tab: state.tab,
    selected: state.selected,
    answers: state.answers.map((item) => [...item]),
    custom: [...state.custom],
    draft: state.draft,
    editing: state.editing,
  };
}

function keep(state: QuestionnaireState): QuestionKeyResult {
  return { type: "state", state };
}

function isEscape(key: string) {
  return key === "\x1b" || key === "\x1b\x1b";
}

function trimStr(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  return `${[...text].slice(0, Math.max(1, max - 1)).join("")}…`;
}
