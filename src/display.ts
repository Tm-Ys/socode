import { formatBanner, pickWelcome } from "./banner.js";
import type { AgentEvent } from "./agent.js";
import { createLoadUi } from "./load-ui.js";
import {
  finishMarkdownLive,
  newMarkdownLive,
  paintMarkdownDelta,
  paintThinkingDelta,
  thinkingPrefix,
  useColor,
  type MarkdownLive,
} from "./markdown.js";
import { assistantPrefix, type AgentMode } from "./mode.js";
import { askPermission } from "./prompt.js";
import { askQuestions } from "./question-ui.js";
import { recapLine } from "./recap.js";
import { createSubagentUi } from "./subagent-ui.js";
import { formatToolCallLine, formatToolResultLines } from "./tool-ui.js";
import type { Message } from "./db.js";
import type { WorkerHost } from "./worker-host.js";

export type PrintState = {
  replied: boolean;
  md?: MarkdownLive;
  think?: MarkdownLive;
  thinkingShown?: boolean;
};

export function newPrintState(): PrintState {
  return { replied: false };
}

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

export function printBanner(session: { title: string }, extra: { mode: AgentMode; workspace: string; mcpCount?: number; remoteHost?: string; remoteHome?: string }) {
  console.log(
    formatBanner({
      workspace: extra.workspace,
      title: session.title,
      mode: extra.mode,
      mcpCount: extra.mcpCount,
      welcome: pickWelcome(),
      width: process.stdout.columns ?? 60,
      color: useColor(),
      remoteHost: extra.remoteHost,
      remoteHome: extra.remoteHome,
    }),
  );
  console.log("");
}

export function printAgentEvent(
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

export function printTurnRecap(trace: Message[]) {
  const line = recapLine(trace, { color: useColor() });
  if (!line) return;
  process.stdout.write(`\n${line}\n`);
}

export function printErr(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nerr> ${message}\n`);
}

export type StdioHost = WorkerHost & {
  subagentUi: ReturnType<typeof createSubagentUi>;
};

export function createStdioHost(mode: () => AgentMode): StdioHost {
  const subagentUi = createSubagentUi();
  const childPrint = new Map<number, PrintState>();
  let turn = newPrintState();
  let load = createLoadUi();

  const printChild = (id: number) => {
    let state = childPrint.get(id);
    if (!state) {
      state = newPrintState();
      childPrint.set(id, state);
    }
    return state;
  };

  return {
    subagentUi,
    beginTurn() {
      turn = newPrintState();
      load = createLoadUi();
    },
    emitEvent(event, opts) {
      const tag = opts?.tag;
      if (tag) {
        const match = /^(\d+)\s/.exec(tag);
        const id = match ? Number(match[1]) : NaN;
        if (Number.isFinite(id)) {
          printAgentEvent(event, printChild(id), mode(), tag, subagentUi);
          return;
        }
      }
      printAgentEvent(event, turn, mode(), tag, subagentUi);
    },
    askPermission,
    askQuestions,
    startLoad() {
      load.start();
    },
    stopLoad() {
      load.stop();
    },
    subagent: {
      startBatch(jobs) {
        childPrint.clear();
        subagentUi.startBatch(jobs);
      },
      jobStart(id) {
        subagentUi.jobStart(id);
      },
      jobDone(job) {
        subagentUi.jobDone(job);
      },
      record(id, event) {
        return subagentUi.record(id, event);
      },
      watching() {
        return subagentUi.watching();
      },
      watch(index) {
        const job = subagentUi.watch(index);
        return job ? { id: job.id, phase: job.phase } : undefined;
      },
      listText() {
        return subagentUi.listText();
      },
      logText(id) {
        return subagentUi.logText(id);
      },
      guard(fn) {
        subagentUi.guard(fn);
      },
      refresh() {
        subagentUi.refresh();
      },
    },
  };
}
