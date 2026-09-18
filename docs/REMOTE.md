# 远程开发

socode 是 **本机 Unix 上的终端 Agent**：工作区、bash、OS 沙箱、会话都在同一台机器上。Windows 没有 `/bin/bash` 和 `sandbox-exec` / `bwrap`，所以远程连接的目标不是做云沙箱，而是让人在这边的终端里，把仓库和工具留在一台 Linux / macOS 上。

和 [`PRODUCT-ROADMAP.md`](./PRODUCT-ROADMAP.md) §6.3「云端执行」不是一回事。云端执行是把 bash 丢到别人的机器；本文是 **SSH 远程工作区**。密钥仍然不进 socode 云（目前也没有云）。

---

## 现状（0.1.3-fix2）

**协议 B 已落地**：本机是显示器，远端跑 worker。

```bash
# 会话里
/remote-ssh
/remote-ssh user@host

# CLI
socode connect user@host:/abs/path
```

连上后注入 `socode-runtime`；远端若无 Node 22 会用对方网络下载。本机 Provider 拷到远端会话文件，断开前删除。主机历史在 `~/.socode/ssh-hosts.json`（不存密码）。实现见 [`REMOTE-B.md`](./REMOTE-B.md)。

没有 `socode ssh`（那是 A：`ssh -t` 整进程包装），没有 `socode serve`，没有把本机仓库同步到远端。

TUI 依赖本机 `stdin` / `stdout` 是 TTY，以及 `setRawMode`（输入、Ask 的 `y/n/a`、问卷、Esc）。B **不要** `ssh -t`：SSH 的 stdout 是 JSON-RPC。若你自己用手敲：

```bash
ssh -t user@host 'cd /path/to/repo && socode'
```

那是 A，远端需要已经装好 Node 22+ 和 socode。在远端跑 `socode --doctor`。

会话写在 **远端工作区** 的 `.socode/sessions/`。B 的 Provider 用本机注入的会话副本；A 用远端 `~/.socode/providers.json`。本机 Windows 上的配置不会自动过去。

---

## 三种接法（只做前两种里的一种产品）

### A. 整进程都在远端（入口糖仍缺）

```
本机 TTY  --ssh -t-->  远端 socode
                         ├─ 工作区 / bash / 沙箱
                         ├─ `.socode/sessions/`
                         └─ 调模型（密钥在远端 `~/.socode/providers.json`）
```

实现应是包装，不是协议：`socode ssh user@host:/path` 内部 `ssh -t`，把 stdio 原样交给远端进程。不要 scp 密钥，不要把本机 cwd 映射成远端。可以继续不做。

代价：密钥在远端；流式 Markdown 差量重绘对 SSH 延迟敏感；本机没有仓库副本。权限、undo、doctor 的语义不变，因为执行侧仍是「这一台 Unix」。

### B. 本机显示器 + 远端 worker（已做）

对齐接近 VS Code Remote-SSH，**不是**「本机跑模型、远端只跑工具」。草案即实现说明：[`REMOTE-B.md`](./REMOTE-B.md)。

```
本机 socode（TTY：画流式事件、Ask、问卷、收 prompt）
        │  ① 注入 socode-runtime + 如需则注入 Node 22 到 ~/.socode-server
        │  ② JSON-RPC over SSH stdio（不要 ssh -t）
远端 worker
        └─ 拼上下文、调 API、工具、会话、沙箱
```

本机没有仓库副本。问不问人在本地 TTY；路径 / 沙箱 / git / 模型请求都在执行侧。传输只走 SSH，不要公网 HTTP。会话仍写远端工作区 `.socode/sessions/`。

### C. 不要做：云沙箱 / 同步工作区

本机 agent、远端执行、再把 diff 同步回来。密钥、延迟、denylist 都要重做，和「本机 OS 沙箱 + 密钥不离机」抢定位。见路线图 §6.3、§8.3。

也不要用 HTTP MCP 冒充远程开发。MCP 是远程 **工具**，不是远程 **仓库**。

---

## 接下来

1. Windows 用户走 WSL2 或 B / 手敲 `ssh -t`，不移植 cmd / PowerShell。
2. A 的 `socode ssh` 包装仍可选，不是缺口。
3. B 已按 [`REMOTE-B.md`](./REMOTE-B.md) 的协议走：`AgentEvent` + `ask` / `question` + `turn/start`。Ask diff 在本地画。API 在远端。

---

## 约束（做的时候不要破）

- 执行侧 `workspace` 必须是远端仓库的绝对路径。权限、沙箱、`.socode-audit.jsonl` 跟今天一样绑在那个目录。
- `/undo` 快照在远端工作区 `.socode/undo/`。SSH 会话断了再连上，只要还是同一个仓库目录，仍可撤最近一轮 socode 文件写入。换机器或换目录不行。
- 不要在 Windows 上假一个 bash 来「适配远程」。远端必须是 Linux 或 macOS。
- 不要把 Provider 密钥写进环境变量再 ssh 转发，也不要打进 runtime 包或 JSON-RPC。A 用远端自己的 `~/.socode`。B 把本机 Provider 拷到远端 `~/.socode-server/session/providers.json`，断开前删掉，不覆盖远端 `~/.socode/providers.json`。请求从远端出网。
- Long 审批器和对话模型在同一侧（远端 worker）；Ask / 问卷的按键仍回本机 TTY。

验收（B）：从一台没有仓库副本的机器 `/remote-ssh` 或 `socode connect user@host:/repo`，Ask 改一个文件、审批能看见 diff。验收（A）若以后做：`socode ssh user@host:/repo` 且 `/doctor` 为绿。
