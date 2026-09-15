import { stdin, stdout } from "node:process";
import { isEscapeKey } from "./abort.js";
import {
  completeCommand,
  ghostText,
  matchCommands,
  resolveCommand,
  type SlashCommand,
} from "./commands.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const CLEAR_DOWN = "\x1b[J";
const QUIT_CONFIRM_MS = 2000;

export const USER_PROMPT = "> ";

let quitArmedAt = 0;
let quitConfirmed = false;

export function confirmQuit() {
  const now = Date.now();
  if (quitArmedAt && now - quitArmedAt <= 50) return false;
  if (quitArmedAt && now < quitArmedAt + QUIT_CONFIRM_MS) {
    quitArmedAt = 0;
    quitConfirmed = true;
    return true;
  }
  quitArmedAt = now;
  const hint = "再按一次退出";
  stdout.write(stdout.isTTY ? `\n${RED}${hint}${RESET}\n` : `\n${hint}\n`);
  return false;
}

export function disarmQuit() {
  quitArmedAt = 0;
}

export function takeForcedQuit() {
  const value = quitConfirmed;
  quitConfirmed = false;
  return value;
}

export function restoreTerminal() {
  try {
    if (stdin.isTTY) stdin.setRawMode(false);
  } catch {
    // already closed or not a TTY
  }
  try {
    stdin.pause();
  } catch {
    // ignore
  }
  if (!stdout.isTTY) return;
  try {
    stdout.write("\x1b[0m\x1b[?25h");
  } catch {
    // ignore
  }
}

export async function promptYou(label = USER_PROMPT) {
  if (!stdin.isTTY || !stdout.isTTY) {
    return await readPlainLine(label);
  }

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let rendered = 0;
    stdin.setRawMode(true);
    stdin.resume();

    function cleanup() {
      stdin.off("data", onData);
      stdin.off("error", onError);
      restoreTerminal();
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    const finish = (value: string) => {
      disarmQuit();
      if (rendered > 1 || value !== buffer) {
        redraw(label, value, [], "", rendered);
      }
      stdout.write("\n");
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (key === "\x03") {
        if (confirmQuit()) {
          cleanup();
          stdout.write("\n");
          resolve("/quit");
          return;
        }
        render();
        return;
      }
      disarmQuit();
      if (key === "\r" || key === "\n" || key === "\r\n") {
        finish(resolveCommand(buffer));
        return;
      }
      if (key === "\t") {
        buffer = completeCommand(buffer);
        render();
        return;
      }
      if (key === "\x7f" || key === "\b") {
        buffer = [...buffer].slice(0, -1).join("");
        render();
        return;
      }
      if (key === "\x15" || isEscapeKey(key)) {
        buffer = "";
        render();
        return;
      }
      if (key.startsWith("\x1b")) return;
      if (key === "\x04") {
        if (!buffer) finish("/quit");
        return;
      }
      if (![...key].every((ch) => ch >= " " || ch === "\t")) return;
      buffer += key;
      render();
    };

    const render = () => {
      const matches = matchCommands(buffer);
      const ghost = ghostText(buffer, matches);
      redraw(label, buffer, matches, ghost, rendered);
      rendered = 1 + (buffer.startsWith("/") ? Math.min(matches.length, 6) : 0);
    };

    stdin.on("data", onData);
    stdin.once("error", onError);
    render();
  });
}

function redraw(
  label: string,
  buffer: string,
  matches: SlashCommand[],
  ghost: string,
  previousLines = 0,
) {
  if (previousLines > 1) stdout.write(`\x1b[${previousLines - 1}A`);
  stdout.write(`\r${CLEAR_DOWN}${label}${buffer}`);
  if (ghost) stdout.write(`${DIM}${ghost}${RESET}`);
  const shown = buffer.startsWith("/") ? matches.slice(0, 6) : [];
  if (shown.length > 0) {
    stdout.write("\n");
    stdout.write(
      shown
        .map((command) => `  ${DIM}${command.name.padEnd(18)} ${command.hint}${RESET}`)
        .join("\n"),
    );
    stdout.write(`\x1b[${shown.length}A`);
    stdout.write(`\r\x1b[${visibleWidth(label + buffer) + 1}G`);
  } else if (ghost) {
    stdout.write(`\r\x1b[${visibleWidth(label + buffer) + 1}G`);
  }
}

function visibleWidth(text: string) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += (char.codePointAt(0) ?? 0) > 127 ? 2 : 1;
  }
  return width;
}

export function watchTurnAbort() {
  const controller = new AbortController();
  const tty = Boolean(stdin.isTTY);
  let paused = false;

  const onData = (chunk: Buffer | string) => {
    if (paused) return;
    const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (key === "\x03") {
      confirmQuit();
      controller.abort();
      return;
    }
    if (controller.signal.aborted) return;
    if (isEscapeKey(key)) controller.abort();
  };

  if (tty) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  }

  return {
    signal: controller.signal,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    dispose: () => {
      stdin.off("data", onData);
      restoreTerminal();
    },
  };
}

export type PermissionAnswer = "allow" | "deny" | "always";

let permissionGate: { pause: () => void; resume: () => void } | undefined;

export function setPermissionGate(gate?: { pause: () => void; resume: () => void }) {
  permissionGate = gate;
}

export async function askPermission(title: string, detail: string): Promise<PermissionAnswer> {
  if (!stdin.isTTY || !stdout.isTTY) return "deny";
  permissionGate?.pause();
  const yellow = "\x1b[33m";
  const dim = "\x1b[2m";
  stdout.write(
    `\n${yellow}? ${title}${RESET}\n  ${dim}${detail}${RESET}\n  ${dim}y 允许  n 拒绝  a 本会话同类一律允许${RESET}\n`,
  );

  try {
    return await new Promise((resolve) => {
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();

      const done = (answer: PermissionAnswer) => {
        stdin.off("data", onData);
        if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
        const label = answer === "allow" ? "允许" : answer === "always" ? "本会话一律允许" : "拒绝";
        stdout.write(`  → ${label}\n`);
        resolve(answer);
      };

      const onData = (chunk: Buffer | string) => {
        const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (key === "y" || key === "Y") {
          done("allow");
          return;
        }
        if (key === "a" || key === "A") {
          done("always");
          return;
        }
        if (key === "n" || key === "N" || key === "\r" || key === "\n" || isEscapeKey(key)) {
          done("deny");
          return;
        }
        if (key === "\x03") {
          confirmQuit();
          done("deny");
        }
      };

      stdin.on("data", onData);
    });
  } finally {
    permissionGate?.resume();
  }
}

async function readPlainLine(label: string) {
  stdout.write(label);
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.at(-1)?.includes(0x0a) || chunks.at(-1)?.includes(0x0d)) break;
  }
  return resolveCommand(Buffer.concat(chunks).toString("utf8").trim());
}
