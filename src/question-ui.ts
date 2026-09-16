import { stdin, stdout } from "node:process";
import { throwIfAborted } from "./abort.js";
import { displayRows, rewindLive, useColor } from "./markdown.js";
import { confirmQuit, withPermissionLock } from "./prompt.js";
import {
  applyQuestionKey,
  createQuestionnaireState,
  formatQuestionFrame,
  type QuestionInfo,
  type QuestionOutcome,
} from "./question.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export async function askQuestions(questions: QuestionInfo[], signal?: AbortSignal): Promise<QuestionOutcome> {
  throwIfAborted(signal);
  if (process.env.NODE_TEST_CONTEXT) return "unavailable";
  return await withPermissionLock(async () => {
    throwIfAborted(signal);
    if (!stdin.isTTY || !stdout.isTTY) return "unavailable";
    return await runQuestionPrompt(questions, signal);
  });
}

async function runQuestionPrompt(questions: QuestionInfo[], signal?: AbortSignal): Promise<QuestionOutcome> {
  let state = createQuestionnaireState(questions);
  const color = useColor();
  let rows = 0;
  stdout.write(`\n${HIDE_CURSOR}`);

  const paint = () => {
    const frame = formatQuestionFrame(state, { color, columns: stdout.columns ?? 80 });
    rewindLive((text) => stdout.write(text), rows);
    stdout.write(frame);
    rows = displayRows(frame, stdout.columns ?? 80);
    stdout.write(state.editing ? SHOW_CURSOR : HIDE_CURSOR);
  };

  return await new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    paint();
    let settled = false;

    const finish = (outcome: QuestionOutcome) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      rewindLive((text) => stdout.write(text), rows);
      stdout.write(SHOW_CURSOR);
      if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      if (outcome === "reject") stdout.write("  → 已取消\n");
      else if (outcome === "unavailable") stdout.write("  → 无法作答\n");
      else {
        const summary = questions
          .map((question, index) => {
            const value = outcome[index]?.length ? outcome[index].join(", ") : "（未答）";
            return `  → ${question.header}: ${value}`;
          })
          .join("\n");
        stdout.write(`${summary}\n`);
      }
      resolve(outcome);
    };

    const onAbort = () => finish("reject");
    signal?.addEventListener("abort", onAbort, { once: true });

    const onData = (chunk: Buffer | string) => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (key === "\x03") {
        if (confirmQuit()) {
          finish("reject");
          return;
        }
        paint();
        return;
      }
      const result = applyQuestionKey(state, key);
      if (result.type === "submit") {
        finish(result.answers);
        return;
      }
      if (result.type === "reject") {
        finish("reject");
        return;
      }
      state = result.state;
      paint();
    };

    stdin.on("data", onData);
  });
}
