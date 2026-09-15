import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { completeChat } from "./chat.js";
import { buildApiMessages, previewMessages } from "./context.js";
import {
  connectDb,
  createConversation,
  openConversation,
  saveTurn,
  type Message,
} from "./db.js";

const BOOLEAN_FLAGS = new Set(["resume", "new", "no-stream"]);

function loadEnv(path: string) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey === "api-key" || rawKey === "key" ? "api" : rawKey;
    const next = argv[i + 1];
    const asBoolean =
      BOOLEAN_FLAGS.has(key) &&
      inlineValue === undefined &&
      (!next || next.startsWith("--"));
    flags[key] = asBoolean ? "true" : (inlineValue ?? argv[++i] ?? "");
  }

  return flags;
}

function flagOn(value: string | undefined) {
  return value === "true" || value === "";
}

function usage() {
  return `用法:
  npm start [-- --input <文本>]
  npm start -- --new
  npm start -- --id <conversation-uuid>
  npm start -- --no-stream

默认继续最近一次会话，把 PostgreSQL 里的历史当作上下文发给模型，并流式打印输出。
--new 开新会话，--id 指定会话，--no-stream 关闭流式。`;
}

function chatUrl(base: string) {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function printContext(history: Message[]) {
  if (history.length === 0) return;
  const { recent, skipped } = previewMessages(history);
  console.log("--- 上下文 ---");
  if (skipped > 0) console.log(`... 更早 ${skipped} 条`);
  for (const message of recent) {
    const who = message.role === "user" ? "you" : "llm";
    console.log(`${who}> ${message.content}`);
  }
  console.log("--------------\n");
}

async function main() {
  loadEnv(resolve(process.cwd(), ".env"));
  const flags = parseArgs(process.argv.slice(2));
  const base = flags.url ?? process.env.BASE_URL ?? process.env.LLM_URL ?? "";
  const api = flags.api ?? process.env.api_key ?? process.env.LLM_API ?? "";
  const model = flags.model ?? process.env.MODEL ?? process.env.LLM_MODEL ?? "";
  const databaseUrl =
    flags.database ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/socode";
  const systemPrompt = flags.system ?? process.env.SYSTEM_PROMPT ?? "";
  const maxMessages = Number(flags.max ?? process.env.MAX_CONTEXT_MESSAGES ?? 40);
  const oneShot = flags.input;
  const fresh = flagOn(flags.new);
  const stream = !flagOn(flags["no-stream"]);
  const conversationFlag = flags.id;

  if (!base || !api || !model) {
    console.error(usage());
    process.exit(1);
  }

  const url = chatUrl(base);
  const pool = await connectDb(databaseUrl);
  let session = await openConversation(pool, {
    model,
    id: conversationFlag,
    fresh,
  });

  const ask = async (history: Message[], user: Message, onDelta?: (text: string) => void) =>
    completeChat({
      url,
      api,
      model,
      stream,
      onDelta,
      messages: buildApiMessages({
        history,
        user,
        systemPrompt: systemPrompt || undefined,
        maxMessages: Number.isFinite(maxMessages) ? maxMessages : 40,
      }),
    });

  try {
    if (oneShot !== undefined) {
      const user: Message = { role: "user", content: oneShot };
      const reply = (
        await ask(session.messages, user, (delta) => process.stdout.write(delta))
      ).trim();
      const assistant: Message = { role: "assistant", content: reply };
      await saveTurn(pool, session.id, user, assistant);
      session.messages.push(user, assistant);
      if (!reply.endsWith("\n")) process.stdout.write("\n");
      return;
    }

    const rl = readline.createInterface({ input, output });
    console.log(`模型: ${model}`);
    console.log(`接口: ${url}`);
    console.log(`会话: ${session.id}`);
    console.log(`流式: ${stream ? "开" : "关"}`);
    console.log("输入消息后回车发送。/new 新会话，/exit 退出。\n");
    printContext(session.messages);

    while (true) {
      const prompt = (await rl.question("you> ")).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      if (prompt === "/new") {
        session = { id: await createConversation(pool, model), messages: [] };
        console.log(`\n新会话: ${session.id}\n`);
        continue;
      }

      const user: Message = { role: "user", content: prompt };
      try {
        process.stdout.write("llm> ");
        const reply = (
          await ask(session.messages, user, (delta) => process.stdout.write(delta))
        ).trim();
        const assistant: Message = { role: "assistant", content: reply };
        await saveTurn(pool, session.id, user, assistant);
        session.messages.push(user, assistant);
        process.stdout.write("\n\n");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\nerr> ${message}\n`);
      }
    }

    rl.close();
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
