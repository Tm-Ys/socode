import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuditDecision = "allow" | "deny" | "always" | "readonly" | "sandbox";

export function writeAudit(params: {
  workspace: string;
  mode: string;
  tool: string;
  decision: string;
  detail: string;
}) {
  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    mode: params.mode,
    tool: params.tool,
    decision: params.decision,
    detail: params.detail.slice(0, 200),
  })}\n`;
  const file = join(params.workspace, ".socode-audit.jsonl");
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, line, { encoding: "utf8" });
  } catch {
    // audit must never break the turn
  }
}
