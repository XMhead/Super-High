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
| `appearance headings get/set/reset` | 查看或修改 Markdown 渲染的 H1～H6 标题颜色 |
| `files ls/read/write/touch/mkdir/rename/delete` | 文件及目录操作；删除须带 `--force` |
| `search <query>` | 文件名及文本搜索；`--limit` 限制数量，`--no-text` 只搜索文件名 |
| `memory graph` | 输出项目指令、记忆卡片及文件引用关系 |
| `memo` | 备忘录正文、分类、附件、链接、窗口、筛选、剪贴板及 CLI 草稿操作 |
| `env cli` | 检测 CLI 命令及安装路径 |
| `service status/start/stop/restart` | 通过桌面应用操作项目服务及 Minecraft 客户端 |
| `tools list/run` | 发现并执行项目登记的脚本工具 |
| `workspace list/inspect` | 查看历史工作区及 `.superhigh` 状态、真实编辑器与脚本契约 |
| `terminal list/logs/create/write/key/resize/close` | 创建、操作及检查桌面应用的真实终端 |

完整参数用 `superhigh-cli <命令组> --help` 查看。`--project` 不是全局参数：`files/env` 不接受它；`service` 必须显式传绝对路径；`terminal` 不传时查询全部项目，传入时也须用绝对路径；其余支持项目路径的命令默认当前目录。

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

## 项目脚本工具

`tools list --all --json` 包含编辑器内部工具及接口契约。
`tools list --id <工具ID> --json` 只输出指定工具，自动包含 hidden 工具。
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

需要运行本次构建的桌面应用。`list` 读取应用的 TerminalManager 登记表，返回 `holdsPtyChild`、`running` 和 `processId`；项目过滤按终端启动目录及其子目录匹配。`logs` 读取指定会话已有的输出缓冲，不发送终端输入。默认最后 100 行，最多 2000 行且受 32 KiB 上限约束，保留 ANSI 控制序列；JSON 的 `truncated` 和字节偏移说明是否截断。日志是有限缓冲快照，不是完整历史记录或实时订阅。

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
superhigh-cli terminal changes $session --json
superhigh-cli terminal changes $session --path src/lib/a.ts
```

读取代码预览右下角变更摘要的同一结果。Codex 合并原生补丁净差和命令文件变更；Claude 合并内置 Edit/Write 提交和 Bash 文件变更。命令检测在回合执行前保存工作区文件基线，在命令完成后计算文本净差。同轮创建后删除、修改后恢复均归零。新建或恢复会话时启用采集。

Codex 普通 PowerShell 命令可完整证明写入路径时，只统计这些路径与原生补丁路径。多个命令的写入范围在同轮累积，其他 Agent 的无关改动不会计入。动态目标、未知脚本或外部程序无法证明完整范围时，回退工作区监测。

`changes` 返回原生会话 ID、回合 ID、`revision`、文件列表和增删行数。`--path` 返回当前轮该文件的差异行及原文、新文行号。查询读取采集缓存，不会重新扫描磁盘。命令检测范围为会话启动工作区，并固定使用回合开始时的 `.ignore`；根目录 `.agent/tmp` 文本作为 Agent 临时文件显式纳入检测。采集跳过依赖、构建目录、运行缓存和二进制文件。命令退出失败不会丢弃已经写入的文件。无法确认目标文件的执行前后文本、文本超限或当前 Agent 尚未适配时，`available` 为 `false`，`reason` 说明原因。会话结束后保留最后结果。

`create` 必须指定绝对项目目录；其他命令可用 `--project` 限定会话启动目录范围。会话操作必须指定 ID。操作成功表示输入已交给 PTY，不代表终端内命令执行成功。测试后关闭自行创建的会话，避免占用应用更新或重启。

## 服务

```powershell
superhigh-cli service status --project "D:\MyServer\plugins" --json
superhigh-cli service start --project "D:\MyServer\plugins" --service client --json
superhigh-cli service stop --project "D:\MyServer\plugins" --service client --json
```

服务控制需要桌面应用运行。存在 `.superhigh/minecraft-client.json` 时可用 `--service client` 启停客户端；`stop` 目前只支持 client。普通服务 `start` 启动项目配置的服务链，`restart` 使用项目登记的重启动作，多服务项目需要指定服务 ID。
