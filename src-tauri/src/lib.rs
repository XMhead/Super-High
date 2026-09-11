mod app_updater;
mod balance_pet;
mod cc_switch;
mod channel_probe;
mod cli;
mod cli_conversations;
mod cli_env;
mod cli_files;
mod cli_history;
mod cli_items;
mod cli_service;
mod cli_terminal;
mod cli_tools;
mod db;
mod fs_ops;
mod item_library;
mod image_viewer_registration;
mod local_control;
mod minecraft_client;
mod minecraft_rcon;
mod mobile_host;
mod models;
mod monster_library;
mod pasted_image;
mod plugins;
mod process_tree;
mod project_instructions;
mod project_services;
mod project_startup;
mod project_terminal_actions;
mod script_tools;
mod skills;
mod terminal;
mod vitepress;
mod workflow_memory;
mod workspace_config;
mod workspace_watcher;

use std::{
    collections::HashMap,
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use anyhow::Context;
use db::{app_data_dir, AppDb};
use fs_ops::{
    copy_files_to_clipboard, copy_paths_to_directory, create_directory, create_empty_file,
    delete_path, list_directory, move_paths_to_directory, normalize_path,
    read_image_as_data_url, read_media_as_data_url, read_office_file_base64, read_text_file, rename_path,
    replace_image_from_clipboard, resolve_super_high_root, save_image_data_url,
    search_project_files, validate_video_for_preview,
    write_text_file,
};
use item_library::ItemLibrarySource;
use mobile_host::{MobileHostManager, SharedMobileHostManager};
use models::{
    AppSettings, AppStorageInfo, ChannelConfig, ChannelProbeResult, CliHistorySnapshot,
    CliNativeConversationDetail, CliNativeConversationSummary, CliProviderEnvironment,
    EndpointLatencyResult, FetchedModel, MemoRecord, MobileHostConfig,
    MobileHostStatus, NativeCliTranscript, PluginListResponse, PluginShellExecRequest,
    PluginShellExecResult, PluginWorkspaceContext, ProjectInstructionFileKind,
    ProjectInstructionFiles, ProjectInstructionMigrationResult, ProjectSearchOptions,
    ProjectSearchResult, RecentProject,
    TerminalSessionDto, VitePressDocsInfo, Workspace, WorkspaceWatchTarget,
};
use pasted_image::save_pasted_image_data_url;
use project_startup::{ProjectStartupInfo, ProjectStartupMode};
use tauri::{Emitter, Manager, State};
use terminal::{SharedTerminalManager, TerminalManager};
use uuid::Uuid;
use vitepress::{SharedVitePressManager, VitePressManager};
use workspace_watcher::{SharedWorkspaceWatcherManager, WorkspaceWatcherManager};

struct AppState {
    db: Arc<AppDb>,
    terminal: SharedTerminalManager,
    vitepress: SharedVitePressManager,
    workspace_watcher: SharedWorkspaceWatcherManager,
    mobile_host: SharedMobileHostManager,
}

/// Holds a path passed on the command line (e.g. Windows Explorer "打开方式" / shell `"%1"`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupOpenTarget {
    workspace_path: String,
    file_path: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalPathTarget {
    path: String,
    is_file: bool,
}

struct StartupWorkspaceArg(Mutex<Option<StartupOpenTarget>>);

struct PluginStartupState {
    disabled_by_cli: bool,
}

const WEBVIEW2_AUTOMATION_FLAG: &str = "--webview2-automation";

#[cfg(windows)]
const WEBVIEW2_AUTOMATION_PORT: u16 = 9222;

fn startup_target_from_cli_arg(arg_os: &OsStr) -> Option<StartupOpenTarget> {
    let lossy = arg_os.to_string_lossy();
    if lossy.starts_with('-') {
        return None;
    }

    let trimmed = lossy.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }

    let path = normalize_open_path_input(trimmed);
    if !path.exists() {
        return None;
    }

    let file_path = if path.is_file() {
        Some(normalize_path(&path))
    } else {
        None
    };
    let workspace_path = if path.is_dir() {
        normalize_path(&path)
    } else {
        normalize_path(path.parent()?)
    };
    Some(StartupOpenTarget {
        workspace_path,
        file_path,
    })
}

#[cfg(test)]
fn workspace_folder_from_cli_arg(arg_os: &OsStr) -> Option<String> {
    startup_target_from_cli_arg(arg_os).map(|target| target.workspace_path)
}

#[cfg(test)]
fn first_cli_workspace_folder<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    for arg_os in args {
        if let Some(path) = workspace_folder_from_cli_arg(arg_os.as_ref()) {
            return Some(path);
        }
    }
    None
}

fn parse_cli_startup_target() -> Option<StartupOpenTarget> {
    std::env::args_os()
        .skip(1)
        .find_map(|arg_os| startup_target_from_cli_arg(arg_os.as_ref()))
}

fn is_media_viewer_launch() -> bool {
    std::env::args_os()
        .skip(1)
        .any(|arg| arg == OsStr::new("--media-viewer"))
}

fn has_webview2_automation_arg<I>(args: I) -> bool
where
    I: IntoIterator,
    I::Item: AsRef<OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == OsStr::new(WEBVIEW2_AUTOMATION_FLAG))
}

fn is_webview2_automation_launch() -> bool {
    has_webview2_automation_arg(std::env::args_os().skip(1))
}

#[cfg(windows)]
fn webview2_automation_browser_args() -> String {
    format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
         --remote-debugging-address=127.0.0.1 \
         --remote-debugging-port={WEBVIEW2_AUTOMATION_PORT} \
         --remote-allow-origins=*"
    )
}

#[cfg(windows)]
fn webview2_automation_data_dir(app_handle: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    let path = app_data_dir(app_handle)?.join("webview2-automation");
    fs::create_dir_all(&path).context("failed to create WebView2 automation data directory")?;
    Ok(path)
}

// The main window must never be replaced by an external webpage. Normal link clicks
// are handled in the frontend; this catches redirects and programmatic navigation.
fn is_super_high_main_url(url: &tauri::Url) -> bool {
    // WebView2 performs an about:blank bootstrap navigation before Tauri
    // replaces it with the bundled app URL. Blocking that first navigation
    // leaves the release window permanently black.
    if url.as_str() == "about:blank" {
        return true;
    }

    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
        return true;
    }

    cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"))
        && url.port_or_known_default() == Some(1420)
}

fn guard_main_webview_navigation(url: &tauri::Url) -> bool {
    if is_super_high_main_url(url) {
        return true;
    }

    if is_supported_external_url(url.as_str()) {
        let external_url = url.to_string();
        let _ = std::thread::Builder::new()
            .name("superhigh-external-url".to_string())
            .spawn(move || {
                let _ = system_browser_command(&external_url).spawn();
            });
    }

    false
}

#[cfg(windows)]
fn set_media_viewer_app_user_model_id() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

    let app_id: Vec<u16> = "com.superhigh.desktop.media-viewer\0"
        .encode_utf16()
        .collect();
    // This is intentionally set before Tauri creates the first window so
    // Windows keeps the viewer in its own taskbar group.
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr());
    }
}

#[tauri::command]
fn take_startup_open_target(state: State<'_, StartupWorkspaceArg>) -> Option<StartupOpenTarget> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn get_project_startup_config_command(
    project_path: String,
) -> Result<Option<ProjectStartupInfo>, String> {
    project_startup::load_project_startup_config(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
// 读取当前工作区声明的本地终端动作按钮。
fn get_project_terminal_actions_command(
    project_path: String,
) -> Result<Vec<project_terminal_actions::ProjectTerminalAction>, String> {
    project_terminal_actions::load_project_terminal_actions(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_minecraft_client_config_command(
    project_path: String,
) -> Result<Option<minecraft_client::MinecraftClientConfig>, String> {
    minecraft_client::load_minecraft_client_config(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn minecraft_client_status_command(
    project_path: String,
) -> Result<minecraft_client::MinecraftClientStatus, String> {
    minecraft_client::minecraft_client_status(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn start_minecraft_client_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    project_path: String,
) -> Result<minecraft_client::MinecraftClientTerminalStartResult, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        let workspace = PathBuf::from(project_path);
        minecraft_client::start_minecraft_client_terminal(
            &app,
            &terminal,
            workspace_id,
            &workspace,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
// 停止当前工作区匹配到的 Minecraft 客户端。
async fn stop_minecraft_client_command(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<minecraft_client::MinecraftClientStatus, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        minecraft_client::stop_minecraft_client_terminal(&terminal, &PathBuf::from(project_path))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn embed_minecraft_client_command(
    app: tauri::AppHandle,
    project_path: String,
    rect: minecraft_client::MinecraftEmbedRect,
) -> Result<minecraft_client::MinecraftClientStatus, String> {
    minecraft_client::embed_minecraft_client(&app, &PathBuf::from(project_path), rect)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_minecraft_client_command(
    app: tauri::AppHandle,
    project_path: String,
    rect: minecraft_client::MinecraftEmbedRect,
) -> Result<minecraft_client::MinecraftClientStatus, String> {
    minecraft_client::resize_minecraft_client(&app, &PathBuf::from(project_path), rect)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn hide_minecraft_client_command() -> Result<minecraft_client::MinecraftClientStatus, String> {
    minecraft_client::hide_minecraft_client().map_err(|error| error.to_string())
}

#[tauri::command]
fn show_minecraft_client_command(
    project_path: String,
) -> Result<minecraft_client::MinecraftClientStatus, String> {
    minecraft_client::show_minecraft_client(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn release_minecraft_client_command(
    project_path: String,
) -> Result<minecraft_client::MinecraftClientStatus, String> {
    minecraft_client::release_minecraft_client(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn release_all_minecraft_clients_command() -> Result<(), String> {
    minecraft_client::release_all_minecraft_clients().map_err(|error| error.to_string())
}

#[tauri::command]
fn attach_dragoncore_tools_window_command(app: tauri::AppHandle) -> Result<(), String> {
    minecraft_client::attach_dragoncore_tools_window(&app).map_err(|error| error.to_string())
}

#[tauri::command]
async fn create_project_startup_terminal_session_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    project_path: String,
) -> Result<TerminalSessionDto, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        let workspace = PathBuf::from(project_path);
        let config = project_startup::load_project_startup_config(&workspace)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "project startup config not found".to_string())?;
        if config.mode != ProjectStartupMode::Single {
            return Err("project startup config is a service chain".to_string());
        }
        let script_path = config
            .script_path
            .ok_or_else(|| "project startup script not found".to_string())?;
        let working_directory = config
            .working_directory
            .ok_or_else(|| "project startup working directory not found".to_string())?;
        terminal
            .create_script_session_for_workspace(
                &app,
                workspace_id,
                "project-startup",
                &config.name,
                &PathBuf::from(script_path),
                &PathBuf::from(working_directory),
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn start_project_services_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    project_path: String,
) -> Result<project_services::ProjectServicesStartResult, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        let workspace = PathBuf::from(&project_path);
        let config = project_startup::load_project_startup_config(&workspace)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "project startup config not found".to_string())?;
        project_services::start_project_services(
            &app,
            &terminal,
            workspace_id,
            &workspace,
            config,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<Workspace, String> {
    let selected = if let Some(path) = path {
        PathBuf::from(path)
    } else {
        rfd::FileDialog::new()
            .pick_folder()
            .ok_or_else(|| "No folder selected".to_string())?
    };
    if !selected.is_dir() {
        return Err("Selected folder does not exist".to_string());
    }
    workspace_config::initialize(&selected).map_err(|error| error.to_string())?;
    item_library::ensure_workspace_item_library_config(&selected);
    let root_path = normalize_path(&selected);
    let name = selected
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path.clone());
    let opened_at = chrono_like_now();
    let recent = RecentProject {
        path: root_path.clone(),
        name: name.clone(),
        last_opened_at: opened_at.clone(),
    };
    state
        .db
        .upsert_recent_project(&recent)
        .map_err(|error| error.to_string())?;
    let workspace = Workspace {
        id: Uuid::new_v4().to_string(),
        name: name.clone(),
        display_name: name,
        root_path,
        opened_at,
    };
    let _ = app.emit("workspace-opened", &workspace);
    Ok(workspace)
}

#[tauri::command]
fn select_directory_command(path: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(path) = path {
        let directory = PathBuf::from(path);
        if directory.exists() {
            dialog = dialog.set_directory(directory);
        }
    }
    Ok(dialog.pick_folder().map(|path| normalize_path(&path)))
}

#[tauri::command]
fn select_files_command(path: Option<String>) -> Result<Vec<String>, String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(path) = path {
        let directory = PathBuf::from(path);
        if directory.exists() {
            dialog = dialog.set_directory(directory);
        }
    }
    Ok(dialog
        .pick_files()
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| normalize_path(&path))
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
fn pick_save_file_path_command(path: String) -> Result<Option<String>, String> {
    let source = PathBuf::from(&path);
    let mut dialog = rfd::FileDialog::new();
    if let Some(parent) = source.parent() {
        if parent.exists() {
            dialog = dialog.set_directory(parent);
        }
    }
    if let Some(file_name) = source.file_name() {
        dialog = dialog.set_file_name(file_name.to_string_lossy().into_owned());
    }
    Ok(dialog.save_file().map(|p| normalize_path(&p)))
}

#[tauri::command]
fn pick_png_export_path_command(source_path: String) -> Result<Option<String>, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_absolute() {
        return Err(format!(
            "Path must be absolute: {}",
            normalize_path(&source)
        ));
    }
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let mut dialog = rfd::FileDialog::new()
        .add_filter("PNG image", &["png"])
        .set_file_name(format!("{stem}-edited.png"));
    if let Some(parent) = source.parent() {
        if parent.exists() {
            dialog = dialog.set_directory(parent);
        }
    }
    Ok(dialog
        .save_file()
        .map(|path| normalize_path(&png_export_path(path))))
}

fn png_export_path(mut path: PathBuf) -> PathBuf {
    let is_png = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("png"));
    if !is_png {
        path.set_extension("png");
    }
    path
}

#[tauri::command]
fn list_recent_projects(state: State<'_, AppState>) -> Result<Vec<RecentProject>, String> {
    state
        .db
        .list_recent_projects()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn remove_recent_project_command(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state
        .db
        .remove_recent_project(&path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.db.load_settings().map_err(|error| error.to_string())
}

#[tauri::command]
fn save_app_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    state
        .db
        .save_settings(&settings)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn probe_channel_command(config: ChannelConfig) -> Result<ChannelProbeResult, String> {
    channel_probe::probe_channel(&config)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn probe_website_latency_command(
    config: ChannelConfig,
) -> Result<Vec<EndpointLatencyResult>, String> {
    Ok(channel_probe::probe_website_latency(&config).await)
}

#[tauri::command]
async fn fetch_channel_models_command(config: ChannelConfig) -> Result<Vec<FetchedModel>, String> {
    channel_probe::fetch_channel_models(&config)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn query_codex_balance_command() -> balance_pet::CodexBalanceResult {
    balance_pet::query_codex_balance().await
}

#[tauri::command]
async fn query_codex_official_usage_command() -> balance_pet::CodexOfficialUsageResult {
    balance_pet::query_codex_official_usage().await
}

#[tauri::command]
fn list_cc_providers_command() -> Vec<cc_switch::CcProviderInfo> {
    cc_switch::list_cc_providers()
}

#[tauri::command]
fn list_cc_profiles_command() -> cc_switch::CcProfilesResponse {
    cc_switch::list_cc_profiles()
}

#[tauri::command]
fn list_memos_command(
    state: State<'_, AppState>,
    query: Option<String>,
    created_from: Option<String>,
    created_before: Option<String>,
) -> Result<Vec<MemoRecord>, String> {
    state
        .db
        .list_memos(
            query.as_deref(),
            created_from.as_deref(),
            created_before.as_deref(),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_memo_command(state: State<'_, AppState>) -> Result<MemoRecord, String> {
    state.db.create_memo().map_err(|error| error.to_string())
}

#[tauri::command]
fn update_memo_command(
    state: State<'_, AppState>,
    id: String,
    title: String,
    content: String,
) -> Result<MemoRecord, String> {
    state
        .db
        .update_memo(&id, &title, &content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_memo_command(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_memo(&id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_directory_command(path: String) -> Result<models::DirectoryListing, String> {
    tokio::task::spawn_blocking(move || {
        list_directory(&PathBuf::from(path)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn is_file_command(path: String) -> bool {
    normalize_open_path_input(&path).is_file()
}

#[tauri::command]
fn resolve_terminal_path_command(path: String) -> Option<TerminalPathTarget> {
    let path = normalize_open_path_input(&path);
    path.exists().then(|| TerminalPathTarget {
        path: normalize_path(&path),
        is_file: path.is_file(),
    })
}

#[tauri::command]
async fn read_file_command(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        read_text_file(&PathBuf::from(path)).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_image_as_data_url_command(path: String) -> Result<String, String> {
    read_image_as_data_url(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_office_file_base64_command(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        read_office_file_base64(&PathBuf::from(path)).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| format!("Office 文件读取任务失败：{error}"))?
}

#[tauri::command]
fn read_media_as_data_url_command(path: String) -> Result<String, String> {
    read_media_as_data_url(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn prepare_video_preview_command(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    let normalized_path = validate_video_for_preview(&path).map_err(|error| error.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| error.to_string())?;
    Ok(normalized_path)
}

#[tauri::command]
fn save_image_data_url_command(path: String, data_url: String) -> Result<String, String> {
    save_image_data_url(&PathBuf::from(path), &data_url).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_pasted_image_command(
    project_path: String,
    data_url: String,
    preferred_name: Option<String>,
) -> Result<String, String> {
    save_pasted_image_data_url(
        &PathBuf::from(project_path),
        &data_url,
        preferred_name.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn write_file_command(path: String, content: String) -> Result<(), String> {
    write_text_file(&PathBuf::from(path), &content).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_file_command(path: String) -> Result<(), String> {
    create_empty_file(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn create_directory_command(path: String) -> Result<(), String> {
    create_directory(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_path_command(path: String, new_path: String) -> Result<(), String> {
    rename_path(&PathBuf::from(path), &PathBuf::from(new_path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_path_command(path: String) -> Result<(), String> {
    delete_path(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn copy_paths_to_directory_command(
    paths: Vec<String>,
    target_directory: String,
) -> Result<Vec<models::FileOperationResult>, String> {
    copy_paths_to_directory(&paths, &PathBuf::from(target_directory))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn move_paths_to_directory_command(
    paths: Vec<String>,
    target_directory: String,
) -> Result<Vec<models::FileOperationResult>, String> {
    move_paths_to_directory(&paths, &PathBuf::from(target_directory))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn copy_files_to_clipboard_command(paths: Vec<String>) -> Result<(), String> {
    copy_files_to_clipboard(&paths).map_err(|error| error.to_string())
}

#[tauri::command]
fn replace_image_from_clipboard_command(path: String) -> Result<(), String> {
    replace_image_from_clipboard(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
async fn search_project_files_command(
    query: String,
    roots: Vec<String>,
    options: Option<ProjectSearchOptions>,
) -> Result<ProjectSearchResult, String> {
    tokio::task::spawn_blocking(move || {
        search_project_files(&query, &roots, options.unwrap_or_default())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_project_minecraft_capabilities_command(project_path: String) -> item_library::ProjectMinecraftCapabilities {
    item_library::project_minecraft_capabilities(Path::new(&project_path))
}

#[tauri::command]
async fn search_item_library_command(
    project_path: String,
    source: ItemLibrarySource,
    query: String,
    expanded_query: Option<String>,
    dragon_core_client_root_path: Option<String>,
    page: Option<usize>,
    page_size: Option<usize>,
    force_refresh: Option<bool>,
) -> Result<item_library::ItemLibrarySearchResponse, String> {
    tokio::task::spawn_blocking(move || {
        let dragon_core_client_root = dragon_core_client_root_path.and_then(|path| {
            let trimmed = path.trim();
            (!trimmed.is_empty()).then(|| PathBuf::from(trimmed))
        });
        let project_path = PathBuf::from(project_path);
        item_library::search_item_library_page_with_icons(
            &project_path,
            source,
            &query,
            expanded_query.as_deref(),
            dragon_core_client_root.as_deref(),
            page.unwrap_or(1),
            page_size.unwrap_or(item_library::ITEM_LIBRARY_DEFAULT_PAGE_SIZE),
            force_refresh.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn item_library_keys_command(
    project_path: String,
    source: ItemLibrarySource,
) -> Result<item_library::ItemLibraryKeyResponse, String> {
    tokio::task::spawn_blocking(move || {
        item_library::item_library_keys(Path::new(&project_path), source)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn search_monster_library_command(
    project_path: String,
    query: Option<String>,
    page: Option<usize>,
    page_size: Option<usize>,
) -> Result<monster_library::MonsterLibrarySearchResponse, String> {
    tokio::task::spawn_blocking(move || {
        monster_library::search_monster_library(
            Path::new(&project_path),
            query.as_deref().unwrap_or_default(),
            page.unwrap_or(1),
            page_size.unwrap_or(monster_library::MONSTER_LIBRARY_DEFAULT_PAGE_SIZE),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn send_item_to_player_command(
    project_path: String,
    item_key: String,
    amount: Option<u32>,
) -> Result<minecraft_rcon::MinecraftItemGiveResponse, String> {
    tokio::task::spawn_blocking(move || {
        minecraft_rcon::send_item_to_default_player(
            &PathBuf::from(project_path),
            &item_key,
            amount.unwrap_or(1),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_skills_command(
    project_path: Option<String>,
) -> Result<Vec<skills::SkillCompletionItem>, String> {
    tokio::task::spawn_blocking(move || {
        let project_path = project_path.as_deref().map(Path::new);
        skills::list_skills(project_path)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn send_item_to_named_player_command(
    project_path: String,
    item_key: String,
    player_name: String,
    amount: Option<u32>,
) -> Result<minecraft_rcon::MinecraftItemGiveResponse, String> {
    tokio::task::spawn_blocking(move || {
        minecraft_rcon::send_item_to_named_player(
            &PathBuf::from(project_path),
            &player_name,
            &item_key,
            amount.unwrap_or(1),
        )
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn online_players_command(
    project_path: String,
) -> Result<minecraft_rcon::MinecraftOnlinePlayersResponse, String> {
    tokio::task::spawn_blocking(move || {
        minecraft_rcon::online_players(&PathBuf::from(project_path))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn execute_project_rcon_command(
    project_path: String,
    command: String,
) -> Result<minecraft_rcon::MinecraftRconCommandResponse, String> {
    tokio::task::spawn_blocking(move || {
        minecraft_rcon::execute_project_rcon_command(&PathBuf::from(project_path), &command)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_project_script_tools_command(
    project_path: String,
) -> Result<script_tools::ScriptToolListResponse, String> {
    tokio::task::spawn_blocking(move || {
        script_tools::list_project_script_tools(&PathBuf::from(project_path))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn run_project_script_tool_command(
    project_path: String,
    tool_id: String,
    values: HashMap<String, String>,
) -> Result<script_tools::ScriptToolRunResponse, String> {
    tokio::task::spawn_blocking(move || {
        script_tools::run_project_script_tool(&PathBuf::from(project_path), &tool_id, &values)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_dragoncore_gui_command(
    project_path: String,
    file_path: String,
) -> Result<minecraft_rcon::DragonCoreOpenGuiResponse, String> {
    tokio::task::spawn_blocking(move || {
        minecraft_rcon::open_dragoncore_gui(&PathBuf::from(project_path), &PathBuf::from(file_path))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn sync_workspace_watch_roots_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    root_paths: Vec<String>,
) -> Result<(), String> {
    let workspace_watcher = Arc::clone(&state.workspace_watcher);
    tokio::task::spawn_blocking(move || {
        workspace_watcher
            .sync_roots(&app, root_paths)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn set_active_workspace_command(state: State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    state.mobile_host.set_active_project(path).map_err(|error| error.to_string())
}

#[tauri::command]
async fn sync_workspace_watch_targets_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    targets: Vec<WorkspaceWatchTarget>,
) -> Result<(), String> {
    let workspace_watcher = Arc::clone(&state.workspace_watcher);
    tokio::task::spawn_blocking(move || {
        workspace_watcher
            .sync_targets(&app, targets)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn discover_project_instruction_files_command(
    project_path: String,
) -> Result<ProjectInstructionFiles, String> {
    project_instructions::discover_project_instruction_files(&PathBuf::from(project_path))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn migrate_project_instruction_file_command(
    project_path: String,
    source_kind: ProjectInstructionFileKind,
    target_kind: ProjectInstructionFileKind,
) -> Result<ProjectInstructionMigrationResult, String> {
    project_instructions::migrate_project_instruction_file(
        &PathBuf::from(project_path),
        source_kind,
        target_kind,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn create_terminal_session_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    provider_kind: String,
    cwd: String,
    env: Option<HashMap<String, String>>,
    initial_prompt: Option<String>,
) -> Result<TerminalSessionDto, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        terminal
            .create_session_for_workspace(
                &app,
                workspace_id,
                &provider_kind,
                &PathBuf::from(cwd),
                env.unwrap_or_default(),
                initial_prompt,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn resume_cli_conversation_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    provider_kind: String,
    cwd: String,
    native_session_id: String,
) -> Result<TerminalSessionDto, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        terminal
            .resume_session_for_workspace(
                &app,
                workspace_id,
                &provider_kind,
                &PathBuf::from(cwd),
                &native_session_id,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_external_cli_command(provider_kind: String, cwd: String) -> Result<(), String> {
    terminal::open_external_cli(&provider_kind, &PathBuf::from(cwd))
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_external_cli_session_command(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || terminal.open_external_session(&session_id))
        .await
        .map_err(|error| format!("外部会话移交任务异常结束：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn enhance_prompt_with_codex_command(cwd: String, prompt: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        terminal::enhance_prompt_with_codex(&PathBuf::from(cwd), &prompt)
    })
    .await
    .map_err(|error| format!("Codex 提示词增强任务异常结束：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn detect_cli_environments_command() -> Result<Vec<CliProviderEnvironment>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(terminal::detect_cli_environments())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn ensure_mobile_host_config_command(
    state: State<'_, AppState>,
) -> Result<MobileHostConfig, String> {
    ensure_mobile_host_config(&state.db).map_err(|error| error.to_string())
}

#[tauri::command]
fn mobile_host_status_command(state: State<'_, AppState>) -> Result<MobileHostStatus, String> {
    let config = ensure_mobile_host_config(&state.db).map_err(|error| error.to_string())?;
    Ok(state.mobile_host.status(&config))
}

#[tauri::command]
fn start_mobile_host_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: Option<MobileHostConfig>,
) -> Result<MobileHostStatus, String> {
    let config = match config {
        Some(config) => save_mobile_host_config(&state.db, config),
        None => ensure_mobile_host_config(&state.db),
    }
    .map_err(|error| error.to_string())?;
    let status = state
        .mobile_host
        .start(Arc::clone(&state.db), app, Arc::clone(&state.terminal), config)
        .map_err(|error| error.to_string())?;
    if let Err(error) = state.db.set_mobile_host_enabled(true) {
        state.mobile_host.stop();
        return Err(error.to_string());
    }
    Ok(status)
}

#[tauri::command]
fn stop_mobile_host_command(state: State<'_, AppState>) -> Result<MobileHostStatus, String> {
    state
        .db
        .set_mobile_host_enabled(false)
        .map_err(|error| error.to_string())?;
    state.mobile_host.stop();
    let config = ensure_mobile_host_config(&state.db).map_err(|error| error.to_string())?;
    Ok(state.mobile_host.status(&config))
}

fn ensure_mobile_host_config(db: &AppDb) -> anyhow::Result<MobileHostConfig> {
    let mut settings = db.load_settings()?;
    let config = normalize_mobile_host_config(settings.mobile_host.clone());
    if settings.mobile_host != config {
        settings.mobile_host = config.clone();
        db.save_settings(&settings)?;
    }
    Ok(config)
}

fn save_mobile_host_config(
    db: &AppDb,
    config: MobileHostConfig,
) -> anyhow::Result<MobileHostConfig> {
    let mut settings = db.load_settings()?;
    let config = normalize_mobile_host_config(config);
    settings.mobile_host = config.clone();
    db.save_settings(&settings)?;
    Ok(config)
}

fn normalize_mobile_host_config(mut config: MobileHostConfig) -> MobileHostConfig {
    if config.port == 0 {
        config.port = 10320;
    }
    config.token = config.token.trim().to_string();
    if config.token.is_empty() {
        config.token = generate_mobile_host_token();
    }
    config
}

fn generate_mobile_host_token() -> String {
    Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(12)
        .collect()
}

#[tauri::command]
fn write_terminal_input_command(
    state: State<'_, AppState>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    state
        .terminal
        .write_input(&session_id, &input)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_terminal_session_command(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .terminal
        .resize_session(&session_id, cols, rows)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_terminal_buffer_command(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<models::TerminalBufferSnapshot, String> {
    state
        .terminal
        .terminal_buffer(&session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_native_cli_transcript_command(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<NativeCliTranscript>, String> {
    state
        .terminal
        .native_cli_transcript(&session_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_workspace_cli_conversations_command(
    project_path: String,
) -> Result<Vec<CliNativeConversationSummary>, String> {
    tokio::task::spawn_blocking(move || {
        cli_conversations::list_workspace_conversations(&PathBuf::from(project_path))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_workspace_cli_conversation_command(
    project_path: String,
    source_path: String,
) -> Result<CliNativeConversationDetail, String> {
    cli_conversations::read_workspace_conversation(&PathBuf::from(project_path), &source_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_workspace_prompt_history_command(
    state: State<'_, AppState>, project_path: String,
) -> Result<Vec<models::CliHistoryMessage>, String> {
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        cli_history::list_workspace_prompt_history(&db, &PathBuf::from(project_path)).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_cli_history_command(state: State<'_, AppState>) -> Result<CliHistorySnapshot, String> {
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        cli_history::load_cached(&db).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn refresh_cli_history_command(state: State<'_, AppState>) -> Result<CliHistorySnapshot, String> {
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        cli_history::refresh(&db).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn record_cli_history_message_command(
    state: State<'_, AppState>,
    content: String,
    timestamp: String,
    cwd: Option<String>,
    session_id: String,
) -> Result<(), String> {
    cli_history::record_superhigh_message(
        &state.db,
        &content,
        &timestamp,
        cwd.as_deref(),
        &session_id,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_live_terminal_session_ids_command(state: State<'_, AppState>) -> Vec<String> {
    state.terminal.live_session_ids()
}

#[tauri::command]
async fn close_terminal_session_command(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let terminal = Arc::clone(&state.terminal);
    tauri::async_runtime::spawn_blocking(move || terminal.close_session(&session_id))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn close_terminal_sessions_for_workspace_command(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), String> {
    let terminal = Arc::clone(&state.terminal);
    tauri::async_runtime::spawn_blocking(move || {
        terminal.close_sessions_for_workspace(&workspace_id)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_path_command(path: String) -> Result<(), String> {
    let path = normalize_open_path_input(&path);
    if !path.is_absolute() {
        return Err(format!("Path must be absolute: {}", normalize_path(&path)));
    }
    if !path.exists() {
        return Err(format!("Path does not exist: {}", normalize_path(&path)));
    }
    let mut command = std::process::Command::new("explorer");
    for arg in explorer_args_for_path(&path, path.is_file()) {
        command.arg(arg);
    }

    command
        .spawn()
        .context("failed to open path")
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_file_with_app_command(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    let path = normalize_open_path_input(&path);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let owner_window = window.clone();
    window.run_on_main_thread(move || {
        let result = (|| {
            #[cfg(windows)]
            let owner = owner_window.hwnd()
                .map_err(|error| format!("无法获取打开方式所属窗口：{error}"))?.0 as isize;
            #[cfg(not(windows))]
            let owner = { let _ = owner_window; 0 };
            fs_ops::open_file_with_app(&path, owner).map_err(|error| error.to_string())
        })();
        let _ = sender.send(result);
    }).map_err(|error| format!("无法显示打开方式：{error}"))?;
    receiver.await.map_err(|_| "打开方式窗口已关闭，未收到操作结果".to_string())?
}

#[tauri::command]
fn open_url_command(url: String) -> Result<(), String> {
    let url = normalize_external_url_input(&url)?;
    let mut command = system_browser_command(&url);
    command
        .spawn()
        .context("failed to open URL")
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 校验外部网页链接，后端只把 http/https 交给系统默认浏览器。
fn normalize_external_url_input(url: &str) -> Result<String, String> {
    let trimmed = url.trim();
    if is_supported_external_url(trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err("仅支持打开 http/https 网页链接。".to_string())
    }
}

fn is_supported_external_url(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    (scheme == "http" || scheme == "https")
        && rest.starts_with("//")
        && !url.chars().any(char::is_control)
}

/// 使用当前系统的默认浏览器打开 URL；Windows 是 Super High 的主要运行目标。
#[cfg(windows)]
fn system_browser_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("rundll32.exe");
    command.arg("url.dll,FileProtocolHandler").arg(url);
    command
}

#[cfg(target_os = "macos")]
fn system_browser_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("open");
    command.arg(url);
    command
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn system_browser_command(url: &str) -> std::process::Command {
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url);
    command
}

fn has_disable_plugins_arg<I>(args: I) -> bool
where
    I: IntoIterator,
    I::Item: AsRef<std::ffi::OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == "--disable-plugins")
}

fn parse_disable_plugins_flag() -> bool {
    has_disable_plugins_arg(std::env::args_os().skip(1))
}

#[tauri::command]
fn list_plugins_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    startup: State<'_, PluginStartupState>,
    workspace: Option<PluginWorkspaceContext>,
) -> Result<PluginListResponse, String> {
    let data_dir = app_data_dir(&app).map_err(|error| error.to_string())?;
    let settings = state
        .db
        .load_settings()
        .map_err(|error| error.to_string())?;
    plugins::discover_plugins(
        &data_dir,
        workspace.as_ref(),
        &settings.disabled_plugin_ids,
        startup.disabled_by_cli,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_plugin_asset_command(
    app: tauri::AppHandle,
    plugin_id: String,
    relative_path: String,
    workspace: Option<PluginWorkspaceContext>,
) -> Result<String, String> {
    let data_dir = app_data_dir(&app).map_err(|error| error.to_string())?;
    plugins::read_plugin_asset(&data_dir, workspace.as_ref(), &plugin_id, &relative_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn plugin_shell_exec_command(
    request: PluginShellExecRequest,
) -> Result<PluginShellExecResult, String> {
    tokio::task::spawn_blocking(move || plugins::exec_plugin_shell(request))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_app_storage_info_command(app: tauri::AppHandle) -> Result<AppStorageInfo, String> {
    let data_dir = app_data_dir(&app).map_err(|error| error.to_string())?;
    let database_path = data_dir.join("super-high.db");
    let super_high_root = resolve_super_high_root().map_err(|error| error.to_string())?;
    let global_library_root = super_high_root.join(".superhigh");
    let plugin_environment = plugins::plugin_paths(&data_dir, None);
    let database_size_bytes = std::fs::metadata(&database_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    Ok(AppStorageInfo {
        data_dir: normalize_path(&data_dir),
        database_path: normalize_path(&database_path),
        database_size_bytes,
        super_high_root: normalize_path(&super_high_root),
        global_library_root: normalize_path(&global_library_root),
        global_plugins_dir: plugin_environment.plugin_root,
        plugin_log_path: plugin_environment.log_path,
        plugin_disable_flag_path: plugin_environment.disable_flag_path,
    })
}

#[tauri::command]
async fn detect_vitepress_docs_command(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<VitePressDocsInfo, String> {
    let vitepress = Arc::clone(&state.vitepress);
    tokio::task::spawn_blocking(move || {
        vitepress
            .detect(&PathBuf::from(project_path))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn ensure_vitepress_docs_command(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<VitePressDocsInfo, String> {
    let vitepress = Arc::clone(&state.vitepress);
    tokio::task::spawn_blocking(move || {
        vitepress
            .ensure(&PathBuf::from(project_path))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn stop_vitepress_docs_command(
    state: State<'_, AppState>,
    project_path: String,
) -> Result<VitePressDocsInfo, String> {
    let vitepress = Arc::clone(&state.vitepress);
    tokio::task::spawn_blocking(move || {
        vitepress
            .stop(&PathBuf::from(project_path))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_system_voice_input_command() -> Result<(), String> {
    open_system_voice_input().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_system_voice_input_command() -> Result<(), String> {
    close_system_voice_input().map_err(|error| error.to_string())
}

#[tauri::command]
async fn shutdown_app_command(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let terminal = Arc::clone(&state.terminal);
    let vitepress = Arc::clone(&state.vitepress);
    state.mobile_host.stop();
    // Release embedded windows before closing their PTYs; neither operation may
    // block the WebView event loop. The docs server can stop independently.
    let (sessions_result, vitepress_result) = tokio::join!(
        tokio::task::spawn_blocking(move || {
            let minecraft_result = minecraft_client::release_all_minecraft_clients();
            let terminal_result = terminal.close_all_sessions();
            minecraft_result.and(terminal_result)
        }),
        tokio::task::spawn_blocking(move || vitepress.stop_all()),
    );
    for result in [sessions_result, vitepress_result] {
        result
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    }

    app.exit(0);
    Ok(())
}

#[cfg(windows)]
fn open_system_voice_input() -> anyhow::Result<()> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, VK_H, VK_LWIN};

    let input_size = std::mem::size_of::<INPUT>() as i32;
    let mut inputs = [
        keyboard_input(VK_LWIN, false),
        keyboard_input(VK_H, false),
        keyboard_input(VK_H, true),
        keyboard_input(VK_LWIN, true),
    ];
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_mut_ptr(), input_size) };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "Windows voice input shortcut could not be sent"
        ))
    }
}

#[cfg(windows)]
fn close_system_voice_input() -> anyhow::Result<()> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, VK_ESCAPE};

    let input_size = std::mem::size_of::<INPUT>() as i32;
    let mut inputs = [
        keyboard_input(VK_ESCAPE, false),
        keyboard_input(VK_ESCAPE, true),
    ];
    let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_mut_ptr(), input_size) };
    if sent == inputs.len() as u32 {
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "Windows voice input stop shortcut could not be sent"
        ))
    }
}

#[cfg(not(windows))]
fn open_system_voice_input() -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "System voice input is only available on Windows"
    ))
}

#[cfg(not(windows))]
fn close_system_voice_input() -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "System voice input is only available on Windows"
    ))
}

#[cfg(windows)]
fn keyboard_input(
    key: windows_sys::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
    key_up: bool,
) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    };

    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                wScan: 0,
                dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn explorer_args_for_path(path: &Path, is_file: bool) -> Vec<String> {
    let explorer_path = explorer_path_string(path);
    if is_file {
        vec!["/select,".to_string(), explorer_path]
    } else {
        vec![explorer_path]
    }
}

fn normalize_open_path_input(path: &str) -> PathBuf {
    normalize_drive_relative_path(expand_home_directory(path))
}

fn expand_home_directory(path: &str) -> PathBuf {
    let path = path.trim().trim_matches('"');
    let Some(relative) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) else {
        return PathBuf::from(path);
    };

    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");

    home.map(PathBuf::from)
        .map(|home| home.join(relative))
        .unwrap_or_else(|| PathBuf::from(path))
}

#[cfg(windows)]
fn normalize_drive_relative_path(path: PathBuf) -> PathBuf {
    use std::path::{Component, Prefix};

    if path.is_absolute() {
        return path;
    }

    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path;
    };
    let Prefix::Disk(drive) = prefix.kind() else {
        return path;
    };

    let mut rooted = PathBuf::from(format!("{}:\\", char::from(drive)));
    for component in components {
        rooted.push(component.as_os_str());
    }
    rooted
}

#[cfg(not(windows))]
fn normalize_drive_relative_path(path: PathBuf) -> PathBuf {
    path
}

fn explorer_path_string(path: &Path) -> String {
    let path = path.to_string_lossy().replace('/', "\\");
    if let Some(path) = path.strip_prefix("\\\\?\\UNC\\") {
        return format!("\\\\{}", path);
    }
    if let Some(path) = path.strip_prefix("\\\\?\\") {
        return path.to_string();
    }
    path
}

pub fn run() {
    #[cfg(windows)]
    if is_media_viewer_launch() {
        set_media_viewer_app_user_model_id();
    }

    let webview2_automation = is_webview2_automation_launch();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_updater::AppUpdater::default())
        .setup(move |app| {
            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .cloned()
                .context("missing main window configuration")?;
            let mut main_window_builder =
                tauri::WebviewWindowBuilder::from_config(app, &main_window_config)?;

            #[cfg(windows)]
            if webview2_automation {
                main_window_builder = main_window_builder
                    .additional_browser_args(&webview2_automation_browser_args())
                    .data_directory(webview2_automation_data_dir(&app.handle())?);
            }

            let main_window = main_window_builder
                .on_navigation(guard_main_webview_navigation)
                .build()?;

            #[cfg(windows)]
            main_window.with_webview(|webview| unsafe {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                use windows::core::Interface;

                let Ok(core_webview) = webview.controller().CoreWebView2() else {
                    return;
                };
                let Ok(settings) = core_webview.Settings() else {
                    return;
                };
                let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() else {
                    return;
                };
                let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
            })?;

            let data_dir = app_data_dir(&app.handle())?;
            let db = Arc::new(AppDb::new(&data_dir)?);
            let terminal = Arc::new(TerminalManager::default());
            let vitepress = Arc::new(VitePressManager::default());
            let workspace_watcher = Arc::new(WorkspaceWatcherManager::default());
            let mobile_host = Arc::new(MobileHostManager::default());
            app.manage(AppState {
                db: Arc::clone(&db),
                terminal: Arc::clone(&terminal),
                vitepress,
                workspace_watcher,
                mobile_host: Arc::clone(&mobile_host),
            });
            let restore_mobile_host = || -> anyhow::Result<()> {
                if db.mobile_host_enabled()? {
                    let config = ensure_mobile_host_config(&db)?;
                    mobile_host.start(
                        Arc::clone(&db),
                        app.handle().clone(),
                        Arc::clone(&terminal),
                        config,
                    )?;
                }
                Ok(())
            };
            if let Err(error) = restore_mobile_host() {
                eprintln!("[Super High] Failed to restore Mobile Host: {error:#}");
            }
            local_control::start(app.handle().clone(), terminal);
            app.manage(PluginStartupState {
                disabled_by_cli: parse_disable_plugins_flag(),
            });
            app.manage(StartupWorkspaceArg(Mutex::new(parse_cli_startup_target())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            image_viewer_registration::get_image_viewer_registration_command,
            image_viewer_registration::set_image_viewer_registration_command,
            app_updater::get_app_update_status_command,
            app_updater::check_app_update_command,
            app_updater::download_app_update_command,
            app_updater::install_app_update_command,
            take_startup_open_target,
            get_project_startup_config_command,
            get_project_terminal_actions_command,
            get_minecraft_client_config_command,
            minecraft_client_status_command,
            start_minecraft_client_command,
            stop_minecraft_client_command,
            embed_minecraft_client_command,
            resize_minecraft_client_command,
            hide_minecraft_client_command,
            show_minecraft_client_command,
            release_minecraft_client_command,
            release_all_minecraft_clients_command,
            attach_dragoncore_tools_window_command,
            create_project_startup_terminal_session_command,
            start_project_services_command,
            open_project,
            select_directory_command,
            select_files_command,
            pick_save_file_path_command,
            pick_png_export_path_command,
            list_recent_projects,
            remove_recent_project_command,
            get_app_settings,
            save_app_settings,
            probe_channel_command,
            probe_website_latency_command,
            fetch_channel_models_command,
            query_codex_balance_command,
            query_codex_official_usage_command,
            list_cc_providers_command,
            list_cc_profiles_command,
            list_memos_command,
            create_memo_command,
            update_memo_command,
            delete_memo_command,
            list_directory_command,
            list_skills_command,
            is_file_command,
            resolve_terminal_path_command,
            read_file_command,
            read_image_as_data_url_command,
            read_office_file_base64_command,
            read_media_as_data_url_command,
            prepare_video_preview_command,
            save_image_data_url_command,
            save_pasted_image_command,
            write_file_command,
            create_file_command,
            create_directory_command,
            rename_path_command,
            delete_path_command,
            copy_paths_to_directory_command,
            move_paths_to_directory_command,
            copy_files_to_clipboard_command,
            replace_image_from_clipboard_command,
            search_project_files_command,
            get_project_minecraft_capabilities_command,
            search_item_library_command,
            item_library_keys_command,
            search_monster_library_command,
            send_item_to_player_command,
            send_item_to_named_player_command,
            online_players_command,
            execute_project_rcon_command,
            list_project_script_tools_command,
            run_project_script_tool_command,
            open_dragoncore_gui_command,
            sync_workspace_watch_roots_command,
            sync_workspace_watch_targets_command,
            set_active_workspace_command,
            discover_project_instruction_files_command,
            migrate_project_instruction_file_command,
            detect_cli_environments_command,
            ensure_mobile_host_config_command,
            mobile_host_status_command,
            start_mobile_host_command,
            stop_mobile_host_command,
            create_terminal_session_command,
            resume_cli_conversation_command,
            open_external_cli_command,
            open_external_cli_session_command,
            enhance_prompt_with_codex_command,
            write_terminal_input_command,
            resize_terminal_session_command,
            get_terminal_buffer_command,
            get_native_cli_transcript_command,
            list_workspace_cli_conversations_command,
            read_workspace_cli_conversation_command,
            list_workspace_prompt_history_command,
            load_cli_history_command,
            refresh_cli_history_command,
            record_cli_history_message_command,
            list_live_terminal_session_ids_command,
            close_terminal_session_command,
            close_terminal_sessions_for_workspace_command,
            open_path_command,
            open_file_with_app_command,
            open_url_command,
            get_app_storage_info_command,
            list_plugins_command,
            read_plugin_asset_command,
            plugin_shell_exec_command,
            detect_vitepress_docs_command,
            ensure_vitepress_docs_command,
            stop_vitepress_docs_command,
            open_system_voice_input_command,
            close_system_voice_input_command,
            shutdown_app_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn run_cli_from_env() -> i32 {
    cli::run_from_env()
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let datetime = time::OffsetDateTime::from_unix_timestamp(now as i64)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        explorer_args_for_path, explorer_path_string, first_cli_workspace_folder,
        is_supported_external_url, normalize_external_url_input, normalize_open_path_input,
        normalize_path, png_export_path, startup_target_from_cli_arg,
        workspace_folder_from_cli_arg,
    };
    use serde_json::Value;
    use std::{ffi::OsStr, fs, path::PathBuf};

    #[test]
    fn explorer_select_arg_keeps_flag_and_file_path_separate() {
        let path = PathBuf::from(r"D:\Demo Files\src\App.vue");

        assert_eq!(
            explorer_args_for_path(&path, true),
            vec![
                "/select,".to_string(),
                r"D:\Demo Files\src\App.vue".to_string()
            ]
        );
    }

    #[test]
    fn png_export_path_uses_png_extension() {
        assert_eq!(
            png_export_path(PathBuf::from("D:/Media/texture.webp")),
            PathBuf::from("D:/Media/texture.png")
        );
        assert_eq!(
            png_export_path(PathBuf::from("D:/Media/texture.PNG")),
            PathBuf::from("D:/Media/texture.PNG")
        );
    }

    #[test]
    fn content_security_policy_allows_data_image_previews() {
        let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config = fs::read_to_string(config_path).unwrap();
        let config: Value = serde_json::from_str(&config).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();

        assert!(
            csp.split(';').any(|directive| {
                let directive = directive.trim();
                directive.starts_with("img-src ")
                    && directive.split_whitespace().any(|value| value == "data:")
            }),
            "CSP must allow img-src data: for DragonCore item icon previews"
        );
    }

    #[test]
    fn content_security_policy_allows_data_and_streamed_media_previews() {
        let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config = fs::read_to_string(config_path).unwrap();
        let config: Value = serde_json::from_str(&config).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().unwrap();

        assert!(
            csp.split(';').any(|directive| {
                let directive = directive.trim();
                directive.starts_with("media-src ")
                    && directive.split_whitespace().any(|value| value == "data:")
                    && directive
                        .split_whitespace()
                        .any(|value| value == "http://asset.localhost")
            }),
            "CSP must allow data URLs and the asset protocol for media previews"
        );
        assert_eq!(
            config["app"]["security"]["assetProtocol"]["enable"],
            true,
            "the streaming asset protocol must be enabled"
        );
    }

    #[test]
    fn media_file_associations_are_registered_as_viewers() {
        let config_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config = fs::read_to_string(config_path).unwrap();
        let config: Value = serde_json::from_str(&config).unwrap();
        let associations = config["bundle"]["fileAssociations"].as_array().unwrap();

        assert!(associations.iter().all(|association| {
            association["mimeType"] != "image/*"
                && association["ext"].as_array().is_none_or(|extensions| {
                    !extensions.iter().any(|extension| extension == "png")
                })
        }), "image registration must remain opt-in");

        for expected in [
            "mp4", "webm", "ogg",
            "ogv", "mov",
        ] {
            let association = associations.iter().find(|association| {
                association["ext"].as_array().is_some_and(|extensions| {
                    extensions.iter().any(|extension| extension == expected)
                })
            });
            let association =
                association.unwrap_or_else(|| panic!("missing {expected} association"));
            assert_eq!(
                association["role"], "Viewer",
                "{expected} must use Viewer role"
            );
        }
    }

    #[test]
    fn explorer_folder_arg_is_the_folder_path_only() {
        let path = PathBuf::from(r"D:\Demo Files\src");

        assert_eq!(
            explorer_args_for_path(&path, false),
            vec![r"D:\Demo Files\src".to_string()]
        );
    }

    #[test]
    fn accepts_only_http_urls_for_system_browser() {
        assert!(is_supported_external_url("https://example.com/path?q=1"));
        assert!(is_supported_external_url("http://127.0.0.1:1420/"));
        assert!(!is_supported_external_url("javascript:alert(1)"));
        assert!(!is_supported_external_url("file:///C:/temp/index.html"));
        assert!(!is_supported_external_url("https://example.com/\nnext"));
        assert_eq!(
            normalize_external_url_input("  https://example.com  ").unwrap(),
            "https://example.com"
        );
    }

    #[test]
    fn strips_extended_length_prefix_before_passing_to_explorer() {
        let path = PathBuf::from(r"\\?\D:\Demo Files\src\App.vue");

        assert_eq!(explorer_path_string(&path), r"D:\Demo Files\src\App.vue");
    }

    #[cfg(windows)]
    #[test]
    fn drive_only_input_is_treated_as_drive_root() {
        assert_eq!(normalize_open_path_input("D:"), PathBuf::from(r"D:\"));
    }

    #[cfg(windows)]
    #[test]
    fn cli_file_arg_opens_its_parent_folder() {
        let file_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let expected_parent = normalize_path(file_path.parent().unwrap());

        assert_eq!(
            workspace_folder_from_cli_arg(file_path.as_os_str()),
            Some(expected_parent)
        );
    }

    #[cfg(windows)]
    #[test]
    fn cli_file_arg_preserves_the_file_for_frontend_opening() {
        let file_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let target = startup_target_from_cli_arg(file_path.as_os_str()).unwrap();

        assert_eq!(
            target.workspace_path,
            normalize_path(file_path.parent().unwrap())
        );
        assert_eq!(target.file_path, Some(normalize_path(&file_path)));
    }

    #[cfg(windows)]
    #[test]
    fn cli_arg_parser_skips_flags_before_workspace_path() {
        let root_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));

        assert_eq!(
            first_cli_workspace_folder([OsStr::new("--ignored"), root_path.as_os_str()]),
            Some(normalize_path(&root_path))
        );
    }

    #[test]
    fn detects_disable_plugins_cli_flag() {
        assert!(super::has_disable_plugins_arg([std::ffi::OsString::from(
            "--disable-plugins"
        ),]));
        assert!(!super::has_disable_plugins_arg([std::ffi::OsString::from(
            "--help",
        )]));
    }

    #[test]
    fn detects_webview2_automation_cli_flag() {
        assert!(super::has_webview2_automation_arg([
            std::ffi::OsString::from("--webview2-automation"),
        ]));
        assert!(!super::has_webview2_automation_arg([
            std::ffi::OsString::from("--disable-plugins"),
        ]));
    }

    #[test]
    fn main_webview_navigation_allows_only_super_high_urls() {
        assert!(super::is_super_high_main_url(
            &tauri::Url::parse("about:blank").unwrap()
        ));
        assert!(super::is_super_high_main_url(
            &tauri::Url::parse("tauri://localhost/").unwrap()
        ));
        assert!(super::is_super_high_main_url(
            &tauri::Url::parse("http://tauri.localhost/").unwrap()
        ));
        assert!(!super::is_super_high_main_url(
            &tauri::Url::parse("https://example.com/billing").unwrap()
        ));
    }

    #[cfg(windows)]
    #[test]
    fn webview2_automation_arguments_use_loopback_cdp() {
        let args = super::webview2_automation_browser_args();

        assert!(args.contains("--remote-debugging-address=127.0.0.1"));
        assert!(args.contains("--remote-debugging-port=9222"));
    }

    #[test]
    fn project_startup_command_returns_none_when_project_config_is_missing() {
        let directory = tempfile::tempdir().unwrap();

        let config = super::get_project_startup_config_command(
            directory.path().to_string_lossy().to_string(),
        )
        .unwrap();

        assert!(config.is_none());
    }
}

#[cfg(test)]
mod test_support {
    pub static ENV_LOCK: once_cell::sync::Lazy<std::sync::Mutex<()>> =
        once_cell::sync::Lazy::new(|| std::sync::Mutex::new(()));
}
