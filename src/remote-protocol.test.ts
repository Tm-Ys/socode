import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handshakeResult, payloadHasSecrets, SOCODE_REMOTE_PROTOCOL } from "./remote-protocol.js";

describe("handshakeResult", () => {
  it("accepts socode-remote/1", () => {
    const result = handshakeResult({ protocol: SOCODE_REMOTE_PROTOCOL, clientVersion: "0.1.2" });
    assert.equal(result.ok, true);
  });

  it("fails closed on a different protocol", () => {
    const result = handshakeResult({ protocol: "other/1", clientVersion: "0.1.2" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, -32000);
  });
});

describe("payloadHasSecrets", () => {
  it("flags api keys and sk- prefixes", () => {
    assert.equal(payloadHasSecrets({ api: "secret-value" }), "api");
    assert.equal(payloadHasSecrets({ text: "sk-live-123" }), "text");
    assert.equal(payloadHasSecrets({ protocol: SOCODE_REMOTE_PROTOCOL, text: "hello" }), null);
  });
});
