import { existsSync, readFileSync, statSync } from "node:fs";
import { applySnippetEdit, formatEditDiff } from "./patch.js";

export const ASK_DIFF_MAX = 12_000;

export function formatAskDiff(name: string, path: string, args: Record<string, unknown>): string {
  if (name === "write") {
    const next = typeof args.content === "string" ? args.content : "";
    const before = readText(path);
    return formatEditDiff(path, before ?? "", next, ASK_DIFF_MAX);
  }
  if (name === "edit") {
    const before = readText(path);
    if (before === null) return `文件不存在，无法预览 diff: ${path}`;
    const oldText = typeof args.old_string === "string" ? args.old_string : "";
    const newText = typeof args.new_string === "string" ? args.new_string : "";
    try {
      const result = applySnippetEdit(before, oldText, newText, args.replace_all === true);
      return formatEditDiff(path, before, result.next, ASK_DIFF_MAX);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `无法生成 diff: ${message}`;
    }
  }
  if (name === "delete") return formatDeletePreview(path);
  return "";
}

export function paintAskDiff(text: string, color: boolean) {
  if (!color) return text;
  const reset = "\x1b[0m";
  return text
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return `\x1b[2m${line}${reset}`;
      if (line.startsWith("+")) return `\x1b[32m${line}${reset}`;
      if (line.startsWith("-")) return `\x1b[31m${line}${reset}`;
      if (line.startsWith("@@")) return `\x1b[36m${line}${reset}`;
      return `\x1b[2m${line}${reset}`;
    })
    .join("\n");
}

function formatDeletePreview(path: string) {
  try {
    const info = statSync(path);
    if (!info.isFile()) return `将删除 ${path}`;
    const raw = readFileSync(path);
    if (raw.includes(0)) return `将删除二进制文件 ${path}（${info.size} bytes）`;
    const lines = raw.toString("utf8").split("\n");
    const shown = lines.slice(0, 80);
    const body = shown.map((line) => `-${line}`).join("\n");
    const extra = lines.length > 80 ? `\n... +${lines.length - 80} lines` : "";
    return `--- ${path}\n+++ /dev/null\n@@ file ${info.size} bytes, ${lines.length} lines @@\n${body}${extra}`;
  } catch {
    return `将删除 ${path}（文件当前不存在）`;
  }
}

function readText(path: string) {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path);
    if (raw.includes(0)) return null;
    return raw.toString("utf8");
  } catch {
    return null;
  }
}
