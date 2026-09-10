# 更新日志

记录版本的用户可见变化。新发布说明按固定分类提供中文和英文，版本号与 GitHub Release 标签保持一致。

## [0.1.19] - 2026-09-10

### 体验优化

- 将渠道检测移至设置，移除重复的分组信息，集中管理渠道状态。
- 精简终端支持、配置入口及其依赖，统一桌面与手机端的可用终端选项。

---

### Improvements

- Move provider checks into Settings and remove duplicate group information to centralize provider status management.
- Simplify terminal support, configuration entry points, and dependencies, with consistent available terminal options on desktop and mobile.

## [0.1.18] - 2026-09-10

### 新增功能

- 设置 → 配置新增系统图片查看器开关，默认关闭；手动启用后，可在 Windows 中选择 Super High 打开图片，关闭后移除该注册。

---

### New Features

- Add a system image viewer toggle under Settings → Configuration, disabled by default. Enable it manually to make Super High available for opening images in Windows; disabling it removes the registration.

## [0.1.16] - 2026-09-10

### 问题修复

- 电脑端记住手机连接服务的开启状态，重启后使用原地址配置和配对令牌恢复服务；主动关闭后保持关闭。
- 手机端在电脑重启或连接中断后自动重试连接，主动退出连接后停止重连。

### 升级说明

- 从旧版升级后，请在新版电脑端开启一次手机连接服务，之后即可随电脑端启动自动恢复。
- 本次只恢复连接，不恢复电脑端重启前的终端进程或任务。

---

### Bug Fixes

- Remember whether the desktop mobile connection service is enabled and restore it with the saved address settings and pairing token after restart; keep it disabled after an explicit stop.
- Automatically retry mobile connections after a desktop restart or connection loss, and stop reconnecting after an explicit disconnect.

### Upgrade Notes

- After upgrading from an older version, enable the mobile connection service once in the new desktop version to allow automatic restoration on subsequent launches.
- This update restores connections only; it does not restore terminal processes or tasks from before a desktop restart.

## [0.1.15] - 2026-09-10

### 体验优化

- 移除 CLI 终端四周的留边，让终端内容贴合面板。
- 移除左侧活动栏的文档预览和终端按钮。

### 问题修复

- 修复 CLI 终端标签之间的间隙导致选中背景显示不完整的问题。

---

### Improvements

- Remove the outer spacing around CLI terminals so their content fits the panel.
- Remove the document preview and terminal buttons from the left activity bar.

### Bug Fixes

- Fix gaps between CLI terminal tabs that made the selected background appear incomplete.

## [0.1.14] - 2026-09-10

### 体验优化

- Android 支持在应用内检查、下载更新并打开系统安装界面，手机应用更新无需连接电脑。
- 手机设置分别显示 Android 应用与电脑更新；旧版安卓外壳和浏览器提供 APK 下载直链，无需在 GitHub 页面寻找附件。

### 问题修复

- 正式 Release 必须包含同版本 Android 安装包，缺少 APK 时阻止发布，避免手机版更新遗漏。

### 升级说明

- 旧版 Android 应用需先下载并安装本版 APK；后续可使用应用内更新，安装仍需在 Android 系统界面确认。

---

### Improvements

- Check and download Android updates in the app, then open the system installer without connecting to a desktop.
- Mobile settings distinguish Android app updates from desktop updates; older Android shells and browsers offer direct APK downloads without searching GitHub release assets.

### Bug Fixes

- Require a matching Android APK before publishing each stable Release to prevent missing mobile updates.

### Upgrade Notes

- Download and install this APK once on older Android versions to enable in-app updates; Android system confirmation is still required for installation.

## [0.1.13] - 2026-09-10

### 问题修复

- 修复桌面 Codex 终端在显示缩放变化后文字缩小、画面偏移的问题。
- 修复终端尺寸计算包含外侧留白导致底部内容被裁切的问题。

---

### Bug Fixes

- Fix shrunken text and shifted content in the desktop Codex terminal after display scaling changes.
- Fix terminal sizing that counted outer spacing as usable space and clipped content at the bottom.

## [0.1.12] - 2026-09-10

### 体验优化

- 文件管理器复用默认工作区的资源管理器，统一文件树样式、展开状态和可调宽度，移除重复的目录标签与根目录行。
- 移除文件管理器的重复标题、路径、选择状态和预览标题行，让文件网格与编辑器顶部对齐，并保持窄窗口下工具栏单行显示。

---

### Improvements

- Reuse the default workspace explorer in the file manager, sharing tree styling, expansion state, and adjustable width while removing duplicate directory tabs and the root row.
- Remove redundant file manager headings, paths, selection status, and preview headings; align the file grid and editor at the top and keep the toolbar on one row in narrow windows.

## [0.1.11] - 2026-09-10

### 新增功能

- 公开版提供 Minecraft 物品搜索、怪物与 DragonCore 等现有工具。

### 体验优化

- 根据当前项目实际存在的插件目录和配置显示相关工具，物品搜索按钮在发现 NI 或 MM 物品目录时显示。

### 问题修复

- 移除物品图标、品质框和怪物库的固定服务器路径回退，避免读取其他项目的数据。

---

### New Features

- Include the existing Minecraft item search, mob and DragonCore tools in the public release.

### Improvements

- Show tools according to the plugin directories and configuration present in the current project. Show item search when an NI or MM item directory is found.

### Bug Fixes

- Remove fixed server path fallbacks for item icons, quality frames and mob libraries to avoid reading another project's data.

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

- 设置新增 CLI 显示开关，电脑和手机共用设置；关闭后直接隐藏启动入口，保留已有会话。
- 手机输入框加号支持拍照、相册和文件，附件上传到电脑工作区的 `.superhigh/pasted-images`，支持重试、移除和仅发送附件路径。

### 体验优化

- 手机使用 Super High 完整主题列表，连接后跟随电脑主题；手机选择主题也会同步到电脑。
- 附件依次上传，发送失败保留输入和附件；切换工作区或电脑时隔离上传结果与设置响应。

### 升级说明

- 附件上传及共享设置需要更新电脑 Host；安卓拍照与文件选择器改进需安装新版 APK。单个附件最大 32 MiB。

---

### New Features

- Add shared CLI visibility switches for desktop and mobile. Disabled entries are hidden while existing sessions remain accessible.
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

### 升级说明

- 安卓系统语音输入需要安装新版 APK，并由手机提供系统语音识别服务；电脑需更新以支持工作区同步与统一更新接口。

---

### New Features

- Open the workspace terminal by default on mobile, browse real computer files in the explorer sidebar, and open Settings through the account ellipsis.
- Expand and lift the mobile composer, invoke CLI slash commands with the plus button, and fill editable text through Android system speech recognition.
- Add connection, local data, language, appearance, font size, terms, and help settings; combine application and interface updates in one entry.

### Improvements

- Keep CLI launch buttons in a single horizontally scrolling row above the terminal and prefer the computer's active workspace on mobile.

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
