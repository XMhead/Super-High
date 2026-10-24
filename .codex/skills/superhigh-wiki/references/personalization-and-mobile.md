# 个性化与日常功能

核对日期：2026-10-12。当前源码含部分 0.1.37 待发布变化。

## 主题与字体

“设置 → 外观”切换主题，悬停选项可即时预览。
主题作用于主界面、Monaco 和终端，并可保存。
自定义主题支持导入、导出及下载模板。
Glass 主题含半透明表面；Windows 桌面可启用 Acrylic。
浏览器截图证明配色，不能证明原生毛玻璃效果。
字体按界面、正文和等宽内容分配。
应用提供 Anthropic 字体风格及字体导入。
手机继承电脑字体风格和资源。
外观设置控制对话列表、颜色码渲染和外部 CMD 最大化。
“Markdown 标题颜色”设置 H1～H6 的 RGBA，所有主题及手机渲染共用；`superhigh-cli appearance headings` 可读改同一设置。
当前“设置 → 配置”提供 100%～250% 默认滚动倍率。

## 备忘录

顶部“备忘录”打开可拖动、可缩放的本地面板。
新增和打开笔记默认进入编辑模式。
笔记支持正文、搜索、分类和日期筛选。
当前源码提供近 7 天、14 天和 30 天筛选。
粘贴图片保存为独立附件，可放大、缩放和拖动查看。
添加网页链接会尝试获取标题；失败时保留原 URL。
复制包含附件路径；插入 CLI 只进入草稿。
当前删除笔记不再弹出确认。
笔记保存在本机数据库；获取网页标题需要网络。
`memo` 命令组复用同一界面和数据。

## Super High 管家

管家可拖动、调整大小和展开。
面板提供额度信息、多终端、对话管理和编辑器入口。
额度和余额依赖已有账户及渠道配置。
本轮 Agent CLI 完成提示音和左下角通知已进入当前源码。
历史恢复不会重复播放完成通知。
完成识别依赖 CLI 输出适配；提示不能代替任务结果验收。

## 手机连接

1. 在电脑“设置 → 手机端”启动连接服务。
2. 让手机与电脑处于可互访的局域网。
3. 打开显示的 `/mobile/` 地址，或在安卓 App 填写 Host 地址。
4. 输入电脑显示的连接令牌。
5. 查看工作区和文件，并操作已有终端。

```text
电脑 Host → 局域网与令牌 → 手机页面 / 安卓外壳 → 同一工作区及会话
```

电脑必须运行；手机不独立执行 Rust 或 Agent CLI。
手机支持工作区选择、文件树、文件阅读和终端交互。
Markdown 可切换原文与渲染；树保留展开和滚动状态。
手机主动选择的工作区保持到桌面路径再次变化。
手机页面与 Host 必须版本匹配。
公开录制不展示实际连接令牌。

## 渠道检测

“设置 → 渠道检测”读取 cc-switch 供应商配置。
面板提供筛选、延迟探测、模型列表及相关测试。
cc-switch 数据库只读；供应商修改应在 cc-switch 完成。
账户余额和测试数据不作为默认宣传素材。

## 直接来源

| 能力 | 来源 |
| --- | --- |
| 主题与字体 | [SettingsDrawer.vue](../../../../src/components/SettingsDrawer.vue)、[theme.ts](../../../../src/lib/theme.ts) |
| 备忘录 | [MemoWindow.vue](../../../../src/components/MemoWindow.vue)、[cli_memo.rs](../../../../src-tauri/src/cli_memo.rs) |
| 管家及通知 | [SuperhighPet.vue](../../../../src/components/SuperhighPet.vue)、[CliCompletionNotice.vue](../../../../src/components/CliCompletionNotice.vue) |
| 手机 | [MobileApp.vue](../../../../src/mobile/MobileApp.vue)、[MobileSessions.vue](../../../../src/mobile/MobileSessions.vue)、[mobile_host.rs](../../../../src-tauri/src/mobile_host.rs) |
| 渠道 | [ChannelProbePanel.vue](../../../../src/components/ChannelProbePanel.vue)、[cc_switch.rs](../../../../src-tauri/src/cc_switch.rs) |
