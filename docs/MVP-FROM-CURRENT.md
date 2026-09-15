# 从当前仓库到 Coding Agent Harness MVP

基于 `main` 上的 `e761ece`（commit message: `mvp`）只读盘点。仓库名 `socode`（见 `package.json` `"name"`）。**当前实现是带 PostgreSQL 持久化的 OpenAI 兼容聊天 REPL，不是 coding agent harness。** 下文每条结论都对应真实路径/符号；未找到的模块一律标为不存在，不虚构。

源码全集仅 4 个 TypeScript 文件：

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | CLI 入口、`.env` 解析、readline 交互、会话选择 |
| `src/chat.ts` | `completeChat`：HTTP + SSE 流式补全 |
| `src/context.ts` | 历史规范化 + 按条数截断 + 组装 API messages |
| `src/db.ts` | PostgreSQL 建库/建表、会话与消息 CRUD |

仓库内无 `docs/` 其它文件、无 `test/` / `tests/` / `eval*`、无 `src/tools/`、无 `src/agent*`。`README.md` 与源码注释均为中文，故本文用中文撰写，路径与符号保持英文原名。

---

## 1. 语言、包管理、入口

**语言：** TypeScript（`tsconfig.json`：`target` ES2022，`module`/`moduleResolution` NodeNext，`strict` true）。运行时靠 `tsx` 直接执行 `.ts`，没有 `src` 之外的编译产物配置。

**包管理：** npm。`package.json` + `package-lock.json`。运行时依赖只有 `pg@^8.16.3`；开发依赖 `@types/node`、`@types/pg`、`tsx`、`typescript`。没有 ink / blessed / commander / openai SDK / vitest 等。

**入口：**

- `package.json` `"scripts.start"` / `"scripts.chat"` → `tsx src/index.ts`
- 真正的 `main()` 在 `src/index.ts`（约 L90）

**CLI，不是独立 TUI/server：**

- `README.md` 自称「最基础的 TypeScript TUI」，实际是 `node:readline/promises` 的 REPL（`src/index.ts` `readline.createInterface`），没有全屏 TUI 库。
- 无 HTTP/WebSocket server、无 Express/Fastify、无 MCP server 进程。
- 支持一次性 `--input` 与交互循环两种模式。

**参数 / 环境变量（`src/index.ts` `main` + `parseArgs`）：**

| 来源 | 键 | 用途 |
| --- | --- | --- |
| `.env` / `--url` | `BASE_URL` 或 `LLM_URL` | API 基址；`chatUrl()` 补 `/chat/completions` |
| `.env` / `--api`（别名 `--api-key`、`--key`） | `api_key` 或 `LLM_API` | Bearer token |
| `.env` / `--model` | `MODEL` 或 `LLM_MODEL` | 模型名 |
| `.env` / `--database` | `DATABASE_URL` | 默认 `postgres://localhost:5432/socode` |
| `.env` / `--system` | `SYSTEM_PROMPT` | 可选 system 文本 |
| `.env` / `--max` | `MAX_CONTEXT_MESSAGES` | 默认 `40` |
| `--input` | 一次性用户消息 | 发完即退出 |
| `--new` | 新会话 | `flagOn(flags.new)` |
| `--id` | 指定 `conversation-uuid` | |
| `--no-stream` | 关闭流式 | |

`BOOLEAN_FLAGS`（`src/index.ts` L15）包含 `"resume"`，但 `main()` **从未读取** `flags.resume`。默认行为是 `openConversation(..., { fresh })`：未传 `--new` 时自动续最近会话（等价于隐式 resume）。

`loadEnv()`（`src/index.ts` L17）手写解析 `.env`：不覆盖已有 `process.env`；支持 `#` 注释与引号剥离。模板见 `.env.example`。

---

## 2. 会话 / 消息模型与持久化

**类型**（`src/db.ts`）：

```ts
export type Role = "system" | "user" | "assistant";
export type Message = { role: Role; content: string };
```

没有 `tool` / `tool_calls` / `name` / `id` 字段。内存会话形状是 `{ id: string; messages: Message[] }`，由 `openConversation()` 返回，没有独立 `Session` 类型。

**PostgreSQL schema**（`migrate()`，`src/db.ts` L45）：

- `conversations`：`id UUID PK DEFAULT gen_random_uuid()`，`model TEXT NOT NULL`，`created_at`，`updated_at`
- `messages`：`id UUID`，`conversation_id` FK ON DELETE CASCADE，`role` CHECK `('system','user','assistant')`，`content TEXT`，`seq INTEGER NOT NULL`，`created_at`
- 唯一索引 `messages_conversation_seq_idx (conversation_id, seq)`
- 辅助索引 `messages_conversation_created_at_idx`

启动时 `connectDb()` 会连 `postgres` 库；若目标库不存在则 `CREATE DATABASE`（`adminUrl` + `quoteIdent`），再对业务库跑 `migrate()`。

**会话选择**（`openConversation`）：

1. `--id`：`conversationExists` 失败则抛 `找不到会话 ${id}`
2. 非 `--new`：`latestConversationId()`（`ORDER BY updated_at DESC, created_at DESC LIMIT 1`）
3. 否则 `createConversation(pool, model)`，消息为空数组

交互里 `/new` 调用 `createConversation` 并清空内存 `messages`（`src/index.ts` L158）。`/exit`、`/quit` 退出循环。

**写入**（`saveTurn`）：事务内 `SELECT ... FOR UPDATE`，`MAX(seq)+1/+2` 插入 **user 再 assistant** 两条，再更新 `conversations.updated_at`。失败 `ROLLBACK`。

**缺口：**

- `SYSTEM_PROMPT` **从不入库**。表允许 `role='system'`，但没有任何 `INSERT` 写 system 行。
- LLM 失败时交互模式只 `console.error`（`src/index.ts` L174），**不保存** 该轮 user 消息。
- `--input` 路径无内层 try/catch，失败走 `main().catch` 并 `process.exit(1)`，同样不落库。
- 无会话列表/删除/重命名/导出命令。
- `conversations.model` 只在创建时写入；续聊换 `--model` 不会更新该列，请求用的是当前 CLI 的 `model`。

---

## 3. System prompt 组装

**位置：** `src/context.ts` `buildApiMessages()`。

**风格：** 单一可选字符串，原样作为第一条 `role: "system"`。无分段、无 XML/Markdown 区块、无工具说明、无仓库树、无日期、无 AGENTS.md / CLAUDE.md / `.cursorrules` 读取。

调用链：`src/index.ts` `ask` → `buildApiMessages({ history, user, systemPrompt: systemPrompt || undefined, maxMessages })`。`systemPrompt` 来自 `--system` 或 `process.env.SYSTEM_PROMPT`，空字符串视为无 system。

`normalizeHistory()` 会 **丢掉** 历史里所有 `role === "system"` 的消息，因此即便将来把 system 写入 `messages` 表，组装请求时也会被跳过；每轮只注入当前环境变量里的那一段。

---

## 4. LLM 客户端 / Provider

**唯一客户端：** `src/chat.ts` `completeChat`。使用全局 `fetch`，不是 `openai` npm 包。

请求体仅三字段：`model`、`messages`、`stream`。Header：`Content-Type: application/json`，`Authorization: Bearer ${api}`。

URL 由 `src/index.ts` `chatUrl()` 规范化到 `.../chat/completions`。任何 OpenAI 兼容网关都可以（README 示例 DeepSeek：`BASE_URL=https://api.deepseek.com/v1`）。**没有** Anthropic Messages、Google、Azure 专用适配；**没有** provider 枚举或路由表。

**流式：** 默认开。解析 SSE `data:` 行，取 `choices[0].delta.content`（`parseSseLine`）。`[DONE]` 忽略。若 `Content-Type` 是 JSON 而非 `event-stream`，回退 `readJsonReply`（`choices[0].message.content`）。非流式走同一 JSON 路径，并用 `onDelta` 一次性写出全文。

**类型缺口：** `ChatCompletion` 只有 `choices.delta.content` / `choices.message.content` / `error.message`。不解析 `tool_calls`、`function_call`、`usage`、`id`、finish_reason。

**无：** 超时、`AbortSignal`、重试、backoff、fallback 模型、请求级 `max_tokens` / `temperature` / `tools`。

---

## 5. Agent loop：continue/stop、重试、步数、中断

**不存在 agent loop。** 每一轮用户回车 = 一次 `completeChat` = 一次 assistant 文本。停止条件是「模型返回一段 content」，不是 finish_reason / 无 tool_calls。

| 能力 | 现状 |
| --- | --- |
| 多步 tool 循环 | 无。无 `while` 调工具。`src/index.ts` 的 `while (true)` 只是 REPL |
| continue / stop 策略 | 无 |
| 步数上限 | 无 |
| 重试 / backoff | 无。失败即抛错 |
| doom-loop / 重复 tool 检测 | 无 |
| 中断 / cancel | 无 `AbortController`、无 SIGINT 处理（默认终止进程）、流式 `readSseReply` 无法取消 |
| 错误写回对话 | 无。错误只打 `err>`，不作为 assistant/tool 消息入库 |

---

## 6. Tools：存在哪些、如何注册

**零工具。** 全仓库无 `tools` 请求字段、无 tool schema、无 `tool_calls` 解析、无 `read` / `write` / `bash` / `search` / `git` / MCP。

`rg` 命中的 `tool` 仅来自自然语言（README 的「token」）或 `parseArgs` 的局部变量，与 agent 工具无关。

**注册机制：** 不存在。没有 `Tool` 接口、没有 registry、没有 `src/tools/`。

若要对齐 Phase 0「read/write/bash/search」，这些全部要新建。

---

## 7. Context compaction / truncation

**仅有按消息条数的硬截断，不是 compaction。**

`buildApiMessages()`（`src/context.ts`）：

1. `normalizeHistory`：跳过 system 与空 content；相邻同 role 用 `\n` 合并；去掉开头的 assistant
2. 若 `history.length > max`（`max = Math.max(2, maxMessages)`），`slice(-max)`，再去掉可能变成开头的 assistant
3. 若最后一条已是 user，丢掉它（避免与本轮 `params.user` 重复）
4. `[optional system] + history + current user`

`previewMessages(history, limit = 6)` 只用于启动时 `printContext()` 的终端预览（`src/index.ts` L78），不参与 API。

**没有：** token 计数、摘要模型、滑动窗口之外的记忆、tool 输出截断（因为没有 tool）、prompt cache breakpoint。超长单条 `content` 不会被切。

---

## 8. Permissions / sandbox / approval

**无。** 进程对文件系统/网络的权限就是运行 `tsx` 的 OS 用户权限。不调用 bash，因此也没有命令审批。

未找到：路径 allowlist、工作区根约束、danger 命令检测、人工 approval prompt、audit log、bubblewrap/docker/seatbelt sandbox。

---

## 9. Cost / usage / cache 仪表

**无。** `completeChat` 丢弃响应里可能存在的 `usage`。无 token 累计、无价格表、无 cache hit/miss、无 per-conversation 成本。`conversations` / `messages` 表也无 usage 列。

流式路径按 token 增量 `process.stdout.write`（`onDelta`），这是 UX 流式，不是 prompt-cache 友好组装（system 虽固定在 messages[0]，但无 cache 控制头或显式 breakpoint）。

---

## 10. Tests / evals

**无测试、无 eval。**

- `package.json` 没有 `test` / `lint` / `eval` script
- 无 `*.test.ts`、无 `vitest`/`jest`/`node:test` 配置
- 无黄金对话、无 tool 契约测试、无 prompt 回归套件

手工验证方式仅 README 中的 `npm start`。

---

## 11. 与 harness 完整度相关的 TODO / FIXME

全仓库（含 README、源码）**没有** `TODO` / `FIXME` / `XXX` / `HACK` / `WIP`。

可从代码直接读出的「未完成/不完整」信号（不是注释，是死代码或半截能力）：

1. `BOOLEAN_FLAGS` 含 `"resume"` 但未使用（`src/index.ts` L15 vs `main()`）
2. DB `role` 允许 `system`，但 `saveTurn` 只写 user/assistant，`normalizeHistory` 又丢弃 system
3. `ChatCompletion` 类型假设纯文本，无法演进到 function calling 而不改类型与解析
4. README 写「TUI」，实现是 readline CLI

---

## 阶段对照

判定标准：DONE = 有可运行的核心路径；PARTIAL = 有相关代码但缺 agent 语义或明显半截；MISSING = 仓库中无对应模块。

### Phase 0 Minimal MVP

目标：session + prompt + llm + loop + read/write/bash/search + basic CLI

| 块 | 状态 | 依据 |
| --- | --- | --- |
| session | **DONE** | `src/db.ts` `openConversation` / `saveTurn`；CLI `--new` `--id` `/new` |
| prompt | **PARTIAL** | 仅环境变量字符串；`buildApiMessages` 无工具/仓库上下文 |
| llm | **DONE**（聊天语义） | `completeChat` OpenAI 兼容 + SSE。缺 tool calling |
| agent loop | **MISSING** | 只有 REPL，无 tool 迭代 |
| read/write/bash/search | **MISSING** | 无 tools |
| basic CLI | **DONE** | `src/index.ts` readline + `--input` + 流式打印 |

**总体：PARTIAL。** 这是「能聊且能存历史」的 MVP，不是「能改代码」的 agent MVP。

### Phase 1 Survive multi-turn

目标：step limits、doom-loop、tool truncation、compaction、cancel、error writeback

| 块 | 状态 | 依据 |
| --- | --- | --- |
| 多轮聊天历史 | **DONE** | PG + `MAX_CONTEXT_MESSAGES` 截断 |
| step limits | **MISSING** | 无 agent 步 |
| doom-loop | **MISSING** | |
| tool truncation | **MISSING** | 无 tool |
| compaction（摘要式） | **MISSING** | 仅 `slice(-max)` |
| cancel | **MISSING** | 无 AbortSignal |
| error writeback | **MISSING** | 失败不入库；交互只打 `err>` |

**总体：PARTIAL**（只有「多轮文本聊天 + 条数截断」）；作为 harness 的 Phase 1 **MISSING**。

### Phase 2 Safety

目标：path allowlist、dangerous-command ask、audit log、optional sandbox

**总体：MISSING。** 无相关文件或符号。

### Phase 3 UX / cost

目标：更好的流式 UI、prompt-cache 友好组装、usage/cost、project memory file、model routing

| 块 | 状态 | 依据 |
| --- | --- | --- |
| 基础流式打印 | **PARTIAL** | SSE → stdout；无工具/思考区分、无 TUI 组件 |
| prompt-cache 友好组装 | **MISSING** | 无稳定分段/cache 标记；system 每轮从 env 插入 |
| usage/cost | **MISSING** | 不读 `usage` |
| project memory file | **MISSING** | 不读 `AGENTS.md` / `MEMORY.md` / 类似文件 |
| model routing | **MISSING** | 单一 `--model` / `MODEL` |

**总体：MISSING**（流式打印不够算 UX 阶段完成）。

### Phase 4 Extensibility

目标：MCP、plugins/hooks、subagents、plan mode、eval suite

**总体：MISSING。** 无 MCP client/server、无 hook、无子 agent、无 plan/ask 模式、无 eval。

---

## 总览表

| Phase | 状态 | 一句话 |
| --- | --- | --- |
| 0 Minimal MVP | PARTIAL | 聊天会话 + LLM + CLI 已有；缺 loop 与全部工具 |
| 1 Survive multi-turn | PARTIAL / 对 harness 为 MISSING | 有历史截断；无步数、取消、错误写回、compaction |
| 2 Safety | MISSING | |
| 3 UX/cost | MISSING | 仅有 token 流式 stdout |
| 4 Extensibility | MISSING | |

---

## 接下来 5 个具体里程碑

排序按依赖：先让模型能调工具并改仓库，再让循环可停可取消，再截断与压缩，再安全，再可观测。**以下仅为建议触碰文件；本 PR 不实现代码。**

### M1 — Agent loop + tool calling 管道

把「一次补全」变成「补全 → 若有 tool_calls 则执行 → 把 tool 结果写回 messages → 再补全」，直到无 tool_calls 或命中上限。

建议文件：

- 新建 `src/agent.ts`：循环、`maxSteps`、把 tool 结果编成 API messages
- 新建 `src/tools/types.ts`：`Tool` 接口（name / description / JSON schema / `execute`）
- 改 `src/chat.ts`：请求加 `tools`；解析 `choices[0].message.tool_calls` 与 `finish_reason`
- 改 `src/db.ts` `Message`：增加 `tool` role 或等价结构；`saveTurn` 改为可写多条（含 tool）
- 改 `src/index.ts`：`ask()` 走 agent loop 而非单次 `completeChat`

验收：对假 tool `echo` 能多步调用并结束。

### M2 — Phase 0 四个核心工具：read / write / bash / search

没有这四个，Phase 0 仍不算完成。

建议文件：

- 新建 `src/tools/read.ts`、`write.ts`、`bash.ts`、`search.ts`（search 可用 `rg` 子进程或受限目录 walk）
- 新建 `src/tools/registry.ts`：显式列表注册，供 `completeChat` 与 loop 共用
- 改 `src/context.ts` / 新建 `src/prompt.ts`：把工具说明编进 system 或走 API `tools` 字段（优先 API schema，prompt 里只写使用策略）

验收：`--input "列出当前目录并读 README.md"` 能真实读到 `README.md` 内容。

### M3 — 步数上限、取消、错误写回（Phase 1 骨架）

建议文件：

- `src/agent.ts`：`maxSteps`（CLI `--max-steps` / env）；连续相同 tool+args 检测后强制停
- `src/chat.ts` + `src/index.ts`：`AbortController`；SIGINT / REPL `/stop` 中止 in-flight fetch 与 bash
- `src/db.ts`：LLM/tool 失败时仍写入 user，以及一条可见的错误文本（assistant 或 tool result），避免历史「吞掉」失败轮
- `src/index.ts`：`--input` 路径与交互路径共用同一错误写回

验收：断网或故意无效 URL 时，会话里能看到错误，而不是只 stderr；Ctrl+C 能停流式请求且进程可回到 prompt（交互模式）。

### M4 — Tool 输出截断 + 真正的 compaction（Phase 1 补齐）

建议文件：

- 新建 `src/tools/truncate.ts`（或 `src/context.ts` 扩展）：bash/search 输出字符/行上限，截断说明写回 tool message
- 改 `src/context.ts`：在条数截断之外，对超长 history 做摘要槽位（可先规则拼接「更早 N 轮已省略」，不必一上来就再调模型）
- `.env.example`：`MAX_TOOL_OUTPUT_CHARS`、`MAX_CONTEXT_TOKENS`（若暂无 tokenizer，先用字符预算并在文档写明）

验收：故意 `bash` 打出超大 stdout 时，请求体不会无限膨胀；长会话仍能发出，且 system 仍在 messages 最前。

### M5 — 工作区 allowlist + 危险命令询问 + 审计日志（Phase 2 最小集）

建议文件：

- 新建 `src/safety/paths.ts`：工具路径必须落在 `process.cwd()`（或 `--root`）之内，拒绝 `..` 逃逸
- 新建 `src/safety/bash.ts`：匹配 `rm -rf`、`mkfs`、`dd`、`sudo` 等则在 TTY 询问 y/n（`--yes` 跳过，CI 默认拒绝）
- 新建 `src/safety/audit.ts`：把 tool 名、参数摘要、决策（allow/deny）、时间追加到本地文件（例如 `~/.socode/audit.log` 或项目 `.socode/audit.log`）
- 改 `src/tools/bash.ts` / `write.ts`：执行前走上述检查
- 改 `src/index.ts`：`--root`、`--yes`

**暂缓（不要塞进这 5 个里程碑）：** MCP、plugins、subagents、plan mode、eval suite、sandbox 容器、多 provider 路由、项目 memory 文件。等 M1–M5 能在真实仓库上改文件并留下审计后再做 Phase 3/4。

---

## 诚实的能力边界

当前 `socode` 适合作为 harness 的 **会话层 + LLM 传输层** 起点：`src/db.ts` 的会话模型和 `src/chat.ts` 的 SSE 客户端可以保留。不要把它当成已有半套 agent——工具、循环、权限、评测在磁盘上都不存在。下一步的唯一正确增量是 M1+M2，而不是先做 MCP 或 TUI 美化。
