# 更新日志

记录版本的用户可见变化。新发布说明按固定分类提供中文和英文，版本号与 GitHub Release 标签保持一致。

## [0.1.5] - 2026-09-09

### 新增功能

- 电脑 Host 托管手机网页，安卓 App 连接后加载电脑上的界面；手机浏览器也可直接访问，电脑设置支持预览手机界面。
- 手机页面文件可独立更新，刷新即可加载新版 UI，无需重新构建安装 APK。

### 问题修复

- 修复手机连接推荐地址误选虚拟网卡的问题，并提供明确的中文连接超时提示。
- 安卓安装图标统一为电脑端的蓝紫菱形图标。

### 升级说明

- 使用网页加载方式需更新一次电脑 Host 和安卓 App；后续安卓原生能力或 App 外壳变更仍需安装新版 APK。

---

### New Features

- The desktop Host serves the mobile web UI, which the Android app loads after connecting. Mobile browsers can open it directly, and desktop settings provide a preview.
- Mobile page files can be updated independently; refresh to load the new UI without rebuilding or reinstalling the APK.

### Bug Fixes

- Fixed virtual adapters being selected as the recommended mobile connection address and added a clear Chinese connection timeout message.
- Matched the Android launcher icon to the desktop app's blue-purple diamond icon.

### Upgrade Notes

- Update the desktop Host and Android app once to enable hosted pages. Changes to native Android capabilities or the app shell still require a new APK.

## [0.1.4] - 2026-09-09

### 新增功能

- 安卓手机端新增终端和 AI 对话，可连接电脑会话、发送输入、查看持续输出，并浏览和继续 AI 历史对话；提供 APK 测试安装包。

---

### New Features

- Added Android terminal and AI conversations: connect to desktop sessions, send input, follow live output, and browse or resume AI conversation history; an APK is available for testing.

## [0.1.3] - 2026-09-09

### 新增功能

- 新增 CLI 终端查询，可列出应用内会话并读取近期输出，支持项目筛选与 JSON。
- 新增 CLI 项目脚本工具入口，可查看工具与参数并执行已登记工具。

### 体验优化

- 项目编辑器未登记页面时显示明确的空状态，不再误报编辑器不可用。

### 问题修复

- 修复 Windows 下部分 Node.js 项目脚本因路径格式无法启动的问题。

### 不兼容变更

- 移除远程端功能及配套 CLI 命令、设置中的工作区历史页面和未实现的 Git 导航入口；欢迎页仍保留最近项目。

---

### New Features

- Added CLI commands to list in-app terminal sessions and read recent output, with project filters and JSON output.
- Added CLI commands to inspect project script tools and their parameters, and run registered tools.

### Improvements

- Project editors with no registered pages now show a clear empty state instead of an unavailable error.

### Bug Fixes

- Fixed a Windows path-format issue that prevented some Node.js project scripts from starting.

### Breaking Changes

- Removed remote-end functionality and its CLI commands, the workspace history settings page, and the unimplemented Git navigation entry; recent projects remain on the welcome page.

## [0.1.2] - 2026-09-09

### 新增功能

- 应用内更新：启动后及每隔 4 小时检查正式版，支持后台下载、手动检查和安装后重启。
- 设置中的“应用更新”页面，显示当前版本、下载进度、更新说明和失败重试入口。
- Windows 更新包签名校验，以及 GitHub Actions 的签名构建和更新清单发布流程。
- PDF、Office 文档和媒体预览能力。

### 体验优化

- 安装更新前保护未保存文件和内部终端会话；其他 Super High 窗口仍打开时延后安装。
- 完善 CLI 历史记录、会话展示和终端交互。
- 发布时核对应用版本、标签、安装包和更新清单的一致性。

### 升级说明

- 0.1.0 尚不具备应用内更新能力，需要手动安装一次本版；后续正式版可在应用内更新。
- 0.1.1 未单独发布到 GitHub，其间的开发变化随本版发布。

---

### New Features

- In-app updates: check for stable releases after startup and every four hours, with background downloads, manual checks, and installation followed by a restart.
- An Updates page in Settings showing the current version, download progress, release notes, and retry controls.
- Signature verification for Windows update packages, plus signed builds and update manifest publishing through GitHub Actions.
- PDF, Office document, and media previews.

### Improvements

- Protect unsaved files and internal terminal sessions before installing an update; defer installation while other Super High windows remain open.
- Improve CLI history, session displays, and terminal interactions.
- Validate consistency between application versions, tags, installers, and update manifests before publishing.

### Upgrade Notes

- Version 0.1.0 does not support in-app updates. Install this version manually once; subsequent stable releases can be installed from within the app.
- Version 0.1.1 was not released separately on GitHub. Its development changes are included in this release.

## [0.1.0] - 2026-08-12

- 首次发布 Windows 安装包。

[0.1.3]: https://github.com/XMhead/Super-High/releases/tag/v0.1.3
[0.1.2]: https://github.com/XMhead/Super-High/releases/tag/v0.1.2
[0.1.0]: https://github.com/XMhead/Super-High/releases/tag/v0.1.0
