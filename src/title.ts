import { completeChat } from "./chat.js";
import type { ConversationRow } from "./db.js";
import type { Provider } from "./provider.js";
import type { TokenUsage } from "./usage.js";

const DEFAULT_TITLE = "新会话";

export function isDefaultTitle(title: string) {
  const text = title.trim();
  return !text || text === DEFAULT_TITLE;
}

export function statusSessionLabel(title: string) {
  return isDefaultTitle(title) ? "new" : title.trim();
}

export function displayTitle(row: { title: string; first_user?: string | null }) {
  if (!isDefaultTitle(row.title)) return row.title.trim();
  const first = row.first_user?.replace(/\s+/g, " ").trim() ?? "";
  if (!first) return DEFAULT_TITLE;
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

export function sanitizeTitle(raw: string, fallback: string) {
  const text = raw
    .split("\n")[0]
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/^标题[:：]\s*/, "")
    .trim();
  if (!text) return fallback.slice(0, 24) || DEFAULT_TITLE;
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

export async function generateTitle(params: {
  provider: Provider;
  userText: string;
  assistantText: string;
}): Promise<{ title: string; usage?: TokenUsage }> {
  const fallback = params.userText.replace(/\s+/g, " ").trim().slice(0, 24) || DEFAULT_TITLE;
  try {
    const result = await completeChat({
      provider: { ...params.provider, maxOutput: Math.min(256, params.provider.maxOutput) },
      stream: false,
      messages: [
        {
          role: "system",
          content: "为这段对话起一个不超过16个字的中文标题。只输出标题本身，不要引号、标点解释或换行。",
        },
        {
          role: "user",
          content: `用户：${params.userText.slice(0, 200)}\n助手：${params.assistantText.slice(0, 200)}`,
        },
      ],
    });
    return { title: sanitizeTitle(result.content, fallback), usage: result.usage };
  } catch {
    return { title: fallback };
  }
}

export function formatConversationList(rows: ConversationRow[], currentId?: string) {
  if (rows.length === 0) return "没有可恢复的会话。";
  return rows
    .map((row, index) => {
      const mark = row.id === currentId ? "*" : " ";
      const time = formatTime(row.updated_at);
      return `${mark}${String(index + 1).padStart(2)}. ${displayTitle(row)}  ${time}`;
    })
    .join("\n");
}

function formatTime(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}
