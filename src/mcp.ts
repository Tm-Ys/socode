import { isTurnAborted, TurnAborted } from "./abort.js";
import { packageVersion } from "./banner.js";
import type { AgentMode } from "./mode.js";
import { loadMcpServers, type McpServerConfig } from "./mcp-config.js";
import { McpStdioClient } from "./mcp-client.js";
import { scrubEnv } from "./sandbox.js";

export type McpToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const MAX_RESULT = 32_000;
const MAX_TOOLS = 64;

export type McpToolInfo = {
  name: string;
  server: string;
  originalName: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
};

export type McpServerStatus = {
  name: string;
  ok: boolean;
  tools: number;
  error?: string;
  source: string;
};

export type McpHub = {
  specs: (opts?: { mode?: AgentMode; role?: string }) => McpToolSpec[];
  isReadOnly: (name: string) => boolean;
  has: (name: string) => boolean;
  call: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
  statusText: () => string;
  toolNames: () => string[];
  close: () => Promise<void>;
};

type LiveServer = {
  config: McpServerConfig;
  client: McpStdioClient;
  tools: McpToolInfo[];
  error?: string;
};

export function isMcpTool(name: string) {
  return name.startsWith("mcp__");
}

export function mcpToolName(server: string, tool: string) {
  const left = sanitize(server);
  const right = sanitize(tool);
  const name = `mcp__${left}__${right}`;
  return name.length <= 64 ? name : name.slice(0, 64);
}

export function emptyMcpHub(): McpHub {
  return {
    specs: () => [],
    isReadOnly: () => false,
    has: () => false,
    call: async (name) => {
      throw new Error(`未知 MCP 工具: ${name}`);
    },
    statusText: () => "MCP: 未配置。在项目根放 .mcp.json，或 ~/.socode/mcp.json。",
    toolNames: () => [],
    close: async () => undefined,
  };
}

export async function openMcpHub(workspace: string): Promise<McpHub> {
  const loaded = loadMcpServers(workspace);
  if (loaded.servers.length === 0 && loaded.errors.length === 0) return emptyMcpHub();

  const lives: LiveServer[] = [];
  const failed: McpServerStatus[] = loaded.errors.map((error) => ({
    name: "config",
    ok: false,
    tools: 0,
    error,
    source: "config",
  }));

  for (const config of loaded.servers) {
    try {
      const live = await connectServer(config, workspace);
      lives.push(live);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ name: config.name, ok: false, tools: 0, error: message, source: config.source });
    }
  }

  const tools = new Map<string, { info: McpToolInfo; client: McpStdioClient }>();
  for (const live of lives) {
    for (const info of live.tools) {
      if (tools.has(info.name)) {
        info.name = `${info.name}_${live.config.name}`.slice(0, 64);
      }
      tools.set(info.name, { info, client: live.client });
    }
  }

  const statuses: McpServerStatus[] = [
    ...lives.map((live) => ({
      name: live.config.name,
      ok: true,
      tools: live.tools.length,
      source: live.config.source,
    })),
    ...failed,
  ];

  return {
    specs: (opts) => {
      let list = [...tools.values()].map(({ info }) => toSpec(info));
      if (opts?.mode === "plan" || opts?.role === "explorer" || opts?.role === "localize" || opts?.role === "verify") {
        list = list.filter((spec) => tools.get(spec.name)?.info.readOnly);
      }
      return list;
    },
    isReadOnly: (name) => Boolean(tools.get(name)?.info.readOnly),
    has: (name) => tools.has(name),
    call: async (name, args, signal) => {
      const hit = tools.get(name);
      if (!hit) throw new Error(`未知 MCP 工具: ${name}`);
      try {
        const result = await hit.client.request(
          "tools/call",
          { name: hit.info.originalName, arguments: args },
          30_000,
          signal,
        );
        return formatToolResult(result);
      } catch (error) {
        if (isTurnAborted(error) || signal?.aborted) throw new TurnAborted();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`MCP ${hit.info.server}/${hit.info.originalName}: ${message}`);
      }
    },
    statusText: () => formatStatus(statuses),
    toolNames: () => [...tools.keys()],
    close: async () => {
      await Promise.all(lives.map((live) => live.client.close()));
    },
  };
}

export function mcpChildEnv(extra: NodeJS.ProcessEnv = {}) {
  return { ...scrubEnv(), ...extra };
}

async function connectServer(config: McpServerConfig, workspace: string): Promise<LiveServer> {
  const client = new McpStdioClient(config.command, config.args, {
    cwd: config.cwd ?? workspace,
    env: mcpChildEnv(config.env),
  });
  try {
    await client.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "socode", version: packageVersion() },
      },
      15_000,
    );
    client.notify("notifications/initialized");
    const listed = await listAllTools(client);
    const tools = listed.slice(0, MAX_TOOLS).map((tool) => {
      const originalName = String(tool.name ?? "");
      return {
        name: mcpToolName(config.name, originalName),
        server: config.name,
        originalName,
        description: `[MCP ${config.name}] ${String(tool.description ?? originalName)}`,
        parameters: normalizeSchema(tool.inputSchema),
        readOnly: tool.annotations?.readOnlyHint === true,
      } satisfies McpToolInfo;
    });
    return { config, client, tools };
  } catch (error) {
    const suffix = client.stderr.trim() ? ` stderr: ${client.stderr.trim().slice(-500)}` : "";
    await client.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}${suffix}`);
  }
}

async function listAllTools(client: McpStdioClient) {
  const tools: Array<{
    name?: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: boolean };
  }> = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i += 1) {
    const result = (await client.request("tools/list", cursor ? { cursor } : {}, 15_000)) as {
      tools?: typeof tools;
      nextCursor?: string;
    };
    tools.push(...(result.tools ?? []));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

function toSpec(info: McpToolInfo): McpToolSpec {
  return {
    name: info.name,
    description: info.description,
    parameters: info.parameters,
  };
}

export function normalizeSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: "object", properties: {} };
  }
  const schema = { ...(input as Record<string, unknown>) };
  if (schema.type !== "object") schema.type = "object";
  if (!schema.properties || typeof schema.properties !== "object") schema.properties = {};
  return schema;
}

export function formatToolResult(result: unknown) {
  if (!result || typeof result !== "object") return clip(String(result));
  const body = result as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string; name?: string; mimeType?: string }>;
    structuredContent?: unknown;
  };
  const chunks: string[] = [];
  if (Array.isArray(body.content)) {
    for (const part of body.content) {
      if (part.type === "text" && part.text) chunks.push(part.text);
      else if (part.type === "resource" && part.name) chunks.push(`[resource ${part.name}]`);
      else if (part.type === "image") chunks.push(`[image ${part.mimeType ?? "binary"}]`);
    }
  }
  if (body.structuredContent !== undefined) {
    chunks.push(JSON.stringify(body.structuredContent));
  }
  const text = chunks.join("\n").trim() || JSON.stringify(result);
  const out = clip(text);
  return body.isError ? `工具执行失败: ${out}` : out;
}

function formatStatus(rows: McpServerStatus[]) {
  if (rows.length === 0) return "MCP: 未配置";
  const lines = ["MCP 服务器:"];
  for (const row of rows) {
    if (row.ok) lines.push(`- ${row.name}  ok  ${row.tools} tools  (${row.source})`);
    else lines.push(`- ${row.name}  fail  ${row.error ?? ""}`);
  }
  return lines.join("\n");
}

function sanitize(input: string) {
  const cleaned = input.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "tool";
}

function clip(text: string) {
  if (text.length <= MAX_RESULT) return text;
  return `${text.slice(0, MAX_RESULT)}\n... [truncated ${text.length - MAX_RESULT} chars]`;
}
