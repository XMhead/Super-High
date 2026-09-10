# Super High 协作约束

Super High 是持续发布的 GitHub 项目。纯桌面 UI 修改默认完成本机验收与脱敏源码同步，仅在用户明确要求时发布 Release；其他功能修改、修复和清理仍默认在本机验收后同步源码并发布新版 Release。用户明确限定范围时按其要求执行。开始这些任务以及 GitHub 配置、版本号、CHANGELOG、发布或同步排错前，读取 [superhigh-github](.codex/skills/superhigh-github/SKILL.md)，按其衔接脱敏流程；交付说明本机、GitHub 源码和 Release 的实际状态。

Windows 安装包和 APK 默认在本机从脱敏后的公开源码构建，再上传 GitHub；云端构建仅在用户明确要求时使用。已验收的同版产物可恢复上传，无需因上传或草稿查询失败重新编译。具体入口与验收按上述发布技能执行。

源码脱敏同步默认只过滤、扫描和同步；编译检查按改动与已有验收补缺，完整打包放在 Release 阶段。说明、技能或发布配置调整核对内容和相关脚本后同步源码，不为验收另发版本。

## 执行原则

- 本项目面向 Windows 11 桌面使用，公开通用版发布到 GitHub，本机 private 保留个人功能；固定 Vue 3、Vite、Tauri 2、Rust，不擅自换栈。系统、文件、进程和窗口能力放在 `src-tauri`。
- 用户不会写代码：直接完成实现与验收，说明用中文，减少手工步骤；不扩展多人、多机或产品级安全工程，避免破坏本机和数据。
- 只改任务必需内容，沿用现有风格；不增加推测性功能、抽象或无关重构，只清理本次改动造成的无用代码。
- 已授权、可推断且可逆的细节自主处理；仅询问无法确定且影响结果的取舍，以及未授权的不可逆操作。独立工作继续。
- 多步任务简述目标和验收方式；默认执行一个最相关检查，失败或存在未覆盖风险时再补充。纯指令整理只核对内容。

## 构建与进程保护

- `npm run build` 仅验证前端。正式版构建按 [README 的 Build](README.md#build) 执行；修改 Rust、Tauri 命令、`tauri.conf.json` 或打包配置后，须构建正式版并重启应用，重启前遵守下述会话保护。
- 内部命令行会话须由 `TerminalManager` 创建、仍持有 PTY 子进程且登记在应用终端会话表中；不能仅凭 Windows 父子进程链判断归属。
- 存在内部会话时不关闭、重启应用或打断子进程；先完成无需重启的验证，确需重启须说明受影响会话并取得用户明确同意。
- 未登记的外部命令行进程不阻碍重启，也不得干预；包括带 `SUPERHIGH_EXTERNAL_CONSOLE=1` 的“外部 CMD”。
- 交付应用更新前，核对运行进程的 EXE 路径及用户实际启动入口（快捷方式、文件关联或启动脚本），更新这些入口使用的程序或修正其目标；仅构建仓库 release 不代表安装版已更新。遵守会话保护后从实际入口启动，确认新进程使用本次产物并验收目标交互（可用 `--webview2-automation`）；未重启或未覆盖原问题场景时明确说明，不能宣称已生效或不会复发。
- 手工创建主 WebView 时，导航保护须允许 `about:blank`、`tauri://localhost` 和 `http://tauri.localhost`。

## 物品库与图片

- 扫描、搜索和项目编辑器桥支持 NeigeItems（NI）与 MythicMobs（MM）；按当前项目实际物品目录匹配结果控制来源与物品搜索按钮的 visible。相关改动须覆盖两种来源的验证。
- Rust 返回的 `data:` 图片要求 `src-tauri/tauri.conf.json` 的 CSP 允许 `img-src 'self' data:`。
- ItemIcon 排错链路：物品显示名或键 → `DragonCore/Itemicon` 或 `DragonCore/ItemIcon` 的 `match`/`texture` → 资源包 `DragonCore/icon`、`DragonCore/gui/icon` → Rust `dataUrl` → CSP。
- 品质框由 Lore `品质=§#颜色品质名` 或 NBT `item_quality` 驱动，按 `DragonCore/ItemEffect.yml` 匹配 `DragonCore/gui/beibao/itemtip/pinzhi*.png` 并叠加到图标；禁止按物品名硬匹配。

## 项目编辑器

- `src/components/ProjectEditorPanel.vue` 将 `.superhigh/editor` 的 HTML 挂载进 Shadow DOM。CSS 的 `body` 转为 `:host` 时只匹配独立选择器，保留 `.item-card-body` 等类名。
- 项目脚本通过隔离的 `new Function` 执行；事件使用 `addEventListener`，动态内容在稳定父节点委托，禁止内联事件。
- `superhigh-editor:fs` 的 `list` 返回带点的 `entry.extension`；筛选扩展名须兼容 `.yml` 等形式。
- `superhigh-editor:item-library` 图标按分页或可见卡片加载并限制并发，禁止全库逐项并发请求。
- 修改挂载或样式转换后，用实际 `.superhigh/editor/*.html` 核对含 `body` 的类名，并运行 `npm run build`。

## 子智能体协作

- 跨工作区、大范围检索或长时间任务优先独立命令行智能体；同一目录内的短任务优先内置工具或子智能体。
- 同一处改动只交给一个执行者；子任务写明目标、范围、禁止项、输出和验收，跨项目指定工作目录。主智能体整合结果并处理冲突。

## 渠道检测

- `ChannelProbePanel.vue` 不自建渠道配置：cc-switch 数据库 `~/.cc-switch/cc-switch.db` 只读；dsh 以 `~/.dsh/config.toml` 为唯一编辑源。
- `src-tauri/src/cc_switch.rs` 的供应商解析须对齐 cc-switch：claude 读取 `env.ANTHROPIC_BASE_URL` 等；codex 读取 `config` TOML 的当前 `model_providers`；gemini 读取 `env.GOOGLE_GEMINI_BASE_URL`、`GEMINI_API_KEY`、`GEMINI_MODEL`；grokbuild 读取 `[models] default → [model.<default>]`；opencode 读取 `options.baseURL / apiKey / models`。
- `channel_probe.rs` 按 `apiFormat` 发送最小请求，文本固定 `hi`：anthropic 用 `/v1/messages`，`ANTHROPIC_AUTH_TOKEN` 用 Bearer、`ANTHROPIC_API_KEY` 用 `x-api-key`；openai_responses 用 `/v1/responses`；openai_chat 用 `/v1/chat/completions`；gemini_native 用 `/v1beta/models/{模型}:generateContent` 和 `x-goog-api-key`。
- 请求前用 `strip_model_context_suffix` 剥离模型名的 `[1M]` 等上下文标记。
- `dsh_editor.rs` 将供应商、分组路由、默认模型及 `active_provider/active_model` 写入 `config.toml`；`settings.yaml`、`profiles/*/cordis.patch.yml` 仅作兼容桥，保留无关字段和注释。`.credentials.yaml` 仅在首次迁移读取。
- 获取 dsh 模型列表时使用配置中的 API Key 实时请求，失败回退配置声明的静态列表。
- 后端命令在 `src-tauri/src/lib.rs` 注册，与 `src/lib/tauri.ts` 前端包装一一对应。
- dsh 表单不展示或要求 `apiKeyEnv`；Key 仅来自 `config.toml`。`SUPERHIGH_DSH_KEY_*` 仅注入当前 DSH 子进程，禁止写入 Windows 用户或机器环境变量。
- 修改 `DSH_HOME`、`CC_SWITCH_HOME`、`USERPROFILE` 的 Rust 测试共用 `dsh_profiles::tests::ENV_LOCK` 串行执行。

## DSH 固定边界

- 唯一交互界面为私有 `~/.dsh/profiles/dsh-tui`，包名 `dsh-tui`，固定版本 `0.4.1`；DSH 主程序固定 `0.1.2-rc.1`。
- 未经用户在当前请求中逐项授权，禁止从外部安装、升级、降级、替换或重建上述程序，禁止运行会改写该配置目录的插件更新、依赖安装或初始化流程，也不得引入旧名称或外部同名界面。
- 仅注册 `dsh` 命令、别名、PATH 或命令包装时，只修改独立包装层并原样转发到现场已有的 `dsh --profile dsh-tui`；不得修改包身份、目录联接、配置目录映射及 `cordis.patch.yml`、`settings.yaml`、`config.toml`。
- 版本和映射以任务开始时的真实文件、命令输出为准；不得根据文档或历史记录恢复、迁移或改链。入口注册暴露版本不兼容时，报告具体错误并停止，不扩大为版本或配置修复。

## 收尾

- 清理本次已确认无用的临时产物；大量生成或搬移时使用 `agent-cleaner`，逐项核对精确路径后移入回收站，不永久删除或猜测批量删除。
- 保留当前 `node_modules`、在用正式版、源码、日志、未跟踪交接材料，以及尚未确认无用的模型、原始素材、会话和证据。
- 汇报仅保留结果、必要取舍、验证和限制，不另建报告或清单。
