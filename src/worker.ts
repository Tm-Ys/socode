import { isTurnAborted, TurnAborted, TurnFailed } from "./abort.js";
import { closeIncompleteTrace, runAgent } from "./agent.js";
import { loadConfig, longBudgetFromConfig } from "./config.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { beginUndoTurn, bindUndoStore, undoLastTurn } from "./undo.js";
import type { TokenUsage } from "./chat.js";
import {
  addTokenUsage,
  emptyTokenUsage,
  estimateUsageUsd,
  formatSessionUsage,
  formatUsageLine,
  lookupModelPrice,
  usageHasTokens,
} from "./usage.js";
import { canCompress, compressHistory, shouldAutoCompress } from "./compress.js";
import { buildApiMessages, formatContextReport, measureContext, toolsTokensFromSpecs } from "./context.js";
import {
  emptySession,
  listConversations,
  loadSession,
  openConversation,
  openSessionStore,
  persistSession,
  discardEmptySession,
  replaceMessages,
  saveMessages,
  sessionHasChat,
  updateConversationTitle,
  type ConversationRow,
  type Message,
  type Session,
  type SessionStore,
} from "./db.js";
import { createLongApprover } from "./long-approve.js";
import { createLongRubric } from "./long-rubric.js";
import { openMcpHub, type McpHub } from "./mcp.js";
import {
  harnessModeMessage,
  lastHarnessMode,
  modeHint,
  modeLabel,
  paintMode,
  parseMode,
  type AgentMode,
} from "./mode.js";
import { createPolicy, type Policy } from "./permissions.js";
import { useColor } from "./markdown.js";
import { setPermissionGate, watchTurnAbort } from "./prompt.js";
import type { Provider } from "./provider.js";
import { recapLine, historyAfterTurn } from "./recap.js";
import { formatSkillsCli, loadSkillBundle } from "./skills.js";
import { activateBaseSkills, logSkillActivate } from "./skill-activate.js";
import { createSubagentRunner, createSubagentStore } from "./subagent.js";
import { parseSeesubagent } from "./subagent-ui.js";
import { buildSystemPrompt } from "./system-prompt.js";
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
import { isDefaultTitle, statusSessionLabel, generateTitle } from "./title.js";
import { toolSpecs } from "./tools.js";
import type { WorkerHost } from "./worker-host.js";

export type WorkerSnapshot = {
  workspace: string;
  mode: AgentMode;
  title: string;
  mcpCount: number;
  model: string;
  thinkingEffort: Provider["thinkingEffort"];
  sessionLabel: string;
  contextUsed: number;
  contextWindow: number;
  provider: Provider;
  providerReady: boolean;
};

export type TurnResult = {
  usageHelp?: boolean;
  aborted?: boolean;
  error?: string;
  reply?: string;
  recap?: string;
  usageLine?: string;
  checkpoint?: string;
  endedNewline?: boolean;
};

export type WorkerConfig = {
  host: WorkerHost;
  workspace: string;
  provider: Provider;
  mode: AgentMode;
  userSystem?: string;
  agentEnabled: boolean;
  maxMessages: number;
  maxSteps: number;
  maxTokens?: number;
  stream: boolean;
  conversationId?: string;
  resume?: boolean;
  fresh?: boolean;
  skipSkills?: boolean;
  skipTitle?: boolean;
  complete?: Parameters<typeof runAgent>[0]["complete"];
};

export type LocalWorker = {
  get mode(): AgentMode;
  get provider(): Provider;
  get workspace(): string;
  get session(): Session;
  get store(): SessionStore;
  get plans(): PlanStore;
  snapshot(): WorkerSnapshot;
  setProvider(next: Provider): void;
  setMode(next: AgentMode): Promise<void>;
  turn(text: string): Promise<TurnResult>;
  doctor(): Promise<string>;
  undo(): Promise<string>;
  contextText(): string;
  usageText(): string;
  task(arg: string): Promise<string>;
  mcpText(): string;
  skillsText(): string;
  seeplanText(): string;
  longTaskText(): string;
  planText(): string;
  modeText(arg: string): { text: string; changed: boolean; mode: AgentMode };
  newSession(): Promise<void>;
  compress(): Promise<TurnResult>;
  applyWorkarea(path: string): Promise<string | null>;
  canSetWorkarea(): boolean;
  listSessions(): Promise<ConversationRow[]>;
  openSession(id: string): Promise<void>;
  abort(): void;
  close(): Promise<void>;
};

export function prepareUserTurn(raw: string) {
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

export function setplanUsageText() {
  return [
    "",
    "用法: /setplan <任务说明>",
    "本轮强制调用 plan 按说明拆目标，并激活 grill-me 追问决策。未达成共识前不改代码。",
    "",
  ].join("\n");
}

export async function openLocalWorker(cfg: WorkerConfig): Promise<LocalWorker> {
  const host = cfg.host;
  const appCfg = loadConfig();
  let workspace = cfg.workspace;
  let provider = cfg.provider;
  let mode = cfg.mode;
  let store = await openSessionStore(workspace);
  await bindUndoStore(workspace);
  let session = await openConversation(store, {
    model: provider.model,
    id: cfg.conversationId,
    resume: cfg.resume,
    fresh: cfg.fresh,
  });
  await rememberMode(store, session, mode);

  const tasks = createTaskStore(lastTaskState(session.messages));
  const plans = createPlanStore(lastPlan(session.messages));
  const subagents = createSubagentStore();
  let mcp: McpHub = await openMcpHub(workspace);
  const longApprove = createLongApprover(() => provider);
  const longRubric = createLongRubric(() => provider);
  const longBudget = longBudgetFromConfig(cfg.maxSteps);
  const policy: Policy = createPolicy(() => workspace, () => mode, tasks, {
    longApprove,
    longRubric,
    longBudget,
    subagents,
    mcp,
    plans,
    askPermission: (title, detail, diff) => host.askPermission(title, detail, diff),
    askQuestions: (questions, signal) => host.askQuestions(questions, signal),
  });
  policy.spawnSubagent = createSubagentRunner({
    getProvider: () => provider,
    getPolicy: () => policy,
    workspace,
    maxSteps: appCfg.subagentSteps,
    stream: cfg.stream,
    shouldStream: (job) => cfg.stream && host.subagent.watching() === job.id,
    onBatch: (jobs) => host.subagent.startBatch(jobs),
    onJobStart: (job) => host.subagent.jobStart(job.id),
    onJobDone: (job) => host.subagent.jobDone(job),
    onEvent: (meta, event) => {
      const live = host.subagent.record(meta.job.id, event);
      if (!live) {
        host.subagent.refresh();
        return;
      }
      const tag = `${meta.job.id} ${meta.job.kind}:${meta.job.label}`;
      host.emitEvent(event, { tag });
    },
  });

  let lastUsage: TokenUsage | undefined;
  let sessionUsage = emptyTokenUsage();
  let sessionUsd = 0;
  let turnAbort: AbortController | undefined;

  const currentPrice = () => lookupModelPrice(provider.model, loadConfig().modelPricing);

  const resetSessionUsage = () => {
    lastUsage = undefined;
    sessionUsage = emptyTokenUsage();
    sessionUsd = 0;
  };

  const noteTurnUsage = (usage?: TokenUsage) => {
    lastUsage = usage;
    if (!usageHasTokens(usage)) return;
    addTokenUsage(sessionUsage, usage);
    const usd = estimateUsageUsd(usage, currentPrice());
    if (usd !== undefined) sessionUsd += usd;
  };

  const usageLine = () => {
    if (!usageHasTokens(lastUsage)) return "";
    return formatUsageLine(lastUsage, { price: currentPrice(), color: useColor() });
  };

  const currentSystem = (activated: string[] = []) =>
    cfg.agentEnabled
      ? buildSystemPrompt(
          workspace,
          cfg.userSystem,
          mode,
          mode === "long" ? tasks.get() : undefined,
          mcp.specs({ mode }).map((tool) => tool.name),
          activated,
          plans.get(),
        )
      : cfg.userSystem || undefined;
  const currentToolsTokens = () =>
    cfg.agentEnabled ? toolsTokensFromSpecs(toolSpecs(mode, { extra: mcp.specs({ mode }) })) : 0;
  const contextBudget = () =>
    Math.max(512, Math.floor((provider.contextWindow - provider.maxOutput - 256) * 0.9));

  const reloadSessionState = () => {
    tasks.replace(lastTaskState(session.messages) ?? emptyTaskState());
    plans.replace(lastPlan(session.messages) ?? emptyPlan());
  };

  const currentContextReport = (history: Message[] = session.messages) =>
    measureContext({
      history,
      systemPrompt: currentSystem(),
      toolsTokens: currentToolsTokens(),
      maxMessages: cfg.maxMessages,
      contextWindow: provider.contextWindow,
      maxOutput: provider.maxOutput,
      mode,
    });

  const snapshot = (): WorkerSnapshot => {
    const report = currentContextReport();
    return {
      workspace,
      mode,
      title: session.title,
      mcpCount: mcp.toolNames().length,
      model: provider.model,
      thinkingEffort: provider.thinkingEffort,
      sessionLabel: statusSessionLabel(session.title),
      contextUsed: report.used,
      contextWindow: report.window,
      provider,
      providerReady: Boolean(provider.url && provider.api && provider.model),
    };
  };

  const runAsk = async (
    history: Message[],
    user: Message,
    opts?: { requirePlan?: boolean; forceSkills?: string[]; skillPrompt?: string },
  ) => {
    host.beginTurn();
    const turn = new AbortController();
    turnAbort = turn;
    const ttyAbort = watchTurnAbort({
      onCommand: (line) => {
        if (handleSeesubagent(host, line)) return;
        if (parseSeeplan(line)) {
          host.emitEvent({ type: "notice", text: formatPlanCli(plans.get()) });
        }
      },
    });
    const onTtyAbort = () => {
      if (!turn.signal.aborted) turn.abort();
    };
    ttyAbort.signal.addEventListener("abort", onTtyAbort);
    setPermissionGate(ttyAbort);
    host.startLoad();
    beginUndoTurn();
    try {
      let activated: string[] = [];
      if (cfg.agentEnabled && !cfg.skipSkills) {
        const decision = await activateBaseSkills({
          prompt: opts?.skillPrompt ?? user.content,
          mode,
          skills: loadSkillBundle(workspace).skills,
          provider,
          signal: turn.signal,
          force: opts?.forceSkills,
        });
        activated = decision.activate;
        logSkillActivate(decision);
      }
      return await runAgent({
        provider,
        stream: cfg.stream,
        maxSteps: cfg.maxSteps,
        maxTokens: mode === "long" ? cfg.maxTokens : undefined,
        maxContextTokens: mode === "long" ? contextBudget() : undefined,
        useTools: cfg.agentEnabled,
        signal: turn.signal,
        policy,
        requirePlan: opts?.requirePlan,
        complete: cfg.complete,
        messages: buildApiMessages({
          history,
          user,
          systemPrompt: currentSystem(activated),
          maxMessages: cfg.maxMessages,
          contextWindow: provider.contextWindow,
          maxOutput: provider.maxOutput,
          toolsTokens: currentToolsTokens(),
          mode,
        }),
        onEvent: (event) => {
          host.stopLoad();
          host.emitEvent(event);
          if (event.type === "tool_result" || event.type === "notice" || event.type === "compress") {
            host.startLoad();
          }
        },
      });
    } finally {
      host.stopLoad();
      setPermissionGate(undefined);
      ttyAbort.signal.removeEventListener("abort", onTtyAbort);
      ttyAbort.dispose();
      if (turnAbort === turn) turnAbort = undefined;
    }
  };

  const runCompress = async (history: Message[]) => {
    if (!canCompress(history)) {
      return { history, skipped: true as const };
    }
    const turn = new AbortController();
    turnAbort = turn;
    const ttyAbort = watchTurnAbort();
    const onTtyAbort = () => {
      if (!turn.signal.aborted) turn.abort();
    };
    ttyAbort.signal.addEventListener("abort", onTtyAbort);
    let replied = false;
    try {
      const result = await compressHistory({
        provider,
        history,
        signal: turn.signal,
        onDelta: (text) => {
          if (!replied) {
            host.emitEvent({ type: "notice", text: "正在压缩上下文…" });
            replied = true;
          }
          host.emitEvent({ type: "delta", text });
        },
      });
      await persistSession(store, session, provider.model);
      await replaceMessages(store, session.id, result.messages);
      return { history: result.messages, saved: result.saved };
    } finally {
      ttyAbort.signal.removeEventListener("abort", onTtyAbort);
      ttyAbort.dispose();
      if (turnAbort === turn) turnAbort = undefined;
    }
  };

  const maybeAutoCompress = async (history: Message[]) => {
    if (mode !== "long") return history;
    const report = currentContextReport(history);
    if (!shouldAutoCompress({ history, report })) return history;
    host.emitEvent({ type: "notice", text: "长程模式：上下文接近上限，自动压缩…" });
    const result = await runCompress(history);
    return result.history;
  };

  const finishTurn = async (user: Message, titleText: string, reply: string, trace: Message[], usage?: TokenUsage) => {
    noteTurnUsage(usage);
    const stored = historyAfterTurn(user, trace);
    await persistSession(store, session, provider.model);
    await saveMessages(store, session.id, stored);
    session.messages.push(...stored);
    await rememberTaskState(store, session, tasks);
    await rememberPlan(store, session, plans);
    await maybeNameSession(store, session, provider, titleText, reply, cfg.skipTitle);
    const recap = recapLine(trace, { color: useColor() });
    return {
      reply,
      recap: recap || undefined,
      usageLine: usageLine() || undefined,
      endedNewline: reply.endsWith("\n"),
    } satisfies TurnResult;
  };

  const failTurn = async (user: Message, error: unknown): Promise<TurnResult> => {
    await saveFailedTurn(store, session, user, error, provider.model);
    if (mode === "long") await rememberTaskState(store, session, tasks);
    await rememberPlan(store, session, plans);
    const recap = recapLine(failedTurnTrace(error), { color: useColor() });
    if (isTurnAborted(error)) {
      return {
        aborted: true,
        recap: recap || undefined,
        checkpoint: mode === "long" ? checkpointReply(tasks.get(), "abort") : undefined,
      };
    }
    return {
      error: error instanceof Error ? error.message : String(error),
      recap: recap || undefined,
    };
  };

  return {
    get mode() {
      return mode;
    },
    get provider() {
      return provider;
    },
    get workspace() {
      return workspace;
    },
    get session() {
      return session;
    },
    get store() {
      return store;
    },
    get plans() {
      return plans;
    },
    snapshot,
    setProvider(next) {
      provider = next;
    },
    async setMode(next) {
      mode = next;
      await rememberMode(store, session, mode);
    },
    async turn(text) {
      const prepared = prepareUserTurn(text);
      if ("usage" in prepared) return { usageHelp: true };
      const user = prepared.user;
      const askOpts = prepared.requirePlan
        ? { requirePlan: true, forceSkills: prepared.forceSkills, skillPrompt: prepared.skillPrompt }
        : undefined;
      try {
        if (mode === "long") {
          session.messages = await maybeAutoCompress(session.messages);
          tasks.replace(seedGoalFromUser(tasks.get(), prepared.titleText));
          await rememberTaskState(store, session, tasks);
        }
        const { reply, trace, usage } = await runAsk(session.messages, user, askOpts);
        return await finishTurn(user, prepared.titleText, reply, trace, usage);
      } catch (error) {
        return await failTurn(user, error);
      }
    },
    async doctor() {
      const report = await runDoctor({ workspace, mode, provider });
      return formatDoctor(report);
    },
    async undo() {
      return undoLastTurn();
    },
    contextText() {
      const report = currentContextReport();
      const cols = process.stdout.columns ?? 40;
      const width = Math.max(16, Math.min(48, cols - 2));
      const lines = ["", formatContextReport(report, width, Boolean(process.stdout.isTTY))];
      if (usageHasTokens(lastUsage)) {
        lines.push(formatUsageLine(lastUsage, { price: currentPrice(), color: useColor() }));
      }
      lines.push("");
      return lines.join("\n");
    },
    usageText() {
      if (!usageHasTokens(lastUsage) && !usageHasTokens(sessionUsage)) {
        return "\n还没有 API 用量。发一条消息后再看。\n";
      }
      const color = useColor();
      const price = currentPrice();
      const lines: string[] = [""];
      if (usageHasTokens(lastUsage)) lines.push(formatUsageLine(lastUsage, { price, color }));
      if (usageHasTokens(sessionUsage)) {
        lines.push(formatSessionUsage(sessionUsage, sessionUsd > 0 ? sessionUsd : undefined, color));
      }
      if (!price) {
        const dim = color ? "\x1b[2m" : "";
        const reset = color ? "\x1b[0m" : "";
        lines.push(`${dim}标价写在 ~/.socode/config.json 的 modelPricing（美元 / 百万 token）。没配就不估金额。${reset}`);
      }
      return `${lines.join("\n")}\n`;
    },
    async task(arg) {
      const text = handleTask(tasks, arg);
      await rememberTaskState(store, session, tasks);
      return text;
    },
    mcpText() {
      const names = mcp.toolNames();
      const extra = names.length ? `\n工具: ${names.join(", ")}` : "";
      return `\n${mcp.statusText()}${extra}\n`;
    },
    skillsText() {
      return `\n${formatSkillsCli(loadSkillBundle(workspace), workspace)}\n`;
    },
    seeplanText() {
      return `\n${formatPlanCli(plans.get())}\n`;
    },
    longTaskText() {
      if (mode !== "long") return "";
      return `${formatTaskStateCli(tasks.get())}\n`;
    },
    planText() {
      if (isEmptyPlan(plans.get())) return "";
      return `${formatPlanCli(plans.get())}\n`;
    },
    modeText(arg) {
      const result = describeMode(mode, arg);
      return result;
    },
    async newSession() {
      await discardEmptySession(store, session);
      session = emptySession();
      reloadSessionState();
      resetSessionUsage();
      await rememberMode(store, session, mode);
    },
    async compress() {
      if (!canCompress(session.messages)) {
        return { error: "对话还不够长，无需压缩。" };
      }
      try {
        host.emitEvent({ type: "notice", text: "正在压缩上下文…" });
        const result = await runCompress(session.messages);
        session.messages = result.history;
        await rememberMode(store, session, mode);
        await rememberTaskState(store, session, tasks);
        await rememberPlan(store, session, plans);
        const saved = "saved" in result && result.saved ? result.saved : 0;
        return {
          reply: saved ? `\n\n已压缩，大约省下 ${saved.toLocaleString("en-US")} tokens` : "",
        };
      } catch (error) {
        if (isTurnAborted(error)) return { aborted: true };
        throw error;
      }
    },
    async applyWorkarea(path) {
      try {
        process.chdir(path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `无法进入目录: ${message}`;
      }
      workspace = path;
      store = await openSessionStore(workspace);
      await bindUndoStore(workspace);
      await mcp.close().catch(() => undefined);
      mcp = await openMcpHub(workspace);
      policy.mcp = mcp;
      return null;
    },
    canSetWorkarea() {
      return !sessionHasChat(session.messages);
    },
    listSessions() {
      return listConversations(store);
    },
    async openSession(id) {
      await discardEmptySession(store, session);
      session = await loadSession(store, id);
      reloadSessionState();
      resetSessionUsage();
      await rememberMode(store, session, mode);
    },
    abort() {
      turnAbort?.abort();
    },
    async close() {
      await discardEmptySession(store, session).catch(() => undefined);
      await mcp.close().catch(() => undefined);
    },
  };
}

export function handleSeesubagent(host: WorkerHost, input: string) {
  const cmd = parseSeesubagent(input);
  if (!cmd) return false;
  if (cmd.kind === "help") {
    process.stdout.write("\n用法: /seesubagent [序号]    /seesubagent off\n");
    host.subagent.refresh();
    return true;
  }
  if (cmd.kind === "off") {
    host.subagent.watch?.(null);
    process.stdout.write("\n已隐藏子代理过程\n");
    host.subagent.refresh();
    return true;
  }
  if (cmd.kind === "list") {
    process.stdout.write(`\n${host.subagent.listText?.() ?? ""}\n`);
    host.subagent.refresh();
    return true;
  }
  const job = host.subagent.watch?.(cmd.index);
  if (!job) {
    process.stdout.write(`\n没有序号 ${cmd.index} 的子代理。\n${host.subagent.listText?.() ?? ""}\n`);
    host.subagent.refresh();
    return true;
  }
  const follow = job.phase === "running" || job.phase === "pending" ? "\n（仍在跑，后续过程会显示在上面）" : "";
  process.stdout.write(`\n${host.subagent.logText?.(job.id) ?? ""}${follow}\n`);
  host.subagent.refresh();
  return true;
}

function failedTurnTrace(error: unknown): Message[] {
  if (error instanceof TurnAborted || error instanceof TurnFailed) {
    return closeIncompleteTrace(error.trace);
  }
  return [];
}

async function saveFailedTurn(
  store: SessionStore,
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
  await persistSession(store, session, model);
  await saveMessages(store, session.id, batch);
  session.messages.push(...batch);
}

async function rememberTaskState(store: SessionStore, session: Session, tasks: TaskStore) {
  const current = tasks.get();
  const last = lastTaskState(session.messages);
  if (last && taskStateEqual(last, current)) return;
  if (!last && isEmptyTaskState(current)) return;
  const notice = taskStateMessage(current);
  session.messages.push(notice);
  if (session.persisted && session.id) await saveMessages(store, session.id, [notice]);
}

async function rememberPlan(store: SessionStore, session: Session, plans: PlanStore) {
  const current = plans.get();
  const last = lastPlan(session.messages);
  if (last && planEqual(last, current)) return;
  if (!last && isEmptyPlan(current)) return;
  const notice = planMessage(current);
  session.messages.push(notice);
  if (session.persisted && session.id) await saveMessages(store, session.id, [notice]);
}

async function rememberMode(store: SessionStore, session: Session, mode: AgentMode) {
  if (lastHarnessMode(session.messages) === mode) return;
  const notice = harnessModeMessage(mode);
  session.messages.push(notice);
  if (session.persisted && session.id) await saveMessages(store, session.id, [notice]);
}

async function maybeNameSession(
  store: SessionStore,
  session: Session,
  provider: Provider,
  userText: string,
  assistantText: string,
  skip?: boolean,
) {
  if (skip || !isDefaultTitle(session.title) || !session.id) return;
  const title = await generateTitle({ provider, userText, assistantText });
  await updateConversationTitle(store, session.id, title);
  session.title = title;
}

function handleTask(store: TaskStore, arg: string) {
  const rest = arg.trim();
  if (!rest || rest === "show") {
    return `\n${formatTaskStateCli(store.get())}\n`;
  }
  if (rest === "clear") {
    store.replace(emptyTaskState());
    return "\n已清空任务状态。\n";
  }
  const match = rest.match(/^(goal|目标|note|notes|备注|milestone|里程碑)\s*[：: ]\s*([\s\S]+)/i);
  if (match) {
    const kind = match[1].toLowerCase();
    const text = match[2].trim();
    if (kind === "goal" || kind === "目标") store.patch({ goal: text });
    else if (kind === "milestone" || kind === "里程碑") store.patch({ addMilestone: text });
    else store.patch({ notes: text });
    return `\n${formatTaskStateCli(store.get())}\n`;
  }
  return "\n用法: /task    /task goal <目标>    /task milestone <项>    /task note <备注>    /task clear\n";
}

function describeMode(mode: AgentMode, arg: string) {
  const rest = arg.trim();
  if (!rest || rest === "show") {
    return {
      mode,
      changed: false,
      text: [
        "",
        `模式: ${paintMode(mode, modeLabel(mode))}`,
        modeHint(mode),
        "",
        `/mode full   ${paintMode("full", "Full Access")}，直接改文件和跑命令`,
        `/mode ask    ${paintMode("ask", "Ask")}，创建/修改/删除先按 y/n/a 审批`,
        `/mode plan   ${paintMode("plan", "Plan")}，只能看和写计划，不能动手`,
        `/mode long   ${paintMode("long", "Long")} / 长程，记住目标、自动压缩；副作用走 LLM 审批，不是 Full`,
        "",
      ].join("\n"),
    };
  }
  const next = parseMode(rest);
  if (!next) {
    return { mode, changed: false, text: "\n未知模式。用 /mode full、/mode ask、/mode plan 或 /mode long（长程）。\n" };
  }
  if (next === mode) {
    return {
      mode,
      changed: false,
      text: `\n已经是 ${paintMode(mode, modeLabel(mode))}\n${modeHint(mode)}\n`,
    };
  }
  return {
    mode: next,
    changed: true,
    text: `\n已切换到 ${paintMode(next, modeLabel(next))}\n${modeHint(next)}\n`,
  };
}

