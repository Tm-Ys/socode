import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paintMode, modeLabel, type AgentMode } from "./mode.js";
import { displayWorkarea } from "./workarea.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

export const WELCOME_LINES = [
  "你知道吗？输入 / 会按前缀列出命令，Tab 补全。",
  "你知道吗？Ask 审批 write/edit/delete 会打出完整 diff，y 允许、n 拒绝、a 本会话同类都允许。",
  "你知道吗？/undo 只撤回最近一轮 write/edit/delete，快照落在本工作区 .socode/undo，关进程后还能撤；不管 bash，也不是把对话倒回去。",
  "你知道吗？每轮结束会打 tokens（含缓存）；标价默认从 models.dev 换成人民币，主模型 / 子代理 / 标题 / Recap / 审批 / 压缩可各自定价。",
  "你知道吗？/doctor 检查 Node、密钥、沙箱和目录能不能写；启动也可用 --doctor。",
  "你知道吗？/mode plan 只能看代码和写计划，不会改文件，也不会跑有副作用的命令。",
  "你知道吗？/mode full 会直接改仓库、跑命令；系统目录和密钥文件仍然碰不到。",
  "你知道吗？/mode long 或 /mode 长程 适合跨很多步的任务；副作用由独立 LLM 审批，不会变成 Full。",
  "你知道吗？/provider 列出已保存的适配，Enter 切换，e 编辑，n 新增。",
  "你知道吗？/model 用左右键换 Provider，上下键换模型。",
  "你知道吗？思考强度请用 /effort 调，不要走 /provider edit。",
  "你知道吗？/new 开新会话；没有聊过的空对话不会写入磁盘。",
  "你知道吗？/session 或 /chat 可以恢复本工作区 .socode/sessions 里的历史对话。",
  "你知道吗？/context 用色块标出 system、工具、对话和还剩多少窗口。",
  "你知道吗？上下文挤了可以 /compress，会保留最近两轮，并钉住当前模式、任务状态和计划。",
  "你知道吗？Long 下 /task 查看目标；也可用 /task goal、/task milestone、/task note、/task clear。",
  "你知道吗？/mcp 查看已连接的 MCP 服务器和工具。",
  "你知道吗？/skills 列出已注入的 AGENTS.md / CLAUDE.md 和发现的 Skills。",
  "你知道吗？子代理过程默认藏着，/seesubagent 列出，/seesubagent 1 盯着某一个。",
  "你知道吗？/seeplan 看当前任务勾选板；/setplan 说明 会强制本轮先拆计划。",
  "你知道吗？空对话时 /setworkarea 可选文件夹，或写成 /setworkarea /绝对路径。",
  "你知道吗？/remote-ssh 连过的主机可以 Tab 补全；密码每次都要重新输入。",
  "你知道吗？打 /ssh 再按 Tab 会补成 /remote-ssh。",
  "你知道吗？连着 SSH 时请用 /sshquit 断开，它会先删掉远端注入的 Provider。",
  "你知道吗？生成中按 Esc 中止当前轮；用户那句还在，半截回复不会入库。",
  "你知道吗？Ctrl+C 第一次只是提醒，再按一次才退出；平时用 /quit 更干净。",
];

let cachedVersion = "";

export function packageVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim()) {
      cachedVersion = pkg.version.trim();
      return cachedVersion;
    }
  } catch {
    // fall through
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

export function bannerTitle(version = packageVersion()) {
  return `socode @ ${version} presented by Tm-Ys`;
}

export function pickWelcome(rand: () => number = Math.random) {
  const n = WELCOME_LINES.length;
  const index = Math.min(n - 1, Math.max(0, Math.floor(rand() * n)));
  return WELCOME_LINES[index] ?? WELCOME_LINES[0];
}

export function formatBanner(params: {
  workspace: string;
  title?: string;
  mode: AgentMode;
  mcpCount?: number;
  welcome?: string;
  width?: number;
  color?: boolean;
  remoteHost?: string;
  remoteHome?: string;
}) {
  const color = params.color ?? false;
  const version = packageVersion();
  const titleText = bannerTitle(version);
  const width = Math.max(lineWidth(titleText) + 8, 44, Math.min(72, params.width ?? 60));
  const inner = width - 4;
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  const welcome = params.welcome ?? pickWelcome();
  const session = (params.title ?? "").trim() || "新会话";
  const place = params.remoteHost
    ? `ssh@${params.remoteHost}  ${displayWorkarea(params.workspace, params.remoteHome)}`
    : displayWorkarea(params.workspace, params.remoteHome);
  const mode = `${paintMode(params.mode, modeLabel(params.mode), color)} · ${session}`;
  const wordmark = color
    ? `${BOLD}${CYAN}socode${RESET}${DIM} @ ${version} presented by Tm-Ys${RESET}`
    : titleText;

  const rows: string[] = ["", ...wrapLine(welcome, inner).map((line) => paintWelcome(line, color)), "", place, mode];
  if ((params.mcpCount ?? 0) > 0) {
    rows.push(`${dim}MCP ${params.mcpCount} 个工具${reset}`);
  }
  rows.push("");

  const paint = { dim, reset };
  const box = drawBox(wordmark, rows, width, paint, inner);
  const hint = params.remoteHost
    ? `${dim}  / 看命令 · Esc 中止 · /sshquit 断开远程${reset}`
    : `${dim}  / 看命令 · Esc 中止 · Ctrl+C 两次退出${reset}`;
  return `${box}\n${hint}`;
}

function paintWelcome(text: string, color: boolean) {
  if (!color) return text;
  return `${DIM}${ITALIC}${text}${RESET}`;
}

function drawBox(
  title: string,
  rows: string[],
  width: number,
  paint: { dim: string; reset: string },
  inner: number,
) {
  const titleWidth = lineWidth(title);
  const dash = Math.max(1, width - titleWidth - 5);
  const top = `${paint.dim}╭─ ${paint.reset}${title}${paint.dim} ${"─".repeat(dash)}╮${paint.reset}`;
  const bottom = `${paint.dim}╰${"─".repeat(width - 2)}╯${paint.reset}`;
  const middle = rows.map((row) => `${paint.dim}│${paint.reset} ${padRow(row, inner)} ${paint.dim}│${paint.reset}`);
  return [top, ...middle, bottom].join("\n");
}

function wrapLine(text: string, width: number) {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const char of text) {
    const size = charWidth(char);
    if (used + size > width && current) {
      lines.push(current);
      current = char;
      used = size;
      continue;
    }
    current += char;
    used += size;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function padRow(text: string, width: number) {
  const clipped = clipAnsi(text, width);
  return `${clipped}${" ".repeat(Math.max(0, width - lineWidth(clipped)))}`;
}

function clipAnsi(text: string, width: number) {
  if (lineWidth(text) <= width) return text;
  const budget = Math.max(1, width - 1);
  let out = "";
  let used = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const seq = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
      if (seq) {
        out += seq[0];
        i += seq[0].length;
        continue;
      }
    }
    const char = text[i];
    const size = charWidth(char);
    if (used + size > budget) break;
    out += char;
    used += size;
    i += 1;
  }
  return `${out}…`;
}

function lineWidth(text: string) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) width += charWidth(char);
  return width;
}

function charWidth(char: string) {
  if (char === "·" || char === "…") return 1;
  const cp = char.codePointAt(0) ?? 0;
  if (cp <= 127) return 1;
  if (cp >= 0x2500 && cp <= 0x259f) return 1;
  return 2;
}
