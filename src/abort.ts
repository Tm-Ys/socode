import type { Message } from "./db.js";

export class TurnAborted extends Error {
  trace: Message[] = [];
  constructor(trace: Message[] = []) {
    super("已中止");
    this.name = "TurnAborted";
    this.trace = trace;
  }
}

export class TurnFailed extends Error {
  trace: Message[] = [];
  constructor(message: string, trace: Message[] = []) {
    super(message);
    this.name = "TurnFailed";
    this.trace = trace;
  }
}

export function isTurnAborted(error: unknown) {
  if (error instanceof TurnAborted) return true;
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  const name = String((error as { name: unknown }).name);
  return name === "AbortError" || name === "TurnAborted";
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new TurnAborted();
}

/** Lone Esc. Arrow keys and other CSI sequences come as longer chunks. */
export function isEscapeKey(key: string) {
  return key === "\x1b" || key === "\x1b\x1b";
}
