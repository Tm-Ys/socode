import { isTurnAborted, throwIfAborted, TurnAborted } from "./abort.js";

export const PROVIDER_MAX_ATTEMPTS = 3;
export const PROVIDER_BASE_DELAY_MS = 400;
export const PROVIDER_MAX_DELAY_MS = 8_000;

export class TransientProviderError extends Error {
  retryAfter: string | null;
  constructor(message: string, retryAfter: string | null = null) {
    super(message);
    this.name = "TransientProviderError";
    this.retryAfter = retryAfter;
  }
}

export function retryableStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function retryableProviderFailure(error: unknown) {
  if (isTurnAborted(error)) return false;
  if (error instanceof TransientProviderError) return true;
  const code =
    typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (
    /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT)$/i.test(
      code,
    )
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|socket|econnreset|etimedout|enotfound|econnrefused|other side closed|und_err_/i.test(
    message,
  );
}

export function providerBackoffMs(attempt: number, retryAfter: string | null = null) {
  const fromHeader = parseRetryAfter(retryAfter);
  if (fromHeader !== null) return Math.min(fromHeader, PROVIDER_MAX_DELAY_MS);
  const exp = PROVIDER_BASE_DELAY_MS * 2 ** Math.max(0, attempt);
  return Math.min(exp, PROVIDER_MAX_DELAY_MS);
}

export async function waitForRetry(ms: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(onDone, ms);
    const onAbort = () => finish(() => reject(new TurnAborted()));
    function onDone() {
      finish(resolve);
    }
    function finish(next: () => void) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      next();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}
