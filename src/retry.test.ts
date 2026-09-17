import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TurnAborted } from "./abort.js";
import {
  providerBackoffMs,
  retryableProviderFailure,
  retryableStatus,
  TransientProviderError,
  waitForRetry,
} from "./retry.js";

describe("provider retry policy", () => {
  it("retries 429/5xx and network jitter, not auth failures", () => {
    assert.equal(retryableStatus(429), true);
    assert.equal(retryableStatus(503), true);
    assert.equal(retryableStatus(401), false);
    assert.equal(retryableStatus(400), false);
    assert.equal(retryableProviderFailure(new TransientProviderError("HTTP 429")), true);
    assert.equal(retryableProviderFailure(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })), true);
    assert.equal(retryableProviderFailure(new Error("Invalid API key")), false);
    assert.equal(retryableProviderFailure(new TurnAborted()), false);
  });

  it("uses Retry-After when present, otherwise exponential backoff", () => {
    assert.equal(providerBackoffMs(0, "1"), 1000);
    assert.equal(providerBackoffMs(0), 400);
    assert.equal(providerBackoffMs(1), 800);
    assert.equal(providerBackoffMs(2), 1600);
  });

  it("stops waiting when the turn is aborted", async () => {
    const signal = AbortSignal.abort();
    await assert.rejects(() => waitForRetry(5_000, signal), TurnAborted);
  });
});
