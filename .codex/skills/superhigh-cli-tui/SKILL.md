---
name: superhigh-cli-tui
description: 维护 SuperHigh CLI、外部 Agent 终端及会话桥接。
---

# SuperHigh CLI 和终端

- 系统、文件、终端与进程能力由 Rust 后端实现；保留 `superhigh-cli` 现有命令、退出码、JSON 和 MCP 协议，入口与参数以 `CLI.md` 和 `--help` 为准。
- SuperHigh 自带 TUI、其自研 Agent 和 CLI JavaScript 插件宿主已移除；不要重新引入。桌面聊天模式、工作模式、外部 Agent 接入及会话调度独立保留。
- 已移除的本地服务终端仅指项目服务端日志、服务启停和 Minecraft 客户端托管。Agent CLI 的启动按钮、PTY、聊天与工作模式属于外部会话链路，继续由现有会话入口承载。
- CLI 入口是 `src-tauri/src/bin/superhigh_cli.rs`，命令分发是 `src-tauri/src/cli.rs` 及对应 `cli_*.rs`；桌面 JavaScript 插件与 CLI 插件宿主无关。
- 外部 Agent 会话以 `terminal list --json` 的实际登记为准；保留现有会话和草稿，重启桌面前遵守根项目的会话保护。
- 会话进程清理由 `src-tauri/src/process_tree.rs` 承载，以 PID 和创建时间确认身份；独立会话宿主 `agent_host.rs` 不因删除自研 TUI Agent 而移除。
- 修改后验证受影响的 CLI 命令及外部会话调用链；修改 Rust 或桌面功能时按项目集成入口构建和验收。

## 聊天与工作模式

- 终端渲染器按工作模式惰性加载，返回聊天时销毁实例和输出监听。聊天复用后台原生会话，通过 `read_cli_chat_ui_command` 获取菜单与忙闲状态；后端实现在 [cli_chat_ui.rs](../../../src-tauri/src/cli_chat_ui.rs)，前端生命周期在 [TerminalPane.vue](../../../src/components/TerminalPane.vue)。隐藏终端不等于释放渲染器。
- 聊天视图的正文、思考和工具输出复用 [markdown.ts](../../../src/lib/markdown.ts)；主工作区的工作模式由 Wraith 的 xterm 6 兼容路径渲染原生终端，WebGPU 不可用时由库回退 DOM，实例与工作视图同生命周期。[cliChatText.ts](../../../src/lib/cliChatText.ts) 的正文清洗保留 SGR，过滤 OSC 和其它终端控制序列；模型名和状态标签仍用纯文本清洗。渲染器启用、回退、WASM 和原生缩放按 [终端渲染验收](../superhigh-html/references/terminal-rendering.md) 的脚本入口检查。
- 原生问答复用 `CliQuestionForm.vue` 和 `CliSessionQuestions.vue`，按会话枚举待答请求；`CliPlanProposal.vue` 承载另一套标记块决策协议。所有 Agent CLI 仅在聊天模式和通知加载问答／Plan 表单；工作模式只显示原生终端，不额外挂载表单或轮询待答问题。请求身份、未提交答案和快照版本由会话共享状态管理，切换视图后的迟到查询不得恢复已答问题；异步回复走原生用户消息及 ACK，阻塞式 Plan 走原请求响应。通知查询成功但请求为空时关闭；查询失败须保留草稿并允许恢复，不得把连接错误当作问题结束。
- 操作验收见 [渲染与问答](../superhigh-html/references/chat-history.md#渲染与问答)。

- 同一冻结历史的内嵌与直接 Codex 首 token 对照：`python scripts/compare-codex-latency.py --help`；使用独立工作目录，按原生 task_started 和 task_complete 指标验收并清理认证副本。
- Codex 录制、xterm WebGL／Wraith 本地压力与 IUI 报告生成，见 [终端渲染基准](references/renderer-benchmark.md)。
- 英文重影与 DPI 网格用 `node .codex/skills/superhigh-cli-tui/scripts/inspect-terminal-glyphs.mjs --help` 检查；Wraith 0.6.1 的物理像素网格补丁由 `scripts/patch-wraithterm.mjs` 在 npm 安装后应用，升级依赖时须复核。

## 方法

方法与流程由本 skill 的 `assets/skill-engine.yml` 声明；按以下入口查询和调用：

- 查找：`find --skill superhigh-cli-tui --workspace . --query "<关键词>" --limit 5`；浏览用 `catalog --skill superhigh-cli-tui --workspace . --limit 10`，按 `next_offset` 翻页。
- 契约：`describe --skill superhigh-cli-tui --workspace . --name <名>` 读取选中 method/workflow 的参数；完整定义加 `--detail`。
- 执行：`call|run --skill superhigh-cli-tui --workspace . --name <名> --args-json <JSON>`；方法用 `call`，流程用 `run` 并默认加 `--state-inline`，导入名称保留命名空间。
- 判断点：内存模式在 `status: waiting` 时保留返回的 `state` 对象，按 `judge` 审查后经标准输入传给 `resume --state-stdin --answer-json <JSON>`；需要跨会话恢复时显式指定 `--state <文件>`。

## 参考

- 终端渲染基准、Codex 采集、GPU 完成吞吐：[renderer-benchmark](references/renderer-benchmark.md)
