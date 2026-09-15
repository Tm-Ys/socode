export type SlashCommand = {
  name: string;
  hint: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/new", hint: "开新会话" },
  { name: "/session", hint: "列出并恢复对话" },
  { name: "/chat", hint: "列出并恢复对话" },
  { name: "/provider", hint: "查看当前 Provider" },
  { name: "/provider edit", hint: "编辑 Provider" },
  { name: "/provider list", hint: "列出已保存的 Provider" },
  { name: "/provider new", hint: "新增 Provider" },
  { name: "/context", hint: "查看上下文占用" },
  { name: "/compress", hint: "压缩对话上下文" },
  { name: "/mode", hint: "查看权限模式" },
  { name: "/mode full", hint: "Full Access，直接改文件" },
  { name: "/mode ask", hint: "Ask，改文件先审批" },
  { name: "/mode plan", hint: "Plan，只能看和写计划" },
  { name: "/mode long", hint: "Long / 长程，长任务+任务状态" },
  { name: "/mode 长程", hint: "Long 模式的中文别名" },
  { name: "/task", hint: "查看或更新长程任务状态" },
  { name: "/exit", hint: "退出" },
  { name: "/quit", hint: "退出" },
];

export function matchCommands(input: string) {
  if (!input.startsWith("/")) return [];
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(input));
}

export function longestCommonPrefix(values: string[]) {
  if (values.length === 0) return "";
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

export function ghostText(input: string, matches: SlashCommand[]) {
  if (matches.length === 0) return "";
  const prefix = longestCommonPrefix(matches.map((item) => item.name));
  return prefix.startsWith(input) ? prefix.slice(input.length) : "";
}

export function resolveCommand(input: string) {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return trimmed;
  const matches = matchCommands(trimmed);
  const exact = matches.find((item) => item.name === trimmed);
  if (exact) return exact.name;
  if (matches.length === 1) return matches[0].name;
  const prefix = longestCommonPrefix(matches.map((item) => item.name));
  if (prefix && SLASH_COMMANDS.some((item) => item.name === prefix)) return prefix;
  return trimmed;
}

export function completeCommand(input: string) {
  const matches = matchCommands(input);
  if (matches.length === 0) return input;
  if (matches.length === 1) return matches[0].name;
  const prefix = longestCommonPrefix(matches.map((item) => item.name));
  return prefix.length > input.length ? prefix : input;
}
