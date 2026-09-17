import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatBanner, pickWelcome } from "./banner.js";
import { closeIncompleteTrace, DEFAULT_MAX_AGENT_STEPS, runAgent, type AgentEvent } from "./agent.js";
import type { TokenUsage } from "./chat.js";
import { canCompress, compressHistory, shouldAutoCompress } from "./compress.js";
import {
  buildApiMessages,
  formatContextMeter,
  formatContextReport,
  measureContext,
  toolsTokensFromSpecs,
} from "./context.js";
import {
  connectDb,
  emptySession,
  listConversations,
  loadSession,
  openConversation,
  persistSession,
  discardEmptySession,
  replaceMessages,
  saveMessages,
  sessionHasChat,
  updateConversationTitle,
  type Message,
  type Session,
} from "./db.js";
import {
  addProvider,
  applyProviderDraft,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  DEFAULT_THINKING_EFFORT,
  emptyProvider,
  findProvider,
  formatProvider,
  hasSavedProvider,
  isThinkingEffort,
  listProviders,
  loadProvider,
  maskApiKey,
  providerReady,
  resolveFieldInput,
  saveProvider,
  switchProvider,
  THINKING_EFFORTS,
  type Provider,
} from "./provider.js";
import { createModelPickState, defaultEffortIndex, fetchModelCatalog } from "./provider-api.js";
import { pickEffort, pickProviderModel, pickSavedProvider } from "./select-ui.js";
import { formatConversationList, generateTitle, isDefaultTitle, statusSessionLabel } from "./title.js";
import { assistantPrefix, harnessModeMessage, lastHarnessMode, loadMode, modeHint, modeLabel, paintMode, parseMode, userPrefix, type AgentMode } from "./mode.js";
import { createPolicy } from "./permissions.js";
import { createLongApprover } from "./long-approve.js";
import { createLongRubric } from "./long-rubric.js";
import { resolveLongBudgetFromEnv } from "./long-budget.js";
import { openMcpHub } from "./mcp.js";
import { formatSkillsCli, loadSkillBundle } from "./skills.js";
import { activateBaseSkills, logSkillActivate } from "./skill-activate.js";
import { createLoadUi } from "./load-ui.js";
import { promptYou, promptStatusLine, restoreTerminal, confirmQuit, takeForcedQuit, watchTurnAbort, setPermissionGate } from "./prompt.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createSubagentRunner, createSubagentStore, DEFAULT_SUBAGENT_STEPS } from "./subagent.js";
import { createSubagentUi, parseSeesubagent } from "./subagent-ui.js";
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
import {
  createPlanStore,
  emptyPlan,
  formatPlanCli,
  isEmptyPlan,
  lastPlan,
  parseSeeplan,
  parseSetplan,
  planEqual,
  planMessage,
  setplanUserContent,
  type PlanStore,
} from "./plan.js";
import { formatToolCallLine, formatToolResultLines } from "./tool-ui.js";
import {
  finishMarkdownLive,
  newMarkdownLive,
  paintMarkdownDelta,
  paintThinkingDelta,
  thinkingPrefix,
  useColor,
  type MarkdownLive,
} from "./markdown.js";
import { historyAfterTurn, recapLine } from "./recap.js";
import { toolSpecs } from "./tools.js";
import {
  parseSetworkarea,
  pickWorkareaFolder,
  resolveWorkarea,
  workareaPlaceholder,
} from "./workarea.js";

const BOOLEAN_FLAGS = new Set(["resume", "new", "no-stream", "no-agent"]);
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
  npm start [-- --input <文本>]          默认新会话，空对话不入库
  npm start -- --resume
  npm start -- --id <conversation-uuid>
  npm start -- --url/--api/--model/--name/--context/--output/--effort/--steps/--max/--mode/--budget

OpenAI 兼容 Provider：name / url / api / model / context window / max output / thinking effort
权限模式：--mode full | ask | plan | long（也可用 /mode 切换，长程可用 长程）。Esc 中止当前轮，/quit 退出。`;
}

function printBanner(session: Session, extra: { mode: AgentMode; workspace: string; mcpCount?: number }) {
  console.log(
    formatBanner({
      workspace: extra.workspace,
      title: session.title,
      mode: extra.mode,
      mcpCount: extra.mcpCount,
      welcome: pickWelcome(),
      width: process.stdout.columns ?? 60,
      color: useColor(),
    }),
  );
  console.log("");
}

type PrintState = {
  replied: boolean;
  md?: MarkdownLive;
  think?: MarkdownLive;
  thinkingShown?: boolean;
};

function closeThinking(state: PrintState) {
  if (state.think) {
    finishMarkdownLive(state.think);
    state.think = undefined;
    process.stdout.write("\n");
    state.thinkingShown = false;
    return;
  }
  if (state.thinkingShown) {
    state.thinkingShown = false;
    process.stdout.write("\n");
  }
}

function printAgentEvent(
  event: AgentEvent,
  state: PrintState,
  mode: AgentMode,
  tag?: string,
  hud?: { guard: (fn: () => void) => void },
) {
  const nest = tag ? `  [${tag}] ` : "";
  const paint = () => {
    if (event.type === "thinking" && event.text) {
      if (state.md) {
        finishMarkdownLive(state.md);
        state.md = undefined;
        if (state.replied) process.stdout.write("\n");
        state.replied = false;
      }
      if (!process.stdout.isTTY) {
        if (!state.thinkingShown) {
          process.stdout.write(`${thinkingPrefix(nest, false)}`);
          state.thinkingShown = true;
        }
        process.stdout.write(event.text);
        return;
      }
      if (!state.think) state.think = newMarkdownLive();
      paintThinkingDelta({
        live: state.think,
        chunk: event.text,
        prefix: thinkingPrefix(nest, useColor()),
        write: (text) => process.stdout.write(text),
        columns: process.stdout.columns ?? 80,
        color: useColor(),
      });
      return;
    }
    if (event.type === "delta" && event.text) {
      closeThinking(state);
      if (!process.stdout.isTTY) {
        if (!state.replied) {
          process.stdout.write(nest || assistantPrefix(mode));
          state.replied = true;
        }
        process.stdout.write(event.text);
        return;
      }
      if (!state.md) state.md = newMarkdownLive();
      state.replied = true;
      paintMarkdownDelta({
        live: state.md,
        chunk: event.text,
        prefix: nest || assistantPrefix(mode),
        write: (text) => process.stdout.write(text),
        columns: process.stdout.columns ?? 80,
        color: useColor(),
      });
      return;
    }
    closeThinking(state);
    if (state.md) {
      finishMarkdownLive(state.md);
      state.md = undefined;
    }
    if (event.type === "tool_call" && event.name) {
      const prefix = state.replied ? "\n" : "";
      state.replied = false;
      process.stdout.write(`${prefix}${nest}${formatToolCallLine(event.name, event.arguments ?? "")}`);
      return;
    }
    if (event.type === "tool_result") {
      if (event.name === "subagent") {
        process.stdout.write("\n");
        return;
      }
      if (event.name === "plan") {
        const body = (event.result ?? "").replace(/\s+$/u, "");
        if (body) process.stdout.write(`\n${nest}${body.split("\n").join(`\n${nest}`)}\n`);
        else process.stdout.write("\n");
        return;
      }
      for (const line of formatToolResultLines(event.result ?? "")) {
        process.stdout.write(`\n${nest}${line}`);
      }
      process.stdout.write("\n");
      return;
    }
    if (event.type === "notice" && event.text) {
      const prefix = state.replied ? "\n" : "";
      state.replied = false;
      const dim = useColor() ? "\x1b[2m" : "";
      const reset = useColor() ? "\x1b[0m" : "";
      process.stdout.write(`${prefix}${nest}${dim}${event.text}${reset}\n`);
      return;
    }
    if (event.type === "compress" && event.saved) {
      const prefix = state.replied ? "\n" : "";
      state.replied = false;
      process.stdout.write(`${prefix}${nest}压缩上下文，大约省下 ${event.saved.toLocaleString("en-US")} tokens\n`);
    }
  };
  if (hud) hud.guard(paint);
  else paint();
}

function printTurnRecap(trace: Message[]) {
  const line = recapLine(trace, { color: useColor() });
  if (!line) return;
  process.stdout.write(`\n${line}\n`);
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
  model: string,
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
  const batch = historyAfterTurn(user, [...trace, ...extra]);
  await persistSession(pool, session, model);
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
  opts?: { current?: string; hint?: string; secret?: boolean; required?: boolean },
) {
  const current = opts?.current ?? "";
  const shown = opts?.secret && current ? maskApiKey(current) : current;
  const parts = [shown && `[${shown}]`, opts?.hint && `(${opts.hint})`].filter(Boolean);
  const suffix = parts.length ? ` ${parts.join(" ")}` : "";
  while (true) {
    const raw = await rl.question(`${label}${suffix}: `);
    const resolved = resolveFieldInput(raw, current, Boolean(opts?.required));
    if (resolved.ok) return resolved.value;
    console.log(`  ${label} 不能为空`);
  }
}

async function promptProviderForm(
  rl: readline.Interface,
  mode: "new" | "edit" | "setup",
  current: Provider,
): Promise<Provider> {
  const creating = mode === "new";
  const title =
    mode === "new" ? "新增 Provider（OpenAI 兼容）" : mode === "setup" ? "配置 Provider（OpenAI 兼容）" : "编辑 Provider（OpenAI 兼容）";
  const hint =
    creating
      ? "按字段填写。名称 / API URL / API Key / 模型必填；其余回车用默认值。思考强度请用 /effort 调整。"
      : "按字段修改。回车保留方括号里的当前值。思考强度请用 /effort 调整。";
  console.log(`\n${title}\n${hint}`);
  const name = await askField(rl, "名称", {
    current: creating ? "" : current.name,
    hint: "例如 deepseek",
    required: true,
  });
  if (creating && hasSavedProvider(name)) {
    throw new Error(`已有同名 Provider: ${name}。换个名字，或先 /provider ${name} 再 /provider edit`);
  }
  const url = await askField(rl, "API URL", {
    current: creating ? "" : current.url,
    hint: "例如 https://api.deepseek.com/v1",
    required: true,
  });
  const api = await askField(rl, "API Key", {
    current: creating ? "" : current.api,
    secret: true,
    required: true,
  });
  const model = await askField(rl, "模型", {
    current: creating ? "" : current.model,
    hint: "例如 deepseek-flash",
    required: true,
  });
  const contextWindow = await askField(rl, "上下文窗口", {
    current: String(creating ? DEFAULT_CONTEXT_WINDOW : current.contextWindow),
  });
  const maxOutput = await askField(rl, "最大输出", {
    current: String(creating ? DEFAULT_MAX_OUTPUT : current.maxOutput),
  });
  const next = applyProviderDraft(
    {
      name,
      url,
      api,
      model,
      contextWindow,
      maxOutput,
      thinkingEffort: creating ? DEFAULT_THINKING_EFFORT : current.thinkingEffort,
    },
    creating ? emptyProvider() : current,
  );
  return creating ? addProvider(next) : saveProvider(next, { replaceName: current.name });
}

function printProviderList(provider: Provider) {
  const rows = listProviders(provider);
  console.log("\n--- Provider ---");
  for (const item of rows) {
    const mark = item.name === provider.name ? "*" : " ";
    console.log(`${mark} ${item.name}  ${item.model}  ctx=${item.contextWindow}  max=${item.maxOutput}  think=${item.thinkingEffort}`);
  }
  console.log("");
}

async function runProviderForm(
  rl: readline.Interface,
  mode: "new" | "edit" | "setup",
  current: Provider,
  fallback: Provider,
): Promise<Provider> {
  try {
    const next = await promptProviderForm(rl, mode, current);
    console.log(`\n已保存 Provider: ${next.name}\n`);
    return next;
  } catch (error) {
    printErr(error);
    return fallback;
  }
}

async function switchToProvider(provider: Provider, name: string): Promise<Provider> {
  if (name === provider.name) {
    console.log(`\n已经是 ${provider.name}\n`);
    return provider;
  }
  const next = switchProvider(name);
  console.log(`\n已切换到 ${next.name} (${next.model})\n`);
  return next;
}

async function handleProvider(
  rl: readline.Interface,
  provider: Provider,
  arg: string,
): Promise<Provider> {
  const rest = arg.trim();
  if (rest === "show") {
    console.log(`\n${formatProvider(provider)}\n`);
    return provider;
  }
  if (rest === "list") {
    printProviderList(provider);
    return provider;
  }
  const editMatch = /^edit(?:\s+(\S+))?$/.exec(rest);
  if (editMatch) {
    const wanted = editMatch[1];
    if (!wanted) return await runProviderForm(rl, "edit", provider, provider);
    const target = findProvider(wanted, provider);
    if (!target) {
      console.log(`\n找不到 Provider: ${wanted}\n`);
      return provider;
    }
    return await runProviderForm(rl, "edit", target, provider);
  }
  if (rest === "new") {
    return await runProviderForm(rl, "new", provider, provider);
  }
  if (!rest) {
    const rows = listProviders(provider);
    if (input.isTTY && output.isTTY) {
      const selected = Math.max(0, rows.findIndex((item) => item.name === provider.name));
      const picked = await pickSavedProvider({
        providers: rows,
        selected,
        activeName: provider.name,
      });
      if (!picked) {
        console.log("  → 已取消\n");
        return provider;
      }
      if (picked.action === "new") return await runProviderForm(rl, "new", provider, provider);
      const target = rows[picked.index];
      if (!target) return provider;
      if (picked.action === "edit") return await runProviderForm(rl, "edit", target, provider);
      try {
        return await switchToProvider(provider, target.name);
      } catch (error) {
        printErr(error);
        return provider;
      }
    }
    console.log(`\n${formatProvider(provider)}\n`);
    return provider;
  }
  try {
    return await switchToProvider(provider, rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`\n${message}`);
    console.log("用法: /provider    /provider list    /provider new    /provider edit [name]    /provider <name>\n");
    return provider;
  }
}

async function handleEffort(provider: Provider, arg: string): Promise<Provider> {
  const rest = arg.trim().toLowerCase();
  if (rest) {
    if (!isThinkingEffort(rest)) {
      console.log("\n未知思考强度。用 none | minimal | low | medium | high | xhigh，或直接 /effort 用方向键选。\n");
      return provider;
    }
    if (rest === provider.thinkingEffort) {
      console.log(`\n思考强度已经是 ${rest}\n`);
      return provider;
    }
    const next = saveProvider({ ...provider, thinkingEffort: rest });
    console.log(`\n思考强度: ${next.thinkingEffort}\n`);
    return next;
  }
  console.log("\n正在从 API 读取思考强度…");
  const catalog = await fetchModelCatalog(provider);
  const efforts = catalog.efforts.length ? catalog.efforts : [...THINKING_EFFORTS];
  const hint =
    catalog.source === "api" && catalog.apiEffort
      ? `API: ${catalog.apiEffort}`
      : catalog.source === "api"
        ? "已从 API 读取可用档位"
        : "API 未返回，使用本地档位";
  const current =
    catalog.apiEffort && efforts.includes(catalog.apiEffort) ? catalog.apiEffort : provider.thinkingEffort;
  const start = defaultEffortIndex(efforts, current);
  if (!input.isTTY || !output.isTTY) {
    console.log(`当前思考强度: ${provider.thinkingEffort}  ${hint}`);
    console.log(`档位: ${efforts.join(" | ")}`);
    console.log("非 TTY 请用 /effort medium 这类写法。\n");
    return provider;
  }
  const picked = await pickEffort({
    efforts: [...efforts],
    selected: start,
    hint,
  });
  if (!picked) {
    console.log("  → 已取消\n");
    return provider;
  }
  if (picked === provider.thinkingEffort) {
    console.log(`  → ${picked}\n`);
    return provider;
  }
  const next = saveProvider({ ...provider, thinkingEffort: picked });
  console.log(`  → ${next.thinkingEffort}\n`);
  return next;
}

async function handleModel(provider: Provider, arg: string): Promise<Provider> {
  const rest = arg.trim();
  const rows = listProviders(provider);
  if (rest) {
    try {
      if (rest === provider.name && rest === provider.model) {
        console.log(`\n已经是 ${provider.name} / ${provider.model}\n`);
        return provider;
      }
      if (rows.some((item) => item.name === rest) && rest !== provider.name) {
        const next = switchProvider(rest);
        console.log(`\n已切换到 ${next.name} (${next.model})\n`);
        return next;
      }
      const named = rows.find((item) => item.model === rest || `${item.name}/${item.model}` === rest);
      if (named) {
        if (named.name === provider.name && named.model === provider.model) {
          console.log(`\n已经是 ${named.name} / ${named.model}\n`);
          return provider;
        }
        const next = named.name === provider.name ? saveProvider({ ...provider, model: named.model }) : switchProvider(named.name);
        console.log(`\n已切换到 ${next.name} (${next.model})\n`);
        return next;
      }
      console.log("\n只能选已保存的 Provider 或模型。用法: /model    /model <provider>    /model <model>\n");
      return provider;
    } catch (error) {
      printErr(error);
      return provider;
    }
  }
  if (!input.isTTY || !output.isTTY) {
    console.log("\n--- 已保存的 Provider / 模型 ---");
    for (const item of rows) {
      const mark = item.name === provider.name ? "*" : " ";
      console.log(`${mark} ${item.name}  ${item.model}`);
    }
    console.log("非 TTY 请用 /model <provider>\n");
    return provider;
  }
  const picked = await pickProviderModel(createModelPickState(rows, provider));
  if (!picked) {
    console.log("  → 已取消\n");
    return provider;
  }
  try {
    const next = applyPickedModel(provider, rows, picked.providerName, picked.model);
    if (next.name === provider.name && next.model === provider.model && next.thinkingEffort === provider.thinkingEffort) {
      console.log(`  → ${next.name} / ${next.model}\n`);
      return provider;
    }
    console.log(`  → ${next.name} / ${next.model}\n`);
    return next;
  } catch (error) {
    printErr(error);
    return provider;
  }
}

function applyPickedModel(current: Provider, all: Provider[], providerName: string, model: string) {
  const named = all.find((item) => item.name === providerName);
  const match =
    all.find((item) => item.name === providerName && item.model === model) ??
    all.find((item) => item.url === (named?.url ?? current.url) && item.model === model);
  if (match) {
    if (match.name === current.name && match.model === current.model) return current;
    return match.name === current.name ? saveProvider({ ...current, model }) : switchProvider(match.name);
  }
  const base = named ?? current;
  if (base.name === current.name && base.model === model) return current;
  return saveProvider({ ...base, model });
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
  session.messages.push(notice);
  if (session.persisted && session.id) await saveMessages(pool, session.id, [notice]);
}

async function rememberPlan(
  pool: Parameters<typeof saveMessages>[0],
  session: Session,
  store: PlanStore,
) {
  const current = store.get();
  const last = lastPlan(session.messages);
  if (last && planEqual(last, current)) return;
  if (!last && isEmptyPlan(current)) return;
  const notice = planMessage(current);
  session.messages.push(notice);
  if (session.persisted && session.id) await saveMessages(pool, session.id, [notice]);
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

function handleSeesubagent(ui: ReturnType<typeof createSubagentUi>, input: string) {
  const cmd = parseSeesubagent(input);
  if (!cmd) return false;
  if (cmd.kind === "help") {
    console.log("\n用法: /seesubagent [序号]    /seesubagent off\n");
    ui.refresh();
    return true;
  }
  if (cmd.kind === "off") {
    ui.watch(null);
    console.log("\n已隐藏子代理过程\n");
    ui.refresh();
    return true;
  }
  if (cmd.kind === "list") {
    console.log(`\n${ui.listText()}\n`);
    ui.refresh();
    return true;
  }
  const job = ui.watch(cmd.index);
  if (!job) {
    console.log(`\n没有序号 ${cmd.index} 的子代理。\n${ui.listText()}\n`);
    ui.refresh();
    return true;
  }
  const follow = job.phase === "running" || job.phase === "pending" ? "\n（仍在跑，后续过程会显示在上面）" : "";
  console.log(`\n${ui.logText(job.id)}${follow}\n`);
  ui.refresh();
  return true;
}

function handleSeeplan(store: PlanStore, input: string) {
  if (!parseSeeplan(input)) return false;
  console.log(`\n${formatPlanCli(store.get())}\n`);
  return true;
}

function setplanUsage() {
  console.log("\n用法: /setplan <任务说明>");
  console.log("本轮强制调用 plan 按说明拆目标，并激活 grill-me 追问决策。未达成共识前不改代码。\n");
}

function prepareUserTurn(raw: string) {
  const setplan = parseSetplan(raw);
  if (setplan && !setplan.prompt) return { usage: true as const };
  if (setplan) {
    return {
      user: { role: "user" as const, content: setplanUserContent(setplan.prompt) },
      skillPrompt: setplan.prompt,
      requirePlan: true,
      forceSkills: ["grill-me"],
      titleText: setplan.prompt,
    };
  }
  return {
    user: { role: "user" as const, content: raw },
    skillPrompt: raw,
    titleText: raw,
  };
}

async function rememberMode(
  pool: Parameters<typeof saveMessages>[0],
  session: Session,
  mode: AgentMode,
) {
  if (lastHarnessMode(session.messages) === mode) return;
  const notice = harnessModeMessage(mode);
  session.messages.push(notice);
  if (session.persisted && session.id) await saveMessages(pool, session.id, [notice]);
}

async function maybeNameSession(params: {
  pool: Parameters<typeof updateConversationTitle>[0];
  session: Session;
  provider: Provider;
  userText: string;
  assistantText: string;
}) {
  if (!isDefaultTitle(params.session.title) || !params.session.id) return;
  const title = await generateTitle({
    provider: params.provider,
    userText: params.userText,
    assistantText: params.assistantText,
  });
  await updateConversationTitle(params.pool, params.session.id, title);
  params.session.title = title;
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
  const resume = flagOn(flags.resume);
  const fresh = flagOn(flags.new);
  const stream = !flagOn(flags["no-stream"]);
  const conversationFlag = flags.id;
  let mode = loadMode(flags.mode);

  if (!providerReady(provider)) {
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
    resume,
    fresh,
  });
  await rememberMode(pool, session, mode);

  const tasks = createTaskStore(lastTaskState(session.messages));
  const plans = createPlanStore(lastPlan(session.messages));
  const subagents = createSubagentStore();
  let workspace = process.cwd();
  let mcp = await openMcpHub(workspace);
  const longApprove = createLongApprover(() => provider);
  const longRubric = createLongRubric(() => provider);
  const longBudget = resolveLongBudgetFromEnv(maxSteps);
  const policy = createPolicy(() => workspace, () => mode, tasks, {
    longApprove,
    longRubric,
    longBudget,
    subagents,
    mcp,
    plans,
  });
  const subagentUi = createSubagentUi();
  const childPrint = new Map<number, PrintState>();
  const printChild = (id: number) => {
    let state = childPrint.get(id);
    if (!state) {
      state = { replied: false };
      childPrint.set(id, state);
    }
    return state;
  };
  policy.spawnSubagent = createSubagentRunner({
    getProvider: () => provider,
    getPolicy: () => policy,
    workspace,
    maxSteps: envPositiveInt(process.env.SUBAGENT_STEPS, DEFAULT_SUBAGENT_STEPS),
    stream,
    shouldStream: (job) => stream && subagentUi.watching() === job.id,
    onBatch: (jobs) => {
      childPrint.clear();
      subagentUi.startBatch(jobs);
    },
    onJobStart: (job) => subagentUi.jobStart(job.id),
    onJobDone: (job) => subagentUi.jobDone(job),
    onEvent: (meta, event) => {
      const live = subagentUi.record(meta.job.id, event);
      if (!live) {
        subagentUi.refresh();
        return;
      }
      const tag = `${meta.job.id} ${meta.job.kind}:${meta.job.label}`;
      printAgentEvent(event, printChild(meta.job.id), mode, tag, subagentUi);
    },
  });
  let lastUsage: TokenUsage | undefined;

  const currentSystem = (activated: string[] = []) =>
    agentEnabled
      ? buildSystemPrompt(
          workspace,
          userSystem,
          mode,
          mode === "long" ? tasks.get() : undefined,
          mcp.specs({ mode }).map((tool) => tool.name),
          activated,
          plans.get(),
        )
      : userSystem || undefined;
  const currentToolsTokens = () =>
    agentEnabled ? toolsTokensFromSpecs(toolSpecs(mode, { extra: mcp.specs({ mode }) })) : 0;
  const contextBudget = () =>
    Math.max(512, Math.floor((provider.contextWindow - provider.maxOutput - 256) * 0.9));

  const reloadSessionState = () => {
    tasks.replace(lastTaskState(session.messages) ?? emptyTaskState());
    plans.replace(lastPlan(session.messages) ?? emptyPlan());
  };

  const ask = async (
    history: Message[],
    user: Message,
    opts?: { requirePlan?: boolean; forceSkills?: string[]; skillPrompt?: string },
  ) => {
    const state = { replied: false };
    const abort = watchTurnAbort({
      onCommand: (line) => {
        if (handleSeesubagent(subagentUi, line)) return;
        handleSeeplan(plans, line);
      },
    });
    setPermissionGate(abort);
    const load = createLoadUi();
    load.start();
    try {
      let activated: string[] = [];
      if (agentEnabled) {
        const decision = await activateBaseSkills({
          prompt: opts?.skillPrompt ?? user.content,
          mode,
          skills: loadSkillBundle(workspace).skills,
          provider,
          signal: abort.signal,
          force: opts?.forceSkills,
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
        requirePlan: opts?.requirePlan,
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
        onEvent: (event) => {
          load.stop();
          printAgentEvent(event, state, mode, undefined, subagentUi);
          if (event.type === "tool_result" || event.type === "notice" || event.type === "compress") {
            load.start();
          }
        },
      });
    } finally {
      load.stop();
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
    mcpCount: mcp.toolNames().length,
    workspace,
  });

  const applyWorkarea = async (path: string) => {
    try {
      process.chdir(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `无法进入目录: ${message}`;
    }
    workspace = path;
    await mcp.close().catch(() => undefined);
    mcp = await openMcpHub(workspace);
    policy.mcp = mcp;
    return null;
  };

  const handleWorkarea = async (input: string) => {
    const parsed = parseSetworkarea(input);
    if (!parsed) return false;
    if (sessionHasChat(session.messages)) {
      console.log("\n已有对话内容时不能换工作区。先 /new 再 /setworkarea。\n");
      return true;
    }
    let target: string;
    if (parsed.path) {
      const resolved = resolveWorkarea(parsed.path);
      if ("error" in resolved) {
        console.log(`\n${resolved.error}\n`);
        return true;
      }
      target = resolved.path;
    } else {
      if (!process.stdin.isTTY) {
        console.log("\n非 TTY 下请用 /setworkarea /绝对路径\n");
        return true;
      }
      console.log("\n选择工作区文件夹…");
      const picked = await pickWorkareaFolder();
      if ("cancelled" in picked) {
        console.log("已取消。\n");
        return true;
      }
      if ("error" in picked) {
        console.log(`\n${picked.error}\n`);
        return true;
      }
      target = picked.path;
    }
    const failed = await applyWorkarea(target);
    if (failed) {
      console.log(`\n${failed}\n`);
      return true;
    }
    console.log(`\n工作区已设为 ${workspace}\n`);
    printBanner(session, extra());
    return true;
  };

  const currentContextReport = (history: Message[] = session.messages) =>
    measureContext({
      history,
      systemPrompt: currentSystem(),
      toolsTokens: currentToolsTokens(),
      maxMessages,
      contextWindow: provider.contextWindow,
      maxOutput: provider.maxOutput,
      mode,
    });

  const printContextUsage = (history: Message[]) => {
    const report = currentContextReport(history);
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
      await persistSession(pool, session, provider.model);
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
    const report = currentContextReport(history);
    if (!shouldAutoCompress({ history, report })) return history;
    console.log("\n长程模式：上下文接近上限，自动压缩…");
    return await runCompress(history);
  };

  const showLongTask = () => {
    if (mode !== "long") return;
    console.log(formatTaskStateCli(tasks.get()));
    console.log("");
  };

  const showPlan = () => {
    if (isEmptyPlan(plans.get())) return;
    console.log(formatPlanCli(plans.get()));
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
    await discardEmptySession(pool, session).catch(() => undefined);
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
      const prepared = prepareUserTurn(oneShot);
      if ("usage" in prepared) {
        setplanUsage();
        return;
      }
      const user = prepared.user;
      const askOpts = prepared.requirePlan
        ? { requirePlan: true, forceSkills: prepared.forceSkills, skillPrompt: prepared.skillPrompt }
        : undefined;
      try {
        if (mode === "long") {
          session.messages = await maybeAutoCompress(session.messages);
          tasks.replace(seedGoalFromUser(tasks.get(), prepared.titleText));
          await rememberTaskState(pool, session, tasks);
        }
        const { reply, trace, usage } = await ask(session.messages, user, askOpts);
        lastUsage = usage;
        const stored = historyAfterTurn(user, trace);
        await persistSession(pool, session, provider.model);
        await saveMessages(pool, session.id, stored);
        session.messages.push(...stored);
        await rememberTaskState(pool, session, tasks);
        await rememberPlan(pool, session, plans);
        if (!reply.endsWith("\n")) process.stdout.write("\n");
        printTurnRecap(trace);
        await maybeNameSession({
          pool,
          session,
          provider,
          userText: prepared.titleText,
          assistantText: reply,
        });
      } catch (error) {
        await saveFailedTurn(pool, session, user, error, provider.model);
        if (mode === "long") {
          await rememberTaskState(pool, session, tasks);
        }
        await rememberPlan(pool, session, plans);
        printTurnRecap(failedTurnTrace(error));
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
    if (!providerReady(provider)) {
      provider = await promptProviderForm(sessionRl, "setup", provider);
      console.log("");
    }
    printBanner(session, extra());
    showLongTask();
    showPlan();

    while (true) {
      sessionRl.pause();
      const report = currentContextReport();
      const prompt = (
        await promptYou(userPrefix(mode), {
          hint: workareaPlaceholder(workspace),
          status: promptStatusLine(provider.model, provider.thinkingEffort, {
            session: statusSessionLabel(session.title),
            context: formatContextMeter(report.used, report.window),
            columns: process.stdout.columns ?? 80,
          }),
        })
      ).trim();
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
          console.log(`\n${formatSkillsCli(loadSkillBundle(workspace), workspace)}\n`);
          continue;
        }
        if (prompt === "/seesubagent" || prompt.startsWith("/seesubagent ")) {
          handleSeesubagent(subagentUi, prompt);
          continue;
        }
        if (prompt === "/seeplan" || prompt.startsWith("/seeplan ")) {
          handleSeeplan(plans, prompt);
          continue;
        }
        if (parseSetworkarea(prompt)) {
          await handleWorkarea(prompt);
          continue;
        }
        if (prompt === "/compress") {
          try {
            session.messages = await runCompress(session.messages);
            await rememberMode(pool, session, mode);
            await rememberTaskState(pool, session, tasks);
            await rememberPlan(pool, session, plans);
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
          await discardEmptySession(pool, session);
          session = emptySession();
          reloadSessionState();
          await rememberMode(pool, session, mode);
          console.log("");
          printBanner(session, extra());
          showLongTask();
          showPlan();
          continue;
        }
        if (prompt === "/provider" || prompt.startsWith("/provider ")) {
          sessionRl.resume();
          const arg = prompt.slice("/provider".length).trim();
          provider = await handleProvider(sessionRl, provider, arg);
          continue;
        }
        if (prompt === "/effort" || prompt.startsWith("/effort ")) {
          provider = await handleEffort(provider, prompt.slice("/effort".length).trim());
          continue;
        }
        if (prompt === "/model" || prompt.startsWith("/model ")) {
          provider = await handleModel(provider, prompt.slice("/model".length).trim());
          continue;
        }
        const restore = parseSlash(prompt);
        if (restore) {
          sessionRl.resume();
          const picked = await pickSession(sessionRl, pool, session, restore.arg);
          if (picked) {
            await discardEmptySession(pool, session);
            session = picked;
            reloadSessionState();
            await rememberMode(pool, session, mode);
            console.log("");
            printBanner(session, extra());
            showLongTask();
            showPlan();
          }
          continue;
        }

        const prepared = prepareUserTurn(prompt);
        if ("usage" in prepared) {
          setplanUsage();
          continue;
        }
        const user = prepared.user;
        const askOpts = prepared.requirePlan
          ? { requirePlan: true, forceSkills: prepared.forceSkills, skillPrompt: prepared.skillPrompt }
          : undefined;
        try {
          if (mode === "long") {
            session.messages = await maybeAutoCompress(session.messages);
            tasks.replace(seedGoalFromUser(tasks.get(), prepared.titleText));
            await rememberTaskState(pool, session, tasks);
          }
          const { reply, trace, usage } = await ask(session.messages, user, askOpts);
          lastUsage = usage;
          const stored = historyAfterTurn(user, trace);
          await persistSession(pool, session, provider.model);
          await saveMessages(pool, session.id, stored);
          session.messages.push(...stored);
          await rememberTaskState(pool, session, tasks);
          await rememberPlan(pool, session, plans);
          process.stdout.write(reply.endsWith("\n") ? "\n" : "\n\n");
          printTurnRecap(trace);
          await maybeNameSession({
            pool,
            session,
            provider,
            userText: prepared.titleText,
            assistantText: reply,
          });
        } catch (error) {
          await saveFailedTurn(pool, session, user, error, provider.model);
          if (mode === "long") await rememberTaskState(pool, session, tasks);
          await rememberPlan(pool, session, plans);
          printTurnRecap(failedTurnTrace(error));
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
