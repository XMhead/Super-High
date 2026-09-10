use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{terminal::UpdateBlockingSession, AppState};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    phase: String,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    error: Option<String>,
    blocking_sessions: Vec<UpdateBlockingSession>,
}

struct UpdateState {
    status: AppUpdateStatus,
    update: Option<Update>,
    bytes: Option<Arc<Vec<u8>>>,
}

pub struct AppUpdater(Mutex<UpdateState>);

impl Default for AppUpdater {
    fn default() -> Self {
        Self(Mutex::new(UpdateState {
            status: AppUpdateStatus {
                phase: "idle".into(),
                current_version: env!("CARGO_PKG_VERSION").into(),
                version: None,
                notes: None,
                downloaded_bytes: 0,
                total_bytes: None,
                error: None,
                blocking_sessions: Vec::new(),
            },
            update: None,
            bytes: None,
        }))
    }
}

impl AppUpdater {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, UpdateState>, String> {
        self.0.lock().map_err(|_| "更新状态不可用".into())
    }
}

fn busy(phase: &str) -> bool {
    matches!(phase, "checking" | "downloading" | "installing")
}

#[tauri::command]
pub fn get_app_update_status_command(
    updater: State<'_, AppUpdater>,
    state: State<'_, AppState>,
) -> Result<AppUpdateStatus, String> {
    let mut status = updater.lock()?.status.clone();
    status.blocking_sessions = state
        .terminal
        .update_blocking_sessions()
        .map_err(|e| e.to_string())?;
    Ok(status)
}

#[tauri::command]
pub async fn check_app_update_command(
    app: AppHandle,
    updater: State<'_, AppUpdater>,
) -> Result<AppUpdateStatus, String> {
    {
        let mut inner = updater.lock()?;
        if busy(&inner.status.phase) || inner.bytes.is_some() {
            return Ok(inner.status.clone());
        }
        inner.status.phase = "checking".into();
        inner.status.error = None;
    }
    let result = async {
        app.updater_builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    let mut inner = updater.lock()?;
    match result {
        Ok(update) => {
            inner.status.phase = if update.is_some() {
                "available"
            } else {
                "upToDate"
            }
            .into();
            inner.status.version = update.as_ref().map(|u| u.version.clone());
            inner.status.notes = update.as_ref().and_then(|u| u.body.clone());
            inner.status.downloaded_bytes = 0;
            inner.status.total_bytes = None;
            inner.update = update;
        }
        Err(error) => {
            inner.status.phase = "error".into();
            inner.status.error = Some(error);
        }
    }
    Ok(inner.status.clone())
}

#[tauri::command]
pub async fn download_app_update_command(
    updater: State<'_, AppUpdater>,
) -> Result<AppUpdateStatus, String> {
    let mut update = {
        let mut inner = updater.lock()?;
        if busy(&inner.status.phase) || inner.bytes.is_some() {
            return Ok(inner.status.clone());
        }
        let update = inner.update.clone().ok_or("请先检查更新")?;
        inner.status.phase = "downloading".into();
        inner.status.error = None;
        inner.status.downloaded_bytes = 0;
        inner.status.total_bytes = None;
        update
    };
    update.timeout = Some(Duration::from_secs(30 * 60));
    // download verifies the release signature before bytes become installable.
    let result = update
        .download(
            |chunk, total| {
                if let Ok(mut inner) = updater.lock() {
                    inner.status.downloaded_bytes += chunk as u64;
                    inner.status.total_bytes = total;
                }
            },
            || {},
        )
        .await;
    let mut inner = updater.lock()?;
    match result {
        Ok(bytes) => {
            inner.bytes = Some(Arc::new(bytes));
            inner.status.phase = "ready".into();
        }
        Err(error) => {
            inner.status.phase = "error".into();
            inner.status.error = Some(error.to_string());
        }
    }
    Ok(inner.status.clone())
}

#[tauri::command]
pub async fn install_app_update_command(
    updater: State<'_, AppUpdater>,
    state: State<'_, AppState>,
) -> Result<AppUpdateStatus, String> {
    let (update, bytes) = {
        let mut inner = updater.lock()?;
        if busy(&inner.status.phase) {
            return Ok(inner.status.clone());
        }
        let update = inner.update.clone().ok_or("请先检查更新")?;
        let bytes = inner.bytes.clone().ok_or("请先下载更新")?;
        inner.status.phase = "installing".into();
        inner.status.error = None;
        (update, bytes)
    };
    let terminal = Arc::clone(&state.terminal);
    let result = tauri::async_runtime::spawn_blocking(move || {
        terminal
            .install_update_when_idle(|| {
                ensure_no_other_app_processes()?;
                update.install(bytes.as_slice()).map_err(Into::into)
            })
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let mut inner = updater.lock()?;
    if let Err(error) = result {
        inner.status.phase = "ready".into();
        inner.status.error = Some(error);
    }
    inner.status.blocking_sessions = state
        .terminal
        .update_blocking_sessions()
        .map_err(|e| e.to_string())?;
    Ok(inner.status.clone())
}

#[cfg(windows)]
fn is_other_app_process(name: &str, pid: u32, current_name: &str, current_pid: u32) -> bool {
    pid != current_pid && name.eq_ignore_ascii_case(current_name)
}

#[cfg(windows)]
fn ensure_no_other_app_processes() -> anyhow::Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    let executable = std::env::current_exe()?;
    let name = executable
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("无法确认当前应用文件名"))?
        .to_string_lossy();
    let current_pid = std::process::id();
    // NSIS passive updates close processes by executable name, even from another install path.
    // Only inspect matching application processes; unrelated terminal processes are irrelevant.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    anyhow::ensure!(
        snapshot != INVALID_HANDLE_VALUE,
        "无法检查其他 Super High 窗口：{}",
        std::io::Error::last_os_error()
    );
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut pids = Vec::new();
    while found != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        let process_name = String::from_utf16_lossy(&entry.szExeFile[..length]);
        if is_other_app_process(&process_name, entry.th32ProcessID, &name, current_pid) {
            pids.push(entry.th32ProcessID);
        }
        found = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    let error = unsafe { GetLastError() };
    unsafe {
        CloseHandle(snapshot);
    }
    anyhow::ensure!(
        error == ERROR_NO_MORE_FILES,
        "无法完整检查其他 Super High 窗口：{}",
        std::io::Error::from_raw_os_error(error as i32)
    );
    pids.sort_unstable();
    anyhow::ensure!(
        pids.is_empty(),
        "请先关闭其他 Super High 窗口（包括图片查看器），再安装更新。进程 PID：{}",
        pids.iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join("、")
    );
    Ok(())
}

#[cfg(not(windows))]
fn ensure_no_other_app_processes() -> anyhow::Result<()> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::is_other_app_process;

    #[test]
    fn updater_process_guard_excludes_self_and_unrelated_terminals() {
        assert!(is_other_app_process(
            "SUPER-HIGH.EXE",
            11,
            "super-high.exe",
            10
        ));
        assert!(!is_other_app_process(
            "super-high.exe",
            10,
            "super-high.exe",
            10
        ));
        for name in [
            "cmd.exe",
            "powershell.exe",
            "dsh.exe",
            "superhigh-cli.exe",
            "super-high.exe.backup",
        ] {
            assert!(!is_other_app_process(name, 11, "super-high.exe", 10));
        }
    }
}
