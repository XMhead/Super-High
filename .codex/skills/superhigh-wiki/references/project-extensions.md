# 项目扩展

核对日期：2026-10-12。当前工作区是项目扩展加载边界。
本页说明用户能力；完整配置和消息桥由 workspace-config skill 维护。

## 脚本工具

顶部“脚本工具”合并全局与当前项目登记的工具。
项目注册表为 `.superhigh/script-tools.json`；全局注册表位于 appData。
卡片提供打开脚本目录、打开源码和复制路径。
工具箱固定“全部 / 全局 / 项目”三个来源入口。
点击卡片选中脚本并打开登记的扩展界面。
路径按钮独立操作，不改变所选脚本。
工具箱按工作区记住来源和脚本，重开与重启后恢复。
来源标识与唤起指令共用同一组件和主题颜色。
`hidden` 工具供内部调用。
脚本可使用 Python、Node、CMD、PowerShell 和 pwsh 等支持运行时。
声明参数调用真实脚本；长任务可流式输出进度。
结果渲染 Markdown，文件引用可点击定位，YAML 代码块可高亮。
接口契约可声明用途、参数说明、示例和输出 JSON Schema。
JSON Schema 是声明信息，宿主不自动执行 Schema 校验。
副作用由脚本决定；登记不表示工具只读。

## 项目 HTML 编辑器

项目在 `.superhigh/editor/editor.json` 登记专用 HTML 页面。
管家列出编辑器；文件树也可打开对应 HTML。
顶部“布局”左侧的“编辑器”打开独立多标签窗口；加号或 F4 选择页面。同一工作区复用窗口，重复打开同页会激活已有标签并保留页面状态。
页面运行在 sandbox iframe，继承主题和字体。
`window.superhighEditor` 请求工作区文件和登记工具。
宿主桥提供工具发现、JSON 结果及代码预览联动。
HTML 长按可把当前文件路径放入 CLI 草稿。
具体业务功能由项目定义。
外部浏览器直接打开页面不属于内嵌运行验收。
工具扩展 HTML 使用 Shadow DOM；项目编辑器使用 iframe。
二者宿主和接口不同，维护时必须区分。
通用宿主已移除内置物品搜索及 DragonCore 专用桥。
Minecraft 业务由项目脚本、插件或 HTML 提供。

## 本机插件

“设置 → 插件”展示全局和项目插件、状态及启用操作。
项目插件来自 `.superhigh/plugins`；设置页可打开全局目录。
同 ID 的项目插件覆盖全局插件。
插件可登记命令、执行本机操作和提供自定义文件预览。
`ctx.editor.openWindow({ id, scope, parameters })` 可打开已登记的 HTML 编辑器，返回窗口 label。参数通过现有 HTML 宿主桥传入。
插件是受信任本机代码；安装不形成权限沙箱。
禁用标记和启动参数可在排错时跳过插件。
维护插件格式时读取实际 loader 和运行接口。

## 直接来源

| 能力 | 来源 |
| --- | --- |
| 工具箱与运行 | [ScriptToolsPanel.vue](../../../../src/components/ScriptToolsPanel.vue)、[ScriptToolExtensionPanel.vue](../../../../src/components/ScriptToolExtensionPanel.vue)、[script_tools.rs](../../../../src-tauri/src/script_tools.rs) |
| 项目 iframe 与桥 | [SuperhighHtmlPreview.vue](../../../../src/components/SuperhighHtmlPreview.vue)、[projectEditorBridge.ts](../../../../src/lib/projectEditorBridge.ts) |
| 编辑器入口 | [SuperhighPet.vue](../../../../src/components/SuperhighPet.vue)、[workspace_config.rs](../../../../src-tauri/src/workspace_config.rs) |
| 插件 | [plugins.rs](../../../../src-tauri/src/plugins.rs)、[pluginRuntime.ts](../../../../src/lib/pluginRuntime.ts) |
