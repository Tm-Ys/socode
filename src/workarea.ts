import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute } from "node:path";

export function parseSetworkarea(input: string) {
  const match = input.trim().match(/^\/setworkarea(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { path: (match[1] ?? "").trim() };
}

export function expandWorkareaPath(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return `${homedir()}${trimmed.slice(1)}`;
  return trimmed;
}

export function resolveWorkarea(raw: string): { path: string } | { error: string } {
  const expanded = expandWorkareaPath(raw);
  if (!expanded) return { error: "请提供绝对路径，或留空打开文件夹选择器。" };
  if (!isAbsolute(expanded)) return { error: "工作区必须是绝对路径。" };
  const abs = expanded;
  if (!existsSync(abs)) return { error: `路径不存在: ${abs}` };
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    return { error: `无法解析路径: ${abs}` };
  }
  try {
    if (!lstatSync(real).isDirectory()) return { error: `不是文件夹: ${real}` };
  } catch {
    return { error: `无法读取路径: ${real}` };
  }
  return { path: real };
}

export function displayWorkarea(path: string, home = homedir()) {
  if (path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export function workareaPlaceholder(path: string, opts?: { host?: string; home?: string }) {
  const place = displayWorkarea(path, opts?.home);
  if (opts?.host) return `on ssh@${opts.host} workspace ${place}`;
  return `on ${place}`;
}

export function inputPlaceholder(buffer: string, placeholder?: string) {
  return !buffer && placeholder ? placeholder : "";
}

export async function pickWorkareaFolder(): Promise<{ path: string } | { error: string } | { cancelled: true }> {
  const picked = await pickByPlatform();
  if (picked === null) return { cancelled: true };
  if (typeof picked === "object" && "error" in picked) return picked;
  return resolveWorkarea(picked);
}

async function pickByPlatform(): Promise<string | { error: string } | null> {
  const os = platform();
  if (os === "darwin") {
    return await runPicker("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择工作区")'], "error");
  }
  if (os === "win32") {
    return await runPicker("powershell", [
      "-NoProfile",
      "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择工作区'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -ne 'OK') { exit 1 }; $d.SelectedPath",
    ], "error");
  }
  const linux = [
    ["zenity", ["--file-selection", "--directory", "--title=选择工作区"]],
    ["kdialog", ["--getexistingdirectory", homedir()]],
    ["yad", ["--file-selection", "--directory", "--title=选择工作区"]],
  ] as const;
  for (const [cmd, args] of linux) {
    const result = await runPicker(cmd, [...args], "skip");
    if (result === "skip") continue;
    return result;
  }
  return { error: "没有找到文件夹选择器。请安装 zenity / kdialog，或用 /setworkarea /绝对路径。" };
}

function runPicker(
  command: string,
  args: string[],
  missing: "error" | "skip",
): Promise<string | { error: string } | null | "skip"> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve(missing === "skip" ? "skip" : { error: `找不到 ${command}，请用 /setworkarea /绝对路径。` });
        return;
      }
      resolve({ error: error.message });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const path = stdout.trim().replace(/^['"]|['"]$/g, "").replace(/\/$/, "");
      resolve(path || null);
    });
  });
}
