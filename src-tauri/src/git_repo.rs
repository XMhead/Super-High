//! Read-only Git data for the workspace Git view. All commands invoke the
//! system `git` binary with fixed arguments and never touch the network.

use std::{
    collections::HashMap,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use anyhow::{bail, ensure, Context, Result};
use serde::Serialize;

const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitStatusFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub index_status: String,
    pub worktree_status: String,
    pub untracked: bool,
    /// 相对 HEAD 的增删行数；未跟踪、二进制或无 HEAD 时为空。
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub subject: String,
    pub refs: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    /// 二进制文件为空。
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetail {
    pub commit: GitCommit,
    /// 提交说明中标题行之后的正文。
    pub body: String,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub path: String,
    pub old_text: String,
    pub new_text: String,
    pub binary: bool,
    pub truncated: bool,
    pub too_large: bool,
}

fn validated_project(project_path: &str) -> Result<PathBuf> {
    let path = PathBuf::from(project_path);
    ensure!(path.is_absolute(), "项目路径不是绝对路径：{project_path}");
    ensure!(path.is_dir(), "项目目录不存在：{project_path}");
    Ok(path)
}

fn git_command(repo: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(repo)
        .args([
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "i18n.logOutputEncoding=utf-8",
            "--no-pager",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat");
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

fn validate_hash(hash: &str) -> Result<()> {
    let hash = hash.trim();
    ensure!(
        (4..=64).contains(&hash.len()) && hash.chars().all(|ch| ch.is_ascii_hexdigit()),
        "无效的提交哈希：{hash}"
    );
    Ok(())
}

fn validate_relative_path(path: &str) -> Result<()> {
    ensure!(!path.trim().is_empty(), "缺少文件路径");
    ensure!(!path.contains(['\n', '\r']), "文件路径含有换行：{path}");
    let candidate = Path::new(path);
    ensure!(!candidate.is_absolute(), "文件路径必须是仓库相对路径：{path}");
    ensure!(
        !candidate.components().any(|component| matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )),
        "文件路径含有非法跳转：{path}"
    );
    Ok(())
}

fn run_git(repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = git_command(repo, args)
        .output()
        .with_context(|| format!("无法启动 git（参数：{}）", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() { stderr } else { stdout };
        bail!(
            "git {} 失败：{}",
            args.first().copied().unwrap_or(""),
            if detail.is_empty() { "未知错误" } else { &detail }
        );
    }
    Ok(output.stdout)
}

/// 工作区到仓库根目录的映射。每次差异请求都要定位仓库根，缓存后省去一次 git 进程（Windows 上约 30ms）。
fn repo_root_cache() -> &'static Mutex<HashMap<PathBuf, PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn repo_root(repo: &Path) -> Result<PathBuf> {
    if let Some(root) = repo_root_cache().lock().ok().and_then(|cache| cache.get(repo).cloned()) {
        if root.join(".git").exists() {
            return Ok(root);
        }
    }
    let root = resolve_repo_root(repo)?;
    if let Ok(mut cache) = repo_root_cache().lock() {
        cache.insert(repo.to_path_buf(), root.clone());
    }
    Ok(root)
}

fn resolve_repo_root(repo: &Path) -> Result<PathBuf> {
    let output = match run_git(repo, &["rev-parse", "--show-toplevel"]) {
        Ok(output) => output,
        Err(error) if error.to_string().contains("not a git repository") => {
            bail!("当前工作区不是 Git 仓库")
        }
        Err(error) => return Err(error.context("无法读取 Git 仓库根目录")),
    };
    let root = String::from_utf8_lossy(&output).trim().to_string();
    ensure!(!root.is_empty(), "当前工作区不是 Git 仓库");
    Ok(PathBuf::from(root))
}

fn has_head(root: &Path) -> bool {
    git_command(root, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn text_from_bytes(bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_TEXT_BYTES;
    let slice = if truncated {
        let end = match std::str::from_utf8(&bytes[..MAX_TEXT_BYTES]) {
            Ok(_) => MAX_TEXT_BYTES,
            Err(error) => error.valid_up_to(),
        };
        &bytes[..end]
    } else {
        &bytes[..]
    };
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

fn status_label(index: char, worktree: char, untracked: bool) -> String {
    if untracked {
        return "?".to_string();
    }
    if index == 'U' || worktree == 'U' {
        return "U".to_string();
    }
    if index == 'R' || worktree == 'R' {
        return "R".to_string();
    }
    if index == 'C' || worktree == 'C' {
        return "C".to_string();
    }
    if index == 'D' || worktree == 'D' {
        return "D".to_string();
    }
    if index == 'A' {
        return "A".to_string();
    }
    if index == 'M' || worktree == 'M' || index == 'T' || worktree == 'T' {
        return "M".to_string();
    }
    "?".to_string()
}

fn parse_status_v2(output: &[u8]) -> GitStatus {
    let mut status = GitStatus {
        repo_root: String::new(),
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        files: Vec::new(),
    };
    let mut fields = output.split(|byte| *byte == 0).map(String::from_utf8_lossy);
    while let Some(field) = fields.next() {
        if field.is_empty() {
            continue;
        }
        if let Some(value) = field.strip_prefix("# branch.head ") {
            if value != "(detached)" {
                status.branch = Some(value.to_string());
            }
            continue;
        }
        if let Some(value) = field.strip_prefix("# branch.upstream ") {
            status.upstream = Some(value.to_string());
            continue;
        }
        if let Some(value) = field.strip_prefix("# branch.ab ") {
            let mut parts = value.split_whitespace();
            if let Some(ahead) = parts.next().and_then(|part| part.strip_prefix('+')) {
                status.ahead = ahead.parse().unwrap_or(0);
            }
            if let Some(behind) = parts.next().and_then(|part| part.strip_prefix('-')) {
                status.behind = behind.parse().unwrap_or(0);
            }
            continue;
        }
        if let Some(path) = field.strip_prefix("? ") {
            status.files.push(GitStatusFile {
                path: path.to_string(),
                old_path: None,
                status: "?".to_string(),
                index_status: "?".to_string(),
                worktree_status: "?".to_string(),
                untracked: true,
                additions: None,
                deletions: None,
            });
            continue;
        }
        if field.starts_with("! ") || field.starts_with("# ") {
            continue;
        }
        if let Some(rest) = field.strip_prefix("1 ") {
            if let Some(file) = parse_v2_entry(rest, None, 6) {
                status.files.push(file);
            }
            continue;
        }
        if let Some(rest) = field.strip_prefix("2 ") {
            let old_path = fields.next().map(|value| value.to_string());
            if let Some(file) = parse_v2_entry(rest, old_path, 7) {
                status.files.push(file);
            }
            continue;
        }
        if let Some(rest) = field.strip_prefix("u ") {
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("UU");
            let mut chars = xy.chars();
            let index = chars.next().unwrap_or('U');
            let worktree = chars.next().unwrap_or('U');
            for _ in 0..8 {
                parts.next();
            }
            let path = parts.next().unwrap_or("").to_string();
            if !path.is_empty() {
                status.files.push(GitStatusFile {
                    path,
                    old_path: None,
                    status: status_label(index, worktree, false),
                    index_status: index.to_string(),
                    worktree_status: worktree.to_string(),
                    untracked: false,
                    additions: None,
                    deletions: None,
                });
            }
        }
    }
    status
}

fn parse_v2_entry(rest: &str, old_path: Option<String>, metadata_fields: usize) -> Option<GitStatusFile> {
    let mut parts = rest.splitn(metadata_fields + 2, ' ');
    let xy = parts.next()?;
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    for _ in 0..metadata_fields {
        parts.next()?;
    }
    let path = parts.next()?.to_string();
    if path.is_empty() {
        return None;
    }
    Some(GitStatusFile {
        path,
        old_path,
        status: status_label(index, worktree, false),
        index_status: index.to_string(),
        worktree_status: worktree.to_string(),
        untracked: false,
        additions: None,
        deletions: None,
    })
}

fn parse_log(output: &[u8]) -> Vec<GitCommit> {
    output
        .split(|byte| *byte == 0x1e)
        .filter_map(|record| {
            let record = record.strip_prefix(b"\n").unwrap_or(record);
            if record.is_empty() {
                return None;
            }
            let fields: Vec<String> = record
                .split(|byte| *byte == 0)
                .map(|field| String::from_utf8_lossy(field).into_owned())
                .collect();
            if fields.len() < 8 {
                return None;
            }
            Some(GitCommit {
                hash: fields[0].clone(),
                short_hash: fields[1].clone(),
                author: fields[2].clone(),
                email: fields[3].clone(),
                timestamp: fields[4].parse().unwrap_or(0),
                parents: if fields[5].trim().is_empty() {
                    Vec::new()
                } else {
                    fields[5].split_whitespace().map(str::to_string).collect()
                },
                subject: fields[6].clone(),
                refs: fields[7].trim().to_string(),
            })
        })
        .collect()
}

type LineStats = HashMap<String, (Option<u32>, Option<u32>)>;

/// 解析 `--raw --numstat -z` 的合并输出：raw 记录以 `:` 开头给出状态与路径，
/// numstat 记录给出增删行数（二进制为 `-`）。只含 numstat 时 files 为空。
fn parse_raw_numstat(output: &[u8]) -> (Vec<GitCommitFile>, LineStats) {
    let mut files = Vec::new();
    let mut stats = LineStats::new();
    let mut fields = output
        .split(|byte| *byte == 0)
        .map(|field| String::from_utf8_lossy(field).into_owned());
    while let Some(field) = fields.next() {
        let field = field.trim_start_matches('\n');
        if field.is_empty() {
            continue;
        }
        if let Some(raw) = field.strip_prefix(':') {
            let label = raw
                .split_whitespace()
                .nth(4)
                .and_then(|value| value.chars().next())
                .unwrap_or('M')
                .to_string();
            let (old_path, path) = if label == "R" || label == "C" {
                let old_path = fields.next().unwrap_or_default();
                (Some(old_path).filter(|value| !value.is_empty()), fields.next().unwrap_or_default())
            } else {
                (None, fields.next().unwrap_or_default())
            };
            if !path.is_empty() {
                files.push(GitCommitFile {
                    path,
                    old_path,
                    status: label,
                    additions: None,
                    deletions: None,
                });
            }
            continue;
        }
        let mut parts = field.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            // 重命名记录：路径为空，随后依次是旧路径和新路径。
            fields.next();
            fields.next().unwrap_or_default()
        } else {
            path.to_string()
        };
        stats.insert(path, (added.parse().ok(), deleted.parse().ok()));
    }
    for file in &mut files {
        if let Some((additions, deletions)) = stats.get(&file.path) {
            file.additions = *additions;
            file.deletions = *deletions;
        }
    }
    (files, stats)
}

fn git_status(project_path: &str) -> Result<GitStatus> {
    let project = validated_project(project_path)?;
    let root = repo_root(&project)?;
    // 增删行数与状态并行读取；无 HEAD 或失败时只是不显示行数。
    let stats_root = root.clone();
    let stats = std::thread::spawn(move || {
        run_git(&stats_root, &["diff", "--numstat", "-z", "-M", "HEAD", "--"])
            .map(|output| parse_raw_numstat(&output).1)
            .unwrap_or_default()
    });
    let output = run_git(
        &root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
        ],
    )?;
    let mut status = parse_status_v2(&output);
    let stats = stats.join().unwrap_or_default();
    for file in &mut status.files {
        if let Some((additions, deletions)) = stats.get(&file.path) {
            file.additions = *additions;
            file.deletions = *deletions;
        }
    }
    status.repo_root = root.to_string_lossy().into_owned();
    Ok(status)
}

fn git_log(project_path: &str, limit: u32, skip: u32) -> Result<Vec<GitCommit>> {
    let project = validated_project(project_path)?;
    let root = repo_root(&project)?;
    if !has_head(&root) {
        return Ok(Vec::new());
    }
    let count = limit.clamp(1, 500).to_string();
    let skip = skip.to_string();
    let output = run_git(
        &root,
        &[
            "log",
            "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00%D%x1e",
            "-n",
            &count,
            &format!("--skip={skip}"),
            "--",
        ],
    )?;
    Ok(parse_log(&output))
}

fn git_commit_detail(project_path: &str, hash: &str) -> Result<GitCommitDetail> {
    let project = validated_project(project_path)?;
    let root = repo_root(&project)?;
    validate_hash(hash)?;
    let meta = run_git(
        &root,
        &[
            "show",
            "-s",
            "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00%D%x00%b",
            hash,
        ],
    )?;
    let body = meta
        .splitn(9, |byte| *byte == 0)
        .nth(8)
        .map(|value| String::from_utf8_lossy(value).trim().to_string())
        .unwrap_or_default();
    let commits = parse_log(&[meta.as_slice(), &[0x1e]].concat());
    let commit = commits
        .into_iter()
        .next()
        .with_context(|| format!("无法读取提交 {hash}"))?;
    // 合并提交按第一父提交比较，与差异预览的旧版本一致。
    let output = if let Some(parent) = commit.parents.first() {
        run_git(
            &root,
            &["diff", "--raw", "--numstat", "-z", "-M", parent, &commit.hash],
        )?
    } else {
        run_git(
            &root,
            &[
                "diff-tree",
                "--no-commit-id",
                "--raw",
                "--numstat",
                "-r",
                "-M",
                "--root",
                "-z",
                &commit.hash,
            ],
        )?
    };
    let (files, _) = parse_raw_numstat(&output);
    Ok(GitCommitDetail { commit, body, files })
}

/// 用一个 `git cat-file --batch` 进程读取多个对象：不存在的对象返回空内容，
/// 超过上限的对象跳过内容并返回 None。
fn git_blobs(root: &Path, specs: &[String]) -> Result<Vec<Option<Vec<u8>>>> {
    let mut child = git_command(root, &["cat-file", "--batch"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("无法启动 git cat-file")?;
    {
        let mut stdin = child.stdin.take().context("无法写入 git cat-file")?;
        for spec in specs {
            writeln!(stdin, "{spec}")?;
        }
    }
    let stdout = child.stdout.take().context("无法读取 git cat-file")?;
    let mut reader = std::io::BufReader::new(stdout);
    let mut blobs = Vec::with_capacity(specs.len());
    for _ in specs {
        let mut header = Vec::new();
        if std::io::BufRead::read_until(&mut reader, b'\n', &mut header)? == 0 {
            blobs.push(Some(Vec::new()));
            continue;
        }
        let header = String::from_utf8_lossy(&header).trim_end().to_string();
        if header.ends_with(" missing") || header.ends_with(" ambiguous") {
            blobs.push(Some(Vec::new()));
            continue;
        }
        let size = header
            .rsplit(' ')
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        if size > MAX_TEXT_BYTES as u64 {
            std::io::copy(&mut (&mut reader).take(size + 1), &mut std::io::sink())?;
            blobs.push(None);
        } else {
            let mut content = vec![0; size as usize + 1];
            reader.read_exact(&mut content)?;
            content.pop();
            blobs.push(Some(content));
        }
    }
    let _ = child.wait();
    Ok(blobs)
}

fn git_working_diff(project_path: &str, path: &str, old_path: Option<&str>) -> Result<GitFileDiff> {
    let project = validated_project(project_path)?;
    let root = repo_root(&project)?;
    validate_relative_path(path)?;
    if let Some(old_path) = old_path {
        validate_relative_path(old_path)?;
    }
    let source_path = old_path.filter(|value| !value.is_empty()).unwrap_or(path);
    // 无 HEAD 时对象缺失，按空内容处理。
    let old_bytes = git_blobs(&root, &[format!("HEAD:{source_path}")])?
        .pop()
        .unwrap_or(Some(Vec::new()));
    let file_path = root.join(path);
    let new_bytes = match std::fs::metadata(&file_path) {
        Ok(metadata) if metadata.len() > MAX_TEXT_BYTES as u64 => None,
        _ => Some(std::fs::read(&file_path).unwrap_or_default()),
    };
    build_diff(path, old_bytes, new_bytes)
}

fn git_commit_file_diff(
    project_path: &str,
    hash: &str,
    path: &str,
    old_path: Option<&str>,
) -> Result<GitFileDiff> {
    let project = validated_project(project_path)?;
    let root = repo_root(&project)?;
    validate_hash(hash)?;
    validate_relative_path(path)?;
    if let Some(old_path) = old_path {
        validate_relative_path(old_path)?;
    }
    let hash = hash.trim();
    let source_path = old_path.filter(|value| !value.is_empty()).unwrap_or(path);
    // `hash^` 为第一父提交；根提交没有父提交，对象缺失即为空内容。
    let mut blobs = git_blobs(
        &root,
        &[format!("{hash}^:{source_path}"), format!("{hash}:{path}")],
    )?;
    let new_bytes = blobs.pop().unwrap_or(Some(Vec::new()));
    let old_bytes = blobs.pop().unwrap_or(Some(Vec::new()));
    build_diff(path, old_bytes, new_bytes)
}

fn build_diff(path: &str, old_bytes: Option<Vec<u8>>, new_bytes: Option<Vec<u8>>) -> Result<GitFileDiff> {
    if old_bytes.is_none() || new_bytes.is_none() {
        return Ok(GitFileDiff {
            path: path.to_string(),
            old_text: String::new(),
            new_text: String::new(),
            binary: false,
            truncated: false,
            too_large: true,
        });
    }
    let old_bytes = old_bytes.unwrap_or_default();
    let new_bytes = new_bytes.unwrap_or_default();
    let binary = is_binary(&old_bytes) || is_binary(&new_bytes);
    if binary {
        return Ok(GitFileDiff {
            path: path.to_string(),
            old_text: String::new(),
            new_text: String::new(),
            binary: true,
            truncated: false,
            too_large: false,
        });
    }
    let (old_text, old_truncated) = text_from_bytes(old_bytes);
    let (new_text, new_truncated) = text_from_bytes(new_bytes);
    Ok(GitFileDiff {
        path: path.to_string(),
        old_text,
        new_text,
        binary: false,
        truncated: old_truncated || new_truncated,
        too_large: false,
    })
}

async fn blocking<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("Git 操作被中断：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn git_status_command(project_path: String) -> Result<GitStatus, String> {
    blocking(move || git_status(&project_path)).await
}

#[tauri::command]
pub async fn git_log_command(
    project_path: String,
    limit: Option<u32>,
    skip: Option<u32>,
) -> Result<Vec<GitCommit>, String> {
    let limit = limit.unwrap_or(80);
    let skip = skip.unwrap_or(0);
    blocking(move || git_log(&project_path, limit, skip)).await
}

#[tauri::command]
pub async fn git_commit_detail_command(
    project_path: String,
    hash: String,
) -> Result<GitCommitDetail, String> {
    blocking(move || git_commit_detail(&project_path, &hash)).await
}

#[tauri::command]
pub async fn git_working_diff_command(
    project_path: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitFileDiff, String> {
    blocking(move || git_working_diff(&project_path, &path, old_path.as_deref())).await
}

#[tauri::command]
pub async fn git_commit_file_diff_command(
    project_path: String,
    hash: String,
    path: String,
    old_path: Option<String>,
) -> Result<GitFileDiff, String> {
    blocking(move || git_commit_file_diff(&project_path, &hash, &path, old_path.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_v2_with_untracked_and_rename() {
        let output = b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/main.rs\0\
2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\0src/old.ts\0\
? notes.md\0";
        let status = parse_status_v2(output);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.files.len(), 3);
        assert_eq!(status.files[0].path, "src/main.rs");
        assert_eq!(status.files[0].status, "M");
        assert_eq!(status.files[1].path, "src/new.ts");
        assert_eq!(status.files[1].old_path.as_deref(), Some("src/old.ts"));
        assert_eq!(status.files[1].status, "R");
        assert_eq!(status.files[2].status, "?");
        assert!(status.files[2].untracked);
    }

    #[test]
    fn parses_raw_numstat_with_rename() {
        let output = b":100644 100644 aaa bbb M\0a.ts\0:100644 100644 aaa bbb R100\0old.ts\0new.ts\0:100644 000000 aaa 000 D\0gone.ts\03\t1\ta.ts\00\t0\t\0old.ts\0new.ts\0-\t-\tgone.ts\0";
        let (files, _) = parse_raw_numstat(output);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "a.ts");
        assert_eq!(files[1].old_path.as_deref(), Some("old.ts"));
        assert_eq!(files[1].path, "new.ts");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[2].status, "D");
        assert_eq!((files[0].additions, files[0].deletions), (Some(3), Some(1)));
        assert_eq!((files[1].additions, files[1].deletions), (Some(0), Some(0)));
        assert_eq!((files[2].additions, files[2].deletions), (None, None));
    }

    #[test]
    fn parses_log_records() {
        let output = b"aaa\0aaa\0Alice\0a@example.com\01700000000\0ppp qqq\0subject\0HEAD -> main\x1e\nbbb\0bbb\0Bob\0b@example.com\01700000001\0\0second\0\x1e\n";
        let commits = parse_log(output);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "aaa");
        assert_eq!(commits[0].parents, vec!["ppp", "qqq"]);
        assert_eq!(commits[0].subject, "subject");
        assert!(commits[1].parents.is_empty());
        assert_eq!(commits[1].timestamp, 1700000001);
    }

    #[test]
    fn truncates_oversized_text() {
        let mut bytes = vec![b'a'; MAX_TEXT_BYTES + 10];
        bytes[MAX_TEXT_BYTES + 1] = 0xff;
        let (text, truncated) = text_from_bytes(bytes);
        assert!(truncated);
        assert_eq!(text.len(), MAX_TEXT_BYTES);
    }

    #[test]
    fn detects_binary_payloads() {
        assert!(is_binary(b"abc\0def"));
        assert!(!is_binary("你好".as_bytes()));
    }

    fn test_git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(dir)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            status.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&status.stderr)
        );
    }

    #[test]
    fn reads_a_real_repository() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        test_git(path, &["init", "-q"]);
        test_git(path, &["config", "user.name", "Tester"]);
        test_git(path, &["config", "user.email", "tester@example.com"]);
        std::fs::write(path.join("hello.txt"), "one\n").unwrap();
        std::fs::write(path.join("gone.txt"), "gone\n").unwrap();
        test_git(path, &["add", "."]);
        test_git(path, &["commit", "-qm", "initial"]);
        std::fs::write(path.join("hello.txt"), "two\n").unwrap();
        std::fs::write(path.join("new.txt"), "new\n").unwrap();
        std::fs::remove_file(path.join("gone.txt")).unwrap();

        let project = path.to_string_lossy().into_owned();
        let status = git_status(&project).unwrap();
        assert!(status.files.iter().any(|file| file.path == "hello.txt" && file.status == "M"));
        assert!(status.files.iter().any(|file| file.path == "gone.txt" && file.status == "D"));
        assert!(status.files.iter().any(|file| file.path == "new.txt" && file.untracked));

        let log = git_log(&project, 10, 0).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "initial");

        let detail = git_commit_detail(&project, &log[0].hash).unwrap();
        assert_eq!(detail.files.len(), 2);
        assert!(detail.files.iter().any(|file| file.path == "hello.txt" && file.status == "A"));
        assert!(detail.files.iter().any(|file| file.path == "hello.txt" && file.additions == Some(1)));
        assert!(status.files.iter().any(|file| file.path == "hello.txt" && file.additions == Some(1) && file.deletions == Some(1)));

        let working = git_working_diff(&project, "hello.txt", None).unwrap();
        assert_eq!(working.old_text, "one\n");
        assert_eq!(working.new_text, "two\n");

        let deleted = git_working_diff(&project, "gone.txt", None).unwrap();
        assert_eq!(deleted.old_text, "gone\n");
        assert_eq!(deleted.new_text, "");
        assert!(!deleted.too_large);

        let initial = git_commit_file_diff(&project, &log[0].hash, "hello.txt", None).unwrap();
        assert_eq!(initial.old_text, "");
        assert_eq!(initial.new_text, "one\n");

        std::fs::write(path.join("hello.txt"), "three\n").unwrap();
        test_git(path, &["commit", "-qam", "second", "-m", "body line"]);
        let log = git_log(&project, 10, 0).unwrap();
        let second = git_commit_detail(&project, &log[0].hash).unwrap();
        assert_eq!(second.body, "body line");
        let changed = git_commit_file_diff(&project, &log[0].hash, "hello.txt", None).unwrap();
        assert_eq!((changed.old_text.as_str(), changed.new_text.as_str()), ("one\n", "three\n"));
        let missing = git_commit_file_diff(&project, &log[0].hash, "nope.txt", None).unwrap();
        assert_eq!((missing.old_text.as_str(), missing.new_text.as_str()), ("", ""));
    }
}
