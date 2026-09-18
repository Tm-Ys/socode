import type { AgentEvent } from "./agent.js";
import type { PermissionAnswer } from "./prompt.js";
import type { QuestionInfo, QuestionOutcome } from "./question.js";
import type { SubagentJob } from "./subagent-plan.js";

export type WorkerHost = {
  emitEvent: (event: AgentEvent, opts?: { tag?: string }) => void;
  askPermission: (title: string, detail: string, diff?: string) => Promise<PermissionAnswer>;
  askQuestions: (questions: QuestionInfo[], signal?: AbortSignal) => Promise<QuestionOutcome>;
  startLoad: () => void;
  stopLoad: () => void;
  beginTurn: () => void;
  subagent: {
    startBatch: (jobs: SubagentJob[]) => void;
    jobStart: (id: number) => void;
    jobDone: (job: SubagentJob) => void;
    record: (id: number, event: AgentEvent) => boolean;
    watching: () => number | null;
    watch: (index: number | null) => { id: number; phase: string } | undefined;
    listText: () => string;
    logText: (id: number) => string;
    guard: (fn: () => void) => void;
    refresh: () => void;
  };
};

export function silentHost(overrides: Partial<WorkerHost> = {}): WorkerHost {
  return {
    emitEvent: () => undefined,
    askPermission: async () => "deny",
    askQuestions: async () => "unavailable",
    startLoad: () => undefined,
    stopLoad: () => undefined,
    beginTurn: () => undefined,
    subagent: {
      startBatch: () => undefined,
      jobStart: () => undefined,
      jobDone: () => undefined,
      record: () => false,
      watching: () => null,
      watch: () => undefined,
      listText: () => "",
      logText: () => "",
      guard: (fn) => fn(),
      refresh: () => undefined,
    },
    ...overrides,
  };
}
