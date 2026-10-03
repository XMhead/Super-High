use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::{models::TerminalSessionDto, terminal::TerminalManager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftClientConfig {
    pub project_path: String,
    pub config_path: String,
    pub display_name: String,
    pub client_root: String,
    pub launcher_path: String,
    pub embed_target: String,
    pub window_title_includes: Vec<String>,
    pub process_names: Vec<String>,
    pub startup_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftClientStatus {
    pub state: String,
    pub message: String,
    pub config: Option<MinecraftClientConfig>,
    pub window_title: Option<String>,
    pub process_id: Option<u32>,
    pub embedded: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftClientTerminalStartResult {
    pub status: MinecraftClientStatus,
    pub session: Option<TerminalSessionDto>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftEmbedRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftClientConfigFile {
    #[serde(default)]
    version: u64,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    client_root: String,
    #[serde(default)]
    launcher: String,
    #[serde(default)]
    embed_target: String,
    #[serde(default = "default_window_title_includes")]
    window_title_includes: Vec<String>,
    #[serde(default = "default_process_names")]
    process_names: Vec<String>,
    #[serde(default = "default_startup_timeout_ms")]
    startup_timeout_ms: u64,
}

pub fn load_minecraft_client_config(
    workspace: &Path,
) -> anyhow::Result<Option<MinecraftClientConfig>> {
    let config_path = workspace.join(".superhigh").join("minecraft-client.json");
    if !config_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&config_path)
        .with_context(|| format!("read Minecraft client config {}", config_path.display()))?;
    let config: MinecraftClientConfigFile = serde_json::from_str(&raw)
        .with_context(|| format!("parse Minecraft client config {}", config_path.display()))?;
    if !config.enabled {
        return Ok(None);
    }

    if config.version != 1 {
        bail!(
            "unsupported Minecraft client config version: {}",
            config.version
        );
    }

    if config.embed_target != "final-game-window" {
        bail!("unsupported embedTarget: {}", config.embed_target);
    }

    let client_root = resolve_workspace_path(workspace, &config.client_root);
    if !client_root.is_dir() {
        bail!("Client root does not exist: {}", client_root.display());
    }
    let launcher_path = resolve_workspace_path(&client_root, &config.launcher);
    if !launcher_path.is_file() {
        bail!("Launcher does not exist: {}", launcher_path.display());
    }

    Ok(Some(MinecraftClientConfig {
        project_path: workspace.to_string_lossy().to_string(),
        config_path: config_path.to_string_lossy().to_string(),
        display_name: if config.display_name.trim().is_empty() {
            "Minecraft".to_string()
        } else {
            config.display_name.trim().to_string()
        },
        client_root: client_root.to_string_lossy().to_string(),
        launcher_path: launcher_path.to_string_lossy().to_string(),
        embed_target: config.embed_target,
        window_title_includes: config.window_title_includes,
        process_names: config.process_names,
        startup_timeout_ms: config.startup_timeout_ms.clamp(1_000, 600_000),
    }))
}

pub fn minecraft_client_status(workspace: &Path) -> anyhow::Result<MinecraftClientStatus> {
    let Some(config) = load_minecraft_client_config(workspace)? else {
        return Ok(status(
            "missing-config",
            "Minecraft client config not found",
        ));
    };
    #[cfg(windows)]
    return windows::status(config);
    #[cfg(not(windows))]
    Ok(status_with_config(Some(config), None))
}

// 通过 Super High 受管本地终端启动客户端；GUI 和本地服务桥共用此入口。
pub fn start_minecraft_client_terminal(
    app: &tauri::AppHandle,
    terminal: &TerminalManager,
    workspace_id: Option<String>,
    workspace: &Path,
) -> anyhow::Result<MinecraftClientTerminalStartResult> {
    let mut status = minecraft_client_status(workspace)?;
    if status.state != "ready" {
        return Ok(MinecraftClientTerminalStartResult {
            status,
            session: None,
        });
    }
    let config = status
        .config
        .as_ref()
        .context("Minecraft client config not found")?;
    let title = format!("{} 客户端", config.display_name);
    if terminal
        .find_live_minecraft_client_session(&title, Path::new(&config.client_root))
        .is_some()
    {
        status.message = "Minecraft client is already managed by Super High".to_string();
        return Ok(MinecraftClientTerminalStartResult {
            status,
            session: None,
        });
    }
    let session = terminal.create_script_session_for_workspace(
        app,
        workspace_id,
        "minecraft-client",
        &title,
        Path::new(&config.launcher_path),
        Path::new(&config.client_root),
    )?;
    status.state = "starting".to_string();
    status.message = "已在 Super High 本地终端启动 Minecraft 客户端".to_string();
    Ok(MinecraftClientTerminalStartResult {
        status,
        session: Some(session),
    })
}

// 停止客户端并关闭对应的受管启动器终端。
pub fn stop_minecraft_client_terminal(
    terminal: &TerminalManager,
    workspace: &Path,
) -> anyhow::Result<MinecraftClientStatus> {
    let status = stop_minecraft_client(workspace)?;
    if let Some(config) = &status.config {
        let title = format!("{} 客户端", config.display_name);
        if let Some(session_id) =
            terminal.find_live_minecraft_client_session(&title, Path::new(&config.client_root))
        {
            terminal.close_session(&session_id)?;
        }
    }
    Ok(status)
}

// 停止当前工作区匹配到的 Minecraft 最终游戏窗口。
pub fn stop_minecraft_client(workspace: &Path) -> anyhow::Result<MinecraftClientStatus> {
    let Some(config) = load_minecraft_client_config(workspace)? else {
        return Ok(status(
            "missing-config",
            "Minecraft client config not found",
        ));
    };
    #[cfg(windows)]
    return windows::stop(config);
    #[cfg(not(windows))]
    Ok(status_with_config(
        Some(config),
        Some("Minecraft client stop requested"),
    ))
}

pub fn embed_minecraft_client(
    app: &tauri::AppHandle,
    workspace: &Path,
    rect: MinecraftEmbedRect,
) -> anyhow::Result<MinecraftClientStatus> {
    let Some(config) = load_minecraft_client_config(workspace)? else {
        return Ok(status(
            "missing-config",
            "Minecraft client config not found",
        ));
    };
    validate_embed_rect(rect)?;
    #[cfg(windows)]
    return windows::embed(app, config, rect);
    #[cfg(not(windows))]
    {
        let _ = (app, config, rect);
        bail!("Minecraft client embedding is only available on Windows");
    }
}

pub fn resize_minecraft_client(
    app: &tauri::AppHandle,
    workspace: &Path,
    rect: MinecraftEmbedRect,
) -> anyhow::Result<MinecraftClientStatus> {
    let Some(config) = load_minecraft_client_config(workspace)? else {
        return Ok(status(
            "missing-config",
            "Minecraft client config not found",
        ));
    };
    validate_embed_rect(rect)?;
    #[cfg(windows)]
    return windows::resize(app, config, rect);
    #[cfg(not(windows))]
    {
        let _ = (app, config, rect);
        bail!("Minecraft client resizing is only available on Windows");
    }
}

pub fn hide_minecraft_client() -> anyhow::Result<MinecraftClientStatus> {
    #[cfg(windows)]
    return windows::hide();
    #[cfg(not(windows))]
    Ok(status("ready", "Minecraft game window is not embedded"))
}

pub fn show_minecraft_client(workspace: &Path) -> anyhow::Result<MinecraftClientStatus> {
    let Some(config) = load_minecraft_client_config(workspace)? else {
        return Ok(status(
            "missing-config",
            "Minecraft client config not found",
        ));
    };
    #[cfg(windows)]
    return windows::show(config);
    #[cfg(not(windows))]
    {
        let _ = config;
        bail!("Minecraft client embedding is only available on Windows");
    }
}

pub fn release_minecraft_client(workspace: &Path) -> anyhow::Result<MinecraftClientStatus> {
    let config = load_minecraft_client_config(workspace)?;
    #[cfg(windows)]
    return windows::release(config);
    #[cfg(not(windows))]
    {
        let _ = config;
        bail!("Minecraft client release is only available on Windows");
    }
}

pub fn release_all_minecraft_clients() -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let _ = windows::release(None)?;
    }
    Ok(())
}

pub fn attach_dragoncore_tools_window(app: &tauri::AppHandle) -> anyhow::Result<()> {
    #[cfg(windows)]
    return windows::attach_dragoncore_tools_window(app);
    #[cfg(not(windows))]
    {
        let _ = app;
        bail!("DragonCore tools window is only available on Windows");
    }
}

fn resolve_workspace_path(root: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn default_enabled() -> bool {
    true
}

fn default_window_title_includes() -> Vec<String> {
    vec!["Minecraft".to_string()]
}

fn default_process_names() -> Vec<String> {
    vec!["javaw.exe".to_string(), "java.exe".to_string()]
}

fn default_startup_timeout_ms() -> u64 {
    180_000
}

fn validate_embed_rect(rect: MinecraftEmbedRect) -> anyhow::Result<()> {
    if rect.width <= 0 || rect.height <= 0 {
        bail!(
            "Minecraft embed rectangle must be positive: {}x{} at {},{}",
            rect.width,
            rect.height,
            rect.x,
            rect.y
        );
    }
    Ok(())
}

fn status(state: &str, message: &str) -> MinecraftClientStatus {
    MinecraftClientStatus {
        state: state.to_string(),
        message: message.to_string(),
        config: None,
        window_title: None,
        process_id: None,
        embedded: false,
    }
}

#[cfg(not(windows))]
fn status_with_config(
    config: Option<MinecraftClientConfig>,
    message: Option<&str>,
) -> MinecraftClientStatus {
    let state = if config.is_some() {
        "configured"
    } else {
        "missing-config"
    };
    MinecraftClientStatus {
        state: state.to_string(),
        message: message
            .unwrap_or(if config.is_some() {
                "Minecraft client config loaded"
            } else {
                "Minecraft client config not found"
            })
            .to_string(),
        config,
        window_title: None,
        process_id: None,
        embedded: false,
    }
}

#[cfg(windows)]
mod windows {
    use super::{MinecraftClientConfig, MinecraftClientStatus, MinecraftEmbedRect};
    use anyhow::{anyhow, bail, Result};
    use once_cell::sync::Lazy;
    use std::{
        path::PathBuf,
        sync::Mutex,
        time::{Duration, Instant},
    };
    use tauri::Manager;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM},
        System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
        },
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW,
            GetWindowThreadProcessId, IsWindow, IsWindowVisible, PostMessageW, SetForegroundWindow,
            SetWindowLongPtrW, SetWindowPos, ShowWindow, GWLP_HWNDPARENT, GWL_STYLE,
            HWND_NOTOPMOST, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNORMAL, WM_CLOSE, WS_CAPTION, WS_MAXIMIZEBOX,
            WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
        },
    };

    struct MinecraftWindow {
        hwnd: isize,
        title: String,
        process_id: u32,
    }

    struct EmbeddedMinecraftWindow {
        hwnd: isize,
        original_owner: isize,
        original_style: isize,
        visible: bool,
    }

    struct MinecraftWindowCandidate {
        hwnd: isize,
        first_seen: Instant,
    }

    static EMBEDDED_WINDOW: Lazy<Mutex<Option<EmbeddedMinecraftWindow>>> =
        Lazy::new(|| Mutex::new(None));
    static WINDOW_CANDIDATE: Lazy<Mutex<Option<MinecraftWindowCandidate>>> =
        Lazy::new(|| Mutex::new(None));
    const WINDOW_STABILIZATION_DELAY: Duration = Duration::from_secs(5);
    const PROCESS_SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

    pub fn status(config: MinecraftClientConfig) -> Result<MinecraftClientStatus> {
        if let Some(window) = embedded_window() {
            return Ok(window_status(
                "running",
                "Minecraft game window detected",
                config,
                &window,
                is_embedded_visible(window.hwnd),
            ));
        }
        Ok(match stable_window(&config) {
            Some(window) => window_status(
                "running",
                "Minecraft game window is ready to embed",
                config,
                &window,
                is_embedded(window.hwnd),
            ),
            None if find_window(&config).is_some() => starting_status(config),
            None => ready_status(config),
        })
    }

    // 关闭配置匹配到的 Minecraft 游戏窗口，并等待同一 PID 完全退出。
    pub fn stop(config: MinecraftClientConfig) -> Result<MinecraftClientStatus> {
        let _ = release(Some(config.clone()))?;
        clear_window_candidate();
        let Some(window) = find_window(&config) else {
            return Ok(stopped_status(config));
        };

        let process_handle = open_process_for_stop(window.process_id)?;
        request_window_close(window.hwnd);
        if wait_for_process_to_exit(process_handle, Duration::from_secs(10)) {
            unsafe {
                CloseHandle(process_handle);
            }
            clear_window_candidate();
            return Ok(stopped_status(config));
        }

        let terminate_result = terminate_process(process_handle, window.process_id);
        let exited = terminate_result.is_ok()
            && wait_for_process_to_exit(process_handle, Duration::from_secs(5));
        unsafe {
            CloseHandle(process_handle);
        }
        terminate_result?;
        if exited {
            clear_window_candidate();
            return Ok(stopped_status(config));
        }

        bail!(
            "Minecraft client process {} is still running",
            window.process_id
        )
    }

    pub fn embed(
        app: &tauri::AppHandle,
        config: MinecraftClientConfig,
        rect: MinecraftEmbedRect,
    ) -> Result<MinecraftClientStatus> {
        let Some(window) = embedded_window().or_else(|| stable_window(&config)) else {
            return status(config);
        };
        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| anyhow!("Super High main window is unavailable"))?;
        let parent = main_window
            .hwnd()
            .map_err(|error| anyhow!(error.to_string()))?
            .0 as HWND;
        let overlay_rect = overlay_screen_rect(&main_window, rect)?;
        embed_window(window.hwnd, parent, overlay_rect)?;
        Ok(window_status(
            "embedded",
            "Minecraft game window embedded",
            config,
            &window,
            true,
        ))
    }

    pub fn resize(
        app: &tauri::AppHandle,
        config: MinecraftClientConfig,
        rect: MinecraftEmbedRect,
    ) -> Result<MinecraftClientStatus> {
        let embedded = EMBEDDED_WINDOW
            .lock()
            .map_err(|_| anyhow!("Minecraft embedding state is unavailable"))?;
        let Some(window) = embedded.as_ref() else {
            return Ok(MinecraftClientStatus {
                state: "ready".to_string(),
                message: "Minecraft game window is not embedded".to_string(),
                config: Some(config),
                window_title: None,
                process_id: None,
                embedded: false,
            });
        };
        let main_window = app
            .get_webview_window("main")
            .ok_or_else(|| anyhow!("Super High main window is unavailable"))?;
        let overlay_rect = overlay_screen_rect(&main_window, rect)?;
        set_window_rect(window.hwnd as HWND, overlay_rect, window.visible)?;
        let game_window = window_from_handle(window.hwnd);
        Ok(MinecraftClientStatus {
            state: if window.visible { "embedded" } else { "hidden" }.to_string(),
            message: if window.visible {
                "Minecraft game window resized"
            } else {
                "Minecraft game window resized while hidden"
            }
            .to_string(),
            config: Some(config),
            window_title: game_window.as_ref().map(|value| value.title.clone()),
            process_id: game_window.as_ref().map(|value| value.process_id),
            embedded: window.visible,
        })
    }

    pub fn hide() -> Result<MinecraftClientStatus> {
        let mut embedded = EMBEDDED_WINDOW
            .lock()
            .map_err(|_| anyhow!("Minecraft embedding state is unavailable"))?;
        let Some(window) = embedded.as_mut() else {
            return Ok(MinecraftClientStatus {
                state: "ready".to_string(),
                message: "Minecraft game window is not embedded".to_string(),
                config: None,
                window_title: None,
                process_id: None,
                embedded: false,
            });
        };
        unsafe {
            ShowWindow(window.hwnd as HWND, SW_HIDE);
        }
        window.visible = false;
        let game_window = window_from_handle(window.hwnd);
        Ok(MinecraftClientStatus {
            state: "hidden".to_string(),
            message: "Minecraft game window hidden".to_string(),
            config: None,
            window_title: game_window.as_ref().map(|value| value.title.clone()),
            process_id: game_window.as_ref().map(|value| value.process_id),
            embedded: false,
        })
    }

    pub fn show(config: MinecraftClientConfig) -> Result<MinecraftClientStatus> {
        let mut embedded = EMBEDDED_WINDOW
            .lock()
            .map_err(|_| anyhow!("Minecraft embedding state is unavailable"))?;
        let Some(window) = embedded.as_mut() else {
            return Ok(MinecraftClientStatus {
                state: "ready".to_string(),
                message: "Minecraft game window is not embedded".to_string(),
                config: Some(config),
                window_title: None,
                process_id: None,
                embedded: false,
            });
        };
        unsafe {
            ShowWindow(window.hwnd as HWND, SW_SHOWNORMAL);
        }
        window.visible = true;
        let game_window = window_from_handle(window.hwnd);
        Ok(MinecraftClientStatus {
            state: "embedded".to_string(),
            message: "Minecraft game window restored".to_string(),
            config: Some(config),
            window_title: game_window.as_ref().map(|value| value.title.clone()),
            process_id: game_window.as_ref().map(|value| value.process_id),
            embedded: true,
        })
    }

    pub fn release(config: Option<MinecraftClientConfig>) -> Result<MinecraftClientStatus> {
        let embedded = EMBEDDED_WINDOW
            .lock()
            .map_err(|_| anyhow!("Minecraft embedding state is unavailable"))?
            .take();
        let Some(window) = embedded else {
            return Ok(MinecraftClientStatus {
                state: "ready".to_string(),
                message: "Minecraft game window is not embedded".to_string(),
                config,
                window_title: None,
                process_id: None,
                embedded: false,
            });
        };
        restore_window(&window)?;
        let game_window = window_from_handle(window.hwnd);
        Ok(MinecraftClientStatus {
            state: "released".to_string(),
            message: "Minecraft game window released".to_string(),
            config,
            window_title: game_window.as_ref().map(|value| value.title.clone()),
            process_id: game_window.as_ref().map(|value| value.process_id),
            embedded: false,
        })
    }

    pub fn attach_dragoncore_tools_window(app: &tauri::AppHandle) -> Result<()> {
        let game_window =
            embedded_window().ok_or_else(|| anyhow!("Minecraft game window is not embedded"))?;
        let tools_window = app
            .get_webview_window("dragoncore-tools")
            .ok_or_else(|| anyhow!("DragonCore tools window is unavailable"))?;
        let tools_hwnd = tools_window
            .hwnd()
            .map_err(|error| anyhow!(error.to_string()))?
            .0 as HWND;
        unsafe {
            SetWindowLongPtrW(tools_hwnd, GWLP_HWNDPARENT, game_window.hwnd);
            if GetWindowLongPtrW(tools_hwnd, GWLP_HWNDPARENT) != game_window.hwnd {
                bail!("Failed to make DragonCore tools window owned by Minecraft");
            }
            if SetWindowPos(
                tools_hwnd,
                HWND_TOP,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ) == 0
            {
                bail!("Failed to place DragonCore tools window above Minecraft");
            }
        }
        Ok(())
    }

    fn ready_status(config: MinecraftClientConfig) -> MinecraftClientStatus {
        MinecraftClientStatus {
            state: "ready".to_string(),
            message: "Minecraft client is ready to start".to_string(),
            config: Some(config),
            window_title: None,
            process_id: None,
            embedded: false,
        }
    }

    fn starting_status(config: MinecraftClientConfig) -> MinecraftClientStatus {
        MinecraftClientStatus {
            state: "starting".to_string(),
            message: "Waiting for the Minecraft game window to become ready".to_string(),
            config: Some(config),
            window_title: None,
            process_id: None,
            embedded: false,
        }
    }

    // 返回停止完成后的统一状态，供终端动作提示使用。
    fn stopped_status(config: MinecraftClientConfig) -> MinecraftClientStatus {
        MinecraftClientStatus {
            state: "stopped".to_string(),
            message: "Minecraft client stopped".to_string(),
            config: Some(config),
            window_title: None,
            process_id: None,
            embedded: false,
        }
    }

    fn window_status(
        state: &str,
        message: &str,
        config: MinecraftClientConfig,
        window: &MinecraftWindow,
        embedded: bool,
    ) -> MinecraftClientStatus {
        MinecraftClientStatus {
            state: state.to_string(),
            message: message.to_string(),
            config: Some(config),
            window_title: Some(window.title.clone()),
            process_id: Some(window.process_id),
            embedded,
        }
    }

    fn stable_window(config: &MinecraftClientConfig) -> Option<MinecraftWindow> {
        let window = find_window(config)?;
        if !is_window_responsive(window.hwnd) {
            clear_window_candidate();
            return None;
        }
        let mut candidate = WINDOW_CANDIDATE.lock().ok()?;
        let now = Instant::now();
        match candidate.as_ref() {
            Some(current)
                if current.hwnd == window.hwnd
                    && now.duration_since(current.first_seen) >= WINDOW_STABILIZATION_DELAY =>
            {
                Some(window)
            }
            Some(current) if current.hwnd == window.hwnd => None,
            _ => {
                *candidate = Some(MinecraftWindowCandidate {
                    hwnd: window.hwnd,
                    first_seen: now,
                });
                None
            }
        }
    }

    fn clear_window_candidate() {
        if let Ok(mut candidate) = WINDOW_CANDIDATE.lock() {
            *candidate = None;
        }
    }

    fn is_window_responsive(hwnd: isize) -> bool {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_NULL,
        };

        let mut result = 0;
        unsafe {
            SendMessageTimeoutW(
                hwnd as HWND,
                WM_NULL,
                0,
                0,
                SMTO_ABORTIFHUNG,
                1_000,
                &mut result,
            ) != 0
        }
    }

    fn find_window(config: &MinecraftClientConfig) -> Option<MinecraftWindow> {
        let mut search = WindowSearch {
            title_includes: &config.window_title_includes,
            process_names: &config.process_names,
            found: Vec::new(),
        };
        unsafe {
            EnumWindows(
                Some(enum_windows_callback),
                &mut search as *mut WindowSearch as LPARAM,
            );
        }
        select_best_window(search.found, &config.window_title_includes)
    }

    fn window_from_handle(hwnd: isize) -> Option<MinecraftWindow> {
        let hwnd = hwnd as HWND;
        let title = window_title(hwnd)?;
        let mut process_id = 0;
        unsafe {
            GetWindowThreadProcessId(hwnd, &mut process_id);
        }
        Some(MinecraftWindow {
            hwnd: hwnd as isize,
            title,
            process_id,
        })
    }

    fn embedded_window() -> Option<MinecraftWindow> {
        let hwnd = EMBEDDED_WINDOW
            .lock()
            .ok()
            .and_then(|embedded| embedded.as_ref().map(|window| window.hwnd))?;
        window_from_handle(hwnd)
    }

    fn overlay_screen_rect(
        main_window: &tauri::WebviewWindow,
        rect: MinecraftEmbedRect,
    ) -> Result<MinecraftEmbedRect> {
        let position = main_window
            .outer_position()
            .map_err(|error| anyhow!(error.to_string()))?;
        let scale = main_window
            .scale_factor()
            .map_err(|error| anyhow!(error.to_string()))?;
        Ok(MinecraftEmbedRect {
            x: position.x + (rect.x as f64 * scale).round() as i32,
            y: position.y + (rect.y as f64 * scale).round() as i32,
            width: (rect.width as f64 * scale).round() as i32,
            height: (rect.height as f64 * scale).round() as i32,
        })
    }

    fn embed_window(hwnd: isize, parent: HWND, rect: MinecraftEmbedRect) -> Result<()> {
        let mut embedded = EMBEDDED_WINDOW
            .lock()
            .map_err(|_| anyhow!("Minecraft embedding state is unavailable"))?;
        if let Some(current) = embedded.as_ref() {
            if current.hwnd == hwnd {
                set_window_rect(hwnd as HWND, rect, true)?;
                if let Some(current) = embedded.as_mut() {
                    current.visible = true;
                }
                return Ok(());
            }
            restore_window(current)?;
        }
        let original_style = unsafe { GetWindowLongPtrW(hwnd as HWND, GWL_STYLE) };
        let overlay_style = (original_style as u32
            & !(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU))
            | WS_POPUP
            | WS_VISIBLE;
        let original_owner =
            unsafe { SetWindowLongPtrW(hwnd as HWND, GWLP_HWNDPARENT, parent as isize) };
        let original_owner =
            if original_owner != 0 && unsafe { IsWindow(original_owner as HWND) } == 0 {
                0
            } else {
                original_owner
            };
        unsafe {
            SetWindowLongPtrW(hwnd as HWND, GWL_STYLE, overlay_style as isize);
        }
        set_window_rect(hwnd as HWND, rect, true)?;
        unsafe {
            SetForegroundWindow(hwnd as HWND);
        }
        *embedded = Some(EmbeddedMinecraftWindow {
            hwnd,
            original_owner,
            original_style,
            visible: true,
        });
        Ok(())
    }

    fn restore_window(window: &EmbeddedMinecraftWindow) -> Result<()> {
        unsafe {
            SetWindowLongPtrW(window.hwnd as HWND, GWLP_HWNDPARENT, window.original_owner);
            SetWindowLongPtrW(window.hwnd as HWND, GWL_STYLE, window.original_style);
            ShowWindow(window.hwnd as HWND, SW_SHOWNORMAL);
        }
        set_window_rect(
            window.hwnd as HWND,
            MinecraftEmbedRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 720,
            },
            true,
        )
    }

    fn set_window_rect(hwnd: HWND, rect: MinecraftEmbedRect, visible: bool) -> Result<()> {
        if visible {
            unsafe {
                ShowWindow(hwnd, SW_SHOWNORMAL);
            }
        }
        let result = unsafe {
            SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                rect.x,
                rect.y,
                rect.width.max(1),
                rect.height.max(1),
                window_position_flags(visible),
            )
        };
        if result == 0 {
            return Err(anyhow!("Failed to position Minecraft game window"));
        }
        Ok(())
    }

    fn window_position_flags(visible: bool) -> u32 {
        let flags = SWP_FRAMECHANGED | SWP_NOACTIVATE;
        if visible {
            flags | SWP_SHOWWINDOW
        } else {
            flags
        }
    }

    struct WindowSearch<'a> {
        title_includes: &'a [String],
        process_names: &'a [String],
        found: Vec<MinecraftWindow>,
    }

    unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam as *mut WindowSearch<'_>);
        let Some(title) = window_title(hwnd) else {
            return 1;
        };
        if !search
            .title_includes
            .iter()
            .any(|needle| title.to_lowercase().contains(&needle.to_lowercase()))
        {
            return 1;
        }
        let mut process_id = 0;
        GetWindowThreadProcessId(hwnd, &mut process_id);
        if !process_name_matches(process_id, search.process_names) {
            return 1;
        }
        search.found.push(MinecraftWindow {
            hwnd: hwnd as isize,
            title,
            process_id,
        });
        1
    }

    fn title_match_score(title: &str, title_includes: &[String]) -> Option<(usize, usize)> {
        let title = title.to_lowercase();
        title_includes
            .iter()
            .enumerate()
            .map(|(index, needle)| (index, needle.trim().to_lowercase()))
            .filter(|(_, needle)| !needle.is_empty() && title.contains(needle))
            .map(|(index, needle)| (needle.len(), title_includes.len() - index))
            .max()
    }

    fn select_best_window(
        candidates: Vec<MinecraftWindow>,
        title_includes: &[String],
    ) -> Option<MinecraftWindow> {
        candidates
            .into_iter()
            .filter_map(|window| {
                title_match_score(&window.title, title_includes).map(|score| (score, window))
            })
            .max_by_key(|(score, _)| *score)
            .map(|(_, window)| window)
    }

    fn window_title(hwnd: HWND) -> Option<String> {
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if copied <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..copied as usize]))
    }

    fn process_name_matches(process_id: u32, expected_names: &[String]) -> bool {
        let handle: HANDLE =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
        if handle.is_null() {
            return false;
        }
        let mut buffer = vec![0u16; 32_768];
        let mut length = buffer.len() as u32;
        let result =
            unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut length) };
        unsafe {
            CloseHandle(handle);
        }
        if result == 0 {
            return false;
        }
        let path = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return false;
        };
        expected_names
            .iter()
            .any(|expected| name.eq_ignore_ascii_case(expected))
    }

    // 先向窗口投递关闭消息，给游戏保存和退出的机会。
    fn request_window_close(hwnd: isize) {
        unsafe {
            PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
        }
    }

    fn open_process_for_stop(process_id: u32) -> Result<HANDLE> {
        let handle: HANDLE = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE_ACCESS,
                0,
                process_id,
            )
        };
        if handle.is_null() {
            bail!("打开 Minecraft 客户端进程失败: {process_id}");
        }
        Ok(handle)
    }

    fn wait_for_process_to_exit(handle: HANDLE, timeout: Duration) -> bool {
        let timeout_ms = timeout.as_millis().min(u32::MAX as u128) as u32;
        (unsafe { WaitForSingleObject(handle, timeout_ms) }) == 0
    }

    // 在优雅退出超时后结束同一个 Minecraft 进程。
    fn terminate_process(handle: HANDLE, process_id: u32) -> Result<()> {
        let result = unsafe { TerminateProcess(handle, 0) };
        if result == 0 {
            bail!("结束 Minecraft 客户端进程失败: {process_id}");
        }
        Ok(())
    }

    fn is_embedded(hwnd: isize) -> bool {
        EMBEDDED_WINDOW
            .lock()
            .ok()
            .and_then(|embedded| embedded.as_ref().map(|window| window.hwnd == hwnd))
            .unwrap_or(false)
    }

    fn is_embedded_visible(hwnd: isize) -> bool {
        is_embedded(hwnd) && unsafe { IsWindowVisible(hwnd as HWND) != 0 }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            select_best_window, title_match_score, window_position_flags, MinecraftWindow,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::SWP_SHOWWINDOW;

        fn candidate(hwnd: isize, title: &str, process_id: u32) -> MinecraftWindow {
            MinecraftWindow {
                hwnd,
                title: title.to_string(),
                process_id,
            }
        }

        #[test]
        fn prefers_specific_final_game_title_over_generic_minecraft_title() {
            let selected = select_best_window(
                vec![
                    candidate(1, "Minecraft Launcher", 10),
                    candidate(2, "地平线 v1.1-持续更新中", 20),
                    candidate(3, "Minecraft 1.12.2", 30),
                ],
                &[
                    "地平线 v1.1".to_string(),
                    "Minecraft".to_string(),
                    "我的世界".to_string(),
                ],
            )
            .unwrap();

            assert_eq!(selected.hwnd, 2);
            assert_eq!(selected.process_id, 20);
        }

        #[test]
        fn ignores_empty_title_matchers() {
            assert_eq!(title_match_score("Minecraft", &[" ".to_string()]), None);
        }

        #[test]
        fn hidden_resize_does_not_request_window_display() {
            assert_eq!(window_position_flags(false) & SWP_SHOWWINDOW, 0);
        }

        #[test]
        fn visible_resize_requests_window_display() {
            assert_ne!(window_position_flags(true) & SWP_SHOWWINDOW, 0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::load_minecraft_client_config;
    use std::{fs, path::Path};

    fn write_config(workspace: &Path, content: &str) {
        let config_dir = workspace.join(".superhigh");
        fs::create_dir_all(&config_dir).unwrap();
        fs::write(config_dir.join("minecraft-client.json"), content).unwrap();
    }

    #[test]
    fn missing_config_returns_none() {
        let workspace = tempfile::tempdir().unwrap();

        assert!(load_minecraft_client_config(workspace.path())
            .unwrap()
            .is_none());
    }

    #[test]
    fn disabled_config_returns_none_without_validating_paths() {
        let workspace = tempfile::tempdir().unwrap();
        write_config(workspace.path(), r#"{"enabled":false}"#);

        assert!(load_minecraft_client_config(workspace.path())
            .unwrap()
            .is_none());
    }

    #[test]
    fn resolves_relative_client_root_and_launcher() {
        let workspace = tempfile::tempdir().unwrap();
        let client_root = workspace.path().join("client");
        fs::create_dir_all(&client_root).unwrap();
        let launcher = client_root.join("launcher.exe");
        fs::write(&launcher, "").unwrap();
        write_config(
            workspace.path(),
            r#"{
                "version": 1,
                "enabled": true,
                "displayName": "Test Client",
                "clientRoot": "client",
                "launcher": "launcher.exe",
                "embedTarget": "final-game-window"
            }"#,
        );

        let config = load_minecraft_client_config(workspace.path())
            .unwrap()
            .unwrap();

        assert_eq!(config.project_path, workspace.path().to_string_lossy());
        assert_eq!(config.client_root, client_root.to_string_lossy());
        assert_eq!(config.launcher_path, launcher.to_string_lossy());
    }

    #[test]
    fn applies_optional_field_defaults() {
        let workspace = tempfile::tempdir().unwrap();
        let client_root = workspace.path().join("client");
        fs::create_dir_all(&client_root).unwrap();
        fs::write(client_root.join("launcher.exe"), "").unwrap();
        write_config(
            workspace.path(),
            r#"{
                "version": 1,
                "enabled": true,
                "displayName": "Test Client",
                "clientRoot": "client",
                "launcher": "launcher.exe",
                "embedTarget": "final-game-window"
            }"#,
        );

        let config = load_minecraft_client_config(workspace.path())
            .unwrap()
            .unwrap();

        assert_eq!(config.window_title_includes, ["Minecraft"]);
        assert_eq!(config.process_names, ["javaw.exe", "java.exe"]);
        assert_eq!(config.startup_timeout_ms, 180_000);
    }

    #[test]
    fn rejects_unknown_embed_target() {
        let workspace = tempfile::tempdir().unwrap();
        let client_root = workspace.path().join("client");
        fs::create_dir_all(&client_root).unwrap();
        fs::write(client_root.join("launcher.exe"), "").unwrap();
        write_config(
            workspace.path(),
            r#"{
                "version": 1,
                "enabled": true,
                "displayName": "Test Client",
                "clientRoot": "client",
                "launcher": "launcher.exe",
                "embedTarget": "launcher-window"
            }"#,
        );

        let error = load_minecraft_client_config(workspace.path()).unwrap_err();

        assert!(error.to_string().contains("embedTarget"));
    }

    #[test]
    fn rejects_unknown_config_version() {
        let workspace = tempfile::tempdir().unwrap();
        let client_root = workspace.path().join("client");
        fs::create_dir_all(&client_root).unwrap();
        fs::write(client_root.join("launcher.exe"), "").unwrap();
        write_config(
            workspace.path(),
            r#"{
                "version": 2,
                "enabled": true,
                "displayName": "Test Client",
                "clientRoot": "client",
                "launcher": "launcher.exe",
                "embedTarget": "final-game-window"
            }"#,
        );

        let error = load_minecraft_client_config(workspace.path()).unwrap_err();

        assert!(error.to_string().contains("version"));
    }

    #[test]
    fn rejects_missing_launcher() {
        let workspace = tempfile::tempdir().unwrap();
        let client_root = workspace.path().join("client");
        fs::create_dir_all(&client_root).unwrap();
        write_config(
            workspace.path(),
            r#"{
                "version": 1,
                "enabled": true,
                "displayName": "Test Client",
                "clientRoot": "client",
                "launcher": "missing.exe",
                "embedTarget": "final-game-window"
            }"#,
        );

        let error = load_minecraft_client_config(workspace.path()).unwrap_err();

        assert!(error.to_string().contains("Launcher does not exist"));
    }
}
