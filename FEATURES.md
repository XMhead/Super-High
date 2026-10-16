# Super High 功能 Wiki

Super High 把代码编辑、Agent CLI、文件和项目工具放进一个 Windows 桌面窗口。
下面的 Wiki 按用户任务组织，包含操作入口、限制及源码证据。

核对日期：2026-10-12。
应用版本文件当前为 0.1.36；CHANGELOG 中 0.1.37 是待发布变化。
说明依据当前源码；具体安装包行为以该版本实际运行结果为准。

## 开始使用

1. 安装 Super High，并打开项目文件夹。
2. 打开源码文件，或从本地终端执行命令。
3. 安装并登录所需 Agent CLI，然后新建对话。

详细前提见 [产品与入门](.codex/skills/superhigh-wiki/references/product-and-start.md)。

## 功能导航

| 想完成的任务 | Wiki |
| --- | --- |
| 打开项目、调整布局、搜索文件和代码符号 | [工作区与编辑器](.codex/skills/superhigh-wiki/references/workspace-and-editor.md) |
| 编辑代码、选中代码提问、阅读 Markdown/YAML | [工作区与编辑器](.codex/skills/superhigh-wiki/references/workspace-and-editor.md) |
| 查看图片、音视频、PDF、Word 和 Excel | [工作区与编辑器](.codex/skills/superhigh-wiki/references/workspace-and-editor.md) |
| 使用 Agent CLI、恢复会话、浏览历史和 Skills | [CLI 与会话](.codex/skills/superhigh-wiki/references/cli-and-sessions.md) |
| 查看会话改动、点击 diff 定位、操作真实 PTY | [CLI 与会话](.codex/skills/superhigh-wiki/references/cli-and-sessions.md) |
| 把脚本变成工具、使用项目 HTML、插件和服务 | [项目扩展](.codex/skills/superhigh-wiki/references/project-extensions.md) |
| 切换主题、导入字体、管理笔记和图片附件 | [个性化与日常功能](.codex/skills/superhigh-wiki/references/personalization-and-mobile.md) |
| 使用管家、检测渠道、从手机连接电脑会话 | [个性化与日常功能](.codex/skills/superhigh-wiki/references/personalization-and-mobile.md) |

## 使用边界

Agent CLI 使用用户自己的安装、认证和模型配置。
手机端连接电脑 Host；电脑执行终端和后端任务。
项目扩展依赖当前工作区的 .superhigh 登记内容。
Word、Excel 和 PDF 提供阅读预览，不提供完整 Office 编辑。
浏览器模拟复用真实组件，但模拟动作不证明实际后端成功。

## 其他文档

- 安装、开发及构建：[README.md](README.md)。
- 原生命令和参数：[CLI.md](CLI.md)。
- 版本变化：[CHANGELOG.md](CHANGELOG.md)。
- Agent 查询及维护入口：[superhigh-wiki](.codex/skills/superhigh-wiki/SKILL.md)。
- 内容维护与宣传证据：[维护与宣传证据](.codex/skills/superhigh-wiki/references/maintenance-and-promotion.md)。
