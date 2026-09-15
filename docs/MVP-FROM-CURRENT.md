# 从当前仓库到 Coding Agent Harness MVP

**盘点对象（默认分支 HEAD）：** `origin/main` = `5b1ddc3f2c38ed7c09da78ea2745849f42f79f54`  
**Commit message：** `mvp++`  
**Committer date：** `2026-09-15 14:43:35 +0800`  
**仓库：** `Tm-Ys/socode`（`package.json` `"name": "socode"`）

本次只读再盘点：`git fetch origin main` 后 `git rev-parse origin/main`、GitHub `defaultBranchRef`、以及 `git ls-tree -r origin/main` 三者一致。下文每条结论对应真实路径/符号；未找到的模块标为不存在，不虚构。

`README.md` 与源码注释均为中文，故本文用中文撰写，路径与符号保持英文原名。

---

## 相对 5b1ddc3 / 上次盘点的新增

**结论：默认分支 HEAD 没有离开 `5b1ddc3`。相对该 commit / 上次盘点（PR #2，`cursor/mvp-inventory-update-f87d`）没有新产品代码。**

核验：

| 检查 | 结果 |
| --- | --- |
| `git log --oneline 5b1ddc3..origin/main` | **空** |
| `git diff --stat 5b1ddc3 origin/main` | **空** |
| GitHub `repos/Tm-Ys/socode` `defaultBranchRef.name` | `main` |
| GitHub `main` SHA | `5b1ddc3f2c38ed7c09da78ea2745849f42f79f54` |
| `git ls-tree -r --name-only origin/main` 下 `src/` | 仍是下面 14 个 `.ts`，无新路径 |

### 新文件

**无。** 没有新增 `src/*.ts`、没有 `src/safety/`、`src/mcp/`、`src/compact*`、`test/`、`tests/`、`eval*`。`docs/MVP-FROM-CURRENT.md` 在 `main` 上也不存在（只出现在未合并的盘点 PR 分支上，不改变产品行为）。

### 新符号（export / 工具名 / CLI flag）

**无。** 相对 `5b1ddc3` 的 export 集合未变。当前仍只有：

- 工具名：`read` / `write` / `bash` / `search` / `calculate` / `get_current_time`（`src/tools.ts` 模块级 `tools` 数组）
- Agent：`runAgent`、`DEFAULT_MAX_AGENT_STEPS`、`AgentEvent`（`src/agent.ts`）
- 路径约束：`requireAbsolutePath` / `requireAbsoluteDir`（`src/fs-tools.ts`）——仍不是工作区 allowlist
- 中止：`TurnAborted` / `watchTurnAbort` / `isEscapeKey`
- Provider：`loadProvider` / `saveProvider` / `switchProvider` / `THINKING_EFFORTS`

没有 `usage` 解析、没有 doom-loop 检测、没有 `--root` / `--yes`、没有 audit、没有 MCP client。

### 上次点名的缺口，现在是否补上

| 上次缺口 | 当前 HEAD |
| --- | --- |
| 工作区 path allowlist | **仍缺。** `requireAbsolutePath` 只拒绝相对路径 |
| 危险 bash 审批 | **仍缺。** `runBash` 原样 `spawn("/bin/bash", ["-c", command])` |
| 失败轮写回（非 abort 的 LLM/步数错误） | **仍缺。** 交互模式 `printErr` 不 `saveMessages`；`--input` 直接 throw |
| doom-loop | **仍缺。** `runAgent` 无相同 tool+args 检测 |
| 摘要式 compaction | **仍缺。** `buildApiMessages` 只 `slice` / `shift` |
| `usage` / cost | **仍缺。** `ChatCompletion` 类型无 `usage` 字段 |
| 测试 | **仍缺。** `package.json` 无 `test` script；无 `*.test.ts` |

因此阶段评分与上次相同，不是「又进了一版」。若本地有未推送改动，它们不在当前默认分支 HEAD 上，本文件不计入。

---

## 源码文件清单（`src/` 全集）

`find src -type f`：**14** 个 `.ts`，合计 **2486** 行。无 `src/tools/` 目录（工具在单文件 `src/tools.ts`）。

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | CLI 入口：`.env`、参数、REPL、会话/Provider 命令、调用 `runAgent`、持久化 trace |
| `src/agent.ts` | Agent loop：`runAgent`、`AgentEvent`、步数上限、最后一步关掉 tools |
| `src/chat.ts` | `completeChat`：OpenAI 兼容 HTTP + SSE；tools / tool_calls / abort |
| `src/tools.ts` | 工具 schema 与 `executeTool` 分发（含表达式解析器 `calculate`） |
| `src/fs-tools.ts` | `readAbsoluteFile` / `writeAbsoluteFile` / `runBash` / `searchAbsoluteDir` |
| `src/context.ts` | 历史规范化、条数截断、字符估 token 预算、组装 API messages |
| `src/db.ts` | PostgreSQL 建库/迁移、会话 CRUD、带 payload 的多条 `saveMessages` |
| `src/system-prompt.ts` | `buildSystemPrompt`：工具策略 + 工作目录 + 可选 `AGENTS.md` |
| `src/provider.ts` | Provider 类型、本地 `providers.json`、写回 `.env` |
| `src/prompt.ts` | TTY raw 输入、退出确认、本轮 abort 监听、斜杠幽灵补全 |
| `src/commands.ts` | `SLASH_COMMANDS`：`/new` `/session` `/chat` `/provider*` `/exit` `/quit` |
| `src/title.ts` | 会话标题生成与列表展示 |
| `src/tool-ui.ts` | 工具调用行、结果预览（失败标红） |
| `src/abort.ts` | `TurnAborted` 与 abort 判断 |

根目录相关文件（非 `src/`，但影响行为）：`package.json`、`tsconfig.json`、`.env.example`、`providers.example.json`、`README.md`、`.gitignore`（忽略 `.env` 与 `providers.json`）。

---

## 1. 语言、包管理、入口

**语言：** TypeScript（`tsconfig.json`：`target` ES2022，`module`/`moduleResolution` NodeNext，`strict` true）。运行时靠 `tsx` 直接执行 `.ts`。

**包管理：** npm。运行时依赖只有 `pg@^8.16.3`。开发依赖 `@types/node`、`@types/pg`、`tsx`、`typescript`。没有 ink / blessed / commander / openai SDK / vitest。工具层用 `node:child_process` `spawn` 调 `/bin/bash` 和可选的 `rg`。

**入口：**

- `package.json` `"scripts.start"` / `"scripts.chat"` → `tsx src/index.ts`
- `main()` 在 `src/index.ts`（约 L312）

**仍是 CLI，不是独立 TUI/server：** README 写「TUI」，输入侧是 `src/prompt.ts` 的 raw-mode（TTY）或纯行读取；没有全屏 TUI 库、无 HTTP/WebSocket/MCP server。一次性 `--input` 与交互循环两种模式。

**参数 / 环境变量（`src/index.ts` `main` + `parseArgs` + `src/provider.ts`）：**

| 来源 | 键 | 用途 |
| --- | --- | --- |
| `providers.json` 优先于 env | `Provider` 整份 | README：已保存的 Provider **不再和环境变量字段混拼** |
| `.env` / `--url` | `BASE_URL` 或 `LLM_URL` | API 基址；`chatCompletionsUrl()` 补 `/chat/completions` |
| `.env` / `--api` | `api_key` 或 `LLM_API` | Bearer token |
| `.env` / `--model` | `MODEL` | 模型名 |
| `.env` / `--name` | `PROVIDER_NAME` | 选哪份已存 Provider |
| `.env` / `--context` | `CONTEXT_WINDOW` | 默认 128000 |
| `.env` / `--output` | `MAX_OUTPUT` | 写入请求 `max_tokens` |
| `.env` / `--effort` | `THINKING_EFFORT` | `none` 时不发 `reasoning_effort` |
| `.env` / `--database` | `DATABASE_URL` | 默认 `postgres://localhost:5432/socode` |
| `.env` / `--system` | `SYSTEM_PROMPT` | 附加到 `buildSystemPrompt` 的「额外用户说明」 |
| `.env` / `--max` | `MAX_CONTEXT_MESSAGES` | 默认 200 |
| `.env` / `--steps` | `MAX_AGENT_STEPS` | 默认 80（`DEFAULT_MAX_AGENT_STEPS`） |
| `--input` | 一次性用户消息 | |
| `--new` / `--id` | 新会话 / 指定 uuid | |
| `--no-stream` | 关闭流式 | |
| `--no-agent` | `useTools: false`，且不用 `buildSystemPrompt` | |

`BOOLEAN_FLAGS`（`src/index.ts` L33）仍包含 `"resume"`，`main()` **从未读取** `flags.resume`。未传 `--new` 时 `openConversation` 续最近会话。

---

## 2. 会话 / 消息模型与持久化

**类型**（`src/db.ts`）：`Role` = `"system" | "user" | "assistant" | "tool"`；`Message` 含 `toolCallId?` / `toolCalls?`；`Session` 含 `title`。

**PostgreSQL schema**（`migrate()`，`src/db.ts` L53）：

- `conversations`：`id UUID PK`，`model TEXT`，`title TEXT NOT NULL DEFAULT '新会话'`，`created_at`，`updated_at`
- `messages`：`role` CHECK `('system','user','assistant','tool')`，`content`，`seq`，`payload JSONB`（存 `tool_call_id` / `tool_calls`）

**会话选择：** `--id` → 否则非 `--new` 取 `latestConversationId` → 否则 `createConversation`。交互：`/new`、`/session` 或 `/chat`。成功一轮且默认标题时 `maybeNameSession` → `generateTitle`。

**写入：** `saveMessages` 事务内 `FOR UPDATE`，按数组插入任意条。中止路径 `saveAbortedTurn` 只插入 user。

**仍缺：**

- `SYSTEM_PROMPT` / `buildSystemPrompt` **从不入库**。表允许 `role='system'`，没有 INSERT；`normalizeHistory` 仍跳过 system。
- 非 abort 的 LLM 失败：交互模式只 `printErr`（`src/index.ts` L506），**不保存** 该轮 user；`--input` 失败则抛出 `process.exit(1)`。
- 步数耗尽：`runAgent` `throw new Error(\`超过最大工具步数 ${maxSteps}\`)`，已执行的 tool trace **不会**作为成功回复返回，调用方同样不落库。
- 无删除/重命名/导出会话命令。`conversations.model` 只在创建时写入；`/provider` 换模型不更新该列。

---

## 3. System prompt 组装

**位置：** `src/system-prompt.ts` `buildSystemPrompt(workspace, extra)`。

拼装顺序：`basePrompt(workspace)` → 若存在则 `# AGENTS.md`（`readAgentsMd`，上限 `AGENTS_MAX_BYTES = 16_384`）→ 若 `SYSTEM_PROMPT` / `--system` 非空则 `# 额外用户说明`。

`basePrompt` 写明工作目录、六个工具名、绝对路径要求（「本仓库请以 `${workspace}/` 为前缀」——这是文字约定，不是执行层 allowlist）、编辑约束、回复风格。

`--no-agent` 时 `ask()` 不走 `buildSystemPrompt`，只用用户 `SYSTEM_PROMPT` 字符串（可空）。

---

## 4. LLM 客户端

`src/chat.ts` `completeChat`：`fetch` + Bearer；默认流式。SSE 解析 `choices[0].delta.content` 与 `delta.tool_calls[index]`（`applySseLine`）。JSON 回退 `readJsonReply`。`ChatResult`：`content`、`toolCalls`、`finishReason`。

请求可带 `tools` + `tool_choice: "auto"`；`max_tokens`；`thinkingEffort !== "none"` 时发 `reasoning_effort`。

**无：** 超时（除 bash 的 30s）、重试/backoff、fallback 模型、温度、响应 `usage` 字段（`ChatCompletion` 类型里没有，也不读取）。

标题请求：`src/title.ts` `generateTitle` 再走一次非流式 `completeChat`，失败则用用户句截断。

---

## 5. Agent loop

**存在。** `src/agent.ts` `runAgent`：

1. `for (step = 0; step < maxSteps; step++)`
2. `completeChat`；最后一步 `allowTools = step < maxSteps - 1`，强制模型给文本
3. 无 `toolCalls` → 把 assistant 推进 `trace` 并 `return { reply, trace }`
4. 有则把 assistant（含 `toolCalls`）和每条 `role: "tool"` 推进 `messages` 与 `trace`
5. 用尽步数 → throw（**不会**把半截 trace 当成功回复返回）

| 能力 | 现状 |
| --- | --- |
| 多步 tool 循环 | **有** `runAgent` |
| continue / stop | 无 tool_calls 则停；最后一步停发 tools |
| 步数上限 | **有** `--steps` / `MAX_AGENT_STEPS` / `DEFAULT_MAX_AGENT_STEPS` |
| 重试 / backoff | **无**。`completeChat` 失败即抛；工具失败变成 tool 文本（`executeTool` catch）再让模型看 |
| doom-loop / 重复 tool 检测 | **无** |
| 中断 / cancel | **有** `watchTurnAbort`：TTY 下 Esc 或 Ctrl+C abort；bash 杀进程组（`killProcessTree`）；中止后存 user |
| 错误写回对话 | 工具错误写回 tool message；**LLM 抛错不入库**（abort 除外只存 user） |

---

## 6. Tools

**六个工具**，硬编码在 `src/tools.ts` 的 `tools: Tool[]`（不是插件目录）。`toolSpecs()` 去掉 `execute` 后交给 API；`executeTool(name, rawArgs, signal)` 做 JSON 解析与分发。内部 `Tool` 类型未 export。未知工具名返回字符串 `未知工具: ${name}`，不抛。

| name | 实现 | 要点 |
| --- | --- | --- |
| `read` | `readAbsoluteFile` | 绝对路径；可选 offset/limit 行；拒绝含 `\0` 的二进制；行号前缀；`MAX_READ_BYTES = 200_000` 用于 search walk，read 本身先整文件读入再 clip |
| `write` | `writeAbsoluteFile` | 绝对路径；`mkdir` 父目录；**整文件覆盖**，无 patch |
| `bash` | `runBash` | `cwd` 必须是已存在的绝对目录；`/bin/bash -c`；30s 超时；可 abort |
| `search` | `searchAbsoluteDir` | 先 `rg`，失败则 walk；`MAX_SEARCH_HITS = 80`；跳过 `.git`/`node_modules` 等 |
| `calculate` | 手写递归下降 | 只允许数字和 `+ - * / ( )`，长度 ≤ 80 |
| `get_current_time` | `toLocaleString` | 默认 `Asia/Shanghai` |

**路径策略（还不是 Phase 2 allowlist）：** `requireAbsolutePath` **拒绝相对路径**，但 **不限制在 `process.cwd()` 内**。模型拿到绝对路径后可以读/写/在任意目录 bash（权限等于 OS 用户）。system prompt 只是文字要求「本仓库请以 `${workspace}/` 为前缀」。

无 git 专用工具、无 MCP、无 web fetch 工具。`clip()` → `MAX_OUTPUT_CHARS = 32_000`。

---

## 7. Context compaction / truncation

比「只 slice(-max)」多一层 **字符估 token 预算**，仍然 **不是摘要式 compaction**。

`buildApiMessages()`（`src/context.ts`）：

1. `normalizeHistory`：跳过 system；保留 tool；相邻 **user** 才合并；去掉空文本且无 toolCalls 的消息；去掉开头的 assistant/tool
2. 超 `maxMessages` 则 `slice(-max)`，再丢掉直到开头是 user
3. 若最后一条已是 user，丢掉（避免与本轮 user 重复）
4. `budget = max(512, contextWindow - maxOutput - 256)`；`estimateTokens`：ASCII/4 + 非 ASCII 按 1；超预算从头部 `shift` 直到下一条是 user
5. `[optional system] + history + current user`

**没有：** tokenizer、摘要模型、滑动窗口之外的记忆槽、prompt cache breakpoint。超长单条 user content 不会被切。丢掉旧消息时 **不插入**「更早 N 条已省略」槽位（CLI 预览 `previewMessages` 会打印 `... 更早 ${skipped} 条`，那只给终端看，不进 API messages）。

---

## 8. Permissions / sandbox / approval

**无 Phase 2 意义上的安全层。** 没有 path allowlist（相对 `WORKSPACE`）、没有危险命令询问、没有 audit log、没有 bubblewrap/docker/seatbelt。

已有的弱约束：相对路径拒绝；读二进制拒绝；bash 30s 超时 + abort 时 `process.kill(-pid, SIGKILL)`；search 跳过若干目录名。

`write` / `bash` 在绝对路径前提下没有二次确认。`--yes` / `--root` **不存在**。

---

## 9. Cost / usage / cache 仪表

**无。** `ChatCompletion` 类型仍无 `usage`；`completeChat` 不累计 token。表无 usage 列。无价格表、无 cache hit/miss。无 cache 头、无显式 breakpoint。system 每轮从磁盘/`AGENTS.md` 重拼。

---

## 10. Tests / evals

**仍无测试、无 eval。**

- `package.json` 没有 `test` / `lint` / `eval` script
- 无 `*.test.ts`、无 vitest/jest/`node:test`
- 无黄金对话、无 tool 契约测试、无 prompt 回归

手工验证方式：README 的 `npm start` / `npm start -- --input "..."`。本次盘点 **没有** 对 LLM 或工具做运行时验收（只读代码 + git 核验 HEAD）。

---

## 11. 与 harness 完整度相关的 TODO / FIXME

全仓库 **没有** `TODO` / `FIXME` / `XXX` / `HACK` / `WIP`（`src/index.ts` 的 `usage()` 是 CLI 帮助函数，不是待办）。

可从代码读出的半截能力：

1. `BOOLEAN_FLAGS` 含 `"resume"` 但未使用（`src/index.ts` L33 vs `main()`）
2. DB 允许 `system` 行，但从不写入；`normalizeHistory` 丢弃 system
3. 步数耗尽抛错，调用方若非 abort 则整轮（含已执行的 tool）不落库
4. README 写「TUI」，实现是 raw-mode CLI
5. 工具不绑定工作区根目录

---

## 阶段对照

判定标准：DONE = 有可运行的核心路径；PARTIAL = 有相关代码但缺关键语义或明显半截；MISSING = 仓库中无对应模块。

### Phase 0 Minimal MVP

目标：session + prompt + llm + agent loop + read/write/bash/search + basic CLI

| 块 | 状态 | 依据 |
| --- | --- | --- |
| session | **DONE** | `src/db.ts` `openConversation` / `saveMessages` / `listConversations`；`--new` `--id` `/new` `/session` |
| prompt | **DONE** | `src/system-prompt.ts` `buildSystemPrompt`；工具策略 + 工作目录 + 可选 `AGENTS.md` |
| llm | **DONE** | `completeChat`：OpenAI 兼容 + SSE + `tools` + `tool_calls` |
| agent loop | **DONE** | `src/agent.ts` `runAgent`；`src/index.ts` `ask()` 走 loop |
| read/write/bash/search | **DONE** | `src/tools.ts` + `src/fs-tools.ts` 同名工具 |
| basic CLI | **DONE** | readline/raw-mode、`--input`、流式与工具行、`/provider` |

**总体：DONE。** 这是「能调工具改文件」的最小 agent，不是「安全/可评测/可压缩」的完整 harness。

### Phase 1 Survive multi-turn

目标：step limits、doom-loop、tool truncation、compaction、cancel、error writeback

| 块 | 状态 | 依据 |
| --- | --- | --- |
| 多轮聊天历史 | **DONE** | PG + 条数截断 + token 预算 |
| step limits | **DONE** | `runAgent` `maxSteps`；最后一步 `tools: undefined` |
| doom-loop | **MISSING** | 无连续相同 tool+args 检测 |
| tool truncation | **DONE** | `MAX_OUTPUT_CHARS = 32_000` + search hit 上限 80 |
| compaction（摘要式） | **MISSING** | 只有丢掉旧消息；无摘要槽 |
| cancel | **DONE** | `AbortController` + Esc；bash/search 可杀 |
| error writeback | **PARTIAL** | 工具失败进 tool content；LLM 失败不入库；abort 只存 user |

**总体：PARTIAL。**

### Phase 2 Safety

目标：path allowlist、dangerous-command ask、audit log、optional sandbox

| 块 | 状态 | 依据 |
| --- | --- | --- |
| 绝对路径 | 弱约束 | `requireAbsolutePath`；**不是** cwd allowlist |
| dangerous-command ask | **MISSING** | `runBash` 原样执行 |
| audit log | **MISSING** | 无 `.socode/audit.log` 或等价模块 |
| sandbox | **MISSING** | 无 bubblewrap/docker/seatbelt |

**总体：MISSING。** 不要把「必须绝对路径」当成工作区沙箱。

### Phase 3 UX / cost

目标：更好的流式 UI、prompt-cache 友好组装、usage/cost、project memory file、model routing

| 块 | 状态 | 依据 |
| --- | --- | --- |
| 流式 + 工具 UI | **PARTIAL** | SSE 文本；`tool-ui.ts` 着色；斜杠幽灵补全；仍非全屏 TUI |
| prompt-cache 友好组装 | **MISSING** | 无 cache 标记；system 每轮重拼 |
| usage/cost | **MISSING** | 不读 `usage` |
| project memory file | **PARTIAL** | 只读根目录 `AGENTS.md`，无 `MEMORY.md`、不写回 |
| model routing | **PARTIAL** | `/provider` 人工切换多份配置；无自动路由 |

**总体：PARTIAL。**

### Phase 4 Extensibility

目标：MCP、plugins/hooks、subagents、plan mode、eval suite

**总体：MISSING。** `--no-agent` 只是关掉 tools，不是 plan/ask 模式。无 MCP client/server、无 hook、无子 agent、无 eval。

---

## 总览表

| Phase | 状态 | 一句话 |
| --- | --- | --- |
| 0 Minimal MVP | **DONE** | 会话 + 系统提示 + LLM tool calling + `runAgent` + 四件套 + CLI 均在 |
| 1 Survive multi-turn | **PARTIAL** | 有步数、取消、tool 截断、token 丢弃；无 doom-loop、无摘要、失败轮不落库 |
| 2 Safety | **MISSING** | 无工作区 allowlist / 审批 / 审计 / 沙箱 |
| 3 UX/cost | **PARTIAL** | 工具轨迹 UI、AGENTS.md、手动切 Provider；无 usage/cache |
| 4 Extensibility | **MISSING** | 无 MCP / plugin / subagent / plan / eval |

相对上次盘点（同样针对 `5b1ddc3`）**评分不变**。

---

## 接下来 4 个具体里程碑

按 **当前缺口** 排序。`5b1ddc3` 已经做完 loop + 四件套，不应再当作下一步。**仅为建议触碰文件；本 PR 不实现代码。**

### M1 — 工作区 allowlist（Phase 2 最小集的一半）

四件套目前接受任意绝对路径。这是现在最大的行为风险。

建议文件：

- 新建 `src/safety/paths.ts`：解析后的路径必须落在 `WORKSPACE`（或 `--root`）之内，拒绝 `..` 逃逸与指向仓库外的绝对路径
- 改 `src/fs-tools.ts`：`read`/`write`/`bash cwd`/`search directory` 执行前调用
- 改 `src/index.ts`：`--root`；banner 已打印 `工作目录: ${WORKSPACE}`，与强制根对齐

验收：对 `/etc/passwd` 或仓库外路径的 `read`/`write` 返回明确错误，且不触盘。

### M2 — 危险 bash 询问 + 审计日志（Phase 2 另一半）

建议文件：

- 新建 `src/safety/bash.ts`：匹配 `rm -rf`、`mkfs`、`dd`、`sudo`、`git reset --hard`、force push 等则在 TTY 询问 y/n（`--yes` 跳过，非 TTY/`--input` 默认拒绝）
- 新建 `src/safety/audit.ts`：tool 名、参数摘要、allow/deny、时间追加到项目 `.socode/audit.log` 或 `~/.socode/audit.log`
- 改 `src/tools.ts` `execute` 前走检查；改 `src/index.ts`：`--yes`

验收：交互里对 `rm -rf /tmp/demo` 会停下来问；`--input` 默认拒绝并留下审计行。

### M3 — 失败写回 + doom-loop（补齐 Phase 1）

建议文件：

- 改 `src/agent.ts`：连续相同 `name+arguments`（例如 3 次）强制停，并带一条可见 assistant/tool 说明；步数耗尽时 **返回** 已有 `trace` + 错误文本，而不是只 throw 导致整轮丢失
- 改 `src/index.ts`：`completeChat`/loop 抛错时仍 `saveMessages` 写入 user，以及一条错误 assistant（与 abort 路径对称）
- `--input` 与交互共用同一写回

验收：断网或无效 URL 后，`/session` 再打开能看到该 user 和错误句；故意让模型重复同一 `read` 三次会停。

### M4 — 摘要槽位 + usage 读取 + 最少测试（Phase 1 尾巴 + Phase 3 最小观测）

建议文件：

- 改 `src/context.ts`：丢掉旧消息时插入一条固定说明「更早 N 条已省略」（可先规则拼接，不必立刻再调模型）
- 改 `src/chat.ts` `ChatCompletion`：解析 `usage`；`src/index.ts` 可选打印本轮 prompt/completion
- 新建最少 `src/*.test.ts`（哪怕只用 `node:test`）覆盖 `requireAbsolutePath`、`calculate`、`normalizeHistory`、tool JSON 失败路径——当前 **零测试** 是回归最大洞

验收：超长历史请求里 system 仍在最前且出现省略说明；一次成功补全能打印 usage；`npm test` 无需 API key 即可跑通。

**暂缓：** MCP、plugins、subagents、plan mode、eval suite、sandbox 容器、自动 model routing、把 raw-mode CLI 做成真正 TUI。等 M1–M2 把「任意绝对路径 bash」收住之后再做 Phase 4。

---

## 诚实的能力边界

当前 `socode` 在 `5b1ddc3`（`mvp++`）已经越过「纯聊天 REPL」：`src/agent.ts` + `src/tools.ts` + `src/fs-tools.ts` 构成可运行的 Phase 0 coding agent。

**本次再盘点没有发现更新的默认分支 commit。** 不要根据「用户感觉有新改动」假设存在 `src/safety/*` 或 usage/doom-loop 模块——它们不在 `origin/main` 树上。

不要把它当成 Phase 2 已完成——**工具没有工作区根，bash 没有审批**。也不要当成已验证产品：仓库里仍然 **零测试**，本文件只盘点源码与 git，不证明 `--input "读 README"` 在真实 Provider 上能跑通。

下一步的正确增量仍是 **M1+M2（安全边界）和 M3（失败可恢复）**，而不是先做 MCP 或全屏 TUI。
