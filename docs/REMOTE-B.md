# 远程协议 B：实现草案（对齐前不写代码）

本文是 **SSH 远程工作区** 的实现草案，按 Remote-SSH 那套：**本机是显示器 + 输入，远端是带完整 Agent 的 worker**。不是已落地能力。

这和上一版草案不同。上一版把模型留在笔记本、只把工具 RPC 到远端。按当前对齐：

- 本机不跑 `runAgent`，不调 Provider，不拼上下文。
- 连上 SSH 之后，把 **本机这份 socode** 打成 `socode-runtime`，再配一个 **Node 22** 送到远端展开。
- 远端 worker 拼历史、调 API、跑工具；本机只收协议事件并画 TUI，把本轮 prompt / 按键送回去。

产品底线仍见 [`REMOTE.md`](./REMOTE.md)：不是云沙箱，不是把仓库同步到本机临时目录。对齐通过后再改路线图优先级。

---

## 0. 一句话

SSH 模式里本机等于 VS Code 的窗口，远端等于 `vscode-server`。仓库、bash、沙箱、会话、模型请求都在那台 Unix 上。本机 TTY 负责画流式消息、问 `y/n/a`、把这一轮用户输入送过去。

```
本机 socode（TTY：画 AgentEvent、Ask、问卷、收 prompt）
        │  ① 探测远端 arch；缺少则上传 Node 22 + socode-runtime
        │  ② JSON-RPC over SSH stdio（不要 ssh -t）
远端 ~/.socode-server/<id>/  展开的 worker
        └─ 拼上下文 / completeChat / runAgent / 工具 / MCP
           工作区仍是 /abs/repo
           `.socode/sessions/`  `.socode/undo/`  `.socode-audit.jsonl`
```

本机 **没有** 仓库副本，也 **没有** `/tmp` 里的镜像工作区。远端 home 里多的是 runtime（像 `~/.vscode-server`），不是项目文件。

---

## 1. 和 A、上一版 B、C 的差别

| | A `ssh -t` | 上一版 B | **这一版 B（Remote-SSH）** | C 同步工作区 |
| --- | --- | --- | --- | --- |
| 远端预装 socode | 要 | 要 | **不要**，本机灌 runtime | — |
| 本机角色 | 一块哑 TTY | TUI + 模型循环 | **TUI 显示器** | 带仓库的 agent |
| 模型 API | 远端 | 本机 | **远端** | 本机 |
| 工具 | 远端 | 远端 | 远端 | 远端再把 diff 拉回 |
| 传输 | 原始 ANSI | 工具 RPC | **AgentEvent + ask/question** | 文件同步 |
| 流式重绘 | 每帧过 SSH，易卡 | 正文在本机画 | 只传 JSON 事件，ANSI 在本机画 | — |

选这一版的原因：

- 不必事先 `npm i -g socode`；换版本跟 VS Code 一样覆盖 `~/.socode-server/<commit>`。
- 上下文、工具、API 在同一台机器，不用把 `executeTool` 拆成两次权限判定。
- Markdown 差量重绘留在本机，SSH 只运 token 文本和工具摘要，比 `ssh -t` 抗延迟。
- 仍然不是 C：改动落在远端仓库里，本机不 checkout。

代价：密钥必须出现在 **调用 API 的那一侧**，也就是远端（§10.1）。本机会话会注入一份并在断开前删掉，不是长期写进远端 `~/.socode`。

---

## 2. 目标与非目标

### 做

- `socode connect user@host:/abs/repo`：无仓库副本也能改远端文件。
- 第一次连接：探测 → 上传 Node 22（如需）和 `socode-runtime` → 启动 worker。
- 之后同版本重连：runtime 已在远端则跳过上传。
- 本机画全部流式事件；Ask / 问卷在本机 TTY；路径 / 沙箱 / git 在远端判定。
- 会话、undo、审计绑远端工作区绝对路径。断线再连同一目录，仍可 `/undo`。
- 本地 `socode`（无 connect）行为不变。

### 不做

- 方案 C：本机 agent + 远端 bash + 把 diff 同步回本机。
- 把 runtime 或仓库展开进本机 `/tmp` 再当工作区。
- 公网 HTTP、把 MCP HTTP 当成远程工作区。
- 把密钥塞进 SSH 环境变量，或打进 runtime 包。
- Windows 当执行侧；不在 Windows 上假 bash。
- 云沙箱、开发容器、密钥进 socode 云。
- 对话 rewind。
- v1 自动重连、跳板机 UI、多 repo 复用一条 ssh。

---

## 3. 职责切分

### 3.1 本机（显示器 + 输入）

- 解析 `user@host:/abs/path`，走 SSH 部署并挂协议。
- TUI：横幅、`printAgentEvent`（`delta` / `thinking` / `tool_call` / `tool_result` / `compress` / `notice`）、加载动画、子代理 HUD、Ask diff 着色、问卷。
- 把本轮用户输入、Ask 答、问卷答、Esc、斜杠命令送进协议。
- 本机 `~/.socode` **只在本次 SSH 会话** 被拷到远端会话文件，worker 用它调 API；断开前删除。不覆盖远端已有的 `~/.socode/providers.json`。
- 窗口列数变化可发 `ui/resize`，让远端知道截断宽度；重绘仍在本机。

本机 **不** 读远端文件，**不** 跑 `runAgent`，**不** `completeChat`。终端 scrollback 就是「显示器上的历史」；会话真相在远端 `.socode/sessions/`。

### 3.2 远端 worker（真正的 socode）

- 用注入的 Node 22 跑注入的 `dist/`。
- `cwd` / `policy.workspace` = 用户给的 **仓库绝对路径**，不是 `~/.socode-server`。
- `buildApiMessages` + 项目 AGENTS.md / skills / MCP 工具表 + 本轮 prompt → `runAgent` → `completeChat`（远端出网）。
- `executeTool`、沙箱、MCP spawn、verify、子代理、Long 审批器，全部在 worker 进程内，和今天本地一样。
- 写会话、undo、审计。
- 需要人时：协议里嵌套 `ask` / `question`，等本机答完再继续。不要在无 TTY 的 worker 里 `setRawMode`。

### 3.3 一次调用怎么走

```
用户在本机敲一行
  → client:  turn/start { text, mode? }
  → worker:  写入 session，拼 system+history+skills，runAgent
  → worker:  notify event { type: delta, text: "…" }   # 许多条
  → worker:  request ask { title, detail, diff }       # 若要审批
  → client:  本机画 diff，y/n/a
  → worker:  继续工具 / 模型
  → worker:  turn/end { usage, recap? }
  → client:  打 token 行，恢复输入
```

斜杠命令（`/undo` `/mode` `/doctor` `/session` `/compress` `/mcp` `/skills` `/new` …）几乎全是 `command { line }` 给 worker。远程会话禁止 `/quit` 和 Ctrl+C；`/sshquit` 先 `shutdown`，再由本机 `finally` 删掉远端会话 `providers.json` 并断开，回到本机新对话。`/setworkarea` v1 禁用（连的时候已经指定路径）。

---

## 4. 部署：socode-runtime + Node 22（Remote-SSH 流程）

远端 **不要求** 预装 Node 或 socode。本机这份代码才是真相。

### 4.1 装在哪

| 路径 | 内容 |
| --- | --- |
| 远端 `~/.socode-server/node/<ver>-<os>-<arch>/` | 便携 Node 22，可复用 |
| 远端 `~/.socode-server/runtime/<stamp>/` | 本机打的 `dist/` + `skills/` + `package.json` |
| 远端 `~/.../repo` | **工作区**，用户指定的绝对路径 |
| 远端 `~/.socode/` | 远端自己的 config / MCP；**不**被本次注入覆盖 |
| 远端 `~/.socode-server/session/providers.json` | 本机会话注入的 Provider，chmod 600，断开前 `rm` |
| 本机 `~/.socode/cache/` | 已下过的 Node 官方包、已打过的 runtime tarball，避免每次重传 |

`stamp` = `package.json` 的 version + `dist/` 与 `skills/` 的内容哈希。版本没变则 scp 跳过。

**禁止** 把 runtime 解压进仓库。**禁止** 在本机建仓库镜像。

### 4.2 runtime 包里有什么

socode 运行时 **没有生产 `node_modules`**（只有 devDependencies）。包可以很小：

```
socode-runtime-<stamp>.tar.gz
  dist/**/*.js          # tsconfig.build 的产物，不含 *.test.ts
  skills/**             # 基础 skill
  package.json          # 只为读 version
  bin/worker-entry.mjs  # 调 dist/worker.js
```

**不准** 打进去：`providers.json`、`.env`、本机 `~/.socode`、仓库源码、测试、docs。

### 4.3 Node 22 怎么过去

本机先一条非交互 SSH：

```bash
ssh -o BatchMode=yes user@host -- uname -s -m
```

只接受 `Linux` / `Darwin` + `x86_64` / `arm64`（`aarch64`）。Windows / 其它 arch 直接失败。

然后：

1. 远端已有 `~/.socode-server/node/.../bin/node` 且主版本 ≥ 22 → 用它。
2. 否则在**远端**测出网（curl/wget 拉 `index.json`），识别 `linux`/`darwin` + `x64`/`arm64`，再用对方网络下载官方 tarball。镜像顺序：nodejs.org → npmmirror → 腾讯云。
3. 不要从本机 scp Node（包大约 45MB，还吃本机带宽）。远端出网失败就报错，不降级上传。

不要把 Node 放进 git。v1 允许 connect 时在远端现下。

### 4.4 启动 worker

```bash
ssh -o BatchMode=yes user@host -- \
  ~/.socode-server/node/<ver>/bin/node \
  ~/.socode-server/runtime/<stamp>/bin/worker-entry.mjs \
  --stdio --workspace /abs/repo
```

不要 `ssh -t`。stdout = JSON-RPC；banner、下载进度、ssh motd 必须在 **本机 stderr** 或 SSH stderr。远端 `~/.bashrc` 往 stdout 打字会脏协议，bootstrap 用 `bash --noprofile --norc`。

本机 UI 提示参考 VS Code：`Installing socode-runtime on host…` / `Using cached runtime <stamp>`，完了再进横幅。

缺沙箱（Ask/Long 且没有 `sandbox-exec`/`bwrap`）：worker `hello` 失败即拒绝，不降级裸跑，不自动装 bubblewrap。

---

## 5. 协议 `socode-remote/1`

JSON-RPC 2.0，NDJSON（一行一个对象）。复用 `mcp-client.ts` 的 `takeMessage` 解析，v1 只发 NDJSON。双向请求：worker 在一轮里可以再 `ask` 本机。

抽 `src/jsonrpc-peer.ts`，不要直接用 `McpStdioClient`（它不会从对面收 request）。

未知字段忽略。`initialize.protocol` 对不上 → 失败，不进 REPL。

### 5.1 本机 → worker

| 方法 | 参数 | 结果 | 说明 |
| --- | --- | --- | --- |
| `initialize` | `{ protocol, clientVersion, columns? }` | `{ protocol, runtimeStamp, node, platform, workspace }` | 第一句 |
| `session/open` | `{ id?, resume?, fresh? }` | `{ id, title, mode, meter? }` | 不把整份 messages 拉回本机 |
| `session/list` | `{}` | `ConversationRow[]` | `/session` 列表；点选后再 `open` |
| `turn/start` | `{ text, mode? }` | 等 `turn/end` 通知 | **只发本轮 prompt**；拼接在 worker |
| `ask/reply` | `{ id, answer: "allow"\|"deny"\|"always" }` | — | 嵌套请求的响应 |
| `question/reply` | `{ id, outcome }` | — | |
| `command` | `{ line }` | `{ ok, text? }` 或后续 events | `/undo` `/mode` `/doctor` 等 |
| `ui/resize` | `{ columns }` | `{}` | 可选 |
| `abort` | `{}` 通知 | — | Esc；打断模型流和 bash |
| `shutdown` | `{}` | `{}` | |

`turn/start` **不带** 历史、system、skills、密钥。那些在 worker 侧已有。

### 5.2 worker → 本机（通知或嵌套请求）

| 方法 | 类型 | 载荷 | 本机 |
| --- | --- | --- | --- |
| `event` | notify | 现成 `AgentEvent` | `printAgentEvent` |
| `ask` | request | `{ id, title, detail, diff? }` | 画 diff，`y/n/a`；diff 已按 `ASK_DIFF_MAX` 截断 |
| `question` | request | `{ id, questions }` | 问卷 TUI |
| `turn/end` | notify | `{ usage?, recap?, error? }` | token 行、恢复 prompt |
| `status` | notify | `{ title?, mode?, context? }` | 刷新状态行 |
| `banner` | notify | `{ workspace, mode, title, mcpCount }` | 启动框 |
| `log` | notify | `{ text }` | 默认丢；`--remote-verbose` 才显示 |

`delta` / `thinking` **要过隧道**，否则本机不是显示器。这是和上一版草案的最大协议差别。

子代理：worker 内跑；HUD 用带 `tag` 的 `event`（已有 `printAgentEvent` 的 nest 参数），或一条 `subagent` 状态 notify。v1 用现有 event + tag 即可。

### 5.3 错误码

- `-32000` 协议版本
- `-32001` workspace 不是绝对路径 / 不存在 / 不是目录
- `-32002` 非 Linux/macOS
- `-32003` Ask/Long 沙箱不可用
- `-32004` 已 abort / 连接断开
- `-32005` 没有可用 Provider（§10.1）

工具失败仍在 `event.tool_result` 文本里（`权限拒绝:` / `工具执行失败:`），不要变成 RPC error，以免 `runAgent` 连续失败计数分叉。

**密钥不得出现在任何 JSON-RPC 字段里。** 测试断言 `initialize` / `turn/start` / `event` 不含 `sk-` / `api` 值。

---

## 6. 代码怎么改

先把「显示器」和「worker」在 **同一进程** 里拆开，本地模式变成 `display + in-process worker`。再让 worker 可挂在 stdio 上。最后才是打包和 SSH。不要一上来 scp。

### 6.1 新文件

| 路径 | 职责 |
| --- | --- |
| `src/jsonrpc-peer.ts` | 双向 NDJSON JSON-RPC |
| `src/remote-protocol.ts` | 版本、方法、类型 |
| `src/display.ts` | 现有 REPL 渲染 + 输入；只认协议（本地可接 in-proc adapter） |
| `src/worker.ts` | 无 TTY：session、runAgent、工具、MCP、provider；通过 `WorkerHost` 发 event / ask |
| `src/worker-host.ts` | `WorkerHost`：`emitEvent`、`askPermission`、`askQuestions`、`resize` |
| `src/runtime-pack.ts` | 打 `socode-runtime-<stamp>.tar.gz`（dist+skills） |
| `src/remote-install.ts` | `uname`、决定是否传 Node、scp、写 `~/.socode-server` |
| `src/connect.ts` | 解析目标、部署、spawn ssh worker、把 peer 交给 display |
| `src/jsonrpc-peer.test.ts` | 嵌套 ask、abort、半包 |
| `src/remote-protocol.test.ts` | 握手失败；载荷不含密钥 |
| `src/worker.test.ts` | 内存双工：prompt → fake complete → events；Ask deny 文件不变 |
| `src/runtime-pack.test.ts` | 包内无 `providers.json`、无测试文件 |
| `src/connect.test.ts` | 目标串解析；拒绝相对路径 |

本地 `socode`：`display` + `InProcessWorkerHost`（函数调用，不是 JSON）。  
`socode worker --stdio`：同一份 `worker.ts`，host 换成 peer。  
`socode connect`：部署后 ssh 到 `worker --stdio`。

### 6.2 必改的现有文件

| 文件 | 改什么 |
| --- | --- |
| `src/index.ts` | 拆出 display 循环；`connect` / `worker` 子命令早退；本地走 in-proc worker |
| `src/permissions.ts` | `askPermission` 改为 hook（与 `askQuestions` 对称）。worker 传入「问 display」 |
| `src/prompt.ts` | 远程 placeholder：`on user@host:/abs/repo` |
| `src/system-prompt.ts` | worker 侧提示：工作区在本进程；用户在另一台终端。不要说「请用户本地保存文件」 |
| `src/doctor.ts` | worker 做执行侧检查；display 的 `/doctor` 只展示 worker 回的报告 + 本机 Node（可选） |
| `src/commands.ts` | 文案；远程禁用 `/setworkarea` |
| `bin/socode.mjs` | 继续进 index 即可 |
| `package.json` | 可加 `pack:runtime` 脚本；无新运行时依赖 |

**尽量不改：** `agent.ts`、`fs-tools.ts`、`sandbox.ts`、`chat.ts`、`db.ts`、`undo.ts`、`ask-diff.ts`。它们只在 worker 里跑。

`runAgent` 已有 `onEvent` / `complete`。权限 hook 接上后，worker 不必为远程改循环语义。

### 6.3 启动骨架

```
parse argv
if (cmd === "worker")  → runWorkerStdio({ workspace }); return
if (cmd === "connect") → installRuntime(target); peer = sshWorker(); runDisplay(peer)
else                   → runDisplay(inProcessWorker(cwd))
```

`runDisplay`：只做 readline、横幅、`printAgentEvent`、把行变成 `turn/start` 或 `command`。  
`runWorker`：今天 `main()` 里除 TTY 以外的部分。

---

## 7. 分阶段

### M0 — 同进程拆 display / worker

- `WorkerHost` + in-process 实现
- `askPermission` hook
- 本地 `socode` 手感不变，`npm test` 全绿

没有这层，Ask 会卡在无 TTY 的 worker 里。

### M1 — 协议 + 本机双进程（不 SSH）

- `jsonrpc-peer`、`remote-protocol`、`worker --stdio`
- 测试用 `child_process` 或 `Duplex`：`turn/start` 看到 `event.delta`；Ask deny；Esc abort；`/undo`

### M2 — runtime 打包（仍可不 SSH）

- `runtime-pack.ts`：stamp、tar、断言不含密钥
- 本机 `node /tmp/runtime/bin/worker-entry.mjs --stdio --workspace <dir>` 能当 M1 的 worker

### M3 — SSH 注入（Remote-SSH）

- `uname`、Node 缓存/上传、runtime scp、`connect` 入口
- 失败文案：arch 不支持、scp 失败、沙箱没有、远端无 Provider
- 验收：本机无仓库；Ask 改远端文件；本机 TTY 看到流式正文和 diff；远端 `~/.socode-server` 有 runtime；本机 `/tmp` 没有项目镜像

### M4 — 会话与坚固性

- `/session` `/compress` `/new` `/doctor` `/mcp` `/skills`
- 同 stamp 跳过上传
- ssh 断开 → 本轮失败，不自动重连
- worker 禁止 `console.log` 到 stdout

**不在本里程碑：** 端口转发、把密钥长期写进远端 `~/.socode/providers.json`、Windows 执行侧、把 display 做成 web。

---

## 8. `/doctor`（连上之后）

```
socode doctor
  通过  本机 Node        v22.x（只跑显示器）
  通过  远端 Node        v22.x  ~/.socode-server/node/…
  通过  runtime          0.1.2+abc1234  已缓存
  通过  远端 Provider    default 已配置（不打印密钥）
  通过  远端沙箱         sandbox-exec / bwrap
  通过  远端会话目录     /abs/repo/.socode/sessions
  信息  工作区           user@host:/abs/repo  ·  Ask
```

Ask/Long 下远端沙箱失败 → 整次失败，worker 拒绝写。

---

## 9. 测试与验收

### 自动化

- Peer：嵌套 `ask`、`abort`、残缺行、worker 崩 → pending 全 reject
- 包：tar 列表无 `providers.json`、无 `.env`、无 `*.test.js`
- 假仓库 worker：prompt → stub 模型 → `write` Ask deny → 文件不变；allow → 文件变；`undo` 恢复
- 协议 fixture 不含密钥字符串

### 手工（M3）

- macOS → Linux、macOS → macOS
- 第二次 connect 不重复传 runtime（日志说 cached）
- 流式思考 + 正文 + 工具行 + Esc 停远端 `sleep`
- 非 TTY `--input`：Ask 写入仍拒绝
- 杀掉 ssh：本机报断开，不在本机写文件

### 不验收

- `ssh -t` 里跑完整 TUI（那是 A）
- 本机出现仓库 checkout

---

## 10. 还要拍板的问题

### 10.1 密钥放哪

API 在远端，worker 必须能读到密钥。已定：

**连接后把本机 `~/.socode/providers.json` 注入到远端 `~/.socode-server/session/providers.json`，worker 用 `SOCODE_PROVIDER_STORE` 读这一份。会话结束（含握手失败、`/exit`、Ctrl+C）先 `rm` 这份文件，再关 SSH。**

- runtime 包、JSON-RPC、SSH `SendEnv` **不准** 带密钥。环境变量只带会话文件路径，不带 `sk-`。
- **不准** 覆盖远端 `~/.socode/providers.json`。那是对方机器自己的配置。
- 本机没有 Provider → 跳过注入；若远端自己也没配，握手后提示去本机先配。
- 日志只写「注入了 N 个 Provider」，不打印 URL/密钥。
- 不要：打进 tar、`initialize` 带 Provider 对象。

### 10.2 远端已有 Node 22 时还传不传

**推荐：有 22+ 就用远端的，没有再传官方二进制。** 强制「永远带自己的 Node」作为 flag：`--bundle-node`。

### 10.3 入口名

**推荐会话里 `/remote-ssh`（分屏填 IP / 认证 / 工作区），CLI 仍可用 `socode connect user@host:/abs/path`。** worker 子命令是 `socode worker --stdio`（注入后的入口，用户一般不手打）。不要叫 `socode ssh`（留给 A 的 `ssh -t` 包装，可以继续不做）。

### 10.4 用户级 AGENTS.md / skills

**推荐只读远端 home + 远端项目。** 本机显示器没有「我的机器上的说明」可注入；要本机说明就先 copy 到仓库。和「拼接全在远端」一致。

### 10.5 MCP

只启 **远端** 工作区 `.mcp.json` 和远端用户 `~/.socode/mcp.json`。本机 MCP 命令在远端 PATH 上会错。

### 10.6 `/setworkarea`

**v1 远程禁用。** 目标在 `connect` 的路径里。

### 10.7 Windows 显示器

**v1 不承诺。** 执行侧必须是 Linux/macOS。Windows 继续 WSL2 或另一台 Unix 当客户端。

---

## 11. 建议先圈的结论

- 本机是显示器 + 输入；worker 在远端跑完整 Agent（含 API）。
- 用 Remote-SSH 式注入：`~/.socode-server` 放 Node + runtime，工作区仍是远端仓库绝对路径。
- 协议核心就是现成 `AgentEvent` + `ask` + `question` + `turn/start`（只发本轮 prompt）。
- 本机 Provider 注入到 `~/.socode-server/session/providers.json`，断开前删除；不进 tar、不进 RPC、不覆盖远端 `~/.socode`。
- 先 M0/M1（同机拆开 + stdio worker），再打包，最后才 scp。
- 本机 `/tmp` 不出现项目镜像；原子写仍是远端文件旁边的 `.tmp`。

对齐通过后才改 `REMOTE.md` 的 B 描述、路线图 §6.1 / §8.3、README。
