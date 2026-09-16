import pg from "pg";

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

const { Pool } = pg;

function quoteIdent(id: string) {
  return `"${id.replaceAll('"', '""')}"`;
}

function adminUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function databaseName(databaseUrl: string) {
  const name = new URL(databaseUrl).pathname.replace(/^\/+/, "");
  if (!name) throw new Error("DATABASE_URL 缺少数据库名");
  return name;
}

export async function connectDb(databaseUrl: string) {
  const name = databaseName(databaseUrl);
  const admin = new Pool({ connectionString: adminUrl(databaseUrl) });
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
    }
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: databaseUrl });
  await migrate(pool);
  return pool;
}

async function migrate(pool: pg.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '新会话',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '新会话';

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq INTEGER;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_role_check;
    ALTER TABLE messages ADD CONSTRAINT messages_role_check
      CHECK (role IN ('system', 'user', 'assistant', 'tool'));

    UPDATE messages
    SET seq = ordered.seq
    FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY conversation_id
          ORDER BY
            created_at ASC,
            CASE role WHEN 'system' THEN 0 WHEN 'user' THEN 1 WHEN 'assistant' THEN 2 ELSE 3 END,
            id ASC
        ) AS seq
      FROM messages
      WHERE seq IS NULL
    ) ordered
    WHERE messages.id = ordered.id AND messages.seq IS NULL;

    ALTER TABLE messages ALTER COLUMN seq SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS messages_conversation_seq_idx
      ON messages (conversation_id, seq);
    CREATE INDEX IF NOT EXISTS messages_conversation_created_at_idx
      ON messages (conversation_id, created_at);
  `);
}

export type Session = {
  id: string;
  title: string;
  messages: Message[];
  persisted: boolean;
};

export function emptySession(title = "新会话"): Session {
  return { id: "", title, messages: [], persisted: false };
}

export function sessionHasChat(messages: Message[]) {
  return messages.some((message) => message.role === "user" || message.role === "assistant" || message.role === "tool");
}

export type ConversationRow = {
  id: string;
  title: string;
  model: string;
  updated_at: Date;
  first_user: string | null;
};

export async function createConversation(pool: pg.Pool, model: string, title = "新会话") {
  const result = await pool.query<{ id: string; title: string }>(
    "INSERT INTO conversations (model, title) VALUES ($1, $2) RETURNING id, title",
    [model, title],
  );
  return { id: result.rows[0].id, title: result.rows[0].title, messages: [] as Message[], persisted: true };
}

export async function updateConversationTitle(pool: pg.Pool, conversationId: string, title: string) {
  await pool.query("UPDATE conversations SET title = $2, updated_at = now() WHERE id = $1", [
    conversationId,
    title,
  ]);
}

export async function listConversations(pool: pg.Pool, limit = 30) {
  const result = await pool.query<ConversationRow>(
    `SELECT
       c.id,
       c.title,
       c.model,
       c.updated_at,
       (
         SELECT m.content
         FROM messages m
         WHERE m.conversation_id = c.id AND m.role = 'user'
         ORDER BY m.seq ASC
         LIMIT 1
       ) AS first_user
     FROM conversations c
     ORDER BY c.updated_at DESC, c.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function latestConversationId(pool: pg.Pool) {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM conversations ORDER BY updated_at DESC, created_at DESC LIMIT 1",
  );
  return result.rows[0]?.id ?? null;
}

export async function conversationExists(pool: pg.Pool, conversationId: string) {
  const result = await pool.query("SELECT 1 FROM conversations WHERE id = $1", [conversationId]);
  return (result.rowCount ?? 0) > 0;
}

export async function loadSession(pool: pg.Pool, conversationId: string): Promise<Session> {
  const result = await pool.query<{ id: string; title: string }>(
    "SELECT id, title FROM conversations WHERE id = $1",
    [conversationId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`找不到会话 ${conversationId}`);
  return { id: row.id, title: row.title, messages: await loadMessages(pool, row.id), persisted: true };
}

export async function openConversation(
  pool: pg.Pool,
  opts: { model: string; id?: string; resume?: boolean; fresh?: boolean },
): Promise<Session> {
  if (opts.id) return await loadSession(pool, opts.id);
  if (opts.resume && !opts.fresh) {
    const latest = await latestConversationId(pool);
    if (latest) return await loadSession(pool, latest);
  }
  return emptySession();
}

export async function persistSession(pool: pg.Pool, session: Session, model: string) {
  if (session.persisted && session.id) return session;
  const created = await createConversation(pool, model, session.title);
  session.id = created.id;
  session.title = created.title;
  session.persisted = true;
  if (session.messages.length) await saveMessages(pool, session.id, session.messages);
  return session;
}

export async function discardEmptySession(pool: pg.Pool, session: Session) {
  if (!session.persisted || !session.id || sessionHasChat(session.messages)) return;
  await pool.query("DELETE FROM conversations WHERE id = $1", [session.id]);
  session.id = "";
  session.persisted = false;
}

export async function loadMessages(pool: pg.Pool, conversationId: string) {
  const result = await pool.query<{ role: Role; content: string; payload: unknown }>(
    "SELECT role, content, payload FROM messages WHERE conversation_id = $1 ORDER BY seq ASC, created_at ASC",
    [conversationId],
  );
  return result.rows.map(rowToMessage);
}

function rowToMessage(row: { role: Role; content: string; payload: unknown }): Message {
  const payload = (row.payload ?? {}) as { tool_call_id?: string; tool_calls?: ToolCall[] };
  return {
    role: row.role,
    content: row.content,
    toolCallId: payload.tool_call_id,
    toolCalls: payload.tool_calls,
  };
}

function messagePayload(message: Message) {
  const payload: Record<string, unknown> = {};
  if (message.toolCallId) payload.tool_call_id = message.toolCallId;
  if (message.toolCalls?.length) payload.tool_calls = message.toolCalls;
  return payload;
}

export async function saveMessages(pool: pg.Pool, conversationId: string, messages: Message[]) {
  if (messages.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
    const next = await client.query<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    let seq = Number(next.rows[0]?.seq ?? 0);
    for (const message of messages) {
      seq += 1;
      await client.query(
        "INSERT INTO messages (conversation_id, role, content, seq, payload, created_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())",
        [conversationId, message.role, message.content, seq, messagePayload(message)],
      );
    }
    await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceMessages(pool: pg.Pool, conversationId: string, messages: Message[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
    await client.query("DELETE FROM messages WHERE conversation_id = $1", [conversationId]);
    let seq = 0;
    for (const message of messages) {
      seq += 1;
      await client.query(
        "INSERT INTO messages (conversation_id, role, content, seq, payload, created_at) VALUES ($1, $2, $3, $4, $5, clock_timestamp())",
        [conversationId, message.role, message.content, seq, messagePayload(message)],
      );
    }
    await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [conversationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
