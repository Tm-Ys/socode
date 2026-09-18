import { stdin as input, stdout as output } from "node:process";
import {
  attachRemoteWorker,
  listRemoteWorkspaces,
  openSshSession,
  paintConnectLog,
  type ConnectLogLevel,
  type ConnectLogger,
  type SshSession,
} from "./connect.js";
import { useColor } from "./markdown.js";
import { printErr } from "./display.js";
import { stopLoadUi } from "./load-ui.js";
import { drainStdin, restoreTerminal, setQuitBlocked } from "./prompt.js";
import { findSshHost, matchSshHosts, parseSshDestination, rememberSshHost } from "./ssh-history.js";
import { isForcedQuit } from "./remote-client.js";
import { parentDir, normalizeAbsPath } from "./remote-install.js";
import { displayWorkarea } from "./workarea.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const HOME = "\x1b[H";
const ERASE_DOWN = "\x1b[J";
const VIEWPORT_CLEAR = "\x1b[H\x1b[2J";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const ALT_ENTER = "\x1b[?1049h";
const ALT_LEAVE = "\x1b[?1049l";
export type RemoteSshFocus = "host" | "user" | "auth" | "secret";
export type RemoteSshPhase = "form" | "pick" | "path" | "install";

export type RemoteSshView = {
  phase: RemoteSshPhase;
  host: string;
  user: string;
  auth: "password" | "key";
  secret: string;
  focus: RemoteSshFocus;
  home: string;
  cwd: string;
  dirs: string[];
  dirIndex: number;
  confirmPath: string;
  pathDraft: string;
  logs: { level: ConnectLogLevel; text: string }[];
  historyIndex: number;
};

export function emptyRemoteSshView(): RemoteSshView {
  return {
    phase: "form",
    host: "",
    user: process.env.USER || "root",
    auth: "password",
    secret: "",
    focus: "host",
    home: "",
    cwd: "",
    dirs: [],
    dirIndex: 0,
    confirmPath: "",
    pathDraft: "",
    logs: [],
    historyIndex: -1,
  };
}

export type PickItem = { kind: "cwd" | "dir" | "path"; path: string; label: string };

export function workspacePickItems(view: RemoteSshView): PickItem[] {
  const cwdLabel = view.cwd ? `${view.cwd}  (当前)` : "当前目录";
  return [
    { kind: "cwd", path: view.cwd, label: cwdLabel },
    ...view.dirs.map((dir) => ({ kind: "dir" as const, path: dir, label: dir })),
    { kind: "path", path: "", label: "输入绝对路径…" },
  ];
}

export function applyRemoteSshKey(view: RemoteSshView, key: string): "redraw" | "connect" | "pick" | "enter-dir" | "parent" | "cancel" {
  if (key === "\x03") return "cancel";
  if (view.phase === "install") return "redraw";

  if (view.confirmPath) {
    if (key === "\x1b") {
      view.confirmPath = "";
      return "redraw";
    }
    if (key === "\r" || key === "\n") return "pick";
    view.confirmPath = "";
  }

  if (key === "\x1b" || key === "\x1b\x1b") return "cancel";

  if (view.phase === "pick") {
    const items = workspacePickItems(view);
    const count = Math.max(1, items.length);
    if (key === "\x1b[A" || key === "k") {
      view.dirIndex = (view.dirIndex - 1 + count) % count;
      return "redraw";
    }
    if (key === "\x1b[B" || key === "j") {
      view.dirIndex = (view.dirIndex + 1) % count;
      return "redraw";
    }
    if (key === "\x1b[C" || key === "l") return "enter-dir";
    if (key === "\x1b[D" || key === "h") return "parent";
    if (key === "\r" || key === "\n") {
      const item = items[view.dirIndex];
      if (!item || item.kind === "path") {
        view.phase = "path";
        return "redraw";
      }
      view.confirmPath = item.path;
      return "redraw";
    }
    return "redraw";
  }

  if (view.phase === "path") {
    if (key === "\x7f" || key === "\b") {
      view.pathDraft = [...view.pathDraft].slice(0, -1).join("");
      return "redraw";
    }
    if (key === "\r" || key === "\n") {
      const path = view.pathDraft.trim();
      if (!path.startsWith("/")) return "redraw";
      view.confirmPath = path;
      return "redraw";
    }
    if (key.startsWith("\x1b")) return "redraw";
    if ([...key].every((ch) => ch >= " ")) view.pathDraft += key;
    return "redraw";
  }

  if (key === "\x1b[A") {
    view.focus = prevFocus(view.focus);
    return "redraw";
  }
  if (key === "\t") {
    if (applySshHistoryTab(view)) return "redraw";
    view.focus = nextFocus(view.focus);
    return "redraw";
  }
  if (key === "\x1b[B") {
    view.focus = nextFocus(view.focus);
    return "redraw";
  }
  if (view.focus === "auth" && (key === "\x1b[C" || key === "\x1b[D" || key === " ")) {
    view.auth = view.auth === "password" ? "key" : "password";
    view.secret = "";
    return "redraw";
  }
  if (key === "\r" || key === "\n") {
    if (view.focus === "secret") return "connect";
    view.focus = nextFocus(view.focus);
    return "redraw";
  }
  if (key === "\x7f" || key === "\b") {
    if (view.focus === "host") {
      view.host = [...view.host].slice(0, -1).join("");
      view.historyIndex = -1;
    }
    if (view.focus === "user") view.user = [...view.user].slice(0, -1).join("");
    if (view.focus === "secret") view.secret = [...view.secret].slice(0, -1).join("");
    return "redraw";
  }
  if (key.startsWith("\x1b")) return "redraw";
  if (![...key].every((ch) => ch >= " ")) return "redraw";
  if (view.focus === "host") {
    view.host += key;
    view.historyIndex = -1;
  }
  if (view.focus === "user") view.user += key;
  if (view.focus === "secret") view.secret += key;
  return "redraw";
}

export function applySshTarget(view: RemoteSshView, raw: string) {
  const parsed = parseSshDestination(raw);
  if (!parsed?.host) return false;
  const remembered = parsed.user ? findSshHost(parsed.user, parsed.host) : matchSshHosts(parsed.host)[0];
  view.host = remembered?.host ?? parsed.host;
  view.user = remembered?.user || parsed.user || view.user;
  view.auth = remembered?.auth ?? "password";
  view.secret = remembered?.auth === "key" ? remembered.identityFile ?? "" : "";
  view.focus = "secret";
  view.historyIndex = -1;
  return true;
}

function applySshHistoryTab(view: RemoteSshView) {
  if (view.phase !== "form") return false;
  if (view.focus !== "host" && view.focus !== "user") return false;
  const prefix = view.focus === "host" ? view.host.trim() : `${view.user.trim()}@${view.host.trim()}`;
  const matches = matchSshHosts(view.focus === "host" ? view.host : prefix);
  if (!matches.length) return false;
  view.historyIndex = (view.historyIndex + 1) % matches.length;
  const picked = matches[view.historyIndex];
  if (!picked) return false;
  view.host = picked.host;
  view.user = picked.user;
  view.auth = picked.auth;
  view.secret = "";
  if (picked.auth === "key" && picked.identityFile) view.secret = picked.identityFile;
  view.focus = "secret";
  return true;
}

function nextFocus(focus: RemoteSshFocus): RemoteSshFocus {
  if (focus === "host") return "user";
  if (focus === "user") return "auth";
  if (focus === "auth") return "secret";
  return "secret";
}

function prevFocus(focus: RemoteSshFocus): RemoteSshFocus {
  if (focus === "secret") return "auth";
  if (focus === "auth") return "user";
  if (focus === "user") return "host";
  return "host";
}

export function formatRemoteSshScreen(view: RemoteSshView, opts?: { cols?: number; rows?: number; color?: boolean }) {
  const cols = Math.max(48, opts?.cols ?? 80);
  const rows = Math.max(8, opts?.rows ?? 24);
  const color = opts?.color ?? false;
  const formHeight = Math.max(5, Math.min(Math.floor(rows / 2), rows - 5));
  const logHeight = rows - formHeight;
  const inner = cols - 4;
  const form =
    view.phase === "pick" || view.phase === "path"
      ? workspaceLines(view, inner, color)
      : view.phase === "install"
        ? installLines(view, inner, color)
        : formLines(view, inner, color);
  const logs = logLines(view, inner, Math.max(1, logHeight - 2), color);
  const top = drawBox("/remote-ssh", form, cols, formHeight, color);
  const bottom = drawBox("日志", logs, cols, logHeight, color);
  const lines = `${top}\n${bottom}`.split("\n");
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows).join("\n");
}

function installLines(view: RemoteSshView, inner: number, color: boolean) {
  const workspace = selectedWorkspace(view);
  return [
    "正在把 worker 装到对方机器，装完会进远程会话。",
    "",
    `主机    ${view.user}@${view.host}`,
    workspace ? `工作区  ${workspace}` : "",
    "",
    dim("安装时密码不再显示。不要按键，等握手完成。", color),
  ]
    .filter((line, index) => line || index === 0)
    .map((line) => clip(line, inner));
}

function formLines(view: RemoteSshView, inner: number, color: boolean) {
  const secretLabel = view.auth === "password" ? "密码" : "密钥";
  return [
    "本机显示器，worker 跑在对方机器。会注入本机 Provider，断开前从远端删掉。",
    "",
    fieldLine("主机", view.host || "IP 或域名", view.focus === "host", inner, color, !view.host),
    fieldLine("用户", view.user, view.focus === "user", inner, color, false),
    authLine(view, inner, color),
    fieldLine(secretLabel, view.secret || (view.auth === "password" ? "输入密码" : "~/.ssh/id_ed25519"), view.focus === "secret", inner, color, !view.secret),
    "",
    dim("tab 补全历史主机 · 密码每次重输 · enter 下一步 · ↑↓ 换栏 · esc 取消", color),
  ].map((line) => clip(line, inner));
}

function workspaceLines(view: RemoteSshView, inner: number, color: boolean) {
  if (view.phase === "path") {
    const rows = [
      "输入远端工作区绝对路径",
      "",
      fieldLine("路径", view.pathDraft || "/abs/path", true, inner, color, !view.pathDraft),
      "",
    ];
    if (view.confirmPath) {
      rows.push(`确定选择 ${view.confirmPath} 为工作目录?`);
      rows.push(dim("enter 再次确认 · esc 取消", color));
    } else {
      rows.push(dim("enter 选定 · esc 取消", color));
    }
    return rows.map((line) => clip(line, inner));
  }
  const items = workspacePickItems(view);
  const start = Math.max(0, view.dirIndex - 4);
  const shown = items.slice(start, start + 6);
  const rows = [
    `选择工作区  ${view.host ? `ssh@${view.host}` : ""}`.trim(),
    view.cwd ? `当前 ${displayWorkarea(view.cwd, view.home || undefined)}` : "",
    "",
    ...shown.map((item, offset) => {
      const index = start + offset;
      const label = item.kind === "dir" && view.cwd && item.path.startsWith(`${view.cwd}/`)
        ? item.path.slice(view.cwd.length + 1)
        : item.label;
      return optionLine(label, index === view.dirIndex, inner, color);
    }),
    "",
  ];
  if (view.confirmPath) {
    rows.push(`确定选择 ${view.confirmPath} 为工作目录?`);
    rows.push(dim("enter 再次确认 · esc / 方向键 取消", color));
  } else {
    rows.push(dim("↑↓ 移动 · → 进入目录 · ← 返回上级 · enter 选定 · esc 取消", color));
  }
  return rows.filter((line, index) => line || index === 0).map((line) => clip(line, inner));
}

function logLines(view: RemoteSshView, inner: number, height: number, color: boolean) {
  const usable = Math.max(1, height);
  const slice = view.logs.slice(-usable);
  if (!slice.length) return [dim("连接日志会显示在这里。成功绿色，失败红色。", color)];
  return slice.map((item) => clip(paintConnectLog(item.level, item.text, color), inner));
}

function fieldLine(label: string, value: string, focused: boolean, inner: number, color: boolean, placeholder: boolean) {
  const mark = focused ? ">" : " ";
  const name = label.padEnd(4);
  const painted = placeholder ? dim(value, color) : focused && color ? `${BOLD}${CYAN}${value}${RESET}` : value;
  return clip(`${mark} ${name}  ${painted}`, inner);
}

function authLine(view: RemoteSshView, inner: number, color: boolean) {
  const focused = view.focus === "auth";
  const mark = focused ? ">" : " ";
  const password = view.auth === "password" ? paintChoice("密码", true, color) : paintChoice("密码", false, color);
  const key = view.auth === "key" ? paintChoice("密钥", true, color) : paintChoice("密钥", false, color);
  return clip(`${mark} 认证  ${password}  ${key}`, inner);
}

function optionLine(label: string, selected: boolean, inner: number, color: boolean) {
  const arrow = selected ? ">" : " ";
  const body = selected && color ? `${BOLD}${CYAN}${label}${RESET}` : selected ? label : dim(label, color);
  return clip(`${arrow} ${body}`, inner);
}

function paintChoice(label: string, selected: boolean, color: boolean) {
  if (selected && color) return `${BOLD}${CYAN}[${label}]${RESET}`;
  if (selected) return `[${label}]`;
  return dim(label, color);
}

function dim(text: string, color: boolean) {
  return color ? `${DIM}${text}${RESET}` : text;
}

function drawBox(title: string, rows: string[], width: number, height: number, color: boolean) {
  const dimC = color ? DIM : "";
  const reset = color ? RESET : "";
  const inner = width - 4;
  const titleText = color ? `${BOLD}${CYAN}${title}${RESET}` : title;
  const dash = Math.max(1, width - visibleWidth(title) - 5);
  const top = `${dimC}╭─ ${reset}${titleText}${dimC} ${"─".repeat(dash)}╮${reset}`;
  const bottom = `${dimC}╰${"─".repeat(width - 2)}╯${reset}`;
  const body = [...rows];
  while (body.length < height - 2) body.push("");
  const middle = body.slice(0, height - 2).map((row) => {
    const clipped = clip(row, inner);
    const pad = Math.max(0, inner - visibleWidth(clipped));
    return `${dimC}│${reset} ${clipped}${" ".repeat(pad)} ${dimC}│${reset}`;
  });
  return [top, ...middle, bottom].join("\n");
}

function clip(text: string, width: number) {
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  const budget = Math.max(1, width - 1);
  for (const token of splitAnsi(text)) {
    if (token.ansi) {
      out += token.text;
      continue;
    }
    for (const char of token.text) {
      const size = charWidth(char);
      if (used + size > budget) return `${out}…`;
      out += char;
      used += size;
    }
  }
  return `${out}…`;
}

function splitAnsi(text: string) {
  const parts: { ansi: boolean; text: string }[] = [];
  const re = /\x1b\[[0-9;]*m/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push({ ansi: false, text: text.slice(last, match.index) });
    parts.push({ ansi: true, text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ ansi: false, text: text.slice(last) });
  return parts;
}

function visibleWidth(text: string) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) width += charWidth(char);
  return width;
}

function charWidth(char: string) {
  const code = char.codePointAt(0) ?? 0;
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return 0;
  if (code >= 0x1100 && code <= 0x115f) return 2;
  if (code >= 0x2e80) return 2;
  return 1;
}

function viewLogger(view: RemoteSshView, redraw: () => void): ConnectLogger {
  const push = (level: ConnectLogLevel, text: string) => {
    view.logs.push({ level, text });
    if (view.logs.length > 200) view.logs.splice(0, view.logs.length - 200);
    redraw();
  };
  return {
    info: (message) => push("info", message),
    ok: (message) => push("ok", message),
    err: (message) => push("err", message),
  };
}

function paintOverlay(view: RemoteSshView, overlay: { open: boolean }) {
  if (!overlay.open) return;
  const cols = output.columns ?? 80;
  const rows = output.rows ?? 24;
  const frame = formatRemoteSshScreen(view, { cols, rows, color: useColor() });
  output.write(`${HIDE}${HOME}${frame}${ERASE_DOWN}`);
}

function enterRemoteSshUi(overlay: { open: boolean }) {
  overlay.open = true;
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  output.write(`${ALT_ENTER}${HIDE}`);
}

function leaveRemoteSshUi(overlay: { open: boolean }, opts?: { clearViewport?: boolean }) {
  const wasOpen = overlay.open;
  overlay.open = false;
  if (wasOpen) output.write(`${SHOW}${ALT_LEAVE}`);
  if (opts?.clearViewport) output.write(VIEWPORT_CLEAR);
  restoreTerminal();
}

function resumeRemoteSshRaw() {
  drainStdin();
  if (input.isTTY) input.setRawMode(true);
  input.resume();
}

export async function runRemoteSshCommand(target = ""): Promise<"sshquit" | undefined> {
  if (!input.isTTY || !output.isTTY) {
    output.write("请在 TTY 里使用 /remote-ssh，或：socode connect user@host:/abs/path\n");
    return;
  }
  const view = emptyRemoteSshView();
  if (target.trim()) applySshTarget(view, target);
  view.logs.push({
    level: "info",
    text: target.trim()
      ? `已填入 ${view.user}@${view.host}。密码要重新输入。`
      : "填写对方 IP、用户名，再选密码或 SSH 密钥。tab 可补全历史主机。",
  });
  let session: SshSession | undefined;
  const overlay = { open: false };
  const paint = () => paintOverlay(view, overlay);
  const log = viewLogger(view, paint);
  enterRemoteSshUi(overlay);
  paint();

  try {
    while (true) {
      const key = await readKey();
      const action = applyRemoteSshKey(view, key);
      if (action === "cancel") {
        log.info("已取消");
        return;
      }
      if (action === "connect") {
        const started = await beginSession(view, log);
        session = started.session;
        resumeRemoteSshRaw();
        paint();
        continue;
      }
      if (action === "enter-dir") {
        if (!session) {
          log.err("还没有 SSH 会话");
          paint();
          continue;
        }
        const item = workspacePickItems(view)[view.dirIndex];
        if (!item || item.kind === "path") {
          view.phase = "path";
          paint();
          continue;
        }
        if (item.kind === "cwd") {
          log.info("已经在这个目录。用 → 进入子目录，enter 选定当前目录。");
          paint();
          continue;
        }
        try {
          await loadWorkspaceDir(session, item.path, view, log);
        } catch (error) {
          log.err(error instanceof Error ? error.message : String(error));
        }
        resumeRemoteSshRaw();
        paint();
        continue;
      }
      if (action === "parent") {
        if (!session) {
          log.err("还没有 SSH 会话");
          paint();
          continue;
        }
        if (!view.cwd || view.cwd === "/") {
          log.info("已经在根目录");
          paint();
          continue;
        }
        try {
          await loadWorkspaceDir(session, parentDir(view.cwd), view, log);
        } catch (error) {
          log.err(error instanceof Error ? error.message : String(error));
        }
        resumeRemoteSshRaw();
        paint();
        continue;
      }
      if (action === "pick") {
        const path = selectedWorkspace(view);
        if (!path) {
          view.phase = "path";
          paint();
          continue;
        }
        if (!session) {
          log.err("还没有 SSH 会话");
          paint();
          continue;
        }
        view.phase = "install";
        paint();
        rememberSshHost({
          user: view.user,
          host: view.host,
          auth: view.auth,
          identityFile: view.auth === "key" ? view.secret : undefined,
          lastWorkspace: path,
        });
        try {
          const attached = await attachRemoteWorker(session, path, {
            log,
            beforeRepl: () => {
              setQuitBlocked(true);
              stopLoadUi();
              drainStdin();
              leaveRemoteSshUi(overlay, { clearViewport: true });
            },
          });
          return attached.sshQuit ? "sshquit" : undefined;
        } catch (error) {
          if (isForcedQuit(error)) return;
          stopLoadUi();
          if (!overlay.open) {
            restoreTerminal();
            printErr(error);
            return;
          }
          view.phase = "pick";
          view.confirmPath = "";
          drainStdin();
          log.err(error instanceof Error ? error.message : String(error));
          paint();
          continue;
        }
      }
      paint();
    }
  } finally {
    session?.close();
    leaveRemoteSshUi(overlay);
  }
}

function selectedWorkspace(view: RemoteSshView) {
  if (view.confirmPath.startsWith("/")) return normalizeAbsPath(view.confirmPath);
  if (view.phase === "path") {
    const path = view.pathDraft.trim();
    return path.startsWith("/") ? normalizeAbsPath(path) : "";
  }
  const picked = workspacePickItems(view)[view.dirIndex]?.path ?? "";
  return picked.startsWith("/") ? normalizeAbsPath(picked) : picked;
}

async function loadWorkspaceDir(session: SshSession, dir: string, view: RemoteSshView, log: ConnectLogger) {
  const listed = await listRemoteWorkspaces(session, { dir, log });
  view.home = listed.home;
  view.cwd = listed.cwd;
  view.dirs = listed.dirs;
  view.dirIndex = 0;
  view.confirmPath = "";
}

async function beginSession(view: RemoteSshView, log: ConnectLogger) {
  const host = view.host.trim();
  const user = view.user.trim();
  if (!host) {
    log.err("请填写主机 IP 或域名");
    return { ok: false as const, session: undefined };
  }
  if (!user) {
    log.err("请填写用户名");
    return { ok: false as const, session: undefined };
  }
  if (!view.secret.trim()) {
    log.err(view.auth === "password" ? "请填写密码" : "请填写密钥路径");
    return { ok: false as const, session: undefined };
  }
  let session: SshSession | undefined;
  try {
    session = await openSshSession({
      user,
      host,
      auth:
        view.auth === "password"
          ? { password: view.secret, preferPassword: true }
          : { identityFile: view.secret },
      log,
    });
    const listed = await listRemoteWorkspaces(session, { log });
    view.home = listed.home;
    view.cwd = listed.cwd;
    view.dirs = listed.dirs;
    view.dirIndex = 0;
    view.confirmPath = "";
    view.phase = "pick";
    rememberSshHost({
      user,
      host,
      auth: view.auth,
      identityFile: view.auth === "key" ? view.secret : undefined,
    });
    const remembered = findSshHost(user, host);
    if (remembered?.lastWorkspace && remembered.lastWorkspace !== listed.cwd) {
      try {
        await loadWorkspaceDir(session, remembered.lastWorkspace, view, log);
      } catch {
        // stay at login cwd
      }
    }
    log.ok("请在上半区选择工作区。→ 进入目录，enter 选定。");
    return { ok: true as const, session };
  } catch (error) {
    session?.close();
    log.err(error instanceof Error ? error.message : String(error));
    return { ok: false as const, session: undefined };
  }
}

function readChunk(timeoutMs?: number) {
  return new Promise<string | null>((resolve, reject) => {
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            cleanup();
            resolve(null);
          }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      cleanup();
      resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      input.off("data", onData);
      input.off("error", onError);
    };
    input.once("data", onData);
    input.once("error", onError);
  });
}

async function readKey() {
  if (input.isTTY) input.setRawMode(true);
  input.resume();
  const first = await readChunk();
  if (first == null) return "";
  if (first !== "\x1b") return first;
  const rest = await readChunk(40);
  return rest ? `${first}${rest}` : first;
}
