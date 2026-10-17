# 工作区与编辑器

核对日期：2026-10-12。依据当前源码；桌面与浏览器能力分别核对。

## 文件和布局

顶部菜单打开工作区；资源管理器展示当前项目文件。
打开文件后，代码预览区新增标签。
多标签支持切换、保存、另存为和关闭。
拖动分栏线调整 CLI、代码和资源管理器的宽度。
顶部布局按钮交换左右布局。
F1 切换资源管理器；设置和对话管理页面不处理该快捷键。
“设置 → 外观”可隐藏侧边对话列表。
活动栏“文件管理器”打开独立文件操作面板。
文件管理器支持目录标签、新建、重命名、复制、移动、导入和删除。
实际文件操作改变磁盘；浏览器模拟仅改变页面覆盖层。

## 搜索和定位

顶部搜索框接受文件名或路径。
`文件名:行号` 可定位代码行；已打开文本文件中 `@符号` 可查找符号。
结果显示项目相对路径。
当前源码支持默认、最近修改、最远修改和打开次数排序。
项目文件搜索遵循 `.ignore` 和 `.gitignore`。
Ctrl+F 查找，Ctrl+H 替换，Ctrl+G 跳行。
Ctrl+Shift+O 查找当前文件符号。

## 代码与 AI 上下文

Monaco 提供语法高亮、编辑、撤销、重做和保存。
选中代码后点击“添加到对话框”。
应用把路径、行号和所选内容放入 CLI 草稿。
检查草稿后再发送；插入草稿不代表 Agent 已收到消息。
编码菜单支持按编码重新打开或保存；非 UTF-8 文件显示编码入口。
当前源码会载入被外部程序修改的已打开文件。

## 内容预览

| 内容 | 操作及边界 |
| --- | --- |
| Markdown | “MD 配置”切换原文和渲染；当前源码保持阅读进度 |
| YAML / Markdown 导航 | 路径栏开关键值面板；点击键或标题定位 |
| ANSI 代码块 | Markdown 渲染终端颜色，支持真实及转义 SGR |
| HTML | 预览开关切换代码和内嵌页面；长按插入路径到 CLI 草稿 |
| 图片 | 预览及放大；查看器支持 A/D、方向键切换，ESC 退出全屏 |
| 音视频 | 支持类型提供播放；解码受 WebView2 支持范围影响 |
| PDF | 阅读和缩放，不提供 PDF 编辑 |
| Word / Excel | 只读；Excel 可切换工作表及分页，不提供完整 Office 编辑 |

代码接受 `.doc/.docx/.xlsx/.pdf` 为文档类型。
Word 使用 docx-preview；不能据 `.doc` 扩展名识别就承诺旧二进制格式可渲染。
Office 预览保真程度需用实际文档验证。
插件可登记特定扩展名的预览提供者。

## 文档站点

顶部“文档预览”检测当前项目的 VitePress 文档目录。
成功后在文档工作区标签显示站点。
没有文档时显示缺失状态。
功能依赖项目的真实文档结构和启动能力。

## 直接来源

| 功能 | 来源 |
| --- | --- |
| 布局与搜索 | [WorkspaceShell.vue](../../../../src/components/WorkspaceShell.vue)、[AppTopBar.vue](../../../../src/components/AppTopBar.vue) |
| 文件管理 | [FileManagerPanel.vue](../../../../src/components/FileManagerPanel.vue)、[fs_ops.rs](../../../../src-tauri/src/fs_ops.rs) |
| 编辑与来源 | [EditorPane.vue](../../../../src/components/EditorPane.vue)、[selectionChat.ts](../../../../src/lib/selectionChat.ts) |
| 类型与媒体 | [path.ts](../../../../src/lib/path.ts)、[MediaViewer.vue](../../../../src/components/MediaViewer.vue) |
| 文档渲染 | [OfficePreview.vue](../../../../src/components/OfficePreview.vue)、[PdfPreview.vue](../../../../src/components/PdfPreview.vue)、[markdown.ts](../../../../src/lib/markdown.ts) |
| VitePress | [DocsWorkspacePanel.vue](../../../../src/components/DocsWorkspacePanel.vue)、[vitepress.rs](../../../../src-tauri/src/vitepress.rs) |
