# socode 再检查（默认分支 fresh fetch）

对照上次已知审计：`32aa8a9`（`docs/AUDIT-LATEST.md` / 已关闭 PR #5）在 Ask 上标了 P0：`classifyBash` 只读绕过、密钥可读、`read`/`write` 不 `realpath`。用户说「检查一下新的」。本文 **只读产品代码、不改实现**。

## 1. 分析对象

**仓库：** `https://github.com/Tm-Ys/socode`  
**默认分支：** `main`（`gh repo view`：`defaultBranchRef.name = main`）  
**Fresh fetch：** `git fetch origin main` 后 `git rev-parse origin/main`

| | hash | 时间 | 说明 |
| --- | --- | --- | --- |
| **当前 HEAD（本报告对象）** | `42f3aac57a4c620b88e342416296aea342af7939` | 2026-09-15 16:41:14 +0800 | `add subagent and fix` |
| 作者 | Tm-Ys `<hanchenxu25@mails.ucas.ac.cn>` | | |
| 上次审计 HEAD | `32aa8a9545b49d82338c33cdd61cdd97dc66ed2d` | 2026-09-15 15:54:40 +0800 | `fix PR2` |
| PR #6 merge commit | `44f830cd1aeb27fd44e776be4403c5a595c30cc4` | 2026-09-15 08:24:20 +0000（= 16:24 +0800） | Long LLM judge；**不是**当前 `origin/main` tip |

`origin/main` tip **已经越过** PR #6：tip 是 `42f3aac`，PR #6 合入点是 `44f830c`。

**方法：** 通读 `src/*.ts` + `docs/LONG-MODE.md`；用 `tsx` 直接调生产函数（`classifyBash` / `createPolicy.authorize` / `readAbsoluteFile` / `realExistingPath` / `bashSpawn` / `childPolicy` / `scrubEnv`）；`npm test`。探测 **没有** 真执行 `find -delete`，也没有对仓库做破坏性写入。本机 `process.platform === "linux"`，**没有** `/usr/bin/bwrap`。

---

### 自 `32aa8a9` 以来的 commits（4 个，旧→新）

1. **`9e361f3631fbc56e57c13303d2032d12d15eb687`**  
   `2026-09-15 16:09:16 +0800`  
   `Harden Ask sandbox against PR5 findings`  
   信息体：Close classifyBash bypasses, follow symlinks, deny `.env`, scope bash grants, fail closed without OS sandbox, and log authorizations.

2. **`4056cd02274e9e1698f7eb62d3e8eb9aca6a8116`**  
   `2026-09-15 08:20:55 +0000`  
   `Add Long (长程) harness mode with TaskState and conservative pre-auth`  
   PR #6 第一笔。注册 `--mode long` / `/mode 长程`，TaskState，自动压缩，预算检查点。当时副作用仍说「confirmation」（人审）；下一笔改成 LLM judge。

3. **`44f830cd1aeb27fd44e776be4403c5a595c30cc4`**  
   `2026-09-15 08:24:20 +0000`  
   `Add Long-only LLM judge for side-effecting tool approval`  
   **PR #6 merge commit**（`gh pr view 6`：`state=MERGED`，`mergedAt=2026-09-15T08:29:49Z`）。干净上下文 JSON `{allow, reason}`；解析/超时 fail-closed。Ask/Full/Plan 仍人审。

4. **`42f3aac57a4c620b88e342416296aea342af7939`**  
   `2026-09-15 16:41:14 +0800`  
   `add subagent and fix`  
   **PR #6 之后、当前 tip。** 新增 `subagent_plan` / `subagent`。

`git diff --stat 32aa8a9..42f3aac`：31 files，`+2713 / -181`。

### 自 PR #6 merge（`44f830c`）以来（与 tip 不同）

仅 1 个 commit：

- `42f3aac` `add subagent and fix`  
  `git diff --stat 44f830c..42f3aac`：13 files，`+593 / -9`  
  新文件：`src/subagent.ts`、`src/subagent-plan.ts`、`src/subagent.test.ts`  
  改动：`src/tools.ts`、`src/permissions.ts`、`src/index.ts`、`src/system-prompt.ts`、`src/agent.ts`、`src/tool-ui.ts`、测试、`README.md`、`.env.example`（`SUBAGENT_STEPS`）。

---

## 2. 相对上次已知状态的新增

上次：`32aa8a9` 无 Long、无 judge、无 audit 模块、无 `realpath`、`classifyBash` 用 `READONLY_HEAD` 首词白名单。

### A. 安全硬化（`9e361f3`，在 Long 之前）

不是 Long 的一部分，但是「新的」里最先落地、直接针对 PR5/P0：

| 符号 / 路径 | 做什么 |
| --- | --- |
| `src/sandbox.ts` `classifyBash` | 废弃首词白名单。`READONLY_CMD` 只认无 metachar 的 `ls\|pwd\|whoami\|date\|uname\|which\|true\|false\|hostname\|id`。`SHELL_META`（`;|&\`$()<>`）一律非只读。 |
| 同文件 `realExistingPath` | 对已存在前缀 `realpathSync`，再拼不存在的尾段。 |
| 同文件 `denyReason` | `SECRET_BASENAMES`：`.env`、`providers.json`、`.env.*`（排除 `.env.example`）。 |
| 同文件 `bashEscapesWorkspace` / `extractAbsolutePaths` | Ask 下 bash 命令里的绝对路径/`~`/重定向/密钥文件名走 denylist + 工作区。 |
| 同文件 `bashHardDenied` / `bashAlwaysAsk` / `commandHead` | Ask/Long 硬拒 `sudo/su/dd/mkfs/reboot/shutdown`；`a` 授权 key 带二进制名，wrapper/解释器不能 always。 |
| 同文件 `bashSpawn` | Ask `confineWrites`：Darwin `sandbox-exec`；Linux 要 `bwrap`；**都没有则 `unavailable`，不裸跑**。Full 仍可裸 bash。 |
| 同文件 `scrubEnv` | bash 子进程去掉 `api_key` / `OPENAI_API_KEY` / `DATABASE_URL` 以及名字像 secret/token/password 的变量。 |
| `src/fs-tools.ts` `requireAbsolutePath` | 先 `realExistingPath` 再 `denyReason`。`read` 改为限额 `open`+`read`，不再整文件进内存。stdout 环形截断。 |
| `src/permissions.ts` | `read`/`search` 非 Full 限制工作区；`writeAudit` 每条授权。 |
| `src/audit.ts` `writeAudit` | 追加工作区 `.socode-audit.jsonl`（`.gitignore` 已列）。失败吞掉，不打断回合。 |
| `src/prompt.ts` `askPermission` | **回车 = 拒绝**（上次 P3-1 是回车=允许）。 |

### B. Long 模式已合入（PR #6：`4056cd0` + `44f830c`）

| 符号 / 路径 | 做什么 |
| --- | --- |
| `src/mode.ts` `AGENT_MODES` / `parseMode("长程")` | 第四模式 `long`。 |
| `src/task-state.ts` `TaskState` / `createTaskStore` / `taskStateMessage` | 会话 `system` 消息 `【task state】`+JSON；无新表。 |
| `src/tools.ts` `task_state` | **仅** `toolSpecs("long")` 出现。 |
| `src/long-approve.ts` `judgeLongApprove` / `parseJudgeReply` / `createLongApprover` | 干净上下文 JSON 审批器。 |
| `src/permissions.ts` `longSideEffect` | Long 副作用走 judge；Ask/Full/Plan **不**走。 |
| `src/compress.ts` `shouldAutoCompress` / `splitForCompress` | Long 开跑前自动压；keep 区钉住 harness mode + TaskState。 |
| `src/agent.ts` `budgetStopReason` / `stopForBudget` | Long 预算停写 `【checkpoint】`；Ask/Full/Plan 步数用尽仍 `throw`。 |
| `src/index.ts` | `--mode long`、`--budget`、`maybeAutoCompress`、`/task`、`createLongApprover`。 |
| `docs/LONG-MODE.md` | 设计说明。 |

### C. PR #6 之后才有（`42f3aac`）

| 符号 / 路径 | 做什么 |
| --- | --- |
| `src/subagent-plan.ts` `parseSubagentPlan` / `createSubagentStore` | 1–6 个 `explorer`\|`worker`。未知 `kind` **默认 `worker`**。 |
| `src/subagent.ts` `createSubagentRunner` / `childPolicy` / `runSubagent` | 子代理独立 `runAgent`；`max_depth=1`。 |
| `src/tools.ts` `subagent_plan` / `subagent` | Ask/Full/Long 可见；Plan 与 nested 子代理不可见。 |
| `src/permissions.ts` | Plan 拒派生子代理；explorer 拒 `write`/`delete`/非只读 bash。 |

**结论（有代码，不是猜测）：** Long 模式 **已合并**；LLM judge **已合并**；上次 P0 的三条 **有对应修复 commit**（`9e361f3`）；此外 tip 还多了 **subagent MVP**。

---

## 3. Long 模式清单

判定：DONE = 有接线 + 测试或本机探测；PARTIAL = 有骨架但关键语义缺口；MISSING = 无模块。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 模式接线 `--mode long` / `/mode 长程` | **DONE** | `src/mode.ts` `ALIASES`：`long` / `长程` / `long-horizon`。`src/index.ts` `loadMode(flags.mode)`、`handleMode`、usage 行。`src/commands.ts` `/mode long`、`/mode 长程`。`src/mode.test.ts` 解析 `长程`。默认仍 `MODE=ask`（`loadMode`）。 |
| TaskState | **DONE** | `src/task-state.ts`：goal / milestones / done / failures / keyFiles / verifyCommands / notes。持久化 `【task state】` system JSON；`lastTaskState` 取最后一条。`seedGoalFromUser` 在 Long 开轮把第一句当 goal（`src/index.ts`）。工具 `task_state` 仅 Long（`src/tools.ts` `toolSpecs`、`tools.test.ts`）。CLI `/task`。压缩 keep 区钉住（`src/compress.ts` `splitForCompress`，`compress.test.ts`）。 |
| 自动压缩 | **DONE（回合前） / 中途 MISSING** | Long 专有：`maybeAutoCompress` 仅 `mode === "long"`（`src/index.ts`）。触发 `shouldAutoCompress`：可压且（已丢历史 **或** used/window ≥ 0.82 **或** free 很小）。复用 `compressHistory`，没有第二套摘要器。`docs/LONG-MODE.md` 写明 **不做** agent 步中间压缩；顶满先检查点、下一轮再压。Ask/Full/Plan 仍手动 `/compress`。 |
| 预算 / 检查点 | **DONE** | `--budget` / `MAX_AGENT_TOKENS`；`runAgent` 把 `maxTokens`/`maxContextTokens` **只传给 Long**。`budgetStopReason` + `stopForBudget` 写 `checkpointReply(..., "budget")`（前缀 `【checkpoint】`）。Abort 在 Long 也打检查点（`src/index.ts`）。Ask/Full/Plan 步数满仍 `超过最大工具步数`（`src/agent.ts`）。`agent.test.ts` 覆盖 token/context/steps。 |
| `long-approve.ts` 干净上下文 JSON judge | **DONE** | `formatJudgeUser` 只有 `mode/workspace/goal/tool/arguments`，测试断言不含 chat history。`completeChat` 两条消息：`JUDGE_SYSTEM_PROMPT` + user。`summarizeApproveArgs` 对 write 只给 preview/bytes，不塞整文件。`pickJudgeProvider`：`LONG_APPROVE_MODEL`/`JUDGE_MODEL`，`thinkingEffort=none`，`maxOutput≤256`。 |
| fail-closed | **DONE** | `parseJudgeReply`：空、非 JSON、`allow` 为字符串 `"true"`、缺 reason → `{allow:false}`。超时 12s、抛错、缺 Provider → deny。`createPolicy` 无 `longApprove` → `Long 审批器未配置`（本机探测 Long write = 该句）。`longSideEffect` catch 后仍 deny。进程里 `index.ts` 会挂上 `createLongApprover`。 |
| 审计日志 | **DONE** | `src/audit.ts` → `.socode-audit.jsonl`。`authorize` 每条 allow/deny；Long judge 额外再写一条 `judge allow\|deny`。`logLongApprove` 打 `console.log`。 |
| Ask / Full / Plan 不被 Long 带跑 | **DONE（权限路径）** | `decide()`：`mode === "full"` 直接放行；`mode === "long"` 才 `longSideEffect`；否则 `askPermission`。测试：把 `longApprove` 传给 Ask，write 仍是 `用户拒绝了`，judge 调用次数 0。Plan：`toolSpecs` 仍只有 `read/search/calculate/get_current_time`；`executeTool` + `authorize` 再拒。`mutationDenied("long", …)` 工作区外写与 Ask 同类、不是 Full。**注意：** Ask 沙箱本身已被 `9e361f3` 收紧（这是安全修复，不是 Long 回归）。 |

Long **没有** 变成 Full：`confineWrites: policy?.mode !== "full"`（`src/tools.ts`），Long 与 Ask 一样开写隔离。

---

## 4. 上次 P0 再测

对生产函数实测（Ask、非 TTY：`askPermission` 返回 `"deny"`，所以「会问」表现为 `用户拒绝了…`，而不是 `null` 放行）。

### P0-1 `classifyBash` 只读绕过 — **已修（针对上次用例）**

| 命令 | `classifyBash.readonly`（现） | Ask `authorize("bash")` |
| --- | --- | --- |
| `env python3 -c "open('/tmp/x','w')…"` | `false` | 工作区外路径硬拒绝（`/tmp/x`） |
| `find . -delete` | `false` | `用户拒绝了执行命令`（不再 `null`） |
| `echo $(curl https://evil.test)` | `false` | `用户拒绝了…` |
| `python3 foo.py` | `false` | `用户拒绝了…` |
| `ls` | `true` | `null`（仍预授权） |

`src/sandbox.test.ts` 覆盖 `env python3` / `find . -delete` / `echo $(curl)` / `cat /etc/passwd` 非只读。

**残留（不确定能否再绕，不是上次那几条）：** 允许名单仍是正则，不是 AST。本机：`ls ../../etc/passwd` 的 `readonly === true`，但 `bashEscapesWorkspace` 解析到 `/etc` 后 `denyReason` 拒绝。若有命令替换/空格拆分让 `extractAbsolutePaths` 看不见目标，仍可能只靠「看起来像 `ls`」。**不标 100% 关闭。**

### P0-2 密钥 / denylist 只读进对话 — **已修（针对上次用例）**

| 探测 | 结果 |
| --- | --- |
| `authorize("read", { path: "<ws>/.env" })` | `拒绝访问受保护文件: .env` |
| `authorize("bash", { command: "cat .env" })` | 同上 |
| `authorize("read", { path: "/etc/passwd" })` | `拒绝访问受保护路径: /etc` |
| `authorize("read", { path: "~/.bashrc" })` | Ask：只能读工作区内（不再 `null`） |
| `authorize("read", { path: "<ws>/.env.example" })` | `null`（明确排除） |
| `scrubEnv({ api_key, OPENAI_API_KEY, PATH })` | 只剩 `PATH` |

`read`/`search` 非 Full 现检查 `isInsideWorkspace`（`src/permissions.ts`）。

**残留：** denylist 不是「一切密钥」。工作区里叫 `secrets.txt` / `id_rsa` 的文件，basename 不在集合里就不会挡。Full 仍可读区外非 denylist 文件。`echo $api_key` 不再只读放行，但 TTY 上用户按 `y` 仍可能把其它 env 打进对话（`scrubEnv` 已剥常见 key）。

### P0-3 `realpath` / 符号链接 — **已修**

临时目录探测：

- workspace 内 symlink → `/etc/passwd`：`realExistingPath` = `/etc/passwd`；`authorize("read")` = 受保护 `/etc`；`readAbsoluteFile` 抛同一句。**读不到 passwd 正文。**
- symlink → 区内普通文件：authorize `null`，内容可读。
- 父目录 symlink → `/tmp/...` 再 `write` 新文件：realpath 落到区外，Ask 硬拒绝创建。

上次「`readAbsoluteFile(link)` 读出 `root:x:`」这条路径 **当前不通**。

---

## 5. `npm test`

可跑。`package.json`：`"test": "tsx --test src/*.test.ts"`。本机 `npm install` 后：

```
# tests 73
# suites 23
# pass 73
# fail 0
```

上次 `32aa8a9` 是 22 pass。新增用例覆盖 Long judge、TaskState、压缩钉住、sandbox 对抗、subagent plan。`npm audit`：0 vulnerabilities。

未测：真实 LLM judge、真实 bwrap/seatbelt、TTY 下 `y/n`、子代理完整 `runAgent`（`subagent.test.ts` 在「无 plan」处停，不调 Provider）。

---

## 6. 阶段表刷新

标准仍旧：DONE = 可跑核心路径；PARTIAL = 有代码但关键语义不完整；MISSING = 无模块。

| Phase | `6c2d902` | `32aa8a9` | **`42f3aac`（现在）** | 说明 |
| --- | --- | --- | --- | --- |
| 0 Minimal MVP | DONE | DONE | **DONE** | 未拆。 |
| 1 Survive multi-turn | PARTIAL | PARTIAL | **PARTIAL** | Long 有自动压缩 + 预算检查点；Ask/Full/Plan 仍手动 `/compress`。doom 并行缺 tool 回写已补（`src/agent.ts` 给未执行 id 补拒绝）。仍无步中压缩。 |
| 2 Safety | PARTIAL | PARTIAL（P0 开着） | **PARTIAL（升高但未 DONE）** | 引用的 P0 已堵；有 audit、Ask 无沙箱则拒绝、Enter=拒绝、bash 看命令路径。仍：classifyBash 启发式、Long 副作用靠 LLM、本机无 bwrap 则 Ask/Long 的 bash **执行层**拒绝、Full 仍裸 bash。 |
| 3 UX/cost | PARTIAL | PARTIAL | **PARTIAL** | Long 增加 `--budget` / 检查点。仍无价格、无 prompt cache 指示。 |
| 4 Extensibility | PARTIAL | PARTIAL（无 subagent） | **PARTIAL** | **有** subagent MVP（Ask/Full/Long）。无 MCP、无 plugin。Plan 仍无子代理工具。 |

**Phase 2 仍不能标 DONE。** Long 也不是「Safety 完成」；文档自己写了非目标包括「修掉全部审计 P0」。P0 引用项实际是在 `9e361f3` 修的，不是 Long PR 修的。

---

## 7. 主要风险 / 下一步（最多 5）

1. **`childPolicy` 不转发 `longApprove`（`src/subagent.ts`）。** 本机：父 Long 挂上 always-allow judge 后，worker 子代理 `write` 仍是 `Long 审批器未配置`。Long 下 worker 子代理 **写不了文件**（explorer 只读是对的）。Ask 子代理走 y/n，不受这句影响。应把父 hooks（至少 `longApprove`）传进 `createPolicy`。

2. **Long 副作用的最终闸是 LLM，不是沙箱。** `long-approve.ts` 把 goal + 命令/预览送给另一模型。本地已挡密钥/区外/sudo，但区内 `rm`、宽 `git`、解释器仍可能被 judge 放行。fail-closed 只覆盖解析/超时，不覆盖「模型说 allow」。

3. **`classifyBash` 仍是正则允许名单。** `ls ../../etc/passwd` 仍标只读，靠路径抽取兜底。不要再把「只读 bash」当成硬边界；硬边界是 denylist + workspace +（有 OS 沙箱时）`confineWrites`。

4. **本机 Linux 无 `bwrap`：Ask/Long 的 `bashSpawn` 设 `unavailable`，执行会扔「无法启用 OS 沙箱…已拒绝」。** 只读 `ls` 在授权层是 `null`，到 `runBash` 才失败。Full 仍是裸 `/bin/bash`。云/CI 默认 Ask 等于 **没有可用 bash**，除非装 bwrap 或改 Full。

5. **`parseSubagentKind("nope") === "worker"`**（`src/subagent-plan.ts`，测试显式如此）。模型写错 kind 会得到可写子代理。未知 kind 更应拒绝或默认 explorer。另：压缩摘要仍是 `role: "user"`（`src/compress.ts`，上次 P2-4 未动）。

---

## 一句话

当前默认分支不是上次的 `32aa8a9`，也不是停在 PR #6：是 **`42f3aac`（Long + judge + 针对 P0 的沙箱硬化 + subagent）**。Long 清单核心项已落地；上次三条 P0 的复现用例已堵住，Phase 2 仍是 PARTIAL。
