const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ERASE_LINE = "\x1b[2K";

export const LOAD_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const LOAD_INTERVAL_MS = 80;
const BAR_WIDTH = 12;
const BAR_BLOCK = 3;

export type LoadUi = {
  start: () => void;
  stop: () => void;
};

type LoadUiOptions = {
  label?: string;
  tty?: boolean;
  color?: boolean;
  write?: (text: string) => void;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

let active: LoadUi | undefined;

export function formatLoadFrame(tick: number, opts?: { label?: string; color?: boolean }) {
  const spin = LOAD_FRAMES[((tick % LOAD_FRAMES.length) + LOAD_FRAMES.length) % LOAD_FRAMES.length];
  const bar = pulseBar(tick, BAR_WIDTH, BAR_BLOCK);
  const label = opts?.label?.trim() || "socoding";
  if (!opts?.color) return `  ${spin} [${bar}] ${label}`;
  return `  ${GREEN}${spin}${RESET} ${GREEN}[${bar}]${RESET} ${DIM}${label}${RESET}`;
}

export function createLoadUi(opts?: LoadUiOptions): LoadUi {
  const tty = opts?.tty ?? Boolean(process.stdout.isTTY);
  const color = opts?.color ?? (tty && !process.env.NO_COLOR);
  const write = opts?.write ?? ((text: string) => process.stdout.write(text));
  const schedule = opts?.setInterval ?? setInterval;
  const unschedule = opts?.clearInterval ?? clearInterval;
  const label = opts?.label ?? "socoding";
  let timer: ReturnType<typeof setInterval> | undefined;
  let tick = 0;
  let shown = false;

  const paint = () => {
    if (!tty) return;
    write(`\r${ERASE_LINE}${formatLoadFrame(tick, { label, color })}`);
    shown = true;
  };

  const stop = () => {
    if (timer) {
      unschedule(timer);
      timer = undefined;
    }
    if (!shown) return;
    write(`\r${ERASE_LINE}${SHOW_CURSOR}`);
    shown = false;
    if (active === ui) active = undefined;
  };

  const start = () => {
    if (!tty) return;
    if (timer) return;
    active = ui;
    tick = 0;
    write(HIDE_CURSOR);
    paint();
    timer = schedule(() => {
      tick += 1;
      paint();
    }, LOAD_INTERVAL_MS);
  };

  const ui: LoadUi = { start, stop };
  return ui;
}

export function stopLoadUi() {
  active?.stop();
}

function pulseBar(tick: number, width: number, block: number) {
  const size = Math.max(1, width);
  const span = Math.min(size, Math.max(1, block));
  const max = size - span;
  if (max <= 0) return "█".repeat(size);
  const cycle = max * 2;
  const t = tick % cycle;
  const pos = t <= max ? t : cycle - t;
  return `${"░".repeat(pos)}${"█".repeat(span)}${"░".repeat(size - pos - span)}`;
}
