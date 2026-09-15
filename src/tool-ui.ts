const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

export function summarizeTool(name: string, rawArgs: string) {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return clip(rawArgs.replace(/\s+/g, " "), 64);
  }
  switch (name) {
    case "read":
    case "write":
      return shortPath(str(args.path));
    case "bash":
      return clip(str(args.command).replace(/\s+/g, " "), 72);
    case "search": {
      const pattern = str(args.pattern);
      const dir = shortPath(str(args.directory));
      return dir ? `${pattern}  ${dir}` : pattern;
    }
    case "calculate":
      return str(args.expression);
    case "get_current_time":
      return str(args.timezone) || "local";
    default: {
      const compact = Object.entries(args)
        .map(([key, value]) => `${key}=${clip(String(value), 24)}`)
        .join(" ");
      return clip(compact, 72);
    }
  }
}

export function formatToolCallLine(name: string, rawArgs: string) {
  const detail = summarizeTool(name, rawArgs);
  const suffix = detail ? `  ${DIM}${detail}${RESET}` : "";
  return `  ${CYAN}${BOLD}●${RESET} ${BOLD}${name}${RESET}${suffix}`;
}

export function formatToolResultLines(result: string) {
  const failed = isToolError(result);
  const body = clipToolOutput(tidyResult(result), 3);
  if (!body.trim()) return [];
  const color = failed ? RED : DIM;
  return body.split("\n").map((line) => `    ${color}${line}${RESET}`);
}

function clipToolOutput(text: string, lines = 3) {
  const parts = text.replace(/\s+$/u, "").split("\n");
  if (parts.length <= lines) return parts.join("\n");
  return `… +${parts.length - lines} 行\n${parts.slice(-lines).join("\n")}`;
}

function tidyResult(text: string) {
  return text
    .replace(/\s+$/u, "")
    .replace(/^exit=0\n/, "")
    .replace(/^stdout:\n/, "")
    .replace(/\nstderr:\n?$/u, "");
}

function isToolError(text: string) {
  return (
    text.startsWith("工具执行失败") ||
    text.startsWith("未知工具") ||
    /^exit=[1-9]/m.test(text)
  );
}

function shortPath(path: string) {
  if (!path) return "";
  const cwd = process.cwd();
  if (path === cwd) return ".";
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  const home = process.env.HOME;
  if (home && path === home) return "~";
  if (home && path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function str(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
