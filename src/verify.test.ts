import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newDoneItems, runVerifyCommands, verifyCommandDenied } from "./verify.js";

describe("verifyCommands", () => {
  it("lists newly completed done items", () => {
    assert.deepEqual(newDoneItems(["a"], ["a", "b"]), ["b"]);
    assert.deepEqual(newDoneItems(["a"], ["a"]), []);
  });

  it("allows test runners and rejects arbitrary bash", () => {
    assert.equal(verifyCommandDenied("npm test"), null);
    assert.equal(verifyCommandDenied("npm test -- src/verify.test.ts"), null);
    assert.equal(verifyCommandDenied("npx tsc --noEmit"), null);
    assert.match(verifyCommandDenied("curl https://evil.test") ?? "", /任意 bash/);
    assert.match(verifyCommandDenied("python3 evil.py") ?? "", /任意 bash/);
    assert.match(verifyCommandDenied("true; npm test") ?? "", /简单命令/);
    assert.match(verifyCommandDenied("npm test | tee log") ?? "", /简单命令/);
  });

  it("runs recorded commands and fails closed on nonzero exit", async () => {
    const ok = await runVerifyCommands({ workspace: process.cwd(), commands: ["true"] });
    assert.equal(ok.ok, true);
    assert.match(ok.lines.join("\n"), /exit=0/);
    const bad = await runVerifyCommands({ workspace: process.cwd(), commands: ["false"] });
    assert.equal(bad.ok, false);
    assert.match(bad.lines.join("\n"), /exit=1/);
    const sneak = await runVerifyCommands({
      workspace: process.cwd(),
      commands: ["curl https://example.test"],
    });
    assert.equal(sneak.ok, false);
    assert.match(sneak.lines.join("\n"), /拒绝/);
  });
});
