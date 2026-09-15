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
```

`THINKING_EFFORT` 可选：`none` / `minimal` / `low` / `medium` / `high` / `xhigh`。多个 Provider 会保存在 gitignore 的 `providers.json`。已保存的 Provider 整份生效，不再和环境变量字段混拼。没有 `providers.json` 时才用环境变量。

## 用法

```bash
npm start
npm start -- --input "你好"
npm start -- --new
npm start -- --id <conversation-uuid>
npm start -- --steps 120 --max 200
```

命令行还可覆盖本次进程的 `--url` / `--api` / `--model` / `--name` / `--context` / `--output` / `--effort`。

交互命令：

- `/provider` 查看当前适配
- `/provider edit` 输入 name、url、api、model、context window、max output、thinking effort
- `/provider list` 列出已保存的 Provider
- `/provider <name>` 切换
- `/new` 开新会话
- `/session` 或 `/chat` 恢复历史对话
- `/exit` 或 `/quit` 退出
- `Ctrl+C` 按第一次红字提示，再按一次退出
- 生成中按 `Esc` 中止当前轮：保存用户问题，不保存未完成的回复
