# socode vs Pi / Codex CLI / Claude Code（2026-09-18，0.1.3-fix2）

对照对象：`https://github.com/Tm-Ys/socode` 默认分支 `main`。

| | |
| --- | --- |
| **分析 commit** | `c13c1f26fe83036999d048b1d651da43330772c9` |
| **版本** | `0.1.3-fix2` |
| **时间** | 2026-09-18 10:54:31 +0800 |
| **说明** | `Rename the sandbox hotfix release to 0.1.3-fix2.`（产品增量在前一 commit） |
| **方法** | `git fetch origin main` 后通读 `528fb32..c13c1f2` 全文 diff，并核对 `src/sandbox.ts`、`src/tools.ts`、`src/verify.ts`、`src/sandbox.test.ts`、`README.md`、`docs/PRODUCT-ROADMAP.md`、`docs/REMOTE.md`；`npx tsx --test src/*.test.ts` |
| **上一快照** | `main@528fb32`（2026-09-18）：Claude **9.4** / Codex **7.9** / Pi **2.9**。Primary Claude Code，Secondary Codex，不是 Pi。当时相对 0.1.1 已落地：Provider 退避重试；落盘 `/undo`（`.socode/undo/`）；`/usage`；Remote-SSH（本机显示器 + 远端 worker、runtime 注入、会话密钥断开即删）；stable+tail 流；MIT。当时仍缺：`apply_patch`；更深 undo/rewind（bash、多检查点）；Ask/Full 短轮默认测；HTTP MCP / hooks / auto-memory；eval 门；未签名包；无 IDE。 |

分数是「socode 的产品形状有多像对方、以及算不算同一类日常主力 CLI」，不是「socode 有多强」。10 = 同一类日常主力；0 = 几乎不重合。Headline 刻度对齐上一快照（9.4 / 7.9 / 2.9），便于直接加减。

**结论先说：** Primary 仍是 **Claude Code**（未换），Secondary 仍是 **Codex CLI**（未换，锁得更死），不是 Pi。Claude **9.4 → 9.4**；Codex **7.9 → 8.3**；Pi **2.9 → 2.8**。这一版只做一件事：把 Ask/Long 的 bash OS 沙箱收成 Codex **workspace-write**。没有新工具、没有更深 undo、没有短轮默认测。

上一快照点名的缺口 **一个都没补上**。新补的是 0.1.3 沙箱语义里那条相对 Codex 的洞：批准 git / 工作区外之后不再整段摘掉沙箱。

---

## 1. 当前 HEAD 与相对 `528fb32` 的增量

| | |
| --- | --- |
| 上一快照 | `528fb32c074ac3881066078e3180e425139d2559` · `Ship 0.1.3 with Remote-SSH display/worker split, session provider inject, and host history.` · **0.1.3** |
| 中间 | `4327a4b895c5032fba98a657147e3be20814ab8c` · 先打成 **0.1.2-fix2**（版本号写错） |
| **当前 HEAD** | `c13c1f26fe83036999d048b1d651da43330772c9` · **0.1.3-fix2** |
| 间隔 | **2 个 commit**，`+360 / −83`，11 files |

```
c13c1f2 Rename the sandbox hotfix release to 0.1.3-fix2.
4327a4b Ship 0.1.2-fix2 with Codex workspace-write sandbox.
528fb32 Ship 0.1.3 with Remote-SSH display/worker split, session provider inject, and host history.
```

`package.json` `"version": "0.1.3-fix2"`。第二个 commit 只把 `0.1.2-fix2` 字符串改成 `0.1.3-fix2`（README / FRONTEND 欢迎框 / mcp `clientInfo` / lockfile）。产品增量全部在 `4327a4b`。

### 1.1 产品能力（有文件证据）——只记相对 0.1.3 的移动

| 能力 | 证据 | 相对 `528fb32` |
| --- | --- | --- |
| Ask/Long bash 对齐 Codex workspace-write | `src/sandbox.ts` `resolveBashSandbox` / `writableRoots` / `tmpWritableRoots` / `protectedWritePaths` / `bwrapArgs` / `seatbeltProfile` | **新语义**。可读大部分磁盘；可写 = 工作区 + `/tmp`（及 `TMPDIR` / `/var/tmp`，Darwin 含 `/private/tmp`）；`.git` 与 `.socode/sessions` 只读 |
| 默认断网 | `bashNeedsNetwork`；seatbelt `(deny network*)(allow network-outbound (remote unix-socket))`；bwrap `--unshare-net` | **新**。`ls` / `npm test` / `git status` 不开网；`curl` / `wget` / `npm install` / `git fetch|pull|push|clone` 等才开网 |
| 批准 git / 区外 **不再整段摘沙箱** | `src/tools.ts`：删除 `confineWrites: !lift`；改为 `resolveBashSandbox(...)`。`askGit.confineWrites === true`，只把 `protectGit` 设为 false | **修洞**。0.1.3 批准 git 或 `bashTouchesOutside` 后该次 OS 写隔离关掉。现在只加那块 `extraWritable` 根（`.git` 或目标目录），沙箱还在 |
| `/tmp` 本来就可写，不再被当成「区外抬沙箱」 | `isTmpWritablePath`；`echo hi > /tmp/x` 的 `extraWritable` 为空、`confineWrites` 仍 true | **新**。0.1.3 把 `/tmp` 当工作区外，批准后会 `lift` |
| Long `verifyCommands` 走同一套沙箱决议 | `src/verify.ts` `runVerifyCommands` 调 `resolveBashSandbox("long", ...)` | **跟上**。不再手写 `{ confineWrites: true }`（旧代码也 confine，但没有断网 / tmp / git 雕花） |
| 文档 | README 沙箱段、Ask 模式说明；`docs/PRODUCT-ROADMAP.md` §2.5；`docs/REMOTE.md` 版本锚到 0.1.3-fix2 | **文档**。路线图顺手改了几处 0.1.3 已过时的 Remote B 句子，不是新功能 |

测试：`src/sandbox.test.ts` 新增 `describe("Codex-style workspace-write sandbox")` 6 条（tmp 根、网络启发式、Ask/Long 保持 confine、区外根不加 `/`、`.git`/sessions 只读、seatbelt/bwrap 策略字符串）。

### 1.2 明确没有在这两次 commit 里动的（0.1.3 已有，不要当新能力）

这些在 `528fb32` 已经存在，**不要写成 0.1.3-fix2 新能力**：

- Provider 429/5xx/网络抖动退避（`src/retry.ts`）；半截流不重试
- 思考/工具流 stable+tail 重绘
- `/usage` + 每轮 token 行；没单价写 `未标价`
- `/undo` 落在工作区 `.socode/undo/`（重启 / Remote 再连同一目录仍可撤）
- Remote-SSH：`/remote-ssh`、`socode connect`；灌 `socode-runtime`；会话 `providers.json` 断开删除；主机历史
- MIT；`/doctor`；Ask 完整 unified diff；git/区外 **询问**（问人这层没变，变的是批准之后的 OS 策略）
- Ask / Plan / Full / Long、stdio MCP、Skills、`question`、子代理、rubric / `verifyCommands`、JSON 会话、macOS 包

工具表 **没有新名字**。没有 `apply_patch`。没有 `/rewind`。没有 HTTP MCP。

### 1.3 沙箱现在的真实边界（避免写成「已经和 Codex 一样」）

证据：`src/sandbox.ts`。Ask / Long 仍 fail-closed：没有 `sandbox-exec` / `bwrap` 就拒绝；Full 才警告后裸跑。

| 它是 | 它不是 |
| --- | --- |
| Codex **workspace-write** 的本地近似：读广、写工作区+tmp、默认断网、`.git` 只读直到批准 git | Codex 的 `read-only` / `workspace-write` / `danger-full-access` 三档配置（`config.toml`）。socode 用 Ask/Long ≈ workspace-write，Full ≈ danger-full-access，Plan 直接不给 bash |
| 批准 git 后只让 `.git` 可写（`protectGit: false`），批准区外路径只加那块根 | 用户可配的 `writable_roots` / `network_access`。网络靠 argv 启发式，不是域名允许名单 |
| Linux `bwrap` `--unshare-net` + `--bind` 可写根 + `--ro-bind` 保护路径 | Codex Linux 的 landlock+seccomp；Windows 沙箱。socode Windows 不是支持平台 |
| 解析不了的 bash **当作需要出网**（`parseBash` 失败 → `bashNeedsNetwork` true） | Codex 默认断网直到显式打开。这是 fail-open 网络，不是 fail-closed |
| 区外文件的可写根取 `dirname`；`~/outside.txt` 会把整个 `$HOME` 加成可写根（仍拦 denylist / 密钥路径，且不会加 `/`） | Codex `--add-dir` / `writable_roots` 的窄目录。这是剩余粗糙度 |

应用层 denylist、`scrubEnv`、审计 `.socode-audit.jsonl`、非 TTY Ask 拒写入：**未改**。

---

## 2. 当前能力盘点（只写相对 0.1.3 有没有动）

约 62 个生产 `.ts` + 50 个 `*.test.ts`（`src/*.ts` 共 112）。与 0.1.3 文件数相同。运行时 **没有数据库依赖**。

### 2.1 动了的：沙箱 / bash 执行路径

- `executeTool("bash")` 一律 `resolveBashSandbox(mode, workspace, cwd, command)`。
- Full：`confineWrites: false`，`allowNetwork: true`，`protectGit: false`（与 0.1.3 Full 警告后裸跑一致；macOS 仍可套一层 seatbelt 禁写密钥目录，失败才 fallback）。
- Ask / Long：始终 `confineWrites: true`。git 命令 `protectGit: false` 且 `extraWritable` 可含 `.git`；区外绝对路径进 `extraWritable`；`/tmp` 已在默认可写根里。

### 2.2 没动的（不要当这版新故事）

| 面 | 现状（与 0.1.3 相同） |
| --- | --- |
| 工具 | `read` / `write` / `edit` / `delete` / `search` / `glob` / `bash` / `plan` / `question` / Long `task_state`+`context_compress` / 子代理 / stdio MCP。**没有** `apply_patch`。`edit` 仍是单段子串 + CRLF/trim |
| 权限模式 | Ask 默认询问；Plan 只读；Full 直接干；Long = Ask 边界 + LLM JSON 审批，**不会变成 Full** |
| MCP | 仅 stdio。`src/mcp-config.ts` 遇到 `type: http\|sse` 或 `url` 直接报错 |
| 会话 | 工作区 `.socode/sessions/`；Remote 写远端工作区。无 fork / archive / `/tree` |
| `/undo` | `.socode/undo/` 最近一轮 write/edit/delete；不管 bash；不是 rewind |
| `/usage` | 每轮 token 行 + 会话累计；无父/子/审批分项 |
| Remote-SSH | 协议 B 已在 0.1.3。没有 `socode ssh`（A 的 `ssh -t` 包装） |
| 短轮验证 | 系统提示「需要测试或构建才能确认时再跑」。只有 Long 里程碑强制 `verifyCommands` |
| 发行 | macOS 包未签名。无 IDE。无 eval 黄金任务门 |

### 2.3 相对「日常主力」仍缺

和 `528fb32` 快照 **同一张表**。hotfix 没有划掉任何一行。

| 缺口 | 现状 |
| --- | --- |
| 手术刀 patch | **没有** `apply_patch` 多 hunk 锚点 |
| `/undo` 深度 | 已落盘、跨重启；仍只最近一轮、不含 bash、不是 rewind |
| 短轮验证 | Ask/Full 不默认跑测试 |
| 扩展 | 无 HTTP MCP、无 PreToolUse hooks、无 auto-memory |
| 评测门 | 只有 `npm test` 模块回归 |
| 发行 / IDE | 未签名；无 IDE；Windows 不是支持平台 |

沙箱那条「批准 git 就整段摘隔离」**不再是缺口**。它也从来不是上一快照的日常主力 blocker，只是 Codex 对齐度上的洞。

---

## 3. 三家对照与重打分

公开产品形状相对 9 小时前的 0.1.3 快照 **没有需要改表的大新闻**。Claude Code 仍是意见化本机编程产品（Edit/Write + `/rewind` + IDE + HTTP MCP + hooks）；Codex CLI 仍是沙箱默认的会话型 CLI（`apply_patch` + workspace-write）；Pi 仍是最小可扩展 harness（默认四工具，权限/沙箱/MCP/SSH 留给扩展）。

socode 落点只动沙箱这一格：

- **更像 Codex（这是本版唯一方向）：** Ask/Long 现在按名字对齐 workspace-write（读广、写工作区+tmp、默认断网、`.git` 只读、额外可写根而不是 unsandbox）。仍缺 `apply_patch`、fork/archive、`codex mcp-server`、Windows / landlock、可配 `writable_roots`。
- **对 Claude 几乎不动：** 没有 rewind、没有 HTTP MCP、没有 hooks、没有 IDE、没有 `apply_patch`。默认断网和 Claude 文档里的 Bash 沙箱有一点重合，但 Claude 默认带 `dangerouslyDisableSandbox` 逃生口；socode Ask/Long 仍然没有这条口。
- **更不像 Pi：** 把 Codex 式 OS 沙箱更深地写进核心循环。Pi 文档仍把 sandboxing 列成扩展。

### 3.1 分维（0–10；括号内为相对 `528fb32`）

| 维 | Claude | Codex | Pi |
| --- | --- | --- | --- |
| 工具面 | 8.7 (0) | 7.2 (0) | 7.0 (0) |
| 权限模式 | 9.1 (0) | 7.9 (+0.3) | 1.7 (−0.1) |
| 沙箱 | 7.9 (+0.1) | 9.5 (+0.5) | 1.9 (−0.1) |
| MCP | 7.5 (0) | 6.0 (0) | 1.5 (0) |
| 会话 | 8.4 (0) | 7.7 (0) | 5.7 (0) |
| 子代理 | 8.0 (0) | 5.0 (0) | 3.0 (0) |
| Skills / 说明 | 8.5 (0) | 4.5 (0) | 6.5 (0) |
| TUI | 8.6 (0) | 8.0 (0) | 5.3 (0) |
| Doctor / 安装 | 8.2 (0) | 7.7 (0) | 3.0 (0) |
| Undo | 7.3 (0) | 6.8 (0) | 2.7 (0) |
| Long / 验证 | 8.6 (0) | 6.2 (+0.1) | 3.5 (0) |
| 哲学（产品 vs 平台） | 9.5 (0) | 7.3 (+0.3) | 2.1 (−0.1) |

涨分来源几乎全在 Codex 的沙箱 / 权限 / 哲学：

- **沙箱 9.0 → 9.5：** 0.1.3 已经有 seatbelt/bwrap + fail-closed，所以早就接近 9；扣分项是「批准 git/区外就 `confineWrites: false`」。这版补上 tmp 可写、默认断网、保护 `.git`、额外可写根。不到 10：Linux 不是 landlock、无 Windows、网络启发式在解析失败时 fail-open、区外根可能宽到 `$HOME`。
- **权限 +0.3：** 问人的策略没变；变的是批准之后 OS 仍在。更像 Codex「workspace-write + 额外 writable root」，不像「审批通过 = 摘沙箱」。
- **哲学 +0.3：** commit / README 自己写「对齐 Codex workspace-write」。产品路线更明确：形态学 Claude，运行时气质跟 Codex 沙箱。
- **Claude 沙箱只 +0.1：** 网络隔离也出现在 Claude Code 沙箱文档里，但本版是在抄 Codex 的档位名和默认断网，不是在抄 Claude 的域名允许名单 / 逃生口。Headline 不够因此抬到 9.5。
- **工具面 / MCP / Undo / TUI / `/usage` / Remote 全 0：** 那些是 0.1.2/0.1.3 的故事。

### 3.2 Headline 总分（对齐上一快照刻度）

| | `528fb32` 快照 | **现在 `c13c1f2`** | Δ |
| --- | --- | --- | --- |
| **Claude Code** | 9.4 | **9.4** | **0** |
| **Codex CLI** | 7.9 | **8.3** | **+0.4** |
| **Pi** | 2.9 | **2.8** | **−0.1** |

未打到 9.5+：Claude 仍有 rewind 历史、可修复 doctor、HTTP MCP、hooks、auto-memory、IDE、`apply_patch`。未让 Codex 反超：缺 `apply_patch` 协议和会话层 fork/archive/MCP-server。Codex +0.4 是因为沙箱语义终于对上它的招牌档位，不是因为工具协议变了——改文件的主路径仍是 Claude/socode 的 `edit`。

### 3.3 Primary / Secondary

| | `528fb32` | **现在** |
| --- | --- | --- |
| **Primary** | Claude Code | **Claude Code（未换）** |
| **Secondary** | Codex CLI | **Codex CLI（未换）** |
| **不是** | Pi | **更不是 Pi** |

未换的原因：hotfix 让 Secondary 更像 Codex，但日常改代码的手感、检查点、MCP/hooks、IDE 仍在 Claude 那一侧。8.3 仍低于 9.4。没有发生「该改 Primary」的事件。

---

## 4. socode 有没有哪里赢过 Claude Code？

上一快照的诚实答案：**有，但是利基，不是总体。** 本版只更新沙箱这一条利基。

### 4.1 仍然成立、不是新的（0.1.3 已写过）

| 利基 | 为什么算赢 | 为什么不够当主力 |
| --- | --- | --- |
| 多 Provider | OpenAI 兼容向导，`/provider` `/model` | 模型质量、工具协议、生态仍是 Claude 强 |
| Long 编排纪律 | 独立 JSON 审批器 fail-closed、动态预算、里程碑 `verifyCommands` + rubric；**不会变成 Full** | Claude 用 hooks / 后台 / workflow 覆盖长任务，完成度更高 |
| fail-closed 沙箱 | Ask/Long 沙箱起不来就拒绝；Full 才警告后裸跑 | Claude 默认路径更顺手（含 unsandbox 重试）；Codex 的 OS 沙箱面更完整（含 Windows） |
| 小到能审 | ~62 个生产 TS 文件、无运行时数据库、MIT | 功能面、发行信任、IDE 都不是一个量级 |
| Ask 完整 diff | `write`/`edit`/`delete` 在 `y/n/a` 前打 unified diff | Claude 的审批/rewind 菜单覆盖更多操作类型 |
| Remote-SSH 不必预装 agent | 灌 runtime，远端自下 Node 22 | 对 Claude CLI 的利基，不是对整个 Claude 产品族 |
| 会话级密钥断开即删 | `~/.socode-server/session/providers.json`，`finally` wipe | 不是「比 Claude 更安全」的总体声明 |
| `/usage` 不编造美元 | 无单价只打 token + `未标价` | Claude `/usage` 信息量更大 |

### 4.2 这次 **新出现** 的利基

| 利基 | 证据 | 边界（不要夸） |
| --- | --- | --- |
| **workspace-write 批准后仍不摘沙箱** | `resolveBashSandbox`：git / 区外只加可写根；Ask/Long `confineWrites` 保持 true | 这是对 Claude 默认沙箱逃生口（`dangerouslyDisableSandbox`）和 socode **自己 0.1.3** 的「批准即 lift」的利基。不是总体优势。区外根可能宽到 `$HOME`。 |
| **默认断网** | `bashNeedsNetwork` + bwrap `--unshare-net` / seatbelt `deny network*` | 比 Claude 默认更紧。启发式不是域名允许名单；解析失败会开网。`npm install` 仍然会开网（需要出网的命令才开，这是故意的）。 |

没有新的总体优势。没有 `apply_patch`、没有多轮 rewind、没有 HTTP MCP / hooks / auto-memory、没有短轮默认测——这些仍然让「关掉 Claude Code 当每天默认」不成立。

### 4.3 什么仍挡住日常主力对等

按对用户的伤害排序（与 0.1.3 **相同**）：

1. **`apply_patch`：** 一次调用改不相邻多处仍要连打 `edit` 或整文件 `write`。
2. **Undo 太浅：** 已跨重启，但只有一轮、不管 bash、不能回到第 N 个 prompt。
3. **短轮不默认测：** Long 里程碑才强制；Ask/Full 靠提示词。
4. **扩展面：** HTTP/SSE MCP、hooks、auto-memory 仍空。
5. **评测门 / 发行：** `npm test` 不是黄金任务；macOS 包未签名。
6. **IDE / Windows：** 终端专用；Windows 走 WSL 或 Remote-SSH 到 Unix。

workspace-write 让「装上之后 bash 别把家目录写穿」更接近 Codex 默认，但口令里的 **patch（多 hunk）+ 短轮跑测试 + 多轮可撤** 还没兑现。

---

## 5. 测试与环境

```
# tests 317
# pass 313
# fail 4
```

相对 0.1.3 快照的 311 / 308 / 3：多了 6 条 workspace-write 单测，其中 5 条过。失败 4 条：

- 3 条与上一快照同类：Long `verifyCommands` 执行 `true` 时本机无 `/usr/bin/bwrap`，Ask/Long **拒绝 bash**（`src/tools.test.ts` 的 `task_state tool`、`src/verify.test.ts`）。这是生产语义。
- 1 条新：`emits a confined seatbelt/bwrap policy...` 在 Linux 上断言 `spec.file === "/usr/bin/bwrap"`，本机没有 bwrap 时 `bashSpawn` 返回 `/bin/bash` + `unavailable`。测试没跳过「沙箱工具不存在」；**生产拒绝执行是对的**，不是 hotfix 写反。

未做：真实 LLM judge、真实 MCP 联调、真机 SSH、在有 `bwrap` 的 Linux 上跑 bash 出网/写 `.git` 的端到端探针。策略字符串和 `resolveBashSandbox` 决议有单测覆盖。

---

## 6. 给用户的中文结论

相对 `528fb32`（0.1.3）只多了一版 **0.1.3-fix2**（中间曾误打成 0.1.2-fix2 再改名）。产品上只做一件事：Ask/Long 的 bash 收成 Codex workspace-write——可读广、只写工作区+`/tmp`、默认断网、`.git`/会话只读，批准 git 或区外时只加那块可写根，**不再整段摘沙箱**。

**Primary 仍是 Claude Code，Secondary 仍是 Codex，不是 Pi。** 分数 9.4 / 7.9 / 2.9 → **9.4 / 8.3 / 2.8**。

0.1.3 已经有的重试、落盘 undo、`/usage`、Remote-SSH 都还在，不要当成这版新货。挡住每天当主力的仍是：没有 `apply_patch`、undo 只有一轮且不管 bash、短轮不默认跑测试、没有 HTTP MCP / hooks / auto-memory。沙箱更像 Codex 了，还不到能关掉 Claude Code 的完整主力。
