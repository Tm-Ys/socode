import { throwIfAborted } from "./abort.js";
import { completeChat, type ChatResult } from "./chat.js";
import { executeTool, toolSpecs } from "./tools.js";
import type { Message } from "./db.js";
import type { Provider } from "./provider.js";

export const DEFAULT_MAX_AGENT_STEPS = 80;

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string };

export async function runAgent(params: {
  provider: Provider;
  messages: Message[];
  stream?: boolean;
  maxSteps?: number;
  useTools?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}): Promise<{ reply: string; trace: Message[] }> {
  const maxSteps = Math.max(1, params.maxSteps ?? DEFAULT_MAX_AGENT_STEPS);
  const messages = [...params.messages];
  const trace: Message[] = [];
  const tools = params.useTools === false ? [] : toolSpecs();

  for (let step = 0; step < maxSteps; step += 1) {
    throwIfAborted(params.signal);
    const allowTools = tools.length > 0 && step < maxSteps - 1;
    const result: ChatResult = await completeChat({
      provider: params.provider,
      messages,
      tools: allowTools ? tools : undefined,
      stream: params.stream,
      signal: params.signal,
      onDelta: (text) => params.onEvent?.({ type: "delta", text }),
    });
    throwIfAborted(params.signal);

    if (result.toolCalls.length === 0) {
      const reply = result.content.trim();
      if (!reply) throw new Error("模型没有给出最终回复");
      const assistant: Message = { role: "assistant", content: reply };
      trace.push(assistant);
      return { reply, trace };
    }

    const assistant: Message = {
      role: "assistant",
      content: result.content,
      toolCalls: result.toolCalls,
    };
    messages.push(assistant);
    trace.push(assistant);

    for (const call of result.toolCalls) {
      throwIfAborted(params.signal);
      params.onEvent?.({ type: "tool_call", name: call.name, arguments: call.arguments });
      const output = await executeTool(call.name, call.arguments, params.signal);
      throwIfAborted(params.signal);
      params.onEvent?.({ type: "tool_result", name: call.name, result: output });
      const toolMessage: Message = {
        role: "tool",
        content: output,
        toolCallId: call.id,
      };
      messages.push(toolMessage);
      trace.push(toolMessage);
    }
  }

  throw new Error(`超过最大工具步数 ${maxSteps}`);
}
