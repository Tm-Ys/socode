# 远程开发

socode 是 **本机 Unix 上的终端 Agent**：工作区、bash、OS 沙箱、会话都在同一台机器上。Windows 没有 `/bin/bash` 和 `sandbox-exec` / `bwrap`，所以远程连接的目标不是做云沙箱，而是让人在这边的终端里，把仓库和工具留在一台 Linux / macOS 上。

和 [`PRODUCT-ROADMAP.md`](./PRODUCT-ROADMAP.md) §6.3「云端执行」不是一回事。云端执行是把 bash 丢到别人的机器；本文是 **SSH 远程工作区**。密钥仍然不进 socode 云（目前也没有云）。

---

## 现状

没有 `socode ssh`，没有 `socode serve`，没有工作区同步。远程用法就是自己开 SSH。

TUI 依赖 `stdin` / `stdout` 是 TTY，以及 `setRawMode`（输入、Ask 的 `y/n/a`、问卷、Esc）。SSH 必须分配伪终端，否则会当成非交互：Ask 写入直接拒绝，欢迎向导也进不去。

```bash
ssh -t user@host 'cd /path/to/repo && socode'
```

远端需要 Node 22+、已安装的 `socode`、以及 Ask / Long 下的沙箱（macOS `sandbox-exec`，Linux `bwrap`）。在远端跑 `socode --doctor`。

会话写在 **远端工作区** 的 `.socode/sessions/`。Provider 和 harness 默认写在 **跑 socode 的那台机器** 的 `~/.socode/`。本机 Windows 上的配置不会自动过去。

---

## 三种接法（只做前两种里的一种产品）

### A. 整进程都在远端（先做）

```
本机 TTY  --ssh -t-->  远端 socode
                         ├─ 工作区 / bash / 沙箱
                         ├─ `.socode/sessions/`
                         └─ 调模型（密钥在远端 `~/.socode/providers.json`）
```

实现应是包装，不是协议：`socode ssh user@host:/path` 内部 `ssh -t`，把 stdio 原样交给远端进程。不要 scp 密钥，不要把本机 cwd 映射成远端。

代价：密钥在远端；流式 Markdown 差量重绘对 SSH 延迟敏感；本机没有仓库副本。权限、undo、doctor 的语义不变，因为执行侧仍是「这一台 Unix」。

### B. 本机显示器 + 远端 worker（真正的「远程连接」）

当前对齐接近 VS Code Remote-SSH，**不是**「本机跑模型、远端只跑工具」。完整草案：[`REMOTE-B.md`](./REMOTE-B.md)。

```
本机 socode（TTY：画流式事件、Ask、问卷、收 prompt）
        │  ① 注入 socode-runtime + 如需则注入 Node 22 到 ~/.socode-server
        │  ② JSON-RPC over SSH stdio（不要 ssh -t）
远端 worker
        └─ 拼上下文、调 API、工具、会话、沙箱
```

本机没有仓库副本。问不问人在本地 TTY；路径 / 沙箱 / git / 模型请求都在执行侧。传输只走 SSH，先不要公网 HTTP。会话仍写远端工作区 `.socode/sessions/`。

要做 B，先把「问人的 TTY」和「worker」拆开。A 不需要拆。

### C. 不要做：云沙箱 / 同步工作区

本机 agent、远端执行、再把 diff 同步回来。密钥、延迟、denylist 都要重做，和「本机 OS 沙箱 + 密钥不离机」抢定位。见路线图 §6.3、§8.3。

也不要用 HTTP MCP 冒充远程开发。MCP 是远程 **工具**，不是远程 **仓库**。

---

## 建议顺序

1. **先当 SSH 应用打磨。** 文档即本文。确认 raw mode、Esc、窗口缩放、Ask 审批、流式重绘在 `ssh -t` 下能用。Windows 用户走 WSL2 或这条 SSH，不移植 cmd / PowerShell。
2. **入口糖。** `socode ssh host:/path`：连上后在远端跑 doctor（Node / socode / 沙箱）。缺了只提示，不自动灌密钥。
3. **要本机抗延迟重绘、又不必预装 socode 时，做 B。** 协议保持小：现成的 `AgentEvent`（`delta` / `thinking` / `tool_call` / `tool_result`）加上 `ask` / `question`，以及只含本轮用户输入的 `turn/start`。Ask diff 在本地画，文件内容按现有截断走。API 在远端；本机 Provider 注入到远端会话文件，断开前删除。不进环境变量里的密钥、不进 runtime 包。

---

## 约束（做的时候不要破）

- 执行侧 `workspace` 必须是远端仓库的绝对路径。权限、沙箱、`.socode-audit.jsonl` 跟今天一样绑在那个目录。
- `/undo` 快照在远端工作区 `.socode/undo/`。SSH 会话断了再连上，只要还是同一个仓库目录，仍可撤最近一轮 socode 文件写入。换机器或换目录不行。
- 不要在 Windows 上假一个 bash 来「适配远程」。远端必须是 Linux 或 macOS。
- 不要把 Provider 密钥写进环境变量再 ssh 转发，也不要打进 runtime 包或 JSON-RPC。A 用远端自己的 `~/.socode`。B 把本机 Provider 拷到远端 `~/.socode-server/session/providers.json`，断开前删掉，不覆盖远端 `~/.socode/providers.json`。请求从远端出网。
- Long 审批器和对话模型在同一侧（远端 worker）；Ask / 问卷的按键仍回本机 TTY。

验收（A）：从一台没有仓库副本的机器 `socode ssh user@host:/repo`，Ask 改一个文件、审批能看见 diff、`/doctor` 为绿。验收（B）另开，不和 A 混在一个里程碑里。

B 的实现草案（对齐前不写代码）：[`REMOTE-B.md`](./REMOTE-B.md)。
