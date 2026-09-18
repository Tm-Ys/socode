# socode vs Pi / Codex CLI / Claude Code（2026-09-18）

对照对象：`https://github.com/Tm-Ys/socode` 默认分支 `main`。

| | |
| --- | --- |
| **分析 commit** | `528fb32c074ac3881066078e3180e425139d2559` |
| **版本** | `0.1.3` |
| **时间** | 2026-09-18 10:31:45 +0800 |
| **说明** | `Ship 0.1.3 with Remote-SSH display/worker split, session provider inject, and host history.` |
| **方法** | `git fetch origin main` 后通读 `src/`、`README.md`、`docs/PRODUCT-ROADMAP.md`、`docs/REMOTE.md`、`docs/REMOTE-B.md`、`docs/FRONTEND.md`；`npx tsx --test src/*.test.ts` |
| **上一快照** | `main@b22e9f0`（2026-09-17）：Claude **9.1** / Codex **7.3** / Pi **3.2**。Primary Claude Code，Secondary Codex，不是 Pi。当时已有 `/doctor`、进程内本轮 `/undo`、Ask 完整 unified diff、git/区外询问并抬沙箱。当时仍缺：`apply_patch`；持久 undo；Provider 429/5xx 重试；短轮默认测；`/usage`；HTTP MCP / hooks / auto-memory；eval 门。`PRODUCT-ROADMAP.md` 当时相对 0.1.1 代码是旧的。 |

分数是「socode 的产品形状有多像对方、以及算不算同一类日常主力 CLI」，不是「socode 有多强」。10 = 同一类日常主力；0 = 几乎不重合。Headline 刻度对齐上一快照（9.1 / 7.3 / 3.2），便于直接加减。

**结论先说：** Primary 仍是 **Claude Code**（未换），Secondary 仍是 **Codex CLI**，不是 Pi。Claude **9.1 → 9.4**；Codex **7.3 → 7.9**；Pi **3.2 → 2.9**（Remote-SSH / `/usage` / 落盘 undo 都写进核心循环，离 Pi 的「核心极简 + 扩展平台」更远）。

上一快照点名的缺口，**已经落地**：Provider 429/5xx/网络抖动退避、思考/工具流 stable+tail 重绘、`/usage` + 每轮 token 行、`/undo` 落到工作区 `.socode/undo/`（重启可撤）、Remote-SSH（本机显示器 + 远端 worker，会话注入 Provider、主机历史）。**仍缺：** `apply_patch`、短轮默认测、HTTP MCP / hooks / auto-memory、eval 门、多轮 rewind。路线图正文仍有几处和 0.1.3 代码打架（见 §2.7）。

---

## 1. 当前 HEAD 与相对 `b22e9f0` 的增量

| | |
| --- | --- |
| 上一快照 | `b22e9f03ff09a398543100b334a8845e6fd2c411` · `Ship 0.1.1 with doctor, undo, Ask diffs, and sandbox asks.` · **0.1.1** |
| 中间 | `5ab073d9d87378cf03495b57809dd5fdfb4df2db` · **0.1.2**（2026-09-17 15:47:50 +0800） |
| **当前 HEAD** | `528fb32c074ac3881066078e3180e425139d2559` · **0.1.3** |
| 间隔 | **2 个 commit**，`+7098 / −1303`，68 files |

```
528fb32 Ship 0.1.3 with Remote-SSH display/worker split, session provider inject, and host history.
5ab073d Ship 0.1.2 with provider retries and stable/tail streaming.
b22e9f0 Ship 0.1.1 with doctor, undo, Ask diffs, and sandbox asks.
```

### 1.1 0.1.2 产品能力（有文件证据）

| 能力 | 证据 | 相对 `b22e9f0` |
| --- | --- | --- |
| Provider 429 / 5xx / 网络抖动重试 | 新 `src/retry.ts`；`completeChat` 最多 3 次；`retryableStatus` 含 408/429/500/502/503/504；尊重 `Retry-After`；指数退避 400ms→8s | **新**。401 等 4xx 一次失败。Esc 取消 `fetch` 和 sleep。 |
| 半截流不重试 | `src/chat.ts` `readSseReply`：已经吐出 `content` / `thinking` / tool_call 则不再包成 `TransientProviderError` | **新**。避免 TUI 把同一段字打两遍。 |
| 思考 / Markdown stable+tail 重绘 | `src/markdown.ts` `paintLiveDelta`：已换行的 stable 行进 scrollback，只 rewind 最后一行 tail | **新**。上一快照按 token 整块擦会花屏。 |
| 远程开发文档 | 新 `docs/REMOTE.md`；`PRODUCT-ROADMAP.md` 按 0.1.1/0.1.2 重写 | **文档**。0.1.2 当时还没有 `socode connect`。 |
| 版本 0.1.2 | `package.json` | 打包号 +1 |

测试：新 `src/retry.test.ts`、`src/chat.test.ts` 退避用例、`src/markdown.test.ts` live reprint。

### 1.2 0.1.3 产品能力（有文件证据）

| 能力 | 证据 | 相对 `5ab073d` |
| --- | --- | --- |
| Remote-SSH：本机显示器 + 远端 worker | `socode connect user@host:/abs/path`；会话里 `/remote-ssh`；`src/connect.ts`、`src/remote-ssh-ui.ts`、`src/worker.ts`、`src/display.ts`、`src/jsonrpc-peer.ts`、`bin/worker-entry.mjs` | **新**。JSON-RPC over SSH stdio（`-T`，不要 `ssh -t`）。本机不跑 `runAgent`。 |
| 远端注入 runtime + Node 22 | `src/runtime-pack.ts`、`src/remote-install.ts`：打 `dist/`+`skills/` 成 `socode-runtime-<stamp>.tar.gz`；远端缺 Node 则自己 `curl` 镜像，不从本机 scp 二进制 | **新**。远端不必预装 socode。禁止把 `providers.json` / `.env` / `src/` 打进 tar。 |
| 会话 Provider 注入并在断开前删 | `injectSessionProvider` → `~/.socode-server/session/providers.json`（chmod 600）；worker 只读 `SOCODE_PROVIDER_STORE`；`finally` 里 `wipeSessionProvider` | **新**。不覆盖远端 `~/.socode/providers.json`，不进环境变量、不进 RPC、不进 runtime 包。 |
| SSH 主机历史 | `src/ssh-history.ts`；`/remote-ssh` Tab 循环历史主机；密码每次重输 | **新**。 |
| `/undo` 落盘 | `src/undo.ts` `bindUndoStore`：工作区 `.socode/undo/manifest.json` + blob；重启 / 远程再连同一目录仍可撤 | **相对 0.1.1 升级**。上一快照是进程内 `Map`。仍只最近一轮 write/edit/delete，不管 bash，不是 rewind。 |
| `/usage` + 每轮 token 行 | 新 `src/usage.ts`；解析 prompt/completion/cache/reasoning；`formatUsageLine`；`~/.socode/config.json` 的 `modelPricing` | **新**。没配单价写 `未标价`，**不编造美元**。无父/子/审批分项，无墙钟。 |
| 显示器 / worker 拆开 | `src/index.ts` 从 ~REPL 巨石收成 CLI + 本地 `openLocalWorker`；本地和 Remote 共用 `src/worker.ts` + `src/display.ts` | **结构**。本地行为应不变。 |
| MIT | 新 `LICENSE` | **新**。 |
| 版本 0.1.3 | `package.json` `"version": "0.1.3"` | 打包号 +1 |

测试：新 `src/usage.test.ts`、`src/connect.test.ts`、`src/remote-*.test.ts`、`src/runtime-pack.test.ts`、`src/stdio-worker.test.ts`、`src/ssh-history.test.ts`、`src/worker.test.ts`、`src/undo.test.ts` 重启夹具。

### 1.3 明确没有在这两次 commit 里做的

不要把下面写成 0.1.3 新能力——它们在 `b22e9f0` 已经存在：

- `/doctor`、`--doctor`、Ask 完整 unified diff、git/区外询问并抬沙箱
- `bin/socode.mjs`、macOS 包、JSON 会话、向导、`glob`、强化 `edit`
- Ask / Plan / Full / Long、stdio MCP、Skills、`question`、子代理、rubric / `verifyCommands`

### 1.4 `/undo` 现在的真实边界（避免写成 Claude `/rewind`）

证据：`src/undo.ts`。相对 0.1.1 **唯一变深的是持久化**。

| 它是 | 它不是 |
| --- | --- |
| 工作区 `.socode/undo/` 里最近一轮 `write` / `edit` / `delete` 的写前字节 | 多轮历史；Claude 式每 prompt 检查点（约 100 份） |
| 关进程、崩溃、Remote-SSH 再连**同一仓库目录**后仍可 `/undo` | 撤 `bash`（`sed`、`npm`、`git checkout`） |
| 下一轮第一次写入才换快照 | 对话 rewind：不删消息、不把模型说辞收回去 |
| 与 Long 的 `【checkpoint】` 无关 | git stash、session rewind |

读失败时 `bytes: null`，undo 会跳过该路径。文案写明：不管 bash，不是 rewind。

---

## 2. 当前能力盘点（以 `src/` 为准）

约 62 个生产 `.ts` + 50 个 `*.test.ts`（仓库 `src/*.ts` 共 112）。运行时 **没有数据库依赖**。入口 `bin/socode.mjs`；Remote worker 入口 `bin/worker-entry.mjs`。

### 2.1 工具

证据：`src/tools.ts`。相对 `b22e9f0` **工具表没加新名字**。

| 工具 | 作用 | 出现条件 |
| --- | --- | --- |
| `read` | 绝对路径按行读，上限 200KB，拒二进制 | 全模式 |
| `write` | 原子覆盖整文件（临时文件 + `rename`） | Ask / Full / Long；Plan 无 |
| `edit` | 子串替换；CRLF / trim 重试；结果带回 unified diff | 同上 |
| `delete` | 只删文件 | 同上 |
| `search` | 目录正则；可选 glob；优先 `rg` | 全模式 |
| `glob` | 按文件名模式列文件；跳过 `node_modules` / `.git` 等 | 全模式 |
| `bash` | 绝对 cwd，30s；Ask/Long 套 OS 沙箱；git/区外批准后抬隔离 | Ask / Full / Long；Plan 无 |
| `calculate` / `get_current_time` | 本地纯函数，不走审批 | 全模式 |
| `plan` | 2–8 项勾选 + 全部完成后 `review` | 全模式（含 Plan） |
| `question` | 一次多题问卷 | 全模式；子代理禁止 |
| `task_state` | goal / milestones / done / `verify_commands`… | **仅 Long** |
| `context_compress` | 按 ReAct 步折轨迹 | **仅 Long** |
| `subagent_plan` / `subagent` | 规划 1–6 人再执行 | Ask / Full / Long；Plan 无；`max_depth=1` |
| `mcp__服务器__工具` | stdio MCP | 随 `.mcp.json`；Plan 只留 `readOnlyHint` |

**没有** `apply_patch`（带上下文锚点的多 hunk 协议）、没有 WebFetch、没有 LSP。`src/patch.ts` 仍只服务 `edit`。系统提示：「需要测试或构建才能确认时再跑」——Ask/Full **不会**在短轮结束前强制跑测试。

### 2.2 权限模式

与 0.1.1 相同策略，Remote-SSH **不另开一套权限**：问不问人在本机 TTY，路径 / 沙箱 / git 在远端 worker 判定。

| 模式 | 策略 |
| --- | --- |
| **Ask**（默认） | 工作区内写/`edit`/删、副作用 bash、**所有 git**、**工作区外读写** 先 `y`/`n`/`a`；写文件审批带完整 diff；区内只读管道预授权 |
| **Plan** | 只能 `read`/`search`/`glob`/`plan`/`question` + 只读 MCP |
| **Full** | 直接改文件跑命令；denylist 仍禁；沙箱起不来时 **警告后裸跑** |
| **Long / 长程** | 区内副作用走独立 LLM JSON 审批；**git 与区外问用户**；密钥/`sudo` 本地硬拒绝；**不会变成 Full** |

非 TTY Ask 无法弹窗，写入直接拒绝。0.1.3 修过：不要把整棵 `/root` 当禁写目录（`EXTRA_SECRET_HOMES` 只拦 `.ssh` 等），否则 root 家目录里的工作区连 `echo` 都被拒。

### 2.3 沙箱与安全

证据：`src/sandbox.ts`。Ask / Long fail-closed：macOS `sandbox-exec`，Linux `bwrap`。密钥 denylist、`scrubEnv`、审计 `.socode-audit.jsonl`。批准 git / 区外后该次 `confineWrites` 关闭。

Remote 密钥模型：A（`ssh -t` 整进程）用远端 `~/.socode`；B（已落地）用本机会话文件，断开删除。

### 2.4 MCP / 会话 / 子代理 / Skills / TUI / Long

骨架与 `b22e9f0` 相同，不重复展开，只记移动：

- MCP：**仅 stdio**。`src/mcp-config.ts` 遇到 `type: http|sse` 或 `url` 直接报错。HTTP / SSE、PreToolUse hooks、auto-memory **仍没有**。
- 会话：工作区 `.socode/sessions/` JSON；Remote 写在**远端工作区**。无 fork / archive / `/tree`。
- 子代理：localize 并行（Long 最多 2）、edit 串行、verify 最后；无 git worktree。
- Skills：`AGENTS.md` / `CLAUDE.md` 层级 + 四基础 skill 按轮激活。无 `/memory`。
- TUI：手写 ANSI；**新** stable+tail；**新** 每轮 `tokens` 行；Ask 完整 diff；Remote-SSH 分屏表单 / 目录选择。无 Ink、无 IDE。
- Long：TaskState、动态预算、压缩钉住、`verifyCommands`、fail-closed rubric、`【checkpoint】`（任务状态，不是文件快照）。审批走同一套 `completeChat` 重试。

### 2.5 斜杠命令与 CLI（`src/commands.ts`、`src/index.ts`）

相对 `b22e9f0` **新加** `/usage`、`/remote-ssh`。CLI **新加** `socode connect`、`socode worker --stdio`。

仍有：`/new` `/session` `/chat` `/provider` `/model` `/effort` `/context` `/compress` `/mode` `/task` `/mcp` `/skills` `/seesubagent` `/seeplan` `/setplan` `/setworkarea` `/undo` `/doctor` `/exit` `/quit`。

**没有：** `/rewind` `/memory` `/diff` `/compact`（接近的是 `/compress`）。没有名为 `socode ssh` 的子命令；入口是 `connect` / `/remote-ssh`。

### 2.6 相对「日常主力」仍缺

| 缺口 | 现状 |
| --- | --- |
| 手术刀 patch | 有强化 `edit` + 写后/审批 diff，**没有** `apply_patch` 多 hunk 锚点 |
| `/undo` 深度 | 已落盘、跨重启；仍只最近一轮、不含 bash、不是 rewind |
| 中断 / 重试 | **0.1.2 已补** 429/5xx/抖动；半截流不重试。Ask/Full 步数用尽仍抛错；MCP / 长 read 没有和 bash 对齐的超时 |
| 短轮验证 | Long 里程碑才强制 `verifyCommands`；Ask/Full 提示「需要时再跑」 |
| 费用 | **0.1.3 已有最小集** `/usage` + token 行；无父/子/审批分项、无花费阈值 |
| 扩展 | 无 HTTP MCP、无 PreToolUse hooks、无 auto-memory |
| 评测门 | 只有 `npm test` 模块回归 |
| 发行 | macOS 包未签名、无自动更新 |
| 远程 | **协议 B 已落地**；不是云沙箱。无自动重连、无跳板机 UI |

### 2.7 路线图与代码的偏差（以代码为准）

`docs/PRODUCT-ROADMAP.md` 已按 0.1.2/0.1.3 改过能力盘点（`/usage`、落盘 undo、重试），但下面几句 **过时**：

- §1 仍写「网络失败不重试……费用几乎看不见」——与 §2.8、代码相反。
- §6.1 / §8.3 仍写 90 天「只允许 A、不做完整 B」——`src/connect.ts` 已经是 B。
- §9.1 `socode ssh` **没有**：子命令实际叫 `connect`；也没有 `socode ssh` 包装。
- `docs/REMOTE.md` 文首仍写「没有 `socode ssh`，没有 `socode serve`」，后文却描述当前 B。
- `docs/REMOTE-B.md` 标题仍是「对齐前不写代码」，实现已在 0.1.3。

评测仍以 `src/` 为准，不把过时句子当成缺口或当成已交付。

---

## 3. 三家对照与重打分

公开产品形状（2026-09 文档；不是把 socode 写成已对齐）：

| | **Claude Code** | **Codex CLI** | **Pi Coding Agent** |
| --- | --- | --- | --- |
| 定位 | 意见化本机编程产品 | 沙箱默认的会话型 CLI | 最小可扩展 harness |
| 工具 | Read / Edit / Write / Bash / Grep / Glob / AskUserQuestion… | `apply_patch` + shell | 默认 `read`/`write`/`edit`/`bash` |
| 模式 | permission modes + Plan | `read-only` / `workspace-write` / `danger-full-access` + 审批 | 交互 / print / RPC / SDK；**核心不做权限弹窗** |
| 沙箱 | Bash OS 沙箱 | 一等（seatbelt / landlock+seccomp / Windows） | 核心没有；容器 / 扩展 |
| MCP | stdio + HTTP/SSE + 管理命令 | 客户端 + **自己可当 MCP server**；stdio 与 streamable HTTP | **刻意不做** |
| 会话 | 本地会话、resume、`/rewind`、Desktop SSH / Remote Control | JSONL `~/.codex/sessions/`、resume/fork/archive、云端 `codex apply` | JSONL 树、`/tree` `/fork` `/share` |
| 子代理 | 一等、可 worktree | 较弱 / 会话内 | 核心没有 |
| 记忆 | CLAUDE.md、Skills、auto-memory、hooks（含 HTTP） | AGENTS.md / `config.toml` | Skills + 扩展 + 主题 |
| TUI | 成熟终端 + IDE；审批/rewind 菜单 | 成熟 TUI；patch 预览 + 审批；stable/tail 流 | 自研 TUI + 主题 |
| Doctor | `claude doctor`；`/doctor` **可修复** | `codex doctor` | 启动/版本检查一类 |
| Undo | `/rewind`（代码和/或对话，约 100 检查点，跟会话存） | 会话 rewind **不还原文件** | 扩展可做 git checkpoint |
| 用量 | `/usage` `/cost`，订阅额度 | TUI 用量；计费走 OpenAI | `/session` 含 tokens/cost |
| 长任务 | compact、后台、workflow | 长会话；无 TaskState/rubric | 靠扩展 |
| 远程 | Desktop SSH、`sshConfigs`、Remote Control、Web | 云任务 + 本地 `codex apply` | SSH 当扩展，不进核心 |

socode 落点：

- **更像 Claude：** `/doctor`、落盘 `/undo`、Ask 完整 diff、Plan、`question`、Skills/`CLAUDE.md`、stdio MCP 命名、子代理角色、`/usage`、Remote-SSH 显示器/worker。仍缺 rewind 深度、hooks、HTTP MCP、IDE、auto-memory、可修复 doctor。
- **更像 Codex：** JSON 会话、fail-closed OS 沙箱、审批分级、审批可见 diff、`doctor`、git/区外先问再抬沙箱、**stable+tail 流**、Provider 退避。仍缺 `apply_patch`、fork/archive、`codex mcp-server`、Windows 沙箱。
- **更不像 Pi：** Pi 把权限弹窗 / MCP / Plan / 子代理 / SSH / 沙箱留给扩展。socode 把 Remote-SSH、`/usage`、落盘 undo、重试也写进同一循环。没有 RPC/SDK/扩展 API。多 Provider 仍是和 Pi 最像的一块，但 socode 把它收成产品向导，不是平台。

### 3.1 分维（0–10；括号内为相对 `b22e9f0`）

| 维 | Claude | Codex | Pi |
| --- | --- | --- | --- |
| 工具面 | 8.7 (0) | 7.2 (0) | 7.0 (0) |
| 权限模式 | 9.1 (+0.1) | 7.6 (+0.1) | 1.8 (−0.2) |
| 沙箱 | 7.8 (0) | 9.0 (0) | 2.0 (0) |
| MCP | 7.5 (0) | 6.0 (0) | 1.5 (0) |
| 会话 | 8.4 (+0.4) | 7.7 (+0.2) | 5.7 (−0.3) |
| 子代理 | 8.0 (0) | 5.0 (0) | 3.0 (0) |
| Skills / 说明 | 8.5 (0) | 4.5 (0) | 6.5 (0) |
| TUI | 8.6 (+0.4) | 8.0 (+0.8) | 5.3 (−0.2) |
| Doctor / 安装 | 8.2 (+0.6) | 7.7 (+0.5) | 3.0 (0) |
| Undo | 7.3 (+1.1) | 6.8 (+0.8) | 2.7 (+0.2) |
| Long / 验证 | 8.6 (+0.1) | 6.1 (+0.1) | 3.5 (0) |
| 哲学（产品 vs 平台） | 9.5 (+0.2) | 7.0 (+0.2) | 2.2 (−0.3) |

涨分来源：

- **TUI：** Codex 那套 stable+tail（`docs/踩坑实录.md` 自己点名）把 Codex 列从 7.2 拉到 8.0；Claude 列跟的是 token 行 + Remote 分屏，不是 IDE。
- **Undo：** 从 RAM-only 变成工作区落盘，Remote 再连同一目录仍可撤。深度仍远浅于 Claude `/rewind`（无多轮、无对话、无 bash）。Codex 列涨的是「可撤的本机改动」这一日常主力形状，不是 Codex 自己已经有文件 rewind。
- **Doctor / 安装：** 429 重试让「装上就能用」更像两家主力 CLI；Remote 向远端灌 Node+runtime，安装故事从「本机一条命令」扩到「远端不必预装 agent」。
- **会话：** Remote-SSH 把 Claude Desktop SSH / VS Code Remote 那一类形状拉近；不是 Pi 的 `/tree`。
- **Pi 继续下降：** 权限、TUI、会话、哲学都是 Pi 文档写明「核心不做、交给扩展」的部分。

工具面 / MCP / 子代理 / Skills **没动**：没有 `apply_patch`、没有 HTTP MCP，所以这四格持平。

### 3.2 Headline 总分（对齐上一快照刻度）

| | `b22e9f0` 快照 | **现在 `528fb32`** | Δ |
| --- | --- | --- | --- |
| **Claude Code** | 9.1 | **9.4** | **+0.3** |
| **Codex CLI** | 7.3 | **7.9** | **+0.6** |
| **Pi** | 3.2 | **2.9** | **−0.3** |

未打到 9.5+：Claude 仍有 rewind 历史、可修复 doctor、HTTP MCP、hooks、auto-memory、IDE、`apply_patch`。未让 Codex 反超：缺 `apply_patch` 协议和会话层 fork/archive/MCP-server。Codex +0.6 主要是 stable+tail + 重试 + 落盘 undo，形状更像「沙箱会话 CLI」，但工具协议仍是 Claude/socode 的 `edit`，不是 Codex 的 patch。

### 3.3 Primary / Secondary

| | `b22e9f0` | **现在** |
| --- | --- | --- |
| **Primary** | Claude Code | **Claude Code（未换）** |
| **Secondary** | Codex CLI | **Codex CLI（未换）** |
| **不是** | Pi | **更不是 Pi** |

未换的原因：0.1.2/0.1.3 补的重试、`/usage`、落盘 undo、Remote-SSH 在 Claude 产品清单上都能找到对应物（`/usage`、checkpoint、Desktop SSH）。Codex 从 7.3 拉到 7.9，仍低于 9.4。Pi 的差异化是「核心极简 + 扩展平台」——这两次 commit 是反着走的。

---

## 4. socode 有没有哪里赢过 Claude Code？

上一快照的诚实答案：**有，但是利基，不是总体。** 这次要更新的是「有没有 **新的** 利基」。

### 4.1 仍然成立的利基（不是新的）

| 利基 | 为什么算赢 | 为什么不够当主力 |
| --- | --- | --- |
| 多 Provider | OpenAI 兼容向导，会话中 `/provider` `/model`；Claude Code 绑 Anthropic 账 | 模型质量、工具协议、生态仍是 Claude 强 |
| Long 编排纪律 | 独立 JSON 审批器 fail-closed、动态 P50→P75、里程碑 `verifyCommands` + rubric；**不会变成 Full** | Claude 用 hooks / 后台 / workflow 覆盖「长任务」，完成度更高 |
| fail-closed 沙箱 | Ask/Long 沙箱起不来就拒绝；Full 才警告后裸跑 | Codex 的 OS 沙箱面更完整（含 Windows）；Claude 默认路径更顺手 |
| 小到能审 | ~62 个生产 TS 文件、无运行时数据库、MIT | 功能面、发行信任、IDE 都不是一个量级 |
| Ask 完整 diff | `write`/`edit`/`delete` 在 `y/n/a` 前打 unified diff | Claude 的审批/rewind 菜单覆盖更多操作类型 |

### 4.2 这次 **新出现** 的利基

| 利基 | 证据 | 边界（不要夸） |
| --- | --- | --- |
| **Remote-SSH 灌 runtime，远端不必预装 agent** | `packRuntime` + 远端自下 Node 22 到 `~/.socode-server`；本机是显示器 | 这是对 **Claude Code CLI**（通常 `ssh -t` 再跑 `claude`）的利基，不是对整个 Claude 产品族。Claude Desktop 已有 `sshConfigs` / Remote Control / Web。socode 没有自动重连、没有 IDE。 |
| **会话级密钥注入，断开即删** | `~/.socode-server/session/providers.json` chmod 600，`finally` wipe；不覆盖远端 `~/.socode` | Claude 用自己的账密体系，不可比「谁更安全」；只是开源、多 Provider、不把 key 长期留在远端家目录这件事上更干净。 |
| **`/usage` 不编造美元** | 无 `modelPricing` 只打 token + `未标价` | Claude `/usage` 有订阅额度、活动统计，信息量更大。socode 赢在「没单价就闭嘴」。 |
| **落盘 `/undo` 但拒绝冒充 rewind** | `.socode/undo/`；文案写明不管 bash、不是对话 rewind | **能力上仍输给** Claude `/rewind`。新的只是产品诚实：不把最近一轮文件快照叫成 Checkpoint。 |

没有新的总体优势。没有 `apply_patch`、没有多轮 rewind、没有 HTTP MCP / hooks / auto-memory、没有短轮默认测——这些仍然让「关掉 Claude Code 当每天默认」不成立。

### 4.3 什么仍挡住日常主力对等

按对用户的伤害排序：

1. **`apply_patch`：** 一次调用改不相邻多处仍要连打 `edit` 或整文件 `write`。Claude / Codex 日常改代码的手感在这里。
2. **Undo 太浅：** 已跨重启，但只有一轮、不管 bash、不能回到第 N 个 prompt。用户按 `a` 之后的保险仍薄。
3. **短轮不默认测：** Long 里程碑才强制；Ask/Full 靠提示词，模型经常嘴炮完成。
4. **扩展面：** HTTP/SSE MCP、hooks、auto-memory 仍空。接团队工具链要自己包一层。
5. **评测门 / 发行：** `npm test` 不是黄金任务；macOS 包未签名。
6. **IDE / Windows：** 终端专用；Windows 不是支持平台（WSL 或 Remote-SSH 到 Unix）。

重试、`/usage`、落盘 undo、Remote-SSH 把上一快照的「装上、看见 diff、undo、doctor 绿」往前推了一截，但口令里的 **patch（多 hunk）+ 短轮跑测试 + 多轮可撤** 还没兑现。

---

## 5. 测试与环境

```
# tests 311
# pass 308
# fail 3
```

新模块抽查过：`provider retry policy`、`markdown live reprint`、`formatUsageLine`、`undo last turn` 的重启夹具、`parseConnectTarget` / runtime pack 禁打密钥。失败 3 条与上一快照同类：Long `verifyCommands` 执行时本机无 `/usr/bin/bwrap`，Ask/Long **拒绝 bash**（`src/tools.test.ts` 的 `task_state tool`、`src/verify.test.ts`）。这是生产语义，不是 0.1.3 写反断言。

未做：真实 LLM judge、真实 MCP 联调、真机 SSH 连远端、TTY 上手工点选 Ask diff / `/undo` / `/remote-ssh`。

---

## 6. 给用户的中文结论

相对 `b22e9f0`（0.1.1）只多了两版：0.1.2 补了 Provider 429/5xx 重试和思考流 stable+tail；0.1.3 把 `/undo` 落到磁盘、加上 `/usage`，并做出 Remote-SSH（本机显示器 + 远端 worker，灌 runtime、会话注入密钥、断开删除）。

**Primary 仍是 Claude Code，Secondary 仍是 Codex，不是 Pi。** 分数 9.1 / 7.3 / 3.2 → **9.4 / 7.9 / 2.9**。

socode 相对 Claude Code 的赢面仍是利基：多 Provider、Long 的 fail-closed 审批、沙箱起不来就拒绝、小代码库、Ask 完整 diff。**新多出来的**是 Remote-SSH 不必在远端预装 agent、会话密钥断开即删、以及 `/usage` 没单价就不报美元——都不是总体优势。挡住每天当主力的仍是：没有 `apply_patch`、undo 只有一轮且不管 bash、短轮不默认跑测试、没有 HTTP MCP / hooks / auto-memory。还不到能关掉 Claude Code 的完整主力。
