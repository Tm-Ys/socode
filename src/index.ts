import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { isTurnAborted, TurnAborted, TurnFailed } from "./abort.js";
import { closeIncompleteTrace, DEFAULT_MAX_AGENT_STEPS, runAgent } from "./agent.js";
import type { TokenUsage } from "./chat.js";
import { canCompress, compressHistory, shouldAutoCompress } from "./compress.js";
import {
  buildApiMessages,
  formatContextReport,
  formatPreviewLine,
  measureContext,
  previewMessages,
  toolsTokensFromSpecs,
} from "./context.js";
import {
  connectDb,
  createConversation,
  listConversations,
  loadSession,
  openConversation,
  replaceMessages,
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
import { assistantPrefix, harnessModeMessage, lastHarnessMode, loadMode, modeHint, modeLabel, paintMode, parseMode, userPrefix, type AgentMode } from "./mode.js";
import { createPolicy } from "./permissions.js";
import { createLongApprover } from "./long-approve.js";
import { openMcpHub } from "./mcp.js";
import { formatSkillsCli, loadSkillBundle } from "./skills.js";
import { activateBaseSkills, logSkillActivate } from "./skill-activate.js";
import { promptYou, restoreTerminal, confirmQuit, takeForcedQuit, watchTurnAbort, setPermissionGate } from "./prompt.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createSubagentRunner, createSubagentStore, DEFAULT_SUBAGENT_STEPS } from "./subagent.js";
import {
  createTaskStore,
  checkpointReply,
  emptyTaskState,
  formatTaskStateCli,
  isEmptyTaskState,
  lastTaskState,
  seedGoalFromUser,
  taskStateEqual,
  taskStateMessage,
  type TaskStore,
} from "./task-state.js";
import { formatToolCallLine, formatToolResultLines } from "./tool-ui.js";
import { toolSpecs } from "./tools.js";

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
  npm start -- --url/--api/--model/--name/--context/--output/--effort/--steps/--max/--mode/--budget

OpenAI 兼容 Provider：name / url / api / model / context window / max output / thinking effort
权限模式：--mode full | ask | plan | long（也可用 /mode 切换，长程可用 长程）。Esc 中止当前轮，/quit 退出。`;
}

function printBanner(session: Session, extra: { provider: Provider; stream: boolean; agent: boolean; steps: number; mode: AgentMode; mcp?: string }) {
  console.log(`工作目录: ${WORKSPACE}`);
  console.log(`会话: ${session.title || "新会话"}`);
  console.log(`编号: ${session.id}`);
  console.log(`Provider: ${extra.provider.name}  模型: ${extra.provider.model}`);
  console.log(
    `上下文: ${extra.provider.contextWindow}  最大输出: ${extra.provider.maxOutput}  思考: ${extra.provider.thinkingEffort}`,
  );
  console.log(`流式: ${extra.stream ? "开" : "关"}  Agent: ${extra.agent ? "开" : "关"}  工具步数: ${extra.steps}`);
  console.log(`模式: ${paintMode(extra.mode, modeLabel(extra.mode))}  ${modeHint(extra.mode)}`);
  if (extra.mcp) console.log(extra.mcp);
  console.log("/new 新会话  /session 恢复  /provider 适配  /context 上下文  /compress 压缩  /mode 权限  /task 长程  /mcp  MCP  /skills 技能  /quit 退出");
  console.log("输入 / 后会按前缀提示命令，Tab 补全。生成中 Esc 中止当前轮，Ctrl+C 按两次退出。\n");
}

function printContext(history: Message[], mode: AgentMode) {
  if (history.length === 0) return;
  const { recent, skipped } = previewMessages(history);
  console.log("--- 上下文 ---");
  if (skipped > 0) console.log(`... 更早 ${skipped} 条`);
  for (const message of recent) {
    console.log(formatPreviewLine(message, mode));
  }
  console.log("--------------\n");
}

function printAgentEvent(
  event: { type: string; text?: string; name?: string; arguments?: string; result?: string },
  state: { replied: boolean },
  mode: AgentMode,
  tag?: string,
) {
  const nest = tag ? `  [${tag}] ` : "";
  if (event.type === "delta" && event.text) {
    if (!state.replied) {
      process.stdout.write(nest || assistantPrefix(mode));
      state.replied = true;
    }
    process.stdout.write(event.text);
    return;
  }
  if (event.type === "tool_call" && event.name) {
    const prefix = state.replied ? "\n" : "";
    state.replied = false;
    process.stdout.write(`${prefix}${nest}${formatToolCallLine(event.name, event.arguments ?? "")}`);
    return;
  }
  if (event.type === "tool_result") {
    for (const line of formatToolResultLines(event.result ?? "")) {
      process.stdout.write(`\n${nest}${line}`);
    }
    process.stdout.write("\n");
  }
}

function printErr(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nerr> ${message}\n`);
}

function failedTurnTrace(error: unknown): Message[] {
  if (error instanceof TurnAborted || error instanceof TurnFailed) {
    return closeIncompleteTrace(error.trace);
  }
  return [];
}

async function saveFailedTurn(
  pool: Parameters<typeof saveMessages>[0],
  session: Session,
  user: Message,
  error: unknown,
) {
  const trace = failedTurnTrace(error);
  const extra: Message[] = isTurnAborted(error)
    ? []
    : [
        {
          role: "assistant",
          content: `本轮失败: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
  const batch = [user, ...trace, ...extra];
  await saveMessages(pool, session.id, batch);
  session.messages.push(...batch);
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

function handleMode(mode: AgentMode, arg: string): { mode: AgentMode; changed: boolean } {
  const rest = arg.trim();
  if (!rest || rest === "show") {
    console.log(`\n模式: ${paintMode(mode, modeLabel(mode))}`);
    console.log(modeHint(mode));
    console.log(`\n/mode full   ${paintMode("full", "Full Access")}，直接改文件和跑命令`);
    console.log(`/mode ask    ${paintMode("ask", "Ask")}，创建/修改/删除先按 y/n/a 审批`);
    console.log(`/mode plan   ${paintMode("plan", "Plan")}，只能看和写计划，不能动手`);
    console.log(`/mode long   ${paintMode("long", "Long")} / 长程，记住目标、自动压缩；副作用走 LLM 审批，不是 Full\n`);
    return { mode, changed: false };
  }
  const next = parseMode(rest);
  if (!next) {
    console.log("\n未知模式。用 /mode full、/mode ask、/mode plan 或 /mode long（长程）。\n");
    return { mode, changed: false };
  }
  if (next === mode) {
    console.log(`\n已经是 ${paintMode(mode, modeLabel(mode))}`);
    console.log(`${modeHint(mode)}\n`);
    return { mode, changed: false };
  }
  console.log(`\n已切换到 ${paintMode(next, modeLabel(next))}`);
  console.log(`${modeHint(next)}\n`);
  return { mode: next, changed: true };
}

async function rememberTaskState(
  pool: Parameters<typeof saveMessages>[0],
  session: Session,
  store: TaskStore,
) {
  const current = store.get();
  const last = lastTaskState(session.messages);
  if (last && taskStateEqual(last, current)) return;
  if (!last && isEmptyTaskState(current)) return;
  const notice = taskStateMessage(current);
  await saveMessages(pool, session.id, [notice]);
  session.messages.push(notice);
}

function handleTask(store: TaskStore, arg: string) {
  const rest = arg.trim();
  if (!rest || rest === "show") {
    console.log(`\n${formatTaskStateCli(store.get())}\n`);
    return true;
  }
  if (rest === "clear") {
    store.replace(emptyTaskState());
    console.log("\n已清空任务状态。\n");
    return true;
  }
  const match = rest.match(/^(goal|目标|note|notes|备注|milestone|里程碑)\s*[：: ]\s*([\s\S]+)/i);
  if (match) {
    const kind = match[1].toLowerCase();
    const text = match[2].trim();
    if (kind === "goal" || kind === "目标") store.patch({ goal: text });
    else if (kind === "milestone" || kind === "里程碑") store.patch({ addMilestone: text });
    else store.patch({ notes: text });
    console.log(`\n${formatTaskStateCli(store.get())}\n`);
    return true;
  }
  console.log("\n用法: /task    /task goal <目标>    /task milestone <项>    /task note <备注>    /task clear\n");
  return false;
}

async function rememberMode(
  pool: Parameters<typeof saveMessages>[0],
  session: Session,
  mode: AgentMode,
) {
  if (lastHarnessMode(session.messages) === mode) return;
  const notice = harnessModeMessage(mode);
  await saveMessages(pool, session.id, [notice]);
  session.messages.push(notice);
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
  const maxTokens =
    parsePositiveInt("--budget", flags.budget) ??
    parsePositiveInt("MAX_AGENT_TOKENS", process.env.MAX_AGENT_TOKENS);
  const oneShot = flags.input;
  const fresh = flagOn(flags.new);
  const stream = !flagOn(flags["no-stream"]);
  const conversationFlag = flags.id;
  let mode = loadMode(flags.mode);

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
  await rememberMode(pool, session, mode);

  const tasks = createTaskStore(lastTaskState(session.messages));
  const subagents = createSubagentStore();
  const mcp = await openMcpHub(WORKSPACE);
  const longApprove = createLongApprover(() => provider);
  const policy = createPolicy(WORKSPACE, () => mode, tasks, { longApprove, subagents, mcp });
  const childUi = new Map<number, { replied: boolean }>();
  policy.spawnSubagent = createSubagentRunner({
    getProvider: () => provider,
    getPolicy: () => policy,
    workspace: WORKSPACE,
    maxSteps: envPositiveInt(process.env.SUBAGENT_STEPS, DEFAULT_SUBAGENT_STEPS),
    stream,
    onEvent: (meta, event) => {
      let ui = childUi.get(meta.job.id);
      if (!ui) {
        ui = { replied: false };
        childUi.set(meta.job.id, ui);
      }
      const tag = `${meta.index}/${meta.total} ${meta.job.kind}:${meta.job.label}`;
      printAgentEvent(event, ui, mode, tag);
    },
  });
  let lastUsage: TokenUsage | undefined;

  const currentSystem = (activated: string[] = []) =>
    agentEnabled
      ? buildSystemPrompt(
          WORKSPACE,
          userSystem,
          mode,
          mode === "long" ? tasks.get() : undefined,
          mcp.specs({ mode }).map((tool) => tool.name),
          activated,
        )
      : userSystem || undefined;
  const currentToolsTokens = () =>
    agentEnabled ? toolsTokensFromSpecs(toolSpecs(mode, { extra: mcp.specs({ mode }) })) : 0;
  const contextBudget = () =>
    Math.max(512, Math.floor((provider.contextWindow - provider.maxOutput - 256) * 0.9));

  const reloadTasks = () => {
    tasks.replace(lastTaskState(session.messages) ?? emptyTaskState());
  };

  const ask = async (history: Message[], user: Message) => {
    const state = { replied: false };
    const abort = watchTurnAbort();
    setPermissionGate(abort);
    try {
      let activated: string[] = [];
      if (agentEnabled) {
        const decision = await activateBaseSkills({
          prompt: user.content,
          mode,
          skills: loadSkillBundle(WORKSPACE).skills,
          provider,
          signal: abort.signal,
        });
        activated = decision.activate;
        logSkillActivate(decision);
      }
      return await runAgent({
        provider,
        stream,
        maxSteps,
        maxTokens: mode === "long" ? maxTokens : undefined,
        maxContextTokens: mode === "long" ? contextBudget() : undefined,
        useTools: agentEnabled,
        signal: abort.signal,
        policy,
        messages: buildApiMessages({
          history,
          user,
          systemPrompt: currentSystem(activated),
          maxMessages,
          contextWindow: provider.contextWindow,
          maxOutput: provider.maxOutput,
          toolsTokens: currentToolsTokens(),
          mode,
        }),
        onEvent: (event) => printAgentEvent(event, state, mode),
      });
    } finally {
      setPermissionGate(undefined);
      abort.dispose();
    }
  };

  const extra = () => ({
    provider,
    stream,
    agent: agentEnabled,
    steps: maxSteps,
    mode,
    mcp: `MCP: ${mcp.toolNames().length} 个工具`,
  });

  const printContextUsage = (history: Message[]) => {
    const report = measureContext({
      history,
      systemPrompt: currentSystem(),
      toolsTokens: currentToolsTokens(),
      maxMessages,
      contextWindow: provider.contextWindow,
      maxOutput: provider.maxOutput,
      mode,
    });
    const cols = process.stdout.columns ?? 40;
    const width = Math.max(16, Math.min(48, cols - 2));
    console.log(`\n${formatContextReport(report, width, Boolean(process.stdout.isTTY))}`);
    if (lastUsage) {
      const prompt = lastUsage.promptTokens.toLocaleString("en-US");
      const completion = lastUsage.completionTokens.toLocaleString("en-US");
      console.log(`API 回报  prompt ${prompt}  completion ${completion}`);
    }
    console.log("");
  };

  const runCompress = async (history: Message[]) => {
    if (!canCompress(history)) {
      console.log("\n对话还不够长，无需压缩。\n");
      return history;
    }
    console.log("\n正在压缩上下文…");
    const abort = watchTurnAbort();
    const state = { replied: false };
    try {
      const result = await compressHistory({
        provider,
        history,
        signal: abort.signal,
        onDelta: (text) => {
          if (!state.replied) {
            process.stdout.write(assistantPrefix(mode));
            state.replied = true;
          }
          process.stdout.write(text);
        },
      });
      await replaceMessages(pool, session.id, result.messages);
      process.stdout.write(
        `\n\n已压缩，大约省下 ${result.saved.toLocaleString("en-US")} tokens\n`,
      );
      printContextUsage(result.messages);
      return result.messages;
    } finally {
      abort.dispose();
    }
  };

  const maybeAutoCompress = async (history: Message[]) => {
    if (mode !== "long") return history;
    const report = measureContext({
      history,
      systemPrompt: currentSystem(),
      toolsTokens: currentToolsTokens(),
      maxMessages,
      contextWindow: provider.contextWindow,
      maxOutput: provider.maxOutput,
      mode,
    });
    if (!shouldAutoCompress({ history, report })) return history;
    console.log("\n长程模式：上下文接近上限，自动压缩…");
    return await runCompress(history);
  };

  const showLongTask = () => {
    if (mode !== "long") return;
    console.log(formatTaskStateCli(tasks.get()));
    console.log("");
  };

  let rl: readline.Interface | undefined;
  const closeHandles = async () => {
    restoreTerminal();
    try {
      rl?.close();
    } catch {
      // ignore
    }
    await mcp.close().catch(() => undefined);
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
        if (mode === "long") {
          session.messages = await maybeAutoCompress(session.messages);
          tasks.replace(seedGoalFromUser(tasks.get(), oneShot));
          await rememberTaskState(pool, session, tasks);
        }
        const { reply, trace, usage } = await ask(session.messages, user);
        lastUsage = usage;
        await saveMessages(pool, session.id, [user, ...trace]);
        session.messages.push(user, ...trace);
        await rememberTaskState(pool, session, tasks);
        if (!reply.endsWith("\n")) process.stdout.write("\n");
        await maybeNameSession({
          pool,
          session,
          provider,
          userText: oneShot,
          assistantText: reply,
        });
      } catch (error) {
        await saveFailedTurn(pool, session, user, error);
        if (mode === "long") {
          await rememberTaskState(pool, session, tasks);
        }
        if (isTurnAborted(error)) {
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
    printContext(session.messages, mode);
    showLongTask();

    while (true) {
      sessionRl.pause();
      const prompt = (await promptYou(userPrefix(mode))).trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") {
        if (takeForcedQuit()) forceExit(130);
        break;
      }
      try {
        if (prompt === "/context") {
          printContextUsage(session.messages);
          continue;
        }
        if (prompt === "/task" || prompt.startsWith("/task ")) {
          handleTask(tasks, prompt.slice("/task".length).trim());
          await rememberTaskState(pool, session, tasks);
          continue;
        }
        if (prompt === "/mcp") {
          console.log(`\n${mcp.statusText()}`);
          const names = mcp.toolNames();
          if (names.length) console.log(`工具: ${names.join(", ")}`);
          console.log("");
          continue;
        }
        if (prompt === "/skills") {
          console.log(`\n${formatSkillsCli(loadSkillBundle(WORKSPACE), WORKSPACE)}\n`);
          continue;
        }
        if (prompt === "/compress") {
          try {
            session.messages = await runCompress(session.messages);
            await rememberMode(pool, session, mode);
            await rememberTaskState(pool, session, tasks);
          } catch (error) {
            if (isTurnAborted(error)) {
              if (takeForcedQuit()) forceExit(130);
              process.stdout.write("\n已中止\n\n");
              continue;
            }
            throw error;
          }
          continue;
        }
        if (prompt === "/mode" || prompt.startsWith("/mode ")) {
          const result = handleMode(mode, prompt.slice("/mode".length).trim());
          mode = result.mode;
          if (result.changed) {
            await rememberMode(pool, session, mode);
            if (mode === "long") showLongTask();
          }
          continue;
        }
        if (prompt === "/new") {
          session = await createConversation(pool, provider.model);
          reloadTasks();
          await rememberMode(pool, session, mode);
          console.log("");
          printBanner(session, extra());
          showLongTask();
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
            reloadTasks();
            await rememberMode(pool, session, mode);
            console.log("");
            printBanner(session, extra());
            printContext(session.messages, mode);
            showLongTask();
          }
          continue;
        }

        const user: Message = { role: "user", content: prompt };
        try {
          if (mode === "long") {
            session.messages = await maybeAutoCompress(session.messages);
            tasks.replace(seedGoalFromUser(tasks.get(), prompt));
            await rememberTaskState(pool, session, tasks);
          }
          const { reply, trace, usage } = await ask(session.messages, user);
          lastUsage = usage;
          await saveMessages(pool, session.id, [user, ...trace]);
          session.messages.push(user, ...trace);
          await rememberTaskState(pool, session, tasks);
          process.stdout.write(reply.endsWith("\n") ? "\n" : "\n\n");
          await maybeNameSession({
            pool,
            session,
            provider,
            userText: prompt,
            assistantText: reply,
          });
        } catch (error) {
          await saveFailedTurn(pool, session, user, error);
          if (mode === "long") await rememberTaskState(pool, session, tasks);
          if (isTurnAborted(error)) {
            if (mode === "long") process.stdout.write(`\n${checkpointReply(tasks.get(), "abort")}\n`);
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
