import { paintMode, modeLabel, type AgentMode } from "./mode.js";
import { displayWorkarea } from "./workarea.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

export const WELCOME_LINES = [
  "把难的事先做完，剩下的会自己让路。",
  "先读再改。猜出来的补丁最贵。",
  "今天也从最小可核对的一步开始。",
  "问清楚再动手，比返工体面。",
  "一次只改一件事，事后才找得到。",
  "测试绿了才算做完，注释绿了不算。",
  "工作区里的文件比记忆可靠。",
  "长任务靠勾选，不靠感觉。",
  "权限问一声，总比回滚便宜。",
  "先 search，再 read，最后才 write。",
  "空白的会话，正好用来做对的那件。",
  "能 grep 到的，就不必假装记得。",
  "小补丁，大声说改了什么。",
  "失败要停手，换方法，不要加参数。",
  "上下文是租来的，别把仓库塞进去。",
  "Ask 一声，总比 Full 后悔轻。",
  "计划写下来，手才不会飘。",
  "目标如果不能一句话说完，就先拆。",
  "读不懂的地方，比写得快的地方更值得停。",
  "工具是手，判断还是你的。",
  "提交信息写给三个月后的自己。",
  "别修顺路看到的，除非它挡路。",
  "命名清楚，注释就可以少写。",
  "先让它对，再让它快。",
  "未知的文件先打开，再发表看法。",
  "一次对话只追求一个清楚的结果。",
  "输入 / 就能找到路，不必把菜单背下来。",
  "新会话，旧习惯：看一眼工作区再动手。",
  "代码在磁盘上，结论要能指回文件。",
  "少承诺，多交付一行能跑的。",
  "今天不炫技，只把缺口补上。",
  "有测试的地方，让测试先说话。",
  "目录结构也是文档。",
  "你提需求，我翻仓库。",
  "慢一点，指到那一行。",
  "会停的人，才改得动大东西。",
  "先写能回滚的，再写漂亮的。",
  "终端够用。花活以后再说。",
  "不要把整份历史背下来，去搜。",
  "做完再说下一步。没有下一步也可以。",
  "Ready when you are.",
  "Small diffs. Clear reasons.",
  "Read the file. Then touch it.",
  "One milestone, then the next.",
  "Ship the boring fix first.",
  "If it is not in the repo, we don't know it.",
  "Type less. Point at the path.",
  "Start where the test is red.",
  "The workspace is the source of truth.",
  "Keep the blast radius small.",
  "Quiet tools. Loud results.",
  "Make something we can grep later.",
];

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
}) {
  const color = params.color ?? false;
  const width = Math.max(44, Math.min(72, params.width ?? 60));
  const inner = width - 4;
  const dim = color ? DIM : "";
  const reset = color ? RESET : "";
  const welcome = params.welcome ?? pickWelcome();
  const session = (params.title ?? "").trim() || "新会话";
  const place = displayWorkarea(params.workspace);
  const mode = `${paintMode(params.mode, modeLabel(params.mode), color)} · ${session}`;
  const wordmark = color ? `${BOLD}${CYAN}socode${RESET}` : "socode";

  const rows: string[] = ["", ...wrapLine(welcome, inner).map((line) => paintWelcome(line, color)), "", place, mode];
  if ((params.mcpCount ?? 0) > 0) {
    rows.push(`${dim}MCP ${params.mcpCount} 个工具${reset}`);
  }
  rows.push("");

  const paint = { dim, reset };
  const box = drawBox(wordmark, rows, width, paint, inner);
  const hint = `${dim}  / 看命令 · Esc 中止 · Ctrl+C 两次退出${reset}`;
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
