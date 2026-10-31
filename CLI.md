# Super High CLI

`superhigh-cli` 复用桌面应用的 Rust 后端，供命令行、脚本及 Agent 调用。

```powershell
superhigh-cli --help
superhigh-cli tools --help
# 在源码工作区运行：
npm run cli -- --help
```

所有命令支持 `--json`。成功退出码为 0；参数、执行或桥接失败为非零，错误说明写到 stderr。`tools run`、`service`、`terminal` 的执行结果在失败时仍可包含 stdout JSON，请同时检查退出码。

## 命令

| 命令 | 功能 |
| --- | --- |
| `agent sessions/tasks` | 调度 SuperHigh 托管的 Codex / Claude Code 会话，提交、查询、等待与中断任务 |
| `mcp serve` | 将相同的会话与任务接口提供为 stdio MCP 工具 |
| `appearance headings get/set/reset` | 查看或修改 Markdown 渲染的 H1～H6 标题颜色 |
| `automation list/save/delete` | 管理系统内置、全局和项目自动任务 |
| `files ls/read/write/touch/mkdir/rename/delete` | 文件及目录操作；删除须带 `--force` |
| `files open <path>` | 在桌面代码预览打开当前工作区内的文件；`.shui`、`.html` 自动切到预览 |
| `search <query>` | 文件名及文本搜索；`--limit` 限制数量，`--no-text` 只搜索文件名 |
| `memory graph` | 输出项目指令、记忆卡片及文件引用关系 |
| `memo` | 备忘录正文、分类、附件、链接、窗口、筛选、剪贴板及 CLI 草稿操作 |
| `env cli` | 检测 CLI 命令及安装路径 |
| `service status/start/stop/restart` | 通过桌面应用操作项目服务及 Minecraft 客户端 |
| `tools list/run` | 发现并执行项目登记的脚本工具 |
| `workspace list/inspect` | 查看历史工作区及 `.superhigh` 状态、真实编辑器与脚本契约 |
| `terminal list/logs/create/write/key/resize/close` | 创建、操作及检查桌面应用的真实终端 |

完整参数用 `superhigh-cli <命令组> --help` 查看。`--project` 不是全局参数：`files/env` 不接受它；`service` 必须显式传绝对路径；`terminal` 不传时查询全部项目，传入时也须用绝对路径；`automation` 不传时只处理系统与全局任务；其余支持项目路径的命令默认当前目录。

## 自动任务

设置 → 自动任务与 CLI 共用任务注册表。任务只在 SuperHigh 运行期间按本机时间调度；关闭应用或休眠时错过的时间不补跑。系统内置“定时关闭或重启电脑”默认禁用，可以编辑时间与操作，不能删除。全局和项目任务支持一次性、每日执行关机、重启或命令。三种来源的任务独立执行，不按同 ID 互相覆盖。

```powershell
superhigh-cli automation list --json
superhigh-cli automation list --project "C:\Projects\Example" --json
superhigh-cli automation save --file task.json --project "C:\Projects\Example" --json
# --file - 从标准输入读取单项任务 JSON。
superhigh-cli automation delete --scope project --id daily-check --project "C:\Projects\Example" --json
```

`automation` 省略 `--project` 时只处理系统和全局任务，不默认当前目录。项目任务必须显式指定工作区；保存后由应用持续调度，工作区无需保持打开。返回任务中的 `nextRun`、`lastRun`、`lastStatus` 和 `lastError` 是运行状态，不必在保存时传入。

`task.json` 是单项任务（以下默认禁用，启用前检查时间和命令）：

```json
{
  "id": "daily-check",
  "scope": "project",
  "title": "每日检查",
  "enabled": false,
  "schedule": { "kind": "daily", "time": "18:00" },
  "action": { "kind": "command", "command": "npm test" }
}
```

一次性时间格式为 `{"kind":"once","at":"YYYY-MM-DDTHH:mm"}`；关机/重启动作为 `{"kind":"shutdown"}` 或 `{"kind":"restart"}`。Windows 命令由隐藏的 `powershell.exe -NoProfile -NonInteractive -Command` 执行，最多运行 300 秒。项目命令在所属工作区执行并提供 `SUPERHIGH_WORKSPACE`；全局命令在应用数据目录执行。关机/重启会影响整台电脑。

源码提供系统模板，其用户配置在应用数据目录 `automation-system.json`；全局注册表为同目录 `automation.json`；项目注册表为 `<workspace>/.superhigh/automation.json`，格式均为 `{"version":1,"tasks":[任务]}`。运行状态和项目调度索引保存在应用数据目录 `automation-state.db`。建议 Agent 使用 CLI 保存以完成校验和项目登记。

## Agent 调度与 MCP

运行新版 SuperHigh 桌面应用后，同机外部 CLI 和 SuperHigh 内部 CLI 都可以调用。CLI 与 MCP 共用桌面进程中的任务表，操作的是桌面终端中的真实 Codex / Claude Code，会话不是另一个隐藏的 SDK 进程。CLI 始终返回 `{ok, result}` 或 `{ok:false, error:{code,message}}` JSON，`--json` 可省略。

```powershell
# 新建会话并委派任务；保留 result.taskId 和 result.sessionId。
superhigh-cli agent tasks submit --project "D:\MyProject" --provider codex --prompt "检查当前改动并报告问题" --request-id review-001
superhigh-cli agent tasks get --task <task-id> --include-logs
superhigh-cli agent tasks wait --task <task-id> --timeout-ms 10000
# 在同一会话继续对话。
superhigh-cli agent tasks submit --session <session-id> --prompt "继续处理刚才发现的问题" --request-id fix-001
superhigh-cli agent tasks list
superhigh-cli agent sessions list
superhigh-cli agent sessions get --session <session-id>
superhigh-cli agent tasks cancel --task <task-id>
superhigh-cli agent sessions close --session <session-id>
```

`tasks submit` 使用 `--session`，或同时使用 `--project`（绝对路径）和 `--provider codex|claude` 创建新会话，二者不能混用。`sessions create --project <绝对路径> --provider <类型>` 可先建空会话。多行任务用 `--prompt-file <UTF-8文件>`；`--prompt-file -` 从标准输入读取，任务最多 64 KiB。任务正文复用 `.superhigh/terminal-prompts`，通过唯一文件引用关联原生回合。

状态含义：`submitted` 只表示文字已送入终端；`running` 表示原生对话已接收；`completed` 必须有对应原生完成记录；`cancelling` 表示已请求中断，继续查询直至 `interrupted`、`completed` 或 `failed`。其他回合替换了任务且无法确认其原生完成时返回 `superseded`，不会将后来的回答算作该任务结果。终端静默不代表完成。启动信任、登录和权限提示仍在桌面处理，用 `sessions get` 或 `--include-logs` 诊断；接口不自动批准提示。尚未确认接收的任务不发送中断信号，避免操作启动界面。

`wait` 最多等待 30 秒；`waitTimedOut:true` 不取消任务。连接断开也不取消任务。任务记录只在当前桌面进程生命周期内保留，最多 256 条，优先淘汰最早结束的记录。重复调用同一 `--request-id` 与相同参数会取回原任务；桌面重启或记录淘汰后不再提供该去重保证。提交超时后先 `tasks list`，不要盲目重复提交。

回答每页最多 16 KiB，`answerNextOffset` 为下一页 UTF-8 字节位置，用 `tasks get --offset <位置>` 继续读取；`answerTotalBytes` 为完整长度。结果包含原生对话 ID、回合 ID、最近工具活动，以及能与该回合精确对应的文件改动摘要。`sessions close` 只关闭通过 Agent 接口创建、且没有活动任务或未完成回合的会话；其它终端沿用桌面与原有 `terminal` 操作。内部 CLI 自动继承 `SUPERHIGH_SESSION_ID`，用于拒绝自身、上游会话委派与等待，并限制委派链长度。

MCP 客户端配置使用同一个稳定安装入口，`command` 可替换为实际 `superhigh-cli.exe` 的绝对路径。Claude Code 的项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "superhigh": {
      "type": "stdio",
      "command": "superhigh-cli",
      "args": ["mcp", "serve"]
    }
  }
}
```

Codex 的 `~/.codex/config.toml`（或已信任项目的 `.codex/config.toml`）：

```toml
[mcp_servers.superhigh]
command = "superhigh-cli"
args = ["mcp", "serve"]
tool_timeout_sec = 60
```

也可用各客户端 CLI 注册：

```powershell
codex mcp add superhigh -- superhigh-cli mcp serve
claude mcp add --transport stdio --scope user superhigh -- superhigh-cli mcp serve
```

MCP 提供 `sessions_list/create/get/close` 和 `tasks_submit/list/get/wait/cancel` 九个工具；参数与 CLI 对应，字段用 `sessionId`、`taskId`、`requestId`、`timeoutMs`、`includeLogs`。采用标准 MCP 初始化、工具发现与结构化返回，支持协议版本 `2025-06-18` 和 `2025-11-25`；不提供 HTTP 监听或自动修改客户端配置。等待调用串行处理且有 30 秒上限。MCP 等待取消不会取消桌面任务，只有显式 `tasks_cancel` 请求中断。

## 历史工作区与扩展状态

```powershell
superhigh-cli workspace list --json
superhigh-cli workspace list --filter "项目名称" --limit 10 --offset 0 --json
superhigh-cli workspace inspect --project "D:\MyProject" --json
```

`list` 只读 SuperHigh 历史记录，默认返回 20 项，最多 100 项。
检查 `total`、`offset`、`hasMore`，用 `--offset` 查看后续记录。
它保留已失效工作区并标明状态，不依赖桌面应用运行。
`inspect` 默认当前目录，输出完整工具契约；`list` 只输出工具摘要。
两者返回 `.superhigh` 文件元数据、真实编辑器入口、hidden 工具及声明缺口。
图片、粘贴图片目录和未登记模板不进入文件清单。
配置值和页面正文不进入状态结果；页面正文按返回路径用 `files read` 获取。
调用检查只识别 `runScriptTool` / `runScriptToolJson` 的字面量 ID，动态 ID 和包装函数需读取对应页面。
`legacyHostApiReferences` 标出已移除专用接口的静态引用；是否有替代路径仍需检查页面。
`state=ready` 表示配置可读取并通过加载检查，不代表页面业务已运行验证。

## 备忘录

运行新版桌面应用并打开工作区，然后执行 `superhigh-cli memo --help`。
CLI 与界面共用备忘录。命令先保存界面中的待保存内容，再执行操作并回传结果。
`--json` 返回 `{ok, result}`；执行失败返回非零退出码。

`list` 默认返回 50 条摘要，支持搜索、分类、创建时间和分页。
用 `get --id <id>` 获取正文和附件。
用 `create` 新增，用 `update --id <id>` 修改指定字段，用 `append` 追加正文。
`--content-file <UTF-8文件>` 支持多行内容；文件名 `-` 从标准输入读取。
`text --id <id> --output <文件>` 导出正文和附件路径。

`category` 支持查询、新增、改名和删除。
分类改名同时移动分类内的备忘录。分类删除保留备忘录，并改为未分类。
`attachment` 支持查询、添加和移除图片路径。移除附件保留原文件。
`links` 从传入内容提取网页链接，并获取标题。

`open/close/select/mode/filter/frame/status` 操作或查询实际备忘录窗口。
`image` 支持打开附件、缩放、适合窗口、平移和关闭。
`copy/paste` 使用系统剪贴板。`insert` 只插入活动 CLI 的输入草稿。
命令超时后先查询 `status` 或 `get`，确认实际结果后再决定是否重试。

## Markdown 标题颜色

```powershell
superhigh-cli appearance headings --json
superhigh-cli appearance headings set --h1 "#FF9B9BFF" --h2 "rgba(255, 213, 128, 1)" --json
superhigh-cli appearance headings reset h2 --json
superhigh-cli appearance headings reset --json
```

与“设置 → 外观 → Markdown 标题颜色”共用同一设置，所有主题及手机端 Markdown 渲染共用一套映射。
颜色接受 `#RGB`、`#RRGGBB`、`#RRGGBBAA`、`rgb()`、`rgba()`（alpha 为 0～1 或百分比），统一保存为 `#RRGGBBAA`。
六级标题默认使用红、黄、绿、青、蓝、紫六种不透明亮色：h1 `#FF9B9BFF`、h2 `#FFD580FF`、h3 `#A7E89BFF`、h4 `#8DE2E8FF`、h5 `#A8BEFFFF`、h6 `#D8B2FFFF`。MD 键值面板继承同一配色，只用缩进表示层级。已有自定义颜色保持原样，可用 `reset` 应用新默认值。
`get` 只读，不需要应用运行。`set/reset` 直接写入设置库，只改该字段；应用运行时立即刷新，JSON 的 `appliedToRunningApp` 为 `false` 表示下次启动生效。`reset` 不带级别时全部恢复默认。

## 脚本工具

`tools list --all --json` 包含编辑器内部工具及接口契约。
`tools list --id <工具ID> --json` 只输出指定工具，自动包含 hidden 工具。
`tools list` 和 `tools run` 使用 `--scope effective|global|project` 选择来源，默认合并全局和项目，项目同 ID 优先。
来源由注册表路径决定；工具顶层不声明分类字段。`parameters[].type` 仍表示字符串或布尔参数。
契约包含用途、参数说明、参数示例和输出格式、JSON Schema、输出示例。
JSON Schema 是说明，宿主不执行 Schema 校验。

```powershell
superhigh-cli tools list --project "D:\MyProject" --json
superhigh-cli tools run check-config --project "D:\MyProject" --arg scope=all --json
```

工具来自项目 `.superhigh/script-tools.json` 及其登记目录，沿用现有运行时与参数配置。先用 `list` 查看工具 ID 和 `parameters`，再用可重复的 `--arg 参数ID=值` 传参。布尔参数传 `true` 或 `false`。`run` 返回工具 stdout、stderr 和 exitCode，工具失败时 CLI 也返回非零。实际执行脚本可能修改项目，取决于该工具的功能。

## 终端状态与日志


```powershell
superhigh-cli terminal list --json
superhigh-cli terminal list --project "D:\MyProject" --json
superhigh-cli terminal logs <session-id> --tail 100 --json
```

需要运行本次构建的桌面应用。`list` 读取应用的 TerminalManager 登记表，返回 `holdsPtyChild`、`running` 和 `processId`；`holdsPtyChild` 表示桌面进程直接持有 PTY，独立 Agent 宿主会话为 `false`，`processId` 仍返回原 CLI 进程。项目过滤按终端启动目录及其子目录匹配。Agent CLI 关闭桌面后显示可交互的原生终端，重开对应工作区隐藏外部窗口并接回原会话；`terminal close`、关闭外部终端或 CLI 自己退出会回收会话及宿主。桌面关闭期间本命令桥接不可用。`logs` 读取指定会话已有的输出缓冲，不发送终端输入。默认最后 100 行，最多 2000 行且受 32 KiB 上限约束，保留 ANSI 控制序列；JSON 的 `truncated` 和字节偏移说明是否截断。日志是有限缓冲快照，不是完整历史记录或实时订阅。

### 创建与操作

需要运行新版桌面应用。`create` 默认启动本地 PowerShell（`--provider local`），也可指定已有 AI provider。返回 `sessions[0].id` 用于后续操作。会话登记在真实 TerminalManager 中，不自动打开桌面终端标签。

```powershell
$session = (superhigh-cli terminal create --project "D:\MyProject" --json | ConvertFrom-Json).sessions[0].id
superhigh-cli terminal write $session --input 'ping.exe -t 127.0.0.1' --enter --json
superhigh-cli terminal key $session --key ctrl+c --json
superhigh-cli terminal write $session --input 'echo OK' --enter --json
superhigh-cli terminal logs $session --tail 30 --json
superhigh-cli terminal resize $session --cols 120 --rows 30 --json
superhigh-cli terminal close $session --json
```

程序输出异步产生，应通过 `logs` 等待目标输出后再进行下一步。`write` 原样发送文本，不解析转义，只有加 `--enter` 才追加回车。`key` 支持 `ctrl+c`、`enter`、`escape`、`tab`、`backspace`、`ctrl+d`。Ctrl+C 发送控制字符，效果由当前前台程序决定；`close` 结束指定会话及其子进程，不能代替 Ctrl+C。

### 会话改动

```powershell
```



`create` 必须指定绝对项目目录；其他命令可用 `--project` 限定会话启动目录范围。会话操作必须指定 ID。操作成功表示输入已交给 PTY，不代表终端内命令执行成功。测试后关闭自行创建的会话，避免占用应用更新或重启。

## 服务

```powershell
superhigh-cli service status --project "D:\MyServer\plugins" --json
superhigh-cli service start --project "D:\MyServer\plugins" --service client --json
superhigh-cli service stop --project "D:\MyServer\plugins" --service client --json
```

服务控制需要桌面应用运行。存在 `.superhigh/minecraft-client.json` 时可用 `--service client` 启停客户端；`stop` 目前只支持 client。普通服务 `start` 启动项目配置的服务链，`restart` 使用项目登记的重启动作，多服务项目需要指定服务 ID。

## 相关文档

- Agent 功能维护入口：[superhigh-wiki](.codex/skills/superhigh-wiki/SKILL.md)。
