import { completeChat } from "./chat.js";
import type { Message } from "./db.js";
import { listProviders, type Provider } from "./provider.js";

export const LONG_APPROVE_TIMEOUT_MS = 12_000;

export type JudgeVerdict = {
  allow: boolean;
  reason: string;
};

export type LongApproveRequest = {
  tool: string;
  args: Record<string, unknown>;
  workspace: string;
  goal?: string;
};

export type LongApprover = (req: LongApproveRequest) => Promise<JudgeVerdict>;

export type ChatFn = (params: {
  provider: Provider;
  messages: Message[];
  stream?: boolean;
  signal?: AbortSignal;
}) => Promise<{ content: string }>;

export const JUDGE_SYSTEM_PROMPT = `你是 socode Long 模式的权限审批器，不是对话助手。
只根据这一条独立请求判断：是否允许当前副作用操作。没有聊天历史，不要猜测用户稍后会解释。

必须拒绝：
- 工作区外写入、删除、重定向、cwd
- 密钥与受保护文件（.env、providers.json、~/.ssh、云凭证、/etc/passwd 等）
- sudo/su、破坏性命令（rm -rf、mkfs、dd、fork bomb、覆盖 git 历史）
- 无明确必要的网络（curl/wget）、把密钥打到 stdout、反弹 shell
- 与给定任务目标无关、或目标为空却要改仓库

可以允许：工作区内、与目标直接相关、可逆的小范围编辑或测试命令。

只输出一个 JSON 对象，不要 markdown、不要解释性前后文。字段：
{"allow": true或false, "reason": "一句中文原因"}
也接受中文键：{"允许": false, "原因": "..."}。
allow 必须是 JSON 布尔，不是字符串。`;

export function parseJudgeReply(text: string): JudgeVerdict {
  const trimmed = text.trim();
  if (!trimmed) return failClosed("审批结果为空");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return failClosed("审批结果不是 JSON");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return failClosed("JSON 解析失败");
  }
  const allow = data.allow ?? data.Allow ?? data["允许"];
  if (typeof allow !== "boolean") return failClosed("缺少布尔字段 allow/允许");
  const reason = String(data.reason ?? data.Reason ?? data["原因"] ?? data["理由"] ?? "").trim();
  if (!reason) return failClosed("缺少 reason/原因");
  return { allow, reason: reason.slice(0, 300) };
}

export function pickJudgeProvider(base: Provider): Provider {
  const model = (process.env.LONG_APPROVE_MODEL ?? process.env.JUDGE_MODEL ?? "").trim();
  const named = listProviders(base).find((item) => /^(judge|fast|cheap|mini)$/i.test(item.name));
  const source =
    named && named.url && named.api
      ? named
      : base;
  return {
    ...source,
    model: model || source.model,
    thinkingEffort: "none",
    maxOutput: Math.min(256, Math.max(64, source.maxOutput || 256)),
  };
}

export function summarizeApproveArgs(name: string, args: Record<string, unknown>) {
  if (name === "bash") {
    return {
      cwd: str(args.cwd),
      command: clip(str(args.command), 500),
    };
  }
  if (name === "write") {
    const content = typeof args.content === "string" ? args.content : "";
    return {
      path: str(args.path),
      bytes: Buffer.byteLength(content, "utf8"),
      preview: clip(content, 400),
    };
  }
  if (name === "delete") return { path: str(args.path) };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "content" && typeof value === "string") {
      out.bytes = Buffer.byteLength(value, "utf8");
      out.preview = clip(value, 200);
      continue;
    }
    out[key] = typeof value === "string" ? clip(value, 240) : value;
  }
  return out;
}

export function formatJudgeUser(req: LongApproveRequest) {
  return [
    `mode: long`,
    `workspace: ${req.workspace}`,
    `goal: ${req.goal?.trim() || "(empty)"}`,
    `tool: ${req.tool}`,
    `arguments: ${JSON.stringify(summarizeApproveArgs(req.tool, req.args))}`,
  ].join("\n");
}

export async function judgeLongApprove(
  req: LongApproveRequest,
  params: {
    provider: Provider;
    complete?: ChatFn;
    timeoutMs?: number;
  },
): Promise<JudgeVerdict> {
  if (!params.provider.url || !params.provider.api || !params.provider.model) {
    return failClosed("审批器缺少 Provider");
  }
  const timeoutMs = params.timeoutMs ?? LONG_APPROVE_TIMEOUT_MS;
  const complete = params.complete ?? defaultComplete;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await complete({
      provider: pickJudgeProvider(params.provider),
      stream: false,
      signal: controller.signal,
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: formatJudgeUser(req) },
      ],
    });
    return parseJudgeReply(result.content ?? "");
  } catch (error) {
    const aborted =
      (typeof error === "object" && error && "name" in error && String((error as { name: unknown }).name) === "AbortError") ||
      (error instanceof Error && /aborted|超时|timeout/i.test(error.message));
    return failClosed(aborted ? "审批超时" : `审批调用失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function createLongApprover(
  provider: () => Provider,
  complete?: ChatFn,
): LongApprover {
  return (req) => judgeLongApprove(req, { provider: provider(), complete });
}

export function logLongApprove(tool: string, verdict: JudgeVerdict) {
  const mark = verdict.allow ? "allow" : "deny";
  console.log(`long-approve ${mark}  ${tool}  ${verdict.reason}`);
}

function defaultComplete(params: {
  provider: Provider;
  messages: Message[];
  stream?: boolean;
  signal?: AbortSignal;
}) {
  return completeChat(params);
}

function failClosed(reason: string): JudgeVerdict {
  return { allow: false, reason };
}

function str(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
