import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { takeMessage } from "./mcp-client.js";
import { expandEnv, parseMcpConfig } from "./mcp-config.js";
import { formatToolResult, mcpToolName, normalizeSchema, openMcpHub, type McpHub } from "./mcp.js";
import { createPolicy } from "./permissions.js";
import { executeTool, toolSpecs } from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const echoServer = join(here, "mcp-echo-server.mjs");

describe("mcp config", () => {
  it("parses Claude-style mcpServers and expands env", () => {
    const parsed = parseMcpConfig(
      {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "${PKG:-@modelcontextprotocol/server-github}"],
            env: { GITHUB_TOKEN: "${TOKEN}" },
          },
          remote: { type: "http", url: "https://example.test/mcp" },
        },
      },
      "mem",
      "/tmp/ws",
    );
    assert.equal(parsed.servers.length, 1);
    assert.equal(parsed.servers[0].name, "github");
    assert.equal(parsed.servers[0].args[1], "@modelcontextprotocol/server-github");
    assert.match(parsed.errors[0] ?? "", /HTTP/);
    assert.equal(expandEnv("x${MISSING:-z}y"), "xzy");
  });
});

describe("mcp helpers", () => {
  it("names tools like Claude Code and fills schemas", () => {
    assert.equal(mcpToolName("github", "list_issues"), "mcp__github__list_issues");
    assert.equal(mcpToolName("my srv", "do thing"), "mcp__my_srv__do_thing");
    const schema = normalizeSchema({ properties: { q: { type: "string" } } });
    assert.equal(schema.type, "object");
  });

  it("reads newline and Content-Length framed JSON", () => {
    const line = takeMessage('{"jsonrpc":"2.0","id":1,"result":true}\nnext');
    assert.equal((line?.value as { result?: boolean }).result, true);
    assert.equal(line?.rest, "next");
    const json = '{"jsonrpc":"2.0","id":2}';
    const framed = takeMessage(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    assert.equal((framed?.value as { id?: number }).id, 2);
  });

  it("formats MCP tool payloads", () => {
    assert.equal(formatToolResult({ content: [{ type: "text", text: "hi" }] }), "hi");
    assert.match(
      formatToolResult({ isError: true, content: [{ type: "text", text: "nope" }] }),
      /工具执行失败/,
    );
  });
});

describe("mcp hub", () => {
  it("connects to a stdio echo server and calls tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "socode-mcp-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { echo: { command: "node", args: [echoServer] } },
      }),
    );
    const hub = await openMcpHub(dir);
    try {
      const ping = "mcp__echo__ping";
      const shout = "mcp__echo__shout";
      assert.deepEqual(hub.toolNames().sort(), [ping, shout].sort());
      assert.equal(hub.isReadOnly(ping), true);
      assert.equal(hub.isReadOnly(shout), false);
      assert.equal(await hub.call(ping, { text: "hi" }), "pong:hi");
      assert.equal(await hub.call(shout, { text: "ok" }), "OK");
      const planSpecs = hub.specs({ mode: "plan" }).map((tool) => tool.name);
      assert.equal(planSpecs.includes(ping), true);
      assert.equal(planSpecs.includes(shout), false);
      const policy = createPolicy(dir, () => "full", undefined, { mcp: hub });
      const out = await executeTool(ping, JSON.stringify({ text: "z" }), undefined, policy);
      assert.equal(out, "pong:z");
      assert.equal(
        toolSpecs("ask", { extra: hub.specs({ mode: "ask" }) }).some((tool) => tool.name === shout),
        true,
      );
    } finally {
      await hub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hides mutating MCP from Plan and explorer", async () => {
    const hub: McpHub = {
      specs: (opts) => {
        const all = [
          { name: "mcp__s__ping", description: "p", parameters: { type: "object", properties: {} } },
          { name: "mcp__s__shout", description: "s", parameters: { type: "object", properties: {} } },
        ];
        if (opts?.mode === "plan" || opts?.role === "explorer") {
          return all.filter((tool) => tool.name.endsWith("ping"));
        }
        return all;
      },
      isReadOnly: (name) => name.endsWith("ping"),
      has: (name) => name.startsWith("mcp__s__"),
      call: async () => "ok",
      statusText: () => "",
      toolNames: () => ["mcp__s__ping", "mcp__s__shout"],
      close: async () => undefined,
    };
    const plan = createPolicy(process.cwd(), () => "plan", undefined, { mcp: hub });
    assert.equal(await plan.authorize("mcp__s__ping", {}), null);
    assert.match((await plan.authorize("mcp__s__shout", {})) ?? "", /Plan/);
    const explorer = createPolicy(process.cwd(), () => "ask", undefined, {
      nested: true,
      role: "explorer",
      mcp: hub,
    });
    assert.match((await explorer.authorize("mcp__s__shout", {})) ?? "", /只读/);
  });
});
