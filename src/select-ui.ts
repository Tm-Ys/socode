import { stdin, stdout } from "node:process";
import { confirmQuit, withPermissionLock } from "./prompt.js";
import { displayRows, rewindLive, useColor } from "./markdown.js";
import {
  applyEffortKey,
  applyModelPickKey,
  applyProviderListKey,
  currentModelPick,
  type ModelPickState,
} from "./provider-api.js";
import type { Provider, ThinkingEffort } from "./provider.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

export async function pickEffort(params: {
  efforts: ThinkingEffort[];
  selected: number;
  hint?: string;
}): Promise<ThinkingEffort | undefined> {
  if (!params.efforts.length) return undefined;
  let selected = Math.max(0, Math.min(params.selected, params.efforts.length - 1));
  const ok = await runSelectLoop({
    render: (color) => formatEffortFrame(params.efforts, selected, params.hint, color),
    onKey: (key) => {
      const result = applyEffortKey(selected, params.efforts.length, key);
      if (result.type === "cancel") return "cancel";
      if (result.type === "submit") return "submit";
      selected = result.index;
      return "redraw";
    },
  });
  return ok ? params.efforts[selected] : undefined;
}

export async function pickProviderModel(state: ModelPickState): Promise<{ providerName: string; model: string } | undefined> {
  let current = state;
  const ok = await runSelectLoop({
    render: (color) => formatModelFrame(current, color),
    onKey: (key) => {
      const result = applyModelPickKey(current, key);
      if (result.type === "cancel") return "cancel";
      if (result.type === "submit") return "submit";
      current = result.state;
      return "redraw";
    },
  });
  if (!ok) return undefined;
  const picked = currentModelPick(current);
  if (!picked.provider) return undefined;
  return { providerName: picked.provider.name, model: picked.model };
}

export async function pickSavedProvider(params: {
  providers: Provider[];
  selected: number;
  activeName?: string;
}): Promise<{ action: "switch" | "edit" | "new"; index: number } | undefined> {
  let selected = params.providers.length
    ? Math.max(0, Math.min(params.selected, params.providers.length - 1))
    : 0;
  let action: "switch" | "edit" | "new" = "switch";
  const ok = await runSelectLoop({
    render: (color) => formatProviderListFrame(params.providers, selected, params.activeName, color),
    onKey: (key) => {
      const result = applyProviderListKey(selected, params.providers.length, key);
      if (result.type === "cancel") return "cancel";
      if (result.type === "new") {
        action = "new";
        return "submit";
      }
      if (result.type === "switch" || result.type === "edit") {
        if (!params.providers.length) return "redraw";
        action = result.type;
        return "submit";
      }
      selected = result.index;
      return "redraw";
    },
  });
  if (!ok) return undefined;
  return { action, index: selected };
}

export function formatEffortFrame(efforts: ThinkingEffort[], selected: number, hint = "", color = false) {
  const yellow = color ? YELLOW : "";
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const cyan = color ? CYAN : "";
  const reset = color ? RESET : "";
  const items = efforts.map((effort, index) =>
    index === selected ? `${bold}${cyan}[${effort}]${reset}` : `${dim}${effort}${reset}`,
  );
  const lines = [
    `${yellow}? 思考强度${reset}${hint ? `  ${dim}${hint}${reset}` : ""}`,
    "",
    `  ${items.join("  ")}`,
    "",
    `  ${dim}←→ / ↑↓ 调整   enter 确认   esc 取消${reset}`,
  ];
  return lines.join("\n");
}

export function formatModelFrame(state: ModelPickState, color = false) {
  const yellow = color ? YELLOW : "";
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const cyan = color ? CYAN : "";
  const reset = color ? RESET : "";
  const picked = currentModelPick(state);
  const providerNames = state.providers.map((item, index) =>
    index === state.providerIndex ? `${bold}${cyan}[${item.name}]${reset}` : `${dim}${item.name}${reset}`,
  );
  const modelNames = picked.models.map((item, index) =>
    index === state.modelIndex ? `${bold}${cyan}[${item}]${reset}` : `${dim}${item}${reset}`,
  );
  const none = `${dim}（无）${reset}`;
  const lines = [
    `${yellow}? 模型${reset}  ${dim}仅已保存的 Provider / 模型${reset}`,
    "",
    `  Provider  ${providerNames.join("  ") || none}`,
    `  Model     ${modelNames.join("  ") || none}`,
    "",
    `  ${dim}←→ 切换提供商   ↑↓ 切换模型   enter 确认   esc 取消${reset}`,
  ];
  return lines.join("\n");
}

export function formatProviderListFrame(
  providers: Provider[],
  selected: number,
  activeName = "",
  color = false,
) {
  const yellow = color ? YELLOW : "";
  const bold = color ? BOLD : "";
  const dim = color ? DIM : "";
  const cyan = color ? CYAN : "";
  const reset = color ? RESET : "";
  const lines = [
    `${yellow}? Provider${reset}  ${dim}已保存的适配${reset}`,
    "",
  ];
  if (!providers.length) {
    lines.push(`  ${dim}（还没有保存的 Provider）${reset}`);
  } else {
    const nameWidth = Math.max(...providers.map((item) => item.name.length), 8);
    for (const [index, item] of providers.entries()) {
      const arrow = index === selected ? ">" : " ";
      const current = item.name === activeName ? "*" : " ";
      const label = `${arrow}${current} ${item.name.padEnd(nameWidth)}  ${item.model}`;
      lines.push(index === selected ? `  ${bold}${cyan}${label}${reset}` : `  ${dim}${label}${reset}`);
    }
  }
  lines.push("");
  lines.push(`  ${dim}↑↓ 选择   enter 切换   e 编辑   n 新增   esc 取消${reset}`);
  return lines.join("\n");
}

async function runSelectLoop(params: {
  render: (color: boolean) => string;
  onKey: (key: string) => "redraw" | "submit" | "cancel";
}): Promise<boolean> {
  if (process.env.NODE_TEST_CONTEXT) return false;
  return await withPermissionLock(async () => {
    if (!stdin.isTTY || !stdout.isTTY) return false;
    const color = useColor();
    let rows = 0;
    stdout.write(`\n${HIDE_CURSOR}`);
    const paint = () => {
      const frame = params.render(color);
      rewindLive((text) => stdout.write(text), rows);
      stdout.write(frame);
      rows = displayRows(frame, stdout.columns ?? 80);
    };
    return await new Promise<boolean>((resolve) => {
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      paint();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        stdin.off("data", onData);
        rewindLive((text) => stdout.write(text), rows);
        stdout.write(SHOW_CURSOR);
        if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
        resolve(ok);
      };
      const onData = (chunk: Buffer | string) => {
        const key = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (key === "\x03") {
          if (confirmQuit()) {
            finish(false);
            return;
          }
          paint();
          return;
        }
        const next = params.onKey(key);
        if (next === "submit") {
          finish(true);
          return;
        }
        if (next === "cancel") {
          finish(false);
          return;
        }
        paint();
      };
      stdin.on("data", onData);
    });
  });
}
