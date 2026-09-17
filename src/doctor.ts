import { access, mkdir, unlink, writeFile, constants as fsConstants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionsDir } from "./db.js";
import type { AgentMode } from "./mode.js";
import { modeLabel } from "./mode.js";
import { providerReady, userSocodeDir, type Provider } from "./provider.js";
import { sandboxToolStatus } from "./sandbox.js";

const MIN_NODE = 22;

export type DoctorCheck = {
  name: string;
  ok: boolean;
  info?: boolean;
  detail: string;
  hint?: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

export async function runDoctor(opts: {
  workspace: string;
  mode: AgentMode;
  provider: Provider;
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    nodeCheck(),
    providerCheck(opts.provider),
    sandboxCheck(),
    await writableCheck("用户目录", userSocodeDir(), "无法写入 ~/.socode。检查目录权限，或设 SOCODE_HOME。"),
    await writableCheck("会话目录", sessionsDir(opts.workspace), "无法写入工作区 .socode/sessions。检查目录权限。"),
    {
      name: "工作区",
      ok: true,
      info: true,
      detail: `${opts.workspace}  ·  ${modeLabel(opts.mode)}`,
    },
  ];
  return { ok: checks.every((item) => item.ok || item.info), checks };
}

export function formatDoctor(report: DoctorReport) {
  const lines = ["socode doctor", ""];
  for (const item of report.checks) {
    const mark = item.info ? "信息" : item.ok ? "通过" : "失败";
    lines.push(`  ${mark}  ${item.name.padEnd(8)}  ${item.detail}`);
    if (!item.ok && item.hint) lines.push(`        修复          ${item.hint}`);
  }
  lines.push("");
  lines.push(report.ok ? "全部通过。" : "有失败项。按上面的修复建议处理后重跑 /doctor 或 --doctor。");
  return lines.join("\n");
}

function nodeCheck(): DoctorCheck {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  const ok = Number.isFinite(major) && major >= MIN_NODE;
  return {
    name: "Node",
    ok,
    detail: `v${version}（需要 ${MIN_NODE}+）`,
    hint: ok ? undefined : `请安装 Node ${MIN_NODE} 或更高版本。`,
  };
}

function providerCheck(provider: Provider): DoctorCheck {
  if (providerReady(provider)) {
    return {
      name: "Provider",
      ok: true,
      detail: `${provider.name || "default"} 已配置（密钥已保存，不打印）`,
    };
  }
  return {
    name: "Provider",
    ok: false,
    detail: "缺少 API URL、密钥或模型",
    hint: "交互启动会进入向导，或用 --url / --api / --model。密钥写在 ~/.socode/providers.json。",
  };
}

function sandboxCheck(): DoctorCheck {
  const status = sandboxToolStatus();
  return {
    name: "沙箱",
    ok: status.ok,
    detail: status.detail,
    hint: status.hint,
  };
}

async function writableCheck(name: string, dir: string, hint: string): Promise<DoctorCheck> {
  const probe = join(dir, `.doctor-${process.pid}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(probe, "ok");
    await access(dir, fsConstants.W_OK);
    await unlink(probe);
    return { name, ok: true, detail: `${displayHome(dir)} 可写` };
  } catch (error) {
    await unlink(probe).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: `${displayHome(dir)} 不可写（${message}）`, hint };
  }
}

function displayHome(path: string) {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}
