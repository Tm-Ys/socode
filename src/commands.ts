import { matchSshHosts, parseSshDestination } from "./ssh-history.js";

export type SlashCommand = {
  name: string;
  hint: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/new", hint: "开新会话" },
  { name: "/session", hint: "列出并恢复对话" },
  { name: "/chat", hint: "列出并恢复对话" },
  { name: "/provider", hint: "列出并切换 Provider" },
  { name: "/provider show", hint: "查看当前 Provider" },
  { name: "/provider edit", hint: "编辑当前或指定 Provider" },
  { name: "/provider list", hint: "列出已保存的 Provider" },
  { name: "/provider new", hint: "按字段新增 Provider" },
  { name: "/model", hint: "在已保存的 Provider / 模型之间切换" },
  { name: "/effort", hint: "从 API 读取并用方向键调整思考强度" },
  { name: "/context", hint: "查看上下文占用" },
  { name: "/usage", hint: "本轮与本会话 token / 缓存 / 价格" },
  { name: "/compress", hint: "压缩对话上下文" },
  { name: "/mode", hint: "查看权限模式" },
  { name: "/mode full", hint: "Full Access，直接改文件" },
  { name: "/mode ask", hint: "Ask，改文件先审批" },
  { name: "/mode plan", hint: "Plan，只能看和写计划" },
  { name: "/mode long", hint: "Long / 长程，长任务 + LLM 审批副作用" },
  { name: "/mode 长程", hint: "Long 模式的中文别名" },
  { name: "/task", hint: "查看或更新长程任务状态" },
  { name: "/mcp", hint: "查看 MCP 服务器和工具" },
  { name: "/skills", hint: "查看已加载的说明文件和 Skills" },
  { name: "/seesubagent", hint: "查看子代理过程（默认隐藏）" },
  { name: "/seeplan", hint: "查看当前任务计划勾选进度" },
  { name: "/setplan", hint: "强制本轮按说明建 Plan，并激活 grill-me" },
  { name: "/setworkarea", hint: "空对话时设置工作区（选文件夹或绝对路径）" },
  { name: "/remote-ssh", hint: "Remote-SSH：本机显示器 + 远端 worker" },
  { name: "/ssh", hint: "Tab 到 /remote-ssh" },
  { name: "/sshquit", hint: "清掉远端 Provider，断开 SSH，回到本机新对话" },
  { name: "/undo", hint: "撤回最近一轮 write/edit/delete（落盘，不管 bash，不是 rewind）" },
  { name: "/doctor", hint: "检查 Node、密钥、沙箱、目录是否可写" },
  { name: "/exit", hint: "退出" },
  { name: "/quit", hint: "退出" },
];

export function matchCommands(input: string) {
  if (!input.startsWith("/")) return [];
  return [...SLASH_COMMANDS, ...sshHistoryCommands()].filter((command) => command.name.startsWith(input));
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
  if (input === "/ssh" || input === "/ssh ") return "/remote-ssh";
  if (isSshAlias(input)) {
    const mapped = mapSshAliasToRemote(input);
    return completeRemoteSsh(mapped) ?? mapped;
  }
  const ssh = completeRemoteSsh(input);
  if (ssh) return ssh;
  const matches = matchCommands(input);
  if (matches.length === 0) return input;
  if (matches.length === 1) return matches[0].name;
  const prefix = longestCommonPrefix(matches.map((item) => item.name));
  return prefix.length > input.length ? prefix : input;
}

function isSshAlias(input: string) {
  return input === "/ssh" || (input.startsWith("/ssh ") && !input.startsWith("/sshquit"));
}

function mapSshAliasToRemote(input: string) {
  if (input === "/ssh" || input === "/ssh ") return "/remote-ssh";
  return `/remote-ssh ${input.slice("/ssh ".length)}`;
}

function sshHistoryCommands(): SlashCommand[] {
  return matchSshHosts("").map((item) => ({
    name: `/remote-ssh ${item.user}@${item.host}`,
    hint: item.lastWorkspace ? `上次 ${item.lastWorkspace}` : item.auth === "key" ? "密钥登录" : "需重新输入密码",
  }));
}

let sshCycleKey = "";
let sshCycleIndex = -1;

function completeRemoteSsh(input: string) {
  if (input !== "/remote-ssh" && !input.startsWith("/remote-ssh ")) return null;
  const names = sshHistoryCommands().map((item) => item.name);
  if (!names.length) return null;
  if (input === "/remote-ssh" || input === "/remote-ssh ") {
    if (sshCycleKey !== "/remote-ssh") {
      sshCycleKey = "/remote-ssh";
      sshCycleIndex = 0;
    } else {
      sshCycleIndex = (sshCycleIndex + 1) % names.length;
    }
    return names[sshCycleIndex] ?? input;
  }
  const exact = names.indexOf(input);
  if (exact >= 0 && names.length > 1) {
    sshCycleKey = "/remote-ssh";
    sshCycleIndex = (exact + 1) % names.length;
    return names[sshCycleIndex] ?? input;
  }
  const rest = input.slice("/remote-ssh".length).trim();
  const matches = matchSshHosts(rest).map((item) => `/remote-ssh ${item.user}@${item.host}`);
  if (!matches.length) return null;
  if (matches.length === 1) return matches[0];
  const prefix = longestCommonPrefix(matches);
  return prefix.length > input.length ? prefix : matches[0];
}

const REMOTE_SSH_NAMES = ["/remote-ssh", "/ssh"] as const;

export function parseRemoteSshCommand(input: string) {
  const trimmed = input.trim();
  for (const name of REMOTE_SSH_NAMES) {
    if (trimmed === name) return { ok: true as const, target: "" };
    if (!trimmed.startsWith(`${name} `)) continue;
    const rest = trimmed.slice(name.length + 1).trim();
    if (!rest) return { ok: true as const, target: "" };
    const parsed = parseSshDestination(rest);
    if (!parsed?.host) return { ok: false as const, error: `用法: ${name} 或 ${name} user@host` };
    return { ok: true as const, target: rest };
  }
  return null;
}
