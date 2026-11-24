# ADB 真机验收

已授权 USB 或已连接无线 ADB 时，在真实手机独立显示运行 SuperHigh；主屏保留用户当前应用。先读全局 `phone-mcp`；连接、页面刷新与 APK 更新入口见 [README 手机界面更新](../../../../README.md#手机界面更新)。ADB 自动配置保留内部认证，无需用户手填地址或密钥；无线 ADB 另需配对，同一 Wi-Fi 不等于已连接 ADB。

先用 PhoneMCP `list_devices` 和 `superhigh-cli mobile status --json` 核对设备与传输类型；旧版桌面可能只列 USB，不能据此判断无线真机不可用。设备列表为空时先运行 `adb mdns services`，尝试 `_adb-tls-connect._tcp` 的已配对连接端口；同一手机可能同时留下旧服务和带 ` (2)` 的新服务，旧端口被拒绝不代表手机不可连。自动连接已启用时，桌面会重新发现无线端口，恢复转发并刷新错误页。ADB 连接不等于手机页面已连接 Host：页面地址为手机回环地址时，检查对应设备的 ADB reverse 映射，再核对实际页面状态。Host 已提供新资源不代表手机已加载；刷新后读取目标界面确认，主屏操作遵守用户授权。

## 操作与取证

`superhigh-cli mobile debug-start --json` 返回本次显示 ID 和 `cdpUrl`；仅对该专属 CDP 操作 WebView。PhoneMCP 普通点击、返回、输入和截图作用于主屏，留给用户明确授权的主屏操作。

- UI 验收：`node .codex/skills/superhigh-html/scripts/check-phone-ui.mjs --cdp <cdpUrl> --smoke`。检查 `app`、`nativeVoice`、`connected`、`visibleErrors` 和 `smoke`，确认设置打开并返回；`viewport` 用于定位真机布局差异，`controls` 用于选择实际控件。局部取证加 `--crop <CSS选择器> --output <PNG>`，保存后再读裁切图。
- 有声播放取证：`python -B .codex/skills/superhigh-html/scripts/check-phone-continuity.py --device <ADB序列号> --duration 90 --require-audio --output <任务目录/evidence.json>`。默认绑定当前主屏应用，指定目标时加 `--package <包名>`；看到 `started` 后执行待测操作。QQ、静音或暂停场景省略 `--require-audio`，只验收主屏保持。
- MCP 取证：`python .codex/skills/superhigh-html/scripts/check-agent-mcp.py --cli <superhigh-cli.exe绝对路径> --mobile`。`adbDeviceCount` 和 `mobileTools` 证明设备及工具发现，实际更新另行验收。

MCP 报告按 `scope` 限定验收范围，`ok` 为真后才接受握手与只读桥接；失败依据 `error` 定位。`protocol`、`toolCount` 用于核对部署协议与工具，`sessionCount`、`taskCount` 证明对应只读桥接能返回。结束核对 `clientExitCode` 为 0 且 `processExited` 为真；未退出时按 `processId` 核对并回收本次探针，保留桌面应用。

系统通知验收使用真实手机通知栏和真实 CLI 会话，检查后台接收、Agent 图标、快捷回复及详情浮层。按改动覆盖 Plan 与异步问题、多题和完整内容，并核对答案进入原会话；feed 已记录只证明 Host 已产生事件。收不到时依次检查通知权限、后台连接、系统通知及 `SuperHighNotice` 日志；主屏操作遵守用户授权。

依据 `package`、`duration`、`sampleCount` 确认采样对象和时间覆盖待测操作。`mainActivities` 定位应用切换或安装拦截；`mainStayedInTarget` 为真且 `errors` 为空，才能接受主屏保持。有声播放还需 `audioInactiveSamples` 为 0 并核对 `audioActiveSamples`。用 `samples` 的相对时间定位中断，输出帧计数仅辅助判断音频输出是否前进。

`audioFocusInspection` 只表示焦点诊断是否可取，并未持续采样焦点。厂商 `dumpsys audio` 异常时保留 unavailable。`limits` 明确采样间隔与音频证据的边界：主屏未切换不证明播放持续，音频持续也不证明视频逐帧连续；实际观看仍由用户确认。

## 更新与退出边界

页面变更用 `mobile reload`，原生壳变更用同签名 APK 的 `mobile update`。已初始化的手机壳通过自身后台安装接口更新；Super High 位于主屏时也允许更新，安装可能结束该页面。首次引导和厂商要求确认另行取得用户授权，系统返回待确认时如实报告。自动更新路径不回退到 `adb install` 或主动弹出安装器。

更新成功须有安装状态或已安装 APK 摘要证据；原生变更还要核对调试进程已重建、CDP 重新就绪及 UI 链路通过。安装成功与新代码运行分别验收。

涉及 WebView 初始化或独立调试进程时，必须覆盖主界面与调试界面同时存活，以及调试先启动后再打开主界面；仅调试 CDP 正常不能代表主界面可用。`SuperHighApplication.attachBaseContext` 在创建 WebView 前为 `:debug` 设置独立数据目录。出现 “This app requires a WebView to work” 时先核对实际 WebView 包与数据目录锁归属，不能直接判为手机缺少 WebView。主界面验收遵守主屏保护，可在任务独立显示临时启动主界面，结束只移除该任务，不停止整个应用包。

结束用 `mobile debug-stop`，核对本次显示、本地 scrcpy 与对应远端 server 均退出；按启动前显示集合保留系统或其它应用的显示。涉及桌面生命周期修改时，额外验证受会话保护的桌面重启也能释放子进程。保留用户持续使用的 ADB 服务和自动连接配置。

## 已证实的实现限制

以下约束已由源码入口承载，维护时原位修正，调用方复用现有命令。

| 现象与根因 | 维护入口与做法 |
| --- | --- |
| scrcpy 的 `--no-window` 会禁用视频，单用它无法创建独立显示 | [mobile_device.rs](../../../../src-tauri/src/mobile_device.rs) 的 `debug_start` 保留 `--record-format=mkv` 与系统空设备录像输出作为视频 sink，并关闭音频、主屏唤醒和系统装饰。 |
| Windows ADB shell 标准输入可能在二进制 `0x1A` 截断 | 同文件 `write_provider` 使用 `adb push` 二进制同步、shell 私有临时目录和 SHA256 校验，再从设备端写入 provider；成功与失败均清理。 |
| 厂商系统可能拒绝访问缓存 UID 的 provider | 同文件 `connect` 区分显式连接与被动同步；显式操作只唤起独立显示，监控同步不重建用户已停止的调试界面。 |
| 应用替换自身时可能丢失安装回调，安装成功也可能仍运行旧进程 | [UsbApkInstaller.java](../../../../android/app/src/main/java/com/superhigh/mobile/UsbApkInstaller.java) 对照安装时间与 APK 摘要恢复状态；桌面还核对已提交安装路径和完整摘要，再重建独立调试进程。等待无错误本身不构成成功。 |
| 桌面被强制结束时，普通析构无法回收 scrcpy 子进程 | `mobile_device.rs` 复用 Windows `ProcessJob` 的 kill-on-close；正常停止另核对远端 server 身份。两条退出路径都需验收。 |
