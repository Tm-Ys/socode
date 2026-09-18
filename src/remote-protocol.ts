export const SOCODE_REMOTE_PROTOCOL = "socode-remote/1";

export const REMOTE_ERROR = {
  protocol: -32000,
  workspace: -32001,
  platform: -32002,
  sandbox: -32003,
  closed: -32004,
  provider: -32005,
} as const;

export type RemoteInitialize = {
  protocol: string;
  clientVersion: string;
  columns?: number;
};

export type RemoteHello = {
  protocol: string;
  runtimeStamp: string;
  node: string;
  platform: string;
  workspace: string;
};

export type RemoteSnapshot = {
  workspace: string;
  mode: string;
  title: string;
  mcpCount: number;
  model: string;
  thinkingEffort: string;
  sessionLabel: string;
  contextUsed: number;
  contextWindow: number;
  providerReady: boolean;
};

export function publicSnapshot(snap: {
  workspace: string;
  mode: string;
  title: string;
  mcpCount: number;
  model: string;
  thinkingEffort: string;
  sessionLabel: string;
  contextUsed: number;
  contextWindow: number;
  providerReady: boolean;
}): RemoteSnapshot {
  return {
    workspace: snap.workspace,
    mode: snap.mode,
    title: snap.title,
    mcpCount: snap.mcpCount,
    model: snap.model,
    thinkingEffort: snap.thinkingEffort,
    sessionLabel: snap.sessionLabel,
    contextUsed: snap.contextUsed,
    contextWindow: snap.contextWindow,
    providerReady: snap.providerReady,
  };
}

const SECRET_KEYS = new Set(["api", "apikey", "api_key", "api-key", "key", "token", "secret", "password"]);
const SECRET_VALUE = /(?:sk-|api[_-]?key\s*[:=])/i;

export function handshakeResult(params: unknown): { ok: true; init: RemoteInitialize } | { ok: false; code: number; message: string } {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, code: REMOTE_ERROR.protocol, message: "initialize 参数无效" };
  }
  const protocol = (params as { protocol?: unknown }).protocol;
  if (protocol !== SOCODE_REMOTE_PROTOCOL) {
    return {
      ok: false,
      code: REMOTE_ERROR.protocol,
      message: `协议不匹配：需要 ${SOCODE_REMOTE_PROTOCOL}`,
    };
  }
  const clientVersion = (params as { clientVersion?: unknown }).clientVersion;
  if (typeof clientVersion !== "string" || !clientVersion.trim()) {
    return { ok: false, code: REMOTE_ERROR.protocol, message: "缺少 clientVersion" };
  }
  const columns = (params as { columns?: unknown }).columns;
  return {
    ok: true,
    init: {
      protocol,
      clientVersion,
      columns: typeof columns === "number" && columns > 0 ? columns : undefined,
    },
  };
}

export function payloadHasSecrets(value: unknown, path = ""): string | null {
  if (typeof value === "string") {
    return SECRET_VALUE.test(value) ? path || "(string)" : null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = payloadHasSecrets(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.has(key.toLowerCase()) && typeof item === "string" && item.trim()) return here;
    const hit = payloadHasSecrets(item, here);
    if (hit) return hit;
  }
  return null;
}
