//! Read-only GitHub account status through the GitHub CLI. SuperHigh never
//! reads or stores the token itself; `gh` owns the credential.

use std::{
    env,
    path::PathBuf,
    process::{Command, Output},
};

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubAccountStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub login: Option<String>,
    pub host: String,
    pub token_source: Option<String>,
    pub home_directory: Option<String>,
    pub error: Option<String>,
}

fn gh_command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    command
}

fn gh_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(program_files) = env::var_os("ProgramFiles") {
        candidates.push(
            PathBuf::from(program_files)
                .join("GitHub CLI")
                .join("gh.exe"),
        );
    }
    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
        candidates.push(
            PathBuf::from(program_files_x86)
                .join("GitHub CLI")
                .join("gh.exe"),
        );
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("GitHubCLI")
                .join("gh.exe"),
        );
    }
    candidates
}

pub(crate) fn run_gh(program: &str, args: &[&str]) -> Result<Output> {
    gh_command(program, args)
        .output()
        .with_context(|| format!("无法启动 GitHub CLI：{program}"))
}

pub(crate) fn resolve_gh() -> Option<String> {
    let path_candidate = if cfg!(windows) { "gh.exe" } else { "gh" };
    if gh_works(path_candidate) {
        return Some(path_candidate.to_string());
    }
    for candidate in gh_candidates() {
        let Some(candidate) = candidate.to_str() else {
            continue;
        };
        if gh_works(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

fn gh_works(program: &str) -> bool {
    run_gh(program, &["--version"])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn home_directory() -> Option<String> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(|value| value.to_string_lossy().into_owned())
}

pub(crate) fn summarize_stderr(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        "GitHub CLI 返回了错误状态".to_string()
    } else {
        stderr.chars().take(400).collect()
    }
}

fn parse_auth_status(output: &[u8]) -> Result<GitHubAccountStatus> {
    let value: serde_json::Value =
        serde_json::from_slice(output).context("无法解析 GitHub CLI 登录状态")?;
    let accounts = value
        .get("hosts")
        .and_then(|hosts| hosts.get("github.com"))
        .and_then(|host| host.as_array());
    let account = accounts.and_then(|list| {
        list.iter()
            .find(|item| item.get("active").and_then(|active| active.as_bool()) == Some(true))
            .or_else(|| list.first())
    });
    let login = account
        .and_then(|item| item.get("login"))
        .and_then(|login| login.as_str())
        .filter(|login| !login.is_empty())
        .map(str::to_string);
    let state = account
        .and_then(|item| item.get("state"))
        .and_then(|state| state.as_str())
        .unwrap_or("failed");
    let token_source = account
        .and_then(|item| item.get("tokenSource"))
        .and_then(|source| source.as_str())
        .map(str::to_string);
    Ok(GitHubAccountStatus {
        installed: true,
        authenticated: state == "success" && login.is_some(),
        login,
        host: "github.com".to_string(),
        token_source,
        home_directory: home_directory(),
        error: None,
    })
}

fn github_account_status() -> Result<GitHubAccountStatus> {
    let Some(program) = resolve_gh() else {
        return Ok(GitHubAccountStatus {
            installed: false,
            authenticated: false,
            login: None,
            host: "github.com".to_string(),
            token_source: None,
            home_directory: home_directory(),
            error: Some("未检测到 GitHub CLI".to_string()),
        });
    };
    let output = run_gh(&program, &["auth", "status", "--json", "hosts"])?;
    if !output.status.success() {
        return Ok(GitHubAccountStatus {
            installed: true,
            authenticated: false,
            login: None,
            host: "github.com".to_string(),
            token_source: None,
            home_directory: home_directory(),
            error: Some(summarize_stderr(&output)),
        });
    }
    match parse_auth_status(&output.stdout) {
        Ok(status) => Ok(status),
        Err(error) => Ok(GitHubAccountStatus {
            installed: true,
            authenticated: false,
            login: None,
            host: "github.com".to_string(),
            token_source: None,
            home_directory: home_directory(),
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
pub async fn github_account_status_command() -> Result<GitHubAccountStatus, String> {
    tauri::async_runtime::spawn_blocking(github_account_status)
        .await
        .map_err(|error| format!("GitHub 状态查询被中断：{error}"))?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_active_account() {
        let json = br#"{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com","login":"octocat","tokenSource":"keyring"}]}}"#;
        let status = parse_auth_status(json).unwrap();
        assert!(status.installed);
        assert!(status.authenticated);
        assert_eq!(status.login.as_deref(), Some("octocat"));
        assert_eq!(status.token_source.as_deref(), Some("keyring"));
        assert_eq!(status.host, "github.com");
    }

    #[test]
    fn parses_empty_hosts_as_logged_out() {
        let status = parse_auth_status(br#"{"hosts":{}}"#).unwrap();
        assert!(status.installed);
        assert!(!status.authenticated);
        assert!(status.login.is_none());
    }

    #[test]
    fn parses_failed_account_as_logged_out() {
        let json = br#"{"hosts":{"github.com":[{"state":"failed","active":false,"host":"github.com","login":"octocat"}]}}"#;
        let status = parse_auth_status(json).unwrap();
        assert!(!status.authenticated);
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_auth_status(b"not json").is_err());
    }
}
