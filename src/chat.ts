import { isTurnAborted, throwIfAborted, TurnAborted } from "./abort.js";
import type { ToolSpec } from "./tools.js";
import type { Message, ToolCall } from "./db.js";
import { chatCompletionsUrl, type Provider } from "./provider.js";
import {
  PROVIDER_MAX_ATTEMPTS,
  providerBackoffMs,
  retryableProviderFailure,
  retryableStatus,
  TransientProviderError,
  waitForRetry,
} from "./retry.js";
import { absorbChatDelta, finishThinkStream, newThinkStream, type ThinkStream } from "./think.js";

export type { ToolCall };

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
};

export type ChatResult = {
  content: string;
  thinking?: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: TokenUsage;
};

export type ChatStreamHandlers = {
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
};

type ChatCompletion = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: Record<string, unknown> & {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: Record<string, unknown> & {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export async function completeChat(params: {
  provider: Provider;
  messages: Message[];
  tools?: ToolSpec[];
  stream?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
  sleepForRetry?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): Promise<ChatResult> {
  const maxAttempts = PROVIDER_MAX_ATTEMPTS;
  const sleep = params.sleepForRetry ?? waitForRetry;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    throwIfAborted(params.signal);
    try {
      return await completeChatOnce(params);
    } catch (error) {
      lastError = error;
      if (isTurnAborted(error)) throw new TurnAborted();
      const retryable = retryableProviderFailure(error);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      const retryAfter = error instanceof TransientProviderError ? error.retryAfter : null;
      await sleep(providerBackoffMs(attempt, retryAfter), params.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function completeChatOnce(params: {
  provider: Provider;
  messages: Message[];
  tools?: ToolSpec[];
  stream?: boolean;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onThinking?: (text: string) => void;
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
  if (stream) {
    body.stream_options = { include_usage: true };
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
    const message = error instanceof Error ? error.message : String(error);
    throw retryableProviderFailure(error) ? new TransientProviderError(message) : error;
  }

  const handlers: ChatStreamHandlers = {
    onDelta: params.onDelta,
    onThinking: params.onThinking,
  };

  if (!stream) {
    return await readJsonReply(response, handlers, params.signal);
  }

  if (!response.ok) {
    throw await httpFailure(response);
  }

  if (!response.body) {
    throw new Error("响应缺少 body，无法流式读取");
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && !contentType.includes("event-stream")) {
    return await readJsonReply(response, handlers, params.signal);
  }

  const result = await readSseReply(response.body, handlers, params.signal);
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
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<ChatResult> {
  throwIfAborted(signal);
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted || isTurnAborted(error)) throw new TurnAborted();
    const message = error instanceof Error ? error.message : String(error);
    throw retryableProviderFailure(error) ? new TransientProviderError(message) : error;
  }
  let data: ChatCompletion;
  try {
    data = JSON.parse(text) as ChatCompletion;
  } catch {
    throw new Error(`非 JSON 响应 (${response.status}): ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    const message = data.error?.message ?? `HTTP ${response.status}: ${text.slice(0, 400)}`;
    throw retryableStatus(response.status)
      ? new TransientProviderError(message, response.headers.get("retry-after"))
      : new Error(message);
  }
  const message = data.choices?.[0]?.message;
  const stream = newThinkStream();
  const result: ChatResult = { content: "", toolCalls: [], finishReason: "stop" };
  emitChatParts(result, absorbChatDelta(stream, message), handlers);
  emitChatParts(result, finishThinkStream(stream), handlers);
  const toolCalls = (message?.tool_calls ?? [])
    .map((call) => ({
      id: call.id ?? "",
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }))
    .filter((call) => call.id && call.name);
  if (!result.content.trim() && toolCalls.length === 0) {
    throw new Error(`响应缺少内容: ${text.slice(0, 400)}`);
  }
  return {
    ...result,
    toolCalls,
    finishReason: data.choices?.[0]?.finish_reason ?? (toolCalls.length ? "tool_calls" : "stop"),
    usage: parseUsage(data.usage),
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

async function httpFailure(response: Response) {
  const message = await errorMessage(response);
  return retryableStatus(response.status)
    ? new TransientProviderError(message, response.headers.get("retry-after"))
    : new Error(message);
}

async function readSseReply(
  body: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const result: ChatResult = { content: "", toolCalls: [], finishReason: "stop" };
  const pending = new Map<number, ToolCall>();
  const stream = newThinkStream();

  const consume = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) applySseLine(line, result, pending, stream, handlers);
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
    applySseLine(buffer, result, pending, stream, handlers);
    emitChatParts(result, finishThinkStream(stream), handlers);
  } catch (error) {
    if (signal?.aborted || isTurnAborted(error)) throw new TurnAborted();
    const started = Boolean(result.content || result.thinking || pending.size);
    if (!started && retryableProviderFailure(error)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientProviderError(message);
    }
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
  stream: ThinkStream,
  handlers: ChatStreamHandlers,
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

  const usage = parseUsage(chunk.usage);
  if (usage) result.usage = usage;

  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) result.finishReason = choice.finish_reason;

  const delta = choice.delta;
  if (!delta) return;
  emitChatParts(result, absorbChatDelta(stream, delta), handlers);
  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0;
    const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
    if (call.id) current.id = call.id;
    if (call.function?.name) current.name = call.function.name;
    if (call.function?.arguments) current.arguments += call.function.arguments;
    pending.set(index, current);
  }
}

function emitChatParts(
  result: ChatResult,
  parts: { thinking: string; text: string },
  handlers: ChatStreamHandlers,
) {
  if (parts.thinking) {
    result.thinking = `${result.thinking ?? ""}${parts.thinking}`;
    handlers.onThinking?.(parts.thinking);
  }
  if (parts.text) {
    result.content += parts.text;
    handlers.onDelta?.(parts.text);
  }
}

function parseUsage(raw?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage | undefined {
  if (!raw) return undefined;
  const promptTokens = Number(raw.prompt_tokens ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? 0);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return undefined;
  if (promptTokens <= 0 && completionTokens <= 0) return undefined;
  return {
    promptTokens: Math.max(0, promptTokens),
    completionTokens: Math.max(0, completionTokens),
  };
}
