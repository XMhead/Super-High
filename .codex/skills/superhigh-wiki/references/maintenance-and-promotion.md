# 维护与宣传证据

核对日期：2026-10-12。基础源码快照：`16c17fa554a5`。
本页定义更新 Wiki 和选择宣传证据的完成条件。

## 更新 Wiki

1. 选定用户功能及对应参考页。
2. 检查用户入口、Vue 状态转换和后端实现。
3. 原位更新操作、限制、日期和直接来源。
4. 同步入口变化涉及的 FEATURES.md 索引。
5. 核对链接，并对该 skill 运行 skill-lint。
6. 按项目已有流程同步公开源码。

```text
功能变化 → 用户入口与 loader → 对应 Wiki 页 → 引用核对 → 公开源码
```

新功能进入对应页，不按每次版本复制整套说明。
API 和 schema 保留在现有权威协议位置。
删除能力从用户操作移除；迁移原因仅在仍影响使用时保留。
版本文件、CLI help 和 loader 是权威来源；Wiki 是解释层。
读者能找到入口、完成目标并理解前提，才算说明完成。
源码核对和运行验收分别记录。

## 最小检索

从参考页源码链接读取目标组件。
需要后端时，再读取对应 command 和 Rust 模块。
参数查询用 CLI help；版本变化只读 CHANGELOG 目标段。
应用版本核对 package.json、Cargo.toml、tauri.conf.json。
新增知识前先检查对应 Wiki 页，避免重复广搜。

## 首期可用主张

| 主张 | 证据 | 画面条件 |
| --- | --- | --- |
| 一个窗口聚合代码、CLI、文件和工具 | WorkspaceShell.vue | 展示真实组件 |
| 支持多种 Agent CLI | cliProviders.ts | 展示入口，不承诺全部已安装 |
| 选中代码携带来源进入对话 | EditorPane.vue、selectionChat.ts | 展示选择和草稿 |
| Markdown、YAML、图片及媒体预览 | EditorPane.vue、path.ts | 使用可实际打开的文件 |
| 主题覆盖界面、编辑器和终端 | SettingsDrawer.vue、theme.ts | 展示真实切换 |
| 脚本及 HTML 成为项目工具 | ScriptToolsPanel.vue、SuperhighHtmlPreview.vue | 真实登记工具才演示业务操作 |
| 手机访问电脑工作区 | MobileApp.vue、mobile_host.rs | 真实 Host 连接才称运行联动 |
| MIT 开源 | LICENSE | 展示仓库和许可 |

首期可用“打开项目 → 代码与 CLI → 预览 → 扩展 → 手机 → 开源地址”的叙事。
三分钟选择能形成完整动作的亮点，不必遍历所有设置。
最终画面必须支持对应主张。
按最终画面核对所主张操作的结果；裁切必须保留关键结果，例如 CLI 草稿中的路径和行号。
原始截图显示成功，不代表裁切后的画面仍能证明该结果。

## 浏览器与桌面证据

预览能力边界与排错方法通过 [Wiki 入口](../SKILL.md#维护边界) 的 superhigh-html 路由读取。
模拟画面标注“真实组件演示”或“界面演示”，不据此承诺真实后端运行成功。
源码可以展示；实际连接令牌和账户数据单独处理。

## 直接来源

| 对象 | 来源 |
| --- | --- |
| 用户入口 | [FEATURES.md](../../../../FEATURES.md) |
| 更新和命令 | [CHANGELOG.md](../../../../CHANGELOG.md)、[cli.rs](../../../../src-tauri/src/cli.rs)、[CLI.md](../../../../CLI.md) |
| 许可 | [LICENSE](../../../../LICENSE) |
