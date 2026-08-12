use std::{
    path::{Path, PathBuf},
    process::Command,
};

use crate::models::{
    RemoteConnectionConfig, RemoteDriveStatus, RemoteMapResult, RemoteServerCheck,
};

/// Run a command through `cmd /c` with UTF-8 code page (65001) so that
/// Chinese characters in command output are not garbled.
fn run_with_utf8(script: &str) -> std::io::Result<std::process::Output> {
    Command::new("cmd")
        .args(["/c", &format!("chcp 65001 > nul && {script}")])
        .output()
}

/// Build a `net use` command-line string that maps a drive letter to a UNC path.
fn net_use_map_cmd(letter: &str, unc: &str, username: &str) -> String {
    let user_arg = if username.trim().is_empty() {
        String::new()
    } else {
        format!(" /user:{}", username.trim())
    };
    format!("net use {letter}: \"{unc}\" /persistent:yes{user_arg}")
}

/// Build a `net use /delete` command-line string.
fn net_use_delete_cmd(letter: &str) -> String {
    format!("net use {letter}: /delete /y")
}

pub fn default_remote_connection_config() -> RemoteConnectionConfig {
    RemoteConnectionConfig::default()
}

/// Check whether the Tailscale CLI is available locally.
pub fn tailscale_available() -> bool {
    if run_with_utf8("tailscale status")
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return true;
    }
    #[cfg(windows)]
    {
        Command::new("where")
            .arg("tailscale.exe")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Get the Tailscale IP of this machine, if available.
pub fn tailscale_ip() -> Option<String> {
    let output = run_with_utf8("tailscale ip -4").ok()?;
    if output.status.success() {
        let ip = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !ip.is_empty() {
            return Some(ip);
        }
    }
    None
}

/// Build the UNC path from config.
pub fn unc_path(config: &RemoteConnectionConfig) -> String {
    if config.remote_host.is_empty() {
        return String::new();
    }
    format!(
        "\\\\{}\\{}",
        config.remote_host.trim(),
        config.share_name.trim()
    )
}

/// Build the local path for the mapped drive letter.
pub fn local_path(config: &RemoteConnectionConfig) -> String {
    let letter = config.local_drive_letter.trim().trim_end_matches(':');
    format!("{}:\\", letter)
}

/// Build the workspace root (local path + optional remote root subdirectory).
pub fn workspace_root(config: &RemoteConnectionConfig) -> String {
    let local = local_path(config);
    let remote_root = config.remote_root.trim().trim_matches(&['\\', '/'][..]);
    if remote_root.is_empty() {
        local
    } else {
        PathBuf::from(&local)
            .join(remote_root)
            .to_string_lossy()
            .replace('\\', "/")
    }
}

/// Check whether a drive letter is currently mapped (the path exists).
pub fn drive_mapped(letter: &str) -> bool {
    let path = format!("{}:\\", letter.trim().trim_end_matches(':'));
    Path::new(&path).exists()
}

/// Build the full remote status with checks.
pub fn remote_drive_status(config: &RemoteConnectionConfig) -> RemoteDriveStatus {
    let tailscale_available = tailscale_available();
    let local = local_path(config);
    let unc = unc_path(config);
    let mapped = !unc.is_empty() && drive_mapped(&config.local_drive_letter);
    let ws_root = workspace_root(config);

    let mut checks = Vec::new();

    checks.push(RemoteServerCheck {
        id: "tailscale".to_string(),
        label: "Tailscale".to_string(),
        ok: tailscale_available,
        detail: if tailscale_available {
            tailscale_ip().unwrap_or_else(|| "已安装".to_string())
        } else {
            "未检测到 Tailscale，请在两端安装并登录同一账号".to_string()
        },
        severity: if tailscale_available {
            "ok".to_string()
        } else {
            "warn".to_string()
        },
    });

    checks.push(RemoteServerCheck {
        id: "remoteHost".to_string(),
        label: "远程主机".to_string(),
        ok: !config.remote_host.trim().is_empty(),
        detail: if config.remote_host.trim().is_empty() {
            "请填写远程 Tailscale IP".to_string()
        } else {
            config.remote_host.clone()
        },
        severity: if config.remote_host.trim().is_empty() {
            "warn".to_string()
        } else {
            "ok".to_string()
        },
    });

    checks.push(RemoteServerCheck {
        id: "shareName".to_string(),
        label: "共享名".to_string(),
        ok: !config.share_name.trim().is_empty(),
        detail: if config.share_name.trim().is_empty() {
            "请填写共享名".to_string()
        } else {
            config.share_name.clone()
        },
        severity: "warn".to_string(),
    });

    checks.push(RemoteServerCheck {
        id: "driveMapping".to_string(),
        label: "映射盘符".to_string(),
        ok: mapped,
        detail: if mapped {
            format!("{} → {} ✓", local, unc)
        } else if unc.is_empty() {
            "等待配置".to_string()
        } else {
            format!("{} 未映射，请执行映射", local)
        },
        severity: if mapped {
            "ok".to_string()
        } else {
            "warn".to_string()
        },
    });

    checks.push(RemoteServerCheck {
        id: "workspaceRoot".to_string(),
        label: "工作区根目录".to_string(),
        ok: mapped && Path::new(&ws_root).exists(),
        detail: if Path::new(&ws_root).exists() {
            ws_root.clone()
        } else if mapped {
            format!("{} 不存在（可能需要创建或调整 remote_root）", ws_root)
        } else {
            "盘符未映射".to_string()
        },
        severity: if Path::new(&ws_root).exists() {
            "ok".to_string()
        } else {
            "warn".to_string()
        },
    });

    RemoteDriveStatus {
        config: config.clone(),
        tailscale_available,
        drive_mapped: mapped,
        unc_path: unc,
        local_path: local,
        workspace_root: ws_root,
        checks,
    }
}

/// Execute `net use` to map a remote SMB share to a local drive letter.
pub fn map_remote_drive(config: &RemoteConnectionConfig) -> RemoteMapResult {
    let letter = config
        .local_drive_letter
        .trim()
        .trim_end_matches(':')
        .to_string();
    let unc = unc_path(config);
    let local = format!("{}:", letter);

    if unc.is_empty() {
        return RemoteMapResult {
            success: false,
            drive_letter: local,
            unc_path: unc,
            error: Some("远程主机地址为空，请先填写 Tailscale IP".to_string()),
        };
    }

    // Try to unmap first (ignore errors)
    let _ = run_with_utf8(&net_use_delete_cmd(&letter));

    // Map the drive via cmd /c with chcp 65001 for correct Chinese output
    let script = net_use_map_cmd(&letter, &unc, &config.username);
    match run_with_utf8(&script) {
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );

            if output.status.success() {
                RemoteMapResult {
                    success: true,
                    drive_letter: local,
                    unc_path: unc,
                    error: None,
                }
            } else {
                RemoteMapResult {
                    success: false,
                    drive_letter: local,
                    unc_path: unc,
                    error: Some(extract_net_use_error(&combined)),
                }
            }
        }
        Err(e) => RemoteMapResult {
            success: false,
            drive_letter: local,
            unc_path: unc,
            error: Some(format!("执行 net use 失败: {}", e)),
        },
    }
}

/// Execute `net use /delete` to unmap a drive.
pub fn unmap_remote_drive(letter: &str) -> RemoteMapResult {
    let letter = letter.trim().trim_end_matches(':').to_string();
    let local = format!("{}:", letter);
    let script = net_use_delete_cmd(&letter);

    match run_with_utf8(&script) {
        Ok(output) => {
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let success = output.status.success()
                || combined.to_lowercase().contains("deleted")
                || combined.to_lowercase().contains("not found")
                || combined.contains("找不到")
                || combined.contains("已删除");
            RemoteMapResult {
                success,
                drive_letter: local,
                unc_path: String::new(),
                error: if success {
                    None
                } else {
                    Some(combined.trim().to_string())
                },
            }
        }
        Err(e) => RemoteMapResult {
            success: false,
            drive_letter: local,
            unc_path: String::new(),
            error: Some(format!("执行 net use /delete 失败: {}", e)),
        },
    }
}

/// Generate a PowerShell mapping script snippet (for user to copy or save).
pub fn map_script(config: &RemoteConnectionConfig) -> String {
    let unc = unc_path(config);
    let letter = config.local_drive_letter.trim().trim_end_matches(':');
    let user = config.username.trim();

    let user_arg = if user.is_empty() {
        String::new()
    } else {
        format!(" /user:{user}")
    };

    format!(r#"net use "{letter}:" "{unc}" /persistent:yes{user_arg}"#)
}

/// Generate a verification script snippet.
pub fn verify_script(config: &RemoteConnectionConfig) -> String {
    let local = local_path(config);
    let ws_root = workspace_root(config);

    format!(
        r#"$driveOk = Test-Path "{local}"
$rootOk = Test-Path "{ws_root}"
if ($driveOk) {{ Write-Host "OK - 映射盘可用: {local}" }} else {{ Write-Host "FAIL - 映射盘不可用: {local}" }}
if ($rootOk) {{ Write-Host "OK - 工作区可用: {ws_root}" }} else {{ Write-Host "WARN - 工作区不存在: {ws_root}" }}
if (-not ($driveOk -and $rootOk)) {{ exit 1 }}"#
    )
}

fn extract_net_use_error(output: &str) -> String {
    // Pick out the most useful error line from net use output.
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if lower.contains("error")
            || lower.contains("access denied")
            || lower.contains("not found")
            || lower.contains("password")
            || lower.contains("failed")
            || lower.contains("cannot")
            || lower.contains("already")
        {
            return trimmed.to_string();
        }
    }
    // Fallback: return the last non-empty line.
    output
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .map(|l| l.trim().to_string())
        .unwrap_or_else(|| "未知错误".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_sensible_defaults() {
        let config = RemoteConnectionConfig::default();
        assert!(config.remote_host.is_empty());
        assert_eq!(config.share_name, "Projects");
        assert_eq!(config.local_drive_letter, "S");
    }

    #[test]
    fn unc_path_formats_correctly() {
        let config = RemoteConnectionConfig {
            remote_host: "100.123.45.67".to_string(),
            share_name: "MyShare".to_string(),
            ..RemoteConnectionConfig::default()
        };
        assert_eq!(unc_path(&config), r"\\100.123.45.67\MyShare");
    }

    #[test]
    fn local_path_formats_with_trailing_slash() {
        let config = RemoteConnectionConfig {
            local_drive_letter: "X".to_string(),
            ..RemoteConnectionConfig::default()
        };
        assert_eq!(local_path(&config), r"X:\");
    }

    #[test]
    fn local_path_strips_colon() {
        let config = RemoteConnectionConfig {
            local_drive_letter: "X:".to_string(),
            ..RemoteConnectionConfig::default()
        };
        assert_eq!(local_path(&config), r"X:\");
    }

    #[test]
    fn workspace_root_with_subdirectory() {
        let config = RemoteConnectionConfig {
            local_drive_letter: "S".to_string(),
            remote_root: "projects/demo".to_string(),
            ..RemoteConnectionConfig::default()
        };
        assert_eq!(workspace_root(&config), "S:/projects/demo");
    }

    #[test]
    fn status_reports_tailscale_unavailable() {
        let config = RemoteConnectionConfig::default();
        let status = remote_drive_status(&config);
        // Tailscale may or may not be installed on the test machine;
        // we just verify the status struct is populated.
        assert!(status.checks.iter().any(|c| c.id == "tailscale"));
        assert!(status.checks.iter().any(|c| c.id == "driveMapping"));
    }

    #[test]
    fn map_script_includes_user_when_provided() {
        let config = RemoteConnectionConfig {
            remote_host: "100.1.2.3".to_string(),
            share_name: "Data".to_string(),
            local_drive_letter: "Z".to_string(),
            username: "admin".to_string(),
            ..RemoteConnectionConfig::default()
        };
        let script = map_script(&config);
        assert!(script.contains(r"\\100.1.2.3\Data"));
        assert!(script.contains("Z:"));
        assert!(script.contains("/user:admin"));
    }

    #[test]
    fn map_script_omits_user_when_empty() {
        let config = RemoteConnectionConfig {
            remote_host: "100.1.2.3".to_string(),
            share_name: "Data".to_string(),
            local_drive_letter: "Z".to_string(),
            ..RemoteConnectionConfig::default()
        };
        let script = map_script(&config);
        assert!(!script.contains("/user:"));
    }
}
