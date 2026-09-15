import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isTurnAborted } from "./abort.js";
import { DEFAULT_MAX_AGENT_STEPS, runAgent } from "./agent.js";
import { buildApiMessages, formatPreviewLine, previewMessages } from "./context.js";
import {
  connectDb,
  createConversation,
  listConversations,
  loadSession,
  openConversation,
  saveMessages,
  updateConversationTitle,
  type Message,
  type Session,
} from "./db.js";
import {
  formatProvider,
  isThinkingEffort,
  listProviders,
  loadProvider,
  saveProvider,
  switchProvider,
  type Provider,
} from "./provider.js";
import { formatConversationList, generateTitle, isDefaultTitle } from "./title.js";
import { promptYou, restoreTerminal, confirmQuit, takeForcedQuit, USER_PROMPT, ASSISTANT_PREFIX, watchTurnAbort } from "./prompt.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { formatToolCallLine, formatToolResultLines } from "./tool-ui.js";

const BOOLEAN_FLAGS = new Set(["resume", "new", "no-stream", "no-agent"]);
const WORKSPACE = process.cwd();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function parsePositiveInt(label: string, raw: string | undefined) {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} 必须是正数`);
  }
  return Math.floor(n);
}

function envPositiveInt(raw: string | undefined, fallback: number) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function flagOn(value: string | undefined) {
  return value === "true" || value === "";
}

function usage() {
  return `用法:
  npm start [-- --input <文本>]
  npm start -- --new
  npm start -- --id <conversation-uuid>
  npm start -- --url/--api/--model/--name/--context/--output/--effort/--steps/--max

OpenAI 兼容 Provider：name / url / api / model / context window / max output / thinking effort
交互里 /provider 查看或修改。Esc 中止当前轮，/quit 退出。`;
}

function printBanner(session: Session, extra: { provider: Provider; stream: boolean; agent: boolean; steps: number }) {
  console.log(`工作目录: ${WORKSPACE}`);
  console.log(`会话: ${session.title || "新会话"}`);
  console.log(`编号: ${session.id}`);
  console.log(`Provider: ${extra.provider.name}  模型: ${extra.provider.model}`);
  console.log(
    `上下文: ${extra.provider.contextWindow}  最大输出: ${extra.provider.maxOutput}  思考: ${extra.provider.thinkingEffort}`,
  );
  console.log(`流式: ${extra.stream ? "开" : "关"}  Agent: ${extra.agent ? "开" : "关"}  工具步数: ${extra.steps}`);
  console.log("/new 新会话  /session 或 /chat 恢复对话  /provider 适配  /quit 退出");
  console.log("输入 / 后会按前缀提示命令，Tab 补全。生成中 Esc 中止当前轮，Ctrl+C 按两次退出。\n");
}

function printContext(history: Message[]) {
  if (history.length === 0) return;
  const { recent, skipped } = previewMessages(history);
  console.log("--- 上下文 ---");
  if (skipped > 0) console.log(`... 更早 ${skipped} 条`);
  for (const message of recent) {
    console.log(formatPreviewLine(message));
  }
  console.log("--------------\n");
}

function printAgentEvent(
  event: { type: string; text?: string; name?: string; arguments?: string; result?: string },
  state: { replied: boolean },
) {
  if (event.type === "delta" && event.text) {
    if (!state.replied) {
      process.stdout.write(ASSISTANT_PREFIX);
      state.replied = true;
    }
    process.stdout.write(event.text);
    return;
  }
  if (event.type === "tool_call" && event.name) {
    const prefix = state.replied ? "\n" : "";
    state.replied = false;
    process.stdout.write(`${prefix}${formatToolCallLine(event.name, event.arguments ?? "")}`);
    return;
  }
  if (event.type === "tool_result") {
    for (const line of formatToolResultLines(event.result ?? "")) {
      process.stdout.write(`\n${line}`);
    }
    process.stdout.write("\n");
  }
}

function printErr(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nerr> ${message}\n`);
}

async function saveAbortedTurn(
  pool: Parameters<typeof saveMessages>[0],
  session: Session,
  user: Message,
) {
  await saveMessages(pool, session.id, [user]);
  session.messages.push(user);
}

function parseSlash(prompt: string) {
  const match = prompt.match(/^\/(session|sessions|chat|chats)(?:\s+(\S+))?$/i);
  if (!match) return null;
  return { arg: match[2] ?? "" };
}

async function askField(
  rl: readline.Interface,
  label: string,
  current?: string,
  secret = false,
) {
  const shown = secret && current ? "****" : (current ?? "");
  const suffix = shown ? ` [${shown}]` : "";
  const value = (await rl.question(`${label}${suffix}: `)).trim();
  return value || current || "";
}

async function editProvider(rl: readline.Interface, current: Provider): Promise<Provider> {
  console.log("\nOpenAI 兼容 Provider（回车保留当前值）");
  const name = await askField(rl, "LLM Provider name", current.name);
  const url = await askField(rl, "API url", current.url);
  const api = await askField(rl, "API", current.api, true);
  const model = await askField(rl, "model name", current.model);
  const contextWindow = Number(await askField(rl, "context window", String(current.contextWindow)));
  const maxOutput = Number(await askField(rl, "max output", String(current.maxOutput)));
  const thinking = (await askField(rl, "thinking effort", current.thinkingEffort)).toLowerCase();
  if (!isThinkingEffort(thinking)) {
    throw new Error("thinking effort 必须是 none | minimal | low | medium | high | xhigh");
  }
  if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
    throw new Error("context window / max output 必须是数字");
  }
  return saveProvider({
    name,
    url,
    api,
    model,
    contextWindow,
    maxOutput,
    thinkingEffort: thinking,
  });
}

async function handleProvider(
  rl: readline.Interface,
  provider: Provider,
  arg: string,
): Promise<Provider> {
  const rest = arg.trim();
  if (!rest || rest === "show") {
    console.log(`\n${formatProvider(provider)}\n`);
    return provider;
  }
  if (rest === "list") {
    const rows = listProviders(provider);
    console.log("\n--- Provider ---");
    for (const item of rows) {
      const mark = item.name === provider.name ? "*" : " ";
      console.log(`${mark} ${item.name}  ${item.model}  ctx=${item.contextWindow}  max=${item.maxOutput}  think=${item.thinkingEffort}`);
    }
    console.log("");
    return provider;
  }
  if (rest === "edit" || rest === "new") {
    try {
      const base = rest === "new" ? { ...provider, name: "", model: provider.model } : provider;
      const next = await editProvider(rl, base);
      console.log(`\n已保存 Provider: ${next.name}\n`);
      return next;
    } catch (error) {
      printErr(error);
      return provider;
    }
  }
  try {
    const next = switchProvider(rest);
    console.log(`\n已切换到 ${next.name} (${next.model})\n`);
    return next;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n${message}\n`);
    return provider;
  }
}

async function pickSession(
  rl: readline.Interface,
  pool: Parameters<typeof listConversations>[0],
  session: Session,
  arg: string,
): Promise<Session | null> {
  const rows = await listConversations(pool);
  if (rows.length === 0) {
    console.log("没有可恢复的会话。\n");
    return null;
  }

  if (arg) {
    if (UUID_RE.test(arg)) {
      const picked = rows.find((row) => row.id === arg);
      if (!picked) {
        console.log("找不到这个会话编号。\n");
        return null;
      }
      return await loadSession(pool, picked.id);
    }
    const index = Number(arg);
    if (!Number.isInteger(index) || index < 1 || index > rows.length) {
      console.log("序号无效。\n");
      return null;
    }
    return await loadSession(pool, rows[index - 1].id);
  }

  console.log("\n--- 会话 ---");
  console.log(formatConversationList(rows, session.id));
  const answer = (await rl.question("输入序号恢复，回车取消: ")).trim();
  if (!answer || answer === "q" || answer === "/exit" || answer === "/quit") {
    console.log("");
    return null;
  }
  return await pickSession(rl, pool, session, answer);
}

async function maybeNameSession(params: {
  pool: Parameters<typeof updateConversationTitle>[0];
  session: Session;
  provider: Provider;
  userText: string;
  assistantText: string;
}) {
  if (!isDefaultTitle(params.session.title)) return;
  const title = await generateTitle({
    provider: params.provider,
    userText: params.userText,
    assistantText: params.assistantText,
  });
  await updateConversationTitle(params.pool, params.session.id, title);
  params.session.title = title;
  console.log(`会话: ${title}`);
}

async function main() {
  loadEnv(resolve(process.cwd(), ".env"));
  const flags = parseArgs(process.argv.slice(2));
  let provider = loadProvider();
  if (flags.url) provider = { ...provider, url: flags.url };
  if (flags.api) provider = { ...provider, api: flags.api };
  if (flags.model) provider = { ...provider, model: flags.model };
  if (flags.name) provider = { ...provider, name: flags.name };
  const contextFlag = parsePositiveInt("--context", flags.context);
  const outputFlag = parsePositiveInt("--output", flags.output);
  if (contextFlag !== undefined) provider = { ...provider, contextWindow: contextFlag };
  if (outputFlag !== undefined) provider = { ...provider, maxOutput: outputFlag };
  if (flags.effort && isThinkingEffort(flags.effort)) {
    provider = { ...provider, thinkingEffort: flags.effort };
  } else if (flags.effort) {
    throw new Error("--effort 必须是 none | minimal | low | medium | high | xhigh");
  }

  const databaseUrl =
    flags.database ?? process.env.DATABASE_URL ?? "postgres://localhost:5432/socode";
  const userSystem = flags.system ?? process.env.SYSTEM_PROMPT ?? "";
  const agentEnabled = !flagOn(flags["no-agent"]);
  const maxMessages =
    parsePositiveInt("--max", flags.max) ??
    envPositiveInt(process.env.MAX_CONTEXT_MESSAGES, 200);
  const maxSteps =
    parsePositiveInt("--steps", flags.steps) ??
    envPositiveInt(process.env.MAX_AGENT_STEPS, DEFAULT_MAX_AGENT_STEPS);
  const oneShot = flags.input;
  const fresh = flagOn(flags.new);
  const stream = !flagOn(flags["no-stream"]);
  const conversationFlag = flags.id;

  if (!provider.url || !provider.api || !provider.model) {
    if (oneShot !== undefined || !process.stdin.isTTY) {
      console.error(usage());
      console.error("缺少 Provider：需要 API url、API、model name。");
      process.exit(1);
    }
  }

  const pool = await connectDb(databaseUrl);
  let session = await openConversation(pool, {
    model: provider.model,
    id: conversationFlag,
    fresh,
  });

  const ask = async (history: Message[], user: Message) => {
    const state = { replied: false };
    const abort = watchTurnAbort();
    try {
      return await runAgent({
        provider,
        stream,
        maxSteps,
        useTools: agentEnabled,
        signal: abort.signal,
        messages: buildApiMessages({
          history,
          user,
          systemPrompt: agentEnabled
            ? buildSystemPrompt(WORKSPACE, userSystem)
            : userSystem || undefined,
          maxMessages,
          contextWindow: provider.contextWindow,
          maxOutput: provider.maxOutput,
        }),
        onEvent: (event) => printAgentEvent(event, state),
      });
    } finally {
      abort.dispose();
    }
  };

  const extra = () => ({ provider, stream, agent: agentEnabled, steps: maxSteps });

  let rl: readline.Interface | undefined;
  const closeHandles = async () => {
    restoreTerminal();
    try {
      rl?.close();
    } catch {
      // ignore
    }
    await Promise.race([
      pool.end().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1500)),
    ]);
  };
  const forceExit = (code: number) => {
    restoreTerminal();
    try {
      rl?.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };
  process.on("SIGINT", () => {
    if (confirmQuit()) forceExit(130);
  });
  process.once("SIGTERM", () => forceExit(143));

  try {
    if (oneShot !== undefined) {
      const user: Message = { role: "user", content: oneShot };
      try {
        const { reply, trace } = await ask(session.messages, user);
        await saveMessages(pool, session.id, [user, ...trace]);
        session.messages.push(user, ...trace);
        if (!reply.endsWith("\n")) process.stdout.write("\n");
        await maybeNameSession({
          pool,
          session,
          provider,
          userText: oneShot,
          assistantText: reply,
        });
      } catch (error) {
        if (isTurnAborted(error)) {
          await saveAbortedTurn(pool, session, user);
          if (takeForcedQuit()) forceExit(130);
          process.stdout.write("\n已中止\n");
          return;
        }
        throw error;
      }
      return;
    }

    const sessionRl = readline.createInterface({ input, output });
    rl = sessionRl;
    if (!provider.url || !provider.api || !provider.model) {
      provider = await editProvider(sessionRl, provider);
      console.log("");
    }
    printBanner(session, extra());
    printContext(session.messages);

    while (true) {
      sessionRl.pause();
      const prompt = (await promptYou(USER_PROMPT)).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") {
        if (takeForcedQuit()) forceExit(130);
        break;
      }
      try {
        if (prompt === "/new") {
          session = await createConversation(pool, provider.model);
          console.log("");
          printBanner(session, extra());
          continue;
        }
        if (prompt === "/provider" || prompt.startsWith("/provider ")) {
          sessionRl.resume();
          const arg = prompt.slice("/provider".length).trim();
          provider = await handleProvider(sessionRl, provider, arg);
          continue;
        }
        const restore = parseSlash(prompt);
        if (restore) {
          sessionRl.resume();
          const picked = await pickSession(sessionRl, pool, session, restore.arg);
          if (picked) {
            session = picked;
            console.log("");
            printBanner(session, extra());
            printContext(session.messages);
          }
          continue;
        }

        const user: Message = { role: "user", content: prompt };
        try {
          const { reply, trace } = await ask(session.messages, user);
          await saveMessages(pool, session.id, [user, ...trace]);
          session.messages.push(user, ...trace);
          process.stdout.write(reply.endsWith("\n") ? "\n" : "\n\n");
          await maybeNameSession({
            pool,
            session,
            provider,
            userText: prompt,
            assistantText: reply,
          });
        } catch (error) {
          if (isTurnAborted(error)) {
            await saveAbortedTurn(pool, session, user);
            if (takeForcedQuit()) forceExit(130);
            process.stdout.write("\n已中止\n\n");
            continue;
          }
          printErr(error);
        }
      } catch (error) {
        printErr(error);
      }
    }
  } finally {
    await closeHandles();
  }
}

process.on("exit", restoreTerminal);

main()
  .then(() => {
    restoreTerminal();
    process.exit(0);
  })
  .catch((error) => {
    restoreTerminal();
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
