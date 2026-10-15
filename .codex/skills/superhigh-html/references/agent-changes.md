# Agent 变更采集验收

## 构建前

修改采集链路或排查摘要缺失时，先在原问题工作区运行以下入口。它直接编译当前采集模块，复用已有正式构建依赖。它不会启动桌面应用。

`node scripts/check-agent-changes.mjs --project <实际工作区> --target-dir <已有正式构建缓存>`

宿主、原生命令与编译器覆盖以 `--help` 为准。原生命令文件只解析，不执行。默认测试命令保留原版 PowerShell 启动方式。

检查必须返回 `available: true`、`cleaned: true`、创建增两行、同轮删除归零和下一轮重新创建。失败时按 `stage`、`reason` 定位；先修复，再正式构建。

## 原版协议与工作区

- 命令证据取原生 `item.command` 或实际 argv。它包含 shell 外层与 shlex 引用；终端缩略文字和最终答复不能替代此证据。
- 使用原问题工作区验证首次基线。小目录测试不能覆盖文件预算、运行缓存、锁文件和并发写入。
- 线程归属按原生 thread/turn ID 验证。隐藏标题线程不能覆盖主会话；下一轮必须保持主会话绑定。
- `available: false` 表示采集未完成。先读取原因，不能把空列表当作零变更。

## 桌面交互

正式版从实际桌面入口启动后，验证原版 CLI 默认命令、摘要、文件列表、差异、第 2 行首次点击和真实编辑器焦点。构建前检查不替代这条链路。

主窗口需要保留时，只使用本轮创建的独立实例。自动化通道沿用 UI 约束的“桌面 UI 定位与验收”。

通过真实 Tauri 实例读取会话与差异。CLI 本机桥接可能属于另一实例；按目标实例的 TerminalManager 核对归属。只关闭本轮创建且已确认的会话和实例。

截图辅助布局判断；结构化结果须包含文件路径、增删行数、实际行号和单次点击结果。摘要、列表及差异均以预览和 CLI 的矩形边界判断归属。

## 直接来源

| 对象 | 权威源 |
| --- | --- |
| 构建前检查及真实采集模块调用 | [check-agent-changes.mjs](../../../../scripts/check-agent-changes.mjs)、[check-agent-changes.rs](../../../../scripts/check-agent-changes.rs) |
| 默认命令解析、PROFILE 判断 | [command_scope.rs](../../../../src-tauri/src/command_scope.rs) |
| 基线、运行缓存及未知原文 | [command_changes.rs](../../../../src-tauri/src/command_changes.rs) |
| 原生回合绑定与迟到事件 | [terminal.rs](../../../../src-tauri/src/terminal.rs)、[claude_changes_hooks.rs](../../../../src-tauri/src/claude_changes_hooks.rs) |
| 净差与行号 | [agent_changes.rs](../../../../src-tauri/src/agent_changes.rs) |
| 摘要、列表及点击链路 | [PreviewChangesPane.vue](../../../../src/components/PreviewChangesPane.vue)、[workspace.ts](../../../../src/stores/workspace.ts) |
