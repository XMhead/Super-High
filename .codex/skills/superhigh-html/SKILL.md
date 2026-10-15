---
name: superhigh-html
description: 开发 Super High 浏览器预览，验证真实桌面与手机的界面、输入、文件操作和 Agent 变更采集。
---

# SuperHigh HTML

用于边改源码边体验真实界面，沿用 [UI 约束](../super-high-ui-constraints/SKILL.md)。交付范围遵循用户当前要求及根 AGENTS；本技能负责预览与交互验收。

## 入口

需要手机界面、当前桌面工作区或真实资源时，运行 `npm run superhigh-html -- --page mobile --no-open`，复用 `http://127.0.0.1:1421/` 的手机尺寸容器；`/mobile/` 是同源真实 MobileApp。电脑本机预览自动只读获取桌面配置并连接，用无保存凭据的浏览器会话核对首次打开体验。局域网手机及 `SUPERHIGH_MOBILE_HOST` 指定的其他 Host 沿用正常认证；连接信息不进入源码、查询参数或日志。

设置预览入口为 `http://127.0.0.1:1422/superhigh-html.html`；更新日志用 `npm run superhigh-html -- --section updates --no-open`，直接加载真实日志。需要模拟设置交互时才选择对应场景，例如 `--section mobile --scenario ready`。

项目 HTML 和脚本扩展页面由 Super High 注入字体变量。界面文字使用 `--font-ui` 与 `--font-ui-weight`，正文使用 `--font-content` 与 `--font-content-weight`，代码和终端内容使用 `--font-mono` 与 `--font-mono-weight`。不要在项目 HTML、脚本扩展或生成模板中硬编码系统字体族；主题画廊模板及其生成文件也必须遵循这组变量。

桌面主工作区模拟使用 `npm run superhigh-html -- --page desktop --no-open`，入口为 `http://127.0.0.1:1423/desktop-preview.html`。该页面读取启动目录的真实源码树，并在浏览器内复用 `WorkspaceShell`；文件写入、新建、重命名和删除只进入当前页面的覆盖层，不落盘。终端会话、CLI 输出、设置保存和工作区状态均在浏览器内模拟。默认只读读取真实 Super High 的 `themeId` 和自定义主题，因此预览颜色跟随当前桌面应用；`--theme` 显式参数优先。读取不到本机设置时回退到共享的内置主题。可用 `--scenario ready|empty|error` 切换可用、空状态和失败场景，可用 `--mode readonly` 禁止覆盖层写入；默认 `--mode simulate`。完整参数与有效值以 `node scripts/superhigh-html.mjs --help` 和 [options.ts](../../../src/preview/options.ts) 为准。

## 直接来源

| 改动 | 来源 |
| --- | --- |
| 预览启动、路由、本机连接与热更新监听 | [superhigh-html.mjs](../../../scripts/superhigh-html.mjs)、[vite.mobile.config.ts](../../../vite.mobile.config.ts)、[mobile-preview-host.ts](../../../scripts/mobile-preview-host.ts) |
| 手机工作区、文件树、文件查看与偏好 | [MobileApp.vue](../../../src/mobile/MobileApp.vue) |
| 手机终端输入、指令点击、焦点与会话 | [MobileSessions.vue](../../../src/mobile/MobileSessions.vue) |
| 桌面与手机文件图标 | [fileIcons.ts](../../../src/lib/fileIcons.ts)；样式复用全局 `tree-kind-icon` |
| 设置模拟 | [SettingsPreview.vue](../../../src/preview/SettingsPreview.vue) → [SettingsDrawer.vue](../../../src/components/SettingsDrawer.vue)；状态转换在 [simulator.ts](../../../src/preview/simulator.ts) |
| 桌面主工作区模拟 | [DesktopPreview.vue](../../../src/preview/DesktopPreview.vue) → [WorkspaceShell.vue](../../../src/components/WorkspaceShell.vue)；真实源码读取与覆盖层在 [workspaceSource.ts](../../../src/preview/workspaceSource.ts)，浏览器后端替换在 [desktopSimulator.ts](../../../src/preview/desktopSimulator.ts)，目录接口在 [superhigh-desktop-preview.mjs](../../../scripts/superhigh-desktop-preview.mjs) |
| 文本编辑加载与后端命令 | [workspace.ts](../../../src/stores/workspace.ts) 的 `readEditorFile` → [tauri.ts](../../../src/lib/tauri.ts) 的 `backend.readEditorFile`；模拟适配范围见上述 `desktopSimulator.ts` |
| 真实主题继承 | [desktop.ts](../../../src/preview/desktop.ts) → `/__superhigh_workspace/theme`；本机设置只读查询在 [superhigh-desktop-preview.mjs](../../../scripts/superhigh-desktop-preview.mjs) |
| 当前及历史更新日志 | [releaseNotes.ts](../../../src/lib/releaseNotes.ts) → 根 `CHANGELOG.md`；更新后的桌面行为见 [应用更新日志](../superhigh-github/SKILL.md#应用更新日志) |

## 行为边界

- 手机预览调用真实 Host。工作区、当前文件和 HTML 预览模式双向同步；手机选择历史工作区后，先等待所属电脑实例切换成功，再显示该工作区。文件夹原地展开/收起；打开文件返回后保留树状态与滚动位置。
- 手机创建或恢复 CLI 会话前，先同步电脑工作区；桌面会话事件按会话目录归属处理。不得把其他目录的会话直接加入当前工作区。
- 令牌刷新必须立即持久化并更新正在运行的 Host；界面只显示 Host 已接受的令牌与实际运行状态。旧令牌失效后，手机打开连接设置，等待重新验证。
- 手机 HTML 标签双向切换源码与预览。预览文档、资源和项目编辑器消息复用电脑当前宿主；保留页面范围、脚本结果、文件绑定及错误。同步文件前核对文件属于当前工作区；旧页面响应不得写入新页面。
- 手机控件复用真实行为与共享资源。会话标签保持单行标识；文件类型标签大写，Markdown 标签直接切换原文/渲染并保留偏好。终端输出、输入转发、焦点和点击分别有实际行为，菜单出现不代表输入链路已接通。
- 桌面主工作区模拟只允许读取启动目录内的源码。目录接口拒绝目录外路径；原始源码保持只读，浏览器覆盖层提供可撤销的写入、新建、重命名和删除演示。该页面不调用真实 CLI、Tauri 命令或本机文件写入。
- 当前桌面模拟仅替换 `backend.readFile`，未适配文本编辑入口 `backend.readEditorFile`，打开文本可能内容为空。`searchProjectFiles` 固定返回空结果，因此该模拟不验证真实搜索。录制可用的主题和会话操作；代码阅读或搜索验收使用已验证的桌面入口。修复适配器后重新核对这些边界。
- 先判断数据与动作能否在浏览器直接复用；本地日志、Markdown 和已有真实读取能力直接加载，不因进入预览而替换为模拟数据。仅需模拟的设置动作才覆盖 store 并截断后端调用，明确标记并补状态转换及失败反馈；浏览器不具备的桌面更新操作禁用。
- 热更新仅监听源码，构建缓存、产物与临时公开树不触发页面重载。桌面进程与会话按根 AGENTS 保护；测试会话记录创建来源和 ID，只清理本轮创建的对象。

## 验收与排错

字体继承或字形差异用 [inspect-rendered-fonts.mjs](../../../scripts/inspect-rendered-fonts.mjs) 实测：`node scripts/inspect-rendered-fonts.mjs --cdp <调试HTTP地址> --page-url <实际页面URL> --output <项目临时目录/font-evidence.json>`。按 `--help` 筛选 frame 和文字元素；检查目标路径、iframe 标题及采样范围，不能把父页面结果当作 iframe 结果。未取得目标 frame 或目标文字时，不能判定通过。

该入口读取 `CSS.getPlatformFontsForNode` 的实际字形来源。CSS 字体名、字体文件加载和 `document.fonts.load()` 成功只证明声明或资源可用。分别比较中文、英文和各字体用途的实际字体、字号、字重；中文回退和页面字号不同不能直接判为继承失败，也不能把字体继承描述为外观完全一致。

修改 Agent 变更采集或排查摘要缺失时，按 [Agent 变更采集验收](references/agent-changes.md) 先做实际工作区的构建前检查，再完成真实桌面链路。

涉及手机终端适配、空白、卡顿或跨桌面实例切换时，先按 [手机终端排错](references/mobile-terminal.md) 定位数据、渲染与 Host 归属，并在正式构建前完成相应压力场景。

仅覆盖本轮受影响的完整操作链路，在 390 px、涉及窄屏布局时补 360 px：

- **终端**：从本轮涉及的入口（指令图标、直接点选、操作按钮）进入后，继续输入、Backspace/Delete、Enter 和退出；确认焦点回到终端。快速连续输入保持顺序，切换或关闭视图后迟到输入不会写入其他会话。
- **文件与工作区**：展开/收起目录、保留兄弟节点、打开子文件再返回，核对路径、展开状态及滚动位置；查看器开关双向切换，图标与桌面规则一致。真实 Host 的可空字段按实际返回值处理。
- **双端同步**：刷新令牌后检查新令牌通过、旧令牌拒绝和桌面状态一致；手机选择另一历史工作区后检查电脑路径，再创建 CLI。打开真实 HTML，双端切换预览，并验证已有项目编辑器的脚本、文件绑定和返回。
- **设置模拟**：修改后刷新核对保存，按改动检查重置、空状态或失败场景。保存源码后观察已有页面热更新。
- **桌面主工作区模拟**：先验证源码树、文件打开和终端输入，再验证覆盖层写入、新建、重命名、删除及重置；分别检查 `ready`、`empty`、`error` 和 `readonly`。确认刷新后原始源码未被修改。

浏览器动作串行执行，以 DOM 或终端缓冲中的目标状态判断完成，再继续依赖操作；CLI 返回成功只表示动作已发出。交互无变化时先读目标状态和去重后的首条页面异常，再定向修复，避免连续重复点击或等待。截图只辅助布局判断，关键结果保留路径、状态、行数或焦点等结构化证据。

验收管家等原生子窗口时，先用 Tauri `getAllWindows()` 核对窗口标签。主窗口 CDP 列表缺少目标，不代表目标没有弹出。用户截图已显示通知时，继续核对该通知与对应会话，停止排查“未出现”。

Plan 问答验收记录终端会话与原生会话标识，并按请求核对选项、补充输入和原会话回答记录。通知显示只证明展示完成；未核对回答记录前，不归因于自动回答、超时或串线。

打开文本后核对实际内容长度及当前面板：Monaco 模型或 Markdown 渲染正文必须对应目标文件。标签出现、命令返回或无控制台异常都不代表内容加载成功。空内容先区分数据读取与面板渲染，再检查适配器入口。

桌面正式版界面取证用 `PrintWindow`（`PW_RENDERFULLCONTENT`）抓目标窗口位图：`CopyFromScreen` 会抓到遮挡窗口，`AppActivate` 不保证窗口到前台，`PostMessage` 注入键盘对 WebView2 无效，不用消息注入代替真实输入。需要窗口内的多步交互（打开文件、拖拽分栏等）时走 [桌面 UI 定位与验收](../super-high-ui-constraints/SKILL.md#桌面-ui-定位与验收) 的 `agent-browser --cdp` 通道；`SetCursorPos`/`SendKeys` 注入只能做单步取证（取前台前先敲一次 ALT，组合键与部分字符会失败或被输入法改写），不要用它拼多步操作。浏览器内无法复现的渲染问题可只读同一份文件内容，用 `npm run dev`（1420）按改动前后的配置各建一个编辑器，再用 `msedge --headless=new --virtual-time-budget=<毫秒> --screenshot=<png>` 出图对比。代码预览只打开当前工作区内的文件，应用启动恢复上次活动工作区，原场景在别的工作区时先切到该工作区再验收。

测试按改动选择现有 `src/mobile/MobileApp.test.ts`、`src/mobile/MobileSessions.test.ts`、`src/preview/localHost.test.ts` 或 `src/preview/simulator.test.ts`；参数改动检查有效与无效输入。单元测试不代替真实 Host 操作，已通过且源码未变的检查直接复用。

完成受影响链路后，再按 [发布收口](../superhigh-github/SKILL.md#发布收口) 冻结交接。交付提供具体预览 URL 和实际验证范围，保留用户继续使用的服务；本机页面调试与正式安装包状态分别说明。
