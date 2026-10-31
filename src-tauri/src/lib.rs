mod automation;
mod cli_automation;
mod app_updater;
mod agent_control;
pub mod agent_host;
pub mod agent_console;
mod balance_pet;
mod cc_switch;
mod cc_usage;
mod channel_probe;
mod cli;
mod cli_agent;
mod cli_mcp;
mod cli_chat;
mod chat_edits;
mod cli_conversations;
mod cli_completion;
mod cli_completion_adapters;
mod claude_session;
mod codex_session;
mod codex_protocol_bridge;
mod codex_agents;
mod claude_plan;
mod codex_plan;
mod cli_appearance;
mod cli_env;
mod cli_files;
mod cli_history;
mod cli_memo;
mod cli_service;
mod cli_skills;
mod cli_terminal;
mod cli_tools;
mod cli_workspace;
mod db;
mod fs_ops;
mod git_replay;
mod git_repo;
mod github_account;
mod image_viewer_registration;
mod local_control;
mod media_stream;
mod native_video;
mod minecraft_client;
mod mobile_host;
mod models;
mod pasted_image;
mod pasted_text;
mod plugins;
mod process_tree;
mod project_data_cleanup;
mod project_instructions;
mod project_services;
mod project_startup;
mod project_terminal_actions;
pub mod service_console;
mod script_tools;
mod script_usage;
mod skills;
mod commands;
mod terminal;
mod terminal_paths;
mod webpage_titles;
mod workflow_memory;
mod workspace_config;
mod extension_projects;
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
    delete_path, list_directory, move_paths_to_directory, normalize_path, recycle_path,
    read_image_as_data_url, read_media_as_data_url, read_office_file_base64, read_text_file, read_text_file_with_encoding, rename_path,
    read_files_from_clipboard, replace_image_from_clipboard, resolve_super_high_root, save_download_data_url, save_image_data_url,
    write_text_file, write_text_file_with_encoding,
};
use mobile_host::{MobileHostManager, SharedMobileHostManager};
use models::{
    AppSettings, AppStorageInfo, ChannelConfig, ChannelProbeResult, CliHistorySnapshot,
    CliNativeConversationDetail, CliNativeConversationSummary, CliProviderEnvironment,
    EndpointLatencyResult, FetchedModel, MemoCursor, MemoPage, MemoRecord, MobileHostConfig,
    MobileHostStatus, NativeCliTranscript, PluginListResponse, PluginShellExecRequest,
    PluginShellExecResult, PluginWorkspaceContext, ProjectInstructionFileKind,
    ProjectInstructionFiles, ProjectInstructionMigrationResult, ProjectSearchOptions,
    ProjectSearchResult, RecentProject,
    TerminalSessionDto, Workspace, WorkspaceWatchTarget,
};
use pasted_image::save_pasted_image_data_url;
use project_startup::{ProjectStartupInfo, ProjectStartupMode};
use tauri::{Emitter, Manager, State};
use terminal::{SharedTerminalManager, TerminalManager};
use uuid::Uuid;
use workspace_watcher::{SharedWorkspaceWatcherManager, WorkspaceWatcherManager};

struct AppState {
    db: Arc<AppDb>,
    terminal: SharedTerminalManager,
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
fn webview2_data_dir(app_handle: &tauri::AppHandle, name: &str) -> anyhow::Result<PathBuf> {
    let path = app_data_dir(app_handle)?.join(name);
    fs::create_dir_all(&path).context("failed to create WebView2 data directory")?;
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
            .create_independent_session(
                &app,
                workspace_id,
                &workspace,
                "project-startup",
                &config.name,
                &PathBuf::from(script_path),
                &[],
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
    state.terminal.register_workspace(&workspace.id, Path::new(&workspace.root_path));
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
// 设置「使用统计」：只读聚合 cc-switch 用量，放到阻塞线程避免卡住界面。
async fn load_usage_stats_command() -> Result<cc_usage::UsageStatsResponse, String> {
    tokio::task::spawn_blocking(cc_usage::load_usage_stats)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
// 设置「插件」的脚本使用统计：先增量扫描会话记录，首次可能读取数百 MB，放到阻塞线程。
async fn load_script_usage_command(project_path: String) -> Result<script_usage::ScriptUsageResponse, String> {
    tokio::task::spawn_blocking(move || script_usage::load(&project_path))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_memos_command(
    state: State<'_, AppState>,
    query: Option<String>,
    created_from: Option<String>,
    created_before: Option<String>,
    category: Option<String>,
) -> Result<Vec<MemoRecord>, String> {
    state
        .db
        .list_memos(
            query.as_deref(),
            created_from.as_deref(),
            created_before.as_deref(),
            category.as_deref(),
        )
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_memo_page_command(
    state: State<'_, AppState>, query: Option<String>, created_from: Option<String>,
    created_before: Option<String>, category: Option<String>, cursor: Option<MemoCursor>,
    backwards: Option<bool>, anchor_id: Option<String>,
) -> Result<MemoPage, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        db.list_memo_page(query.as_deref(), created_from.as_deref(), created_before.as_deref(),
            category.as_deref(), cursor.as_ref(), backwards.unwrap_or(false), anchor_id.as_deref())
            .map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_memo_command(state: State<'_, AppState>, id: String) -> Result<MemoRecord, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || db.get_memo(&id).map_err(|error| error.to_string()))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn create_memo_command(state: State<'_, AppState>, category: Option<String>) -> Result<MemoRecord, String> {
    state.db.create_memo(category.as_deref().unwrap_or("")).map_err(|error| error.to_string())
}

#[tauri::command]
async fn fetch_webpage_titles_command(urls: Vec<String>) -> Result<Vec<webpage_titles::WebpageTitle>, String> {
    webpage_titles::fetch_webpage_titles(urls).await
}

#[tauri::command]
fn update_memo_command(
    state: State<'_, AppState>,
    id: String,
    title: String,
    content: String,
    category: String,
    attachments: Vec<String>,
) -> Result<MemoRecord, String> {
    state
        .db
        .update_memo(&id, &title, &content, &category, &attachments)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_memo_command(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_memo(&id).map_err(|error| error.to_string())
}

#[tauri::command]
async fn memo_cli_data_command(state: State<'_, AppState>, request: cli_memo::MemoRequest) -> Result<serde_json::Value, String> {
    cli_memo::execute_data(&state.db, &request).await.map_err(|error| error.to_string())
}

#[tauri::command]
fn memo_cli_complete_command(id: String, result: serde_json::Value, error: Option<String>) {
    cli_memo::complete(&id, result, error);
}

#[tauri::command]
fn files_cli_complete_command(id: String, result: serde_json::Value, error: Option<String>) {
    cli_files::complete_open(&id, result, error);
}

#[tauri::command]
fn memo_cli_ready_command(ready: bool) {
    cli_memo::set_ready(ready);
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
async fn media_file_missing_command(path: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || match std::fs::metadata(normalize_open_path_input(&path)) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn resolve_terminal_path_command(path: String) -> Option<TerminalPathTarget> {
    let path = terminal_paths::resolve(&normalize_open_path_input(&path))?;
    Some(TerminalPathTarget {
        path: normalize_path(&path),
        is_file: path.is_file(),
    })
}

#[tauri::command]
fn chat_edit_preview_command(cwd: String, path: String, changes: Vec<chat_edits::PatchFile>) -> Result<chat_edits::EditPreview, String> {
    chat_edits::preview(&cwd, &path, &changes)
}

#[tauri::command]
fn chat_edit_undo_command(cwd: String, path: String, changes: Vec<chat_edits::PatchFile>, expected: String) -> Result<(), String> {
    chat_edits::undo(&cwd, &path, &changes, &expected)
}

#[tauri::command]
async fn read_file_command(path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        read_text_file(&PathBuf::from(path)).map_err(|error| format!("{error:#}"))
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
async fn prepare_video_preview_command(streams: State<'_, media_stream::MediaStreams>, path: String) -> Result<serde_json::Value, String> {
    let streams = streams.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Browser/IUI media uses the original byte stream. The desktop viewer
        // decodes through libmpv; neither path creates a compatibility copy.
        let token = streams.register(&PathBuf::from(path)).map_err(|error| error.to_string())?;
        Ok(serde_json::json!({"token": token, "optimized": false}))
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn native_video_supported_command() -> bool { cfg!(windows) }

#[tauri::command]
async fn native_video_command(
    window: tauri::WebviewWindow,
    videos: State<'_, native_video::NativeVideos>,
    id: String,
    action: native_video::Action,
) -> Result<serde_json::Value, String> {
    let videos = videos.inner().clone();
    tauri::async_runtime::spawn_blocking(move || videos.execute(window, id, action).map_err(|error| format!("{error:#}")))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
fn save_download_data_url_command(path: String, data_url: String) -> Result<String, String> {
    save_download_data_url(&PathBuf::from(path), &data_url).map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_editor_file_command(path: String, encoding: Option<String>) -> Result<fs_ops::TextFileContent, String> {
    tokio::task::spawn_blocking(move || {
        read_text_file_with_encoding(&PathBuf::from(path), encoding.as_deref()).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn list_memo_categories_command(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.db.list_memo_categories().map_err(|error| error.to_string())
}

#[tauri::command]
fn create_memo_category_command(state: State<'_, AppState>, name: String) -> Result<Vec<String>, String> {
    state.db.create_memo_category(&name).map_err(|error| error.to_string())
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
fn save_pasted_text_command(
    project_path: String,
    stamp: String,
    content: String,
) -> Result<pasted_text::PastedTextFile, String> {
    pasted_text::save_pasted_text(&PathBuf::from(project_path), &stamp, &content)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_pasted_texts_command(project_path: String) -> Result<Vec<pasted_text::PastedTextFile>, String> {
    pasted_text::list_pasted_texts(&PathBuf::from(project_path)).map_err(|error| error.to_string())
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
fn recycle_path_command(path: String) -> Result<(), String> {
    recycle_path(&PathBuf::from(path)).map_err(|error| error.to_string())
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
fn write_editor_file_command(path: String, content: String, encoding: String) -> Result<(), String> {
    write_text_file_with_encoding(&PathBuf::from(path), &content, &encoding)
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn read_files_from_clipboard_command() -> Result<Vec<String>, String> {
    read_files_from_clipboard().map_err(|error| error.to_string())
}

#[tauri::command]
fn replace_image_from_clipboard_command(path: String) -> Result<(), String> {
    replace_image_from_clipboard(&PathBuf::from(path)).map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_project_search_command(consumer_id: String) {
    let _ = fs_ops::begin_project_search(Some(&consumer_id));
}

#[tauri::command]
async fn search_project_files_command(
    query: String, roots: Vec<String>, options: Option<ProjectSearchOptions>, consumer_id: Option<String>,
) -> Result<ProjectSearchResult, String> {
    run_project_search(query, roots, options, consumer_id, None).await
}

#[tauri::command]
async fn stream_project_search_command(
    query: String, roots: Vec<String>, options: Option<ProjectSearchOptions>, consumer_id: Option<String>,
    on_batch: tauri::ipc::Channel<Vec<models::TextSearchMatch>>,
) -> Result<ProjectSearchResult, String> {
    run_project_search(query, roots, options, consumer_id, Some(on_batch)).await
}

async fn run_project_search(
    query: String, roots: Vec<String>, options: Option<ProjectSearchOptions>, consumer_id: Option<String>,
    on_batch: Option<tauri::ipc::Channel<Vec<models::TextSearchMatch>>>,
) -> Result<ProjectSearchResult, String> {
    static SEARCH_PERMITS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let token = fs_ops::begin_project_search(consumer_id.as_deref());
    let permit = SEARCH_PERMITS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
        .clone().acquire_owned().await.map_err(|error| error.to_string())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let send = |rows| { if let Some(channel) = &on_batch { let _ = channel.send(rows); } };
        fs_ops::search_project_files_streaming(&query, &roots, options.unwrap_or_default(), &token,
            on_batch.as_ref().map(|_| &send as &(dyn Fn(Vec<models::TextSearchMatch>) + Sync)))
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
async fn list_skill_overview_command(
    project_path: Option<String>,
) -> Result<Vec<skills::SkillOverviewItem>, String> {
    tokio::task::spawn_blocking(move || {
        let project_path = project_path.as_deref().map(Path::new);
        skills::list_skill_overview(project_path)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_registered_commands_command(
    project_path: Option<String>,
) -> Result<Vec<commands::CommandCompletionItem>, String> {
    tokio::task::spawn_blocking(move || commands::list_commands(project_path.as_deref().map(Path::new)))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_project_script_tools_command(
    project_path: String,
    include_hidden: Option<bool>,
) -> Result<script_tools::ScriptToolListResponse, String> {
    tokio::task::spawn_blocking(move || {
        if include_hidden.unwrap_or(false) {
            script_tools::inspect_project_script_tools(&PathBuf::from(project_path), true)
        } else {
            script_tools::list_project_script_tools(&PathBuf::from(project_path))
        }
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_extension_projects_command(project_path: String) -> Result<Vec<extension_projects::ExtensionProject>, String> {
    extension_projects::load(Path::new(&project_path)).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn save_extension_projects_command(project_path: String, projects: Vec<extension_projects::ExtensionProject>) -> Result<(), String> {
    extension_projects::save(Path::new(&project_path), projects).map_err(|error| format!("{error:#}"))
}

#[tauri::command]
fn list_extension_project_roots_command(project_path: String, feature: String) -> Result<Vec<String>, String> {
    extension_projects::roots(Path::new(&project_path), &feature)
        .map(|paths| paths.iter().map(|path| fs_ops::normalize_path(path)).collect())
        .map_err(|error| format!("{error:#}"))
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
async fn run_project_script_tool_streaming_command(
    project_path: String,
    tool_id: String,
    values: HashMap<String, String>,
    on_progress: tauri::ipc::Channel<script_tools::ScriptToolProgress>,
) -> Result<script_tools::ScriptToolRunResponse, String> {
    tokio::task::spawn_blocking(move || {
        script_tools::run_project_script_tool_streaming(&PathBuf::from(project_path), &tool_id, &values, &|event| {
            let _ = on_progress.send(event);
        })
    }).await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
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
    // Build the file search index in the background so the first search does not wait for the walk.
    if let Some(root) = path.clone().filter(|root| !root.is_empty()) {
        std::thread::spawn(move || fs_ops::prewarm_search_index(std::path::Path::new(&root)));
    }
    state.mobile_host.set_active_project(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn set_mobile_view_state_command(state: State<'_, AppState>, view: models::MobileViewState) {
    state.mobile_host.set_view_state(view);
}

#[tauri::command]
fn complete_mobile_view_command(state: State<'_, AppState>, id: String, result: serde_json::Value, error: Option<String>) {
    state.mobile_host.complete_ui(&id, result, error);
}

#[tauri::command]
fn update_mobile_host_config_command(app: tauri::AppHandle, state: State<'_, AppState>, config: MobileHostConfig) -> Result<MobileHostStatus, String> {
    let previous = ensure_mobile_host_config(&state.db).map_err(|error| error.to_string())?;
    let config = save_mobile_host_config(&state.db, config).map_err(|error| error.to_string())?;
    if let Err(error) = state.mobile_host.synchronize_enabled(Arc::clone(&state.db), app.clone(), Arc::clone(&state.terminal), config.clone()) {
        let _ = save_mobile_host_config(&state.db, previous.clone());
        let _ = state.mobile_host.synchronize_enabled(Arc::clone(&state.db), app, Arc::clone(&state.terminal), previous);
        return Err(error.to_string());
    }
    Ok(state.mobile_host.status(&config))
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
fn discover_global_instruction_files_command() -> Result<Vec<project_instructions::GlobalInstructionFile>, String> {
    project_instructions::discover_global_instruction_files().map_err(|error| error.to_string())
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
        let cwd = PathBuf::from(cwd);
        terminal.create_session_for_workspace(
            &app,
            workspace_id,
            &provider_kind,
            &cwd,
            env.unwrap_or_default(),
            initial_prompt,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_replay_start_command(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    repo_path: String,
    options: Option<git_replay::GitReplayOptions>,
) -> Result<TerminalSessionDto, String> {
    let terminal = Arc::clone(&state.terminal);
    tokio::task::spawn_blocking(move || {
        git_replay::start_replay(&app, &terminal, workspace_id, &repo_path, &options.unwrap_or_default())
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
        let cwd = PathBuf::from(cwd);
        terminal.resume_session_for_workspace(
            &app,
            workspace_id,
            &provider_kind,
            &cwd,
            &native_session_id,
        )
        .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn open_external_cli_command(
    state: State<'_, AppState>,
    provider_kind: String,
    cwd: String,
) -> Result<(), String> {
    let maximized = state
        .db
        .load_settings()
        .map_err(|error| error.to_string())?
        .external_cmd_maximized;
    terminal::open_external_cli(&provider_kind, &PathBuf::from(cwd), maximized)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_external_cli_session_command(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let terminal = Arc::clone(&state.terminal);
    let maximized = state
        .db
        .load_settings()
        .map_err(|error| error.to_string())?
        .external_cmd_maximized;
    tokio::task::spawn_blocking(move || terminal.open_external_session(&session_id, maximized))
        .await
        .map_err(|error| format!("外部会话移交任务异常结束：{error}"))?
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
    state.db.set_mobile_host_enabled(true).map_err(|error| error.to_string())?;
    match state.mobile_host.start(Arc::clone(&state.db), app, Arc::clone(&state.terminal), config) {
        Ok(status) => Ok(status),
        Err(error) => {
            let _ = state.db.set_mobile_host_enabled(false);
            state.mobile_host.stop();
            Err(error.to_string())
        }
    }
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
fn get_cli_plan_request_command(state: State<'_, AppState>, session_id: String, connection: u64, request_id: serde_json::Value) -> Option<codex_plan::PlanRequest> {
    state.terminal.pending_plan(&session_id, connection, &request_id)
}

#[tauri::command]
async fn reply_cli_plan_command(state: State<'_, AppState>, session_id: String, connection: u64, request_id: serde_json::Value, answers: HashMap<String, Vec<String>>) -> Result<(), String> {
    let terminal = state.terminal.clone();
    tauri::async_runtime::spawn_blocking(move || terminal.reply_plan(&session_id, connection, request_id, answers).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
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
    force: Option<bool>,
) -> Result<(), String> {
    state
        .terminal
        .resize_session_with(&session_id, cols, rows, force.unwrap_or(false))
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

fn cache_hit_rate(cached: Option<u64>, input: Option<u64>) -> Option<f64> {
    let (cached, input) = (cached?, input?);
    if input == 0 || cached > input { None } else { Some(cached as f64 / input as f64) }
}

fn claude_context(usage: &serde_json::Value, window: &serde_json::Value, source: &str) -> Option<serde_json::Value> {
    let Some(input) = usage["input_tokens"].as_u64() else {
        return window.as_u64().map(|_| serde_json::json!({"usedTokens":null,"windowTokens":window,"inputTokens":null,"outputTokens":null,"cachedTokens":null,"cacheHitRate":null,"segments":[],"source":source}));
    };
    let cached = usage["cache_read_input_tokens"].as_u64();
    let total = input.saturating_add(cached.unwrap_or(0)).saturating_add(usage["cache_creation_input_tokens"].as_u64().unwrap_or(0));
    Some(serde_json::json!({"usedTokens":total,"windowTokens":window,"inputTokens":total,"outputTokens":usage["output_tokens"],"cachedTokens":cached,"cacheHitRate":cache_hit_rate(cached, Some(total)),"segments":[],"source":source}))
}

fn claude_status_snapshot(status: &serde_json::Value) -> (Option<String>, Option<serde_json::Value>) {
    let window = &status["context_window"];
    (status["model"]["id"].as_str().map(str::to_owned), claude_context(&window["current_usage"], &window["context_window_size"], "claude-status-line"))
}

fn native_log_snapshot(path: &str, provider: &str) -> (Option<String>, Option<String>, Option<serde_json::Value>) {
    use std::io::{Read, Seek, SeekFrom};
    type Snapshot = (Option<String>, Option<String>, Option<serde_json::Value>);
    type Entry = (u64, Option<std::time::SystemTime>, Snapshot);
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Entry>>> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let Ok(mut file) = std::fs::File::open(path) else { return (None, None, None) };
    let Ok(meta) = file.metadata() else { return (None, None, None) };
    let key = (meta.len(), meta.modified().ok());
    if let Some((len, modified, snapshot)) = cache.lock().unwrap().get(&format!("{provider}:{path}")) { if (*len, *modified) == key { return snapshot.clone(); } }
    let offset = meta.len().saturating_sub(256 * 1024);
    if file.seek(SeekFrom::Start(offset)).is_err() { return (None, None, None); }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() { return (None, None, None); }
    let start = if offset > 0 { bytes.iter().position(|b| *b == b'\n').map(|n| n + 1).unwrap_or(bytes.len()) } else { 0 };
    let data = String::from_utf8_lossy(&bytes[start..]);
    let mut snapshot: Snapshot = (None, None, None);
    for line in data.lines().rev() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if provider == "claude" {
            let message = &value["message"];
            if snapshot.0.is_none() { snapshot.0 = message["model"].as_str().filter(|m| !m.starts_with('<')).map(str::to_owned); }
            if snapshot.2.is_none() { snapshot.2 = claude_context(&message["usage"], &serde_json::Value::Null, "claude-message-usage"); }
        } else {
            let payload = &value["payload"];
            if value["type"] == "turn_context" && snapshot.0.is_none() {
                snapshot.0 = payload["model"].as_str().map(str::to_owned);
                snapshot.1 = payload.pointer("/collaboration_mode/settings/reasoning_effort").or_else(|| payload.get("effort")).and_then(serde_json::Value::as_str).map(str::to_owned);
            }
            if value["type"] == "event_msg" && payload["type"] == "token_count" && snapshot.2.is_none() {
                let info = &payload["info"];
                let last = &info["last_token_usage"];
                if last["total_tokens"].as_u64().is_some() {
                    snapshot.2 = Some(serde_json::json!({"usedTokens":last["total_tokens"],"windowTokens":info["model_context_window"],"inputTokens":last["input_tokens"],"outputTokens":last["output_tokens"],"cachedTokens":last["cached_input_tokens"],"cacheHitRate":cache_hit_rate(last["cached_input_tokens"].as_u64(), last["input_tokens"].as_u64()),"segments":[],"source":"codex-native-log"}));
                }
            }
        }
        if snapshot.0.is_some() && snapshot.2.is_some() { break; }
    }
    let mut cache = cache.lock().unwrap();
    if cache.len() >= 128 { cache.clear(); }
    cache.insert(format!("{provider}:{path}"), (key.0, key.1, snapshot.clone()));
    snapshot
}

#[cfg(test)]
mod chat_control_tests {
    use super::*;
    #[test]
    fn codex_native_last_usage_and_empty_claude_window() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let records = [
            serde_json::json!({"type":"turn_context","payload":{"model":"gpt-test","collaboration_mode":{"settings":{"reasoning_effort":"high"}}}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":9000},"last_token_usage":{"total_tokens":120,"input_tokens":100,"cached_input_tokens":40,"output_tokens":20},"model_context_window":200000}}})
        ];
        std::fs::write(file.path(), records.iter().map(|v| v.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let (model, effort, context) = native_log_snapshot(file.path().to_str().unwrap(), "codex");
        assert_eq!(model.as_deref(), Some("gpt-test"));
        assert_eq!(effort.as_deref(), Some("high"));
        let context = context.unwrap();
        assert_eq!(context["usedTokens"], 120);
        assert_eq!(context["windowTokens"], 200000);
        assert_eq!(context["cacheHitRate"], 0.4);
        let (_, empty) = claude_status_snapshot(&serde_json::json!({"context_window":{"context_window_size":200000,"current_usage":null}}));
        let empty = empty.unwrap();
        assert!(empty["usedTokens"].is_null());
        assert_eq!(empty["windowTokens"], 200000);
    }
    #[test]
    fn claude_current_usage_and_cache_rate() {
        let status = serde_json::json!({"model":{"id":"claude-test"},"context_window":{"context_window_size":200000,"current_usage":{"input_tokens":10,"cache_read_input_tokens":60,"cache_creation_input_tokens":30,"output_tokens":4}}});
        let (model, snapshot) = claude_status_snapshot(&status);
        assert_eq!(model.as_deref(), Some("claude-test"));
        assert_eq!(snapshot.unwrap()["windowTokens"], 200000);
        let usage = serde_json::json!({"input_tokens":10,"cache_read_input_tokens":60,"cache_creation_input_tokens":30,"output_tokens":4});
        let context = claude_context(&usage, &serde_json::json!(200000), "claude-status-line").unwrap();
        assert_eq!(context["windowTokens"], 200000);
        assert_eq!(context["usedTokens"], 100);
        assert_eq!(context["inputTokens"], 100);
        assert_eq!(context["cachedTokens"], 60);
        assert_eq!(context["cacheHitRate"], 0.6);
        assert_eq!(cache_hit_rate(Some(5), Some(10)), Some(0.5));
        assert_eq!(cache_hit_rate(Some(1), Some(0)), None);
    }
}

#[tauri::command]
async fn read_terminal_chat_controls_command(state: State<'_, AppState>, session_id: String) -> Result<serde_json::Value, String> {
    let terminal = Arc::clone(&state.terminal);
    tauri::async_runtime::spawn_blocking(move || terminal.chat_controls(&session_id)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

pub(crate) fn local_chat_controls(terminal: &terminal::TerminalManager, session_id: &str) -> anyhow::Result<serde_json::Value> {
    let provider = terminal.session_provider(&session_id).unwrap_or_default();
    let chat_context = terminal.session_chat_context(&session_id);
    let root = chat_context.as_ref().and_then(|(_, _, id)| id.clone());
    let status = terminal.claude_status(&session_id);
    let agents = terminal.codex_agent_view(&session_id);

        let Some(agents) = agents else {
            let (mut model, mut context) = status.as_ref().map(claude_status_snapshot).unwrap_or_default();
            let mut effort = None;
            if matches!(provider.as_str(), "claude" | "codex") && (model.is_none() || context.is_none()) {
                if let Some((cwd, started, Some(native))) = chat_context {
                    if let Ok(Some(path)) = terminal::chat_source(&session_id, &provider, &cwd, started, Some(&native)) {
                        let (log_model, log_effort, log_context) = native_log_snapshot(&path, &provider);
                        effort = log_effort;
                        if model.is_none() { model = log_model; }
                        if context.is_none() { context = log_context; }
                    }
                }
            }
            return Ok(serde_json::json!({"provider":provider,"model":model,"effort":effort,"models":[],"context":context,"canSelectModel":false}));
        };
        let (current, usage, catalog) = agents.controls(root.as_deref())?;
        let mut parts = current.split_whitespace();
        let model = parts.next();
        let effort = parts.next();
        let models: Vec<_> = catalog["data"].as_array().into_iter().flatten().map(|m| serde_json::json!({"id":m["model"],"label":m["displayName"].as_str().unwrap_or_default(),"description":m["description"].as_str().unwrap_or_default(),"efforts":m["supportedReasoningEfforts"].as_array().into_iter().flatten().map(|e| serde_json::json!({"id":e["reasoningEffort"],"label":e["reasoningEffort"],"description":e["description"].as_str().unwrap_or_default()})).collect::<Vec<_>>(),"defaultEffort":m["defaultReasoningEffort"]})).collect();
        let context = usage.map(|u| { let last = &u["last"]; serde_json::json!({"usedTokens":last["totalTokens"],"windowTokens":u["modelContextWindow"],"inputTokens":last["inputTokens"],"outputTokens":last["outputTokens"],"cachedTokens":last["cachedInputTokens"],"cacheHitRate":cache_hit_rate(last["cachedInputTokens"].as_u64(), last["inputTokens"].as_u64()),"segments":[],"source":"codex"}) });
        Ok(serde_json::json!({"provider":provider,"model":model,"effort":effort,"canSelectModel":!models.is_empty(),"models":models,"context":context}))

}

#[tauri::command]
async fn read_terminal_chat_command(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<cli_chat::ChatTranscript>, String> {
    Ok(read_terminal_chat_window(state, session_id, 40).await?.map(|mut transcript| {
        let excess = transcript.turns.len().saturating_sub(40);
        transcript.turns.drain(..excess);
        transcript
    }))
}

async fn read_terminal_chat_window(
    state: State<'_, AppState>, session_id: String, limit: usize,
) -> Result<Option<cli_chat::ChatTranscript>, String> {
    let Some(provider) = state.terminal.session_provider(&session_id) else { return Ok(None) };
    let Some((cwd, started_at, native_id)) = state.terminal.session_chat_context(&session_id) else { return Ok(None) };
    let terminal = Arc::clone(&state.terminal);
    let root = native_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = terminal::chat_source(&session_id, &provider, &cwd, started_at, native_id.as_deref())?;
        // Only expose a source as session identity when it was matched to the
        // PTY's native ID; timestamp-only candidates cannot prove ownership.
        let identity_source = native_id.as_ref().and(source.clone());
        let mut transcript = match source {
            Some(source) if matches!(provider.as_str(), "codex" | "claude") => cli_chat::read_chat_window(&provider, &source, limit)?,
            Some(source) if provider == "opencode" => {
                // An unavailable completion schema keeps the current turn open.
                let completed_at = cli_completion::latest_completion(&provider, &source).ok().flatten().map(|(_, at)| at);
                cli_conversations::read_opencode_live_chat(&cwd, &source, limit, completed_at)?
            },
            Some(source) => {
                let completion_source = if matches!(provider.as_str(), "gemini" | "kimi") {
                    cli_completion_adapters::gemini_completion_path(&session_id).to_string_lossy().into_owned()
                } else { source.clone() };
                let completed_at = cli_completion::latest_completion(&provider, &completion_source)?.map(|(_, at)| at);
                cli_chat::read_native_chat(&cwd, &source, completed_at)?
            }
            None => cli_chat::ChatTranscript::default(),
        };
        // A /resume can change the PTY identity while the file is being read.
        // Never return the old transcript under the new session binding.
        if terminal.session_chat_context(&session_id).map(|(_, _, id)| id) != Some(native_id.clone()) {
            return Ok::<_, anyhow::Error>(cli_chat::ChatTranscript::default());
        }
        transcript.source = identity_source;
        match terminal.agent_view_data(&session_id, root.as_deref(), &transcript.agent_calls, &transcript.agent_links) {
            Ok(view) => {
                if !view.model.is_empty() { transcript.model = view.model; }
                transcript.agents = view.agents;
                transcript.agent_error = view.error;
            }
            Err(error) => transcript.agent_error = Some(error.to_string()),
        }
        Ok::<_, anyhow::Error>(transcript)
    })
        .await
        .map_err(|error| error.to_string())?
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn read_terminal_chat_page_command(
    state: State<'_, AppState>, session_id: String, revision: Option<String>, limit: usize, known: std::collections::HashMap<String, String>,
) -> Result<Option<cli_chat::ChatPage>, String> {
    Ok(read_terminal_chat_window(state, session_id, limit).await?
        .map(|transcript| cli_chat::page_chat(transcript, revision, limit, known)))
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
async fn list_cli_conversations_command(refresh: Option<bool>) -> Result<Vec<CliNativeConversationSummary>, String> {
    tokio::task::spawn_blocking(move || cli_conversations::list_all_conversations(refresh.unwrap_or(false)).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn read_cli_conversation_chat_command(project_path: String, source_path: String, limit: Option<usize>) -> Result<cli_chat::ChatTranscript, String> {
    tokio::task::spawn_blocking(move || cli_conversations::historical_chat(&PathBuf::from(project_path), &source_path, limit.unwrap_or(40).max(1)).map_err(|e| e.to_string())).await.map_err(|e| e.to_string())?
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
async fn restore_service_monitors_command(app: tauri::AppHandle, state: State<'_, AppState>,
    workspace_id: Option<String>, project_path: String) -> Result<Vec<TerminalSessionDto>, String> {
    let terminal = Arc::clone(&state.terminal);
    tauri::async_runtime::spawn_blocking(move || {
        let mut sessions = terminal.restore_independent_sessions(&app, workspace_id.clone(), Path::new(&project_path))?;
        sessions.extend(terminal.restore_agent_sessions(&app, workspace_id, Some(Path::new(&project_path)))?);
        Ok::<_, anyhow::Error>(sessions)
    })
        .await.map_err(|error| error.to_string())?.map_err(|error| error.to_string())
}

#[tauri::command]
async fn close_terminal_session_command(
    state: State<'_, AppState>,
    session_id: String,
    terminate_process: Option<bool>,
) -> Result<(), String> {
    let terminal = Arc::clone(&state.terminal);
    tauri::async_runtime::spawn_blocking(move || {
        if terminate_process == Some(true) && terminal.stop_independent_session(&session_id)? { return Ok(()); }
        if terminate_process == Some(true) { terminal.close_session(&session_id) }
        else { terminal.close_session_view(&session_id) }
    })
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
async fn dsh_webview_show_command(
    app: tauri::AppHandle,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::Manager;
    let url = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("DSH WebView requires a loopback HTTP address".into());
    }
    if ![x, y, width, height].iter().all(|n| n.is_finite()) || width <= 0.0 || height <= 0.0 {
        return Err("invalid DSH WebView bounds".into());
    }
    let position = tauri::LogicalPosition::new(x, y);
    let size = tauri::LogicalSize::new(width, height);
    if let Some(webview) = app.get_webview("dsh-web") {
        webview.set_position(position).map_err(|e| e.to_string())?;
        webview.set_size(size).map_err(|e| e.to_string())?;
        webview.show().map_err(|e| e.to_string())?;
    } else {
        let window = app.get_window("main").ok_or("main window unavailable")?;
        let mut builder = tauri::webview::WebviewBuilder::new("dsh-web", tauri::WebviewUrl::External(url));
        #[cfg(windows)]
        if is_webview2_automation_launch() {
            builder = builder
                .additional_browser_args(&webview2_automation_browser_args())
                .data_directory(webview2_data_dir(&app, "webview2-automation").map_err(|e| e.to_string())?);
        }
        window.add_child(builder, position, size)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn dsh_webview_hide_command(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(webview) = app.get_webview("dsh-web") {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
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
    state.mobile_host.request_shutdown();
    // Release embedded windows before closing their PTYs without blocking the WebView.
    tokio::task::spawn_blocking(move || {
        let minecraft_result = minecraft_client::release_all_minecraft_clients();
        let terminal_result = terminal.close_all_sessions();
        minecraft_result.and(terminal_result)
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())?;

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
    if std::env::args_os().nth(1).as_deref() == Some(OsStr::new("--uninstall-project-data")) {
        let result = std::env::var_os("APPDATA")
            .ok_or_else(|| anyhow::anyhow!("无法定位当前用户的应用数据目录"))
            .and_then(|base| {
                project_data_cleanup::run(
                    &PathBuf::from(base).join("com.superhigh.desktop/super-high.db"),
                )
            });
        if let Err(error) = result {
            rfd::MessageDialog::new()
                .set_title("Super High — 项目数据未清理")
                .set_level(rfd::MessageLevel::Error)
                .set_description(format!("{error:#}"))
                .show();
            std::process::exit(1);
        }
        return;
    }
    #[cfg(windows)]
    if is_media_viewer_launch() {
        set_media_viewer_app_user_model_id();
    }

    let webview2_automation = is_webview2_automation_launch();

    tauri::Builder::default()
        .manage(native_video::NativeVideos::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<native_video::NativeVideos>().close_owner(window.label());
            }
        })
        .manage(media_stream::MediaStreams::default())
        .register_asynchronous_uri_scheme_protocol("media", |context, request, responder| {
            let streams = context.app_handle().state::<media_stream::MediaStreams>().inner().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(streams.respond(request)));
        })
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
                    .data_directory(webview2_data_dir(&app.handle(), "webview2-automation")?);
            } else if is_media_viewer_launch() {
                // A separate profile keeps the viewer from joining the main window's
                // WebView2 browser. That join fails once the runtime updates while the
                // main window is open, leaving a viewer process with no window.
                main_window_builder = main_window_builder
                    .data_directory(webview2_data_dir(&app.handle(), "webview2-media-viewer")?);
            }

            let main_window = main_window_builder
                .on_navigation(guard_main_webview_navigation)
                .build()?;

            #[cfg(windows)]
            if let Err(error) = window_vibrancy::apply_acrylic(&main_window, Some((13, 17, 23, 220))) {
                eprintln!("[Super High] Failed to enable acrylic window background: {error}");
            }

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
            match plugins::GlobalPluginWatcher::start(&app.handle(), &data_dir) {
                Ok(watcher) => { app.manage(watcher); }
                Err(error) => eprintln!("[Super High] Failed to watch global plugins: {error:#}"),
            }
            let terminal = Arc::new(TerminalManager::with_data_dir(data_dir.clone()));
            if let Err(error) = terminal.restore_agent_sessions(app.handle(), None, None) {
                eprintln!("[Super High] Failed to reconnect Agent sessions: {error:#}");
            }
            let workspace_watcher = Arc::new(WorkspaceWatcherManager::default());
            let mobile_host = Arc::new(MobileHostManager::default());
            app.manage(AppState {
                db: Arc::clone(&db),
                terminal: Arc::clone(&terminal),
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
            let monitor_db = Arc::clone(&db);
            let monitor_host = Arc::clone(&mobile_host);
            let monitor_terminal = Arc::clone(&terminal);
            let monitor_app = app.handle().clone();
            let _ = std::thread::Builder::new()
                .name("superhigh-mobile-host-monitor".to_string())
                .spawn(move || {
                    while !monitor_host.monitoring_stopped() {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                        if monitor_host.monitoring_stopped() {
                            break;
                        }
                        let Ok(config) = ensure_mobile_host_config(&monitor_db) else {
                            continue;
                        };
                        if let Err(error) = monitor_host.synchronize_enabled(
                            Arc::clone(&monitor_db),
                            monitor_app.clone(),
                            Arc::clone(&monitor_terminal),
                            config,
                        ) {
                            eprintln!("[Super High] Failed to synchronize Mobile Host: {error:#}");
                        }
                    }
                });
            automation::start_scheduler(data_dir.clone());
            local_control::start(app.handle().clone(), terminal);
            script_usage::start_background_scan();
            app.manage(PluginStartupState {
                disabled_by_cli: parse_disable_plugins_flag(),
            });
            app.manage(StartupWorkspaceArg(Mutex::new(parse_cli_startup_target())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            automation::automation_list_command,
            automation::automation_save_command,
            automation::automation_delete_command,
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
            load_usage_stats_command,
            load_script_usage_command,
            list_memos_command,
            list_memo_page_command,
            get_memo_command,
            create_memo_command,
            fetch_webpage_titles_command,
            update_memo_command,
            delete_memo_command,
            memo_cli_data_command,
            memo_cli_complete_command,
            files_cli_complete_command,
            memo_cli_ready_command,
            list_memo_categories_command,
            create_memo_category_command,
            list_directory_command,
            list_skills_command,
            list_skill_overview_command,
            list_registered_commands_command,
            is_file_command,
            media_file_missing_command,
            resolve_terminal_path_command,
            chat_edit_preview_command,
            chat_edit_undo_command,
            read_file_command,
            read_editor_file_command,
            read_image_as_data_url_command,
            read_office_file_base64_command,
            read_media_as_data_url_command,
            prepare_video_preview_command,
            native_video_supported_command,
            native_video_command,
            save_image_data_url_command,
            save_download_data_url_command,
            save_pasted_image_command,
            save_pasted_text_command,
            list_pasted_texts_command,
            write_file_command,
            write_editor_file_command,
            create_file_command,
            create_directory_command,
            rename_path_command,
            delete_path_command,
            recycle_path_command,
            copy_paths_to_directory_command,
            move_paths_to_directory_command,
            copy_files_to_clipboard_command,
            read_files_from_clipboard_command,
            replace_image_from_clipboard_command,
            search_project_files_command,
            stream_project_search_command,
            cancel_project_search_command,
            git_repo::git_status_command,
            git_repo::git_log_command,
            git_repo::git_commit_detail_command,
            git_repo::git_working_diff_command,
            git_repo::git_commit_file_diff_command,
            github_account::github_account_status_command,
            git_replay::github_repo_list_command,
            git_replay::git_replay_status_command,
            git_replay::git_replay_prepare_command,
            git_replay_start_command,
            list_project_script_tools_command,
            get_extension_projects_command,
            save_extension_projects_command,
            list_extension_project_roots_command,
            run_project_script_tool_command,
            run_project_script_tool_streaming_command,
            sync_workspace_watch_roots_command,
            sync_workspace_watch_targets_command,
            set_active_workspace_command,
            set_mobile_view_state_command,
            complete_mobile_view_command,
            update_mobile_host_config_command,
            discover_project_instruction_files_command,
            discover_global_instruction_files_command,
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
            write_terminal_input_command,
            get_cli_plan_request_command,
            reply_cli_plan_command,
            resize_terminal_session_command,
            get_terminal_buffer_command,
            get_native_cli_transcript_command,
            read_terminal_chat_controls_command,
            read_terminal_chat_command,
            read_terminal_chat_page_command,
            list_cli_conversations_command,
            read_cli_conversation_chat_command,
            list_workspace_cli_conversations_command,
            read_workspace_cli_conversation_command,
            list_workspace_prompt_history_command,
            load_cli_history_command,
            refresh_cli_history_command,
            record_cli_history_message_command,
            list_live_terminal_session_ids_command,
            close_terminal_session_command,
            restore_service_monitors_command,
            close_terminal_sessions_for_workspace_command,
            open_path_command,
            open_file_with_app_command,
            open_url_command,
            get_app_storage_info_command,
            list_plugins_command,
            read_plugin_asset_command,
            plugin_shell_exec_command,
            dsh_webview_show_command,
            dsh_webview_hide_command,
            open_system_voice_input_command,
            close_system_voice_input_command,
            shutdown_app_command
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub fn run_cli_from_env() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "claude-plan-hook") {
        return claude_plan::run_hook(&args[1..]);
    }
    if args.first().is_some_and(|arg| arg == "claude-status-hook") { return claude_session::run_status_hook(&args[1..]); }
    if args.first().is_some_and(|arg| arg == "claude-session-hook") {
        return claude_session::run_hook(&args[1..]);
    }
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
            "CSP must allow img-src data: for embedded image previews"
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
