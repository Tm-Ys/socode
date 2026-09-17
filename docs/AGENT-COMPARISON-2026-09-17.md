# socode vs Pi / Codex CLI / Claude Code（2026-09-17）

对照对象：`https://github.com/Tm-Ys/socode` 默认分支 `main`。

| | |
| --- | --- |
| **分析 commit** | `b22e9f03ff09a398543100b334a8845e6fd2c411` |
| **版本** | `0.1.1` |
| **时间** | 2026-09-17 14:42:16 +0800 |
| **说明** | `Ship 0.1.1 with doctor, undo, Ask diffs, and sandbox asks.` |
| **方法** | `git fetch origin main` 后通读 `src/`、`README.md`、`docs/LONG-MODE.md`、`docs/FRONTEND.md`；`npm test` |
| **上一快照** | `main@5831056`（2026-09-17）：Claude **8.6** / Codex **6.7** / Pi **3.5**。Primary Claude Code，Secondary Codex，不是 Pi。当时已有可安装 CLI + macOS 包、JSON 会话（无 Postgres）、向导、`glob`、强化 `edit`、load-ui、`.socode` denylist。当时仍缺：`/doctor`、本轮文件 `/undo`、Ask 审批完整 diff。 |

分数是「socode 的产品形状有多像对方、以及算不算同一类日常主力 CLI」，不是「socode 有多强」。10 = 同一类日常主力；0 = 几乎不重合。Headline 刻度对齐上一快照（8.6 / 6.7 / 3.5），便于直接加减。

**结论先说：** Primary 仍是 **Claude Code**（未换），Secondary 仍是 **Codex CLI**，不是 Pi。Claude **8.6 → 9.1**；Codex **6.7 → 7.3**；Pi **3.5 → 3.2**（产品又往意见化 CLI 走了一步，离 Pi 的平台路线更远）。

上一快照点名的三块 **已经落地**：`/doctor` + `--doctor`、本轮文件 `/undo`、Ask 审批完整 unified diff。额外把 git / 工作区外从硬拒绝改成先问用户，批准后这一次放开 OS 写隔离。

---

## 1. 当前 HEAD 与相对 `5831056` 的增量

| | |
| --- | --- |
| 上一快照 | `583105632895bf3145a460979855a696164f90f2` · `Add a socode CLI and ship installable macOS packages.` |
| **当前 HEAD** | `b22e9f03ff09a398543100b334a8845e6fd2c411` · **0.1.1** |
| 间隔 | **1 个 commit**，`+650 / −87`，25 files |

```
b22e9f0 Ship 0.1.1 with doctor, undo, Ask diffs, and sandbox asks.
5831056 Add a socode CLI and ship installable macOS packages.
```

### 1.1 产品能力（有文件证据）

| 能力 | 证据 | 相对 `5831056` |
| --- | --- | --- |
| `/doctor` 与 `socode --doctor` | 新 `src/doctor.ts`；`src/index.ts` 认 `--doctor`（失败 exit 1）；`src/commands.ts` 注册 `/doctor` | **新**。检查 Node 22+、Provider（只报已配、不打印密钥）、`sandbox-exec`/`bwrap`、`~/.socode` 可写、工作区 `.socode/sessions` 可写、当前工作区/模式。不自动修复、不查 PATH 重复安装、不查更新。 |
| 本轮文件 `/undo` | 新 `src/undo.ts`；`writeAbsoluteFile` / `editAbsoluteFile` / `deleteAbsoluteFile` 写前 `snapshotForUndo`；每轮 `beginUndoTurn()` | **新**。只撤 **最近一轮** socode 的 write/edit/delete；不碰本轮没改过的脏文件。Esc 后已落地的仍可撤。 |
| Ask 审批完整 unified diff | 新 `src/ask-diff.ts`；`askPermission(title, detail, diff)`；`permissions.ts` 把 diff 传进去 | **新**。`write`/`edit`/`delete` 在 `y/n/a` 前打绿加红删（上限约 12KB）。`edit` 在内存里 `applySnippetEdit`，不改磁盘。`bash` 仍是命令摘要。 |
| git / 工作区外改为询问 | `src/permissions.ts`、`src/sandbox.ts` `mutationDenied` 不再因区外硬拒；`bashTouchesOutside`；`git` 进 `NEVER_ALWAYS_BINS` | **新语义**。密钥 / `.env` / 系统路径 / `sudo` 仍硬拒绝。Ask 与 Long 对 git、区外读写 **问用户**（Long 不把这两类丢给 LLM 审批器）。 |
| 批准 git / 区外 bash 后抬沙箱 | `src/tools.ts`：`confineWrites: !lift`，`lift` = Full 或 git 或 `bashTouchesOutside` | **新**。批准之后这一次 OS 写隔离关掉，否则 git / 区外命令在 `sandbox-exec`/`bwrap` 里本来也写不出去。 |
| 版本 0.1.1 | `package.json` `"version": "0.1.1"` | 打包号 +1 |

测试：新 `src/doctor.test.ts`、`src/undo.test.ts`、`src/ask-diff.test.ts`，以及 permissions/sandbox 对「区外询问 / Long git 不问 judge」的用例。

### 1.2 明确没有在这一 commit 里动的（上一快照已有）

这些在 `5831056` 已经存在，**不要当成 0.1.1 新能力**：

- `package.json` `bin: socode`、macOS `.dmg`/`.pkg`/`tar.gz`
- 会话：工作区 `.socode/sessions/` JSON，无 Postgres（`src/db.ts`）
- 第一轮 Provider 向导 → `~/.socode/providers.json`
- `glob`；`edit` 的 CRLF / 行尾 trim 重试、原子 `rename`、tool 结果 unified diff（`src/patch.ts`、`src/fs-tools.ts`）
- load-ui 转圈条；`.socode` / `.socode/sessions` denylist
- Ask / Plan / Full / Long、stdio MCP、Skills、`question`、子代理、Long rubric / `verifyCommands`

### 1.3 `/undo` 的真实边界（避免写成 Claude `/rewind`）

证据：`src/undo.ts` 是进程内 `Map`，不是磁盘检查点。

- **只有** `write` / `edit` / `delete` 的写前字节。`bash` 的 `sed` / heredoc / `rm` **不进快照**。
- **只保留最近一轮**；下一轮第一次写入会清空上一袋。
- **不持久化**：进程退出、`--resume` 换进程后无法 undo。
- **不回滚对话**，也不提供「恢复到第 N 个用户提问」。
- 读失败（权限等）时 `bytes: null`，undo 会 **跳过** 该路径。

这已经满足路线图 P0「这一轮 socode 写入可撤」的最小验收；距离 Claude Code 的 `/rewind`（每 prompt 检查点、默认 100 份、可恢复代码和/或对话、跟会话一起存 30 天）还差一层。

---

## 2. 当前能力盘点（以 `src/` 为准）

约 48 个生产 `.ts` + 38 个 `*.test.ts`（仓库 `src/*.ts` 共 86）。运行时 **没有数据库依赖**。入口 `bin/socode.mjs`。

### 2.1 工具

证据：`src/tools.ts` `toolSpecs()` / `executeTool()`。

| 工具 | 作用 | 出现条件 |
| --- | --- | --- |
| `read` | 绝对路径按行读，上限 200KB，拒二进制 | 全模式 |
| `write` | 原子覆盖整文件（临时文件 + `rename`） | Ask / Full / Long；Plan 无 |
| `edit` | 子串替换；CRLF / trim 重试；结果带回 unified diff | 同上 |
| `delete` | 只删文件 | 同上 |
| `search` | 目录正则；可选 glob；优先 `rg` | 全模式 |
| `glob` | 按文件名模式列文件；跳过 `node_modules` / `.git` 等，最多 200 | 全模式 |
| `bash` | 绝对 cwd，30s；Ask/Long 套 OS 沙箱；git/区外批准后抬隔离 | Ask / Full / Long；Plan 无 |
| `calculate` / `get_current_time` | 本地纯函数，不走审批 | 全模式 |
| `plan` | 2–8 项勾选 + 全部完成后 `review` | 全模式（含 Plan） |
| `question` | 一次多题问卷 | 全模式；子代理禁止 |
| `task_state` | goal / milestones / done / `verify_commands`… | **仅 Long** |
| `context_compress` | 按 ReAct 步折轨迹 | **仅 Long** |
| `subagent_plan` / `subagent` | 规划 1–6 人再执行 | Ask / Full / Long；Plan 无；`max_depth=1` |
| `mcp__服务器__工具` | stdio MCP | 随 `.mcp.json`；Plan 只留 `readOnlyHint` |

**没有** `apply_patch`（带上下文锚点的多 hunk 协议）、没有 WebFetch、没有 LSP / 符号搜索。`edit` 仍是片段替换，不是 GNU patch。系统提示要求改已有文件优先 `edit`；tool 结果已含 diff，故「不要立刻再 `read` 来核对」现在说得通（`src/system-prompt.ts`）。

### 2.2 权限模式

证据：`src/mode.ts`；`src/permissions.ts`；`docs/LONG-MODE.md`（0.1.1 已改表）。

| 模式 | 策略 |
| --- | --- |
| **Ask**（默认） | 工作区内写/`edit`/删、副作用 bash、**所有 git**、**工作区外读写** 先 `y`/`n`/`a`；写文件审批带完整 diff；区内只读管道预授权 |
| **Plan** | 只能 `read`/`search`/`glob`/`plan`/`question` + 只读 MCP |
| **Full** | 直接改文件跑命令；denylist 仍禁；沙箱起不来时 **警告后裸跑** |
| **Long / 长程** | 区内副作用走独立 LLM JSON 审批；**git 与区外问用户**；密钥/`sudo` 本地硬拒绝；**不会变成 Full** |

非 TTY Ask 无法弹窗，写入直接拒绝。

### 2.3 沙箱与安全

证据：`src/sandbox.ts`。

- bash argv / 管道分类；Ask / Long fail-closed：macOS `sandbox-exec`，Linux `bwrap`。
- denylist：`.env` / `providers.json` / `~/.ssh` / `.socode`（含会话目录）等；symlink `realpath`。
- `scrubEnv`；审计 `.socode-audit.jsonl`。
- **新：** 用户批准 git 或区外 bash 后，该次 `confineWrites` 关闭。

### 2.4 MCP / 会话 / 子代理 / Skills / TUI / Long

与 `5831056` 相同骨架，不重复展开：

- MCP：**仅 stdio**。HTTP / SSE 仍是刻意不做。
- 会话：工作区 `.socode/sessions/` JSON；空对话不落盘；无 fork / archive。
- 子代理：localize 并行（Long 最多 2）、edit 串行、verify 最后；无 git worktree。
- Skills：`AGENTS.md` / `CLAUDE.md` 层级 + 四基础 skill 按轮激活。无 `/memory`、无 Stop hook。
- TUI：手写 ANSI；**Ask 现有完整 diff**；工具结果仍最多 3 行折叠；无 Ink、无 IDE。
- Long：TaskState、动态预算、压缩钉住、`verifyCommands`、fail-closed rubric、`【checkpoint】`（任务状态，不是文件快照）。

### 2.5 斜杠命令（`src/commands.ts`）

相对 `5831056` **新加** `/undo`、`/doctor`。

仍有：`/new` `/session` `/chat` `/provider` `/model` `/effort` `/context` `/compress` `/mode` `/task` `/mcp` `/skills` `/seesubagent` `/seeplan` `/setplan` `/setworkarea` `/exit` `/quit`。

**没有：** `/rewind` `/memory` `/diff` `/usage` `/compact`（功能接近的是 `/compress`）。

### 2.6 相对「日常主力」仍缺

路线图那句验收口令（装上、配密钥、Ask 改函数、**审批看见 diff**、跑测试、**`/undo`**、**`doctor` 为绿）——除「短轮默认跑测试」外，**代码路径已经齐**。挡每天当主力的是下一层：

| 缺口 | 现状 |
| --- | --- |
| 手术刀 patch | 有强化 `edit` + 写后/审批 diff，**没有** `apply_patch` 多 hunk 锚点；大文件仍可整份 `write` |
| `/undo` 深度 | 进程内存、最近一轮、不含 bash |
| 中断 / 重试 | `Esc`、doom-loop、原子写入有；`src/chat.ts` **单次 `fetch`，无 429/5xx 退避**；崩溃后不能续未完成 tool 轮 |
| 短轮验证 | Long 里程碑才强制 `verifyCommands`；Ask/Full 提示「需要时再跑」 |
| 费用 | `/context` 色块；无 `/usage`、无美元、无分项（子代理/审批） |
| 扩展 | 无 HTTP MCP、无 PreToolUse hooks、无 auto-memory |
| 评测门 | 只有 `npm test` 模块回归 |
| 发行 | macOS 包未签名、无自动更新 |

`docs/PRODUCT-ROADMAP.md` **未随 0.1.1 更新**，文中仍写「没有 `socode doctor`」「Ask 审批没有 diff」「运行时只有 `pg`」。以代码为准。

---

## 3. 三家对照与重打分

公开产品形状（2026-09 文档；不是把 socode 写成已对齐）：

| | **Claude Code** | **Codex CLI** | **Pi Coding Agent** |
| --- | --- | --- | --- |
| 定位 | 意见化本机编程产品 | 沙箱默认的会话型 CLI | 最小可扩展 harness |
| 工具 | Read / Edit / Write / Bash / Grep / Glob / AskUserQuestion… | `apply_patch` + shell | 默认 `read`/`write`/`edit`/`bash` |
| 模式 | permission modes + Plan | `read-only` / `workspace-write` / `danger-full-access` + 审批 | 交互 / print / RPC / SDK；**核心不做权限弹窗** |
| 沙箱 | Bash OS 沙箱 | 一等（seatbelt / bwrap / Windows） | 核心没有；容器 / 扩展 |
| MCP | stdio + HTTP/SSE + 管理命令 | 客户端 + **自己可当 MCP server** | **刻意不做** |
| 会话 | 本地会话、resume、branch/fork | JSONL `~/.codex/sessions/`、resume/fork/archive | JSONL 树、`/tree` `/fork` |
| 子代理 | 一等、可 worktree / `/batch` | 较弱 / 会话内 | 核心没有 |
| 记忆 | CLAUDE.md、Skills、auto-memory、hooks | AGENTS.md / `config.toml` | Skills + 扩展 + 主题 |
| TUI | 成熟终端 + IDE；审批/rewind 菜单 | 成熟 TUI；patch 预览 + 审批 | 自研 TUI + 主题 |
| Doctor | `claude doctor` 只读；`/doctor` **可修复** | `codex doctor` 诊断报告 | 启动/版本检查一类 |
| Undo | `/rewind`（代码和/或对话，约 100 检查点） | 会话 rewind **不还原文件**；文件 `/rewind` 仍是需求 | 扩展可做 git checkpoint |
| 长任务 | compact、后台、workflow | 长会话；无 TaskState/rubric | 靠扩展 |

socode 落点：

- **更像 Claude：** `/doctor`、`/undo`、Ask 完整 diff、Plan、`question`、Skills/`CLAUDE.md`、stdio MCP 命名、子代理角色。仍缺 rewind 深度、hooks、HTTP MCP、IDE、`/usage`。
- **更像 Codex：** JSON 会话、fail-closed OS 沙箱、审批分级、**审批可见 diff**、`doctor`、git/区外先问再抬沙箱。仍缺 `apply_patch`、fork/archive、`codex mcp-server`、app-server。
- **更不像 Pi：** Pi 把权限弹窗 / MCP / Plan / 子代理留给扩展。socode 把 doctor、undo、diff 审批也写进同一循环。没有 RPC/SDK/扩展 API。

### 3.1 分维（0–10；括号内为相对 `5831056`）

| 维 | Claude | Codex | Pi |
| --- | --- | --- | --- |
| 工具面 | 8.7 (+0.2) | 7.2 (+0.2) | 7.0 (0) |
| 权限模式 | 9.0 (+0.5) | 7.5 (+1.0) | 2.0 (−0.5) |
| 沙箱 | 7.8 (+0.3) | 9.0 (+0.3) | 2.0 (−0.5) |
| MCP | 7.5 (0) | 6.0 (0) | 1.5 (0) |
| 会话 | 8.0 (0) | 7.5 (0) | 6.0 (0) |
| 子代理 | 8.0 (0) | 5.0 (0) | 3.0 (0) |
| Skills / 说明 | 8.5 (0) | 4.5 (0) | 6.5 (0) |
| TUI | 8.2 (+1.0) | 7.2 (+1.5) | 5.5 (−0.5) |
| Doctor / 安装 | 7.6 (+2.1) | 7.2 (+2.2) | 3.0 (0) |
| Undo | 6.2 (+4.2) | 6.0 (+3.5) | 2.5 (+0.5) |
| Long / 验证 | 8.5 (0) | 6.0 (0) | 3.5 (0) |
| 哲学（产品 vs 平台） | 9.3 (+0.1) | 6.8 (+0.3) | 2.5 (−0.3) |

涨分集中在 Doctor、Undo、TUI（Ask diff）、权限/沙箱（询问而非硬墙）。Codex 的 TUI/审批/doctor 维度涨得和 Claude 一样狠，但 Skills/子代理/哲学仍明显偏低。Pi 在权限、TUI、哲学继续下降：这些正是 Pi 文档写明「核心不做、交给扩展」的部分。

Codex 的 Undo 列涨到 6.0，**不是**因为 Codex 已经有 Claude 式文件 rewind（公开文档里会话 rewind 不还原磁盘，完整 `/rewind` 仍是 issue），而是 socode 现在有「可撤的本机改动」这一日常主力形状，和 Codex 作为沙箱会话 CLI 的目标更同级。深度上 socode 的 `/undo` 仍浅于 Claude `/rewind`。

### 3.2 Headline 总分（对齐上一快照刻度）

| | `5831056` 快照 | **现在 `b22e9f0`** | Δ |
| --- | --- | --- | --- |
| **Claude Code** | 8.6 | **9.1** | **+0.5** |
| **Codex CLI** | 6.7 | **7.3** | **+0.6** |
| **Pi** | 3.5 | **3.2** | **−0.3** |

未打到 9.5+：Claude 仍有 rewind 历史、可修复 doctor、HTTP MCP、hooks、IDE、`/usage`、`apply_patch`。未让 Codex 反超：缺 `apply_patch` 协议和会话层 fork/archive/MCP-server。

### 3.3 Primary / Secondary

| | `5831056` | **现在** |
| --- | --- | --- |
| **Primary** | Claude Code | **Claude Code（未换）** |
| **Secondary** | Codex CLI | **Codex CLI（未换）** |
| **不是** | Pi | **更不是 Pi** |

未换的原因：0.1.1 补的三件套（`/doctor`、`/undo`、Ask diff）在 Claude 产品清单上是同名物；沙箱询问 + 审批 diff 把 Codex 从 6.7 拉到 7.3，仍低于 9.1。Pi 的差异化是「核心极简 + 扩展平台」——这一 commit 是反着走的。

---

## 4. 测试与环境

```
# tests 255
# pass 252
# fail 3
```

新模块全过：`runDoctor`、`undo last turn`、`formatAskDiff` / `paintAskDiff`。失败 3 条与上一快照同类：Long `verifyCommands` 执行 `true` 时本机无 `/usr/bin/bwrap`，Ask/Long **拒绝 bash**（`src/tools.test.ts`、`src/verify.test.ts`）。这是生产语义，不是 0.1.1 写反断言。

未做：真实 LLM judge、真实 MCP 联调、TTY 上手工点选 Ask diff / `/undo`。

---

## 5. 给用户的中文结论

**动了什么：** 相对 `5831056`，只多了一版 0.1.1。上次点名的三块全补上了——`/doctor`、本轮文件 `/undo`、Ask 审批完整 unified diff；git 和工作区外从硬拒绝改成先问你，批准后这一次放开沙箱写隔离。

**仍挡日常主力：** `/undo` 只在当前进程、只覆盖 write/edit/delete、不管 bash；没有 `apply_patch`；Provider 失败不重试；短轮不默认跑测试；没有 `/usage`。路线图那句「装上、看见 diff、undo、doctor 绿」已经基本成立，缺的是改完就测和改砸能跨会话撤回。

**一句话：** Primary 仍是 Claude Code；socode 现在更敢当「改自己仓库」的默认 CLI，但还不到能关掉 Claude Code / Codex 的完整主力。
