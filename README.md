# socode

最基础的 TypeScript TUI：OpenAI 兼容 LLM Provider、流式输出、Agent Loop、PostgreSQL 会话存储。

## 安装

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

`THINKING_EFFORT` 可选：`none` / `minimal` / `low` / `medium` / `high` / `xhigh`。多个 Provider 会保存在 gitignore 的 `providers.json`。已保存的 Provider 整份生效，不再和环境变量字段混拼。没有 `providers.json` 时才用环境变量。

## 用法

```bash
npm start
npm start -- --input "你好"
npm start -- --new
npm start -- --id <conversation-uuid>
npm start -- --steps 120 --max 200
npm start -- --mode long
```

命令行还可覆盖本次进程的 `--url` / `--api` / `--model` / `--name` / `--context` / `--output` / `--effort` / `--mode` / `--budget`。

## 权限与沙箱

默认 **Ask**（`MODE=ask` 或 `--mode ask`）。工作区内创建、修改、删除文件，以及有副作用的命令，会先询问：`y` 允许、`n` 或回车拒绝、`a` 本会话同类一律允许。Esc 视为拒绝。工作区外的写入直接拒绝，需要 `/mode full`。`.env`、`providers.json` 和系统密钥路径始终不可读写。

- **Full Access**（`/mode full`）：直接改文件和执行命令，仍禁止系统目录和密钥路径（`/etc`、`/usr`、`~/.ssh`、`~/.aws`、工作区 `.env` 等）。
- **Ask**（`/mode ask`）：写、删、有副作用的 `bash` 和所有 `git` 命令先审批，且只能在工作区内；`ls` / `pwd` 这类短只读命令不打断。bash 的 cwd 和重定向都不能离开工作区。`a` 按命令名授权，不会把 `git status` 扩成 `sudo`。
- **Plan**（`/mode plan`）：只能 `read` / `search` 和拟定计划，不能写文件、删文件、执行命令。
- **Long / 长程**（`/mode long` 或 `/mode 长程`）：给多步骤长任务用。工作区 `read` / `search` 预授权；写、删、git、网络等副作用走**独立 LLM 审批**（干净上下文、只输出 JSON，失败则拒绝），**不会变成 Full**。密钥、工作区外、sudo 仍本地硬拒绝。进入后维护 TaskState（`/task`），上下文接近上限时自动 `/compress`。设计说明见 `docs/LONG-MODE.md`。

macOS 上 `bash` 会套 `sandbox-exec`，Linux Ask 需要 `bwrap`。Ask 下只允许写入工作区，沙箱起不来就拒绝执行。Full 在沙箱失败时会警告后裸跑。非 TTY（例如 `--input`）在 Ask 模式下会拒绝写入，需要 `--mode full`。每次授权会追加到工作区 `.socode-audit.jsonl`。

交互命令：

- `/provider` 查看当前适配
- `/provider edit` 输入 name、url、api、model、context window、max output、thinking effort
- `/provider list` 列出已保存的 Provider
- `/provider <name>` 切换
- `/new` 开新会话
- `/session` 或 `/chat` 恢复历史对话
- `/context` 查看上下文占用（色块：system / tools / context / output / free）
- `/compress` 用当前模型压缩较早对话，保留最近两轮
- `/mode` 查看权限模式；`/mode full` Full Access，`/mode ask` 审批后改文件，`/mode plan` 只能看和写计划，`/mode long`（`/mode 长程`）长程任务
- `/task` 查看或更新 Long 模式的 TaskState
- `/exit` 或 `/quit` 退出
- `Ctrl+C` 按第一次红字提示，再按一次退出
- 生成中按 `Esc` 中止当前轮：保存用户问题，不保存未完成的回复
