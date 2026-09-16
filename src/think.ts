const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"];
const CLOSE_TAGS = ["</think>", "</thinking>", "</reasoning>"];

export type ThinkSplitState = {
  mode: "text" | "think";
  hold: string;
};

export type ThinkStream = {
  split: ThinkSplitState;
  dedicated: boolean;
};

export function newThinkSplitState(): ThinkSplitState {
  return { mode: "text", hold: "" };
}

export function newThinkStream(): ThinkStream {
  return { split: newThinkSplitState(), dedicated: false };
}

export function splitThinkChunk(state: ThinkSplitState, chunk: string): { thinking: string; text: string } {
  const src = `${state.hold}${chunk}`;
  state.hold = "";
  let thinking = "";
  let text = "";
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const tags = state.mode === "think" ? CLOSE_TAGS : OPEN_TAGS;
    const hit = findTag(rest, tags);
    if (hit) {
      const piece = rest.slice(0, hit.index);
      if (state.mode === "think") thinking += piece;
      else text += piece;
      i += hit.index + hit.len;
      state.mode = state.mode === "think" ? "text" : "think";
      continue;
    }
    const hold = trailingPartial(rest, tags);
    const piece = rest.slice(0, rest.length - hold);
    if (state.mode === "think") thinking += piece;
    else text += piece;
    state.hold = rest.slice(rest.length - hold);
    break;
  }
  return { thinking, text };
}

export function flushThinkSplit(state: ThinkSplitState): { thinking: string; text: string } {
  const leftover = state.hold;
  state.hold = "";
  if (!leftover) return { thinking: "", text: "" };
  if (state.mode === "think") return { thinking: leftover, text: "" };
  return { thinking: "", text: leftover };
}

export function absorbChatDelta(stream: ThinkStream, delta: unknown): { thinking: string; text: string } {
  const rec = asRecord(delta);
  if (!rec) return { thinking: "", text: "" };
  let thinking = "";
  const dedicated = reasoningFromUnknown(rec);
  if (dedicated) {
    stream.dedicated = true;
    thinking += dedicated;
  }
  const content = typeof rec.content === "string" ? rec.content : "";
  let text = "";
  if (content) {
    const parts = splitThinkChunk(stream.split, content);
    if (!stream.dedicated) thinking += parts.thinking;
    text += parts.text;
  }
  return { thinking, text };
}

export function finishThinkStream(stream: ThinkStream): { thinking: string; text: string } {
  const parts = flushThinkSplit(stream.split);
  if (stream.dedicated) return { thinking: "", text: parts.text };
  return parts;
}

export function reasoningFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const rec = value as Record<string, unknown>;
  for (const key of ["reasoning_content", "thinking", "reasoning_text", "thought"]) {
    if (typeof rec[key] === "string" && rec[key]) return rec[key];
  }
  return reasoningValue(rec.reasoning);
}

function reasoningValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => reasoningValue(item)).join("");
  }
  if (!value || typeof value !== "object") return "";
  const rec = value as Record<string, unknown>;
  if (typeof rec.content === "string" && rec.content) return rec.content;
  if (typeof rec.text === "string" && rec.text) return rec.text;
  if (Array.isArray(rec.summary)) return rec.summary.map((item) => reasoningValue(item)).join("");
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function findTag(src: string, tags: string[]): { index: number; len: number } | null {
  const lower = src.toLowerCase();
  let best: { index: number; len: number } | null = null;
  for (const tag of tags) {
    const index = lower.indexOf(tag);
    if (index < 0) continue;
    if (!best || index < best.index) best = { index, len: tag.length };
  }
  return best;
}

function trailingPartial(src: string, tags: string[]): number {
  const max = Math.max(...tags.map((tag) => tag.length));
  const start = Math.max(0, src.length - (max - 1));
  const lower = src.toLowerCase();
  for (let i = start; i < src.length; i += 1) {
    const slice = lower.slice(i);
    if (tags.some((tag) => tag.startsWith(slice))) return src.length - i;
  }
  return 0;
}
