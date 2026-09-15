import { isTurnAborted, throwIfAborted, TurnAborted } from "./abort.js";
import {
  deleteAbsoluteFile,
  readAbsoluteFile,
  requireAbsolutePath,
  runBash,
  searchAbsoluteDir,
  writeAbsoluteFile,
} from "./fs-tools.js";
import type { AgentMode } from "./mode.js";
import type { Policy } from "./permissions.js";

export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type Tool = ToolSpec & {
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> | string;
};

const tools: Tool[] = [
  {
    name: "get_current_time",
    description: "获取当前日期和时间。可选 timezone，例如 Asia/Shanghai。",
    parameters: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA 时区名，默认 Asia/Shanghai" },
      },
    },
    execute: (args) => {
      const timezone = typeof args.timezone === "string" && args.timezone ? args.timezone : "Asia/Shanghai";
      const text = new Date().toLocaleString("zh-CN", {
        timeZone: timezone,
        hour12: false,
      });
      return `${text} (${timezone})`;
    },
  },
  {
    name: "calculate",
    description: "计算数学表达式，仅支持数字和 + - * / ( ) 。",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "例如 17 * (3 + 2)" },
      },
      required: ["expression"],
    },
    execute: (args) => {
      if (typeof args.expression !== "string") throw new Error("缺少 expression");
      return String(calculate(args.expression));
    },
  },
  {
    name: "read",
    description: "读取绝对路径文件内容。path 必须是绝对路径。可选 offset/limit 按行截取。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "绝对文件路径，例如 /Users/me/proj/src/index.ts" },
        offset: { type: "integer", description: "起始行号，从 1 开始" },
        limit: { type: "integer", description: "最多读取行数" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const path = str(args, "path");
      return await readAbsoluteFile(path, num(args, "offset"), num(args, "limit"));
    },
  },
  {
    name: "write",
    description: "把内容写入绝对路径文件。path 必须是绝对路径，必要时创建父目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "绝对文件路径" },
        content: { type: "string", description: "要写入的完整文件内容" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => {
      const path = str(args, "path");
      if (typeof args.content !== "string") throw new Error("缺少 content");
      requireAbsolutePath(path, "path");
      return await writeAbsoluteFile(path, args.content);
    },
  },
  {
    name: "delete",
    description: "删除绝对路径文件。只能删文件，不能删目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的绝对文件路径" },
      },
      required: ["path"],
    },
    execute: async (args) => {
      const path = str(args, "path");
      requireAbsolutePath(path, "path");
      return await deleteAbsoluteFile(path);
    },
  },
  {
    name: "bash",
    description: "在绝对目录下执行 bash 命令。cwd 必须是已存在的绝对目录。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 bash 命令" },
        cwd: { type: "string", description: "绝对工作目录，例如 /Users/me/proj" },
      },
      required: ["command", "cwd"],
    },
    execute: async (args, signal) => runBash(str(args, "command"), str(args, "cwd"), 30_000, signal),
  },
  {
    name: "search",
    description: "在绝对目录中搜索文本。directory 必须是已存在的绝对目录。pattern 为正则。",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", description: "绝对目录路径" },
        pattern: { type: "string", description: "搜索正则，例如 runAgent" },
        glob: { type: "string", description: "可选文件名过滤，例如 *.ts" },
      },
      required: ["directory", "pattern"],
    },
    execute: async (args, signal) => {
      const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
      return await searchAbsoluteDir(str(args, "directory"), str(args, "pattern"), glob, signal);
    },
  },
];

const READ_TOOLS = new Set(["read", "search", "calculate", "get_current_time"]);

export function toolSpecs(mode?: AgentMode): ToolSpec[] {
  return tools
    .filter((tool) => mode !== "plan" || READ_TOOLS.has(tool.name))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export async function executeTool(
  name: string,
  rawArgs: string,
  signal?: AbortSignal,
  policy?: Policy,
): Promise<string> {
  throwIfAborted(signal);
  const tool = tools.find((item) => item.name === name);
  if (!tool) return `未知工具: ${name}`;
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return `工具参数不是合法 JSON: ${rawArgs}`;
  }
  try {
    if (policy?.mode === "plan" && !READ_TOOLS.has(name)) {
      return `权限拒绝: 当前是 Plan 模式，不能使用 ${name}。请只给出计划，或让用户输入 /mode ask 或 /mode full。`;
    }
    if (policy) {
      const denied = await policy.authorize(name, args);
      if (denied) return denied.startsWith("权限拒绝") ? denied : `权限拒绝: ${denied}`;
    }
    throwIfAborted(signal);
    if (name === "bash") {
      return await runBash(str(args, "command"), str(args, "cwd"), 30_000, signal, {
        workspace: policy?.workspace ?? process.cwd(),
        confineWrites: policy?.mode !== "full",
      });
    }
    return await tool.execute(args, signal);
  } catch (error) {
    if (isTurnAborted(error) || signal?.aborted) throw new TurnAborted();
    const message = error instanceof Error ? error.message : String(error);
    return `工具执行失败: ${message}`;
  }
}

function str(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${key}`);
  return value;
}

function num(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function calculate(input: string): number {
  const source = input.replace(/\s+/g, "");
  if (!source || source.length > 80) throw new Error("表达式无效或过长");
  let i = 0;
  const peek = () => source[i];
  const eat = () => source[i++];

  const parseExpression = (): number => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = eat();
      const right = parseTerm();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      const right = parseFactor();
      if (op === "/" && right === 0) throw new Error("除数不能为 0");
      value = op === "*" ? value * right : value / right;
    }
    return value;
  };

  const parseFactor = (): number => {
    if (peek() === "+") {
      eat();
      return parseFactor();
    }
    if (peek() === "-") {
      eat();
      return -parseFactor();
    }
    if (peek() === "(") {
      eat();
      const value = parseExpression();
      if (eat() !== ")") throw new Error("括号不匹配");
      return value;
    }
    return parseNumber();
  };

  const parseNumber = (): number => {
    const start = i;
    while (peek() && /[0-9.]/.test(peek())) i += 1;
    if (start === i) throw new Error("表达式无效");
    const value = Number(source.slice(start, i));
    if (!Number.isFinite(value)) throw new Error("数字无效");
    return value;
  };

  const value = parseExpression();
  if (i !== source.length || !Number.isFinite(value)) throw new Error("表达式无效");
  return value;
}
