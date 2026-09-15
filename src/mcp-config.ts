import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type McpServerConfig = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
  source: string;
};

export function mcpConfigPaths(workspace: string) {
  return [
    join(homedir(), ".socode", "mcp.json"),
    join(workspace, ".socode", "mcp.json"),
    join(workspace, ".mcp.json"),
  ];
}

export function loadMcpServers(workspace: string): { servers: McpServerConfig[]; errors: string[] } {
  const servers = new Map<string, McpServerConfig>();
  const errors: string[] = [];
  for (const file of mcpConfigPaths(workspace)) {
    if (!existsSync(file)) continue;
    try {
      const parsed = parseMcpConfigFile(file, workspace);
      for (const server of parsed.servers) servers.set(server.name, server);
      errors.push(...parsed.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: ${message}`);
    }
  }
  return { servers: [...servers.values()].filter((server) => !server.disabled), errors };
}

export function parseMcpConfigFile(file: string, workspace: string) {
  const raw = readFileSync(file, "utf8");
  const json = JSON.parse(raw) as unknown;
  return parseMcpConfig(json, file, workspace);
}

export function parseMcpConfig(json: unknown, source: string, workspace: string) {
  const errors: string[] = [];
  const servers: McpServerConfig[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("MCP 配置必须是对象");
  }
  const root = json as Record<string, unknown>;
  const table = root.mcpServers;
  if (table === undefined) return { servers, errors };
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    throw new Error("mcpServers 必须是对象");
  }
  for (const [name, value] of Object.entries(table as Record<string, unknown>)) {
    const parsed = parseServerEntry(name, value, source, workspace);
    if (typeof parsed === "string") {
      errors.push(parsed);
      continue;
    }
    servers.push(parsed);
  }
  return { servers, errors };
}

export function expandEnv(input: string, env: NodeJS.ProcessEnv = process.env) {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_all, key: string, fallback?: string) => {
    const value = env[key];
    if (value !== undefined && value !== "") return value;
    return fallback ?? "";
  });
}

function parseServerEntry(
  name: string,
  value: unknown,
  source: string,
  workspace: string,
): McpServerConfig | string {
  const key = name.trim();
  if (!key) return `${source}: 服务器名不能为空`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${source}: ${key} 配置必须是对象`;
  }
  const entry = value as Record<string, unknown>;
  const transport = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  if (transport === "http" || transport === "sse" || typeof entry.url === "string") {
    return `${source}: ${key} 是 HTTP/SSE MCP，当前只支持 stdio`;
  }
  const command = typeof entry.command === "string" ? expandEnv(entry.command.trim()) : "";
  if (!command) return `${source}: ${key} 缺少 command`;
  const args = Array.isArray(entry.args)
    ? entry.args.filter((item): item is string => typeof item === "string").map((item) => expandEnv(item))
    : [];
  const env: Record<string, string> = {};
  if (entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)) {
    for (const [envKey, envVal] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof envVal === "string") env[envKey] = expandEnv(envVal);
    }
  }
  const cwd = typeof entry.cwd === "string" && entry.cwd.trim() ? expandEnv(entry.cwd.trim()) : workspace;
  return {
    name: key,
    command,
    args,
    env,
    cwd,
    disabled: entry.disabled === true,
    source,
  };
}
