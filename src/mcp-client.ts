import { spawn, type ChildProcess } from "node:child_process";
import { throwIfAborted, TurnAborted } from "./abort.js";

export type JsonRpcId = number | string;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class McpStdioClient {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<JsonRpcId, Pending>();
  private closed = false;
  stderr = "";

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.closed) return;
      this.failAll(new Error(`MCP 进程退出 code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  }

  async request(method: string, params?: unknown, timeoutMs = 30_000, signal?: AbortSignal) {
    throwIfAborted(signal);
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new TurnAborted());
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`MCP ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.write(payload);
      } catch (error) {
        this.finish(id, undefined, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown) {
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("MCP 连接已关闭"));
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }

  private write(payload: Record<string, unknown>) {
    if (this.closed || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("MCP stdin 不可写");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    while (this.buf.length) {
      const parsed = takeMessage(this.buf);
      if (!parsed) break;
      this.buf = parsed.rest;
      this.onMessage(parsed.value);
    }
  }

  private onMessage(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const msg = value as { id?: JsonRpcId; error?: { message?: string; code?: number }; result?: unknown; method?: string };
    if (msg.id === undefined || msg.method) return;
    if (msg.error) {
      this.finish(msg.id, undefined, new Error(msg.error.message || `MCP error ${msg.error.code ?? ""}`.trim()));
      return;
    }
    this.finish(msg.id, msg.result, undefined);
  }

  private finish(id: JsonRpcId, result: unknown, error?: Error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  private failAll(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

export function takeMessage(buf: string): { value: unknown; rest: string } | null {
  if (buf.startsWith("Content-Length:")) {
    const sep = buf.indexOf("\r\n\r\n");
    const alt = buf.indexOf("\n\n");
    const split = sep >= 0 ? sep : alt;
    const gap = sep >= 0 ? 4 : 2;
    if (split < 0) return null;
    const header = buf.slice(0, split);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) return { value: null, rest: buf.slice(split + gap) };
    const len = Number(match[1]);
    const body = buf.slice(split + gap);
    if (body.length < len) return null;
    const json = body.slice(0, len);
    const rest = body.slice(len).replace(/^\r?\n/, "");
    return { value: JSON.parse(json), rest };
  }
  const nl = buf.indexOf("\n");
  if (nl < 0) return null;
  const line = buf.slice(0, nl).trim();
  const rest = buf.slice(nl + 1);
  if (!line) return { value: null, rest };
  return { value: JSON.parse(line), rest };
}
