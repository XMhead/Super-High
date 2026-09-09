# Super High

## 自动更新

首次安装支持更新的版本后，应用会检查 GitHub Releases 新版，并可在应用内下载安装；内部终端会话存在时延后安装。发布者需在 Actions secrets 设置 `TAURI_SIGNING_PRIVATE_KEY`，如私钥有密码再设 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，使用与应用公钥配对的同一签名私钥。

发布时统一更新 `package.json`、`package-lock.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json` 的应用版本，将 `v版本号` 标签指向公开 `main` 的当前提交。工作流核对版本，构建签名安装包并生成 `latest.json`，所有必需产物验证通过后才正式发布。签名私钥须长期备份，不得提交到仓库。

> **English**：[README.en.md](README.en.md) ｜ **功能讲解**：[FEATURES.md](FEATURES.md)

Super High 是一个常驻 Windows 桌面的「一体化工作区」应用：把代码编辑、内嵌终端、项目服务控制、脚本工具、AI CLI 对话、文件管理、文档预览和原生命令行整合进同一个窗口，面向需要同时操作多个项目和工具的开发者。

技术栈：**Vue 3 + Vite + Tauri 2 + Rust**，目标系统 **Windows 11**。

[![Release](https://img.shields.io/github/v/release/XMhead/Super-High?display_name=release&label=Release)](https://github.com/XMhead/Super-High/releases/latest)

## 功能总览

| 功能 | 说明 |
|------|------|
| 代码编辑 | Monaco 多标签编辑器、文件树、项目内搜索、Markdown / YAML / 图片 / 媒体预览 |
| 内嵌终端 | 本地终端、AI CLI 会话（Codex / Claude）、SSH 会话 |
| 项目服务启动 | 按依赖顺序一键启动项目的多个服务，带 TCP 健康检查 |
| JS 插件运行时 | 从全局 / 项目目录加载本机插件，命令注入活动栏 |
| 脚本工具 | 用 JSON 注册项目脚本，按钮化运行，输出可渲染 |
| 文件管理 | 多标签文件管理器，导入 / 粘贴 / 增删改查 |
| 渠道检测 | 检测 AI 渠道连通性与延迟，拉取可用模型列表 |
| 备忘录 | 独立便签窗口，本地数据库存储 |
| 文档预览 | 一键启动 / 停止工作区内的文档站点 |
| 项目编辑器 | 用 HTML 给项目做专属界面（Shadow DOM 隔离） |
| 手机端 | 局域网内手机浏览器访问同一工作区 |
| 原生 CLI | `superhigh-cli`：cards / docs / files / skills / env / remote / search |

每个功能的详细讲解见 **[FEATURES.md](FEATURES.md)**（中文）。

## 下载（Releases）

Windows 安装包以 GitHub Releases 形式发布。到 [Releases 页面](https://github.com/XMhead/Super-High/releases/latest) 下载最新的 `*-setup.exe`，双击即可安装（Windows 11）。

> 安装包由仓库在推送 `v*` 标签时自动构建，见 `.github/workflows/release.yml`。

## 界面组成

- 活动栏：切换工作区 / 编辑器 / 文件管理器 / 文档 / 渠道检测 / 设置等
- 顶部栏：文件与编辑菜单、搜索、终端、脚本工具、插件命令
- 编辑区：多标签代码编辑 + 预览
- 底部终端 / 状态栏

## 环境要求

- Windows 11
- Node.js 22 或更新
- Rust stable
- Tauri 在 Windows 上的前置依赖

## 安装

```powershell
npm install
```

## 开发

```powershell
npm run dev       # 只跑前端
npm run tauri:dev # 以桌面应用方式运行
```

## 手机界面

设置 → 手机端启动 Host，手机浏览器打开显示的手机网页地址并输入令牌；新版安卓 App 连接后也加载电脑上的界面。电脑可点击“预览手机界面”。

修改 `src/mobile/` 后运行 `npm run mobile:build`，刷新手机页面即可更新 UI，无需重装 APK。仓库运行读取根目录 `dist-mobile`，安装版读取 EXE 旁的 `dist-mobile`；安装版可完整替换该目录更新网页，桌面正式构建也会自动打包页面。原生权限、插件或 App 外壳变更仍需安装新版 APK。

开发预览：`npm run mobile:dev`，打开 `http://localhost:1421/index.mobile.html` 并填写电脑 Host 地址和令牌。

## 插件

Super High 从以下位置加载「受信任的本机 JavaScript 插件」：

- 全局：`%APPDATA%\SuperHigh\plugins\`
- 项目：`<工作区>\.superhigh\plugins\`

每个项目可以有自己的插件。打开工作区时自动加载该项目的插件；如果同一个插件 id 在全局和项目里同时存在，以项目为准。

测试方式：

1. 打开 Super High。
2. 打开 设置 > 插件，复制全局 / 项目插件目录。
3. 在目标目录创建插件文件夹，文件夹名必须与 `plugin.json` 里的 `id` 一致。
4. 打开目标工作区并刷新 设置 > 插件。

恢复方式：

- 带 `--disable-plugins` 启动，跳过本次插件加载。
- 在 设置 > 插件 显示的应用数据目录里创建 `disable-plugins.flag`，删除该文件前都会跳过插件。

## 脚本工具

顶部栏的「脚本工具」按钮读取当前工作区的脚本工具。在工作区添加 `.superhigh/script-tools.json`，注册允许的工作区相对目录，并列出要显示为工具的脚本：

```json
{
  "version": 1,
  "directories": [{ "path": "scripts" }],
  "tools": [{
    "version": 1,
    "id": "report",
    "title": "查看报告",
    "script": "scripts/report.py",
    "runtime": "python",
    "kind": "query"
  }]
}
```

每个工具声明真实脚本路径、运行时（`python` / `powershell` / `node` / `cmd`）、输入字段，以及是只读 `query` 还是需要确认的 `maintenance` 工具。脚本必须位于已注册目录内（且不在 `.superhigh` 里）；`.superhigh` 只作为注册表和项目状态存储。

## 项目服务启动

在 `.superhigh/project.json` 里声明启动方式：单脚本模式或服务编排模式。多服务模式支持依赖顺序（`startAfter`）与 TCP 健康检查，启动后每个服务的状态实时显示。

## 终端动作

在 `.superhigh/terminal-actions.json` 里注册动作按钮，一键向项目终端发送命令或重启服务。

## 项目编辑器

在 `.superhigh/editor/` 放 HTML 文件，即可为项目提供专属界面。页面挂载在 Shadow DOM 中、脚本隔离执行，并通过 `superhigh-editor:fs` 等安全接口读取项目文件。

## 构建

```powershell
npm run build
npm run tauri:build
```

## 测试

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## CLI

```powershell
npm run cli -- --help
```

更多 CLI 示例见 [CLI.md](CLI.md)。

## 项目结构

- `src/` - Vue 渲染层源码
- `src-tauri/` - Rust / Tauri 后端与原生 CLI
- `scripts/` - 项目工具脚本

## 协议

MIT
