import type { AgentMode } from "./mode.js";
import { askPermission, type PermissionAnswer } from "./prompt.js";
import {
  classifyBash,
  denyReason,
  displayPath,
  isInsideWorkspace,
  opLabel,
  resolvePath,
  writeKind,
  type FileOp,
} from "./sandbox.js";

export type Policy = {
  mode: AgentMode;
  authorize: (name: string, args: Record<string, unknown>) => Promise<string | null>;
};

export function createPolicy(workspace: string, mode: () => AgentMode): Policy {
  const grants = new Set<string>();

  return {
    get mode() {
      return mode();
    },
    async authorize(name, args) {
      const current = mode();
      if (name === "get_current_time" || name === "calculate") return null;

      if (name === "read" || name === "search") {
        const path = resolvePath(str(args, name === "read" ? "path" : "directory"));
        return denyReason(path);
      }

      if (name === "write") {
        const path = resolvePath(str(args, "path"));
        return await decide(current, workspace, grants, {
          op: writeKind(path),
          path,
          detail: displayPath(workspace, path),
        });
      }

      if (name === "delete") {
        const path = resolvePath(str(args, "path"));
        return await decide(current, workspace, grants, {
          op: "delete",
          path,
          detail: displayPath(workspace, path),
        });
      }

      if (name === "bash") {
        const cwd = resolvePath(str(args, "cwd"));
        const command = str(args, "command");
        const blocked = denyReason(cwd);
        if (blocked) return blocked;
        if (current === "plan") {
          return "当前是 Plan 模式，不能执行命令。请只给出计划，或让用户输入 /mode ask 或 /mode full 后再执行。";
        }
        const kind = classifyBash(command);
        if (kind.readonly) return null;
        return await decide(current, workspace, grants, {
          op: kind.op,
          path: cwd,
          detail: clip(command.replace(/\s+/g, " "), 72),
        });
      }

      return null;
    },
  };
}

async function decide(
  mode: AgentMode,
  workspace: string,
  grants: Set<string>,
  req: { op: FileOp; path: string; detail: string },
): Promise<string | null> {
  const blocked = denyReason(req.path);
  if (blocked) return blocked;

  if (mode === "plan") {
    return `当前是 Plan 模式，不能${opLabel(req.op)}。请只给出计划，或让用户输入 /mode ask 或 /mode full 后再执行。`;
  }
  if (mode === "full") return null;

  const inside = isInsideWorkspace(workspace, req.path);
  const key = `${req.op}:${inside ? "in" : "out"}`;
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
