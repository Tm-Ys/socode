import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { emptyProvider } from "./provider.js";
import { silentHost } from "./worker-host.js";
import { openLocalWorker } from "./worker.js";

const provider = {
  ...emptyProvider(),
  name: "test",
  url: "https://example.test/v1",
  api: "dummy",
  model: "dummy",
};

describe("openLocalWorker", () => {
  it("writes after injected Ask allow and keeps the file on deny", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-worker-"));
    const file = join(dir, "note.txt");
    try {
      let calls = 0;
      const allow = await openLocalWorker({
        host: silentHost({ askPermission: async () => "allow" }),
        workspace: dir,
        provider,
        mode: "ask",
        agentEnabled: true,
        skipSkills: true,
        skipTitle: true,
        maxMessages: 20,
        maxSteps: 8,
        stream: false,
        complete: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              content: "",
              toolCalls: [{ id: "1", name: "write", arguments: JSON.stringify({ path: file, content: "hello" }) }],
            };
          }
          return { content: "wrote", toolCalls: [] };
        },
      });
      const allowed = await allow.turn("写一个文件");
      assert.equal(allowed.error, undefined);
      assert.equal(readFileSync(file, "utf8"), "hello");
      await allow.close();

      calls = 0;
      const deny = await openLocalWorker({
        host: silentHost({ askPermission: async () => "deny" }),
        workspace: dir,
        provider,
        mode: "ask",
        agentEnabled: true,
        skipSkills: true,
        skipTitle: true,
        maxMessages: 20,
        maxSteps: 8,
        stream: false,
        complete: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              content: "",
              toolCalls: [{ id: "1", name: "write", arguments: JSON.stringify({ path: file, content: "nope" }) }],
            };
          }
          return { content: "denied", toolCalls: [] };
        },
      });
      await deny.turn("再写");
      assert.equal(readFileSync(file, "utf8"), "hello");
      await deny.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
