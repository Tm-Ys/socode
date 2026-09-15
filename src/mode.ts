import type { Message } from "./db.js";

export const AGENT_MODES = ["full", "ask", "plan"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export const HARNESS_MODE_PREFIX = "【harness mode】";

const ALIASES: Record<string, AgentMode> = {
  full: "full",
  "full-access": "full",
  unrestricted: "full",
  open: "full",
  ask: "ask",
  permission: "ask",
  approve: "ask",
  "ask-for-permission": "ask",
  plan: "plan",
  plans: "plan",
  readonly: "plan",
  "read-only": "plan",
};

export function isAgentMode(value: string): value is AgentMode {
  return (AGENT_MODES as readonly string[]).includes(value);
}

export function parseMode(input: string): AgentMode | null {
  const key = input.trim().toLowerCase().replace(/\s+/g, "-");
  return ALIASES[key] ?? null;
}

const RESET = "\x1b[0m";
const MODE_COLOR = {
  full: "\x1b[1;33m",
  ask: "\x1b[1;34m",
  plan: "\x1b[1;32m",
} as const;

export function modeLabel(mode: AgentMode) {
  if (mode === "full") return "Full Access";
  if (mode === "plan") return "Plan";
  return "Ask";
}

export function paintMode(mode: AgentMode, text: string, tty = Boolean(process.stdout.isTTY)) {
  if (!tty) return text;
  return `${MODE_COLOR[mode]}${text}${RESET}`;
}

export function assistantPrefix(mode: AgentMode, tty = Boolean(process.stdout.isTTY)) {
  return `${paintMode(mode, `socoding on ${modeLabel(mode)} mode`, tty)} `;
}

export function userPrefix(mode: AgentMode, tty = Boolean(process.stdout.isTTY)) {
  const name = mode === "full" ? "full access mode" : mode === "plan" ? "plan mode" : "ask mode";
  return `${paintMode(mode, `${name} >`, tty)} `;
}

export function modeHint(mode: AgentMode) {
  if (mode === "full") return "可改文件和跑命令，仍禁止系统目录与密钥文件";
  if (mode === "plan") return "只能阅读和拟定计划，不能改文件或执行有副作用的命令";
  return "创建/修改/删除和 git 会先询问，仅限工作区内；工作区外写入请改用 /mode full";
}

export function modeRules(mode: AgentMode) {
  if (mode === "plan") {
    return "你只能阅读代码和拟定计划，不能改文件、不能创建/删除文件、不能运行有副作用的命令。可用 `read` / `search` / `calculate` / `get_current_time`。把步骤写成计划，等用户 `/mode ask` 或 `/mode full` 后再动手。";
  }
  if (mode === "full") {
    return "可以直接在工作区写文件和执行命令。不要碰系统目录和密钥文件。破坏性操作前仍要确认用户意图。";
  }
  return "创建、修改、删除文件仅限工作区内，会先征得用户同意（y 允许 / n 拒绝 / a 本会话同类一律允许）。所有 git 命令同样要先问。不能在工作区外写文件、删文件或把有副作用的 bash cwd 放到工作区外；需要区外权限时让用户 `/mode full`。被拒绝后不要换一种方式硬做，改为说明并给计划。";
}

export function modeInstruction(mode: AgentMode) {
  return `${HARNESS_MODE_PREFIX}${mode}\n当前 socode harness 处于 ${modeLabel(mode)} 模式。${modeRules(mode)} 以本条消息为准；若之后还有更新的【harness mode】，以最新一条为准。`;
}

export function harnessModeMessage(mode: AgentMode): Message {
  return { role: "system", content: modeInstruction(mode) };
}

export function isHarnessModeMessage(message: Message) {
  return message.role === "system" && message.content.startsWith(HARNESS_MODE_PREFIX);
}

export function parseHarnessMode(message: Message): AgentMode | null {
  if (!isHarnessModeMessage(message)) return null;
  const token = message.content.slice(HARNESS_MODE_PREFIX.length).split(/\s|\n/)[0]?.trim() ?? "";
  return isAgentMode(token) ? token : parseMode(token);
}

export function lastHarnessMode(messages: Message[]): AgentMode | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const parsed = parseHarnessMode(messages[i]);
    if (parsed) return parsed;
  }
}

export function insertCurrentMode(messages: Message[], mode: AgentMode): Message[] {
  if (lastHarnessMode(messages) === mode) return messages;
  const notice = harnessModeMessage(mode);
  const last = messages.at(-1);
  if (last?.role === "user") return [...messages.slice(0, -1), notice, last];
  return [...messages, notice];
}

export function loadMode(raw?: string): AgentMode {
  if (raw !== undefined && raw !== "") {
    const parsed = parseMode(raw);
    if (!parsed) throw new Error(`未知模式: ${raw}（用 full / ask / plan）`);
    return parsed;
  }
  return parseMode(process.env.MODE ?? "") ?? "ask";
}
