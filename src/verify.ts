import { runBash } from "./fs-tools.js";
import { bashEscapesWorkspace, bashHardDenied } from "./sandbox.js";

export const VERIFY_TIMEOUT_MS = 60_000;

const VERIFY_META = /[;&|`$()<>\n]/;
const VERIFY_RUNNERS = [
  /^(true|false)(\s|$)/,
  /^(npm|pnpm|yarn|bun)(\s+run)?\s+(test|tests|check|lint|typecheck|ci|tsc|vitest|jest)\b/,
  /^npx\s+(--yes\s+)?(tsc|vitest|jest|eslint|prettier)\b/,
  /^cargo\s+(test|check)\b/,
  /^go\s+test\b/,
  /^(python3?|py)\s+-m\s+(pytest|unittest)\b/,
  /^pytest\b/,
  /^node\s+--test\b/,
  /^make\s+(test|check|lint)\b/,
];

export function verifyCommandDenied(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;
  if (VERIFY_META.test(cmd)) {
    return "验证命令必须是单条简单命令，不能含管道、重定向或命令替换";
  }
  if (VERIFY_RUNNERS.some((re) => re.test(cmd))) return null;
  return "验证命令只允许测试/类型检查（如 npm test），不能当任意 bash";
}

export type VerifyReport = {
  ok: boolean;
  lines: string[];
};

export function newDoneItems(before: string[], after: string[]) {
  return after.filter((item) => !before.includes(item));
}

export async function runVerifyCommands(params: {
  workspace: string;
  commands: string[];
  signal?: AbortSignal;
}): Promise<VerifyReport> {
  const lines: string[] = [];
  let ok = true;
  for (const command of params.commands) {
    const cmd = command.trim();
    if (!cmd) continue;
    const denied = verifyCommandDenied(cmd);
    if (denied) {
      ok = false;
      lines.push(`$ ${cmd}\n拒绝: ${denied}`);
      continue;
    }
    const hard = bashHardDenied("long", cmd);
    if (hard) {
      ok = false;
      lines.push(`$ ${cmd}\n拒绝: ${hard}`);
      continue;
    }
    const escaped = bashEscapesWorkspace("long", params.workspace, params.workspace, cmd);
    if (escaped) {
      ok = false;
      lines.push(`$ ${cmd}\n拒绝: ${escaped}`);
      continue;
    }
    try {
      const output = await runBash(cmd, params.workspace, VERIFY_TIMEOUT_MS, params.signal, {
        workspace: params.workspace,
        cwd: params.workspace,
        confineWrites: true,
      });
      const failed = !/^exit=0(\n|$)/.test(output);
      if (failed) ok = false;
      lines.push(`$ ${cmd}\n${clip(output, 4_000)}`);
    } catch (error) {
      ok = false;
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`$ ${cmd}\n失败: ${message}`);
    }
  }
  if (!lines.length) {
    return { ok: true, lines: ["（没有可跑的 verifyCommands）"] };
  }
  return { ok, lines };
}

function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…`;
}
