# socode 代码审计（安全 + harness 正确性）

## 1. 审计范围与 commit

**对象：** `https://github.com/Tm-Ys/socode` 默认分支 `main` 在 fresh fetch 后的 HEAD。  
**Commit：** `32aa8a9545b49d82338c33cdd61cdd97dc66ed2d`（`fix PR2`）  
**作者 / 时间：** Tm-Ys `<hanchenxu25@mails.ucas.ac.cn>`，`2026-09-15 15:54:40 +0800`  
**核验：** `git fetch origin main` 后 `git rev-parse origin/main` = `32aa8a9`。相对上次盘点 `6c2d902`（`fix sm bug`）有 1 个 commit、16 文件、`+484 / -79`。

**范围：** 全部 `src/*.ts`（22 个文件、3924 行）以及 `package.json` / `package-lock.json` / `.gitignore` / `README.md` / `.env.example`。无 MCP、无 HTTP 服务、无浏览器 UI。本审计 **不改产品代码**。

**方法：** 通读安全关键路径；用 `tsx` 直接调用生产函数做对抗探测（`classifyBash` / `mutationDenied` / `createPolicy.authorize` / `readAbsoluteFile`）；`npm test`（22 pass / 0 fail）。探测 **没有** 真正执行 `find -delete`，也没有对仓库做破坏性写入。

**威胁模型（谁能做什么）：**

socode 是本机 CLI coding agent。默认 `MODE=ask`。攻击者不是远程匿名用户，而是：

1. **被诱导的模型**（工具选择错误、循环空转）；
2. **提示注入**（用户打开的仓库里的 `AGENTS.md`、源码注释、`/compress` 摘要、工具回写内容）；
3. **恶意仓库**（预先放好指向 `~/.ssh` 或 `/etc` 的符号链接）。

能力边界：工具能读/写/删文件、在任意已存在绝对目录下 `spawn(/bin/bash, ["-c", command], { env: process.env })`。会话全文（含工具参数与输出）进 PostgreSQL。API key 在进程环境与工作区文件里。

---

## 2. 总体结论

`32aa8a9` 相对 `6c2d902` **确实补上了盘点里点名的几块 harness 空洞**（Ask 工作区外写入改为硬拒绝、doom-loop、失败轮写回、API `usage`、薄测试、Ask 下 macOS 沙箱失败不再 fallback），但 **默认 Ask 并不是一个封闭工作区沙箱**。`classifyBash` 的“只读”判定是正则前缀启发式，`env python3 …` / `find . -delete` / `echo $(curl …)` / `cat /etc/passwd` 在 Ask 下 **授权函数直接返回 `null`、不弹 y/n/a**；`read`/`write` 走 Node `fs` 且 **不 `realpath`**，工作区符号链接可以读到 denylist 目标（实测可读 `/etc/passwd`）；Linux 上 `bashSpawn` 就是裸 `/bin/bash`。Plan 模式对写工具是硬拦截（schema + `executeTool` + `authorize` 三重），这部分是真的。Phase 2 Safety **仍是 PARTIAL**，不能因为 README「权限与沙箱」或 PR2 测试变绿就标 DONE。

---

## 3. 发现列表

### P0-1  Ask 下 `classifyBash` 只读误判 = 无审批任意副作用

**证据：** `src/sandbox.ts:classifyBash`（L96–130）+ `READONLY_HEAD`（L93–94）；`src/permissions.ts:createPolicy.authorize` 在 `kind.readonly` 时直接 `return null`（L64–65）。

`READONLY_HEAD` 只看 **每个 `&&`/`||`/`;`/`|` 片段的第一个词** 是否为 `ls|pwd|…|cat|rg|find|env|echo|…`。命令替换、`-exec`、`env` 后面跟的解释器都看不见。对生产函数实测：

| 命令 | `classifyBash` | Ask `authorize("bash")` |
| --- | --- | --- |
| `env python3 -c "open('/tmp/x','w').write('hi')"` | `readonly: true` | `null`（放行） |
| `find . -delete` | `readonly: true` | `null`（放行） |
| `find . -exec python3 -c '…' \;` | `readonly: true` | `null`（放行） |
| `echo $(curl https://evil.test)` | `readonly: true` | `null`（放行） |
| `python3 foo.py`（无 `env` 前缀） | `readonly: false` | 会走审批（对照：启发式“看起来”保守） |

同文件里对 `rm`/`>`/`tee`/`sudo`/`curl\|sh` 的黑名单是全文正则，所以 `echo x > f`、`curl \| sh` **不会**被这条绕过。漏洞是 **白名单前缀**，不是黑名单漏了 `rm`。

**影响：** 默认 Ask 下，被注入的模型无需用户按 `y`，即可在工作区 `cwd` 里删文件、写文件、外连。Linux 上没有 seatbelt 可兜底。

**复现思路：** `MODE=ask` 交互会话，让模型调用 `bash`：`{ "cwd": "<workspace>", "command": "env python3 -c \"open('pwned.txt','w').write('x')\"" }`。不应出现 y/n/a；当前授权层会放行。不要在真实仓库里跑 `find . -delete`。

**修复建议：** 废弃“命令文本像只读”作为放行条件。默认所有 `bash` 都审批，或只允许 **参数化、无 metacharacter** 的固定子命令（`ls`/`pwd` 等）且禁止 `$()` / backticks / `-exec` / `env`/`command`/`nice` 包装。有解析再用 allowlist，不要用 `READONLY_HEAD`.test(首词)。

---

### P0-2  密钥与 denylist 可被只读工具读进对话

**证据：**

- `read`/`search` 只跑 `denyReason(path)`，**没有** `isInsideWorkspace`（`src/permissions.ts` L33–36）。
- `denyReason` 不覆盖工作区 `.env`、`providers.json`、`~/.bashrc`、`/var`、`/opt`（`src/sandbox.ts` L8–24、L40–58）。探测：`denyReason("/workspace/.env") === null`，`authorize("read", { path: "<ws>/.env.example" }) === null`，`authorize("read", { path: "~/.bashrc" }) === null`；`~/.ssh/id_rsa` 对 **字面路径** 会拒绝。
- `cat .env`、`cat /etc/passwd`、`env`、`echo $api_key`、`rg api_key ~` 均被 `classifyBash` 标只读 → Ask 不询问。
- `runBash` 把 **完整** `process.env` 传给子进程（`src/fs-tools.ts` L120–123）。`saveProvider` → `applyToProcessEnv` 写入 `process.env.api_key`（`src/provider.ts` L113–116）。
- `.gitignore` 忽略 `.env` / `providers.json`，但工具层不忽略。

**影响：** API key、Provider URL、shell history、工作区密钥文件会进入：模型上下文、TTY 工具输出、PostgreSQL `messages.content`。这是本机 confused deputy，不是“远程未授权读盘”，但对默认 Ask 来说已经越过用户预期的审批边界。

**复现思路：** Ask 会话调 `read` 读 `<workspace>/.env`，或 `bash` `command: "env"` / `"echo $api_key"` / `"cat .env"`。授权应失败；当前为 `null`。

**修复建议：** denylist 至少加入工作区 `.env`、`providers.json`、常见 `*credentials*`；bash 子进程用剥掉 `api_key`/`LLM_API` 的环境副本；`read`/`search` 默认限制在 workspace（Full 再显式放开）；禁止把 `env`/`printenv` 当只读放行。

---

### P0-3  `read`/`write` 跟随符号链接，路径策略不 `realpath`

**证据：** `requireAbsolutePath` 只用 `normalize` + `denyReason`（`src/fs-tools.ts` L12–19）；`isInsideWorkspace` 是字符串 `relative`（`src/sandbox.ts` L33–38）；`readAbsoluteFile` / `writeAbsoluteFile` 调用 `readFile` / `writeFile`（L34–55），跟随 symlink。`stat(symlink).isFile === true`。

探测（临时目录，非仓库内）：

- 符号链接 → 普通文件：`readAbsoluteFile(link)` 读到目标正文。
- 符号链接 → `/etc/hostname`：读成功。
- 符号链接 → `/etc/passwd`：`denyReason(link) === null`，**整文件读出**（`root:x:…`）。

若恶意仓库在 workspace 里放 `ln -s ~/.ssh/id_rsa ./id`，Ask 的 `read` 看到的是区内路径，denylist 打不中 `~/.ssh`。

`write` 同样跟随 symlink：Ask 对 **链接路径** 走区内审批，批准后覆盖的是 **目标文件**。`unlink` 删的是链接本身（`deleteAbsoluteFile` L57–67），这条相对安全。

**影响：** 绕过 `/etc` 与 `~/.ssh` 字面 denylist；恶意项目 / 已批准的 `ln` 之后可打到系统文件。

**复现思路：** `ln -s /etc/passwd /tmp/ws/link &&` 调 `readAbsoluteFile("/tmp/ws/link")`。当前返回 passwd 内容。

**修复建议：** 所有文件工具对最终路径 `realpath`（不存在的 `write` 对父目录 realpath），再跑 denylist + workspace 判断。拒绝 `realpath` 失败或指向区外的链接（Full 可另开开关）。`search` 的 `rg` 默认已不跟目录 symlink，可保持。

---

### P1-1  工作区 allowlist 对 `write`/`delete` 是硬拒绝，对 `bash` 只检查 `cwd`

**证据：** `mutationDenied` 在 `mode !== "full" && !isInsideWorkspace` 时硬拒绝（`src/sandbox.ts` L87–89）。`createPolicy` 对 `write` 用文件 path，对 `bash` 用 **cwd** 当 `req.path`（`src/permissions.ts` L56–70）。相对 `6c2d902`：Ask 已不再把区外写入只当成“换一句提示再问”——`permissions.test.ts` 覆盖了 `/tmp` 上的 `write` 与 `mkdir`。

探测：Ask + `cwd=<workspace>` + `command: "echo hi > /tmp/socode-audit-pwned"` → **没有** “工作区外”硬拒绝，只走到 `askPermission`；非 TTY 得到 `用户拒绝了修改文件: echo hi > /tmp/socode-audit-pwned`。说明策略认为这是 **区内 modify**。

`cp .env /tmp/stolen`、`ln -s ~/.ssh/id_rsa ./link` 同理：分类为 modify，审批 key 是 `modify:in`。

**影响：** 用户以为 Ask = 不能写出工作区。实际是：`write` 工具不能，`bash` 在区内 cwd 批准一次（或按了 `a`）就能重定向/复制到 `/tmp` 或家目录。Full 模式 `mutationDenied` 对 `/tmp` 返回 `null`（`sandbox.test.ts` “allows Full writes outside except denylist”），这是显式设计，但 README 容易让人以为 denylist ≈ 沙箱。

**复现思路：** TTY Ask，批准 `echo hi > /tmp/x` 或先对任意区内 modify 按 `a`，再发带 `/tmp` 重定向的命令。

**修复建议：** Ask 下 bash 禁止重定向与绝对路径操作数指向区外；或 Ask 禁止一切 bash 写（只留 `write`/`delete` 工具）。Full 的区外写要单独确认，不要 `decide()` 里 `mode === "full" return null`（L86）。

---

### P1-2  `a`（本会话一律允许）粒度是 `op:in|out`，一次放行整类危险操作

**证据：** `src/permissions.ts` L88–98：`key = \`${req.op}:${inside ? "in" : "out"}\``。`askPermission` 把 `a`/`A` 映射为 `"always"`（`src/prompt.ts` L252–254）。Enter / `y` 都是单次 `"allow"`（L248–249）。

`classifyBash("sudo id")` → `{ readonly: false, op: "exec" }`。Ask 下用户若对 `git status`（同样 `op: "exec"`，L116–122 凡 `\bgit\b` 都非只读）按 `a`，则后续 **同一进程内** 区内 `exec`（`sudo`、`curl`、`python3`、`kill`）不再询问。`grants` 只活在内存，不进 PG——重启会丢，这是好事。

**影响：** 审批 UX 暗示“同类”，实现是“同一 FileOp + 区内/区外”。`create:in` 一次覆盖 `mkdir` 与 `npm install`；`modify:in` 覆盖 `ln`/`cp`/`>`。

**复现思路：** Ask 对 `git status` 按 `a`，再发 `sudo id` 或 `python3 -c '…'`，不应再弹窗。

**修复建议：** grant key 至少包含二进制名；`sudo`/`su`/`dd`/`mkfs`/`curl`/`wget` 永远询问或直接拒绝。不要用 Enter 当允许（见 P3-1）。

---

### P1-3  Linux 无沙箱；macOS seatbelt 是 `(allow default)`；Full 仍会裸跑 bash

**证据：** `src/sandbox.ts:bashSpawn` L150–156：非 Darwin **或** 没有 `/usr/bin/sandbox-exec` → 直接 `{ file: "/bin/bash", args: ["-c", command] }`。本机探测 `process.platform === "linux"`，Ask/Full 的 `bashSpawn` 都是裸 bash。

Darwin 且 Ask（`confineWrites: policy?.mode !== "full"`，`src/tools.ts` L172–176）：profile 为 `(allow default)(deny file-write*)(allow file-write* workspace /tmp /private/tmp /var/folders)` + 密钥读拒绝（`src/sandbox.ts` L180–185）；`fallback` 为 `undefined`（L155）——**相对 6c2d902 的静默脱壳，Ask 已修好**。

Full：`confineWrites` false，`fallback: direct`。`shouldFallbackSandbox` 在 exit 71 或 stderr 匹配 `/sandbox_apply|sandbox-exec:/i` 时重跑裸 bash（`src/sandbox.ts` L159–161，`src/fs-tools.ts` L82–96）。profile 仍是 `(allow default)` 再 deny 若干写路径：网络、exec、IPC 全开。

`sb()`（L188–190）只转义 `\` 和 `"`，workspace 路径里的 `)` 能打断 seatbelt 语法。攻击者要能控制 `process.cwd()`，通常是用户自己启动目录，严重度低于模型工具。

**影响：** 默认部署若在 Linux（CI、云开发机、多数服务器），bash 隔离 = `denyReason(cwd)` + 上面那套可绕过的 classify。macOS Full 在 sandbox-exec 异常时退回零隔离。

**复现思路：** Linux 上读 `bashSpawn("ls")` 的 `file`。Darwin Full 下构造能让 sandbox-exec 打出 `sandbox-exec:` 的命令，确认第二轮是 `/bin/bash -c`。

**修复建议：** Linux 用 bubblewrap/landlock，失败则拒绝而不是执行。macOS 改 `(deny default)` + 显式 allow。Full 的 fallback 必须打印可见警告，或直接失败。Ask 的“无 fallback”请保留。

---

### P1-4  Plan/Ask 模式完整性：Plan 硬拦截成立；Ask 的“只读 bash”不是硬边界

**证据（Plan 是硬的，不是只靠 prompt）：**

- `toolSpecs("plan")` 只留 `READ_TOOLS` = `read`/`search`/`calculate`/`get_current_time`（`src/tools.ts` L140–146）。
- `executeTool` 再拒：`policy?.mode === "plan" && !READ_TOOLS.has(name)`（L164–166）。
- `authorize` 对 bash 在 plan 下直接拒绝（`src/permissions.ts` L61–62）；`mutationDenied("plan", …)` 拒绝一切 mutation（`src/sandbox.ts` L84–86）。

探测：`authorize("write", { path: "<ws>/src/index.ts" })` 在 plan 下匹配 `/Plan/`。模型就算 hallucinate `write` 也执行不了。

Ask 对 `write`/`delete`/非只读 bash 有审批；对只读 bash **零审批**。系统提示写“不要用 bash 的 rm/mv 绕过权限”（`src/system-prompt.ts` L27–28），这是 prompt，P0-1 证明执行层没跟上。

**影响：** Plan 可当作“不能动手”的模式。Ask 不能当作“没有 y 就不能有副作用”。

**修复建议：** Plan 保持三重门。Ask 把 bash 默认视为有副作用（回到 P0-1）。

---

### P2-1  无审计日志

全仓库没有 `.socode/audit.log`、没有把 allow/deny/always/denylist 命中写成追加日志的模块。工具轨迹只存在：TTY 三行摘要（`src/tool-ui.ts:clipToolOutput`）、PG `messages`（含完整 `tool_calls.arguments`）。拒绝与放行无法事后对账，也无法和 P0 的“根本没弹窗”对上。

**修复建议：** 每条 tool 追加一行：时间、mode、name、路径/命令摘要、decision、是否 sandbox。Ask 拒绝、Plan 拦截、denylist、classify 放行都要有。

---

### P2-2  doom-loop 有了，但易规避；并行批次提前 break 会缺 tool 回写

**证据：** `src/agent.ts` `REPEAT_LIMIT = 3`（L10）。连续相同 `name\0arguments` 第 3 次不执行，改写“权限拒绝: 同一工具连续调用…”（L125–131）；同名连续 `isToolError` 三次则停（L140–148）。然后 `return` 一段合成 assistant 文本（L165–169）。**成功路径不调用 `closeIncompleteTrace`。**

规避：改一个空格、换 JSON key 顺序、在两个失败工具间交替，计数器归零。上限仍是 `DEFAULT_MAX_AGENT_STEPS = 80`（L9），最后一步关掉 tools（L93）——步数门还在。

并行：同一 assistant 若带 4 个相同 call，第 3 个开始 `doom=true` 后 `break`（L162），第 4 个没有 tool message。这段 trace 会 `saveMessages`。下一轮 OpenAI 兼容接口通常要求每个 `tool_call.id` 都有 `role: tool`，可能直接 400。`closeIncompleteTrace` 只用于 abort/fail（L80–88），doom 的“成功停机”用不到。

**复现思路：** mock 模型一次返回 4 个相同 `read`；检查入库 messages 是否 4 call / 3 tool。再对 `read` 路径每次 `+ " "` 重复 80 步，应能撑满步数。

**修复建议：** doom 返回前跑 `closeIncompleteTrace`（或给未执行的 id 补一条 tool 错误）。重复检测用规范化 JSON + 规范化 path，并对“同工具不同参但连续失败”设总上限。

---

### P2-3  工具执行期间 Esc 被暂停；bash 输出在 clip 前无界拼接

**证据：** `runAgent` 在 `executeTool` 外包 `onGate(true/false)`（`src/agent.ts` L133–138）。`watchTurnAbort.pause` 把 `paused` 置位后 **忽略** Esc/Ctrl+C（`src/prompt.ts` L190–191, L210–211）。审批期间暂停是为了不把按键当 abort，但 **整个 bash 30s** 也在 pause 里。超时后 `killProcessTree`（`src/fs-tools.ts` L151–154, L311–326）会杀进程组，这点是好的。

`runBashProcess` 的 `stdout += chunk`（L156–160）没有上限，`clip` 只在事后切到 `MAX_OUTPUT_CHARS = 32_000`（L7–8, L306–308）。`readAbsoluteFile` **不使用** `MAX_READ_BYTES`（该常量只给 `searchByWalk` L254），先 `readFile` 整个文件再截断输出。

**影响：** 失控的 `yes`/`cat /dev/zero` 类命令可在 30s 内把 Node 撑爆；Esc 不能提前停。大文件 `read` 同样先进内存。

**修复建议：** 工具执行时仍响应 Esc（与审批 raw-mode 分离）。stdout/stderr 环形缓冲；`read` 先 `stat` 再限额。

---

### P2-4  `/compress` 副作用：摘要以 `user` 角色入库；工具输出进压缩器

**证据：** `compressHistory` 把 stale 转成 transcript（工具结果 clip 1500 字，`src/compress.ts` L88–90），模型摘要写入 `role: "user"` + `【会话摘要】`（L67–71），然后 `replaceMessages` 删光该会话消息再插入（`src/db.ts` L250–272）。事务完整，中途失败会 rollback——这块安全。`runCompress` 成功后 `rememberMode`（`src/index.ts` L601–604）。

摘要是 user 角色，后续模型会当成用户说的话。被注入的压缩模型（或 transcript 里已有的注入）可以把指令写进摘要。压缩调用 **没有 tools**（`completeChat` 默认），不会在压缩过程中再动文件系统。

**修复建议：** 摘要用 `role: "system"` 或带固定前缀的独立角色，并在 `normalizeHistory` 里当不可合并的系统块。不要把 tool 原文（尤其 `env` 输出）送给压缩器。

---

### P2-5  持久化：SQL 注入风险低；工具 payload 无大小上限、明文密钥

**证据：** `saveMessages` / `replaceMessages` 使用 `$1…$5` 绑定（`src/db.ts` L235–238）。`role` 有 CHECK（L81–82）。`quoteIdent` 用于 `CREATE DATABASE`（L20–22, L42），来源是 `DATABASE_URL` 的 pathname，不是模型参数。JSONB `payload.tool_calls` 保存 **完整** arguments（L215–219），`write` 的 `content` 因此整份进库。`content TEXT` 无应用层长度限制；工具侧只有 32k 的 **回写给模型** 截断，入库前 `executeTool` 已经 clip 过返回值，但 assistant `tool_calls[].arguments` 仍是模型原始 JSON（`src/chat.ts` L287–293 无限拼接）。

**影响：** 不是经典 SQLi。风险是会话库膨胀、密钥进 backup、以及超长 tool arguments 的内存压力。

**修复建议：** arguments/content 入库前截断并打 hash；密钥类工具输出脱敏；考虑对 `messages.content` 设上限。

---

### P2-6  测试存在但未覆盖对抗面

`package.json` `"test": "tsx --test src/*.test.ts"`。本次 `npm test`：22 pass / 0 fail（`sandbox` / `permissions` / `agent.closeIncompleteTrace` / `mode`）。

**没有**用例覆盖：`env python3`、`find -delete`、symlink `read`、`.env` denylist、doom 并行缺回写、`bashSpawn` 在 linux 的裸 exec。`classifyBash` 测试只断言 `ls` 只读、`rm`/`>`/`npm install`/`python3 foo.py` 非只读（`src/sandbox.test.ts` L58–70）——刚好避开 P0-1 的反例。

---

### P3-1  审批时 Enter = 允许

`src/prompt.ts` L248：`key === "y" || "Y" || "\r" || "\n"` → `"allow"`。误触回车会放行当前 mutation。Esc = 拒绝（L256）是合理的。

**修复建议：** 只有显式 `y` 允许；Enter 忽略或视为拒绝。

---

### P3-2  `AGENTS.md` 与仓库内容进 system prompt（标准注入面）

`buildSystemPrompt` 读取根目录 `AGENTS.md`，上限 16384 字节，冲突说明“以本系统提示和用户为准”（`src/system-prompt.ts` L10–12, L92–104）。这是产品功能。恶意 `AGENTS.md` 仍可要求模型“忽略 plan、直接 bash”。Plan 的硬拦截能挡住写工具；挡不住 P0 的只读 bash。

---

### P3-3  其它小项（有证据、不拔高）

- `BOOLEAN_FLAGS` 含 `"resume"`（`src/index.ts` L46），`main()` 从不读取。
- `searchByWalk` 对模型提供的 `pattern` 做 `new RegExp`（`src/fs-tools.ts` L239–243），存在 ReDoS。
- `globMatch` 极简（L297–304），不是安全边界。
- `--api` 出现在 argv，本机 `ps` 可见。
- `BASE_URL` 若是 `http://`，Bearer 明文出站（`src/chat.ts` L85–90）；属用户配置问题。
- `title.ts` / `compress.ts` 的额外 LLM 调用不计入 `lastUsage`（只累加 `runAgent` 内 `completeChat`）。

`calculate` 是手写递归下降，拒绝字母（`src/tools.ts` L199–256），**没有** `eval`。相对路径在 `resolvePath`/`requireAbsolutePath` 会被拒绝。`isInsideWorkspace` 对 `../` 与兄弟目录 `proj-evil` 的字符串逃逸 **探测为拒绝**（`sandbox.test.ts` + 本次探测）。这些点按现状算安全。

---

## 4. 做得好的地方

相对 `6c2d902` 的盘点缺口，下列在 `32aa8a9` **有代码、有测试或有探测对照，不是文档空话**：

1. **Ask 对 `write`/`delete`/cwd 在区外的 mutation 硬拒绝**（`mutationDenied` L87–89），不再只靠“工作区外”文案再问一次。`permissions.test.ts` 覆盖 `/tmp`。
2. **Plan 三重硬门**（schema 过滤 + `executeTool` + `authorize`/`mutationDenied`），不是只靠 `modeRules` 文本。
3. **非 TTY fail-closed：** `askPermission` 在非 TTY 返回 `"deny"`（`src/prompt.ts` L226）。`--input` 默认 Ask 不会默默写盘。
4. **字面 denylist 对 `/etc`、`~/.ssh` 有效**（直接 path，不含 symlink）。Full 也不能 `write /etc/...`。
5. **全部 `git` 在 Ask 要审批**（`classifyBash` L119 的 `\bgit\b`），比 `6c2d902` 把 `git status` 当只读更严。
6. **Ask 下 macOS 不再 fallback 裸 bash**（`bashSpawn` L155，`confineWrites`）。
7. **doom-loop 与失败轮写回已存在：** `REPEAT_LIMIT`；`TurnFailed`/`closeIncompleteTrace`；`saveFailedTurn`（`src/index.ts` L182–200, L662–663）。Abort 存 user+已完成 tool，不存半截 assistant——与 README 一致。
8. **API usage：** `parseUsage`（`src/chat.ts` L297–311），流式 `include_usage`（L80）；`/context` 打印 `API 回报 prompt/completion`（`src/index.ts` L484–488）。
9. **密钥展示默认 mask**（`formatProvider` / `maskApiKey`，`src/provider.ts` L95–111）；`.env`/`providers.json` 在 `.gitignore`。
10. **PG 参数化查询 + role CHECK**；`calculate` 无 eval；bash `stdio: ["ignore",…]` 不把 TTY 交给子进程；超时杀进程组；工具 JSON 解析失败 **返回字符串** 而不是把半截 call 丢掉后静默（`src/tools.ts` L158–161）。
11. **`npm test` 22/22 通过**（安装依赖后）。`npm audit` 当时 0 vulnerabilities（锁文件 `pg@8.23.0`，声明 `^8.16.3`）。

---

## 5. 优先修复顺序（最多 7 项）

1. **堵住 `classifyBash` 只读白名单**（P0-1）：没有可靠解析前，Ask/Plan 不要因首词是 `env`/`find`/`echo`/`cat` 就放行。
2. **路径全部 `realpath` 再授权**（P0-3），symlink 指向区外或 denylist 则拒绝。
3. **密钥面**（P0-2）：denylist 覆盖 `.env`/`providers.json`；bash 环境剔除 API key；`read` 默认不出 workspace。
4. **bash 的工作区策略看命令，不只看 cwd**（P1-1）；Ask 禁止区外重定向。
5. **收紧 `a` 与永远询问的命令**（P1-2）：`sudo`/`curl`/`python` 不能被 `git status` 的 always 带过。
6. **Linux 隔离 + Full 禁止静默脱壳**（P1-3）；补 **audit log**（P2-1）。
7. **doom 返回走 `closeIncompleteTrace`，工具执行中允许 Esc，限制 stdout/read 内存**（P2-2 / P2-3）。补对抗测试：`env python3`、`find -delete`、symlink read、`.env` 拒绝。

不要先做 MCP / 全屏 TUI / 自动 routing。Phase 2 没闭合前，扩展攻击面没有意义。

---

## 6. 阶段评分更新

判定与先前盘点相同：DONE = 有可运行核心路径；PARTIAL = 有代码但关键语义不成立或半截；MISSING = 无模块。对照基线是 `6c2d902` 盘点（Phase 0 DONE / 1 PARTIAL / 2 PARTIAL / 3 PARTIAL / 4 PARTIAL）。

| Phase | `6c2d902` | `32aa8a9` | 说明 |
| --- | --- | --- | --- |
| 0 Minimal MVP | DONE | **DONE** | 不变。 |
| 1 Survive multi-turn | PARTIAL | **PARTIAL** | doom-loop、失败写回已从无到有，但 doom 可规避且并行缺回写；compaction 仍是手动 `/compress`；工具执行中 Esc 暂停。未升 DONE。 |
| 2 Safety | PARTIAL | **PARTIAL（未升）** | Ask 区外 `write` 硬拒绝、Ask 不再 sandbox fallback、git 全审批、薄测试——有进步。仍无 audit、无 Linux sandbox、`classifyBash` 可绕、无 realpath、bash 只锁 cwd。 **不能标 DONE。** |
| 3 UX/cost | PARTIAL | **PARTIAL** | API `usage`：MISSING → 有解析 + `/context` 展示。仍无 cache 断点、无价格、非全屏 TUI。 |
| 4 Extensibility | PARTIAL | **PARTIAL** | Plan 仍 DONE。现有 `node:test` 不是 eval suite。无 MCP/plugin/subagent。 |

**Phase 2 仍为 PARTIAL。** PR2 修的是盘点 M1 的 Ask-write 部分、M2、M5 的薄切片，不是 Safety 阶段完成。
