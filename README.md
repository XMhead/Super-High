# Super High

Windows 11 桌面工作区，将代码编辑、AI CLI 终端、文件管理和项目工具集中在一个窗口。基于 Vue 3、Vite、Tauri 2 和 Rust。

[下载最新版](https://github.com/XMhead/Super-High/releases/latest) · [功能 Wiki](FEATURES.md) · [CLI 文档](CLI.md) · [Wiki Skill](.codex/skills/superhigh-wiki/SKILL.md)

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

设置页交互模拟使用 `npm run superhigh-html`，默认打开 `http://127.0.0.1:1422/superhigh-html.html`；可传 `-- --section mobile --scenario error --theme opencode-github-light --persist 0` 直接进入目标场景。默认使用模拟数据，体验设置保存、手机服务、插件、更新状态和教程重放；模拟动作不操作本机，设置保存在独立浏览器会话中，可重置。`--mode readonly` 切回只读预览，`--no-open` 仅返回链接并复用服务。

入口直接复用应用设置组件与主题样式，保存 Vue/CSS 后自动更新；桌面 store 变更会自动刷新以重新安装模拟适配器。完整参数和扩展规则见 [superhigh-html 技能](.codex/skills/superhigh-html/SKILL.md)。真实文件、进程、联网和安装行为仍在桌面应用验收，模拟通过不能替代实际后端验证。

## Build

构建桌面正式版（自动构建前端和手机页面）：

```powershell
npm run tauri:build -- --no-bundle
```

本机签名安装包使用 `powershell -NoProfile -File scripts/build-update.ps1`。正式版构建和安装后的重启、实际入口验收遵循 [AGENTS.md](AGENTS.md#应用与会话保护)。

正式发布默认在本机从已脱敏并同步的公开工作树构建 Windows 安装包与同版 APK：`node scripts/publish-local-release.mjs --source <公开工作树绝对路径> --tag v<版本>`。上传失败加 `--resume` 复用已校验产物；GitHub 提供下载，云端构建仅作明确请求时的备用。

### 手机界面更新

设置 → 手机端启动 Host，手机浏览器打开显示的 `/mobile/` 地址并输入令牌；新版安卓 App 也从电脑加载同一界面。

修改 `src/mobile/` 后运行 `npm run mobile:build`，刷新手机页面即可更新，无需重启 Host。仓库运行读取根目录 `dist-mobile`，安装版读取 EXE 旁的同名目录，可完整替换该目录更新页面。本机页面调试可沿用现有外壳；每次 GitHub 正式 Release 都从本次公开源码重新构建并附带同版本 APK，手机可直接下载更新。

实时预览使用 `npm run mobile:dev`，电脑打开 `http://localhost:1421/`，手机打开 `http://电脑局域网IP:1421/mobile/`，新版 App 可将 Host 地址设为 `http://电脑局域网IP:1421`；均使用电脑 Host 的令牌。开发代理默认连接本机 `10320` 端口，可在启动前用 `SUPERHIGH_MOBILE_HOST` 指定其他地址，开发服务需保持运行。

## 工作区与来源分类

SuperHigh 打开的目录就是工作区。SuperHigh 源码目录也遵循相同规则，使用自身的 `.superhigh`。
“项目”在来源分类中指当前精确工作区，不限于 Minecraft 或其他业务项目。

| 来源 | 含义 | 现有入口 |
| --- | --- | --- |
| 系统 | SuperHigh 源码自带，随应用提供 | `/prompt`、Skill 概览编辑器 |
| 全局 | 用户使用 SuperHigh 后自行注册，供各工作区使用 | 用户数据目录中的指令、脚本工具、编辑器和插件 |
| 项目 | 用户在当前工作区自行注册，仅属于该工作区 | 当前工作区 `.superhigh` 中的指令、脚本工具、编辑器和插件 |

分类按提供方式确定，不按功能名称或运行目录确定。系统编辑器在用户数据目录中的落地副本仍属于系统。
编辑器、唤起指令、脚本工具和插件共用这些含义；各入口仅显示实际支持的来源。
Agent CLI 原生命令单列为“Agent CLI”。Skills 沿用提供方的全局和项目目录归属。
当前工作区的 `.superhigh/skills` 属于项目，用户主目录中的 `.superhigh/skills` 属于全局。
源码维护用的项目 Skills 也属于该源码工作区，不因名称包含 SuperHigh 而成为系统功能。
缓存、日志、附件和终端状态是运行产物。空注册表与未登记模板不表示已有扩展。

## 测试与 CLI

SuperHigh 可通过 `superhigh-cli agent sessions/tasks` 或 `superhigh-cli mcp serve` 对外提供 Codex / Claude Code 会话调度：新建或继续会话、提交任务、查询结果、有限等待及请求中断。外部和内部 Agent 共用桌面任务表，按原生回合确认完成。MCP 配置与完整示例见 [CLI 参考](CLI.md#agent-调度与-mcp)。

### 输入框指令

输入 `/` 打开指令菜单。顶部分类栏支持点击，以及左右方向键循环切换；上下方向键选择条目。系统自带 `/prompt` 归入“系统”。全局、项目指令与 Skills 分别筛选。右键预览文件后保留菜单。

仅当前工作区根目录有 `AGENTS.md`、`CLAUDE.md` 或本地 Agent Skill 时，打开项目才自动补建 `.superhigh` 默认注册表、模板及缓存目录；空 Skill 目录、父目录、子项目和全局 Skill 不算。已有配置保持原样，无上述标识的目录仍可读取已有配置，但不自动补建。全局指令从 Tauri `appDataDir()/commands.json` 读取，Windows 默认为 `%APPDATA%/com.superhigh.desktop/commands.json`。两处使用相同格式：

```json
{
  "version": 1,
  "commands": [
    { "id": "review", "name": "review", "description": "检查当前改动", "content": "检查当前改动，指出错误与遗漏。" }
  ]
}
```

`id` 在同一注册表内唯一且保持稳定。`name` 在同一注册表内唯一，不能含空白或 `/`；`prompt` 是系统保留名称。`description` 可省略，`content` 为非空草稿正文，支持 `\n`。选择注册指令只将正文填入输入框，发送仍由用户确认。全局与项目同 ID 指令分别显示。每次输入 `/` 重新读取注册表；无效配置会在菜单显示错误。指令与 Skills 颜色沿用 Codex 标题的稳定 ID 分配规则。

### 脚本扩展进度

脚本工具箱固定提供“全部 / 全局 / 项目”三个来源筛选。来源由注册表位置决定，工具顶层不声明分类字段；参数的 `type` 仍可指定字符串或布尔值。点击卡片即选中并展开扩展界面，路径操作不改变选择。工具箱按工作区保存最后选择，关闭重开与应用重启后恢复。工具消失时选择现有工具，空来源不会清除最后有效脚本。

全局脚本工具登记在 Tauri `appDataDir()/script-tools.json`，Windows 默认是 `%APPDATA%/com.superhigh.desktop/script-tools.json`。沿用项目注册表的 `version: 1`、`directories` 与 `tools` 格式。全局相对路径以 appData 为基准；`directories[].path` 和工具 `script` 也可使用绝对路径，脚本必须位于登记目录中。全局 `ui` 是 `script-tools/<id>/panel.html` 等 appData 内相对路径。用户脚本与 UI 不放入应用源码。

工作区工具与全局工具按 ID 合并，项目同 ID 覆盖全局。两者均以当前工作区为运行目录，并设置 `SUPERHIGH_WORKSPACE` 为工作区绝对路径。工具元数据保留 `sourcePath`、`uiPath`，并提供 `scope`、`registryPath`、`basePath`、`sourceAbsolutePath` 与 `uiAbsolutePath`。全局相对路径以注册表目录为基准，项目相对路径仍以工作区为基准。

CLI 默认使用合并后的工具；`tools list` 和 `tools run` 均支持 `--scope effective|project|global`。例如 `superhigh-cli tools list --scope global --all --json`，或 `superhigh-cli tools run <id> --scope global --project <workspace> --arg key=value --json`。注册表无效会明确报告错误；缺少全局或项目注册表表示该范围没有工具。

`.superhigh` 脚本工具 HTML 可调用 `window.superhighScriptTool.runStreaming(values, onProgress)`。回调参数为 `{ stream: 'stdout' | 'stderr', chunk: string }`，每次提供一行（保留换行），退出时也发送没有换行的尾部文本。两条输出流并行读取，各自保持顺序；不要假定 stdout 与 stderr 之间的顺序。Python 自动使用 UTF-8 和无缓冲输出，其他运行时应主动刷新进度行。

Promise 在进程退出并读取完输出后返回原有 `{ toolId, title, exitCode, stdout, stderr }`。非零退出码仍返回结果，启动或读取失败会 reject。原有 `run(values)` 继续可用。进度回调只更新页面状态；目录等独立操作无需随生成任务禁用。

```powershell
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run cli -- --help
```

公开版本采用 [MIT 许可](https://github.com/XMhead/Super-High/blob/main/LICENSE)。
