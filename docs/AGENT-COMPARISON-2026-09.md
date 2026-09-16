# socode vs Pi / Codex CLI / Claude Code（2026-09-16）

对照对象：`https://github.com/Tm-Ys/socode` 默认分支 `main`。

| | |
| --- | --- |
| **分析 commit** | `3e3f064227aa7465423ca5d26af7d70559f5f541` |
| **时间** | 2026-09-16 15:34:11 +0800 |
| **说明** | `Add questionnaires, distinct thinking, and /effort /model pickers.` |
| **方法** | `git fetch origin main` 后通读 `src/`、`README.md`、`docs/LONG-MODE.md`、`docs/FRONTEND.md`；`npm test` |
| **基准** | 约 mid-Sep（`42f3aac`，Long + explorer/worker 子代理）：Primary Claude Code、Secondary Codex、not Pi；总分约 **7.6 / 5.6 / 4.0** |

分数是「socode 的产品形状有多像对方」，不是「socode 有多强」。10 = 同一类日常主力 CLI；0 = 几乎不重合。

**结论先说：** Primary 仍是 **Claude Code**（未换），Secondary 仍是 **Codex CLI**，不是 Pi。Claude 相似度 **7.6 → 8.3**；Codex **5.6 → 6.1**；Pi **4.0 → 3.7**（socode 更产品化，离 Pi 的平台路线更远）。

---

## 0. 先核实：`edit` / MCP / checkpoint / verifyCommands

用户提醒这四项「可能已经有了，不要当成缺口」。在 **当前 HEAD** 和 **mid-Sep `42f3aac`** 上分别查了源码：

| 项 | 当前 `3e3f064` | mid-Sep `42f3aac` | 判定 |
| --- | --- | --- | --- |
| 字符串 `edit` 工具 | **有** `src/tools.ts` 名 `"edit"`，`old_string`/`new_string`/`replace_all`；实现 `src/fs-tools.ts` `editAbsoluteFile` | **无**（`git show 42f3aac:src/tools.ts` 无该工具） | **新能力**（`b5fbc0b`），不是漏记 |
| stdio MCP | **有** `src/mcp.ts` + `src/mcp-client.ts` `McpStdioClient`；配置 `src/mcp-config.ts` | **无**（`42f3aac` 无 `src/mcp.ts`） | **新能力**（`a1265fd`），不是漏记 |
| Long `【checkpoint】` | **有** `src/task-state.ts` `CHECKPOINT_PREFIX` / `checkpointReply`；`src/agent.ts` 预算停、`src/index.ts` Esc 中止 | **已有**（`42f3aac` 的 `task-state.ts` 已含 `CHECKPOINT_PREFIX` 与 `verifyCommands: string[]`） | **基准期已存在**；若当时当缺口，是漏记 |
| `verifyCommands` | **字段 + harness 强制跑** `src/verify.ts` `runVerifyCommands`；`task_state` 写入 `done` 时调用（`src/tools.ts`） | **只有 TaskState 字段**，无 `src/verify.ts`，写入 done **不**跑命令 | 字段是漏记/已有；**强制执行是新的**（`b5fbc0b`） |

`/doctor`、`/undo`、`/rewind`：全仓库 `src/` **无匹配**（`Grep` 零命中）。没有安装诊断，也没有工作区文件快照回滚。Long 的检查点只恢复 **任务描述**（goal / done / 下一步），不收回磁盘上的 diff。

---

## 1. 当前能力盘点（以 `src/` 为准）

运行时依赖仍只有 `pg`（`package.json`）。约 50 个生产 `.ts` + 28 个 `*.test.ts`。CLI 入口 `tsx src/index.ts`，无 `bin`。

### 1.1 工具

证据：`src/tools.ts` `toolSpecs()` / `executeTool()`。

| 工具 | 作用 | 出现条件 |
| --- | --- | --- |
| `read` | 绝对路径按行读，上限 200KB，拒二进制 | 全模式 |
| `write` | 整文件覆盖 | Ask / Full / Long；Plan 无 |
| `edit` | 精确子串替换；多处须 `replace_all` | 同上 |
| `delete` | 只删文件 | 同上 |
| `search` | 目录正则；可选 glob；优先 `rg` | 全模式 |
| `bash` | 绝对 cwd，30s；Ask/Long 套 OS 沙箱 | Ask / Full / Long；Plan 无 |
| `calculate` / `get_current_time` | 本地纯函数，不走审批 | 全模式 |
| `plan` | 2–8 项勾选 + 全部完成后 `review` | 全模式（含 Plan） |
| `question` | 一次多题问卷（含 Type your own answer） | 全模式；子代理禁止 |
| `task_state` | goal / milestones / done / `verify_commands`… | **仅 Long** |
| `context_compress` | 按 ReAct 步折轨迹 | **仅 Long** |
| `subagent_plan` / `subagent` | 规划 1–6 人再执行 | Ask / Full / Long；Plan 无；`max_depth=1` |
| `mcp__服务器__工具` | stdio MCP | 随 `.mcp.json`；Plan 只留 `readOnlyHint` |

路径 / `cwd` / `search.directory` 必须绝对路径。没有独立 `glob`、没有 `apply_patch`、没有 WebFetch、没有 LSP。

`edit` 是精确字符串匹配，不是带上下文锚点的 patch：找不到就报错让再 `read`；成功后只回报字节变化，**没有**写后 unified diff（`src/fs-tools.ts`）。

### 1.2 权限模式

证据：`src/mode.ts` `AGENT_MODES`；`src/permissions.ts` `createPolicy` / `decide`。

| 模式 | 策略（真的不同，不是换皮） |
| --- | --- |
| **Ask**（默认） | 工作区内写/`edit`/删、有副作用 bash、git 先 `y`/`n`/`a`；回车=拒绝；只读管道预授权 |
| **Plan** | 只能 `read`/`search`/`plan`/`question` + 只读 MCP；无写、删、bash |
| **Full** | 直接改文件跑命令；系统目录与密钥仍禁；沙箱起不来时 **警告后裸跑** |
| **Long / 长程** | Ask 的边界 + TaskState + **独立 LLM JSON 审批**副作用；**不会变成 Full** |

非 TTY（`--input`）Ask 无法弹窗，写入直接拒绝。

### 1.3 沙箱与安全

证据：`src/sandbox.ts`。

- bash **不再靠整句正则**：`parseBash` 拆 argv / 管道，剥 `env`/`timeout`/`xargs`/`bash -c`；`$()` 解析失败当有副作用（`classifyBash`）。
- Ask / Long：`confineWrites`。macOS `sandbox-exec`；Linux `bwrap --ro-bind /` + `--bind` 工作区。**没有则拒绝执行**（`bashSpawn` `unavailable`）。Full 才可裸 `/bin/bash`。
- denylist：`.env` / `providers.json` / `~/.ssh` 等；`realExistingPath` 跟 symlink。
- `scrubEnv`：bash 与 MCP 子进程剥密钥类环境变量。
- 每次授权追加工作区 `.socode-audit.jsonl`（`src/audit.ts`）。
- Long 副作用：本地硬拒绝密钥/区外/`sudo` 之后才问 `src/long-approve.ts`；解析失败 / 超时 12s / 缺字段 **fail-closed**。

本机探测：当前 Linux 无 `/usr/bin/bwrap` 时，`true` 也会在执行层被拒。这是设计，不是测试写错。

### 1.4 MCP

证据：`src/mcp.ts`、`src/mcp-client.ts`、`src/mcp-config.ts`、`.mcp.json.example`。

- 传输：**仅 stdio JSON-RPC**（`protocolVersion: "2024-11-05"`）。HTTP / SSE **明确未做**（README「刻意不做」）。
- 加载顺序：`~/.socode/mcp.json` → 项目 `.socode/mcp.json` → `.mcp.json`，后者覆盖同名。
- 工具名 `mcp__服务器__工具`，上限 64 个；`readOnlyHint === true` 才进 Plan / localize / verify。
- `/mcp` 看连接状态。子进程走 `scrubEnv`。

### 1.5 会话

证据：`src/db.ts`、`src/index.ts`。

- PostgreSQL：启动 `connectDb(DATABASE_URL)`，可自动建库、迁移。`conversations` + `messages`（`payload` JSONB 存 tool_calls）。
- `npm start` 默认**新会话**；空对话不入库。`--resume` / `--id` / `/session`（`/chat`）恢复。
- 生成中 Esc：用户问题留下，半截助手回复不入库（`closeIncompleteTrace`）。
- **硬依赖 Postgres**：没有 SQLite / `~/.socode/sessions/` 文件后端。连不上库则进程起不来。
- 无 session fork / archive（Codex 有 `codex fork` / `archive`）。

### 1.6 子代理

证据：`src/subagent.ts`、`src/subagent-plan.ts`、`src/subagent-ui.ts`。

- 先 `subagent_plan` 再 `subagent`。kinds：`localize` / `edit` / `verify`（Long 推荐）以及 `explorer` / `worker`（Ask/Full）。
- localize/explorer **并行**（Long 同时最多 2）；edit/worker **串行**；verify **等写入完成后再跑**。
- 干净上下文，看不到父对话；不能再开子代理；不能 `question` / `plan` / `task_state` / `context_compress`。
- `childPolicy` **转发** `longApprove` 与 `mcp`（`src/subagent.ts`；mid-Sep 曾不转发 judge，现已修）。
- edit 的 `ok` 必须真有改文件；verify 的 `ok` **由 bash 退出码覆盖**。
- 过程默认隐藏，右下角 HUD；`/seesubagent [序号]` 查看。
- **没有** git worktree；共享工作区。

### 1.7 记忆 / Skills / 项目说明

证据：`src/skills.ts`、`src/skill-activate.ts`。

- 说明文件：用户级 `~/.claude/CLAUDE.md`、`~/.socode/AGENTS.md` / `CLAUDE.md`，再从 git 根走到工作区的 `AGENTS.md` / `CLAUDE.md` / `.claude/CLAUDE.md` 等。同层 AGENTS 在前、CLAUDE 更具体。`@AGENTS.md` 可展开。单文件 16KB。
- Skills：`<name>/SKILL.md`。扫描内置 `skills/` → `~/.claude|cursor|socode/skills` → 工作区 `.agents|.claude|.cursor|.socode/skills`。
- 四个基础 skill（`brainstorm` / `grill-me` / `ponytail` / `superpowers`）默认不灌全文；软件工程请求另一次短 JSON 调用，最多激活 2 个。闲聊不调用。
- `/skills` 查看实际加载。
- **没有** Claude 式 auto-memory / `/memory`，没有跨会话笔记库。

### 1.8 TUI

证据：`docs/FRONTEND.md`、`src/markdown.ts`、`src/think.ts`、`src/prompt.ts`、`src/question-ui.ts`、`src/select-ui.ts`。

- 无 React / Ink：ANSI 差量重绘 Markdown；思考块暗色斜体，与正文分开，**不入库**。
- 工具一行摘要；结果最多 3 行后折叠；失败红色。Ask 审批一行按键，**无 diff 预览**。
- `question`：↑↓ / j k / 1–9 / Tab / Esc；多题 Confirm。
- `/model`（←→ 提供商，↑↓ 模型）、`/effort` 方向键。`/` 幽灵补全 + Tab。
- `/context` 色块；长轮次灰色 `recap`（触发后历史只留 recap，`src/recap.ts`）。
- `/seeplan` 勾选板；`/setworkarea` 空会话换工作区。

### 1.9 Doctor / 安装

- **无** `socode doctor` / `/doctor`。
- 无 `package.json` `bin`；安装故事是 Node 22+、本机 PostgreSQL、`npm install`、`.env`。
- 沙箱缺失只在第一次副作用 bash 时报错。

### 1.10 Undo

- **无** `/undo`、无写前文件快照、无 git stash 自动回滚。
- Long `【checkpoint】` = TaskState 文本，不是工作区快照（`src/task-state.ts` `checkpointReply`）。

### 1.11 Long 编排（超出 Ask 短轮）

证据：`docs/LONG-MODE.md`、`src/task-state.ts`、`src/long-budget.ts`、`src/long-rubric.ts`、`src/verify.ts`、`src/compress.ts`、`src/agent.ts`。

- TaskState 活在会话 `【task state】` system 消息里，无新表。
- 自动压缩：轮次前 + 工具步之间约 82%；钉住 harness mode / TaskState / plan；另有 `context_compress`（节流）。
- 步数默认 Dynamic P50→P75；有写入/里程碑/验证才延期一次。
- `add_done` → 白名单 `verifyCommands`（`npm test` / `npx tsc` 等）→ 可选 fail-closed rubric（四轴、权重 3 必须全过、加权 ≥ 0.7）。失败撤回 done。
- 预算用尽或 Esc：优雅停 + `【checkpoint】`。Ask/Full 步数满仍抛错。

### 1.12 斜杠命令（`src/commands.ts`）

`/new` `/session` `/chat` `/provider` `/model` `/effort` `/context` `/compress` `/mode` `/task` `/mcp` `/skills` `/seesubagent` `/seeplan` `/setplan` `/setworkarea` `/exit` `/quit`。

**没有：** `/doctor` `/undo` `/rewind` `/memory` `/diff` `/compact`（名称上；功能接近的是 `/compress`）。

---

## 2. 相对 mid-Sep 基准：新能力 vs 当时已有但可能漏记

基准代码锚点：`42f3aac`（2026-09-15，`add subagent and fix`）。之后 4 个 commit：`a1265fd` → `b5fbc0b` → `b76229a` → `3e3f064`（`+9305 / -405`）。

### 2.1 当时已有（若对比报告写成缺口 = 漏记）

- Ask / Plan / Full / **Long**
- Long LLM judge（`src/long-approve.ts`）
- TaskState 字段含 `verifyCommands`，以及 `【checkpoint】`
- OS 沙箱 fail-closed、`realpath`、`.env` denylist、audit jsonl
- 子代理 MVP：`explorer` / `worker`，`max_depth=1`
- Postgres 会话、`/compress`、doom-loop、Esc 中止

### 2.2 基准之后新落地（应加分）

| Commit | 新东西 | 证据 |
| --- | --- | --- |
| `a1265fd` | **stdio MCP**；Skills + `AGENTS.md`/`CLAUDE.md`；基础 skill 按轮激活 | `src/mcp*.ts`、`src/skills.ts`、`src/skill-activate.ts` |
| `b5fbc0b` | 字符串 **`edit`**；**`verify.ts` 强制跑命令**；`plan`；recap；workarea；子代理 HUD；bash **argv 分类**（不再整句正则） | `src/fs-tools.ts`、`src/verify.ts`、`src/plan.ts`、`src/sandbox.ts` |
| `b76229a` | Long M1–M4：Dynamic 预算、循环内压缩 + `context_compress`、localize/edit/verify、fail-closed rubric；`childPolicy` 转发 `longApprove` | `src/long-budget.ts`、`src/long-rubric.ts`、`src/subagent.ts` |
| `3e3f064` | **`question` 问卷**；思考块与正文分流；`/effort` `/model` 选择器 | `src/question.ts`、`src/think.ts`、`src/select-ui.ts` |

### 2.3 仍缺（相对「日常主力 CLI」）

Doctor、本轮 undo、安装去 Postgres、`apply_patch` / 写后 diff、审批 diff 预览、HTTP MCP、hooks、auto-memory、git worktree、插件/扩展 API。这些在 PR #9 路线图里仍是 P0/P1，当前 `main` **没有实现**。

---

## 3. 三家对照与重打分

公开产品形状（2026-09 文档，不是把 socode 吹成已对齐）：

| | **Claude Code** | **Codex CLI** | **Pi Coding Agent** |
| --- | --- | --- | --- |
| 定位 | 意见化本机编程产品 | 沙箱默认的会话型 CLI | 最小可扩展 harness |
| 工具 | Read / Edit / Write / Bash / Grep / Glob / AskUserQuestion… | 补丁 + shell；`apply_patch` 气质 | 默认 `read`/`write`/`edit`/`bash` |
| 模式 | 多套 permission mode + Plan | sandbox `read-only` / `workspace-write` / `danger-full-access` + 审批策略 | 交互 / print / RPC / SDK；**核心不做权限弹窗** |
| 沙箱 | Bash OS 沙箱（可与 mode 组合） | 一等能力（seatbelt / 等价隔离） | **核心没有**；Docker / 扩展 |
| MCP | stdio + HTTP/SSE + 管理命令 | 客户端 + **自己可当 MCP server** | **刻意不做 MCP** |
| 会话 | 本地会话、resume | JSONL `~/.codex/sessions/`、resume/fork/archive | 文件会话、可分支 |
| 子代理 | 一等、可 worktree | 较弱 / 偏会话内 | 核心没有；扩展或另开进程 |
| 记忆 | CLAUDE.md、Skills、auto-memory、hooks | AGENTS.md / 配置 TOML | Skills + 扩展 + 主题 |
| TUI | 成熟终端 + IDE | 成熟 TUI | 自研 TUI + 主题 |
| Doctor | `claude doctor` / `/doctor` | 若干诊断 / 严格配置 | 启动版本检查一类 |
| Undo | `/rewind`（会话+文件） | 扩展/TUI 有 revert；CLI 仍偏 git | 扩展可做 git checkpoint |
| 长任务 | compact、后台任务、workflow | 长会话，无 TaskState/rubric 这一套 | 靠扩展 |

socode 落点：

- **像 Claude：** 权限即产品、Plan、Ask 审批、`edit`、`question`、stdio MCP 命名、`CLAUDE.md`+Skills、子代理、`/compress`。
- **像 Codex：** `sandbox-exec`/`bwrap` fail-closed、审计、会话可恢复、审批分级；但存储是 Postgres 不是 JSONL，也没有 `codex mcp-server` / fork。
- **不像 Pi：** Pi 把 MCP/权限/Plan/子代理留给扩展；socode 把这些写死在同一循环里。没有 RPC/SDK/扩展 API。

### 3.1 分维（0–10，越高越像对方）

| 维 | Claude | Codex | Pi | 相对 7.6/5.6/4.0 |
| --- | --- | --- | --- | --- |
| 工具面 | 8.0 | 6.5 | 7.0 | Claude/Codex ↑（有 `edit`）；Pi 持平（Pi 核心也是这四件） |
| 权限模式 | 8.5 | 6.5 | 2.5 | 已有；问卷让 Claude 更像 |
| 沙箱 | 7.0 | **8.5** | 2.5 | Codex ↑（argv 分类 + fail-closed） |
| MCP | **7.5** | 6.0 | 1.5 | 从「无」→ stdio；Claude 大涨，Pi **下降**（Pi 拒绝 MCP） |
| 会话 | 6.5 | 6.0 | 5.0 | 仍 Postgres 硬依赖，三家都不完全像 |
| 子代理 | **8.0** | 5.0 | 3.0 | localize/edit/verify + HUD；Claude ↑ |
| Skills / 说明 | **8.5** | 4.5 | 6.5 | Claude ↑↑；Pi 也有 skills 但无 CLAUDE.md 层级 |
| TUI | 7.0 | 5.5 | 6.0 | 思考分流 + 问卷 + 选择器；仍无折叠轨迹/diff |
| Doctor / 安装 | 1.5 | 2.0 | 2.5 | 无变化 |
| Undo | 2.0 | 2.5 | 2.0 | 仍无文件回滚；checkpoint 只是任务状态 |
| Long / 验证 | **8.5** | 6.0 | 3.5 | rubric + 强制 verify + 动态预算；三家都没有同等 harness，但产品叙事更接近「认真干活的 Claude」 |
| 哲学（产品 vs 平台） | **9.0** | 6.5 | **3.0** | 更不像 Pi |

### 3.2 总分（等权平均，四舍五入到 0.1）

| | mid-Sep 基准 | **现在** | Δ |
| --- | --- | --- | --- |
| **Claude Code** | 7.6 | **8.3** | +0.7 |
| **Codex CLI** | 5.6 | **6.1** | +0.5 |
| **Pi** | 4.0 | **3.7** | −0.3 |

加权若把「日常敢用」（doctor/undo/安装）再压一档，Claude 仍明显高于另外两家；缺口也仍集中在那三列低分上。

### 3.3 Primary / Secondary

| | mid-Sep | **现在** |
| --- | --- | --- |
| **Primary** | Claude Code | **Claude Code（未换）** |
| **Secondary** | Codex CLI | **Codex CLI（未换）** |
| **不是** | Pi | **更不是 Pi** |

未换的原因：新增项（MCP、Skills、`question`、`edit`、Plan 勾选、子代理角色）几乎全是 Claude 产品清单上的同名物；沙箱强化把 Codex 从 5.6 拉到 6.1，仍明显低于 8.3。Pi 的差异化是「核心极简 + 扩展平台」——socode 这几天是反着走的。

---

## 4. 测试与环境

```
# tests 208
# pass 205
# fail 3
```

失败 3 条全部是 Long `verifyCommands` 执行 `true`/`false` 时撞上「无 bwrap → Ask/Long 拒绝 bash」（`src/tools.test.ts`、`src/verify.test.ts`）。在无 `sandbox-exec`/`bwrap` 的 Linux 上这是 **生产语义**，不是断言逻辑写反。白名单拒绝 `curl` 的用例仍通过。

未做：真实 LLM judge、真实 MCP 服务器联调、TTY 问卷手工点选。

---

## 5. 一句话

当前 `main`（`3e3f064`）已经是「Claude 形状的本机 Agent + Codex 气质的沙箱 + 自研 Long harness」。`edit` 和 stdio MCP 是 **9/15 夜间之后新写的**；Long checkpoint 和 `verifyCommands` **字段**在 mid-Sep 就有，强制跑验证是之后补上的。Primary 仍然是 Claude Code。
