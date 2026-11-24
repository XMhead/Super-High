//! ADB transport and real-device debug displays. All children belong to the desktop.
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write, path::PathBuf, process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock}, thread, time::{Duration, Instant}};
use tauri::Manager;

const PACKAGE: &str = "com.superhigh.mobile";
const URI: &str = "content://com.superhigh.mobile.usb";
const DEBUG_COMPONENT: &str = "com.superhigh.mobile/.DebugActivity";

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub operation: String,
    pub device_id: Option<String>,
    pub apk_path: Option<String>,
}

struct Display {
    #[cfg(windows)]
    _job: crate::codex_protocol_bridge::ProcessJob,
    child: Child,
    _log: tempfile::NamedTempFile,
    id: u32,
    cdp_port: Option<u16>,
    main_before: String,
    serial: String,
    remote_server: Option<(u32, String)>,
}
impl Drop for Display {
    fn drop(&mut self) {
        crate::process_tree::kill_std_child_tree(&mut self.child);
        let _ = self.child.wait();
        if let Some((pid, scid)) = &self.remote_server {
            // Killing the Windows client is insufficient on some devices. Recheck
            // the exact server identity before terminating our remote process.
            if server_processes(&self.serial).ok().and_then(|p| p.get(pid).cloned()).as_ref() == Some(scid) {
                let _ = adb(Some(&self.serial), &["shell", "kill", "-TERM", &pid.to_string()], None);
            }
        }
    }
}
#[derive(Default)]
struct DeviceState {
    fingerprint: String,
    generation: String,
    ports: Vec<u16>,
    display: Option<Display>,
}
fn devices_state() -> &'static Mutex<BTreeMap<String, DeviceState>> {
    static STATE: OnceLock<Mutex<BTreeMap<String, DeviceState>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
fn command(path: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

fn tool(name: &str) -> Result<PathBuf> {
    if let Some(path) = std::env::var_os(format!("SUPERHIGH_{}", name.to_uppercase())) {
        let path = PathBuf::from(path);
        anyhow::ensure!(path.is_file(), "{name} override does not exist");
        return Ok(path);
    }
    let filename = if cfg!(windows) { format!("{name}.exe") } else { name.into() };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let path = dir.join(&filename);
            if path.is_file() { return Ok(path); }
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        if name == "aapt" {
            if let Ok(entries) = std::fs::read_dir(local.join("Android/Sdk/build-tools")) {
                let mut paths = entries.flatten().map(|e| e.path().join("aapt.exe")).filter(|p| p.is_file()).collect::<Vec<_>>();
                paths.sort();
                if let Some(path) = paths.pop() { return Ok(path); }
            }
        } else if name == "adb" {
            let path = local.join("Android/Sdk/platform-tools/adb.exe");
            if path.is_file() { return Ok(path); }
        } else {
            let root = local.join("SuperHigh/android-tools");
            if let Ok(entries) = std::fs::read_dir(root) {
                let mut paths = entries.flatten().map(|e| e.path().join(&filename)).filter(|p| p.is_file()).collect::<Vec<_>>();
                paths.sort();
                if let Some(path) = paths.pop() { return Ok(path); }
            }
        }
    }
    bail!("{name} 未安装；USB 需要 Android platform-tools，独立显示需要 scrcpy（scripts/setup-mobile-debug.ps1）")
}

// Files avoid pipe-buffer deadlocks; every timeout kills and reaps its exact child tree.
fn run(mut cmd: Command, input: Option<&[u8]>, timeout: Duration) -> Result<String> {
    let output = tempfile::NamedTempFile::new()?;
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(output.as_file().try_clone()?).stderr(output.as_file().try_clone()?);
    let mut child = cmd.spawn().context("无法启动 USB 工具")?;
    let mut writer = input.map(|input| {
        let bytes = input.to_vec();
        let mut stdin = child.stdin.take().unwrap();
        thread::spawn(move || stdin.write_all(&bytes))
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait()? { break status; }
        if Instant::now() >= deadline {
            crate::process_tree::kill_std_child_tree(&mut child);
            let _ = child.wait();
            if let Some(writer) = writer.take() { let _ = writer.join(); }
            bail!("USB 命令超时；请先查询手机状态再重试更新");
        }
        thread::sleep(Duration::from_millis(30));
    };
    let text = std::fs::read_to_string(output.path()).unwrap_or_default();
    // Never include payloads, shell arguments or configuration in errors.
    let written = writer.map(|writer| writer.join());
    anyhow::ensure!(status.success(), "USB 工具失败：{}", text.chars().take(2000).collect::<String>());
    if let Some(written) = written { written.map_err(|_| anyhow::anyhow!("USB 传输线程已退出"))??; }
    Ok(text)
}
fn adb(serial: Option<&str>, args: &[&str], input: Option<&[u8]>) -> Result<String> {
    let mut cmd = command(tool("adb")?);
    if let Some(serial) = serial { cmd.args(["-s", serial]); }
    cmd.args(args);
    run(cmd, input, Duration::from_secs(if args.first() == Some(&"push") { 120 } else { 15 }))
}
fn list() -> Result<Vec<Value>> {
    let text = adb(None, &["devices", "-l"], None)?;
    Ok(parse_devices(&text))
}
fn parse_devices(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 2 || !matches!(parts[1], "device" | "unauthorized" | "offline") { return None; }
        if parts[0].starts_with("emulator-") { return None; }
        let transport = if parts.iter().any(|p| p.starts_with("usb:")) { "usb" } else { "wifi" };
        Some(json!({"deviceId":parts[0], "state":parts[1],
            "model":parts.iter().find_map(|p| p.strip_prefix("model:")).unwrap_or(""), "transport":transport}))
    }).collect()
}
fn wireless_endpoints(text: &str) -> Vec<String> {
    let mut endpoints: Vec<String> = Vec::new();
    for line in text.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        // Service names can include an OEM collision suffix such as " (2)".
        // Only connect services are eligible; pairing still requires the user.
        if !fields.contains(&"_adb-tls-connect._tcp") { continue; }
        let Some(endpoint) = fields.last() else { continue; };
        if endpoint.parse::<std::net::SocketAddr>().is_ok() && !endpoints.iter().any(|e| e == *endpoint) {
            endpoints.push((*endpoint).to_owned());
        }
    }
    endpoints
}
fn reconnect_wireless(devices: Vec<Value>) -> Result<Vec<Value>> {
    if devices.iter().any(|device| device["state"] == "device") { return Ok(devices); }
    // A paired phone may advertise a new TLS port after waking or restarting
    // wireless debugging. ADB does not always reconnect to the new service.
    let Ok(services) = adb(None, &["mdns", "services"], None) else { return Ok(devices); };
    for endpoint in wireless_endpoints(&services) {
        let _ = adb(None, &["connect", &endpoint], None);
        let current = list()?;
        if current.iter().any(|device| device["state"] == "device") { return Ok(current); }
    }
    list()
}
fn selected(devices: &[Value], serial: Option<&str>) -> Result<String> {
    if let Some(serial) = serial {
        anyhow::ensure!(devices.iter().any(|d| d["deviceId"] == serial && d["state"] == "device"), "指定的 ADB 手机未连接或未授权");
        return Ok(serial.into());
    }
    let ready = devices.iter().filter(|d| d["state"] == "device").collect::<Vec<_>>();
    anyhow::ensure!(ready.len() == 1, "需要一台已授权的 ADB 手机；连接多台时指定 deviceId");
    Ok(ready[0]["deviceId"].as_str().unwrap().into())
}
fn provider(serial: &str, method: &str) -> Result<String> {
    let text = adb(Some(serial), &["shell", "content", "call", "--uri", URI, "--method", method], None)?;
    anyhow::ensure!(text.contains("Bundle["), "手机壳不支持 USB 管理，请先通过 mobile update 安装新版 APK");
    Ok(text)
}

fn write_provider(serial: &str, uri: &str, bytes: &[u8]) -> Result<()> {
    // Windows adb shell stdin can stop at binary Ctrl-Z. Use adb's binary sync
    // protocol and a shell-private directory, then verify before dispatch.
    let remote = format!("/data/local/tmp/superhigh-usb-{}", uuid::Uuid::new_v4());
    let payload = format!("{remote}/payload");
    let mut source = tempfile::NamedTempFile::new()?;
    source.write_all(bytes)?;
    source.as_file().sync_all()?;
    adb(Some(serial), &["shell", &format!("umask 077; mkdir {remote}")], None)?;
    let result = (|| -> Result<()> {
        adb(Some(serial), &["push", source.path().to_str().context("USB 临时路径编码无效")?, &payload], None)?;
        adb(Some(serial), &["shell", "chmod", "600", &payload], None)?;
        let hash = adb(Some(serial), &["shell", "sha256sum", &payload], None)?;
        let expected = format!("{:x}", Sha256::digest(bytes));
        anyhow::ensure!(hash.split_whitespace().next() == Some(expected.as_str()), "USB 传输摘要不一致，未提交更新");
        let output = adb(Some(serial), &["shell", &format!("content write --uri '{uri}' < {payload}")], None)?;
        anyhow::ensure!(!output.contains("Error while accessing provider") && !output.contains("Exception:"), "手机拒绝 USB 数据写入");
        Ok(())
    })();
    let cleaned = adb(Some(serial), &["shell", "rm", "-f", "--", &payload], None)
        .and_then(|_| adb(Some(serial), &["shell", "rmdir", "--", &remote], None));
    result?;
    cleaned.context("USB 数据已写入，但手机私有临时文件尚未清理")?;
    Ok(())
}

fn auto_enabled(app: &tauri::AppHandle) -> Result<bool> {
    app.state::<crate::AppState>().db.with_connection(|conn| {
        conn.execute_batch("CREATE TABLE IF NOT EXISTS mobile_usb_state (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL)")?;
        Ok(conn.query_row("SELECT enabled FROM mobile_usb_state WHERE id=1", [], |r| r.get(0)).unwrap_or(false))
    })
}
fn set_auto(app: &tauri::AppHandle, enabled: bool) -> Result<()> {
    auto_enabled(app)?;
    app.state::<crate::AppState>().db.with_connection(|conn| {
        conn.execute("INSERT INTO mobile_usb_state(id,enabled) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled", [enabled])?;
        Ok(())
    })
}
fn connect(app: &tauri::AppHandle, serial: &str, entry: &mut DeviceState, allow_wake: bool) -> Result<()> {
    let state = app.state::<crate::AppState>();
    let config = crate::ensure_mobile_host_config(&state.db)?;
    if !state.mobile_host.status(&config).running {
        state.db.set_mobile_host_enabled(true)?;
        state.mobile_host.start(std::sync::Arc::clone(&state.db), app.clone(), std::sync::Arc::clone(&state.terminal), config.clone())?;
    }
    let host = state.mobile_host.status(&config);
    let mut ports = state.db.list_mobile_host_instances()?.into_iter().map(|h| h.port).collect::<Vec<_>>();
    ports.push(host.port);
    ports.sort_unstable(); ports.dedup();
    let reverse = adb(Some(serial), &["reverse", "--list"], None)?;
    for port in &ports {
        let endpoint = format!("tcp:{port}");
        if !reverse.lines().any(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            fields.len() >= 3 && fields[fields.len()-2] == endpoint && fields[fields.len()-1] == endpoint
        }) {
            adb(Some(serial), &["reverse", "--no-rebind", &endpoint, &endpoint], None)
            .context("ADB 端口已被其他连接占用")?;
            // Restoring transport alone leaves a WebView error page in place.
            // Keep this invalidated until the provider accepts a fresh reload.
            entry.fingerprint.clear();
            if !entry.ports.contains(port) { entry.ports.push(*port); }
        }
    }
    let index = crate::mobile_host::mobile_page_directory().context("手机页面未构建")?.join("index.mobile.html");
    let revision = std::fs::read(index).unwrap_or_default();
    let fingerprint = format!("{:x}", Sha256::digest([host.port.to_string().as_bytes(), config.token.as_bytes(), &revision].concat()));
    // Some OEMs deny shell acquisition of a cached app's provider. Wake only the
    // isolated display, never the launcher activity. Passive reconnect respects debug-stop.
    let phone_status = match provider(serial, "status") {
        Ok(status) => status,
        Err(_) if !allow_wake => return Ok(()),
        Err(_) => { debug_start(serial, entry)?; provider(serial, "status")? }
    };
    anyhow::ensure!(phone_status.contains("protocol=1"), "手机 ADB 管理协议版本不兼容");
    if entry.fingerprint != fingerprint || !phone_status.contains(&entry.generation) {
        let generation = uuid::Uuid::new_v4().to_string();
        let payload = serde_json::to_vec(&json!({"baseUrl":format!("http://127.0.0.1:{}", host.port), "token":config.token,"generation":generation}))?;
        write_provider(serial, &format!("{URI}/connection"), &payload)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if provider(serial, "status")?.contains(&generation) { break; }
            anyhow::ensure!(Instant::now() < deadline, "手机未确认 USB 配置");
            thread::sleep(Duration::from_millis(80));
        }
        entry.fingerprint = fingerprint;
        entry.generation = generation;
    }
    Ok(())
}

fn main_activity(serial: &str) -> Result<String> {
    let dump = adb(Some(serial), &["shell", "dumpsys", "activity", "activities"], None)?;
    // Explicitly parse only display 0; the globally focused display may be our virtual one.
    let mut main = false;
    for line in dump.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Display #") { main = trimmed.starts_with("Display #0 ") || trimmed == "Display #0"; }
        if main && (trimmed.starts_with("mResumedActivity:") || trimmed.starts_with("Resumed:")) {
            return Ok(trimmed.to_string());
        }
    }
    bail!("无法核对主屏前台 Activity，已停止独立显示操作")
}

fn verify_update_display(before: &str, after: &str) -> Result<bool> {
    let unchanged = before == after;
    anyhow::ensure!(before.contains(PACKAGE) || unchanged, "主屏应用已变化，停止手机更新后续操作");
    Ok(unchanged)
}
fn display_id(log: &str) -> Option<u32> {
    log.lines().find_map(|line| {
        if !line.contains("New display:") { return None; }
        line.split("id=").nth(1)?.split(')').next()?.trim().parse().ok().filter(|id| *id > 0)
    })
}

fn server_processes(serial: &str) -> Result<BTreeMap<u32, String>> {
    let text = adb(Some(serial), &["shell", "ps", "-A", "-o", "PID,ARGS"], None)?;
    Ok(text.lines().filter_map(|line| {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 5 || !fields[1].starts_with("app_process")
            || !fields.contains(&"com.genymobile.scrcpy.Server") { return None; }
        let pid = fields[0].parse().ok()?;
        let scid = fields.iter().find_map(|s| s.strip_prefix("scid="))?;
        Some((pid, scid.to_string()))
    }).collect())
}

fn installed_apk(serial: &str) -> Result<String> {
    let output = adb(Some(serial), &["shell", "pm", "path", PACKAGE], None)?;
    let path = output.lines().filter_map(|l| l.trim().strip_prefix("package:"))
        .find(|p| p.ends_with("/base.apk")).context("无法核对手机已安装 APK")?;
    anyhow::ensure!(path.bytes().all(|c| c.is_ascii_alphanumeric() || b"/._~=-".contains(&c)), "手机 APK 路径格式无效");
    Ok(path.into())
}

fn debug_start(serial: &str, entry: &mut DeviceState) -> Result<()> {
    if let Some(display) = entry.display.as_mut() {
        if display.child.try_wait()?.is_none() { return Ok(()); }
    }
    entry.display = None;
    let before = main_activity(serial)?;
    let scrcpy = tool("scrcpy")?;
    let help = run({ let mut cmd = command(&scrcpy); cmd.arg("--help"); cmd }, None, Duration::from_secs(8))?;
    anyhow::ensure!(help.contains("--display-ime-policy"), "scrcpy 版本过旧，请运行 scripts/setup-mobile-debug.ps1");
    let log = tempfile::NamedTempFile::new()?;
    let previous_servers = server_processes(serial)?;
    let mut cmd = command(scrcpy);
    cmd.args(["--serial", serial, "--new-display=1080x1920/420", "--no-window", "--no-audio",
        "--no-power-on", "--no-vd-system-decorations", "--display-ime-policy=local", "--max-fps=5",
        "--record-format=mkv", if cfg!(windows) { "--record=NUL" } else { "--record=/dev/null" }])
        .env("ADB", tool("adb")?).stdin(Stdio::null()).stdout(log.as_file().try_clone()?).stderr(log.as_file().try_clone()?);
    let mut child = cmd.spawn().context("无法创建真机独立显示")?;
    #[cfg(windows)]
    let job = match crate::codex_protocol_bridge::ProcessJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            crate::process_tree::kill_std_child_tree(&mut child);
            let _ = child.wait();
            return Err(error).context("无法托管独立显示进程");
        }
    };
    let mut display = Display { child, _log: log, id: 0, cdp_port: None, main_before: before,
        #[cfg(windows)]
        _job: job,
        serial: serial.into(), remote_server: None };
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let output = std::fs::read_to_string(display._log.path()).unwrap_or_default();
        if let Some(id) = display_id(&output) { display.id = id; break; }
        anyhow::ensure!(display.child.try_wait()?.is_none() && Instant::now() < deadline,
            "手机未创建独立显示：{}", output.chars().take(1500).collect::<String>());
        thread::sleep(Duration::from_millis(100));
    }
    let new_servers = server_processes(serial)?.into_iter().filter(|(pid, _)| !previous_servers.contains_key(pid)).collect::<Vec<_>>();
    if new_servers.len() == 1 { display.remote_server = new_servers.into_iter().next(); }
    let started = adb(Some(serial), &["shell", "am", "start", "--display", &display.id.to_string(), "-n", DEBUG_COMPONENT], None)?;
    anyhow::ensure!(!started.contains("Error") && !started.contains("Exception"), "独立手机界面启动失败：{started}");
    thread::sleep(Duration::from_millis(800));
    anyhow::ensure!(main_activity(serial)? == display.main_before, "主屏 Activity 发生变化，已停止独立显示；未尝试操控主屏");
    entry.display = Some(display);
    Ok(())
}

fn cdp(serial: &str, display: &mut Display) -> Result<Value> {
    let pids = adb(Some(serial), &["shell", "pidof", "com.superhigh.mobile:debug"], None)?;
    let pid = pids.split_whitespace().next().context("独立手机界面未运行")?;
    anyhow::ensure!(pid.bytes().all(|b| b.is_ascii_digit()), "无效的手机进程 ID");
    let socket = format!("localabstract:webview_devtools_remote_{pid}");
    let port = match display.cdp_port {
        Some(port) => port,
        None => {
            let port = adb(Some(serial), &["forward", "tcp:0", &socket], None)?.trim().parse::<u16>()?;
            display.cdp_port = Some(port); port
        }
    };
    Ok(json!({"cdpUrl":format!("http://127.0.0.1:{port}"), "displayId":display.id, "processId":pid,
        "mainDisplayUnchanged": main_activity(serial)? == display.main_before}))
}

fn stop_display(serial: &str, entry: &mut DeviceState) {
    if let Some(mut display) = entry.display.take() {
        if let Some(port) = display.cdp_port.take() {
            let _ = adb(Some(serial), &["forward", "--remove", &format!("tcp:{port}")], None);
        }
        drop(display); // scrcpy destroys the virtual display AND its content; never migrate to display 0.
    }
}

pub(crate) fn execute(app: &tauri::AppHandle, request: Request) -> Result<Value> {
    anyhow::ensure!(matches!(request.operation.as_str(), "status"|"connect"|"disconnect"|"reload"|"update"|"debug-start"|"debug-stop"|"debug-status"), "未知手机操作");
    anyhow::ensure!(request.operation == "update" || request.apk_path.is_none(), "只有 update 接受 apkPath");
    let devices = list()?;
    if request.operation == "status" {
        let mut registry = devices_state().lock().unwrap();
        let debug = registry.iter_mut().filter_map(|(serial, state)| {
            let display = state.display.as_mut()?;
            Some(json!({"deviceId":serial, "displayId":display.id, "running":display.child.try_wait().ok().flatten().is_none(), "desktopPid":display.child.id(), "cdpPort":display.cdp_port}))
        }).collect::<Vec<_>>();
        return Ok(json!({"autoConnect":auto_enabled(app)?, "devices":devices,"debug":debug, "scrcpyAvailable":tool("scrcpy").is_ok()}));
    }
    if request.operation == "disconnect" {
        set_auto(app, false)?;
        let mut registry = devices_state().lock().unwrap();
        for (serial, entry) in registry.iter_mut() {
            stop_display(serial, entry);
            for port in &entry.ports { let _ = adb(Some(serial), &["reverse", "--remove", &format!("tcp:{port}")], None); }
        }
        registry.clear();
        return Ok(json!({"autoConnect":false}));
    }
    let devices = reconnect_wireless(devices)?;
    let serial = selected(&devices, request.device_id.as_deref())?;
    let mut registry = devices_state().lock().unwrap();
    let entry = registry.entry(serial.clone()).or_default();
    match request.operation.as_str() {
        "debug-stop" => { stop_display(&serial, entry); return Ok(json!({"deviceId":serial,"stopped":true})); }
        "update" => {
            let apk = PathBuf::from(request.apk_path.context("update 需要 apkPath，且 APK 必须与已安装版本签名一致")?);
            anyhow::ensure!(apk.is_absolute() && apk.is_file() && apk.extension().is_some_and(|e| e.eq_ignore_ascii_case("apk")), "需要现有 APK 的绝对路径");
            let badging = run({ let mut cmd = command(tool("aapt")?); cmd.args(["dump", "badging"]).arg(&apk); cmd }, None, Duration::from_secs(15))?;
            anyhow::ensure!(badging.lines().any(|line| line.starts_with("package: name='com.superhigh.mobile' ")), "请选择 SuperHigh 手机端 APK");
            let before = main_activity(&serial)?;
            let resume = entry.display.is_some();
            connect(app, &serial, entry, true)?;
            debug_start(&serial, entry)?;
            let updated = (|| -> Result<()> {
                anyhow::ensure!(provider(&serial, "status")?.contains("installProtocol=1"),
                    "手机壳需要一次性初始化新版后台自更新能力；未调用 ADB 安装器或打开主屏");
                let display = entry.display.as_mut().unwrap();
                let id = display.id.to_string();
                if let Some(port) = display.cdp_port.take() {
                    let _ = adb(Some(&serial), &["forward", "--remove", &format!("tcp:{port}")], None);
                }
                anyhow::ensure!(std::fs::metadata(&apk)?.len() <= 256 * 1024 * 1024, "APK 超过 256 MiB");
                let bytes = std::fs::read(&apk)?;
                let expected_hash = format!("{:x}", Sha256::digest(&bytes));
                let previous_apk = installed_apk(&serial)?;
                let generation = uuid::Uuid::new_v4().to_string();
                write_provider(&serial, &format!("{URI}/apk?generation={generation}"), &bytes)?;
                let deadline = Instant::now() + Duration::from_secs(90);
                loop {
                    anyhow::ensure!(display.child.try_wait()?.is_none(), "独立显示已退出，停止后台更新验收");
                    let status = provider(&serial, "install-status").unwrap_or_default();
                    if status.contains(&generation) {
                        if status.contains("installState=installed") { break; }
                        anyhow::ensure!(!status.contains("installState=requires-confirmation"),
                            "系统要求安装确认，后台更新已停止，未主动打开主屏安装器");
                        anyhow::ensure!(!status.contains("installState=failed"), "手机后台安装失败：{status}");
                    }
                    // A self-replacement may invalidate the old PendingIntent.
                    // Prove completion from PackageManager's newly committed code
                    // path and its full APK digest instead of relying on callback delivery.
                    if let Ok(current) = installed_apk(&serial) {
                        if current != previous_apk {
                            let hash = adb(Some(&serial), &["shell", "sha256sum", &current], None)?;
                            anyhow::ensure!(hash.split_whitespace().next() == Some(expected_hash.as_str()), "已安装 APK 摘要不符，停止验收");
                            break;
                        }
                    }
                    anyhow::ensure!(Instant::now() < deadline, "后台安装结果未确认；请先查询状态再重试");
                    // Replacement kills the WebView process. Revive only our dedicated display.
                    let _ = adb(Some(&serial), &["shell", "am", "start", "--display", &id, "-n", DEBUG_COMPONENT], None);
                    thread::sleep(Duration::from_millis(500));
                }
                verify_update_display(&before, &main_activity(&serial)?)?;
                // PackageInstaller may preserve the installer process during a self-update.
                // Reload our app only after proving installation and checking display 0.
                adb(Some(&serial), &["shell", "am", "force-stop", PACKAGE], None)?;
                adb(Some(&serial), &["shell", "am", "start", "--display", &id, "-n", DEBUG_COMPONENT], None)?;
                Ok(())
            })();
            if !resume { stop_display(&serial, entry); }
            updated?;
            entry.fingerprint.clear();
            connect(app, &serial, entry, false)?;
            let unchanged = verify_update_display(&before, &main_activity(&serial)?)?;
            return Ok(json!({"deviceId":serial, "installed":true,"method":"self-update", "runtimeReloaded":true, "debugResumed":resume,"mainDisplayUnchanged":unchanged}));
        }
        "debug-status" => {
            let display = entry.display.as_mut().context("未启动独立显示")?;
            anyhow::ensure!(display.child.try_wait()?.is_none(), "独立显示已退出");
            return cdp(&serial, display);
        }
        _ => {
            connect(app, &serial, entry, true)?;
            set_auto(app, true)?;
            if request.operation == "reload" { provider(&serial, "reload")?; }
            if request.operation == "debug-start" {
                debug_start(&serial, entry)?;
                return cdp(&serial, entry.display.as_mut().unwrap());
            }
        }
    }
    let transport = devices.iter().find(|device| device["deviceId"] == serial).and_then(|device| device["transport"].as_str()).unwrap_or("usb");
    Ok(json!({"deviceId":serial,"connected":true,"autoConnect":true,"transport":transport}))
}

pub(crate) fn call(operation: &str, arguments: Value) -> Result<Value> {
    let mut request = arguments.as_object().cloned().context("手机参数需要对象")?;
    request.insert("operation".into(), Value::String(operation.into()));
    // Validate before IPC, including unknown fields.
    let request: Request = serde_json::from_value(Value::Object(request))?;
    #[cfg(windows)] {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(180), crate::local_control::send_request_async::<_, Value>(
                &json!({"operation":"mobile.control","request": {"operation":request.operation,"deviceId":request.device_id,"apkPath":request.apk_path}})))
                .await.context("手机请求仍可能在运行，请先查询状态")?
        })
    }
    #[cfg(not(windows))] { let _ = request; bail!("手机管理需要运行 Windows 桌面应用"); }
}

pub(crate) fn execute_bridge(app: &tauri::AppHandle, raw: &str) -> Value {
    let result = serde_json::from_str::<Value>(raw).map_err(anyhow::Error::from)
        .and_then(|v| Ok(serde_json::from_value::<Request>(v["request"].clone())?))
        .and_then(|request| execute(app, request));
    match result {
        Ok(value) => json!({"ok":true,"result":value}),
        Err(error) => json!({"ok":false,"error":{"code":"mobile_request_failed","message":error.to_string()}})
    }
}

#[tauri::command]
pub(crate) async fn mobile_device_command(app: tauri::AppHandle, request: Request) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || execute(&app, request)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

pub(crate) fn synchronize(app: &tauri::AppHandle) -> Result<()> {
    if !auto_enabled(app)? { return Ok(()); }
    let devices = reconnect_wireless(list()?)?;
    let Ok(mut registry) = devices_state().try_lock() else { return Ok(()); };
    registry.retain(|id, entry| {
        if devices.iter().any(|d| d["deviceId"] == *id && d["state"] == "device") { return true; }
        stop_display(id, entry); false
    });
    let serial = match selected(&devices, None) {
        Ok(serial) => serial,
        Err(_) if registry.len() == 1 => registry.keys().next().unwrap().clone(),
        Err(_) => return Ok(()),
    };
    connect(app, &serial, registry.entry(serial.clone()).or_default(), false)
}

pub(crate) fn shutdown() {
    if let Ok(mut registry) = devices_state().lock() {
        for (serial, entry) in registry.iter_mut() { stop_display(serial, entry); }
        registry.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wireless_discovery_accepts_changed_ports_and_collision_names_without_pairing() {
        let services = "List of discovered mdns services\n\
            adb-phone _adb-tls-connect._tcp 192.0.2.10:45695\n\
            adb-phone (2) _adb-tls-connect._tcp 192.0.2.10:35293\n\
            duplicate _adb-tls-connect._tcp 192.0.2.10:35293\n\
            ipv6 _adb-tls-connect._tcp [fe80::1]:35293\n\
            pairing _adb-tls-pairing._tcp 192.0.2.10:33333\n\
            legacy _adb._tcp 192.0.2.10:5555\n\
            invalid _adb-tls-connect._tcp not-an-endpoint\n";
        assert_eq!(wireless_endpoints(services), vec!["192.0.2.10:45695", "192.0.2.10:35293", "[fe80::1]:35293"]);
    }
    #[test]
    fn update_permits_foreground_superhigh_replacement_but_preserves_other_apps() {
        let phone = "Resumed: com.superhigh.mobile/.MainActivity";
        let other = "Resumed: com.example.other/.MainActivity";
        assert_eq!(verify_update_display(phone, other).unwrap(), false);
        assert_eq!(verify_update_display(phone, phone).unwrap(), true);
        assert_eq!(verify_update_display(other, other).unwrap(), true);
        assert!(verify_update_display(other, phone).is_err());
    }
    #[test]
    fn selection_supports_usb_and_wireless_but_rejects_unauthorized_and_ambiguous_devices() {
        let devices = parse_devices("List of devices attached\nABC device usb:1-1 model:Phone\n1.2.3.4:5555 device model:Phone\nemulator-5554 device\nLOCKED unauthorized usb:1-2\n");
        assert_eq!(devices.len(), 3);
        assert_eq!(devices[0]["transport"], "usb");
        assert_eq!(devices[1]["transport"], "wifi");
        assert!(selected(&devices, None).is_err());
        assert_eq!(selected(&devices, Some("1.2.3.4:5555")).unwrap(), "1.2.3.4:5555");
        assert_eq!(selected(&devices[..1], None).unwrap(), "ABC");
        assert!(selected(&devices, Some("LOCKED")).is_err());
        let mut multiple = devices.clone(); multiple.push(json!({"deviceId":"SECOND","state":"device"}));
        assert!(selected(&multiple, None).is_err());
    }
    #[test]
    fn only_new_nonzero_virtual_display_is_accepted() {
        assert_eq!(display_id("[server] INFO: New display: 1080x1920/420 (id=7)"), Some(7));
        assert_eq!(display_id("[server] INFO: New display: 1080x1920/420 (id=0)"), None);
        assert_eq!(display_id("Display: 0"), None);
    }
}
