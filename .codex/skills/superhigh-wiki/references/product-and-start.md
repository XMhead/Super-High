# 产品与入门

核对日期：2026-10-12。基础源码快照：`16c17fa554a5`。
本页经过源码核对；不声称所有桌面功能已完成运行验收。

## 产品定位

Super High 是 Windows 11 桌面工作区。
它把代码编辑、Agent CLI、文件管理和项目工具放进同一个窗口。
技术栈为 Vue 3、Vite、Tauri 2 和 Rust。
本地终端执行真实命令；AI 能力来自用户配置的 Agent CLI。
应用自身不提供免费模型服务或 CLI 登录账户。
公开仓库为 `https://github.com/XMhead/Super-High`。
许可为 MIT；作者为 XMhead。安装包从仓库 Releases 下载。

## 版本口径

核对时 package.json、Cargo.toml 和 tauri.conf.json 均为 `0.1.36`。
CHANGELOG.md 首段 `0.1.37` 包含待发布更新。
当前源码可能已包含待发布行为；现有安装包未必包含这些行为。
发布前重新核对远端 Release 和应用版本。
Alpha、Beta 或正式版阶段沿用当前项目发布约定。

## 首次使用

1. 安装并打开 Super High。
2. 从“文件 → 打开工作区...”选择项目目录。
3. 从资源管理器打开源码文件。
4. 在“设置 → 终端”检查所需 CLI 的安装状态。
5. 点击“新增对话”，选择 CLI 和工作目录。
6. 输入任务，并观察真实终端输出。

```text
项目目录 → 文件与代码 → Agent CLI 会话 → 预览及项目工具
```

CLI 必须先安装并完成自身认证。
新增对话可填写名称、初始提示词和工作目录。
近期项目可从“文件”菜单恢复。
工作区切换同时切换项目文件和项目扩展范围。

## 数据与更新

设置、最近项目及备忘录保存在本机应用数据中。
“设置 → 数据”显示数据目录、数据库和项目目录。
“设置 → 应用”提供更新状态及日志。
运行中的内部终端会话可能延后安装更新。
可选项目能力从当前工作区 `.superhigh` 读取。
缺少项目配置时，相关入口可能隐藏或没有内容。

## 直接来源

| 事实 | 来源 |
| --- | --- |
| 定位和安装 | [README.md](../../../../README.md) |
| 许可 | [LICENSE](../../../../LICENSE) |
| 版本 | [package.json](../../../../package.json)、[Cargo.toml](../../../../src-tauri/Cargo.toml)、[tauri.conf.json](../../../../src-tauri/tauri.conf.json) |
| 待发布变化 | [CHANGELOG.md](../../../../CHANGELOG.md) |
| 工作区和会话 | [AppTopBar.vue](../../../../src/components/AppTopBar.vue)、[NewConversationDialog.vue](../../../../src/components/NewConversationDialog.vue) |
| 数据与更新 | [db.rs](../../../../src-tauri/src/db.rs)、[app_updater.rs](../../../../src-tauri/src/app_updater.rs) |
