export type EditStrategy = "exact" | "crlf" | "trim";

export function applySnippetEdit(text: string, oldText: string, newText: string, replaceAll = false) {
  if (!oldText) throw new Error("old_string 不能为空");
  const exact = countOccurrences(text, oldText);
  if (exact > 0) {
    if (!replaceAll && exact > 1) {
      throw new Error(`找到 ${exact} 处相同文本。把 old_string 写得更独特，或设 replace_all=true。`);
    }
    return {
      next: replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, newText),
      count: replaceAll ? exact : 1,
      strategy: "exact" as const,
    };
  }
  const crlfNeedle = oldText.includes("\r\n") ? oldText.replace(/\r\n/g, "\n") : oldText.replace(/\n/g, "\r\n");
  if (crlfNeedle !== oldText) {
    const crlf = countOccurrences(text, crlfNeedle);
    if (crlf > 0) {
      if (!replaceAll && crlf > 1) {
        throw new Error(`找到 ${crlf} 处相同文本。把 old_string 写得更独特，或设 replace_all=true。`);
      }
      const crlfNew = oldText.includes("\r\n") ? newText.replace(/\r\n/g, "\n") : newText.replace(/\n/g, "\r\n");
      return {
        next: replaceAll ? text.split(crlfNeedle).join(crlfNew) : text.replace(crlfNeedle, crlfNew),
        count: replaceAll ? crlf : 1,
        strategy: "crlf" as const,
      };
    }
  }
  const trimmed = findTrimmedBlocks(text, oldText);
  if (trimmed.length === 0) {
    throw new Error(`未找到要替换的文本。先 read，再提供文件里的精确片段。${nearbyHint(text, oldText)}`);
  }
  if (!replaceAll && trimmed.length > 1) {
    throw new Error(`找到 ${trimmed.length} 处相同文本（忽略行尾空白后）。把 old_string 写得更独特，或设 replace_all=true。`);
  }
  const targets = replaceAll ? trimmed : trimmed.slice(0, 1);
  let next = text;
  for (const block of [...targets].reverse()) {
    next = `${next.slice(0, block.start)}${newText}${next.slice(block.end)}`;
  }
  return { next, count: targets.length, strategy: "trim" as const };
}

export function formatEditDiff(path: string, before: string, after: string) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const removed = oldLines.slice(start, oldEnd);
  const added = newLines.slice(start, newEnd);
  const hunk = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${start + 1},${Math.max(1, removed.length)} +${start + 1},${Math.max(1, added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");
  return hunk.length > 4000 ? `${hunk.slice(0, 4000)}\n... [diff truncated]` : hunk;
}

function countOccurrences(text: string, needle: string) {
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + Math.max(1, needle.length);
  }
  return count;
}

function findTrimmedBlocks(text: string, needle: string) {
  const needleLines = needle.split("\n").map((line) => line.trimEnd());
  if (!needleLines.length || needleLines.every((line) => !line)) return [];
  const hayLines = text.split("\n");
  const hits: { start: number; end: number }[] = [];
  for (let i = 0; i <= hayLines.length - needleLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needleLines.length; j += 1) {
      if (hayLines[i + j].trimEnd() !== needleLines[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const raw = hayLines.slice(i, i + needleLines.length).join("\n");
    const start = offsetOfLine(hayLines, i);
    hits.push({ start, end: start + raw.length });
  }
  return hits;
}

function offsetOfLine(lines: string[], index: number) {
  let offset = 0;
  for (let i = 0; i < index && i < lines.length; i += 1) {
    offset += lines[i].length;
    if (i < lines.length - 1) offset += 1;
  }
  return offset;
}

function nearbyHint(text: string, needle: string) {
  const first = needle.split("\n")[0]?.trim() ?? "";
  if (first.length < 4) return "";
  const lines = text.split("\n");
  const key = first.slice(0, 40);
  const at = lines.findIndex((line) => line.includes(key) || key.includes(line.trim()));
  if (at < 0) return "";
  const from = Math.max(0, at - 2);
  const snippet = lines.slice(from, from + 8).map((line, i) => `${from + i + 1}|${line}`).join("\n");
  return `\n文件里接近的片段:\n${snippet}`;
}
