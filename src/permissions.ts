import type { AgentMode } from "./mode.js";
import { workspaceModeLabel } from "./mode.js";
import { writeAudit } from "./audit.js";
import { askPermission, type PermissionAnswer } from "./prompt.js";
import {
  logLongApprove,
  type LongApproveRequest,
  type LongApprover,
} from "./long-approve.js";
import type { McpHub } from "./mcp.js";
import { isMcpTool } from "./mcp.js";
import type { SubagentStore } from "./subagent-plan.js";
import type { TaskStore } from "./task-state.js";
import type { PlanStore } from "./plan.js";
import {
  bashAlwaysAsk,
  bashEscapesWorkspace,
  bashHardDenied,
  classifyBash,
  commandHead,
  denyReason,
  displayPath,
  isInsideWorkspace,
  mutationDenied,
  opLabel,
  realExistingPath,
  writeKind,
  type FileOp,
} from "./sandbox.js";

export type Policy = {
  mode: AgentMode;
  workspace: string;
  tasks?: TaskStore;
  plans?: PlanStore;
  nested?: boolean;
  role?: "explorer" | "worker";
  subagents?: SubagentStore;
  spawnSubagent?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  mcp?: McpHub;
  longApprove?: LongApprover;
  authorize: (name: string, args: Record<string, unknown>) => Promise<string | null>;
};

export type PolicyHooks = {
  longApprove?: LongApprover;
  nested?: boolean;
  role?: "explorer" | "worker";
  subagents?: SubagentStore;
  spawnSubagent?: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  mcp?: McpHub;
  plans?: PlanStore;
};

export function createPolicy(
  workspace: string | (() => string),
  mode: () => AgentMode,
  tasks?: TaskStore,
  hooks?: PolicyHooks,
): Policy {
  const grants = new Set<string>();
  const getWorkspace = typeof workspace === "function" ? workspace : () => workspace;

  return {
    get mode() {
      return mode();
    },
    get workspace() {
      return getWorkspace();
    },
    tasks,
    plans: hooks?.plans,
    nested: Boolean(hooks?.nested),
    role: hooks?.role,
    subagents: hooks?.subagents,
    spawnSubagent: hooks?.spawnSubagent,
    mcp: hooks?.mcp,
    longApprove: hooks?.longApprove,
    async authorize(name, args) {
      const current = mode();
      const currentWorkspace = getWorkspace();
      const denied = await authorizeInner(current, currentWorkspace, grants, name, args, tasks, hooks);
      writeAudit({
        workspace: currentWorkspace,
        mode: current,
        tool: name,
        decision: denied ? "deny" : "allow",
        detail: denied ?? summarize(name, args),
      });
      return denied;
    },
  };
}

// Long：工作区只读仍本地预授权。副作用不走用户 y/n，也不盲目放行，
// 而是独立 LLM 审批（见 long-approve.ts）。本地先硬拒绝密钥/区外/sudo。
// Ask/Full/Plan 不使用该审批器。
async function authorizeInner(
  current: AgentMode,
  workspace: string,
  grants: Set<string>,
  name: string,
  args: Record<string, unknown>,
  tasks?: TaskStore,
  hooks?: PolicyHooks,
): Promise<string | null> {
  if (name === "get_current_time" || name === "calculate" || name === "task_state" || name === "plan") return null;

  if (name === "subagent_plan" || name === "subagent") {
    if (current === "plan") {
      return "Plan 模式不能派生子代理。请只给出计划，或让用户输入 /mode ask、/mode long 或 /mode full。";
    }
    if (hooks?.nested) return "子代理不能再派生子代理（max_depth=1）";
    return null;
  }

  if (hooks?.role === "explorer" && (name === "write" || name === "edit" || name === "delete")) {
    return "explorer 子代理是只读的，不能写或删文件";
  }

  if (name === "read" || name === "search") {
    const path = realExistingPath(str(args, name === "read" ? "path" : "directory"));
    const blocked = denyReason(path);
    if (blocked) return blocked;
    if (current !== "full" && !isInsideWorkspace(workspace, path)) {
      return `${workspaceModeLabel(current)} 模式只能读取工作区内的文件。路径: ${path}。需要的话请 /mode full。`;
    }
    return null;
  }

  if (name === "write" || name === "edit") {
    const path = realExistingPath(str(args, "path"));
    return await decide(current, workspace, grants, {
      op: writeKind(path),
      path,
      detail: displayPath(workspace, path),
      tool: name,
      args,
      tasks,
      hooks,
    });
  }

  if (name === "delete") {
    const path = realExistingPath(str(args, "path"));
    return await decide(current, workspace, grants, {
      op: "delete",
      path,
      detail: displayPath(workspace, path),
      tool: name,
      args,
      tasks,
      hooks,
    });
  }

  if (name === "bash") {
    const cwd = realExistingPath(str(args, "cwd"));
    const command = str(args, "command");
    const blocked = denyReason(cwd);
    if (blocked) return blocked;
    if (current !== "full" && !isInsideWorkspace(workspace, cwd)) {
      return `${workspaceModeLabel(current)} 模式只能在工作区内执行命令。cwd: ${cwd}。需要的话请 /mode full。`;
    }
    if (current === "plan") {
      return "当前是 Plan 模式，不能执行命令。请只给出计划，或让用户输入 /mode ask、/mode long 或 /mode full 后再执行。";
    }
    const hard = bashHardDenied(current, command);
    if (hard) return hard;
    const escaped = bashEscapesWorkspace(current, workspace, cwd, command);
    if (escaped) return escaped;
    const kind = classifyBash(command);
    if (hooks?.role === "explorer" && !kind.readonly) {
      return "explorer 子代理是只读的，不能执行有副作用的命令";
    }
    if (kind.readonly) return null;
    return await decide(
      current,
      workspace,
      grants,
      {
        op: kind.op,
        path: cwd,
        detail: clip(command.replace(/\s+/g, " "), 72),
        tool: name,
        args,
        tasks,
        hooks,
      },
      bashAlwaysAsk(command) ? undefined : `${kind.op}:${isInsideWorkspace(workspace, cwd) ? "in" : "out"}:${commandHead(command)}`,
    );
  }

  if (isMcpTool(name) || hooks?.mcp?.has(name)) {
    if (!hooks?.mcp?.has(name)) return `未知 MCP 工具: ${name}`;
    const readOnly = hooks.mcp.isReadOnly(name);
    if (current === "plan" && !readOnly) {
      return "Plan 模式不能调用有副作用的 MCP 工具。只读 MCP 可用，或让用户 /mode ask、/mode long 或 /mode full。";
    }
    if (hooks.role === "explorer" && !readOnly) {
      return "explorer 子代理是只读的，不能调用有副作用的 MCP 工具";
    }
    if (readOnly || current === "full") return null;
    return await decide(
      current,
      workspace,
      grants,
      {
        op: "exec",
        path: workspace,
        detail: clip(`${name} ${JSON.stringify(args)}`.replace(/\s+/g, " "), 72),
        tool: name,
        args,
        tasks,
        hooks,
      },
      `mcp:${name}`,
    );
  }

  return null;
}

async function decide(
  mode: AgentMode,
  workspace: string,
  grants: Set<string>,
  req: {
    op: FileOp;
    path: string;
    detail: string;
    tool: string;
    args: Record<string, unknown>;
    tasks?: TaskStore;
    hooks?: PolicyHooks;
  },
  grantKey?: string,
): Promise<string | null> {
  const blocked = mutationDenied(mode, workspace, req.path, req.op);
  if (blocked) return blocked;
  if (mode === "full") return null;

  if (mode === "long") {
    return await longSideEffect(workspace, req);
  }

  const inside = isInsideWorkspace(workspace, req.path);
  const key = grantKey ?? `${req.op}:${inside ? "in" : "out"}`;
  if (grants.has(key)) return null;

  const zone = inside ? "工作区内" : "工作区外";
  const answer: PermissionAnswer = await askPermission(
    `${opLabel(req.op)}  ${req.detail}`,
    `${zone}  ${req.path}`,
  );
  if (answer === "deny") return `用户拒绝了${opLabel(req.op)}: ${req.detail}`;
  if (answer === "always") grants.add(key);
  return null;
}

async function longSideEffect(
  workspace: string,
  req: {
    op: FileOp;
    detail: string;
    tool: string;
    args: Record<string, unknown>;
    tasks?: TaskStore;
    hooks?: PolicyHooks;
  },
): Promise<string | null> {
  const payload: LongApproveRequest = {
    tool: req.tool,
    args: req.args,
    workspace,
    goal: req.tasks?.get().goal,
  };
  if (!req.hooks?.longApprove) {
    return `Long 审批器未配置，已拒绝${opLabel(req.op)}: ${req.detail}`;
  }
  let verdict;
  try {
    verdict = await req.hooks.longApprove(payload);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    verdict = { allow: false as const, reason: `审批调用失败: ${reason}` };
  }
  logLongApprove(req.tool, verdict);
  writeAudit({
    workspace,
    mode: "long",
    tool: req.tool,
    decision: verdict.allow ? "allow" : "deny",
    detail: `judge ${verdict.allow ? "allow" : "deny"}: ${verdict.reason}`.slice(0, 200),
  });
  if (!verdict.allow) {
    return `Long 审批拒绝: ${verdict.reason}`;
  }
  return null;
}

function str(args: Record<string, unknown>, key: string) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`缺少 ${key}`);
  return value;
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summarize(name: string, args: Record<string, unknown>) {
  const path = args.path ?? args.directory ?? args.cwd ?? args.command;
  return typeof path === "string" ? `${name} ${path}`.slice(0, 120) : name;
}
