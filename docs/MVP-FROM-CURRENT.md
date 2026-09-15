# 从当前仓库到 Coding Agent Harness MVP

**盘点对象（默认分支 HEAD）：** `origin/main` = `6c2d9025572376dfb261e9809c522955569a13cd`  
**Commit message：** `fix sm bug`  
**Committer date：** `2026-09-15 15:31:34 +0800`（GitHub `commit.committer.date` = `2026-09-15T07:31:34Z`）  
**作者：** Tm-Ys `<hanchenxu25@mails.ucas.ac.cn>`  
**仓库：** `Tm-Ys/socode`（`package.json` `"name": "socode"`）  
**对照基线：** `5b1ddc3f2c38ed7c09da78ea2745849f42f79f54`（`mvp++`）

核验：`git fetch origin main` 后 `git rev-parse origin/main`、GitHub `defaultBranchRef.name=main`、`GET /repos/Tm-Ys/socode/commits/main` 的 `sha` 三者均为 `6c2d902`。`git log --oneline 5b1ddc3..origin/main` 只有这一条新 commit。下文每条结论对应真实路径/符号；未找到的模块标为不存在，不虚构。

`README.md` 与源码注释均为中文，故本文用中文撰写，路径与符号保持英文原名。本次 **只更新本文档，不实现产品功能**。

---

## 相对 5b1ddc3 的新增

**结论：默认分支 HEAD 已离开 `5b1ddc3`。** 相对基线有 **1** 个 commit、**16** 个文件、`+1111 / -62`。`src/` 从 14 个 `.ts` / 2486 行变为 **18** 个 `.ts` / **3520** 行。

### 新文件

| 路径 | 职责 |
| --- | --- |
| `src/mode.ts` | `AgentMode`：`full` / `ask` / `plan`；`loadMode` / `parseMode`；`【harness mode】` 系统消息 |
| `src/permissions.ts` | `createPolicy`：按模式审批 `write` / `delete` / 有副作用的 `bash` |
| `src/sandbox.ts` | 路径 denylist、`isInsideWorkspace`、`classifyBash`、macOS `sandbox-exec` |
| `src/compress.ts` | `/compress`：LLM 摘要较早对话，保留最近两轮 user |

根目录非 `src/` 改动：`.env.example` 增加 `MODE="ask"`；`README.md` 增加权限/沙箱、`/context`、`/compress`、`/mode` 说明。`package.json` **未改**（仍无 `test` script）。`src/abort.ts`、`src/chat.ts`、`src/provider.ts`、`src/title.ts` **相对 5b1ddc3 零 diff**。

### 新符号（export / 工具名 / CLI）

**工具名：** 在原有 `read` / `write` / `bash` / `search` / `calculate` / `get_current_time` 上新增 **`delete`**（`src/tools.ts`）。Plan 模式 `toolSpecs("plan")` 只暴露 `READ_TOOLS` = `read` / `search` / `calculate` / `get_current_time`。

**模式：** `AGENT_MODES`、`AgentMode`、`HARNESS_MODE_PREFIX`、`harnessModeMessage`、`insertCurrentMode`、`lastHarnessMode`、`loadMode`（默认 `process.env.MODE`，否则 `"ask"`）。

**权限：** `Policy`、`createPolicy`、`askPermission`（`src/prompt.ts`，返回 `"allow" | "deny" | "always"`）、`watchTurnAbort().pause` / `.resume`（审批时暂停 Esc 误杀）。

**沙箱 / 路径：** `resolvePath`、`isInsideWorkspace`、`denyReason`、`classifyBash`、`bashSpawn`、`shouldFallbackSandbox`、`FileOp`。`requireAbsolutePath`（`src/fs-tools.ts`）现在会调用 `denyReason`，拒绝 `/etc`、`/usr`、`~/.ssh` 等，**仍不是**「必须落在 `WORKSPACE` 内」。

**压缩 / 上下文 UI：** `compressHistory`、`canCompress`、`splitForCompress`、`COMPRESSED_PREFIX`（`【会话摘要】`）、`measureContext`、`formatContextReport`、`replaceMessages`（`src/db.ts`，整表替换会话消息）。

**CLI / 斜杠：** `--mode` / `MODE`；`SLASH_COMMANDS` 新增 `/context`、`/compress`、`/mode`、`/mode full|ask|plan`。没有 `--root`、没有 `--yes`。`BOOLEAN_FLAGS` 仍含未使用的 `"resume"`。

### 上次点名的缺口，现在是否补上

| 上次缺口（相对 `5b1ddc3`） | 当前 HEAD `6c2d902` |
| --- | --- |
| 工作区 path allowlist | **仍缺强制 allowlist。** 有 `isInsideWorkspace`，但只用来给 Ask 审批分「区内/区外」grant key（`op:in` / `op:out`），**不拒绝**工作区外路径。硬拦截只有 `denyReason` 系统目录/密钥 denylist。 |
| 危险 bash 审批 | **已有（Ask 默认）。** `classifyBash` 把只读命令放行，其余走 `askPermission`（`y`/`n`/`a`）。非 TTY（`--input`）Ask 下 `askPermission` 直接 `"deny"`。`full` 模式跳过询问。没有单独的 `rm -rf` 黑名单文件，也没有 `--yes`。 |
| 失败轮写回（非 abort 的 LLM/步数错误） | **仍缺。** 交互模式 `printErr` 不 `saveMessages`；`--input` 直接 throw。`runAgent` 步数耗尽仍 `throw`。 |
| doom-loop | **仍缺。** `runAgent` 无相同 tool+args 检测。 |
| 摘要式 compaction | **手动有、自动无。** `/compress` → `compressHistory` 调模型写 `【会话摘要】` 并 `replaceMessages`。超预算路径仍是 `fitHistory` 头部 `shift`，不插摘要槽。 |
| `usage` / cost | **仍缺 API usage。** `ChatCompletion` 类型仍无 `usage` 字段。`/context` 是本地 `estimateTokens`（ASCII/4）色块，不是账单。 |
| 测试 | **仍缺。** `package.json` 无 `test`；无 `*.test.ts`。 |

额外出现、上次未点名的能力：Plan 模式、`delete` 工具、macOS `sandbox-exec`（Linux 无等价物；sandbox 失败会 fallback 到裸 `/bin/bash`）。

---

## 源码文件清单（`src/` 全集）

`find src -type f`：**18** 个 `.ts`，合计 **3520** 行。无 `src/tools/` 目录（工具仍在单文件 `src/tools.ts`）。无 `src/safety/` 目录（安全逻辑在 `src/sandbox.ts` + `src/permissions.ts` + `src/mode.ts`）。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/index.ts` | 664 | CLI 入口：`.env`、参数、REPL、`/mode` `/context` `/compress`、调用 `runAgent`、持久化 |
| `src/agent.ts` | 83 | Agent loop：`runAgent`、步数上限、`policy` / `onGate` |
| `src/chat.ts` | 277 | `completeChat`：OpenAI 兼容 HTTP + SSE（**相对基线未改**） |
| `src/tools.ts` | 251 | 工具 schema、`toolSpecs(mode)`、`executeTool(..., policy)` |
| `src/fs-tools.ts` | 325 | `read` / `write` / `deleteAbsoluteFile` / `runBash` / `search` |
| `src/context.ts` | 304 | 历史规范化、条数/token 预算、`measureContext` 色块 |
| `src/db.ts` | 272 | PG 会话 CRUD；新增 `replaceMessages` |
| `src/system-prompt.ts` | 113 | `buildSystemPrompt(workspace, extra, mode)` + 可选 `AGENTS.md` |
| `src/provider.ts` | 198 | Provider 本地存储（**相对基线未改**） |
| `src/prompt.ts` | 278 | TTY 输入、abort、**`askPermission`** |
| `src/commands.ts` | 65 | `SLASH_COMMANDS` |
| `src/title.ts` | 75 | 会话标题（**相对基线未改**） |
| `src/tool-ui.ts` | 96 | 工具调用行；失败识别含 `权限拒绝` |
| `src/abort.ts` | 22 | `TurnAborted`（**相对基线未改**） |
| `src/mode.ts` | 115 | **新** Ask/Full/Plan |
| `src/permissions.ts` | 111 | **新** 审批策略 |
| `src/sandbox.ts` | 164 | **新** denylist / bash 分类 / seatbelt |
| `src/compress.ts` | 107 | **新** 摘要压缩 |

根目录相关文件（非 `src/`，但影响行为）：`package.json`、`tsconfig.json`、`.env.example`、`providers.example.json`、`README.md`、`.gitignore`（忽略 `.env` 与 `providers.json`）。无 `test/`、`tests/`、`eval*`。

---

## 1. 语言、包管理、入口

**语言：** TypeScript（`tsconfig.json`：`target` ES2022，`module`/`moduleResolution` NodeNext，`strict` true）。运行时靠 `tsx` 直接执行 `.ts`。

**包管理：** npm。运行时依赖只有 `pg@^8.16.3`。开发依赖 `@types/node`、`@types/pg`、`tsx`、`typescript`。没有 ink / blessed / commander / openai SDK / vitest。工具层用 `node:child_process` `spawn`；Darwin 上 `bashSpawn` 可改走 `/usr/bin/sandbox-exec`。

**入口：** `package.json` `"scripts.start"` / `"scripts.chat"` → `tsx src/index.ts`；`main()` 在 `src/index.ts`（约 L362）。

仍是 CLI，不是独立 TUI/server。一次性 `--input` 与交互循环两种模式。

**相对基线新增的参数 / 环境变量：**

| 来源 | 键 | 用途 |
| --- | --- | --- |
| `.env` / `--mode` | `MODE` | `full` / `ask` / `plan`；缺省 **`ask`**（`loadMode`） |

其余 Provider / DB / `--input` / `--new` / `--id` / `--no-stream` / `--no-agent` / `--steps` / `--max` 与 `5b1ddc3` 相同。`BOOLEAN_FLAGS` 仍包含 `"resume"`，`main()` **从未读取** `flags.resume`。

---

## 2. 会话 / 消息模型与持久化

**类型**（`src/db.ts`）：`Role` 仍是 `"system" | "user" | "assistant" | "tool"`。schema 未改表结构。

**相对基线的变化：**

- `replaceMessages`：压缩时 `DELETE` 该会话全部 `messages` 再按序插入。
- `rememberMode`（`src/index.ts`）：会话打开、`/new`、恢复、`/mode` 切换时，若最新 `【harness mode】` 与当前模式不同，则 `saveMessages` 插入一条 **`role: "system"`** 的 harness 消息。
- `normalizeHistory` **不再丢弃** `isHarnessModeMessage` 的 system 行；其它 system 仍跳过。`buildSystemPrompt` 本身仍不入库。

**仍缺：**

- 非 abort 的 LLM 失败：交互只 `printErr`（`src/index.ts` L641），**不保存** 该轮 user；`--input` 失败则抛出 `process.exit(1)`。
- 步数耗尽：`runAgent` `throw new Error(\`超过最大工具步数 ${maxSteps}\`)`，已执行的 tool trace **不会**作为成功回复返回，调用方同样不落库。
- 无删除/重命名/导出会话命令。`conversations.model` 只在创建时写入。

---

## 3. System prompt 组装

**位置：** `src/system-prompt.ts` `buildSystemPrompt(workspace, extra, mode = "ask")`。

拼装顺序：`basePrompt(workspace, mode)` → `modePrompt(mode)` → 若存在则 `# AGENTS.md`（上限 `AGENTS_MAX_BYTES = 16_384`）→ 若 `SYSTEM_PROMPT` / `--system` 非空则 `# 额外用户说明`。

Plan 模式工具列表缩成 `read`/`search`/`calculate`/`get_current_time`，并写「不要调用写文件、删文件或 bash」。Ask/Full 列表含 `delete`。文字仍要求绝对路径并以 `${workspace}/` 为前缀——**执行层不强制 workspace 根**。

API 消息里还会经 `insertCurrentMode` 插入/复用 `【harness mode】` 系统条（`src/context.ts` `buildApiMessages`）。

`--no-agent` 时 `ask()` 不走 `buildSystemPrompt`，只用用户 `SYSTEM_PROMPT` 字符串（可空）。

---

## 4. LLM 客户端

`src/chat.ts` **相对 `5b1ddc3` 未改。** `completeChat`：`fetch` + Bearer；默认流式。`ChatResult`：`content`、`toolCalls`、`finishReason`。

**无：** 超时（除 bash 的 30s）、重试/backoff、fallback 模型、温度、响应 `usage` 字段（`ChatCompletion` 类型里没有，也不读取）。

标题请求仍走 `src/title.ts` `generateTitle`。压缩另走一次 `completeChat`（`src/compress.ts`）。

---

## 5. Agent loop

**存在。** `src/agent.ts` `runAgent` 相对基线的增量：

- `policy?: Policy` 传给 `executeTool`
- `onGate?: (pause: boolean) => void`：工具执行前后暂停/恢复 abort 监听（避免审批时按键被当成 Esc）
- `toolSpecs(params.policy?.mode)`：Plan 不把写工具 schema 发给模型

循环结构未变：无 `toolCalls` 则停；最后一步 `allowTools = step < maxSteps - 1`；用尽步数 throw。

| 能力 | 现状 |
| --- | --- |
| 多步 tool 循环 | **有** `runAgent` |
| 步数上限 | **有** `--steps` / `MAX_AGENT_STEPS` / `DEFAULT_MAX_AGENT_STEPS` |
| 重试 / backoff | **无** |
| doom-loop / 重复 tool 检测 | **无** |
| 中断 / cancel | **有** `watchTurnAbort`；审批时 `pause` |
| 错误写回对话 | 工具错误（含 `权限拒绝:`）写回 tool message；**LLM 抛错不入库**（abort 除外只存 user） |

---

## 6. Tools

**七个工具**，硬编码在 `src/tools.ts`。未知工具名返回字符串 `未知工具: ${name}`。`executeTool` 在执行前走 Plan 过滤与 `policy.authorize`；拒绝结果前缀 `权限拒绝:`。

| name | 实现 | 要点 |
| --- | --- | --- |
| `read` | `readAbsoluteFile` | 绝对路径 + `denyReason`；Ask **不问** |
| `write` | `writeAbsoluteFile` | 整文件覆盖；Ask/Plan 受政策约束 |
| `delete` | `deleteAbsoluteFile` | **新**；只删文件不删目录 |
| `bash` | `runBash` | cwd 绝对目录 + `denyReason`；Darwin 可套 `sandbox-exec` |
| `search` | `searchAbsoluteDir` | 先 `rg` 失败则 walk；Ask **不问** |
| `calculate` | 手写递归下降 | 政策直接放行 |
| `get_current_time` | `toLocaleString` | 政策直接放行 |

**路径策略（仍不是 Phase 2 工作区 allowlist）：**

- `requireAbsolutePath` 拒绝相对路径，并 `throw` `denyReason`（`/etc`、`/usr`、`/bin`、`/sbin`、`/System`、`/Library`、`/dev`、`/proc`、`/sys`、`/root`、以及 `~/.ssh` `~/.aws` 等密钥路径）。
- `isInsideWorkspace(WORKSPACE, path)` **不用于拒绝**。Full Access 下 `decide()` 在 denylist 通过后直接 `return null`，可以写工作区外（例如 `/tmp`）。
- Ask 对工作区外写入只是提示「工作区外」再问一次，允许后可写。
- `read` / `search` 只要不在 denylist，**任意绝对路径可读**。

无 git 专用工具、无 MCP、无 web fetch。`clip()` → `MAX_OUTPUT_CHARS = 32_000`。

---

## 7. Context compaction / truncation

两层机制，不要混为一谈：

1. **自动丢弃（与基线同类）：** `cappedHistory` `slice(-max)` + `fitHistory` 按 `estimateTokens` 从头部 `shift` 直到下一条是 user。丢掉时 **不插入**「更早 N 条已省略」槽位。
2. **手动摘要（新）：** `/compress` → `canCompress`（stale token ≥ `MIN_STALE_TOKENS` 1200 且 user 轮次 > `KEEP_USER_TURNS` 2）→ `compressHistory` 把 stale 交给当前模型，写入 `role: "user"` 且前缀 `【会话摘要】`，再 `replaceMessages` 落库。

`/context` → `measureContext` / `formatContextReport`：本地估算 system / tools / context / output / free 色块。这是占用预览，不是 API `usage`。

---

## 8. Permissions / sandbox / approval

相对 `5b1ddc3` 这是最大增量。**不要把 denylist + Ask 审批说成「工作区沙箱已完成」。**

| 块 | 代码 | 诚实评价 |
| --- | --- | --- |
| 模式 | `src/mode.ts` `full`/`ask`/`plan`；默认 Ask | 有。Plan 从 schema 和 `executeTool` 双重关掉写工具 |
| 审批 | `src/permissions.ts` + `askPermission` | Ask：`write`/`delete`/非只读 `bash` 先问；`a` 按 `op:in` 或 `op:out` 记本进程 grant（不持久化）。非 TTY 拒绝。Full 不问。 |
| bash 分类 | `classifyBash` | 启发式：全文先匹配 `rm`/`sudo`/`dd` 等；再按 `&&`/`||`/`;` 切块，每块都像 `ls`/`git status`/`cat` 才标只读。未知命令偏保守当 `exec` 要问。**不解析命令读了哪些路径**：Ask 对 `cat ~/.ssh/id_rsa` 不问（cwd 过 denylist 即可）；macOS seatbelt 可能拦住密钥读，Linux 不会。 |
| 路径 denylist | `denyReason` | 有。不是 workspace allowlist |
| workspace 根 | `isInsideWorkspace` | 只用于文案与 grant key |
| macOS sandbox | `bashSpawn` + `seatbeltProfile` | Darwin 且存在 `/usr/bin/sandbox-exec` 时 `(allow default)` 再 deny 系统写与密钥读。**失败（exit 71 或 stderr 匹配）fallback 裸 bash**（`shouldFallbackSandbox`）。Linux/Windows **无** bubblewrap/docker/seatbelt |
| audit log | — | **无** `.socode/audit.log` 或等价模块 |
| `--yes` / `--root` | — | **不存在** |

---

## 9. Cost / usage / cache 仪表

**无 API usage。** `ChatCompletion` 仍无 `usage`；不累计 token、无价格表、无 cache hit/miss。

有的是本地估算：`estimateTokens` + `/context` 色块 + 压缩前后 `saved` 打印。system 每轮从磁盘/`AGENTS.md` 重拼。无 prompt-cache breakpoint。

---

## 10. Tests / evals

**仍无测试、无 eval。**

- `package.json` 没有 `test` / `lint` / `eval` script
- 无 `*.test.ts`、无 vitest/jest/`node:test`
- 无黄金对话、无 tool 契约测试、无 prompt 回归

手工验证方式：README 的 `npm start` / `npm start -- --input "..."`。本次盘点 **没有** 对 LLM 或工具做运行时验收（只读代码 + git 核验 HEAD）。

---

## 11. 与 harness 完整度相关的 TODO / FIXME

全仓库 **没有** `TODO` / `FIXME` / `XXX` / `HACK` / `WIP`（`src/index.ts` 的 `usage()` 仍是 CLI 帮助函数）。

可从代码读出的半截能力：

1. `BOOLEAN_FLAGS` 含 `"resume"` 但未使用
2. `isInsideWorkspace` 不算进拒绝路径
3. macOS sandbox 失败会静默退回无沙箱 bash
4. 步数耗尽抛错，非 abort 整轮（含已执行的 tool）不落库
5. README 写「TUI」，实现仍是 raw-mode CLI
6. grant Set 只活在当前进程，不进 PG

---

## 阶段对照

判定标准：DONE = 有可运行的核心路径；PARTIAL = 有相关代码但缺关键语义或明显半截；MISSING = 仓库中无对应模块。

相对 `5b1ddc3` 基线（当时 Phase 0 DONE、1 PARTIAL、2 MISSING、3 PARTIAL、4 MISSING）的变化标在「相对基线」列。

### Phase 0 Minimal MVP

目标：session + prompt + llm + agent loop + read/write/bash/search + basic CLI

| 块 | 状态 | 依据 |
| --- | --- | --- |
| session | **DONE** | `src/db.ts`；另有 `replaceMessages`、harness system 行 |
| prompt | **DONE** | `buildSystemPrompt(..., mode)` |
| llm | **DONE** | `completeChat`（未改） |
| agent loop | **DONE** | `runAgent` + `policy` |
| read/write/bash/search | **DONE** | 另加 `delete` |
| basic CLI | **DONE** | 另加 `--mode` `/mode` `/context` `/compress` |

**总体：DONE。** 相对基线不变（能力变多，最小 MVP 早已满足）。

### Phase 1 Survive multi-turn

目标：step limits、doom-loop、tool truncation、compaction、cancel、error writeback

| 块 | 状态 | 相对基线 | 依据 |
| --- | --- | --- | --- |
| 多轮聊天历史 | **DONE** | 同 | PG + 条数截断 + token 预算 |
| step limits | **DONE** | 同 | `maxSteps`；最后一步关掉 tools |
| doom-loop | **MISSING** | 同 | `src/agent.ts` 无重复 tool 检测 |
| tool truncation | **DONE** | 同 | `MAX_OUTPUT_CHARS = 32_000` |
| compaction（摘要式） | **PARTIAL** | MISSING → PARTIAL | 有 `/compress`+`compressHistory`；自动路径仍只 `shift` |
| cancel | **DONE** | 同（审批时 pause） | Esc / Ctrl+C；bash 可杀 |
| error writeback | **PARTIAL** | 同 | 工具失败进 tool content；LLM 失败不入库 |

**总体：PARTIAL。**

### Phase 2 Safety

目标：path allowlist、dangerous-command ask、audit log、optional sandbox

| 块 | 状态 | 相对基线 | 依据 |
| --- | --- | --- | --- |
| 工作区 allowlist | **PARTIAL** | 无 → 弱 denylist | `denyReason` + `isInsideWorkspace`（后者不拒绝） |
| dangerous-command ask | **DONE** | MISSING → DONE | 默认 Ask；`classifyBash` + `askPermission`；非 TTY 拒绝。Full 跳过 |
| audit log | **MISSING** | 同 | 无审计文件/模块 |
| sandbox | **PARTIAL** | MISSING → PARTIAL | 仅 Darwin `sandbox-exec`；失败 fallback；Linux 无 |

**总体：PARTIAL**（基线是 MISSING）。不要把「必须绝对路径」或系统目录 denylist 当成工作区沙箱。

### Phase 3 UX / cost

目标：更好的流式 UI、prompt-cache 友好组装、usage/cost、project memory file、model routing

| 块 | 状态 | 相对基线 | 依据 |
| --- | --- | --- | --- |
| 流式 + 工具 UI | **PARTIAL** | 同（略增） | 模式着色前缀、审批提示、`/context` 色块；仍非全屏 TUI |
| prompt-cache 友好组装 | **MISSING** | 同 | 无 cache 标记；system 每轮重拼 |
| usage/cost | **MISSING** | 同 | 不读 API `usage`；`/context` 只是本地估算 |
| project memory file | **PARTIAL** | 同 | 只读根目录 `AGENTS.md` |
| model routing | **PARTIAL** | 同 | `/provider` 人工切换 |

**总体：PARTIAL。**

### Phase 4 Extensibility

目标：MCP、plugins/hooks、subagents、plan mode、eval suite

| 块 | 状态 | 相对基线 | 依据 |
| --- | --- | --- | --- |
| plan mode | **DONE** | MISSING → DONE | `/mode plan`、`--mode plan`、`toolSpecs` 过滤、`executeTool` 再拒 |
| MCP | **MISSING** | 同 | 无 client/server |
| plugins / hooks | **MISSING** | 同 | 无 |
| subagents | **MISSING** | 同 | 无 |
| eval suite | **MISSING** | 同 | 无 |

**总体：PARTIAL**（基线是 MISSING）。`--no-agent` 仍只是关掉 tools，与 Plan 模式不是同一件事。

---

## 总览表

| Phase | 状态 | 相对 `5b1ddc3` | 一句话 |
| --- | --- | --- | --- |
| 0 Minimal MVP | **DONE** | 不变 | 最小 agent 仍在；现另有 `delete` 与模式 |
| 1 Survive multi-turn | **PARTIAL** | 不变（compaction 从无到手动） | 仍无 doom-loop、失败轮不落库；有 `/compress` |
| 2 Safety | **PARTIAL** | MISSING → PARTIAL | Ask 审批 + 系统路径 denylist + macOS seatbelt；无 workspace 强制根、无 audit |
| 3 UX/cost | **PARTIAL** | 不变 | `/context` `/mode` 着色；无 API usage/cache |
| 4 Extensibility | **PARTIAL** | MISSING → PARTIAL | Plan 模式真实存在；无 MCP / plugin / subagent / eval |

---

## 接下来 5 个具体里程碑

按 **当前缺口** 排序。不要再把「加 Ask 模式」或「再写一遍 loop」当作下一步。**仅为建议触碰文件；本 PR 不实现代码。**

### M1 — 真正的工作区 allowlist

`isInsideWorkspace` 已经能判断路径是否在 `WORKSPACE` 内，但 `createPolicy` / `requireAbsolutePath` **不用它拒绝**。Full Access 仍可对 `/tmp` 等任意非 denylist 路径 `write`/`bash`。

建议：

- `src/sandbox.ts` / `src/fs-tools.ts`：`read`/`write`/`delete`/`search`/`bash cwd` 默认必须 `isInsideWorkspace`；越界返回明确错误且不触盘
- `src/index.ts`：`--root` 覆盖 `WORKSPACE`；可选 `--yes` 仅跳过 Ask 询问、**不**跳过 allowlist
- Full Access 若仍允许区外，应是显式二次确认或单独 flag，而不是 `decide()` 直接 `return null`

验收：默认模式下对 `/etc/passwd`（已 denylist）和工作区外 `/tmp/...` 的 `write` 都不落盘。

### M2 — 失败写回 + doom-loop（补齐 Phase 1）

建议：

- `src/agent.ts`：连续相同 `name+arguments`（例如 3 次）强制停，并带可见说明；步数耗尽 **返回** 已有 `trace` + 错误文本
- `src/index.ts`：LLM/loop 抛错时仍 `saveMessages` 写入 user + 错误 assistant（与 `saveAbortedTurn` 对称）

验收：断网后 `/session` 能看到该 user 和错误句；故意重复同一 `read` 三次会停。

### M3 — 审计日志（Phase 2 剩下的洞）

建议：tool 名、参数摘要、mode、allow/deny/always、时间追加到 `.socode/audit.log` 或 `~/.socode/audit.log`。Ask 拒绝、Plan 拦截、denylist 命中都应有行。

验收：`--input` 触发的拒绝在日志里有对应行。

### M4 — 不要静默脱掉沙箱 + Linux 最小隔离

当前 `shouldFallbackSandbox` 在 exit 71 时改跑裸 `/bin/bash`。Linux 上 `bashSpawn` 直接裸 bash。

建议：fallback 必须对用户可见；Linux 至少把 cwd 限制 + denylist 当作唯一屏障并在 README 写明「非 macOS 无 seatbelt」。有余力再接 bubblewrap。

### M5 — API `usage` + 最少测试

建议：

- `src/chat.ts`：解析 `usage`；`/context` 或回合结束打印 prompt/completion（与本地 `estimateTokens` 分开标注）
- 最少 `src/*.test.ts`（`node:test` 即可）覆盖 `classifyBash`、`isInsideWorkspace`、`denyReason`、`normalizeHistory`、`splitForCompress`——当前 **零测试** 是回归最大洞

验收：`npm test` 无需 API key；一次成功补全能打印 **API** usage（有则显示，无则明说字段缺失）。

**暂缓：** MCP、plugins、subagents、eval suite、自动 model routing、把 raw-mode CLI 做成真正 TUI、自动（非 `/compress`）摘要 compaction。等 M1 把「工作区外可写」收住之后再做其余 Phase 4。

---

## 诚实的能力边界

当前 `socode` 在 `6c2d902`（`fix sm bug`）相对 `5b1ddc3`（`mvp++`）**确实前进了一版**：默认 Ask 审批、Plan 模式、系统路径 denylist、手动 `/compress`、`/context` 估算条、macOS `sandbox-exec`、`delete` 工具。

它仍不是「安全/可评测/可观测」的完整 harness：

- **工具没有强制工作区根**（`isInsideWorkspace` 不拒绝）
- **Linux 无沙箱**；macOS 沙箱失败会退回裸 bash
- **无 audit、无 doom-loop、失败轮不落库、不读 API usage、零测试**

不要根据 README「权限与沙箱」一节把 Phase 2 标成 DONE。下一步的正确增量仍是 **M1（allowlist 真正拒绝）和 M2（失败可恢复）**，而不是先做 MCP 或全屏 TUI。
