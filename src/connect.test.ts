import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseConnectTarget } from "./connect.js";

describe("parseConnectTarget", () => {
  it("parses user@host:/abs/path", () => {
    const parsed = parseConnectTarget("me@box:/home/me/repo");
    assert.deepEqual(parsed, { user: "me", host: "box", path: "/home/me/repo" });
  });

  it("rejects a relative path", () => {
    const parsed = parseConnectTarget("me@box:repo");
    assert.equal("error" in parsed, true);
  });

  it("rejects a missing host", () => {
    const parsed = parseConnectTarget(":/abs");
    assert.equal("error" in parsed, true);
  });
});
