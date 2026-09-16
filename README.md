# socode

本机终端里的编程 Agent。OpenAI 兼容模型、流式输出、工具循环、PostgreSQL 会话。

默认 **Ask**：能改仓库，写入先问你；密钥和系统路径始终碰不到。不是套壳框架——运行时只依赖 `pg`，其余是一组可直接审的 TypeScript 模块。

## 亮点

**权限是产品，不是开关。** 四种模式策略不同，不是同一套工具换个名字：

| 模式 | 适合 | 写入 / 副作用 |
| --- | --- | --- |
| **Ask**（默认） | 日常改代码 | 工作区内先 `y` / `n` / `a`；只读管道不打断 |
| **Plan** | 先看再动手 | 只能 `read` / `search` / `plan`，没有写、删、bash |
| **Full** | 你已经信任这次会话 | 直接改文件、跑命令；系统目录和密钥仍禁 |
| **Long / 长程** | 跨很多步的任务 | 只读预授权；副作用由**独立 LLM 审批**，**不会变成 Full** |

Long 的审批器拿一份干净上下文、只输出 JSON；解析失败、超时、缺字段一律拒绝。密钥、工作区外、`sudo` 在问审批器之前就被本地硬拒绝。设计说明见 [`docs/LONG-MODE.md`](docs/LONG-MODE.md)。

**失败即拒绝，OS 沙箱和应用层叠在一起。** Ask / Long 下 `bash` 在 macOS 走 `sandbox-exec`（只允许写工作区），Linux 走 `bwrap`。沙箱起不来就拒绝执行，Full 才会警告后裸跑。bash 不再靠整句正则：拆成 argv，剥掉 `env` / `timeout` / `xargs` / `bash -c`，按每一段管道分类——`ls | wc` 仍只读，`ls | tee out` / `find | xargs rm` 会升级；`$()` 和进程替换解析不了就当有副作用。另有：`.env` / `providers.json` / `~/.ssh` 等 denylist、symlink `realpath`、`git status` 的 `a` 不会扩成 `sudo`。bash 和 MCP 子进程都剥掉密钥。每次授权追加到工作区 `.socode-audit.jsonl`。非 TTY（脚本、`--input`）在 Ask 下无法弹窗，写入直接拒绝。

**长任务能接着做，但不扩大权限。** Long 把目标记在 TaskState 里（会话中的 `【task state】` 消息，不另建表）。上下文挤到约 82% 会自动压缩（轮次之间、工具步之间、以及 `context_compress`），压缩时把最新模式和 TaskState **钉在保留区**。步数默认 Dynamic P50→P75：先给一半，工具后提醒还剩几步；本段有写入/里程碑/验证才延期一次。里程碑写入 `done` 时 harness **强制**跑 `verifyCommands`，并可再过一道 fail-closed rubric。失败则撤回这次 done。步数 / token 用尽或 Esc 中止会留下 `【checkpoint】`。Ask / Full 步数用尽仍报错，只有 Long 优雅停。

**子代理是干净上下文，只读并行、写入串行。** Ask / Full / Long 可先 `subagent_plan` 再 `subagent`。Long 推荐 `localize` / `edit` / `verify`（Ask/Full 仍可用 explorer/worker）：localize 并行（Long 同时最多 2 个），edit/worker 一个接一个，verify 等写入完成后再跑。交回 JSON；verify 的 `ok` 由退出码覆盖。过程默认隐藏，`/seesubagent [序号]` 查看某一个。子代理看不到父对话，不能再开子代理。Plan 模式没有这两个工具。

**多步骤任务用 `plan` 勾着做。** 模型和权限模式无关：非平凡请求先拆成 2–8 个目标，做完一项勾一项，全部勾完必须再 `plan` 写入 review，然后才给最终结果。勾选板会打在终端上，`/seeplan` 随时看进度。`/setplan <说明>` 强制本轮必须写出计划，并激活 grill-me（未达成共识前不改代码）。计划钉在会话里的 `【plan】` 消息，压缩时和 harness mode / TaskState 一起保留。这和 Plan **模式**（只读）不是一回事，也和 Long 的 TaskState 分开。

**MCP 和 Skills 进同一套循环。** 读 Claude/Cursor 风格的 `.mcp.json`（stdio JSON-RPC），把服务器工具挂进同一套权限，名字是 `mcp__服务器__工具`。`readOnlyHint` 为真的 MCP 在 Plan 里也能用；有副作用的走 Ask / Long / Full。HTTP MCP 暂不支持。`/mcp` 看连接状态。

项目说明从用户目录到 git 根再到工作区加载 `AGENTS.md` / `CLAUDE.md`（同层 AGENTS 在前、CLAUDE 更具体）。内置基础 skill（`brainstorm` / `grill-me` / `ponytail` / `superpowers`）默认不灌全文：每轮用一次短 JSON 询问当前用户话该激活哪几个，最多 2 个，闲聊和解析失败都不注入。`/skills` 查看实际加载结果。

**终端自己就是前端。** 没有 React / Ink：流式 Markdown 差量重绘（标题、代码块、列表、粗体），工具行和失败红色，Ask 审批，子代理默认藏过程、右下角 HUD。说明见 [`docs/FRONTEND.md`](docs/FRONTEND.md)。

**上下文看得见、会话回得去。** `/context` 用色块标 system / tools / 对话 / 预留输出 / 空闲。一轮工具超过 6 次、或模型输出超过约 2400 字时，结束后打一条灰色 `recap`；**这一轮入库和后续上下文只留 recap**，需要细节请自行 grep。PostgreSQL 自动建库、迁移；短轮次仍存完整 tool trace。`npm start` 默认新会话，空对话不入库。生成中 Esc 中止当前轮：用户问题留下，半截回复不入库。连续三次同调用或同失败会停，避免空转。`/` 后有幽灵补全和 Tab。

**小到能审。** 大约 50 个 TypeScript 文件、运行时依赖只有 `pg`。权限、沙箱、Long 审批、MCP、Skills、压缩、验证、子代理、计划、recap 都有测试（`npm test`）。策略写在代码里，不藏在框架配置后面。

要达到「敢当日常主力」还缺什么、90 天建议先做什么，见 [`docs/PRODUCT-ROADMAP.md`](docs/PRODUCT-ROADMAP.md)。那份文档只写差距与验收，不改产品代码。

## 安装

需要 Node 22+ 和 PostgreSQL。

```bash
npm install
cp .env.example .env
```

在 `.env` 里填 OpenAI 兼容 Provider：

```
PROVIDER_NAME="deepseek"
MODEL="deepseek-flash"
api_key="sk-..."
BASE_URL="https://api.deepseek.com/v1"
CONTEXT_WINDOW="128000"
MAX_OUTPUT="8192"
THINKING_EFFORT="none"
DATABASE_URL="postgres://localhost:5432/socode"
SYSTEM_PROMPT=""
MAX_CONTEXT_MESSAGES="200"
MAX_AGENT_STEPS="80"
MODE="ask"
```

`THINKING_EFFORT` 可选：`none` / `minimal` / `low` / `medium` / `high` / `xhigh`。多个 Provider 存在 gitignore 的 `providers.json`。已保存的 Provider 整份生效，不再和环境变量字段混拼；没有 `providers.json` 时才用环境变量。

可选：`MAX_AGENT_TOKENS`（Long 的 token 预算）、`LONG_APPROVE_MODEL` / `JUDGE_MODEL`（Long 审批与 skill 激活模型）、`SUBAGENT_STEPS`（子代理步数，默认 24）。审批器也会选用 `providers.json` 里名为 `judge` / `fast` / `cheap` / `mini` 的项。

## 用法

```bash
npm start
npm start -- --input "你好"
npm start -- --resume
npm start -- --id <conversation-uuid>
npm start -- --steps 120 --max 200
npm start -- --mode long
```

`npm start` 默认开**新会话**。没有用户/助手内容的对话不会写入数据库；接着上次用 `--resume` 或 `/session`。`--new` 仍可用，和默认一样。

命令行还可覆盖本次进程的 `--url` / `--api` / `--model` / `--name` / `--context` / `--output` / `--effort` / `--mode` / `--budget`。`--no-stream` / `--no-agent` 关掉流式或工具。

非 TTY（例如 `--input`）在 Ask 下会拒绝写入，脚本里改文件请 `--mode full` 或 `--mode long`。

```bash
npm test
```

## 权限与沙箱

默认 **Ask**（`MODE=ask` 或 `--mode ask`）。工作区内创建、修改、删除，以及有副作用的命令，会先询问：`y` 允许、`n` 或回车拒绝、`a` 本会话同类一律允许。Esc 视为拒绝。工作区外写入直接拒绝，需要 `/mode full`。

- **Ask**：写、`edit`、删、有副作用的 `bash` 和所有 `git` 先审批，且只能在工作区内；解析后的只读管道（`ls` / `pwd` / `cat | rg`）不打断。bash 的 cwd 和重定向都不能离开工作区。
- **Full**（`/mode full`）：直接改文件和执行命令，仍禁止 `/etc`、`/usr`、`~/.ssh`、`~/.aws`、工作区 `.env` 等。
- **Plan**（`/mode plan`）：只能看和写计划。只读 MCP 可用。
- **Long**（`/mode long` 或 `/mode 长程`）：Ask 的权限边界 + 长程编排 + LLM 审批副作用。进入后维护 TaskState（`/task`）。

Long **不会**在沙箱起不来时 fallback 裸跑，也**不会**把本地已能判定的危险请求交给审批器。

## 交互命令

输入 `/` 后会按前缀提示，Tab 补全。

- `/provider` 查看当前适配；`/provider edit` 编辑；`/provider list` 列出；`/provider <name>` 切换；`/provider new` 新增
- `/new` 开新会话（空的不入库）
- `/session` 或 `/chat` 恢复历史对话
- `/context` 查看上下文占用
- `/compress` 用当前模型压缩较早对话，保留最近两轮（并钉住 harness mode / TaskState / plan）
- `/mode` 查看或切换：`full` / `ask` / `plan` / `long`（`长程`）
- `/task` 查看长程状态；`/task goal …`、`/task milestone …`、`/task note …`、`/task clear`
- `/mcp` 查看 MCP 服务器和工具
- `/skills` 查看已注入的 `AGENTS.md` / `CLAUDE.md` 和发现的 Skills
- `/seesubagent` 列出子代理；`/seesubagent [序号]` 查看某个子代理的过程（默认隐藏，只在右下角显示在跑）
- `/seeplan` 查看当前任务计划勾选进度
- `/setplan <说明>` 本轮强制按说明调用 `plan` 拆目标，并激活 grill-me 追问
- `/setworkarea` 空对话时弹出系统文件夹选择器；也可 `/setworkarea /绝对路径`。输入行空着时灰色显示 `on 路径`
- `/exit` 或 `/quit` 退出
- `Ctrl+C` 第一次红字提示，再按一次退出
- 生成中 `Esc` 中止当前轮

## 工具

| 工具 | 作用 |
| --- | --- |
| `read` / `write` / `edit` / `delete` | 绝对路径读写删（delete 只删文件；write 覆盖整文件；edit 替换一段） |
| `search` | 目录内正则搜索，可 glob |
| `bash` | 绝对 cwd 下执行，30s 超时，Ask/Long 套 OS 沙箱 |
| `calculate` / `get_current_time` | 纯本地，不走权限询问 |
| `task_state` | 仅 Long：更新 goal / milestones / done / keyFiles / verifyCommands；写入 done 时强制跑验证 |
| `plan` | 拆任务、勾进度、全部完成后审查；Ask / Full / Long / Plan 都有 |
| `subagent_plan` / `subagent` | Ask / Full / Long：规划并执行子代理（explorer 并行，worker 串行） |
| `mcp__…` | 来自 `.mcp.json` 的外部 MCP 工具 |

路径、`cwd`、`search` 的 `directory` 必须是绝对路径。

MCP 配置（`~/.socode/mcp.json` 先加载，项目 `.socode/mcp.json` / `.mcp.json` 覆盖同名）：

```json
{
  "mcpServers": {
    "echo": {
      "command": "node",
      "args": ["src/mcp-echo-server.mjs"]
    }
  }
}
```

`command` / `args` / `env` 支持 `${TOKEN}` 和 `${PKG:-default}`。示例见 `.mcp.json.example`。

## 项目说明与 Skills

启动时把说明文件拼进系统提示，**从宽到窄、后者更具体**：

1. 用户级：`~/.claude/CLAUDE.md`、`~/.socode/AGENTS.md`、`~/.socode/CLAUDE.md`
2. 从 git 根（没有 `.git` 则向上最多 12 层）走到工作区；每一层顺序为 `AGENTS.md` → `CLAUDE.md` / `Claude.md` → `.claude/CLAUDE.md` → `AGENTS.override.md` → `CLAUDE.local.md` / `AGENTS.local.md`

`CLAUDE.md` 里的 `@AGENTS.md` 会展开；已经作为独立说明加载过的文件不会重复。单文件上限 16KB。

Skills 来自各目录下的 `<name>/SKILL.md`（YAML frontmatter 的 `name` / `description` / `disable-model-invocation`）。扫描顺序后者覆盖同名：

- 内置 `skills/`（brainstorm、grill-me、ponytail、superpowers）
- `~/.claude/skills`、`~/.cursor/skills`、`~/.socode/skills`
- 工作区 `.agents/skills`、`.claude/skills`、`.cursor/skills`、`.socode/skills`

默认把可自动调用的 skill 正文一并注入（总预算约 24KB）；`disable-model-invocation: true` 的只进目录。四个基础 skill 默认不灌全文：用户发软件工程请求时，另起一次短 LLM 调用（只送原话和四张卡片），返回激活名单和一句理由，最多 2 个。闲聊不调用。点名则强制加入。`/skills` 查看目录。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | CLI、会话循环、斜杠命令 |
| `src/agent.ts` | 工具循环、doom loop、Long 预算；上下文顶满时先压缩再继续 |
| `src/permissions.ts` | 按模式授权 |
| `src/sandbox.ts` | 路径 denylist、bash 解析/分类、OS 沙箱 |
| `src/long-approve.ts` | Long 副作用的独立 JSON 审批器 |
| `src/task-state.ts` | 长程状态（活在对话消息里） |
| `src/plan.ts` | 可勾选任务计划，`/seeplan` 查看 |
| `src/workarea.ts` | `/setworkarea` 选文件夹或设绝对路径 |
| `src/verify.ts` | Long 里程碑验证：跑 `verifyCommands`，失败撤回 done |
| `src/long-budget.ts` | Long 动态步数预算、reminder、`shouldExtend` |
| `src/long-rubric.ts` | 里程碑级 fail-closed 评分 |
| `src/compress.ts` | 摘要压缩，钉住 mode / TaskState |
| `src/subagent.ts` | 干净上下文子代理：explorer 并行，worker 串行 |
| `src/subagent-ui.ts` | 子代理过程默认隐藏，`/seesubagent` 查看 |
| `src/mcp.ts` | stdio MCP hub |
| `src/skills.ts` / `src/skill-activate.ts` | 说明文件、Skills、按轮激活 |
| `src/chat.ts` / `src/provider.ts` | OpenAI 兼容流式、多 Provider |
| `src/markdown.ts` | 轻量 Markdown → TUI ANSI |
| `src/recap.ts` | 长轮次灰色回顾；触发后历史只留 recap |
| `src/db.ts` | PostgreSQL 自动建库与迁移；空会话不入库 |
| `src/context.ts` | 上下文计量与 `/context` 色块 |

## 刻意不做

- HTTP / SSE MCP（只做 stdio）
- 把 Long 做成静默 Full
- 子代理再开子代理；不给 worker 做 git worktree，共享工作区，靠串行避免同时改同一文件
