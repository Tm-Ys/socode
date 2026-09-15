import { isTurnAborted, throwIfAborted, TurnAborted } from "./abort.js";
import type { ToolSpec } from "./tools.js";
import type { Message, ToolCall } from "./db.js";
import { chatCompletionsUrl, type Provider } from "./provider.js";

export type { ToolCall };

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
};

type ChatCompletion = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
};

export async function completeChat(params: {
  provider: Provider;
  messages: Message[];
  tools?: ToolSpec[];
  stream?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}): Promise<ChatResult> {
  throwIfAborted(params.signal);
  const stream = params.stream ?? true;
  const body: Record<string, unknown> = {
    model: params.provider.model,
    messages: params.messages.map(toApiMessage),
    stream,
  };
  if (params.provider.maxOutput > 0) {
    body.max_tokens = params.provider.maxOutput;
  }
  if (params.provider.thinkingEffort !== "none") {
    body.reasoning_effort = params.provider.thinkingEffort;
  }
  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(params.provider.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.provider.api}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
  } catch (error) {
    if (params.signal?.aborted || isTurnAborted(error)) throw new TurnAborted();
    throw error;
  }

  if (!stream) {
    return await readJsonReply(response, params.onDelta, params.signal);
  }

  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }

  if (!response.body) {
    throw new Error("响应缺少 body，无法流式读取");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && !contentType.includes("event-stream")) {
    return await readJsonReply(response, params.onDelta, params.signal);
  }

  const result = await readSseReply(response.body, params.onDelta, params.signal);
  if (!result.content.trim() && result.toolCalls.length === 0) {
    throwIfAborted(params.signal);
    throw new Error("流式响应缺少内容");
  }
  return result;
}

function toApiMessage(message: Message) {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

async function readJsonReply(
  response: Response,
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  throwIfAborted(signal);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted || isTurnAborted(error)) throw new TurnAborted();
    throw error;
  }
  let data: ChatCompletion;
  try {
    data = JSON.parse(text) as ChatCompletion;
  } catch {
    throw new Error(`非 JSON 响应 (${response.status}): ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    throw new Error(data.error?.message ?? `HTTP ${response.status}: ${text.slice(0, 400)}`);
  }
  const message = data.choices?.[0]?.message;
  const content = message?.content ?? "";
  const toolCalls = (message?.tool_calls ?? [])
    .map((call) => ({
      id: call.id ?? "",
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }))
    .filter((call) => call.id && call.name);
  if (!content.trim() && toolCalls.length === 0) {
    throw new Error(`响应缺少内容: ${text.slice(0, 400)}`);
  }
  if (content) onDelta?.(content);
  return {
    content,
    toolCalls,
    finishReason: data.choices?.[0]?.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop"),
  };
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
  signal?: AbortSignal,
): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const result: ChatResult = { content: "", toolCalls: [], finishReason: "stop" };
  const pending = new Map<number, ToolCall>();

  const consume = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) applySseLine(line, result, pending, onDelta);
  };

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    onAbort();
    throw new TurnAborted();
  }
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
    applySseLine(buffer, result, pending, onDelta);
  } catch (error) {
    if (signal?.aborted || isTurnAborted(error)) throw new TurnAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);

  result.toolCalls = [...pending.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => call)
    .filter((call) => call.id && call.name);
  if (result.toolCalls.length > 0 && result.finishReason === "stop") {
    result.finishReason = "tool_calls";
  }
  return result;
}

function applySseLine(
  line: string,
  result: ChatResult,
  pending: Map<number, ToolCall>,
  onDelta?: (text: string) => void,
) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return;

  let chunk: ChatCompletion;
  try {
    chunk = JSON.parse(data) as ChatCompletion;
  } catch {
    return;
  }
  if (chunk.error?.message) {
    throw new Error(chunk.error.message);
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) result.finishReason = choice.finish_reason;

  const delta = choice.delta;
  if (!delta) return;
  if (typeof delta.content === "string" && delta.content) {
    result.content += delta.content;
    onDelta?.(delta.content);
  }
  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0;
    const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
    if (call.id) current.id = call.id;
    if (call.function?.name) current.name = call.function.name;
    if (call.function?.arguments) current.arguments += call.function.arguments;
    pending.set(index, current);
  }
}
