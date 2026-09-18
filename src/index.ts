import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig, migrateLegacyDotenv } from "./config.js";
import { formatContextMeter } from "./context.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { createStdioHost, printBanner, printErr } from "./display.js";
import { runConnect } from "./connect.js";
import { runRemoteSshCommand } from "./remote-ssh-ui.js";
import { runWorkerStdio } from "./stdio-worker.js";
import { loadMode, userPrefix } from "./mode.js";
import {
  promptYou,
  promptStatusLine,
  restoreTerminal,
  confirmQuit,
  isQuitBlocked,
  takeForcedQuit,
} from "./prompt.js";
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
import { formatConversationList } from "./title.js";
import { parseSetworkarea, pickWorkareaFolder, resolveWorkarea, workareaPlaceholder } from "./workarea.js";
import { parseRemoteSshCommand } from "./commands.js";
import {
  handleSeesubagent,
  openLocalWorker,
  setplanUsageText,
  type LocalWorker,
} from "./worker.js";

const BOOLEAN_FLAGS = new Set(["resume", "new", "no-stream", "no-agent", "doctor", "stdio"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCli(argv: string[]) {
  const rest = argv.slice(2);
  const cmd = rest[0] === "connect" || rest[0] === "worker" ? rest[0] : undefined;
  const args = cmd ? rest.slice(1) : rest;
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey === "api-key" || rawKey === "key" ? "api" : rawKey;
    const next = args[i + 1];
    const asBoolean =
      BOOLEAN_FLAGS.has(key) &&
      inlineValue === undefined &&
      (!next || next.startsWith("--"));
    flags[key] = asBoolean ? "true" : (inlineValue ?? args[++i] ?? "");
  }

  return { cmd, flags, positional };
}

function parsePositiveInt(label: string, raw: string | undefined) {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${label} 必须是正数`);
  }
  return Math.floor(n);
}

function flagOn(value: string | undefined) {
  return value === "true" || value === "";
}

function usage() {
  return `用法:
  socode [--input <文本>]          默认新会话，空对话不落盘
  socode --resume
  socode --id <conversation-uuid>
  socode connect user@host:/abs/path   本机显示器 + 远端 worker（可用密码或公钥）
  会话里 /ssh 或 /remote-ssh [user@host]  Tab 把 /ssh 补成 /remote-ssh；远程用 /sshquit 断开
  socode worker --stdio --workspace /abs/path
  socode --url/--api/--model/--name/--context/--output/--effort/--steps/--max/--mode/--budget
  socode --doctor                     检查 Node、密钥、沙箱、目录是否可写

OpenAI 兼容 Provider 存在 ~/.socode/providers.json；默认值在 ~/.socode/config.json
权限模式：--mode full | ask | plan | long（也可用 /mode 切换，长程可用 长程）。Esc 中止当前轮，本机 /quit 退出；远程会话必须 /sshquit。`;
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
  worker: LocalWorker,
  arg: string,
): Promise<boolean> {
  const rows = await worker.listSessions();
  if (rows.length === 0) {
    console.log("没有可恢复的会话。\n");
    return false;
  }

  if (arg) {
    if (UUID_RE.test(arg)) {
      const picked = rows.find((row) => row.id === arg);
      if (!picked) {
        console.log("找不到这个会话编号。\n");
        return false;
      }
      await worker.openSession(picked.id);
      return true;
    }
    const index = Number(arg);
    if (!Number.isInteger(index) || index < 1 || index > rows.length) {
      console.log("序号无效。\n");
      return false;
    }
    await worker.openSession(rows[index - 1].id);
    return true;
  }

  console.log("\n--- 会话 ---");
  console.log(formatConversationList(rows, worker.session.id));
  const answer = (await rl.question("输入序号恢复，回车取消: ")).trim();
  if (!answer || answer === "q" || answer === "/exit" || answer === "/quit") {
    console.log("");
    return false;
  }
  return await pickSession(rl, worker, answer);
}

function extra(worker: LocalWorker) {
  const snap = worker.snapshot();
  return { mode: snap.mode, workspace: snap.workspace, mcpCount: snap.mcpCount };
}

function printSessionChrome(worker: LocalWorker) {
  printBanner(worker.session, extra(worker));
  const task = worker.longTaskText();
  if (task) console.log(task);
  const plan = worker.planText();
  if (plan) console.log(plan);
}

function printTurnResult(result: Awaited<ReturnType<LocalWorker["turn"]>>, opts?: { oneShot?: boolean }) {
  if (result.usageHelp) {
    console.log(setplanUsageText());
    return;
  }
  if (result.reply !== undefined && !opts?.oneShot) {
    process.stdout.write(result.endedNewline ? "\n" : "\n\n");
  } else if (result.reply !== undefined && opts?.oneShot && !result.endedNewline) {
    process.stdout.write("\n");
  }
  if (result.recap) process.stdout.write(`\n${result.recap}\n`);
  if (result.usageLine) process.stdout.write(`${result.usageLine}\n`);
  if (result.checkpoint) process.stdout.write(`\n${result.checkpoint}\n`);
  if (result.error) printErr(result.error);
}

async function handleWorkarea(worker: LocalWorker, input: string) {
  const parsed = parseSetworkarea(input);
  if (!parsed) return false;
  if (!worker.canSetWorkarea()) {
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
  const failed = await worker.applyWorkarea(target);
  if (failed) {
    console.log(`\n${failed}\n`);
    return true;
  }
  console.log(`\n工作区已设为 ${worker.workspace}\n`);
  printBanner(worker.session, extra(worker));
  return true;
}

async function main() {
  migrateLegacyDotenv();
  const { cmd, flags, positional } = parseCli(process.argv);
  if (cmd === "connect") {
    await runConnect(positional[0] ?? "");
    return;
  }
  if (cmd === "worker") {
    if (!flagOn(flags.stdio)) {
      console.error("用法: socode worker --stdio --workspace /abs/path");
      process.exit(2);
    }
    await runWorkerStdio({
      workspace: flags.workspace || positional[0] || process.cwd(),
      flags,
    });
    return;
  }

  const cfg = loadConfig();
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

  const userSystem = flags.system ?? cfg.systemPrompt;
  const agentEnabled = !flagOn(flags["no-agent"]);
  const maxMessages = parsePositiveInt("--max", flags.max) ?? cfg.maxContextMessages;
  const maxSteps = parsePositiveInt("--steps", flags.steps) ?? cfg.maxAgentSteps;
  const maxTokens = parsePositiveInt("--budget", flags.budget) ?? cfg.maxAgentTokens;
  const oneShot = flags.input;
  const resume = flagOn(flags.resume);
  const fresh = flagOn(flags.new);
  const stream = !flagOn(flags["no-stream"]);
  const conversationFlag = flags.id;
  const mode = loadMode(flags.mode, cfg.mode);

  if (flagOn(flags.doctor)) {
    const report = await runDoctor({ workspace: process.cwd(), mode, provider });
    console.log(formatDoctor(report));
    process.exit(report.ok ? 0 : 1);
  }

  if (!providerReady(provider)) {
    if (oneShot !== undefined || !process.stdin.isTTY) {
      console.error(usage());
      console.error("缺少 Provider：需要 API url、API、model name。");
      process.exit(1);
    }
  }

  let worker: LocalWorker;
  const host = createStdioHost(() => worker.mode);
  worker = await openLocalWorker({
    host,
    workspace: process.cwd(),
    provider,
    mode,
    userSystem,
    agentEnabled,
    maxMessages,
    maxSteps,
    maxTokens,
    stream,
    conversationId: conversationFlag,
    resume,
    fresh,
  });

  let rl: readline.Interface | undefined;
  const closeHandles = async () => {
    restoreTerminal();
    try {
      rl?.close();
    } catch {
      // ignore
    }
    await worker.close();
  };
  const forceExit = (code: number) => {
    if (isQuitBlocked()) {
      confirmQuit();
      return;
    }
    restoreTerminal();
    try {
      rl?.close();
    } catch {
      // ignore
    }
    process.exit(code);
  };
  const onSigint = () => {
    if (isQuitBlocked()) {
      confirmQuit();
      return;
    }
    if (confirmQuit()) forceExit(130);
  };
  process.on("SIGINT", onSigint);
  process.once("SIGTERM", () => forceExit(143));

  try {
    if (oneShot !== undefined) {
      const result = await worker.turn(oneShot);
      printTurnResult(result, { oneShot: true });
      if (result.aborted) {
        if (takeForcedQuit()) forceExit(130);
        process.stdout.write("\n已中止\n");
      }
      return;
    }

    const sessionRl = readline.createInterface({ input, output });
    rl = sessionRl;
    sessionRl.on("SIGINT", onSigint);
    if (!providerReady(worker.provider)) {
      worker.setProvider(await promptProviderForm(sessionRl, "setup", worker.provider));
      console.log("");
    }
    printSessionChrome(worker);

    while (true) {
      sessionRl.pause();
      const snap = worker.snapshot();
      const prompt = (
        await promptYou(userPrefix(snap.mode), {
          hint: workareaPlaceholder(snap.workspace),
          status: promptStatusLine(snap.model, snap.thinkingEffort, {
            session: snap.sessionLabel,
            context: formatContextMeter(snap.contextUsed, snap.contextWindow),
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
        if (prompt === "/doctor") {
          console.log(`\n${await worker.doctor()}\n`);
          continue;
        }
        if (prompt === "/undo") {
          console.log(`\n${await worker.undo()}\n`);
          continue;
        }
        if (prompt === "/context") {
          console.log(worker.contextText());
          continue;
        }
        if (prompt === "/usage") {
          console.log(worker.usageText());
          continue;
        }
        if (prompt === "/task" || prompt.startsWith("/task ")) {
          console.log(await worker.task(prompt.slice("/task".length).trim()));
          continue;
        }
        if (prompt === "/mcp") {
          console.log(worker.mcpText());
          continue;
        }
        if (prompt === "/skills") {
          console.log(worker.skillsText());
          continue;
        }
        if (prompt === "/seesubagent" || prompt.startsWith("/seesubagent ")) {
          handleSeesubagent(host, prompt);
          continue;
        }
        if (prompt === "/seeplan" || prompt.startsWith("/seeplan ")) {
          console.log(worker.seeplanText());
          continue;
        }
        if (parseSetworkarea(prompt)) {
          await handleWorkarea(worker, prompt);
          continue;
        }
        const remoteSsh = parseRemoteSshCommand(prompt);
        if (remoteSsh) {
          if (remoteSsh.ok === false) {
            console.log(`\n${remoteSsh.error}\n`);
            continue;
          }
          restoreTerminal();
          const outcome = await runRemoteSshCommand(remoteSsh.target);
          if (outcome === "sshquit") {
            await worker.newSession();
            console.log("\n已断开远程。远端会话 Provider 已删除。本机开了新对话。\n");
          }
          printSessionChrome(worker);
          continue;
        }
        if (prompt === "/sshquit" || prompt.startsWith("/sshquit ")) {
          console.log("\n当前不是远程会话。连上之后才能 /sshquit。\n");
          continue;
        }
        if (prompt === "/compress") {
          const result = await worker.compress();
          if (result.error) {
            console.log(`\n${result.error}\n`);
            continue;
          }
          if (result.aborted) {
            if (takeForcedQuit()) forceExit(130);
            process.stdout.write("\n已中止\n\n");
            continue;
          }
          if (result.reply) process.stdout.write(`${result.reply}\n`);
          console.log(worker.contextText());
          continue;
        }
        if (prompt === "/mode" || prompt.startsWith("/mode ")) {
          const result = worker.modeText(prompt.slice("/mode".length).trim());
          console.log(result.text);
          if (result.changed) {
            await worker.setMode(result.mode);
            const task = worker.longTaskText();
            if (task) console.log(task);
          }
          continue;
        }
        if (prompt === "/new") {
          await worker.newSession();
          console.log("");
          printSessionChrome(worker);
          continue;
        }
        if (prompt === "/provider" || prompt.startsWith("/provider ")) {
          sessionRl.resume();
          const arg = prompt.slice("/provider".length).trim();
          worker.setProvider(await handleProvider(sessionRl, worker.provider, arg));
          continue;
        }
        if (prompt === "/effort" || prompt.startsWith("/effort ")) {
          worker.setProvider(await handleEffort(worker.provider, prompt.slice("/effort".length).trim()));
          continue;
        }
        if (prompt === "/model" || prompt.startsWith("/model ")) {
          worker.setProvider(await handleModel(worker.provider, prompt.slice("/model".length).trim()));
          continue;
        }
        const restore = parseSlash(prompt);
        if (restore) {
          sessionRl.resume();
          const opened = await pickSession(sessionRl, worker, restore.arg);
          if (opened) {
            console.log("");
            printSessionChrome(worker);
          }
          continue;
        }

        const result = await worker.turn(prompt);
        printTurnResult(result);
        if (result.aborted) {
          if (takeForcedQuit()) forceExit(130);
          process.stdout.write("\n已中止\n\n");
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
