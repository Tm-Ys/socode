import type { AgentMode } from "./mode.js";
import { workspaceModeLabel } from "./mode.js";
import { writeAudit } from "./audit.js";
import { askPermission, type PermissionAnswer } from "./prompt.js";
import type { TaskStore } from "./task-state.js";
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
  authorize: (name: string, args: Record<string, unknown>) => Promise<string | null>;
};

export function createPolicy(workspace: string, mode: () => AgentMode, tasks?: TaskStore): Policy {
  const grants = new Set<string>();

  return {
    get mode() {
      return mode();
    },
    workspace,
    tasks,
    async authorize(name, args) {
      const current = mode();
      const denied = await authorizeInner(current, workspace, grants, name, args);
      writeAudit({
        workspace,
        mode: current,
        tool: name,
        decision: denied ? "deny" : "allow",
        detail: denied ?? summarize(name, args),
      });
      return denied;
    },
  };
}

// Long 与 Ask 共用工作区限制：只预授权工作区内只读 read/search，以及
// classifyBash.readonly 的短命令。write/delete/git/网络/解释器仍走 y/n/a。
// 不要把 Long 当成 Full。audit P0（symlink、密钥、bash 误判史）未全部封闭前，
// 不对工作区写入做静默预授权。
async function authorizeInner(
  current: AgentMode,
  workspace: string,
  grants: Set<string>,
  name: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  if (name === "get_current_time" || name === "calculate" || name === "task_state") return null;

  if (name === "read" || name === "search") {
    const path = realExistingPath(str(args, name === "read" ? "path" : "directory"));
    const blocked = denyReason(path);
    if (blocked) return blocked;
    if (current !== "full" && !isInsideWorkspace(workspace, path)) {
      return `${workspaceModeLabel(current)} 模式只能读取工作区内的文件。路径: ${path}。需要的话请 /mode full。`;
    }
    return null;
  }

  if (name === "write") {
    const path = realExistingPath(str(args, "path"));
    return await decide(current, workspace, grants, {
      op: writeKind(path),
      path,
      detail: displayPath(workspace, path),
    });
  }

  if (name === "delete") {
    const path = realExistingPath(str(args, "path"));
    return await decide(current, workspace, grants, {
      op: "delete",
      path,
      detail: displayPath(workspace, path),
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
    if (kind.readonly) return null;
    return await decide(
      current,
      workspace,
      grants,
      {
        op: kind.op,
        path: cwd,
        detail: clip(command.replace(/\s+/g, " "), 72),
      },
      bashAlwaysAsk(command) ? undefined : `${kind.op}:${isInsideWorkspace(workspace, cwd) ? "in" : "out"}:${commandHead(command)}`,
    );
  }

  return null;
}

async function decide(
  mode: AgentMode,
  workspace: string,
  grants: Set<string>,
  req: { op: FileOp; path: string; detail: string },
  grantKey?: string,
): Promise<string | null> {
  const blocked = mutationDenied(mode, workspace, req.path, req.op);
  if (blocked) return blocked;
  if (mode === "full") return null;

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
