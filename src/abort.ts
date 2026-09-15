export class TurnAborted extends Error {
  constructor() {
    super("已中止");
    this.name = "TurnAborted";
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
