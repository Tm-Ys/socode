import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type Role = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type Message = {
  role: Role;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
};

export type Session = {
  id: string;
  title: string;
  messages: Message[];
  persisted: boolean;
};

export type SessionStore = {
  workspace: string;
  dir: string;
};

export type ConversationRow = {
  id: string;
  title: string;
  model: string;
  updated_at: Date;
  first_user: string | null;
};

type SessionFile = {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
};

const ROLES = new Set<Role>(["system", "user", "assistant", "tool"]);

export function emptySession(title = "新会话"): Session {
  return { id: "", title, messages: [], persisted: false };
}

export function sessionHasChat(messages: Message[]) {
  return messages.some((message) => message.role === "user" || message.role === "assistant" || message.role === "tool");
}

export function socodeDir(workspace: string) {
  return join(workspace, ".socode");
}

export function sessionsDir(workspace: string) {
  return join(socodeDir(workspace), "sessions");
}

export async function openSessionStore(workspace: string): Promise<SessionStore> {
  const root = realpathSync(workspace);
  const dir = sessionsDir(root);
  await mkdir(dir, { recursive: true });
  await writeIfMissing(join(socodeDir(root), ".gitignore"), "sessions/\nundo/\n");
  await writeIfMissing(join(dir, ".gitignore"), "*\n!.gitignore\n");
  return { workspace: root, dir };
}

export async function createConversation(store: SessionStore, model: string, title = "新会话") {
  const now = new Date().toISOString();
  const record: SessionFile = {
    id: randomUUID(),
    title,
    model,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await writeSession(store, record);
  return { id: record.id, title: record.title, messages: [] as Message[], persisted: true };
}

export async function updateConversationTitle(store: SessionStore, conversationId: string, title: string) {
  const record = await readSession(store, conversationId);
  record.title = title;
  record.updatedAt = new Date().toISOString();
  await writeSession(store, record);
}

export async function listConversations(store: SessionStore, limit = 30) {
  const records = await readAllSessions(store);
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt));
  return records.slice(0, limit).map((record) => ({
    id: record.id,
    title: record.title,
    model: record.model,
    updated_at: new Date(record.updatedAt),
    first_user: record.messages.find((message) => message.role === "user")?.content ?? null,
  }));
}

export async function latestConversationId(store: SessionStore) {
  const rows = await listConversations(store, 1);
  return rows[0]?.id ?? null;
}

export async function conversationExists(store: SessionStore, conversationId: string) {
  return existsSync(sessionPath(store, conversationId));
}

export async function loadSession(store: SessionStore, conversationId: string): Promise<Session> {
  const record = await readSession(store, conversationId);
  return { id: record.id, title: record.title, messages: record.messages, persisted: true };
}

export async function openConversation(
  store: SessionStore,
  opts: { model: string; id?: string; resume?: boolean; fresh?: boolean },
): Promise<Session> {
  if (opts.id) return await loadSession(store, opts.id);
  if (opts.resume && !opts.fresh) {
    const latest = await latestConversationId(store);
    if (latest) return await loadSession(store, latest);
  }
  return emptySession();
}

export async function persistSession(store: SessionStore, session: Session, model: string) {
  if (session.persisted && session.id) return session;
  const created = await createConversation(store, model, session.title);
  session.id = created.id;
  session.title = created.title;
  session.persisted = true;
  if (session.messages.length) await saveMessages(store, session.id, session.messages);
  return session;
}

export async function discardEmptySession(store: SessionStore, session: Session) {
  if (!session.persisted || !session.id || sessionHasChat(session.messages)) return;
  await unlink(sessionPath(store, session.id)).catch(() => undefined);
  session.id = "";
  session.persisted = false;
}

export async function loadMessages(store: SessionStore, conversationId: string) {
  return (await readSession(store, conversationId)).messages;
}

export async function saveMessages(store: SessionStore, conversationId: string, messages: Message[]) {
  if (messages.length === 0) return;
  const record = await readSession(store, conversationId);
  record.messages = [...record.messages, ...messages];
  record.updatedAt = new Date().toISOString();
  await writeSession(store, record);
}

export async function replaceMessages(store: SessionStore, conversationId: string, messages: Message[]) {
  const record = await readSession(store, conversationId);
  record.messages = messages;
  record.updatedAt = new Date().toISOString();
  await writeSession(store, record);
}

function sessionPath(store: SessionStore, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`找不到会话 ${id}`);
  return join(store.dir, `${id}.json`);
}

async function readSession(store: SessionStore, id: string) {
  let raw: string;
  try {
    raw = await readFile(sessionPath(store, id), "utf8");
  } catch {
    throw new Error(`找不到会话 ${id}`);
  }
  const record = parseSessionFile(raw);
  if (!record || record.id !== id) throw new Error(`找不到会话 ${id}`);
  return record;
}

async function readAllSessions(store: SessionStore) {
  let names: string[] = [];
  try {
    names = await readdir(store.dir);
  } catch {
    return [];
  }
  const records: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = parseSessionFile(await readFile(join(store.dir, name), "utf8"));
      if (record) records.push(record);
    } catch {
      // skip unreadable files
    }
  }
  return records;
}

function parseSessionFile(raw: string): SessionFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.title !== "string" || typeof rec.model !== "string") return null;
  if (typeof rec.createdAt !== "string" || typeof rec.updatedAt !== "string") return null;
  if (!Array.isArray(rec.messages)) return null;
  const messages: Message[] = [];
  for (const item of rec.messages) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (!ROLES.has(row.role as Role) || typeof row.content !== "string") continue;
    messages.push({
      role: row.role as Role,
      content: row.content,
      toolCallId: typeof row.toolCallId === "string" ? row.toolCallId : undefined,
      toolCalls: Array.isArray(row.toolCalls) ? (row.toolCalls as ToolCall[]) : undefined,
    });
  }
  return {
    id: rec.id,
    title: rec.title,
    model: rec.model,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    messages,
  };
}

async function writeSession(store: SessionStore, record: SessionFile) {
  const file = sessionPath(store, record.id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function writeIfMissing(path: string, content: string) {
  if (existsSync(path)) return;
  await writeFile(path, content, "utf8");
}
