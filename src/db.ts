import pg from "pg";

export type Role = "system" | "user" | "assistant";

export type Message = {
  role: Role;
  content: string;
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      content TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq INTEGER;

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

export async function createConversation(pool: pg.Pool, model: string) {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO conversations (model) VALUES ($1) RETURNING id",
    [model],
  );
  return result.rows[0].id;
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

export async function openConversation(
  pool: pg.Pool,
  opts: { model: string; id?: string; fresh?: boolean },
) {
  if (opts.id) {
    if (!(await conversationExists(pool, opts.id))) {
      throw new Error(`找不到会话 ${opts.id}`);
    }
    return { id: opts.id, messages: await loadMessages(pool, opts.id) };
  }

  if (!opts.fresh) {
    const latest = await latestConversationId(pool);
    if (latest) {
      return { id: latest, messages: await loadMessages(pool, latest) };
    }
  }

  const id = await createConversation(pool, opts.model);
  return { id, messages: [] as Message[] };
}

export async function loadMessages(pool: pg.Pool, conversationId: string) {
  const result = await pool.query<Message>(
    "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY seq ASC, created_at ASC",
    [conversationId],
  );
  return result.rows;
}

export async function saveTurn(
  pool: pg.Pool,
  conversationId: string,
  user: Message,
  assistant: Message,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM conversations WHERE id = $1 FOR UPDATE", [conversationId]);
    const next = await client.query<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = $1",
      [conversationId],
    );
    const seq = Number(next.rows[0]?.seq ?? 0);
    await client.query(
      "INSERT INTO messages (conversation_id, role, content, seq, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())",
      [conversationId, user.role, user.content, seq + 1],
    );
    await client.query(
      "INSERT INTO messages (conversation_id, role, content, seq, created_at) VALUES ($1, $2, $3, $4, clock_timestamp())",
      [conversationId, assistant.role, assistant.content, seq + 2],
    );
    await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [
      conversationId,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
