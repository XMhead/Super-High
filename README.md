# Super High

[English](README.en.md) · [功能讲解](FEATURES.md) · [CLI 文档](CLI.md)

Windows 11 桌面工作区，将代码编辑、AI CLI 终端、文件管理和项目工具集中在一个窗口。基于 Vue 3、Vite、Tauri 2 和 Rust。

[![Release](https://img.shields.io/github/v/release/XMhead/Super-High?display_name=release&label=Release)](https://github.com/XMhead/Super-High/releases/latest)

## 下载与更新

从 [Releases](https://github.com/XMhead/Super-High/releases/latest) 下载最新的 `*-setup.exe` 并安装。后续可在应用内检查和安装更新；内部终端仍有会话时会延后安装。

## 赞助

感谢 **Aizzz 中转站** 对作者的赞助，欢迎通过作者的邀请链接注册。

<a href="https://api.aizzz.xyz/sign-up?aff=nDR2"><img src="https://api.aizzz.xyz/custom/huiling-newapi-logo.png" alt="Aizzz 中转站" width="48" height="48"></a>

[Aizzz 中转站 · 邀请注册](https://api.aizzz.xyz/sign-up?aff=nDR2)

## 主要功能

- **编辑与预览**：多标签代码编辑、项目搜索、Markdown、YAML、图片和媒体预览。
- **终端与 AI**：内嵌终端、AI CLI 会话、渠道连通性与模型检测。
- **项目工具**：服务启动、脚本工具、本地插件和项目专属 HTML 界面。
- **日常管理**：文件管理、备忘录、文档站点预览，以及局域网手机访问。

详细用法见 [功能讲解](FEATURES.md)。

## 开发与构建

需要 Windows 11、Node.js 22+、Rust stable 和 Tauri 的 Windows 前置依赖。

```powershell
npm install
npm run tauri:dev
```

仅预览前端使用 `npm run dev`。构建桌面安装包（自动构建前端和手机页面）：

```powershell
npm run tauri:build
```

### 手机界面

设置 → 手机端启动 Host，手机浏览器打开显示的地址并输入令牌；新版安卓 App 也从电脑加载同一界面。

修改 `src/mobile/` 后运行 `npm run mobile:build`，刷新手机页面即可更新。仓库运行读取根目录 `dist-mobile`，安装版读取 EXE 旁的同名目录，可完整替换该目录更新页面。本机页面调试可沿用现有外壳；每次 GitHub 正式 Release 都从本次公开源码重新构建并附带同版本 APK，手机可直接下载更新。

实时预览使用 `npm run mobile:dev`，电脑打开 `http://localhost:1421/`，手机打开 `http://电脑局域网IP:1421/mobile/`，新版 App 可将 Host 地址设为 `http://电脑局域网IP:1421`；均使用电脑 Host 的令牌。开发代理默认连接本机 `10320` 端口，可在启动前用 `SUPERHIGH_MOBILE_HOST` 指定其他地址，开发服务需保持运行。

## 测试与 CLI

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run cli -- --help
```

更多命令见 [CLI 文档](CLI.md)。

## 许可

[MIT](LICENSE)
