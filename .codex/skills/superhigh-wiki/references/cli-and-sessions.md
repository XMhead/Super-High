# CLI 与会话

核对日期：2026-10-30。CLI 表示用户安装的命令行工具。

## Agent CLI

当前提供方包括 Claude Code、Codex、Kimi Code、Grok Build、Gemini、OpenCode 和 CodeBuddy Code。
“设置 → 终端”检测工具，并可隐藏不使用的入口。
每个 CLI 使用自己的安装、账户、认证和模型配置。
多个会话可分别指定工作目录。
新建对话支持初始提示词及常用语；会话名称可修改。
历史恢复取决于对应 CLI 是否提供有效会话标识。

## 会话视图

侧边列表切换活动会话。
管家的“多终端对话”开启网格视图。
网格默认 3×3；超过九个会话后增加可滚动行。
“对话管理”展示本机 CLI 历史，并支持查看和恢复。
当前对话管理是提供方卡片界面；名称不表示节点连线图。
当前源码支持鼠标侧键循环切换 Agent CLI 会话。
左右方向键交给终端，不切换会话。

## 输入辅助

代码选择和 HTML 长按可把来源放入活动 CLI 草稿。
CLI 输入支持常用语、提示词历史及图片附件。
图片能否进入模型上下文取决于对应 CLI 支持。
输入 `/` 可发现项目及全局 Skills；右键可预览文件。
`/prompt` 打开提示词历史。
选择 Skill 后，发送逻辑携带其调用内容。
当前源码关闭输入框 Tab 补全；Skills 菜单仍有自己的入口。
输出中的可识别路径、行号和 diff 行号可打开代码预览。
“移到外部继续”使用外部 CLI 窗口；外观设置控制最大化偏好。

## 本地终端与原生 CLI

顶部“本地终端”打开 PowerShell。
真实 PTY 可执行命令或启动项目服务。
Agent CLI 由独立会话宿主持有 PTY、Codex 后端及提供方连接。关闭 Super High 后自动显示可交互的原生终端；重新打开对应工作区隐藏外部终端并接回同一会话和进程，不另建 Agent 副本。
明确关闭 Agent 会话或外部终端窗口会结束该会话及宿主；CLI 自己退出后宿主和外部终端自动回收。普通隐藏和切换标签不会关闭会话。
本地 PowerShell 等仍由桌面直接持有的 PTY 随应用关闭，并受更新和重启保护约束。升级前已启动的旧内嵌 Agent 会话仍沿用原生命周期，不能在线转移。
`superhigh-cli` 提供文件、搜索、记忆关系、提示词、备忘录、工具、工作区、终端和服务入口。
参数使用命令组 `--help` 查询。
历史工作区查询不要求桌面运行；终端、服务和备忘录桥接要求桌面运行。界面关闭时独立 Agent 继续执行，Super High 专属桥接暂不可用。
PTY 写入成功只表示输入交付；读取日志后才能确认内部命令结果。

## 直接来源

| 功能 | 来源 |
| --- | --- |
| 提供方 | [cliProviders.ts](../../../../src/lib/cliProviders.ts)、[cli_env.rs](../../../../src-tauri/src/cli_env.rs) |
| 输入及 Skills | [TerminalPane.vue](../../../../src/components/TerminalPane.vue)、[skills.rs](../../../../src-tauri/src/skills.rs) |
| 会话视图 | [CliTerminalGrid.vue](../../../../src/components/CliTerminalGrid.vue)、[ConversationMapPanel.vue](../../../../src/components/ConversationMapPanel.vue) |
| PTY 与命令组 | [terminal.rs](../../../../src-tauri/src/terminal.rs)、[cli.rs](../../../../src-tauri/src/cli.rs)、[CLI.md](../../../../CLI.md) |
| 独立 Agent 与外部窗口 | [agent_host.rs](../../../../src-tauri/src/agent_host.rs)、[agent_console.rs](../../../../src-tauri/src/agent_console.rs) |
