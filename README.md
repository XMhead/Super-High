# Super High

Windows 11 桌面工作区，将代码编辑、AI CLI 终端、文件管理和项目工具集中在一个窗口。基于 Vue 3、Vite、Tauri 2 和 Rust。

[下载最新版](https://github.com/XMhead/Super-High/releases/latest) · [功能讲解](https://github.com/XMhead/Super-High/blob/main/FEATURES.md) · [CLI 文档](CLI.md)

## 赞助

感谢 **Aizzz 中转站** 对作者的赞助，欢迎通过作者的邀请链接注册。

<a href="https://api.aizzz.xyz/sign-up?aff=nDR2"><img src="https://api.aizzz.xyz/custom/huiling-newapi-logo.png" alt="Aizzz 中转站" width="48" height="48"></a>

[Aizzz 中转站 · 邀请注册](https://api.aizzz.xyz/sign-up?aff=nDR2)

## 主要功能

- **编辑与预览**：多标签代码编辑、项目搜索、Markdown、YAML、图片和媒体预览。
- **终端与 AI**：内嵌终端、AI CLI 会话、渠道连通性与模型检测。
- **项目工具**：服务启动、脚本工具、本地插件和项目专属 HTML 界面。
- **日常管理**：文件管理、备忘录、文档站点预览，以及局域网手机访问。

## 安装与更新

从 [Releases](https://github.com/XMhead/Super-High/releases/latest) 下载最新的 `*-setup.exe` 并安装。后续可在应用内检查和安装更新；内部终端仍有会话时会延后安装。

## 开发

需要 Windows 11、Node.js 22+、Rust stable 和 Tauri 的 Windows 前置依赖。

```powershell
npm install
npm run tauri:dev
```

仅预览前端使用 `npm run dev`。

设置页交互模拟使用 `npm run superhigh-html`，默认打开 `http://127.0.0.1:1422/superhigh-html.html`；可传 `-- --section mobile --scenario error --theme light --persist 0` 直接进入目标场景。默认使用模拟数据，体验设置保存、手机服务、插件、更新状态和教程重放；模拟动作不操作本机，设置保存在独立浏览器会话中，可重置。`--mode readonly` 切回只读预览，`--no-open` 仅返回链接并复用服务。

入口直接复用应用设置组件与主题样式，保存 Vue/CSS 后自动更新；桌面 store 变更会自动刷新以重新安装模拟适配器。完整参数和扩展规则见 [superhigh-html 技能](.codex/skills/superhigh-html/SKILL.md)。真实文件、进程、联网和安装行为仍在桌面应用验收，模拟通过不能替代实际后端验证。

## Build

构建桌面正式版（自动构建前端和手机页面）：

```powershell
npm run tauri:build -- --no-bundle
```

本机签名安装包使用 `powershell -NoProfile -File scripts/build-update.ps1`。正式版构建和安装后的重启、实际入口验收遵循 [AGENTS.md](AGENTS.md#构建与进程保护)。

正式发布默认在本机从已脱敏并同步的公开工作树构建 Windows 安装包与同版 APK：`node scripts/publish-local-release.mjs --source <公开工作树绝对路径> --tag v<版本>`。上传失败加 `--resume` 复用已校验产物；GitHub 提供下载，云端构建仅作明确请求时的备用。

### 手机界面更新

设置 → 手机端启动 Host，手机浏览器打开显示的 `/mobile/` 地址并输入令牌；新版安卓 App 也从电脑加载同一界面。

修改 `src/mobile/` 后运行 `npm run mobile:build`，刷新手机页面即可更新，无需重启 Host。仓库运行读取根目录 `dist-mobile`，安装版读取 EXE 旁的同名目录，可完整替换该目录更新页面。本机页面调试可沿用现有外壳；每次 GitHub 正式 Release 都从本次公开源码重新构建并附带同版本 APK，手机可直接下载更新。

实时预览使用 `npm run mobile:dev`，电脑打开 `http://localhost:1421/`，手机打开 `http://电脑局域网IP:1421/mobile/`，新版 App 可将 Host 地址设为 `http://电脑局域网IP:1421`；均使用电脑 Host 的令牌。开发代理默认连接本机 `10320` 端口，可在启动前用 `SUPERHIGH_MOBILE_HOST` 指定其他地址，开发服务需保持运行。

## 测试与 CLI

### 脚本扩展进度

`.superhigh` 脚本工具 HTML 可调用 `window.superhighScriptTool.runStreaming(values, onProgress)`。回调参数为 `{ stream: 'stdout' | 'stderr', chunk: string }`，每次提供一行（保留换行），退出时也发送没有换行的尾部文本。两条输出流并行读取，各自保持顺序；不要假定 stdout 与 stderr 之间的顺序。Python 自动使用 UTF-8 和无缓冲输出，其他运行时应主动刷新进度行。

Promise 在进程退出并读取完输出后返回原有 `{ toolId, title, exitCode, stdout, stderr }`。非零退出码仍返回结果，启动或读取失败会 reject。原有 `run(values)` 继续可用。进度回调只更新页面状态；目录等独立操作无需随生成任务禁用。

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run cli -- --help
```

公开版本采用 [MIT 许可](https://github.com/XMhead/Super-High/blob/main/LICENSE)。
