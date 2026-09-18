import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userSocodeDir } from "./provider.js";

export type SshHistoryAuth = "password" | "key";

export type SshHistoryEntry = {
  user: string;
  host: string;
  auth: SshHistoryAuth;
  identityFile?: string;
  lastWorkspace?: string;
  lastAt: string;
};

const MAX_HOSTS = 20;

export function sshHistoryPath() {
  return join(userSocodeDir(), "ssh-hosts.json");
}

export function sshDestination(entry: Pick<SshHistoryEntry, "user" | "host">) {
  return `${entry.user}@${entry.host}`;
}

export function parseSshDestination(raw: string): { user: string; host: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes(" ") || trimmed.includes(":") || trimmed.includes("/")) return null;
  const at = trimmed.lastIndexOf("@");
  if (at < 0) {
    if (!isHost(trimmed)) return null;
    return { user: "", host: trimmed };
  }
  const user = trimmed.slice(0, at);
  const host = trimmed.slice(at + 1);
  if (!user || !isHost(host)) return null;
  return { user, host };
}

export function listSshHosts(): SshHistoryEntry[] {
  return readHistory().hosts;
}

export function findSshHost(user: string, host: string) {
  const key = destKey(user, host);
  return listSshHosts().find((item) => destKey(item.user, item.host) === key);
}

export function matchSshHosts(prefix: string) {
  const needle = prefix.trim().toLowerCase();
  const hosts = listSshHosts();
  if (!needle) return hosts;
  return hosts.filter((item) => {
    const dest = sshDestination(item).toLowerCase();
    return dest.startsWith(needle) || item.host.toLowerCase().startsWith(needle) || item.user.toLowerCase().startsWith(needle);
  });
}

export function rememberSshHost(input: {
  user: string;
  host: string;
  auth?: SshHistoryAuth;
  identityFile?: string;
  lastWorkspace?: string;
}) {
  const user = input.user.trim();
  const host = input.host.trim();
  if (!user || !isHost(host)) return;
  const prev = findSshHost(user, host);
  const auth = input.auth ?? prev?.auth ?? "password";
  const identityFile = auth === "key" ? safeIdentity(input.identityFile ?? prev?.identityFile) : undefined;
  const entry: SshHistoryEntry = {
    user,
    host,
    auth,
    lastAt: new Date().toISOString(),
    ...(identityFile ? { identityFile } : {}),
    ...(workspaceOf(input.lastWorkspace ?? prev?.lastWorkspace) ? { lastWorkspace: workspaceOf(input.lastWorkspace ?? prev?.lastWorkspace) } : {}),
  };
  const rest = readHistory().hosts.filter((item) => destKey(item.user, item.host) !== destKey(user, host));
  writeHistory([entry, ...rest].slice(0, MAX_HOSTS));
}

function destKey(user: string, host: string) {
  return `${user.trim().toLowerCase()}@${host.trim().toLowerCase()}`;
}

function isHost(value: string) {
  return Boolean(value) && !value.includes("@") && !value.includes(" ") && !value.includes(":") && !value.includes("/");
}

function safeIdentity(value?: string) {
  const path = value?.trim() ?? "";
  if (!path.startsWith("/") && !path.startsWith("~")) return undefined;
  if (path.includes("\n") || path.includes("\0")) return undefined;
  return path;
}

function workspaceOf(value?: string) {
  const path = value?.trim() ?? "";
  if (!path.startsWith("/")) return "";
  const body = path.replace(/^\/+/, "").replace(/\/+$/, "");
  return body ? `/${body}` : "/";
}

function readHistory(): { hosts: SshHistoryEntry[] } {
  const path = sshHistoryPath();
  if (!existsSync(path)) return { hosts: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { hosts?: unknown };
    if (!Array.isArray(data.hosts)) return { hosts: [] };
    return { hosts: data.hosts.map(parseEntry).filter((item): item is SshHistoryEntry => Boolean(item)) };
  } catch {
    return { hosts: [] };
  }
}

function parseEntry(raw: unknown): SshHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.password === "string" || typeof item.secret === "string" || typeof item.api === "string") {
    // ignore poisoned records; never round-trip secrets
  }
  const user = typeof item.user === "string" ? item.user.trim() : "";
  const host = typeof item.host === "string" ? item.host.trim() : "";
  if (!user || !isHost(host)) return null;
  const auth: SshHistoryAuth = item.auth === "key" ? "key" : "password";
  const identityFile = auth === "key" ? safeIdentity(typeof item.identityFile === "string" ? item.identityFile : "") : undefined;
  const lastWorkspace = workspaceOf(typeof item.lastWorkspace === "string" ? item.lastWorkspace : "");
  return {
    user,
    host,
    auth,
    lastAt: typeof item.lastAt === "string" ? item.lastAt : new Date(0).toISOString(),
    ...(identityFile ? { identityFile } : {}),
    ...(lastWorkspace ? { lastWorkspace } : {}),
  };
}

function writeHistory(hosts: SshHistoryEntry[]) {
  const path = sshHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ hosts }, null, 2)}\n`, "utf8");
}
