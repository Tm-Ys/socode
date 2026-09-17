# 产品级差距与 90 天路线图

本文是对 **socode 现状的产品盘点**，不是实现清单。对照实现以仓库当前代码为准（`src/`、`README.md`、`docs/LONG-MODE.md`、`docs/FRONTEND.md`、`docs/REMOTE.md`）。下文不夸大已有能力，也不把尚未落地的能力写成「已经有了」。

版本锚点：本文按 **0.1.1** 重写能力盘点；**0.1.2**（2026-09-17）补上 Provider 退避重试、思考/工具流的 stable+tail 重绘，以及远程开发文档。此前文本仍写「没有 doctor / 没有 Ask diff / 启动依赖 Postgres」，那些已经落地，不再当缺口立项。

---

## 1. 背景与对标结论

socode 的产品形状最接近 **Claude Code**：本机终端里的编程 Agent，权限模式是产品本身，工具循环、会话、项目说明、子代理、MCP 都挂在同一套策略上。它不是套壳框架——运行时 **没有数据库依赖**，其余是一组可直接审的 TypeScript 模块。

它同时带有一层 **Codex CLI 式的沙箱 / 会话意识**：Ask / Long 下 `bash` 在 macOS 走 `sandbox-exec`、Linux 走 `bwrap`；失败即拒绝（Ask / Long 沙箱起不来就拒执行）；会话在工作区 `.socode/sessions/`；压缩、任务检查点、审计日志把「这次会话发生了什么」留下来。

它 **不像 Pi**。Pi 的核心是可扩展 harness 平台。socode 的核心是 **一种具体的本机编程产品**：权限边界写死在代码里。这条路建议继续走。

一句话：**产品形态学 Claude Code，运行时气质靠近 Codex 的沙箱与会话，不要学 Pi 做平台。** 0.1.1 已经能装上、能问着改、能 doctor、能撤本轮文件写入。还没到「每天打开不会心疼」：补丁协议不够、undo 太浅、网络失败不重试、短轮不默认测、费用几乎看不见。

对标时不要按功能清单打勾。Claude Code 赢在手术刀式改文件、Checkpoint / rewind、安装路径、TUI / IDE 一体。Codex CLI 赢在沙箱默认和审批完成度。socode 已经有权限模式、OS 沙箱、Long 编排、stdio MCP、Skills、Ask 完整 diff、文件会话，这些是真的。

---

## 2. 已有能力（0.1.1，以代码为准）

写路线图时把它们当地基，不要当缺口重复立项。

### 2.1 Agent 循环

`src/agent.ts`：OpenAI 兼容 function calling、流式 delta、连续三次同一调用签名或同一工具连续失败则停。生成中 `Esc` 中止当前轮；用户问题入库，半截助手回复不入库。上下文顶满时 Long 会先压缩再继续。一轮工具超过 6 次、或助手正文超过约 2400 字时，结束后打灰色 `【recap】`，入库和后续上下文只留 recap。

### 2.2 四种模式

| 模式 | 现状 |
| --- | --- |
| **Ask**（默认） | 工作区内写 / 改 / 删、有副作用的 bash 先 `y` / `n` / `a`；只读管道不打断。git、工作区外问用户。密钥和 `sudo` 硬拒绝 |
| **Plan** | 只能 `read` / `search` / `glob` / `plan` / `question`（及只读 MCP） |
| **Full** | 直接改文件、跑命令；系统目录和密钥仍禁。沙箱起不来时警告后裸跑 |
| **Long / 长程** | Ask 的权限边界 + TaskState + 独立 LLM 审批副作用；**不会变成 Full** |

Long 审批器只输出 JSON；解析失败、超时、缺字段一律拒绝。设计见 [`LONG-MODE.md`](./LONG-MODE.md)。

### 2.3 工具

- **文件系统**：`read`（按行、限 200KB）、`write`（临时文件 + rename 原子覆盖）、`edit`（子串替换，容忍 CRLF / 行尾空白，结果带 unified diff）、`delete`（只删文件）
- **检索与执行**：`search`、`glob`（跳过 `node_modules` / `.git` 等）、`bash`（绝对 cwd，默认 30s，Ask/Long 套 OS 沙箱）
- **本地纯函数**：`calculate`、`get_current_time`
- **编排**：`plan`、`question`；Long 另有 `task_state`、`context_compress`；Ask / Full / Long 有 `subagent_plan` / `subagent`
- **MCP**：`.mcp.json` stdio，名字 `mcp__服务器__工具`

没有 `apply_patch`。`src/patch.ts` 只服务现有 `edit`（匹配策略 + 把前后文本收成 diff），不是多 hunk / 行锚点协议。系统提示要求改已有文件走 `edit`；这是提示词，不是 patch 工具。

### 2.4 会话与配置

会话是工作区 `.socode/sessions/<uuid>.json`（`src/db.ts`），换目录互不可见。`socode` 默认新会话，空对话不落盘。Provider 和 harness 默认在用户级 `~/.socode/`（`providers.json`、`config.json`）。第一次启动若目录里还有旧 `.env`，一次性迁走，之后不再读。没有 PostgreSQL。

项目说明从用户目录到 git 根再到工作区加载 `AGENTS.md` / `CLAUDE.md`。基础 skill 按轮短 JSON 激活，最多 2 个。`/skills` 查看。

### 2.5 沙箱、审计、审批 UX

Ask / Long 的 bash：macOS `sandbox-exec` 只允许写工作区；Linux `bwrap`。沙箱起不来则拒绝；Full 才警告后裸跑。git 和工作区外改为询问，批准后这一次放开 `confineWrites`。密钥路径仍硬拒绝。授权追加 `.socode-audit.jsonl`。非 TTY 在 Ask 下无法弹窗，写入直接拒绝。

Ask 对 `write` / `edit` / `delete` 在 `y/n/a` 之前打完整 unified diff（`src/ask-diff.ts`）。bash 仍是命令摘要。

### 2.6 `/undo`、`/doctor`、安装

- **`/undo`**：进程内、最近一轮 `write` / `edit` / `delete` 的写前字节副本。Esc 后已落地的仍可撤。详见 §4.4 还缺什么。
- **`/doctor` 与 `--doctor`**：Node 版本、密钥有无、sandbox-exec/bwrap、`~/.socode` 与工作区会话目录可写。
- **安装**：`bin/socode.mjs`；macOS 有 `.dmg` / `.pkg` / tar.gz。无 Postgres 硬依赖。Windows 不是支持平台，见 [`REMOTE.md`](./REMOTE.md)。

### 2.7 长程、子代理、验证

Long 的 `【task state】` 活在会话消息里。里程碑 `done` 时强制跑白名单 `verifyCommands`，可选 fail-closed rubric；失败撤回这次 done。步数 / token 用尽或 Esc 留下 `【checkpoint】`——这是 **任务状态**，不是文件快照，也不是对话 rewind。

子代理干净上下文：Long 推荐 `localize` / `edit` / `verify`；Ask/Full 仍可用 `explorer` / `worker`。写入串行，禁止嵌套子代理。

### 2.8 终端与 Provider

手写 ANSI，无 React / Ink，见 [`FRONTEND.md`](./FRONTEND.md)。`/context` 用色块标占用，并可附带 **上一轮** API 的 prompt / completion。没有 `/usage`，没有分项账本。

`completeChat`（`src/chat.ts` + `src/retry.ts`）对 429 / 5xx / 网络抖动最多 3 次，指数退避，尊重 `Retry-After`。401 等 4xx 直接抛。已经吐出 token 的半截流式不再重试。Esc 取消进行中的请求和等待。`provider.ts` 只存密钥和模型，不负责重试。流式空内容仍抛错。

### 2.9 测试

`npm test` 跑 `src/*.test.ts`。这是模块级回归，不是黄金任务评测门。

---

## 3. 产品级定义：什么叫「敢当日常主力」

用户在自己的仓库里应能做到下面这些，且默认路径不需要先搭基础设施、不需要先背一套工作流：

1. **改代码像人在改。** 补丁能锚定上下文、失败能重试、写完能核对。
2. **找得到该改的地方，改完就测。** glob / 搜索够用；短轮结束前默认尝试相关测试。
3. **十分钟内能用。** 一条命令安装；本机默认存储；向导配密钥；doctor 能说出缺什么。（0.1.1 在 macOS / Linux 上基本成立。）
4. **改错了能撤。** 不只是本进程里的文件副本；bash 副作用和跨重启也要有说法。这 **不是** 对话 rewind。
5. **中断不是灾难。** 工具有超时；网络抖动会重试；半截写入可清理；失败时停下来的语义清楚。
6. **看得见自己在干什么、花了多少。** 审批能看 diff（已有）；token / 步数 / 子代理花费有默认展示和 `/usage`。

P0 对应还没做完的 1、2、4、5 和 6 的用量部分。P1 补交互面、扩展点、记忆、评测。P2 才是多表面、远程协议 B、更强多 Agent、云端和发行信任。

---

## 4. 还没做完的 P0

原 90 天里的「本地存储 / doctor / 安装 / Ask diff / 本轮文件 undo / glob / 原子写入」已经进 0.1.1。下面这些仍挡「每天当主力」。

### 4.1 仍然没有 `apply_patch`

**为什么重要。** `edit` 已经能模糊空白、写后带回 diff、原子落地，Ask 也能在审批前看见这份 diff。日常主力仍缺 **一次调用改一个文件的多个 hunk、带行上下文锚点**。模型记错一行或要同时改函数头和函数尾时，只能连打几次 `edit`，或退回整文件 `write`。Claude Code / Codex 的竞争力很大一块在 `apply_patch`。

**现状。** 工具列表里没有 `apply_patch`。`edit` 是单段子串替换（可 `replace_all`）。没有 GNU patch / V4A 格式，没有「失败后扩大/缩小上下文再匹配」的运行时重试（只有 CRLF 和 trim 两种预备匹配）。对已存在大文件，没有策略层禁止无必要 `write`。

**目标形态。** 改已有文件的主路径改为带上下文锚点的 patch（工具名 `apply_patch`，现有 `edit` 保留作 fallback）：

- 协议里带路径、若干行上下文、要删/要加的片段；同一文件多 hunk。
- 应用失败时运行时再试：规范化换行、放宽空白、用邻近唯一锚点；仍失败则返回当前文件相关片段，而不是一句「未找到」。
- 成功后继续强制把实际 unified diff 写进 tool 结果（`edit` 已做，patch 必须同等）。
- `write` 留给新文件或真正需要重写的文件。
- 继续禁止用 bash 的 heredoc / `sed` / `python` 改文件来绕过。

**验收。** 在 200 行以上的现有 TypeScript 文件上，连续多次「改一个函数里不相邻的两处」走 `apply_patch`，零次整文件 `write`。人为制造缩进不一致时至少自动重试一次。单元测试覆盖多 hunk、锚点漂移、二进制拒绝、写失败回滚。

### 4.2 短轮不默认跑测试

**为什么重要。** Long 的 `verifyCommands` 只挂在里程碑 `done` 上。Ask / Full 的日常改动没有这条默认路径。系统提示写的是「需要测试或构建才能确认时再跑」，模型经常声称做完却没跑 `npm test`。

**现状。** `glob` 和结构化一点的 `search` 已经有了。没有符号表 / LSP。Ask/Full **不会**在 `edit` 后自动跑测试。`verify` 子代理是模型可选动作。

**目标形态。** 实质性 `edit` / `apply_patch` / `write` 之后，短轮结束前应优先跑与改动相关的最小测试（仓库已有 `npm test` / 单文件测试则用之）；用户可用偏好关掉。这不是每次按键都跑全量 CI。Ask 短轮不必套 Long 那套白名单架构，但提示或 harness 钩子要让「改完就测」成为常见轨迹。

**验收。** 黄金任务或脚本：在本仓库改 `src/agent.ts` 一处行为并配测试时，轨迹里出现测试命令，失败会阻止「声称已完成」。偏好关闭后不再强跑。

### 4.3 `/undo` 不持久、不管 bash、不是对话 rewind

**为什么重要。** 用户敢按 `a` 或把 Long 交给模型，前提是搞砸了能回到这一轮开始。现在的 `/undo` 只覆盖「这个进程里、最近一次写文件工具」——比完全没有强，但还不够当主力保险。

**现状（必须写清，避免把它当成 Checkpoint）：**

| 它是 | 它不是 |
| --- | --- |
| 进程内 `Map`，`write` / `edit` / `delete` 写前把字节读进内存 | 落盘快照；重启、崩溃、`/new`、换工作区后还在 |
| 只撤 socode 文件工具碰过的路径 | 撤 `bash`（`sed`、`npm`、`git checkout`、测试写缓存） |
| 最近一轮写入；下一轮再写才换快照 | 对话 rewind：不删消息、不把模型说辞收回去 |
| 与 Long 的 `【checkpoint】` 无关 | 任务状态恢复、git stash、Claude Code 式 session rewind |

`beginUndoTurn` 在每轮 `ask()` 开头置位；若下一轮只聊天不写文件，上一轮快照还在。这是有意的，不是 rewind。

**目标形态。** 分三层，不要混成一个命令：

1. **文件 undo（加强现有 `/undo`）**：快照进会话或工作区 `.socode/`，跨重启可撤最近 N 轮 socode 写入的文件；仍不动用户没被本轮碰过的脏文件。
2. **bash 副作用**：P0 只要求 **声明做不到** 并在 `/undo` 文案里写明；若做，限于能从写前 `stat` 到的常规文件，不宣称能反转 `rm -rf`、网络、git 历史。不要假装能 undo 一条任意 shell。
3. **对话 rewind**：明确 **不是 P0**。若以后做，应是另一条命令（例如 `/rewind`），恢复消息与可选文件快照，而不是把 `/undo` 做成人称「后悔药」。

**验收。** 固定夹具：一轮 `edit`/`write`/`delete` 后 `/undo`，工作区字节级回到该轮开始；重启进程后再 `/undo` 仍能撤（持久化落地后）。文档和欢迎语写明：不管 bash、不是 rewind。有 bash 改文件的轨迹里，`/undo` 必须提示那些路径没被跟踪，而不是静默宣称「已全部撤回」。

### 4.4 中断与失败语义（Provider 重试已落地）

**已做。** `src/retry.ts` + `completeChat`：429 / 5xx / `fetch failed` / `ECONNRESET` 最多 3 次，指数退避，可读 `Retry-After`。401 等 4xx 一次失败。Esc 取消 `fetch` 和 sleep。已经吐出 token 的流不再重试，避免 TUI 重复字。`provider.ts` 仍只是配置文件，不处理 HTTP。

**还缺。** Ask/Full 步数用尽仍抛错，只有 Long 打 `【checkpoint】`（任务态）。MCP / 长 read 没有和 bash 对齐的超时。stop-on-failure 表还没写成产品说明：权限拒绝 / 沙箱不可用 / 补丁无法应用应停本轮；测试失败交给模型修。

**验收（已覆盖）。** 单测：429 两次后成功只产生一次正文；401 不重试。

---

## 5. P1：与竞品对齐

P1 不阻塞「能改自己的仓库」，但阻塞「愿意长时间开着、愿意推荐给别人」。

### 5.1 `/usage` 与默认用量行

**为什么重要。** 子代理、Long 审批、skill 激活都是额外调用。用户只在 `/context` 里看到上一轮 prompt / completion，不知道这一轮多少步、子代理花了多少。没有 `/usage`。Long 有 token/步数硬停；Ask 没有「意外子代理爆发」的软阈值。

**现状。** `runAgent` 累计 `TokenUsage`，存在 `lastUsage` 里给 `/context` 用。没有美元估价、没有分项（主循环 / 审批 / 子代理 / 压缩）、没有跨会话账本、不默认上报。

**目标形态。** 每轮结束默认打一行：主模型 tokens、工具步数、子代理次数与 tokens、墙钟时间。`/usage` 看本会话累计。可选软/硬阈值。未配置单价时不编造金额。

**验收。** 一轮含一次子代理的对话，结束行能分开父 / 子 tokens。`/usage` 存在且与 `/context` 不抢同一块色带。

### 5.2 TUI 轨迹与 IDE 表面

Ask diff 已有。仍缺：工具轨迹可折叠展开、长 bash 可滚或外开 pager。IDE 仍可以是很薄的 app-server，核心留在 CLI。不把「再做一遍 Ask diff」立项。

### 5.3 MCP 远程传输与 hooks

stdio MCP 已落地。缺口是 HTTP / SSE（可选）和项目级 hooks（PreToolUse 等进审计日志）。不要重写 stdio 实现。不要用 MCP 代替 [`REMOTE.md`](./REMOTE.md) 的远程工作区。

### 5.4 分层记忆

`AGENTS.md` 已有。缺全局 / 会话记忆晋升。没有用户确认不得改持久记忆文件。

### 5.5 Eval / 回归套件

`npm test` 不是黄金任务门。先 5–10 个夹具：不得整文件覆盖已有大文件、工作区外写入询问或拒绝、undo 恢复、Provider 429 重试。第一期允许 mock Provider。

---

## 6. P2：更晚再做的规模化

没有可靠 patch 和更硬的 undo 就做云端执行，只是把风险搬到别人的机器上。

### 6.1 多表面与远程会话协议

把 `runAgent`、权限、会话存储抽成稳定协议。现在 `src/index.ts` 把 REPL、斜杠命令、持久化缠在一起。远程开发的产品决策见 [`REMOTE.md`](./REMOTE.md)：**先 A（ssh -t 整进程在远端），再 B（本地 TUI + 远端 worker）**。B 才是这条「远程会话协议」。90 天若做远程，只允许 A 的入口糖，不做完整 B。

### 6.2 更强的多 Agent

现状：最多 6 个子代理、localize 并行上限 2、写入串行、共享工作区。P2 若并行写入，必须先有 per-agent worktree。不要在共享工作区上多个 worker 一起 `write`。

### 6.3 云端 / 远程执行（不是远程开发）

把 bash 放到云沙箱或开发容器。当前优势是本机 OS 沙箱 + 密钥不离机。与 [`REMOTE.md`](./REMOTE.md) 的 SSH 工作区分开记账。90 天不做云端执行。

### 6.4 发行信任

已有 GitHub Release 与 macOS 安装包，未签名。P2：签名、自动更新需用户同意、默认无遥测、隐私说明。

---

## 7. 接下来的顺序（接 0.1.1）

原里程碑 2–5（存储、undo 雏形、doctor、Ask diff）已交付。不要再按那张图施工。剩余依赖：

```
[apply_patch + 写后 diff 已有，补多 hunk / 锚点]
        │
        ▼
[/undo 持久化；文案已写明只管本轮、不管 bash、不是 rewind]
        │
        ▼
[短轮改完就测  +  /usage]
        │
        ▼
[小型回归 eval]
```

Provider 429/5xx 退避已在 `src/retry.ts`。远程：文档已在 [`REMOTE.md`](./REMOTE.md)。实现最多穿插 **A：`socode ssh` 包装**。不要插入云沙箱，不要和 eval 抢。

P1 其余（MCP HTTP、hooks、分层记忆、TUI 折叠）和全部 P2 **不进当前必达**。有余力优先 `/usage` 最小集。

90 天口令更新为：在一台只有 Node 的 Linux 或 macOS 上，安装 socode，配密钥，用 Ask 对已有文件打 **patch（多 hunk）**，审批看见 diff，短轮跑测试，网络 429 能自己缓过来，`/undo` 重启后仍能回到改前，`/doctor` 为绿，`/usage` 能看见这一轮花了多少。Windows 走 SSH / WSL，见远程文档。

---

## 8. 明确非目标 / 暂缓

### 8.1 继续成立

- 不要把 Long 做成静默 Full。
- 不要在 Long 范围里重写 Linux 全量沙箱。
- 子代理不要嵌套；90 天不要给 worker 上 git worktree。
- 不要做 HTTP/SSE MCP 的同时推倒 stdio。
- 不要引入大型前端框架。
- 不要做 Pi 式可替换 harness。
- **不要把 `/undo` 做成对话 rewind。** 那是另一个产品。
- **不要把远程开发做成云端 bash。**

### 8.2 已关闭的旧缺口（不要再立项）

| 旧表述 | 现在 |
| --- | --- |
| 启动依赖 Postgres / 运行时只有 `pg` | 文件会话，无数据库依赖 |
| 没有 `bin`、没有 doctor、没有向导 | `bin/socode.mjs`、`/doctor`、`--doctor`、缺 Provider 进向导 |
| Ask 审批只有短预览 | `write`/`edit`/`delete` 完整 unified diff |
| 没有 glob | 有 `glob` |
| `edit` 只能精确匹配、write 非原子 | CRLF/trim、`atomicWrite`、edit 结果带 diff |
| 没有本轮文件 undo | 有进程内 `/undo`；剩余见 §4.3 |
| 会话在 `~/.socode/sessions/` | **不是**。会话在工作区 `.socode/sessions/`；用户级 `~/.socode/` 只放 Provider / config / MCP |

### 8.3 当前窗口明确不做

- 云端执行、远程开发容器、把密钥上传到 socode 云。
- 完整远程协议 B（本地 TUI + 远端 worker）——文档可以写，实现排在 A 之后。
- 对话 rewind、多 worker 并行写、自动 merge。
- 签名发布、自动更新、默认遥测。
- 完整 VS Code/Cursor 对标、LSP / 全语言 AST。
- 计费账户、多租户。
- Windows 原生 bash / PowerShell 工具层。

若某项提前做了，仍服从：权限失败即拒绝、不扩大 Long 权限、不把 Postgres 再变回唯一路径。

---

## 9. 附录：名称（仅统一用词）

### 9.1 命令

| 名称 | 状态 |
| --- | --- |
| `socode` | 已有 `bin` |
| `socode --doctor` / `/doctor` | 已有 |
| 第一轮 Provider 向导 | 已有 |
| `/undo` | 已有，能力见 §4.3 |
| `/usage` | **没有** |
| `/rewind` | **没有**；若做，不要叫 undo |
| `socode ssh` | **没有**；见 [`REMOTE.md`](./REMOTE.md) |
| `/memory` | 没有 |
| `/checkpoint`（文件快照列表） | 没有；勿与 Long `【checkpoint】` 混名 |

现有 `/compress`、`/context`、`/mode`、`/task`、`/mcp`、`/skills`、`/seeplan`、`/seesubagent` 保持。

### 9.2 工具

| 名称 | 状态 |
| --- | --- |
| `apply_patch` | **没有** |
| `glob` | 已有 |
| `search` | 已有 |
| `write` / `edit` / `delete` | 已有 |

### 9.3 模块

| 路径 | 职责 |
| --- | --- |
| `src/patch.ts` | 现为 `edit` 的匹配与 diff；将来才是 apply_patch 解析器 |
| `src/db.ts` | 工作区文件会话，不是 Postgres 适配器 |
| `src/undo.ts` | 进程内写前快照 |
| `src/doctor.ts` | doctor |
| `src/ask-diff.ts` | Ask 审批 diff |
| `src/retry.ts` | Provider 429/5xx/网络抖动退避 |
| `src/usage.ts` | **没有** |
| `docs/REMOTE.md` | 远程开发决策 |

### 9.4 路径

- 用户级：`~/.socode/`（`providers.json`、`config.json`、`mcp.json`、可选 skills）。
- 会话：工作区 `.socode/sessions/`。
- 审计：工作区 `.socode-audit.jsonl`。
- 持久 undo（尚未做）：应进工作区 `.socode/` 或会话 JSON，不要写到用户级以免串仓库。

---

## 10. 本文与实现的关系

本文描述差距、顺序和验收。落地另开实现 PR，按 §7 拆开。实现时若发现本文与代码不符，以代码为准改文档。
