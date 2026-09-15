import type { Message } from "./db.js";

type ChatCompletion = {
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string };
  }>;
  error?: { message?: string };
};

export async function completeChat(params: {
  url: string;
  api: string;
  model: string;
  messages: Message[];
  stream?: boolean;
  onDelta?: (text: string) => void;
}): Promise<string> {
  const stream = params.stream ?? true;
  const response = await fetch(params.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.api}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream,
    }),
  });

  if (!stream) {
    const content = await readJsonReply(response);
    params.onDelta?.(content);
    return content;
  }

  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  if (!response.body) {
    throw new Error("响应缺少 body，无法流式读取");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && !contentType.includes("event-stream")) {
    const content = await readJsonReply(response);
    params.onDelta?.(content);
    return content;
  }

  const reply = await readSseReply(response.body, params.onDelta);
  if (!reply.trim()) {
    throw new Error("流式响应缺少内容");
  }
  return reply;
}

async function readJsonReply(response: Response) {
  const text = await response.text();
  let data: ChatCompletion;
  try {
    data = JSON.parse(text) as ChatCompletion;
  } catch {
    throw new Error(`非 JSON 响应 (${response.status}): ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    throw new Error(data.error?.message ?? `HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`响应缺少内容: ${text.slice(0, 400)}`);
  }
  return content;
}

async function errorMessage(response: Response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text) as ChatCompletion;
    return data.error?.message ?? `HTTP ${response.status}: ${text.slice(0, 400)}`;
  } catch {
    return `HTTP ${response.status}: ${text.slice(0, 400)}`;
  }
}

async function readSseReply(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  const consume = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const delta = parseSseLine(line);
      if (!delta) continue;
      reply += delta;
      onDelta?.(delta);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    consume(decoder.decode(value, { stream: true }));
  }
  consume(decoder.decode());

  const tail = parseSseLine(buffer);
  if (tail) {
    reply += tail;
    onDelta?.(tail);
  }

  return reply;
}

function parseSseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return "";
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return "";

  let chunk: ChatCompletion;
  try {
    chunk = JSON.parse(data) as ChatCompletion;
  } catch {
    return "";
  }
  if (chunk.error?.message) {
    throw new Error(chunk.error.message);
  }
  return chunk.choices?.[0]?.delta?.content ?? "";
}
