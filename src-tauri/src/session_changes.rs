//! Per-session code change tracking for CLI terminals.
//!
//! A baseline of the working tree is captured right before a CLI session starts.
//! Git repositories record HEAD plus a snapshot of files that were already dirty;
//! other directories record a bounded snapshot of small files. The panel above the
//! CLI input compares the live tree against that baseline, so it works for every
//! CLI provider without parsing its output.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const BASELINE_VERSION: u32 = 1;
/// Files larger than this are compared by hash only and never diffed.
const MAX_DIFF_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Upper bound for reading a file just to decide whether it changed.
const MAX_READ_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_GIT_DIRTY_SNAPSHOT: usize = 5000;
const MAX_PLAIN_ENTRIES: usize = 20_000;
const MAX_PLAIN_FILE_BYTES: u64 = 512 * 1024;
const MAX_PLAIN_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_CANDIDATES: usize = 2000;
const MAX_DIFF_ROWS: usize = 4000;
const MAX_DIFF_DISTANCE: usize = 4000;
const DIFF_CONTEXT: usize = 3;
const BASELINE_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const PLAIN_SKIP_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "target", ".next", ".nuxt", ".cache", ".venv",
    "venv", "__pycache__", ".gradle", ".idea", ".vs", "logs", "crash-reports", ".agent",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum BaselineMode {
    Git,
    Plain,
}

/// Snapshot of one file at baseline time. `hash` is present when the content
/// was stored as a blob (or hashed) so it can be diffed/compared later.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileState {
    exists: bool,
    size: u64,
    mtime_ns: u64,
    hash: Option<String>,
    stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Baseline {
    version: u32,
    session_id: String,
    cwd: String,
    root: String,
    mode: BaselineMode,
    head: Option<String>,
    captured_at_ms: u64,
    /// Git: files dirty at baseline. Plain: every scanned file.
    files: BTreeMap<String, FileState>,
    truncated: bool,
}

/// Baseline captured before the session exists; registered once its id is known.
pub struct PreparedBaseline {
    baseline: Baseline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileChange {
    pub path: String,
    pub absolute_path: String,
    /// added | modified | deleted
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
    /// Already dirty before this session and not touched since.
    pub pre_session: bool,
    /// source | test | generated
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChanges {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub mode: String,
    pub root: String,
    /// session | head (no session baseline, compared with HEAD)
    pub baseline: String,
    pub captured_at_ms: Option<u64>,
    pub files: Vec<SessionFileChange>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiffRow {
    /// context | add | del | gap
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileDiff {
    pub file: Option<SessionFileChange>,
    pub rows: Vec<SessionDiffRow>,
    pub truncated: bool,
    pub too_large: bool,
    pub unavailable_base: bool,
}

static BASELINES: Lazy<Mutex<HashMap<String, Arc<Baseline>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
/// (base hash, current hash) -> (additions, deletions)
static STAT_CACHE: Lazy<Mutex<HashMap<(String, String), (u32, u32)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static PRUNE_STARTED: AtomicBool = AtomicBool::new(false);

fn store_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("session-changes")
}

fn baseline_path(data_dir: &Path, session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    store_dir(data_dir).join("baselines").join(format!("{safe}.json"))
}

fn blob_path(data_dir: &Path, hash: &str) -> PathBuf {
    store_dir(data_dir).join("blobs").join(&hash[..2]).join(hash)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_blob(data_dir: &Path, bytes: &[u8]) -> Result<String> {
    let hash = sha256_hex(bytes);
    let path = blob_path(data_dir, &hash);
    if !path.exists() {
        fs::create_dir_all(path.parent().unwrap())?;
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        fs::write(&tmp, bytes)?;
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
    Ok(hash)
}

fn read_blob(data_dir: &Path, hash: &str) -> Option<Vec<u8>> {
    fs::read(blob_path(data_dir, hash)).ok()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mtime_ns(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

/// Metadata of a regular file; `None` for missing paths and directories.
fn file_meta(path: &Path) -> Option<fs::Metadata> {
    fs::metadata(path).ok().filter(|meta| meta.is_file())
}

fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    if cfg!(windows) { text.replace('/', "\\") } else { text }
}

// ---------------------------------------------------------------------------
// git plumbing

fn git_command(root: &Path) -> Command {
    let mut command = git_base_command(root);
    command.arg("--literal-pathspecs");
    command
}

/// `check-ignore` rejects `--literal-pathspecs`, so it uses this form.
fn git_base_command(root: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.quotepath=off")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let output = git_command(root).args(args).output().context("failed to run git")?;
    if !output.status.success() {
        bail!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(output.stdout)
}

fn git_root(cwd: &Path) -> Option<PathBuf> {
    let out = git(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    (!text.is_empty()).then(|| PathBuf::from(display_path(Path::new(&text))))
}

/// Repository to compare against, unless `cwd` sits in a directory the repo
/// ignores (for example a scratch folder under an ignored `tmp/`): git would
/// hide every change there, so such folders use a plain snapshot instead.
fn tracking_git_root(cwd: &Path) -> Option<PathBuf> {
    let root = git_root(cwd)?;
    let prefix = git(cwd, &["rev-parse", "--show-prefix"]).ok()?;
    let prefix = String::from_utf8_lossy(&prefix).trim().to_string();
    // Check every ancestor ("tmp/", "tmp/demo/"): git stops at the first ignored directory.
    let mut ancestor = String::new();
    for part in prefix.split('/').filter(|part| !part.is_empty()) {
        ancestor.push_str(part);
        ancestor.push('/');
        let ignored = git_base_command(&root)
            .args(["check-ignore", "-q", "--", &ancestor])
            .status()
            .is_ok_and(|status| status.success());
        if ignored {
            return None;
        }
    }
    Some(root)
}

fn git_head(root: &Path) -> Option<String> {
    let out = git(root, &["rev-parse", "--verify", "-q", "HEAD"]).ok()?;
    let text = String::from_utf8_lossy(&out).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect()
}

/// Paths (relative to the repo root, `/` separated) that differ from HEAD or are untracked.
fn git_dirty_paths(root: &Path, pathspec: Option<&str>) -> Result<BTreeSet<String>> {
    let mut args = vec!["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"];
    if let Some(spec) = pathspec {
        args.push("--");
        args.push(spec);
    }
    let out = git(root, &args)?;
    Ok(split_nul(&out)
        .into_iter()
        .filter(|entry| entry.len() > 3)
        .map(|entry| entry[3..].trim_end_matches('/').to_string())
        .collect())
}

fn git_changed_between(root: &Path, from: &str, to: &str) -> Result<BTreeSet<String>> {
    let out = git(root, &["diff", "--name-only", "-z", "--no-renames", from, to])?;
    Ok(split_nul(&out).into_iter().collect())
}

fn git_tree_paths(root: &Path, rev: &str) -> Result<BTreeSet<String>> {
    let out = git(root, &["ls-tree", "-r", "-z", "--name-only", rev])?;
    Ok(split_nul(&out).into_iter().collect())
}

/// Reads `<rev>:<path>` blobs in a single `git cat-file --batch` process.
/// Missing objects map to `None`.
fn git_read_blobs(root: &Path, specs: &[String]) -> Result<Vec<Option<Vec<u8>>>> {
    if specs.is_empty() {
        return Ok(Vec::new());
    }
    let mut child = git_command(root)
        .arg("cat-file")
        .arg("--batch")
        .stdin(Stdio::piped())
        .spawn()
        .context("failed to run git cat-file")?;
    let mut stdin = child.stdin.take().context("git stdin unavailable")?;
    let input: Vec<u8> = specs.iter().flat_map(|spec| format!("{spec}\n").into_bytes()).collect();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let mut reader = BufReader::new(child.stdout.take().context("git stdout unavailable")?);
    let mut results = Vec::with_capacity(specs.len());
    for _ in specs {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.ends_with(" missing") || header.ends_with(" ambiguous") {
            results.push(None);
            continue;
        }
        let size: usize = header
            .rsplit(' ')
            .next()
            .and_then(|value| value.parse().ok())
            .context("unexpected git cat-file header")?;
        let mut content = vec![0; size];
        reader.read_exact(&mut content)?;
        let mut newline = [0u8; 1];
        reader.read_exact(&mut newline)?;
        results.push(Some(content));
    }
    let _ = writer.join();
    let _ = child.wait();
    while results.len() < specs.len() {
        results.push(None);
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// line diff (Myers, O((N+M)·D) with common prefix/suffix trimmed)

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Equal,
    Delete,
    Insert,
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

/// Splits text into lines; `\r` is dropped so CRLF/LF conversions do not show as edits.
fn split_lines(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
}

fn intern_lines<'a>(ids: &mut HashMap<&'a str, u32>, lines: &'a [String]) -> Vec<u32> {
    let mut out = Vec::with_capacity(lines.len());
    for line in lines {
        let next = ids.len() as u32;
        out.push(*ids.entry(line.as_str()).or_insert(next));
    }
    out
}

fn diff_ops(old: &[String], new: &[String]) -> Vec<Op> {
    let mut ids: HashMap<&str, u32> = HashMap::new();
    let a = intern_lines(&mut ids, old);
    let b = intern_lines(&mut ids, new);

    let mut prefix = 0;
    while prefix < a.len() && prefix < b.len() && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < a.len() - prefix
        && suffix < b.len() - prefix
        && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix]
    {
        suffix += 1;
    }
    let middle = myers(&a[prefix..a.len() - suffix], &b[prefix..b.len() - suffix]);
    let mut ops = vec![Op::Equal; prefix];
    ops.extend(middle);
    ops.extend(std::iter::repeat(Op::Equal).take(suffix));
    ops
}

fn myers(a: &[u32], b: &[u32]) -> Vec<Op> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    if n == 0 || m == 0 {
        let mut ops = vec![Op::Delete; a.len()];
        ops.extend(std::iter::repeat(Op::Insert).take(b.len()));
        return ops;
    }
    let max = (n + m) as usize;
    let limit = max.min(MAX_DIFF_DISTANCE) as i64;
    let offset = max as i64 + 1;
    let mut v = vec![0i64; 2 * max + 3];
    // trace[d] holds v[-d-1 ..= d+1] as it was before step d.
    let mut trace: Vec<Vec<i64>> = Vec::new();
    let mut found = None;
    'outer: for d in 0..=limit {
        let lo = (offset - d - 1) as usize;
        let hi = (offset + d + 1) as usize;
        trace.push(v[lo..=hi].to_vec());
        let mut k = -d;
        while k <= d {
            let idx = (offset + k) as usize;
            let mut x = if k == -d || (k != d && v[idx - 1] < v[idx + 1]) {
                v[idx + 1]
            } else {
                v[idx - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[idx] = x;
            if x >= n && y >= m {
                found = Some(d);
                break 'outer;
            }
            k += 2;
        }
    }
    let Some(final_d) = found else {
        // Too different to align cheaply: show as a full replacement.
        let mut ops = vec![Op::Delete; a.len()];
        ops.extend(std::iter::repeat(Op::Insert).take(b.len()));
        return ops;
    };

    let mut ops = Vec::with_capacity((n + m) as usize);
    let (mut x, mut y) = (n, m);
    for d in (1..=final_d).rev() {
        let snapshot = &trace[d as usize];
        let get = |k: i64| snapshot[(k + d + 1) as usize];
        let k = x - y;
        let prev_k = if k == -d || (k != d && get(k - 1) < get(k + 1)) { k + 1 } else { k - 1 };
        let prev_x = get(prev_k);
        let prev_y = prev_x - prev_k;
        while x > prev_x && y > prev_y {
            ops.push(Op::Equal);
            x -= 1;
            y -= 1;
        }
        if x == prev_x {
            ops.push(Op::Insert);
        } else {
            ops.push(Op::Delete);
        }
        x = prev_x;
        y = prev_y;
    }
    while x > 0 && y > 0 {
        ops.push(Op::Equal);
        x -= 1;
        y -= 1;
    }
    ops.reverse();
    ops
}

fn count_ops(ops: &[Op]) -> (u32, u32) {
    let additions = ops.iter().filter(|op| **op == Op::Insert).count() as u32;
    let deletions = ops.iter().filter(|op| **op == Op::Delete).count() as u32;
    (additions, deletions)
}

/// Builds display rows: changed lines with context, deletions before insertions
/// in each change block, and `gap` rows where unchanged lines were skipped.
fn build_rows(old: &[String], new: &[String], ops: &[Op]) -> (Vec<SessionDiffRow>, bool) {
    // Normalise each change block to deletes-then-inserts.
    let mut normalised = Vec::with_capacity(ops.len());
    let mut i = 0;
    while i < ops.len() {
        if ops[i] == Op::Equal {
            normalised.push(Op::Equal);
            i += 1;
            continue;
        }
        let start = i;
        while i < ops.len() && ops[i] != Op::Equal {
            i += 1;
        }
        let (dels, ins) = ops[start..i].iter().fold((0, 0), |(d, n), op| {
            if *op == Op::Delete { (d + 1, n) } else { (d, n + 1) }
        });
        normalised.extend(std::iter::repeat(Op::Delete).take(dels));
        normalised.extend(std::iter::repeat(Op::Insert).take(ins));
    }

    let mut visible = vec![false; normalised.len()];
    for (index, op) in normalised.iter().enumerate() {
        if *op != Op::Equal {
            let lo = index.saturating_sub(DIFF_CONTEXT);
            let hi = (index + DIFF_CONTEXT).min(normalised.len() - 1);
            visible[lo..=hi].iter_mut().for_each(|flag| *flag = true);
        }
    }

    let mut rows = Vec::new();
    let (mut oi, mut ni) = (0usize, 0usize);
    let mut skipped = false;
    let mut truncated = false;
    for (index, op) in normalised.iter().enumerate() {
        if visible[index] {
            if skipped && !rows.is_empty() {
                rows.push(SessionDiffRow { kind: "gap".into(), old_line: None, new_line: None, text: String::new() });
            }
            skipped = false;
            if rows.len() >= MAX_DIFF_ROWS {
                truncated = true;
                break;
            }
            let row = match op {
                Op::Equal => SessionDiffRow {
                    kind: "context".into(),
                    old_line: Some(oi as u32 + 1),
                    new_line: Some(ni as u32 + 1),
                    text: new[ni].clone(),
                },
                Op::Delete => SessionDiffRow {
                    kind: "del".into(),
                    old_line: Some(oi as u32 + 1),
                    new_line: None,
                    text: old[oi].clone(),
                },
                Op::Insert => SessionDiffRow {
                    kind: "add".into(),
                    old_line: None,
                    new_line: Some(ni as u32 + 1),
                    text: new[ni].clone(),
                },
            };
            rows.push(row);
        } else {
            skipped = true;
        }
        match op {
            Op::Equal => {
                oi += 1;
                ni += 1;
            }
            Op::Delete => oi += 1,
            Op::Insert => ni += 1,
        }
    }
    (rows, truncated)
}

fn file_kind(rel: &str) -> &'static str {
    let lower = rel.to_ascii_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let generated_names = [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock", "poetry.lock",
        "composer.lock", "gemfile.lock", "bun.lockb", "go.sum",
    ];
    let segments: Vec<&str> = lower.split('/').collect();
    let dirs = &segments[..segments.len().saturating_sub(1)];
    if generated_names.contains(&name)
        || name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || name.ends_with(".snap")
        || dirs.iter().any(|dir| matches!(*dir, "dist" | "build" | "generated" | "__snapshots__" | "node_modules" | "target"))
    {
        return "generated";
    }
    let stem = name.split('.').next().unwrap_or(name);
    if dirs.iter().any(|dir| matches!(*dir, "test" | "tests" | "__tests__" | "spec" | "specs"))
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_test.")
        || stem.starts_with("test_")
        || stem.ends_with("_test")
        || stem.ends_with("tests")
    {
        return "test";
    }
    "source"
}

// ---------------------------------------------------------------------------
// baseline capture

fn snapshot_state(data_dir: &Path, path: &Path, store: bool) -> FileState {
    let Some(meta) = file_meta(path) else {
        return FileState { exists: false, size: 0, mtime_ns: 0, hash: None, stored: false };
    };
    let (size, mtime) = (meta.len(), mtime_ns(&meta));
    let mut state = FileState { exists: true, size, mtime_ns: mtime, hash: None, stored: false };
    if store && size <= MAX_READ_FILE_BYTES {
        if let Ok(bytes) = fs::read(path) {
            if bytes.len() as u64 <= MAX_DIFF_FILE_BYTES {
                if let Ok(hash) = write_blob(data_dir, &bytes) {
                    state.hash = Some(hash);
                    state.stored = true;
                }
            } else {
                state.hash = Some(sha256_hex(&bytes));
            }
        }
    }
    state
}

fn prepare_git(data_dir: &Path, cwd: &Path, root: &Path) -> Result<Baseline> {
    let head = git_head(root);
    let dirty = git_dirty_paths(root, None)?;
    let truncated = dirty.len() > MAX_GIT_DIRTY_SNAPSHOT;
    let files = dirty
        .into_iter()
        .enumerate()
        .map(|(index, rel)| {
            let state = snapshot_state(data_dir, &join_rel(root, &rel), index < MAX_GIT_DIRTY_SNAPSHOT);
            (rel, state)
        })
        .collect();
    Ok(Baseline {
        version: BASELINE_VERSION,
        session_id: String::new(),
        cwd: display_path(cwd),
        root: display_path(root),
        mode: BaselineMode::Git,
        head,
        captured_at_ms: now_ms(),
        files,
        truncated,
    })
}

fn plain_skip(name: &str) -> bool {
    PLAIN_SKIP_DIRS.iter().any(|skip| name.eq_ignore_ascii_case(skip))
}

/// Walks a non-git directory, returning `/`-separated relative paths with metadata.
fn walk_plain(root: &Path) -> (Vec<(String, fs::Metadata)>, bool) {
    let mut entries = Vec::new();
    let mut truncated = false;
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !(entry.file_type().is_dir() && plain_skip(&entry.file_name().to_string_lossy())));
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".log") || name.ends_with(".lck") || name.ends_with(".lock.db") {
            continue;
        }
        if entries.len() >= MAX_PLAIN_ENTRIES {
            truncated = true;
            break;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if let Ok(meta) = entry.metadata() {
            entries.push((rel, meta));
        }
    }
    (entries, truncated)
}

fn prepare_plain(data_dir: &Path, cwd: &Path) -> Baseline {
    let (entries, truncated) = walk_plain(cwd);
    let mut budget = MAX_PLAIN_TOTAL_BYTES;
    let mut files = BTreeMap::new();
    for (rel, meta) in entries {
        let size = meta.len();
        let store = size <= MAX_PLAIN_FILE_BYTES && size <= budget;
        let state = if store {
            let state = snapshot_state(data_dir, &join_rel(cwd, &rel), true);
            if state.stored {
                budget = budget.saturating_sub(state.size);
            }
            state
        } else {
            FileState { exists: true, size, mtime_ns: mtime_ns(&meta), hash: None, stored: false }
        };
        files.insert(rel, state);
    }
    Baseline {
        version: BASELINE_VERSION,
        session_id: String::new(),
        cwd: display_path(cwd),
        root: display_path(cwd),
        mode: BaselineMode::Plain,
        head: None,
        captured_at_ms: now_ms(),
        files,
        truncated,
    }
}

fn prune_store(data_dir: &Path) {
    let baselines_dir = store_dir(data_dir).join("baselines");
    let mut referenced = BTreeSet::new();
    let cutoff = SystemTime::now().checked_sub(BASELINE_RETENTION);
    for entry in fs::read_dir(&baselines_dir).into_iter().flatten().flatten() {
        let path = entry.path();
        let expired = cutoff.is_some_and(|cutoff| {
            entry.metadata().and_then(|meta| meta.modified()).is_ok_and(|modified| modified < cutoff)
        });
        if expired {
            let _ = fs::remove_file(&path);
            continue;
        }
        if let Ok(baseline) = fs::read(&path).map_err(anyhow::Error::from).and_then(|raw| Ok(serde_json::from_slice::<Baseline>(&raw)?)) {
            referenced.extend(baseline.files.values().filter_map(|state| state.hash.clone()));
        }
    }
    // Leave fresh blobs alone: a baseline may still be preparing them.
    let fresh = SystemTime::now().checked_sub(Duration::from_secs(24 * 60 * 60));
    for bucket in fs::read_dir(store_dir(data_dir).join("blobs")).into_iter().flatten().flatten() {
        for blob in fs::read_dir(bucket.path()).into_iter().flatten().flatten() {
            let name = blob.file_name().to_string_lossy().to_string();
            let old = fresh.is_some_and(|fresh| {
                blob.metadata().and_then(|meta| meta.modified()).is_ok_and(|modified| modified < fresh)
            });
            if old && !referenced.contains(&name) {
                let _ = fs::remove_file(blob.path());
            }
        }
    }
}

fn load_baseline(data_dir: &Path, session_id: &str) -> Option<Arc<Baseline>> {
    if let Some(baseline) = BASELINES.lock().unwrap_or_else(|e| e.into_inner()).get(session_id) {
        return Some(Arc::clone(baseline));
    }
    let raw = fs::read(baseline_path(data_dir, session_id)).ok()?;
    let baseline: Baseline = serde_json::from_slice(&raw).ok()?;
    if baseline.version != BASELINE_VERSION {
        return None;
    }
    let baseline = Arc::new(baseline);
    BASELINES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(session_id.to_string(), Arc::clone(&baseline));
    Some(baseline)
}

// ---------------------------------------------------------------------------
// comparison

#[derive(Debug, Clone, Default)]
struct Side {
    exists: bool,
    /// Loaded content (only kept when small enough to diff).
    bytes: Option<Vec<u8>>,
    hash: Option<String>,
    size: u64,
    mtime_ns: u64,
}

impl Side {
    fn from_bytes(bytes: Vec<u8>) -> Self {
        let hash = Some(sha256_hex(&bytes));
        let size = bytes.len() as u64;
        let bytes = (size <= MAX_DIFF_FILE_BYTES).then_some(bytes);
        Side { exists: true, bytes, hash, size, mtime_ns: 0 }
    }

    fn current(path: &Path) -> Self {
        let Some(meta) = file_meta(path) else { return Side::default() };
        let mtime = mtime_ns(&meta);
        if meta.len() <= MAX_READ_FILE_BYTES {
            if let Ok(bytes) = fs::read(path) {
                return Side { mtime_ns: mtime, ..Side::from_bytes(bytes) };
            }
        }
        Side { exists: true, bytes: None, hash: None, size: meta.len(), mtime_ns: mtime }
    }

    fn from_state(data_dir: &Path, state: &FileState) -> Self {
        if !state.exists {
            return Side::default();
        }
        let bytes = if state.stored { state.hash.as_deref().and_then(|hash| read_blob(data_dir, hash)) } else { None };
        Side { exists: true, bytes, hash: state.hash.clone(), size: state.size, mtime_ns: state.mtime_ns }
    }

    fn matches_state(&self, state: &FileState) -> bool {
        if !self.exists || !state.exists {
            return self.exists == state.exists;
        }
        match (&self.hash, &state.hash) {
            (Some(a), Some(b)) => a == b,
            _ => self.size == state.size && self.mtime_ns == state.mtime_ns,
        }
    }

    fn diffable(&self) -> Option<&[u8]> {
        if !self.exists {
            return Some(&[]);
        }
        let bytes = self.bytes.as_deref()?;
        (!is_binary(bytes)).then_some(bytes)
    }
}

struct Pair {
    rel: String,
    base: Side,
    current: Side,
    pre_session: bool,
    /// The base existed but its content was not snapshotted.
    base_unknown: bool,
}

fn matches_only(only: Option<&str>, rel: &str) -> bool {
    only.map_or(true, |only| only == rel)
}

fn git_pairs(
    data_dir: &Path,
    root: &Path,
    baseline: Option<&Baseline>,
    only: Option<&str>,
) -> Result<(Vec<Pair>, bool)> {
    let current_head = git_head(root);
    let base_head = match baseline {
        Some(baseline) => baseline.head.clone(),
        None => current_head.clone(),
    };
    let mut candidates = git_dirty_paths(root, only)?;
    if let Some(baseline) = baseline {
        candidates.extend(baseline.files.keys().filter(|rel| matches_only(only, rel)).cloned());
        if let (true, Some(current)) = (base_head != current_head, &current_head) {
            // Commits made during the session: their files are compared with the baseline too.
            let committed = match &base_head {
                Some(base) => git_changed_between(root, base, current)?,
                None => git_tree_paths(root, current)?,
            };
            candidates.extend(committed.into_iter().filter(|rel| matches_only(only, rel)));
        }
    }
    let truncated = candidates.len() > MAX_CANDIDATES;
    let mut pairs = Vec::new();
    let mut specs: Vec<(usize, String)> = Vec::new();
    for rel in candidates.into_iter().take(MAX_CANDIDATES) {
        let current = Side::current(&join_rel(root, &rel));
        let mut pair = Pair { rel, base: Side::default(), current, pre_session: false, base_unknown: false };
        let blob_rev = match baseline.and_then(|baseline| baseline.files.get(&pair.rel)) {
            // Dirty before the session and untouched since: an earlier edit, shown against HEAD.
            Some(state) if pair.current.matches_state(state) => {
                pair.pre_session = true;
                current_head.clone()
            }
            Some(state) => {
                pair.base = Side::from_state(data_dir, state);
                pair.base_unknown = state.exists && pair.base.bytes.is_none();
                None
            }
            None => base_head.clone(),
        };
        if let Some(rev) = blob_rev {
            specs.push((pairs.len(), format!("{rev}:{}", pair.rel)));
        }
        pairs.push(pair);
    }
    let blobs = git_read_blobs(root, &specs.iter().map(|(_, spec)| spec.clone()).collect::<Vec<_>>())?;
    for ((index, _), blob) in specs.iter().zip(blobs) {
        if let Some(bytes) = blob {
            pairs[*index].base = Side::from_bytes(bytes);
        }
    }
    Ok((pairs, truncated))
}

fn plain_pairs(data_dir: &Path, root: &Path, baseline: &Baseline, only: Option<&str>) -> (Vec<Pair>, bool) {
    let make = |rel: &str, state: Option<&FileState>| {
        let current = Side::current(&join_rel(root, rel));
        let base = state.map(|state| Side::from_state(data_dir, state)).unwrap_or_default();
        let base_unknown = state.is_some_and(|state| state.exists && base.bytes.is_none());
        Pair { rel: rel.to_string(), base, current, pre_session: false, base_unknown }
    };
    if let Some(rel) = only {
        return (vec![make(rel, baseline.files.get(rel))], false);
    }
    let (entries, walk_truncated) = walk_plain(root);
    let mut pairs = Vec::new();
    let mut seen = BTreeSet::new();
    for (rel, meta) in &entries {
        seen.insert(rel.as_str());
        match baseline.files.get(rel) {
            Some(state) if state.size == meta.len() && state.mtime_ns == mtime_ns(meta) => continue,
            // Beyond a truncated baseline scan: only files created after capture count as added.
            None if baseline.truncated && mtime_ns(meta) / 1_000_000 < baseline.captured_at_ms => continue,
            state => pairs.push(make(rel, state)),
        }
        if pairs.len() >= MAX_CANDIDATES {
            return (pairs, true);
        }
    }
    for (rel, state) in &baseline.files {
        if seen.contains(rel.as_str()) || (walk_truncated && join_rel(root, rel).exists()) {
            continue;
        }
        pairs.push(make(rel, Some(state)));
        if pairs.len() >= MAX_CANDIDATES {
            return (pairs, true);
        }
    }
    (pairs, walk_truncated)
}

fn cached_counts(base: &Side, current: &Side) -> Option<(u32, u32)> {
    let (old, new) = (base.diffable()?, current.diffable()?);
    let key = (base.hash.clone().unwrap_or_default(), current.hash.clone().unwrap_or_default());
    if let Some(counts) = STAT_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Some(*counts);
    }
    let counts = count_ops(&diff_ops(&split_lines(old), &split_lines(new)));
    let mut cache = STAT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() > 4096 {
        cache.clear();
    }
    cache.insert(key, counts);
    Some(counts)
}

fn summarize(root: &Path, pair: &Pair) -> Option<SessionFileChange> {
    let (base, current) = (&pair.base, &pair.current);
    if !base.exists && !current.exists {
        return None;
    }
    if base.exists && current.exists && base.hash.is_some() && base.hash == current.hash {
        return None;
    }
    let status = if !base.exists { "added" } else if !current.exists { "deleted" } else { "modified" };
    let binary = [base, current].iter().any(|side| side.bytes.as_deref().is_some_and(is_binary));
    let counts = if binary { None } else { cached_counts(base, current) };
    // Only line endings differ.
    if status == "modified" && counts == Some((0, 0)) {
        return None;
    }
    Some(SessionFileChange {
        path: pair.rel.clone(),
        absolute_path: display_path(&join_rel(root, &pair.rel)),
        status: status.to_string(),
        additions: counts.map(|(additions, _)| additions),
        deletions: counts.map(|(_, deletions)| deletions),
        binary,
        pre_session: pair.pre_session,
        kind: file_kind(&pair.rel).to_string(),
    })
}

// ---------------------------------------------------------------------------
// public API

struct Scope {
    root: PathBuf,
    mode: BaselineMode,
    baseline: Option<Arc<Baseline>>,
}

fn resolve_scope(data_dir: &Path, session_id: &str, cwd: &Path) -> Result<Scope> {
    if let Some(baseline) = load_baseline(data_dir, session_id) {
        return Ok(Scope { root: PathBuf::from(&baseline.root), mode: baseline.mode, baseline: Some(baseline) });
    }
    match tracking_git_root(cwd) {
        Some(root) => Ok(Scope { root, mode: BaselineMode::Git, baseline: None }),
        None => bail!("该会话启动时未记录基线，且当前目录不是 Git 仓库，无法统计改动"),
    }
}

/// Terminals that are not coding CLIs (shells, project services) are not tracked.
pub fn should_track(provider_kind: &str) -> bool {
    !matches!(provider_kind, "local" | "project-startup" | "project-service" | "minecraft-client")
}

pub fn prepare(data_dir: &Path, cwd: &Path) -> Result<PreparedBaseline> {
    let baseline = match tracking_git_root(cwd) {
        Some(root) => prepare_git(data_dir, cwd, &root)?,
        None => prepare_plain(data_dir, cwd),
    };
    Ok(PreparedBaseline { baseline })
}

pub fn register(data_dir: &Path, session_id: &str, prepared: PreparedBaseline) {
    let mut baseline = prepared.baseline;
    baseline.session_id = session_id.to_string();
    let path = baseline_path(data_dir, session_id);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_vec(&baseline) {
        let _ = fs::write(&path, raw);
    }
    BASELINES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(session_id.to_string(), Arc::new(baseline));
    if !PRUNE_STARTED.swap(true, Ordering::SeqCst) {
        let data_dir = data_dir.to_path_buf();
        std::thread::spawn(move || prune_store(&data_dir));
    }
}

/// Captures a baseline before `create` starts the CLI, then registers it under the new id.
/// Baseline failures never block the session.
pub fn track_new_session<F>(
    data_dir: Option<&Path>,
    provider_kind: &str,
    cwd: &Path,
    create: F,
) -> Result<crate::models::TerminalSessionDto>
where
    F: FnOnce() -> Result<crate::models::TerminalSessionDto>,
{
    let prepared = match data_dir {
        Some(data_dir) if should_track(provider_kind) && cwd.is_dir() => prepare(data_dir, cwd).ok(),
        _ => None,
    };
    let session = create()?;
    if let (Some(data_dir), Some(prepared)) = (data_dir, prepared) {
        register(data_dir, &session.id, prepared);
    }
    Ok(session)
}

fn unavailable(reason: String) -> SessionChanges {
    SessionChanges {
        available: false,
        reason: Some(reason),
        mode: String::new(),
        root: String::new(),
        baseline: String::new(),
        captured_at_ms: None,
        files: Vec::new(),
        truncated: false,
    }
}

fn scope_pairs(data_dir: &Path, scope: &Scope, only: Option<&str>) -> Result<(Vec<Pair>, bool)> {
    match (scope.mode, &scope.baseline) {
        (BaselineMode::Plain, Some(baseline)) => Ok(plain_pairs(data_dir, &scope.root, baseline, only)),
        (BaselineMode::Plain, None) => bail!("缺少会话基线"),
        (BaselineMode::Git, baseline) => git_pairs(data_dir, &scope.root, baseline.as_deref(), only),
    }
}

pub fn session_changes(data_dir: &Path, session_id: &str, cwd: &Path) -> SessionChanges {
    let result = (|| -> Result<SessionChanges> {
        let scope = resolve_scope(data_dir, session_id, cwd)?;
        let (pairs, truncated) = scope_pairs(data_dir, &scope, None)?;
        let mut files: Vec<SessionFileChange> = pairs.iter().filter_map(|pair| summarize(&scope.root, pair)).collect();
        files.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
        Ok(SessionChanges {
            available: true,
            reason: None,
            mode: match scope.mode { BaselineMode::Git => "git", BaselineMode::Plain => "plain" }.to_string(),
            root: display_path(&scope.root),
            baseline: if scope.baseline.is_some() { "session" } else { "head" }.to_string(),
            captured_at_ms: scope.baseline.as_ref().map(|baseline| baseline.captured_at_ms),
            files,
            truncated: truncated || scope.baseline.as_ref().is_some_and(|baseline| baseline.truncated),
        })
    })();
    result.unwrap_or_else(|error| unavailable(error.to_string()))
}

/// Accepts a root-relative path (either separator) or an absolute path inside the root.
fn relative_path(root: &Path, path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let root_text = display_path(root).replace('\\', "/");
    let root_text = root_text.trim_end_matches('/');
    let prefix_len = root_text.len();
    if normalized.len() > prefix_len
        && normalized.get(..prefix_len).is_some_and(|prefix| prefix.eq_ignore_ascii_case(root_text))
        && normalized[prefix_len..].starts_with('/')
    {
        return normalized[prefix_len + 1..].to_string();
    }
    normalized.trim_start_matches("./").to_string()
}

pub fn session_file_diff(data_dir: &Path, session_id: &str, cwd: &Path, path: &str) -> Result<SessionFileDiff> {
    let scope = resolve_scope(data_dir, session_id, cwd)?;
    let rel = relative_path(&scope.root, path);
    anyhow::ensure!(!rel.is_empty() && !rel.split('/').any(|part| part == ".."), "invalid path: {path}");
    let (pairs, _) = scope_pairs(data_dir, &scope, Some(&rel))?;
    let empty = SessionFileDiff { file: None, rows: Vec::new(), truncated: false, too_large: false, unavailable_base: false };
    let Some(pair) = pairs.into_iter().find(|pair| pair.rel == rel) else { return Ok(empty) };
    let Some(file) = summarize(&scope.root, &pair) else { return Ok(empty) };
    let mut diff = SessionFileDiff { file: Some(file), ..empty };
    if pair.base_unknown {
        diff.unavailable_base = true;
        return Ok(diff);
    }
    match (pair.base.diffable(), pair.current.diffable()) {
        (Some(old), Some(new)) => {
            let (old, new) = (split_lines(old), split_lines(new));
            let ops = diff_ops(&old, &new);
            let (rows, truncated) = build_rows(&old, &new, &ops);
            diff.rows = rows;
            diff.truncated = truncated;
        }
        _ => diff.too_large = !diff.file.as_ref().is_some_and(|file| file.binary),
    }
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str) -> Vec<String> {
        split_lines(text.as_bytes())
    }

    /// Applies ops to `old` and checks that the result is `new`.
    fn check_ops(old: &str, new: &str) -> (u32, u32) {
        let (a, b) = (lines(old), lines(new));
        let ops = diff_ops(&a, &b);
        let (mut oi, mut ni, mut rebuilt) = (0, 0, Vec::new());
        for op in &ops {
            match op {
                Op::Equal => {
                    assert_eq!(a[oi], b[ni]);
                    rebuilt.push(a[oi].clone());
                    oi += 1;
                    ni += 1;
                }
                Op::Delete => oi += 1,
                Op::Insert => {
                    rebuilt.push(b[ni].clone());
                    ni += 1;
                }
            }
        }
        assert_eq!((oi, ni), (a.len(), b.len()));
        assert_eq!(rebuilt, b);
        count_ops(&ops)
    }

    #[test]
    fn myers_diff_is_minimal_and_reconstructs_the_new_text() {
        assert_eq!(check_ops("a\nb\nc\n", "a\nb\nc\n"), (0, 0));
        assert_eq!(check_ops("a\nb\nc\n", "a\nx\nc\n"), (1, 1));
        assert_eq!(check_ops("", "a\nb\n"), (2, 0));
        assert_eq!(check_ops("a\nb\n", ""), (0, 2));
        assert_eq!(check_ops("a\nb\nc\nd\ne\n", "b\nc\nx\ne\nf\n"), (2, 2));
        assert_eq!(check_ops("a\r\nb\r\n", "a\nb\n"), (0, 0));
        assert_eq!(check_ops("x\ny\nx\ny\nz\n", "y\nx\ny\nz\nz\n"), (1, 1));
    }

    #[test]
    fn rows_keep_context_and_mark_gaps() {
        let old: String = (1..=20).map(|n| format!("line {n}\n")).collect();
        let new = old.replace("line 3\n", "line three\n").replace("line 18\n", "line 18\nextra\n");
        let (a, b) = (lines(&old), lines(&new));
        let (rows, truncated) = build_rows(&a, &b, &diff_ops(&a, &b));
        assert!(!truncated);
        let kinds: Vec<&str> = rows.iter().map(|row| row.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|kind| **kind == "gap").count(), 1);
        let del = rows.iter().find(|row| row.kind == "del").unwrap();
        assert_eq!((del.old_line, del.text.as_str()), (Some(3), "line 3"));
        let add = rows.iter().find(|row| row.kind == "add" && row.text == "extra").unwrap();
        assert_eq!(add.new_line, Some(19));
        assert_eq!(rows.first().unwrap().new_line, Some(1));
        assert_eq!(rows.last().unwrap().new_line, Some(21));
    }

    #[test]
    fn classifies_tests_and_generated_files() {
        assert_eq!(file_kind("src/lib/terminalFileLinks.ts"), "source");
        assert_eq!(file_kind("src/lib/terminalFileLinks.test.ts"), "test");
        assert_eq!(file_kind("tests/api.rs"), "test");
        assert_eq!(file_kind("package-lock.json"), "generated");
        assert_eq!(file_kind("web/dist/app.js"), "generated");
        assert_eq!(file_kind("src/contest.ts"), "source");
    }

    #[test]
    fn relative_path_accepts_absolute_and_relative_forms() {
        let root = Path::new(r"D:\Super High");
        assert_eq!(relative_path(root, r"d:\super high\src\a.ts"), "src/a.ts");
        assert_eq!(relative_path(root, "src/a.ts"), "src/a.ts");
        assert_eq!(relative_path(root, "./src/a.ts"), "src/a.ts");
    }

    fn run_git(root: &Path, args: &[&str]) {
        git(root, args).unwrap();
    }

    #[test]
    fn git_baseline_separates_session_edits_from_earlier_edits() {
        let repo = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = repo.path();
        run_git(root, &["init", "-q"]);
        run_git(root, &["config", "user.email", "test@example.com"]);
        run_git(root, &["config", "user.name", "test"]);
        run_git(root, &["config", "core.autocrlf", "false"]);
        fs::write(root.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        fs::write(root.join("b.txt"), "base\n").unwrap();
        fs::write(root.join("keep.txt"), "keep\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-q", "-m", "init"]);
        // Dirty before the session.
        fs::write(root.join("b.txt"), "base\nearlier\n").unwrap();
        fs::write(root.join("keep.txt"), "keep\nearlier\n").unwrap();

        let prepared = prepare(data.path(), root).unwrap();
        register(data.path(), "git-session", prepared);

        fs::write(root.join("a.txt"), "one\n2\nthree\nfour\n").unwrap();
        fs::write(root.join("b.txt"), "base\nearlier\nsession\n").unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("new.test.ts"), "it()\n").unwrap();

        let changes = session_changes(data.path(), "git-session", root);
        assert!(changes.available, "{:?}", changes.reason);
        assert_eq!(changes.baseline, "session");
        let find = |path: &str| changes.files.iter().find(|file| file.path == path).cloned();
        let a = find("a.txt").unwrap();
        assert_eq!((a.status.as_str(), a.additions, a.deletions, a.pre_session), ("modified", Some(2), Some(1), false));
        // Session edit on top of an earlier edit counts only the session part.
        let b = find("b.txt").unwrap();
        assert_eq!((b.additions, b.deletions, b.pre_session), (Some(1), Some(0), false));
        let keep = find("keep.txt").unwrap();
        assert!(keep.pre_session);
        assert_eq!(keep.additions, Some(1));
        let new = find("src/new.test.ts").unwrap();
        assert_eq!((new.status.as_str(), new.kind.as_str()), ("added", "test"));

        // A commit during the session keeps the committed edit visible.
        run_git(root, &["add", "a.txt"]);
        run_git(root, &["commit", "-q", "-m", "session"]);
        let changes = session_changes(data.path(), "git-session", root);
        assert!(changes.files.iter().any(|file| file.path == "a.txt" && file.additions == Some(2)));

        let diff = session_file_diff(data.path(), "git-session", root, "a.txt").unwrap();
        let kinds: Vec<(&str, &str)> = diff.rows.iter().map(|row| (row.kind.as_str(), row.text.as_str())).collect();
        assert_eq!(kinds, vec![
            ("context", "one"), ("del", "two"), ("add", "2"), ("context", "three"), ("add", "four"),
        ]);
        let diff = session_file_diff(data.path(), "git-session", root, "missing.txt").unwrap();
        assert!(diff.file.is_none());
    }

    #[test]
    fn git_without_baseline_falls_back_to_head() {
        let repo = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = repo.path();
        run_git(root, &["init", "-q"]);
        fs::write(root.join("a.txt"), "x\n").unwrap();
        let changes = session_changes(data.path(), "unknown-session", root);
        assert!(changes.available);
        assert_eq!(changes.baseline, "head");
        assert_eq!(changes.files.len(), 1);
        assert_eq!(changes.files[0].status, "added");
    }

    #[test]
    fn folder_ignored_by_its_parent_repo_uses_a_plain_snapshot() {
        let repo = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = repo.path();
        run_git(root, &["init", "-q"]);
        fs::write(root.join(".gitignore"), "tmp/\n").unwrap();
        let scratch = root.join("tmp").join("demo");
        fs::create_dir_all(&scratch).unwrap();
        fs::write(scratch.join("a.txt"), "one\n").unwrap();

        register(data.path(), "ignored-session", prepare(data.path(), &scratch).unwrap());
        fs::write(scratch.join("a.txt"), "one\ntwo\n").unwrap();

        let changes = session_changes(data.path(), "ignored-session", &scratch);
        assert_eq!(changes.mode, "plain");
        assert_eq!(changes.files.len(), 1);
        assert_eq!((changes.files[0].path.as_str(), changes.files[0].additions), ("a.txt", Some(1)));
    }

    #[test]
    fn plain_directory_tracks_added_modified_and_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("config.yml"), "a: 1\nb: 2\n").unwrap();
        fs::write(root.join("gone.txt"), "bye\n").unwrap();
        fs::create_dir_all(root.join("logs")).unwrap();
        fs::write(root.join("logs").join("latest.txt"), "x").unwrap();

        let prepared = prepare(data.path(), root).unwrap();
        register(data.path(), "plain-session", prepared);

        fs::write(root.join("config.yml"), "a: 1\nb: 3\nc: 4\n").unwrap();
        fs::remove_file(root.join("gone.txt")).unwrap();
        fs::write(root.join("fresh.txt"), "hi\n").unwrap();
        fs::write(root.join("logs").join("latest.txt"), "changed").unwrap();

        let changes = session_changes(data.path(), "plain-session", root);
        assert!(changes.available, "{:?}", changes.reason);
        assert_eq!(changes.mode, "plain");
        let summary: Vec<(&str, &str, Option<u32>, Option<u32>)> = changes
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.status.as_str(), file.additions, file.deletions))
            .collect();
        assert_eq!(summary, vec![
            ("config.yml", "modified", Some(2), Some(1)),
            ("fresh.txt", "added", Some(1), Some(0)),
            ("gone.txt", "deleted", Some(0), Some(1)),
        ]);
        let diff = session_file_diff(data.path(), "plain-session", root, &root.join("config.yml").to_string_lossy()).unwrap();
        assert_eq!(diff.rows.iter().filter(|row| row.kind == "add").count(), 2);
    }
}
