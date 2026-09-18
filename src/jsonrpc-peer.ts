import { PassThrough } from "node:stream";
import { takeMessage, type JsonRpcId } from "./mcp-client.js";

export type JsonRpcError = { code: number; message: string };

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type JsonRpcHandler = (method: string, params: unknown, id?: JsonRpcId) => Promise<unknown> | unknown;

export class JsonRpcPeer {
  private buf = "";
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private handlers = new Map<string, JsonRpcHandler>();
  private closed = false;
  private fallback?: JsonRpcHandler;
  private closeListeners = new Set<(error: Error) => void>();

  get isClosed() {
    return this.closed;
  }

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {
    this.input.setEncoding?.("utf8");
    this.input.on("data", (chunk: string | Buffer) => {
      this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.drain();
    });
    this.input.on("end", () => this.close(new Error("JSON-RPC 连接已关闭")));
    this.input.on("error", (error: Error) => this.close(error));
  }

  handle(method: string, fn: JsonRpcHandler) {
    this.handlers.set(method, fn);
  }

  fallbackHandle(fn: JsonRpcHandler) {
    this.fallback = fn;
  }

  onClose(fn: (error: Error) => void) {
    if (this.closed) {
      const fail = new Error("JSON-RPC 连接已关闭");
      queueMicrotask(() => fn(fail));
      return () => undefined;
    }
    this.closeListeners.add(fn);
    return () => {
      this.closeListeners.delete(fn);
    };
  }

  async request(method: string, params?: unknown) {
    if (this.closed) throw new Error("JSON-RPC 连接已关闭");
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(payload);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown) {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
  }

  respond(id: JsonRpcId, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: JsonRpcId, error: JsonRpcError) {
    this.write({ jsonrpc: "2.0", id, error });
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    const fail = error ?? new Error("JSON-RPC 连接已关闭");
    for (const pending of this.pending.values()) pending.reject(fail);
    this.pending.clear();
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const fn of listeners) {
      try {
        fn(fail);
      } catch {
        // ignore
      }
    }
    try {
      this.output.end();
    } catch {
      // ignore
    }
  }

  private write(payload: Record<string, unknown>) {
    if (this.closed) throw new Error("JSON-RPC 连接已关闭");
    this.output.write(`${JSON.stringify(payload)}\n`);
  }

  private drain() {
    while (this.buf.length) {
      let parsed: { value: unknown; rest: string } | null;
      try {
        parsed = takeMessage(this.buf);
      } catch {
        const nl = this.buf.indexOf("\n");
        if (nl < 0) return;
        this.buf = this.buf.slice(nl + 1);
        continue;
      }
      if (!parsed) break;
      this.buf = parsed.rest;
      if (parsed.value == null) continue;
      void this.onMessage(parsed.value);
    }
  }

  private async onMessage(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const msg = value as {
      id?: JsonRpcId;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    if (msg.method) {
      const handler = this.handlers.get(msg.method) ?? this.fallback;
      if (msg.id === undefined) {
        try {
          await handler?.(msg.method, msg.params);
        } catch {
          // notifications cannot fail the peer
        }
        return;
      }
      if (!handler) {
        this.respondError(msg.id, { code: -32601, message: `未知方法: ${msg.method}` });
        return;
      }
      try {
        const result = await handler(msg.method, msg.params, msg.id);
        if (!this.closed) this.respond(msg.id, result ?? null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof RpcError ? error.code : -32000;
        if (!this.closed) this.respondError(msg.id, { code, message });
      }
      return;
    }
    if (msg.id === undefined) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code ?? ""}`.trim()));
      return;
    }
    pending.resolve(msg.result);
  }
}

export function pairedPeers() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const left = new JsonRpcPeer(bToA, aToB);
  const right = new JsonRpcPeer(aToB, bToA);
  return { left, right };
}
