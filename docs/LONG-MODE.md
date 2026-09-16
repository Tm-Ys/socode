# Long（长程）模式

面向「做一件要跑很久的事」：记住目标、压缩上下文、计划–执行–验证、预算用尽时留下检查点。权限上它**不是 Full**。

对照实现：`src/mode.ts`、`src/task-state.ts`、`src/verify.ts`、`src/long-budget.ts`、`src/long-rubric.ts`、`src/permissions.ts`、`src/long-approve.ts`、`src/agent.ts`、`src/compress.ts`、`src/index.ts`。

## 为什么要单独一种模式

Ask 适合短轮、每步审批。Full 适合你已经信任这次会话的写入。Plan 只看不动手。长任务夹在中间：

- 上下文会被丢掉或需要手动 `/compress`
- 目标散落在对话里，压缩后容易忘
- 频繁 y/n 会打断节奏，但把 Long 做成 Full 会扩大已有沙箱漏洞

所以 Long 是 **Ask 的权限边界 + 长程编排 + 独立 LLM 审批副作用**。只读仍本地预授权；副作用既不对用户 y/n，也不盲目放行。

## 架构

```
CLI --mode long / /mode long / /mode 长程
        │
        ▼
  mode.ts  注册 AgentMode="long"
        │
        ├─ system-prompt.ts   长程循环说明 + 当前 TaskState
        ├─ tools.ts           多一个 task_state；bash 仍 confineWrites
        ├─ permissions.ts     与 Ask 同沙箱；read/search 预授权
        ├─ long-approve.ts    Long 独有：干净上下文 JSON 审批器
        ├─ compress.ts        接近窗口或已经在丢历史时自动压缩
        ├─ agent.ts           步数 / token / 上下文预算用尽则优雅停；context_compress
        ├─ long-budget.ts     Dynamic P50→P75 + 延期门
        ├─ long-rubric.ts     里程碑 fail-closed 评分
        ├─ verify.ts          写入 done 时强制跑 verifyCommands
        └─ task-state.ts      内存 TaskStore + 会话里的【task state】消息
                    │
                    ▼
              PostgreSQL messages.payload 旁的 system 文本
              （不新增表；和【harness mode】一样活在对话里）
```

会话切换、`/compress`、`replaceMessages` 都能带上最新 TaskState：压缩时会把最新 harness mode、TaskState 和 plan **钉在 keep 区**，不让摘要把目标吃掉。

## TaskState

```ts
type TaskState = {
  goal: string;
  milestones: string[];
  done: string[];
  failures: string[];
  keyFiles: string[];
  verifyCommands: string[];
  notes: string;
  updatedAt: string; // ISO
  lastVerify?: LastVerify;
  verifyRubric?: VerifyRubric;
  lastRubricScore?: RubricScore;
};
```

持久化：`role=system` 且正文以 `【task state】` 开头，后面是 JSON。取历史里**最后一条**为当前状态。

来源：

1. 进入 Long 且 goal 为空时，把用户第一句有效输入当成 `goal`
2. 模型调用 `task_state`（仅 Long 出现在 tool specs）
3. 用户 `/task`、`/task goal …`、`/task milestone …`、`/task note …`、`/task clear`

检查点：预算停、用户 Esc 中止时再写一条 TaskState，并对用户打 `【checkpoint】` 摘要。同一会话下一轮接着做。

## 循环上相对 Ask/Full/Plan 的改动

1. **提示词** 明确 search → read → 小改；里程碑写入 done 时 harness 强制跑 `verifyCommands`；用 `task_state` 记账；禁止用另一种命令绕过拒绝。
2. **自动压缩** 仅 Long：`shouldAutoCompress` 在「对话够长可压」且（已丢历史 **或** 占用 ≥ 82% 窗口 **或** free 很小）时，在开跑 agent 前复用现有 `compressHistory`。工具步之间上下文到约 82% 预算时也会压，压完再继续。不另做一套摘要器。
3. **预算** `--steps` / `MAX_AGENT_STEPS` 以及 `--budget` / `MAX_AGENT_TOKENS`。Long 用尽后**不抛**「超过最大工具步数」，而是返回检查点回复。Ask/Full/Plan 仍抛错。token 预算满仍立刻停（压缩省不了已花掉的 usage）。
4. **Doom loop** 沿用现有连续三次同调用 / 同失败即停，Long 额外在提示里强调。

## 权限策略

| 操作 | Long | Ask | Full | Plan |
| --- | --- | --- | --- | --- |
| 工作区 `read` / `search` | 本地预授权 | 预授权 | 允许 | 允许 |
| 工作区外读 | 本地拒绝 | 拒绝 | 允许（denylist 除外） | 拒绝 |
| 工作区 `write` / `edit` / `delete` | **LLM 审批** | y/n/a | 允许 | 拒绝 |
| 只读短 bash（`ls`/`pwd`…） | 本地预授权 | 预授权 | 允许 | 拒绝 |
| git / 网络 / 解释器 / 其它 bash | **LLM 审批** | y/n/a | 允许 | 拒绝 |
| `sudo` 等 | 本地硬拒绝 | 硬拒绝 | 不走 Ask 硬拒绝 | 拒绝 |
| OS 写隔离 `confineWrites` | 开 | 开 | 关 | （无 bash） |
| `.env` / 系统路径 | 本地拒绝 | 拒绝 | 拒绝 | 拒绝 |

Ask/Full/Plan **不会**调用 Long 审批器。即使把 `longApprove` 传进 `createPolicy`，Ask 仍走用户 y/n。

Long **不会**：

- 把 `classifyBash` 放宽，或把 Long 当成 Full
- 在沙箱起不来时 fallback 裸跑
- 在本地已能判定的 P0 类问题上问审批器（symlink/密钥/区外/sudo 先硬拒绝）

## Long 独有：LLM 自动审批

副作用若通过本地硬拒绝，**不**对用户弹 y/n，也**不**直接允许，而是发起一次**全新、无历史**的 LLM 调用（`src/long-approve.ts`）。

只发给审批器：

- 工具名 + 截断后的参数（bash 命令；write 只给 path / 字节数 / 预览；edit 给 path / old / new 预览，不塞整文件）
- `mode: long`、workspace、TaskState 的 goal
- 严格的 system prompt（`JUDGE_SYSTEM_PROMPT`）

**没有**对话历史、没有先前工具输出。

### 输出 schema

只接受一个 JSON 对象（可夹在 markdown 代码块里，解析时取第一个 `{` 到最后一个 `}`）：

```json
{ "allow": true, "reason": "与目标相关的小改动" }
```

中文键等价：

```json
{ "允许": false, "原因": "会覆盖密钥文件" }
```

`allow` / `允许` 必须是 JSON 布尔；`reason` / `原因` / `理由` 必须是非空字符串。

### 失败即拒绝

- JSON 解析失败、缺字段、`allow` 是字符串 `"true"` → deny
- 审批 LLM 抛错、超时（默认 12s）、缺 Provider → deny
- `createPolicy` 未挂 `longApprove` → deny（测试默认如此；进程里 `index.ts` 会挂上）

允许/拒绝及原因会 `console.log` 一行 `long-approve allow|deny  <tool>  <reason>`，并写入 `.socode-audit.jsonl`。

### 模型

优先 `LONG_APPROVE_MODEL` 或 `JUDGE_MODEL`（同一套 URL/Key）；否则若 `providers.json` 里有名为 `judge` / `fast` / `cheap` / `mini` 的项就用它；再否则用当前 Provider，但 `thinkingEffort=none`、`maxOutput≤256`。

## 压缩 / 预算 / 检查点

- 压缩器：`src/compress.ts` 的 LLM 摘要。用户手动 `/compress` 仍按用户轮切；Long 循环内和 `context_compress` 按 **ReAct 步**切，钉住 harness mode / TaskState / Plan，丢掉 `【turn budget】` 瞬时提醒。
- 触发：Long 每轮开始前看 `measureContext`；**工具步之间**上下文到约 82% 预算时也会压；模型也可调用 `context_compress`（节流：刚压过不能连着压）。压不动或仍超限才停并留检查点。
- 步数预算（More with Less）：默认 **Dynamic P50→P75**（`--steps` 80 → 先 40，有进展才一次加到 60）。每步工具后注入 `【turn budget】You have X turns left`（不入库用户回复）。延期门比论文严：本段要有成功写入 / 里程碑前进 / 验证命令通过，且非 doom、非纯 read。Token / 上下文预算仍硬停。`LONG_BUDGET_POLICY=fixed|unlimited` 可关延期。
- 检查点消息前缀：`【checkpoint】`。TaskState 本身才是可恢复的机器状态。

## Long 子代理与里程碑门

Long 推荐 `localize` / `edit` / `verify`（Ask/Full 仍可用 explorer/worker）。localize 并行上限 2；edit/worker 串行；verify 等写入完成后再跑。子代理最终应回 JSON；verify 的 `ok` 由 bash 退出码覆盖。`add_done` 仍强制跑 `verifyCommands`；若会话挂了评分器（`src/long-rubric.ts`），还要通过 fail-closed 的仓库接地 rubric（四轴、权重 3 必须全过、加权 ≥ 0.7）。

设计以本文件的已实现行为为准。

## 怎么试

```bash
npm start -- --mode long
# 或进入后 /mode long  /mode 长程
# /task
# /task goal 把 Ask/Full/Plan 的模式体系补上 Long
```

环境变量：`MODE=long`。可选 `MAX_AGENT_TOKENS`、`--budget`、已有的 `--steps`、`LONG_APPROVE_MODEL` / `JUDGE_MODEL`、`LONG_BUDGET_POLICY`（`dynamic` / `fixed` / `unlimited`）、`LONG_BUDGET_DYNAMIC`（`50-75` 或 `25-50`）。

## 阶段

1. **本 PR（MVP）** 模式注册、TaskState、只读预授权、Long 独有 LLM 审批副作用、自动压缩钩子、预算停、`/task`、文档与测试。
2. **更强本地检测** 继续收紧 symlink / bash 只读误判等 P0，减少审批器需要看见的危险请求。
3. **循环内压缩** 已做：工具步之间调用 compress（Long 按 ReAct 步）；另有 `context_compress` 工具。
4. **更强验证** 已做：里程碑 `add_done` 强制 `verifyCommands`；可选 Agentic Rubric 合取；verify 子代理退出码覆盖 `ok`。
5. **动态步数预算** 已做：默认 Dynamic P50→P75 + reminder + 严 `shouldExtend`。

## 非目标

- 把 Long 做成静默 Full
- Linux 全量沙箱重写（仍依赖 bwrap；没有就拒绝副作用 bash）
- 修掉全部审计 P0（它们是「更激进预授权」的阻断项，不是本模式的范围）
- MCP / 子代理由独立模块负责；Long 只套同一套权限边界，验证命令是测试白名单，再走沙箱和本地硬拒绝，不经审批器

## 与 Ask/Full/Plan 的兼容

默认仍是 `MODE=ask`。`userPrefix` / `modeRules` 为 Long 单列，避免掉进 Ask 分支。Plan 仍然去掉 write/bash；Full 仍然 `mode === "full"` 才关隔离。测试覆盖 Long 读预授权、副作用走 mock 审批器、本地硬拒绝不调用审批器、Ask 仍 y/n、`task_state` 只在 Long 出现。
