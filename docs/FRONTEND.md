# socode 的「前端」长什么样

socode 没有 web 界面。所谓前端就是终端里的这一层 TUI：全是拼 ANSI 转义序列手写出来的，没有 React/Ink 之类的框架。

对照实现：`src/index.ts`（主循环、启动横幅、事件渲染）、`src/markdown.ts`（流式 Markdown）、`src/tool-ui.ts`（工具调用/结果行）、`src/prompt.ts`（输入行与补全）、`src/mode.ts`（模式着色）、`src/subagent-ui.ts`（子代理进度条）。

## 启动

`npm start` 后先打一段横幅：

```
工作目录: /Users/lively/projects/socode
会话: 新会话
编号: 尚未保存
Provider: <name>  模型: <model>
上下文: 128000  最大输出: 8192  思考: medium
流式: 开  Agent: 开  工具步数: 12
模式: socoding on ask mode  <模式说明>
/new 新会话  /session 恢复  ...  /quit 退出
输入 / 后会按前缀提示命令，Tab 补全。生成中 Esc 中止当前轮，Ctrl+C 按两次退出。
```

模式名按权限模式着色（`src/mode.ts`）。

## 一轮对话

用户输入提示符是 `> `。助手回复有前缀 `socoding on <mode> mode `，前缀颜色随模式变。

流式输出走 `paintMarkdownDelta`：每收到一个 delta，把已累积的原文重新渲染成带色 Markdown，用 `\r` + `\x1b[<n>A` + `\x1b[J` 把上一帧擦掉再重画。行数与宽度按 `displayRows`/`visibleWidth` 算，中日韩字符按 2 列宽。非 TTY（管道、重定向）时退化成纯文本直接追加，不重绘。

Mini Markdown 支持：`#` 标题、``` 代码块（暗青色）、`>` 引用、`-`/`1.` 列表、表格、以及行内 `**粗体**`、`*斜体*`、`~~删除线~~`、`` `code` ``、链接。

## 工具调用与结果

工具调用写成一行：

```
  ● bash  rg -n "foo" src
```

`●` 青色加粗，工具名加粗，参数是暗色的摘要——`read/write/edit/delete` 只显示短路径（相对 cwd 或 `~`），`bash` 显示截断到 72 列的命令，`search` 显示 pattern + 目录（`src/tool-ui.ts`）。

结果最多回显 3 行、缩进 4 空格、暗色；超出的折叠成 `… +N 行`。判定为失败的（`工具执行失败`/`权限拒绝`/非零 `exit=` 等）整段转红。

## 权限审批

Ask 模式下，写文件或跑命令前弹一行提问，等一个按键：

- `y` 允许
- `n` 拒绝
- 回车 拒绝
- `a` 本会话同类一律允许

逻辑在 `src/prompt.ts` 的 `askPermission`，和主输入共用一条 readline 流，靠 `pause/resume` 让出控制权。

## 命令补全

输入以 `/` 开头时，下面弹暗色候选列表，按前缀过滤，Tab 补全。候选列表在 `src/commands.ts`。

## 子代理

`subagent` 默认**不**把内部轨迹打出来：先打一行「N 个子代理在跑」，过程藏起来，右下角 HUD 显示 `子代理 n/m 在跑`（`src/subagent-ui.ts`）。`/seesubagent` 列出，`/seesubagent [序号]` 看某一个的过程，`/seesubagent off` 取消盯着。explorer 并行、worker 串行。结束后 HUD 消失，父代理只拿到摘要。

## 其它内联提示

- 压缩上下文时打：`压缩上下文，大约省下 N tokens`
- 错误统一走 `err> <message>` 到 stderr
- `/context` 打印最近若干条消息的预览，超出的折叠成 `... 更早 N 条`

## 一句话总结

它的「前端」是一套自己实现的差量重绘终端渲染器：光标回退 + 重画，把流式 Markdown、工具行、审批提示、子代理进度都塞进同一个 TTY 里。
