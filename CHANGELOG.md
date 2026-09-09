# 更新日志

记录版本的用户可见变化。新发布说明按固定分类提供中文和英文，版本号与 GitHub Release 标签保持一致。

## [0.1.10] - 2026-09-10

### 新增功能

- 手机 Markdown 文件支持在渲染预览和原文之间切换。

### 体验优化

- 手机会话改用横向标签栏切换，并在标签内提供关闭入口；刷新和历史对话收进更多菜单，移除独立快捷键行。
- 调整手机输入区与底部安全区域的间距。

### 问题修复

- 手机新建 CLI 会话后立即通知电脑同步会话列表。

### 升级说明

- 会话同步需要更新电脑 Host；手机页面随 Host 更新，现有安卓 App 刷新连接即可加载新界面。
- 自定义指令按钮尚未接入操作，终端画面直接键入仍未接入发送；请继续使用底部输入框发送文本。

---

### New Features

- Switch mobile Markdown files between rendered preview and source text.

### Improvements

- Switch mobile sessions through horizontal tabs with a close action. Move refresh and conversation history into the more menu and remove the separate shortcut row.
- Adjust spacing between the mobile composer and the bottom safe area.

### Bug Fixes

- Notify the desktop immediately after creating a CLI session on mobile so its session list stays synchronized.

### Upgrade Notes

- Update the desktop Host for session synchronization. Mobile pages update with the Host; reconnect the existing Android app to load the new interface.
- The custom command button is not connected yet, and typing directly in the terminal display is not forwarded. Continue sending text through the bottom composer.
## [0.1.9] - 2026-09-10

### 新增功能

- 设置新增 CLI 显示开关，电脑和手机共用设置；关闭后直接隐藏启动入口，保留已有会话。dsh-tui 默认隐藏，显示后使用现有固定程序和配置启动。
- 手机输入框加号支持拍照、相册和文件，附件上传到电脑工作区的 `.superhigh/pasted-images`，支持重试、移除和仅发送附件路径。

### 体验优化

- 手机使用 Super High 完整主题列表，连接后跟随电脑主题；手机选择主题也会同步到电脑。
- 附件依次上传，发送失败保留输入和附件；切换工作区或电脑时隔离上传结果与设置响应。

### 升级说明

- 附件上传及共享设置需要更新电脑 Host；安卓拍照与文件选择器改进需安装新版 APK。单个附件最大 32 MiB。

---

### New Features

- Add shared CLI visibility switches for desktop and mobile. Disabled entries are hidden while existing sessions remain accessible. dsh-tui is hidden by default and uses its existing fixed installation and configuration when shown.
- The mobile composer plus button opens camera, gallery, and file selection. Attachments are uploaded to the computer workspace's `.superhigh/pasted-images`, with retry, removal, and attachment-only sending.

### Improvements

- Use the full Super High theme catalog on mobile. Connecting applies the computer theme, and mobile theme changes synchronize back to the computer.
- Upload attachments sequentially, retain drafts and attachments on send failure, and isolate upload results and preference responses across workspace or computer changes.

### Upgrade Notes

- Update the desktop Host for uploads and shared preferences, and install the new Android APK for camera and file picker improvements. Each attachment is limited to 32 MiB.

## [0.1.8] - 2026-09-09

### 新增功能

- 手机端默认进入工作区终端，通过资源管理器侧栏访问电脑真实文件，账户省略号进入设置。
- 手机输入框支持上移展开、通过加号唤起 CLI 斜杠命令及安卓系统语音识别，识别结果可编辑后发送。
- 手机设置提供账户连接、数据管理、语言、外观、字号、服务协议与帮助反馈；检查更新统一包含程序与界面。

### 体验优化

- CLI 启动按钮保持终端上方单行横向滚动，手机优先接续电脑当前工作区。
- 电脑和手机暂时禁用 dsh-tui 新建及恢复唤起，保留已有配置和程序。

### 问题修复

- 修复 Windows 安装更新主动断开连接时手机误报失败，改为等待电脑重新开启手机连接后自动加载新版界面。
- 修复安卓退出后自动重新登录，以及编辑或切换电脑连接时影响已有终端的问题。

### 升级说明

- 安卓系统语音输入需要安装新版 APK，并由手机提供系统语音识别服务；电脑需更新以支持工作区同步与统一更新接口。

---

### New Features

- Open the workspace terminal by default on mobile, browse real computer files in the explorer sidebar, and open Settings through the account ellipsis.
- Expand and lift the mobile composer, invoke CLI slash commands with the plus button, and fill editable text through Android system speech recognition.
- Add connection, local data, language, appearance, font size, terms, and help settings; combine application and interface updates in one entry.

### Improvements

- Keep CLI launch buttons in a single horizontally scrolling row above the terminal and prefer the computer's active workspace on mobile.
- Temporarily disable new and resumed dsh-tui launches on desktop and mobile while preserving existing configuration and binaries.

### Bug Fixes

- Handle the expected connection loss during Windows installation and reload the updated interface after mobile access is re-enabled on the desktop.
- Prevent automatic reconnection after Android logout and preserve the active terminal while editing or validating another computer connection.

### Upgrade Notes

- Android system voice input requires the new APK and an available system speech recognition service; update the desktop host for workspace synchronization and unified update APIs.

## [0.1.7] - 2026-09-09

### 新增功能

- 手机端默认进入工作区终端，通过资源管理器侧栏访问电脑真实文件，账户省略号进入设置。
- 手机输入框支持上移展开、通过加号唤起 CLI 斜杠命令及安卓系统语音识别，识别结果可编辑后发送。
- 手机设置提供账户连接、数据管理、语言、外观、字号、服务协议与帮助反馈；检查更新统一包含程序与界面。

### 体验优化

- CLI 启动按钮保持终端上方单行横向滚动，手机优先接续电脑当前工作区。
- 电脑和手机暂时禁用 dsh-tui 新建及恢复唤起，保留已有配置和程序。

### 升级说明

- 安卓系统语音输入需要安装新版 APK，并由手机提供系统语音识别服务；电脑需更新以支持工作区同步与统一更新接口。

---

### New Features

- Open the workspace terminal by default on mobile, browse real computer files in the explorer sidebar, and open Settings through the account ellipsis.
- Expand and lift the mobile composer, invoke CLI slash commands with the plus button, and fill editable text through Android system speech recognition.
- Add connection, local data, language, appearance, font size, terms, and help settings; combine application and interface updates in one entry.

### Improvements

- Keep CLI launch buttons in a single horizontally scrolling row above the terminal and prefer the computer's active workspace on mobile.
- Temporarily disable new and resumed dsh-tui launches on desktop and mobile while preserving existing configuration and binaries.

### Upgrade Notes

- Android system voice input requires the new APK and an available system speech recognition service; update the desktop host for workspace synchronization and unified update APIs.

## [0.1.6] - 2026-09-09

### 新增功能

- 桌面版增加日常使用新手教程，覆盖项目、对话、文件、终端、渠道排错和手机端接续；完成或关闭后不再自动播放，支持在设置中重放。
- 教程支持左右方向键切换步骤、ESC 直接关闭。

### 不兼容变更

- 移除内置 SSH 连接功能及相关设置入口。

---

### New Features

- Add a desktop tutorial for projects, conversations, files, terminals, channel troubleshooting, and mobile access. It stops appearing automatically after completion or dismissal and can be replayed from Settings.
- Navigate tutorial steps with the left and right arrow keys, or close it with ESC.

### Breaking Changes

- Remove the built-in SSH connection feature and its Settings entry.

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
