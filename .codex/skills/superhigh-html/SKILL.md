---
name: superhigh-html
description: 开发 Super High 的浏览器热更新预览与可交互模拟；设置场景复用 Vue 设置组件，手机预览连接真实 Host 同步工作区和文件。
---

# SuperHigh HTML

用于边改源码边体验真实界面，沿用 [UI 约束](../super-high-ui-constraints/SKILL.md)。交付范围遵循用户当前要求及根 AGENTS；本技能负责预览与交互验收。

## 入口

需要手机界面、当前桌面工作区或真实资源时，运行 `npm run superhigh-html -- --page mobile --no-open`，复用 `http://127.0.0.1:1421/` 的手机尺寸容器；`/mobile/` 是同源真实 MobileApp。电脑本机预览自动只读获取桌面配置并连接，用无保存凭据的浏览器会话核对首次打开体验。局域网手机及 `SUPERHIGH_MOBILE_HOST` 指定的其他 Host 沿用正常认证；连接信息不进入源码、查询参数或日志。

设置模拟运行 `npm run superhigh-html -- --section mobile --scenario ready --no-open`，入口为 `http://127.0.0.1:1422/superhigh-html.html`。设置的 `section`、`theme`、`scenario`、`mode`、`persist` 可用查询参数切换；完整参数与有效值以 `node scripts/superhigh-html.mjs --help` 和 [options.ts](../../../src/preview/options.ts) 为准。

## 直接来源

| 改动 | 来源 |
| --- | --- |
| 预览启动、路由、本机连接与热更新监听 | [superhigh-html.mjs](../../../scripts/superhigh-html.mjs)、[vite.mobile.config.ts](../../../vite.mobile.config.ts)、[mobile-preview-host.ts](../../../scripts/mobile-preview-host.ts) |
| 手机工作区、文件树、文件查看与偏好 | [MobileApp.vue](../../../src/mobile/MobileApp.vue) |
| 手机终端输入、指令点击、焦点与会话 | [MobileSessions.vue](../../../src/mobile/MobileSessions.vue) |
| 桌面与手机文件图标 | [fileIcons.ts](../../../src/lib/fileIcons.ts)；样式复用全局 `tree-kind-icon` |
| 设置模拟 | [SettingsPreview.vue](../../../src/preview/SettingsPreview.vue) → [SettingsDrawer.vue](../../../src/components/SettingsDrawer.vue)；状态转换在 [simulator.ts](../../../src/preview/simulator.ts) |

## 行为边界

- 手机预览调用真实 Host。当前工作区跟随桌面变化；手机主动选择的工作区保持到桌面路径再次变化。文件夹原地展开/收起，打开文件返回后保留树状态与滚动位置；刷新范围包含已展开目录。
- 手机控件复用真实行为与共享资源。会话标签保持单行标识；文件类型标签大写，Markdown 标签直接切换原文/渲染并保留偏好。终端输出、输入转发、焦点和点击分别有实际行为，菜单出现不代表输入链路已接通。
- 设置模拟明确标记模拟数据，覆盖 store 动作并截断后端调用；新动作先补状态转换及失败反馈。模拟逻辑只在设置预览入口加载，真实桌面能力仍由桌面后端执行。
- 热更新仅监听源码，构建缓存、产物与临时公开树不触发页面重载。桌面进程与会话按根 AGENTS 保护；测试会话记录创建来源和 ID，只清理本轮创建的对象。

## 验收与排错

仅覆盖本轮受影响的完整操作链路，在 390 px、涉及窄屏布局时补 360 px：

- **终端**：从本轮涉及的入口（指令图标、直接点选、操作按钮）进入后，继续输入、Backspace/Delete、Enter 和退出；确认焦点回到终端。快速连续输入保持顺序，切换或关闭视图后迟到输入不会写入其他会话。
- **文件与工作区**：展开/收起目录、保留兄弟节点、打开子文件再返回，核对路径、展开状态及滚动位置；查看器开关双向切换，图标与桌面规则一致。真实 Host 的可空字段按实际返回值处理。
- **设置模拟**：修改后刷新核对保存，按改动检查重置、空状态或失败场景。保存源码后观察已有页面热更新。

浏览器动作串行执行，以 DOM 或终端缓冲中的目标状态判断完成，再继续依赖操作；CLI 返回成功只表示动作已发出。交互无变化时先读目标状态和去重后的首条页面异常，再定向修复，避免连续重复点击或等待。截图只辅助布局判断，关键结果保留路径、状态、行数或焦点等结构化证据。

测试按改动选择现有 `src/mobile/MobileApp.test.ts`、`src/mobile/MobileSessions.test.ts`、`src/preview/localHost.test.ts` 或 `src/preview/simulator.test.ts`；参数改动检查有效与无效输入。单元测试不代替真实 Host 操作，已通过且源码未变的检查直接复用。

完成受影响链路后，再按 [发布收口](../superhigh-github/SKILL.md#发布收口) 冻结交接。交付提供具体预览 URL 和实际验证范围，保留用户继续使用的服务；本机页面调试与正式安装包状态分别说明。
