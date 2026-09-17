# socode 的「前端」长什么样

socode 没有 web 界面。所谓前端就是终端里的这一层 TUI：全是拼 ANSI 转义序列手写出来的，没有 React/Ink 之类的框架。

对照实现：`src/index.ts`（主循环、启动横幅、事件渲染）、`src/banner.ts`（欢迎框）、`src/markdown.ts`（流式 Markdown）、`src/think.ts`（思考块拆分）、`src/tool-ui.ts`（工具调用/结果行）、`src/prompt.ts`（输入行与补全）、`src/mode.ts`（模式着色）、`src/subagent-ui.ts`（子代理进度条）、`src/question.ts` / `src/question-ui.ts`（问卷）、`src/select-ui.ts`（`/effort` `/model` `/provider` 方向键选择）。

## 启动

`npm start` 后先打一块欢迎框，每次从一池欢迎语里抽一句：

```
╭─ socode ──────────────────────────────────────╮
│                                               │
│  先读再改。猜出来的补丁最贵。                   │
│                                               │
│  ~/projects/socode                            │
│  Ask · 新会话                                 │
│                                               │
╰───────────────────────────────────────────────╯
  / 看命令 · Esc 中止 · Ctrl+C 两次退出
```

模型、思考强度、会话名、上下文占用在输入行下面，不在启动页重复。没对话时是 `deepseek-flash · medium · new`，有标题后变成 `deepseek-flash · medium · 标题`，右边对齐 `context 5%(6.4K / 128K)`。命令清单改成输入 `/` 再补全。模式名按权限模式着色（`src/mode.ts`）。实现：`src/banner.ts`。

## 一轮对话

用户输入提示符是 `ask mode>`（随权限模式着色），空输入时同一行暗色占位 `on ~/path`。下一行橙色：左边 `deepseek-flash · medium · new`（有对话名则换成标题），右边对齐 `context 5%(6.4K / 128K)`，数字和 `/context` 同一套计量。发出消息后、模型还没吐字时，当前行画 npm 式加载：绿色 braille 转圈 + 来回滑动的 `█` 条 + 暗色 `socoding`（`src/load-ui.ts`）。首个思考 / 正文 / 工具调用到来时擦掉；工具结果之后再等模型会重新转。助手回复有前缀 `socoding on <mode> mode `，前缀颜色随模式变。不会再单独打一行 `会话: …`。

流式输出走 `paintMarkdownDelta`：每收到一个正文 delta，把已累积的原文重新渲染成带色 Markdown，用 `\r` + `\x1b[<n>A` + `\x1b[J` 把上一帧擦掉再重画。行数与宽度按 `displayRows`/`visibleWidth` 算，中日韩字符按 2 列宽。非 TTY（管道、重定向）时退化成纯文本直接追加，不重绘。

模型思考不走这条正文通道。`reasoning_content` / `reasoning` / `<think>` 会拆成独立的 `thinking` 事件，用 `paintThinkingDelta` 画成暗色斜体，左边标 `思考`，和 `socoding on <mode> mode` 的 Markdown 正文分开。思考只在终端里看，不会写进发给模型的 assistant `content`。

Mini Markdown 支持：`#` 标题、``` 代码块（暗青色）、`>` 引用、`-`/`1.` 列表、表格、以及行内 `**粗体**`、`*斜体*`、`~~删除线~~`、`` `code` ``、链接。

## 工具调用与结果

工具调用写成一行：

```
  ● bash  rg -n "foo" src
```

`●` 青色加粗，工具名加粗，参数是暗色的摘要——`read/write/edit/delete` 只显示短路径（相对 cwd 或 `~`），`bash` 显示截断到 72 列的命令，`search` / `glob` 显示 pattern + 目录（`src/tool-ui.ts`）。Ask 审批 `edit` 时详情里带一小段 `原文 → 替换`。

结果最多回显 3 行、缩进 4 空格、暗色；超出的折叠成 `… +N 行`。判定为失败的（`工具执行失败`/`权限拒绝`/非零 `exit=` 等）整段转红。`plan` 例外：完整框起来的进度板直接打出来，不截三行。

## 计划板

`/seeplan` 和 `plan` 工具结果共用一块带边框的进度板（`src/plan.ts` 的 `formatPlanCli`）：

```
╭─ 📋 Plan  1/2 ──────────────────────────╮
│ 🎯  demo                                │
│ 📊  ██████░░░░░░  1/2                   │
│                                         │
│ ✅  1. read                             │
│ 👉  2. edit                             │
│                                         │
│ 📝  （未审查）                          │
│ 👉  完成下一项并勾选                    │
╰─────────────────────────────────────────╯
```

已完成项 ✅、下一项 👉、其余 ⬜。全部勾完待审查会在标题标 🔍；写过 review 标 ✨。框宽跟着终端列数走。

## 权限审批

Ask 模式下，写文件或跑命令前弹一行提问，等一个按键：

- `y` 允许
- `n` 拒绝
- 回车 拒绝
- `a` 本会话同类一律允许

逻辑在 `src/prompt.ts` 的 `askPermission`，和主输入共用一条 readline 流，靠 `pause/resume` 让出控制权。

## 问卷

模型一次有多个决策要问时调用 `question`。TUI 按 OpenCode 的交互来：

```
? 问卷  1/2
  存储  端口  Confirm

用哪种存储？
  1. > SQLite (Recommended)
       本地文件，零依赖
  2.   PostgreSQL
       已有数据库
  3.   Type your own answer
```

多选题额外在最后加提交：

```
  3.   [ ] Type your own answer
  4.   提交答案
```

- 单选最后一项固定是 Type your own answer；多选它是倒数第二，最后一项是「提交答案」（模型不要自己加「其他」）
- `↑↓` / `j k` 移动，`1-9` 快捷，`Enter` 确认、勾选或提交
- 选中 Type your own answer 后再 Enter：输入自定义答案
- 多题用 `Tab` / `h l` 切换，最后一页 Confirm 汇总后再提交
- `Esc` 取消整张问卷，不中止这一轮
- 非 TTY 无法作答，工具直接返回说明

和审批一样走 `withPermissionLock`，生成中的 Esc 监听会先 pause。实现：`src/question.ts`（解析、按键状态机）、`src/question-ui.ts`（raw-mode 重绘）。

## 命令补全

输入以 `/` 开头时，下面弹暗色候选列表，按前缀过滤，Tab 补全。候选列表在 `src/commands.ts`。

## 思考强度与模型

`/effort` 先 `GET /models` 读当前模型的思考档位，再弹出一排：

```
? 思考强度  API: medium

  none  minimal  low  [medium]  high  xhigh

  ←→ / ↑↓ 调整   enter 确认   esc 取消
```

默认 medium。`/provider new` / `edit` 不再问这一项。非 TTY 可用 `/effort medium`。

`/model` 只在已保存的 Provider 和模型之间选：←→ 换提供商，↑↓ 换同一 API 下已确认过的模型。

`/provider` 弹出已保存列表（对标 OpenCode 的 `/connect`）：

```
? Provider  已保存的适配

  >* deepseek          deepseek-flash
     openai            gpt-5

  ↑↓ 选择   enter 切换   e 编辑   n 新增   esc 取消
```

`e` 或 `/provider edit [name]` 按字段改，回车保留方括号里的当前值，不会把空输入当成清空。`n` 或 `/provider new` 是空表。多个 Provider 存在 `providers.json`。非 TTY 用 `/provider show` / `/provider list` / `/provider <name>`。

## 子代理

`subagent` 默认**不**把内部轨迹打出来：先打一行「N 个子代理在跑」，过程藏起来，右下角 HUD 显示 `子代理 n/m 在跑`（`src/subagent-ui.ts`）。`/seesubagent` 列出，`/seesubagent [序号]` 看某一个的过程，`/seesubagent off` 取消盯着。explorer 并行、worker 串行。结束后 HUD 消失，父代理只拿到摘要。

## 其它内联提示

- 压缩上下文时打：`压缩上下文，大约省下 N tokens`
- 错误统一走 `err> <message>` 到 stderr
- `/context` 打色块占用（system / tools / 对话 / 预留输出 / 空闲）；recap 过的轮次按短 recap 计 token，报告里会标 `recap N 轮`

## 一句话总结

它的「前端」是一套自己实现的差量重绘终端渲染器：光标回退 + 重画，把思考块、流式 Markdown、工具行、审批提示、问卷、子代理进度都塞进同一个 TTY 里。
