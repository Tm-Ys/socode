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
import { formatSubagentPlan, parseSubagentPlan } from "./subagent-plan.js";
import { formatTaskStateCli, patchFromToolArgs } from "./task-state.js";

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
  {
    name: "task_state",
    description:
      "更新长程任务状态 TaskState。可设置 goal/notes，替换 milestones/done/failures/key_files/verify_commands，或用 add_* 追加一项。只在 Long 模式使用。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "当前总目标" },
        notes: { type: "string", description: "给后续轮次看的备注" },
        milestones: { type: "array", items: { type: "string" }, description: "未完成里程碑（替换）" },
        done: { type: "array", items: { type: "string" }, description: "已完成项（替换）" },
        failures: { type: "array", items: { type: "string" }, description: "失败与卡点（替换）" },
        key_files: { type: "array", items: { type: "string" }, description: "关键文件路径（替换）" },
        verify_commands: { type: "array", items: { type: "string" }, description: "验证命令（替换）" },
        add_milestone: { type: "string" },
        add_done: { type: "string" },
        add_failure: { type: "string" },
        add_key_file: { type: "string" },
        add_verify_command: { type: "string" },
      },
    },
    execute: () => {
      throw new Error("task_state 需要会话上下文");
    },
  },
  {
    name: "subagent_plan",
    description:
      "规划要派出的子代理。先调用本工具，再调用 subagent 执行。agents 为 1–6 项，每项 kind=explorer（只读调研）或 worker（可改文件），prompt 必须自洽（子代理看不到父对话）。",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "为什么拆成多个子代理" },
        agents: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", description: "explorer 或 worker" },
              label: { type: "string", description: "短名，便于对照结果" },
              prompt: { type: "string", description: "给该子代理的完整任务说明" },
            },
            required: ["prompt"],
          },
        },
      },
      required: ["agents"],
    },
    execute: () => {
      throw new Error("subagent_plan 需要会话上下文");
    },
  },
  {
    name: "subagent",
    description:
      "按最近一次 subagent_plan 执行子代理。不传参数则按顺序跑完全部 pending；传 index 只跑其中一个。每个子代理独立上下文，只把摘要返回给你。",
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", description: "1-based，只执行规划里的这一项" },
        retry: { type: "boolean", description: "true 时重跑已完成项" },
      },
    },
    execute: () => {
      throw new Error("subagent 需要会话上下文");
    },
  },
];

const READ_TOOLS = new Set(["read", "search", "calculate", "get_current_time"]);

export function toolSpecs(
  mode?: AgentMode,
  opts?: { nested?: boolean; role?: "explorer" | "worker" },
): ToolSpec[] {
  return tools
    .filter((tool) => {
      if (opts?.nested && (tool.name === "subagent_plan" || tool.name === "subagent")) return false;
      if (tool.name === "task_state") return mode === "long" && !opts?.nested;
      if (opts?.role === "explorer") return READ_TOOLS.has(tool.name);
      if (mode === "plan") return READ_TOOLS.has(tool.name);
      return true;
    })
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
      return `权限拒绝: 当前是 Plan 模式，不能使用 ${name}。请只给出计划，或让用户输入 /mode ask、/mode long 或 /mode full。`;
    }
    if (name === "task_state" && policy?.mode !== "long") {
      return "权限拒绝: task_state 只在 Long 模式下可用。请先 /mode long。";
    }
    if ((name === "subagent_plan" || name === "subagent") && policy?.nested) {
      return "权限拒绝: 子代理不能再派生子代理（max_depth=1）";
    }
    if (policy) {
      const denied = await policy.authorize(name, args);
      if (denied) return denied.startsWith("权限拒绝") ? denied : `权限拒绝: ${denied}`;
    }
    throwIfAborted(signal);
    if (name === "task_state") {
      if (!policy?.tasks) return "工具执行失败: 当前会话没有任务状态";
      const next = policy.tasks.patch(patchFromToolArgs(args));
      return formatTaskStateCli(next);
    }
    if (name === "subagent_plan") {
      if (!policy?.subagents) return "工具执行失败: 当前会话没有子代理规划器";
      const plan = policy.subagents.setPlan(parseSubagentPlan(args));
      return formatSubagentPlan(plan);
    }
    if (name === "subagent") {
      if (!policy?.spawnSubagent) return "工具执行失败: 子代理运行器未配置";
      return await policy.spawnSubagent(args, signal);
    }
    if (name === "bash") {
      return await runBash(str(args, "command"), str(args, "cwd"), 30_000, signal, {
        workspace: policy?.workspace ?? process.cwd(),
        cwd: str(args, "cwd"),
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
