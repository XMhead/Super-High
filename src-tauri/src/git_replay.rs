//! Git commit replay through gitlogue. Lists the signed-in account's GitHub
//! repositories via `gh`, keeps one no-checkout clone per repository in the app
//! data cache, and runs gitlogue in a registered PTY session. Read-only: the
//! cache only clones and fetches; nothing is committed or pushed.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::github_account::{resolve_gh, run_gh, summarize_stderr};
use crate::models::TerminalSessionDto;
use crate::terminal::{find_program, TerminalManager};

pub const PROVIDER_KIND: &str = "git-replay";
const INSTALL_COMMAND: &str = "cargo install gitlogue --locked";
const REPO_LIST_LIMIT: &str = "200";
const REPO_LIST_FIELDS: &str = "nameWithOwner,description,isPrivate,isFork,isArchived,isEmpty,pushedAt";
const IGNORED_PATTERNS: &[&str] = &["*.lock", "package-lock.json", "pnpm-lock.yaml", "npm-shrinkwrap.json"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepoSummary {
    pub name_with_owner: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default)]
    pub is_fork: bool,
    #[serde(default)]
    pub is_archived: bool,
    #[serde(default)]
    pub is_empty: bool,
    #[serde(default)]
    pub pushed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReplayStatus {
    pub installed: bool,
    pub program_path: Option<String>,
    pub install_command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReplayTarget {
    pub repo_path: String,
    /// `workspace` reuses the open project; `cache` is SuperHigh's own clone.
    pub source: String,
    pub name_with_owner: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReplayOptions {
    pub order: Option<String>,
    pub speed: Option<u32>,
    pub author: Option<String>,
}

fn parse_repo_list(output: &[u8]) -> Result<Vec<GitHubRepoSummary>> {
    let mut repos: Vec<GitHubRepoSummary> =
        serde_json::from_slice(output).context("无法解析 GitHub 仓库列表")?;
    for repo in &mut repos {
        if repo.description.as_deref().is_some_and(|text| text.trim().is_empty()) {
            repo.description = None;
        }
    }
    // ISO 8601 timestamps sort lexicographically; most recently pushed first.
    repos.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at));
    Ok(repos)
}

fn list_github_repos() -> Result<Vec<GitHubRepoSummary>> {
    let program = resolve_gh().context("未检测到 GitHub CLI，请先在“设置 > 账户”完成 GitHub 登录")?;
    let output = run_gh(
        &program,
        &["repo", "list", "--limit", REPO_LIST_LIMIT, "--json", REPO_LIST_FIELDS],
    )?;
    if !output.status.success() {
        bail!("读取 GitHub 仓库失败：{}", summarize_stderr(&output));
    }
    parse_repo_list(&output.stdout)
}

fn validate_name_with_owner(value: &str) -> Result<(String, String)> {
    let value = value.trim();
    let (owner, name) = value.split_once('/').context("仓库名需要 owner/name 格式")?;
    let valid = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part.starts_with('-')
            && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    };
    ensure!(valid(owner) && valid(name), "无效的仓库名：{value}");
    Ok((owner.to_string(), name.to_string()))
}

/// Returns lowercase `owner/name` for a github.com remote URL.
fn parse_github_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url.strip_prefix("git@github.com:") {
        rest
    } else {
        let without_scheme = ["https://", "http://", "ssh://", "git://"]
            .iter()
            .find_map(|scheme| url.strip_prefix(scheme))?;
        let (authority, path) = without_scheme.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
        let host = host.split(':').next()?;
        if !host.eq_ignore_ascii_case("github.com") {
            return None;
        }
        path
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(format!("{owner}/{name}").to_ascii_lowercase())
}

fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .with_context(|| format!("无法启动 git（参数：{}）", args.join(" ")))?;
    if !output.status.success() {
        let stderr: String = String::from_utf8_lossy(&output.stderr).trim().chars().take(400).collect();
        bail!(
            "git {} 失败：{}",
            args.first().copied().unwrap_or(""),
            if stderr.is_empty() { "未知错误" } else { &stderr }
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn ensure_has_commits(repo: &Path) -> Result<()> {
    git(repo, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        .map(|_| ())
        .context("仓库还没有提交，无法回放")
}

fn workspace_repo_root(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute() && path.is_dir(), "项目目录不存在：{}", path.display());
    let top = git(path, &["rev-parse", "--show-toplevel"]).context("当前项目不是 Git 仓库")?;
    let root = PathBuf::from(top);
    // gitlogue locates the repository by walking up to a `.git` entry.
    ensure!(root.join(".git").exists(), "gitlogue 需要带 .git 的仓库目录：{}", root.display());
    ensure_has_commits(&root)?;
    Ok(root)
}

fn workspace_remote_matches(root: &Path, key: &str) -> bool {
    git(root, &["remote", "-v"])
        .map(|remotes| {
            remotes.lines().any(|line| {
                line.split_whitespace().nth(1).and_then(parse_github_remote).as_deref() == Some(key)
            })
        })
        .unwrap_or(false)
}

fn sync_cached_clone(cache_root: &Path, owner: &str, name: &str) -> Result<PathBuf> {
    let owner_dir = cache_root.join(owner);
    let target = owner_dir.join(name);
    if target.join(".git").is_dir() {
        // No working tree is checked out, so moving the current branch is safe.
        git(&target, &["fetch", "--prune", "--update-head-ok", "origin", "+refs/heads/*:refs/heads/*"])
            .with_context(|| format!("更新 {owner}/{name} 失败"))?;
        return Ok(target);
    }
    fs::create_dir_all(&owner_dir)
        .with_context(|| format!("无法创建回放缓存目录：{}", owner_dir.display()))?;
    if target.exists() {
        fs::remove_dir_all(&target).with_context(|| format!("无法清理不完整的缓存：{}", target.display()))?;
    }
    let staging = owner_dir.join(format!(".{name}.cloning"));
    if staging.exists() {
        fs::remove_dir_all(&staging).with_context(|| format!("无法清理上次未完成的克隆：{}", staging.display()))?;
    }
    let url = format!("https://github.com/{owner}/{name}.git");
    let staging_arg = staging.to_string_lossy().into_owned();
    if let Err(error) = git(&owner_dir, &["clone", "--no-checkout", "--quiet", &url, &staging_arg]) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error.context(format!("克隆 {owner}/{name} 失败")));
    }
    fs::rename(&staging, &target).with_context(|| format!("无法写入回放缓存：{}", target.display()))?;
    Ok(target)
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn prepare_replay(
    cache_root: &Path,
    name_with_owner: Option<&str>,
    workspace_path: Option<&str>,
) -> Result<GitReplayTarget> {
    let workspace = workspace_path.map(str::trim).filter(|path| !path.is_empty()).map(PathBuf::from);
    let Some(name_with_owner) = name_with_owner.map(str::trim).filter(|value| !value.is_empty()) else {
        let root = workspace_repo_root(&workspace.context("缺少要回放的仓库")?)?;
        return Ok(GitReplayTarget { repo_path: display_path(&root), source: "workspace".into(), name_with_owner: None });
    };
    let (owner, name) = validate_name_with_owner(name_with_owner)?;
    let full_name = format!("{owner}/{name}");
    // The open project may hold local-only commits, so prefer it over a fresh clone.
    if let Some(root) = workspace.and_then(|path| workspace_repo_root(&path).ok()) {
        if workspace_remote_matches(&root, &full_name.to_ascii_lowercase()) {
            return Ok(GitReplayTarget { repo_path: display_path(&root), source: "workspace".into(), name_with_owner: Some(full_name) });
        }
    }
    let path = sync_cached_clone(cache_root, &owner, &name)?;
    ensure_has_commits(&path)?;
    Ok(GitReplayTarget { repo_path: display_path(&path), source: "cache".into(), name_with_owner: Some(full_name) })
}

fn replay_args(repo: &Path, options: &GitReplayOptions) -> Result<Vec<String>> {
    let order = options.order.as_deref().unwrap_or("asc");
    ensure!(matches!(order, "asc" | "desc" | "random"), "不支持的回放顺序：{order}");
    let speed = options.speed.unwrap_or(30).clamp(1, 500);
    let mut args = vec![
        "--path".to_string(),
        repo.to_string_lossy().into_owned(),
        "--order".to_string(),
        order.to_string(),
        "--speed".to_string(),
        speed.to_string(),
    ];
    if let Some(author) = options.author.as_deref().map(str::trim).filter(|author| !author.is_empty()) {
        ensure!(author.chars().count() <= 100 && !author.chars().any(char::is_control), "作者筛选无效");
        // `=` keeps a value that starts with `-` from being parsed as a flag.
        args.push(format!("--author={author}"));
    }
    for pattern in IGNORED_PATTERNS {
        args.push("--ignore".to_string());
        args.push((*pattern).to_string());
    }
    Ok(args)
}

pub fn start_replay(
    app: &AppHandle,
    terminal: &TerminalManager,
    workspace_id: Option<String>,
    repo_path: &str,
    options: &GitReplayOptions,
) -> Result<TerminalSessionDto> {
    let program = find_program("gitlogue")
        .with_context(|| format!("未检测到 gitlogue，请先运行 `{INSTALL_COMMAND}` 安装"))?;
    let repo = PathBuf::from(repo_path.trim());
    ensure!(repo.is_absolute() && repo.join(".git").exists(), "不是可回放的 Git 仓库：{repo_path}");
    let args = replay_args(&repo, options)?;
    terminal.create_program_session(app, workspace_id, PROVIDER_KIND, "Git 回放", &program, &args, &repo)
}

#[tauri::command]
pub async fn github_repo_list_command() -> Result<Vec<GitHubRepoSummary>, String> {
    tauri::async_runtime::spawn_blocking(list_github_repos)
        .await
        .map_err(|error| format!("GitHub 仓库查询被中断：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_replay_status_command() -> Result<GitReplayStatus, String> {
    let program = tauri::async_runtime::spawn_blocking(|| find_program("gitlogue"))
        .await
        .map_err(|error| error.to_string())?;
    Ok(GitReplayStatus {
        installed: program.is_some(),
        program_path: program.as_deref().map(display_path),
        install_command: INSTALL_COMMAND.to_string(),
    })
}

#[tauri::command]
pub async fn git_replay_prepare_command(
    app: AppHandle,
    name_with_owner: Option<String>,
    workspace_path: Option<String>,
) -> Result<GitReplayTarget, String> {
    let cache_root = crate::db::app_data_dir(&app).map_err(|error| error.to_string())?.join("git-replay");
    tauri::async_runtime::spawn_blocking(move || {
        prepare_replay(&cache_root, name_with_owner.as_deref(), workspace_path.as_deref())
    })
    .await
    .map_err(|error| format!("仓库准备被中断：{error}"))?
    .map_err(|error| format!("{error:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_sorts_repo_list() {
        let json = br#"[
            {"nameWithOwner":"me/old","description":"","isPrivate":false,"isFork":false,"isArchived":false,"isEmpty":false,"pushedAt":"2026-01-01T00:00:00Z"},
            {"nameWithOwner":"me/new","description":"Fresh","isPrivate":true,"isFork":false,"isArchived":false,"isEmpty":false,"pushedAt":"2026-10-01T00:00:00Z"}
        ]"#;
        let repos = parse_repo_list(json).unwrap();
        assert_eq!(repos[0].name_with_owner, "me/new");
        assert!(repos[0].is_private);
        assert_eq!(repos[1].description, None);
    }

    #[test]
    fn rejects_malformed_repo_list() {
        assert!(parse_repo_list(b"not json").is_err());
    }

    #[test]
    fn validates_name_with_owner() {
        assert_eq!(
            validate_name_with_owner("XMhead/Super-High").unwrap(),
            ("XMhead".to_string(), "Super-High".to_string())
        );
        assert!(validate_name_with_owner("XMhead").is_err());
        assert!(validate_name_with_owner("XMhead/..").is_err());
        assert!(validate_name_with_owner("a/b/c").is_err());
        assert!(validate_name_with_owner("-x/repo").is_err());
        assert!(validate_name_with_owner("me/re po").is_err());
    }

    #[test]
    fn parses_github_remote_forms() {
        let key = Some("xmhead/super-high".to_string());
        assert_eq!(parse_github_remote("https://github.com/XMhead/Super-High.git"), key);
        assert_eq!(parse_github_remote("https://user@github.com/XMhead/Super-High"), key);
        assert_eq!(parse_github_remote("git@github.com:XMhead/Super-High.git"), key);
        assert_eq!(parse_github_remote("ssh://git@github.com:22/XMhead/Super-High.git"), key);
        assert_eq!(parse_github_remote("https://gitlab.com/XMhead/Super-High.git"), None);
        assert_eq!(parse_github_remote("https://github.com/XMhead"), None);
    }

    #[test]
    fn builds_replay_args() {
        let options = GitReplayOptions { order: Some("desc".into()), speed: Some(9999), author: Some(" -me ".into()) };
        let args = replay_args(Path::new("D:/repo"), &options).unwrap();
        assert_eq!(&args[..6], ["--path", "D:/repo", "--order", "desc", "--speed", "500"]);
        assert!(args.contains(&"--author=-me".to_string()));
        assert!(args.windows(2).any(|pair| pair == ["--ignore", "*.lock"]));
        let defaults = replay_args(Path::new("D:/repo"), &GitReplayOptions::default()).unwrap();
        assert!(defaults.iter().all(|arg| !arg.starts_with("--author")));
        assert_eq!(defaults[3], "asc");
    }

    #[test]
    fn rejects_unknown_order_and_control_chars() {
        let bad_order = GitReplayOptions { order: Some("sideways".into()), ..Default::default() };
        assert!(replay_args(Path::new("D:/repo"), &bad_order).is_err());
        let bad_author = GitReplayOptions { author: Some("a\nb".into()), ..Default::default() };
        assert!(replay_args(Path::new("D:/repo"), &bad_author).is_err());
    }
}
