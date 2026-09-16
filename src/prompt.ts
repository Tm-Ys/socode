import { stdin, stdout } from "node:process";
import { isEscapeKey } from "./abort.js";
import {
  completeCommand,
  ghostText,
  matchCommands,
  resolveCommand,
  type SlashCommand,
} from "./commands.js";
import { inputPlaceholder } from "./workarea.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const CLEAR_DOWN = "\x1b[J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
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

export async function promptYou(label = USER_PROMPT, opts?: { hint?: string }) {
  if (!stdin.isTTY || !stdout.isTTY) {
    return await readPlainLine(label);
  }

  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let inputRows = 1;
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
      const menuOpen = buffer.startsWith("/") && matchCommands(buffer).length > 0;
      const hintShowing = Boolean(opts?.hint && !buffer);
      if (menuOpen || value !== buffer || hintShowing) {
        inputRows = redraw(label, value, [], "", inputRows);
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
      const hint = ghost ? "" : inputPlaceholder(buffer, opts?.hint);
      inputRows = redraw(label, buffer, matches, ghost, inputRows, hint);
    };

    stdin.on("data", onData);
    stdin.once("error", onError);
    render();
  });
}

export function clipToWidth(text: string, cols: number) {
  const limit = Math.max(1, cols);
  if (visibleWidth(text) <= limit) return text;
  const budget = Math.max(1, limit - 1);
  let width = 0;
  let out = "";
  for (const char of text) {
    const w = charWidth(char);
    if (width + w > budget) break;
    out += char;
    width += w;
  }
  return `${out}…`;
}

export function visualRows(width: number, cols: number) {
  const size = Math.max(1, cols);
  if (width <= 0) return 1;
  return Math.max(1, Math.ceil(width / size));
}

function redraw(
  label: string,
  buffer: string,
  matches: SlashCommand[],
  ghost: string,
  prevInputRows = 1,
  hint = "",
) {
  const cols = Math.max(20, stdout.columns ?? 80);
  stdout.write(HIDE_CURSOR);
  if (prevInputRows > 1) stdout.write(`\x1b[${prevInputRows - 1}A`);
  stdout.write(`\r${CLEAR_DOWN}${label}${buffer}`);
  if (ghost) stdout.write(`${DIM}${ghost}${RESET}`);
  else if (hint) stdout.write(`${DIM}${hint}${RESET}`);
  const shown = buffer.startsWith("/") ? matches.slice(0, 6) : [];
  if (shown.length > 0) {
    const lines = shown.map((command) =>
      clipToWidth(`  ${command.name.padEnd(18)} ${command.hint}`, cols),
    );
    stdout.write(`\n${lines.map((line) => `${DIM}${line}${RESET}`).join("\n")}`);
    stdout.write(`\x1b[${lines.length}A`);
    stdout.write(`\r\x1b[${cursorColumn(visibleWidth(label + buffer), cols)}G`);
  } else if (ghost || hint) {
    stdout.write(`\r\x1b[${cursorColumn(visibleWidth(label + buffer), cols)}G`);
  }
  stdout.write(SHOW_CURSOR);
  return visualRows(visibleWidth(label + buffer + ghost + hint), cols);
}

function cursorColumn(width: number, cols: number) {
  const size = Math.max(1, cols);
  const col = width % size;
  return (col === 0 && width > 0 ? size : col) + 1;
}

function visibleWidth(text: string) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += charWidth(char);
  }
  return width;
}

function charWidth(char: string) {
  if (char === "…" || char === "·") return 1;
  return (char.codePointAt(0) ?? 0) > 127 ? 2 : 1;
}

export function watchTurnAbort(opts?: { onCommand?: (line: string) => void }) {
  const controller = new AbortController();
  const tty = Boolean(stdin.isTTY);
  let paused = false;
  let command = "";

  const onData = (chunk: Buffer | string) => {
    if (paused) return;
    const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (key === "\x03") {
      command = "";
      confirmQuit();
      controller.abort();
      return;
    }
    if (controller.signal.aborted) return;
    if (isEscapeKey(key)) {
      command = "";
      controller.abort();
      return;
    }
    if (command || key === "/") {
      if (key === "\r" || key === "\n" || key === "\r\n") {
        const line = command;
        command = "";
        if (line) opts?.onCommand?.(line);
        return;
      }
      if (key === "\x7f" || key === "\b") {
        command = [...command].slice(0, -1).join("");
        return;
      }
      if (key.startsWith("\x1b")) return;
      if (![...key].every((ch) => ch >= " " || ch === "\t")) return;
      command += key;
    }
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
let permissionChain = Promise.resolve();

export function setPermissionGate(gate?: { pause: () => void; resume: () => void }) {
  permissionGate = gate;
}

export async function askPermission(title: string, detail: string): Promise<PermissionAnswer> {
  let release!: () => void;
  const previous = permissionChain;
  permissionChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  if (!stdin.isTTY || !stdout.isTTY) {
    release();
    return "deny";
  }
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
    release();
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
