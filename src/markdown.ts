const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const STRIKE = "\x1b[9m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const YELLOW = "\x1b[33m";

export type MarkdownLive = {
  raw: string;
  rows: number;
};

export function newMarkdownLive(): MarkdownLive {
  return { raw: "", rows: 0 };
}

export function useColor(tty = Boolean(process.stdout.isTTY)) {
  return tty && !process.env.NO_COLOR;
}

export function renderMarkdown(src: string, opts?: { color?: boolean }) {
  const color = opts?.color ?? false;
  const lines = src.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        body.push(lines[i]);
        i += 1;
      }
      out.push(renderFence(body, color));
      continue;
    }
    out.push(renderBlock(line, color));
  }
  return out.join("\n");
}

export function displayRows(text: string, columns: number) {
  const cols = Math.max(1, columns);
  const lines = text.split("\n");
  let rows = 0;
  for (const line of lines) {
    const width = visibleWidth(line);
    rows += Math.max(1, Math.ceil(width / cols) || 1);
  }
  return rows;
}

export function rewindLive(write: (text: string) => void, rows: number) {
  if (rows <= 0) return;
  write("\r");
  if (rows > 1) write(`\x1b[${rows - 1}A`);
  write("\x1b[J");
}

export function paintMarkdownDelta(params: {
  live: MarkdownLive;
  chunk: string;
  prefix: string;
  write: (text: string) => void;
  columns: number;
  color: boolean;
}) {
  params.live.raw += params.chunk;
  const rendered = `${params.prefix}${renderMarkdown(params.live.raw, { color: params.color })}`;
  rewindLive(params.write, params.live.rows);
  params.write(rendered);
  params.live.rows = displayRows(rendered, params.columns);
}

export function finishMarkdownLive(live: MarkdownLive) {
  live.raw = "";
  live.rows = 0;
}

function renderFence(body: string[], color: boolean) {
  const text = body.join("\n");
  if (!color) return text;
  return text
    .split("\n")
    .map((line) => `${DIM}${CYAN}${line}${RESET}`)
    .join("\n");
}

function renderBlock(line: string, color: boolean) {
  const heading = /^(#{1,6})\s+(.+)$/.exec(line);
  if (heading) {
    const level = heading[1].length;
    const title = renderInline(heading[2], color);
    if (!color) return title;
    if (level === 1) return `${BOLD}${UNDERLINE}${title}${RESET}`;
    if (level === 2) return `${BOLD}${MAGENTA}${title}${RESET}`;
    return `${BOLD}${title}${RESET}`;
  }
  if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
    return color ? `${DIM}────${RESET}` : "----";
  }
  const quote = /^>\s?(.*)$/.exec(line);
  if (quote) {
    const body = renderInline(quote[1], color);
    return color ? `${DIM}${ITALIC}${body}${RESET}` : body;
  }
  const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
  if (list) {
    const mark = /^\d+\./.test(list[2]) ? list[2] : "•";
    const body = renderInline(list[3], color);
    return `${list[1]}${color ? `${YELLOW}${mark}${RESET}` : mark} ${body}`;
  }
  if (/^\s*\|/.test(line) && line.includes("|")) {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell && !/^[-:]+$/.test(cell))
      .map((cell) => renderInline(cell, color));
    if (cells.length) return cells.join(color ? `${DIM} │ ${RESET}` : " | ");
  }
  return renderInline(line, color);
}

function renderInline(src: string, color: boolean) {
  let i = 0;
  let out = "";
  while (i < src.length) {
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        out += paint(src.slice(i + 1, end), "code", color);
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i) || src.startsWith("__", i)) {
      const mark = src.slice(i, i + 2);
      const end = src.indexOf(mark, i + 2);
      if (end > i + 1) {
        out += paint(src.slice(i + 2, end), "bold", color);
        i = end + 2;
        continue;
      }
    }
    if (src.startsWith("~~", i)) {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 1) {
        out += paint(src.slice(i + 2, end), "strike", color);
        i = end + 2;
        continue;
      }
    }
    if (src[i] === "*" || src[i] === "_") {
      const mark = src[i];
      if (mark === "_" && isWord(src[i - 1]) && isWord(src[i + 1])) {
        out += src[i];
        i += 1;
        continue;
      }
      const end = src.indexOf(mark, i + 1);
      if (end > i + 1 && src[end + 1] !== mark) {
        out += paint(src.slice(i + 1, end), "italic", color);
        i = end + 1;
        continue;
      }
    }
    if (src[i] === "[") {
      const link = /^\[([^\]]+)\]\(([^)]+)\)/.exec(src.slice(i));
      if (link) {
        const label = paint(link[1], "bold", color);
        const url = color ? `${DIM} ${link[2]}${RESET}` : ` ${link[2]}`;
        out += `${label}${url}`;
        i += link[0].length;
        continue;
      }
    }
    out += src[i];
    i += 1;
  }
  return out;
}

function paint(text: string, kind: "bold" | "italic" | "code" | "strike", color: boolean) {
  if (!color) return text;
  if (kind === "bold") return `${BOLD}${text}${RESET}`;
  if (kind === "italic") return `${ITALIC}${text}${RESET}`;
  if (kind === "strike") return `${STRIKE}${text}${RESET}`;
  return `${CYAN}${text}${RESET}`;
}

function isWord(ch: string | undefined) {
  return Boolean(ch && /[A-Za-z0-9]/.test(ch));
}

export function visibleWidth(text: string) {
  let width = 0;
  for (const char of text.replace(/\x1b\[[0-9;]*m/g, "")) {
    width += (char.codePointAt(0) ?? 0) > 127 ? 2 : 1;
  }
  return width;
}
