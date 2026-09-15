# socode

最基础的 TypeScript TUI：读取 `.env`，向目标 URL 发 OpenAI 兼容请求，把多轮对话写入 PostgreSQL，并在后续请求里带上历史上下文。

## 安装

```bash
npm install
cp .env.example .env
```

在 `.env` 里填：

```
MODEL="deepseek-flash"
api_key="sk-..."
BASE_URL="https://api.deepseek.com/v1"
DATABASE_URL="postgres://localhost:5432/socode"
SYSTEM_PROMPT=""
MAX_CONTEXT_MESSAGES="40"
```

首次运行会自动创建 `socode` 数据库和表。

## 用法

默认继续最近一次会话（有历史就会作为上下文发出去）：

```bash
npm start
npm start -- --input "你好"
```

开新会话：

```bash
npm start -- --new
npm start -- --new --input "你好"
```

继续指定会话：

```bash
npm start -- --id <conversation-uuid>
```

交互模式里 `/new` 开新会话，`/exit` 退出。回复默认按 token 流式打印；`--no-stream` 等全部生成完再输出。

命令行参数会覆盖 `.env`：`--url`、`--api`、`--model`、`--database`、`--system`、`--max`。
