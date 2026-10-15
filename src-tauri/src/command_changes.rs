//! Complete text reconciliation against a baseline captured before turn dispatch.
//! Native command exit codes do not determine whether a filesystem write happened.
use crate::agent_changes::CommittedFileChange;
use crate::command_scope::{parse_powershell_scope, CommandScope};
use anyhow::{bail, Context, Result};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;
const PREPARE_BUDGET: Duration = Duration::from_secs(30);
const REFRESH_BUDGET: Duration = Duration::from_secs(20);

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
}
#[derive(Clone)]
struct Entry {
    stamp: Stamp,
    text: Option<Arc<str>>,
    unsupported: Option<String>,
    fingerprint: Option<[u8; 32]>,
}
type Snapshot = BTreeMap<String, Entry>;
#[derive(Clone)]
pub struct PreparedCommandBaseline {
    snapshot: Arc<Snapshot>,
    scope: Arc<Gitignore>,
    excluded_directories: Arc<BTreeSet<PathBuf>>,
}
impl PreparedCommandBaseline {
    pub fn watches_path(&self, root: &Path, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(root) else {
            return true;
        };
        relative == Path::new(".ignore")
            || (relevant_baseline_path(root, path)
                && !self
                    .scope
                    .matched_path_or_any_parents(path, false)
                    .is_ignore()
                && !self
                    .scope
                    .matched_path_or_any_parents(path, true)
                    .is_ignore()
                && !self
                    .excluded_directories
                    .iter()
                    .any(|p| path != p && path.starts_with(p)))
    }
}
struct Active {
    native: String,
    turn: String,
    baseline: Snapshot,
    current: Snapshot,
    touched: BTreeSet<String>,
    finished: bool,
    scope: Arc<Gitignore>,
    commands: Option<CommandScope>,
    fallback: bool,
    seen_commands: BTreeSet<String>,
}
pub struct CommandChanges {
    cwd: PathBuf,
    prepared: Option<PreparedCommandBaseline>,
    active: Option<Active>,
}
impl CommandChanges {
    pub fn new(cwd: &Path) -> Self {
        Self {
            cwd: cwd.into(),
            prepared: None,
            active: None,
        }
    }
    pub fn has_prepared(&self) -> bool {
        self.prepared.is_some()
    }
    pub fn is_finished(&self) -> bool {
        self.active.as_ref().is_none_or(|a| a.finished)
    }
    pub fn matches(&self, native: &str, turn: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|a| a.native == native && a.turn == turn)
    }
    pub fn prepare(&mut self) -> Result<()> {
        self.prepared = None;
        self.prepare_changed(&[], false)
    }
    /// Background captures reuse file contents, but watcher evidence forces rereads
    /// even when a write preserved the file's size and timestamps.
    pub fn prepare_changed(&mut self, paths: &[PathBuf], reload: bool) -> Result<()> {
        anyhow::ensure!(self.is_finished(), "正在执行的回合不能重新冻结基线");
        // An unsuccessful fresh capture must never leave an older prepared baseline usable.
        let previous = self.prepared.take();
        let cache = (!reload)
            .then(|| {
                previous
                    .as_ref()
                    .map(|p| p.snapshot.as_ref())
                    .or_else(|| self.active.as_ref().map(|a| &a.current))
            })
            .flatten();
        let changed: Vec<_> = paths
            .iter()
            .filter_map(|p| relative_path(&self.cwd, &p.to_string_lossy()))
            .collect();
        let forced = cache
            .into_iter()
            .flat_map(|c| c.keys())
            .filter(|name| {
                changed
                    .iter()
                    .any(|p| *name == p || name.starts_with(&(p.clone() + "/")))
            })
            .cloned()
            .collect();
        let scope = Arc::new(workspace_scope(&self.cwd)?);
        let selection = (cache.is_some()
            && !changed.is_empty()
            && changed.len() == paths.len()
            && !changed.iter().any(|p| p == ".ignore"))
        .then(|| CommandScope {
            files: changed.iter().cloned().collect(),
            prefixes: changed.iter().cloned().collect(),
        });
        let mut excluded_directories = selection
            .as_ref()
            .and_then(|_| previous.as_ref())
            .map(|p| (*p.excluded_directories).clone())
            .unwrap_or_default();
        if let Some(selection) = &selection {
            excluded_directories.retain(|p| {
                relative_path(&self.cwd, &p.to_string_lossy())
                    .is_some_and(|p| !selected(&p, selection))
            });
        }
        let sampled = scan_selected(
            &self.cwd,
            cache,
            &forced,
            &scope,
            selection.as_ref(),
            PREPARE_BUDGET,
            Some(&mut excluded_directories),
        )?;
        let snapshot = if let (Some(selection), Some(cache)) = (&selection, cache) {
            let mut merged = cache.clone();
            merged.retain(|p, _| !selected(p, selection));
            merged.extend(sampled);
            anyhow::ensure!(
                merged
                    .values()
                    .filter_map(|e| e.text.as_ref())
                    .map(|t| t.len())
                    .sum::<usize>()
                    <= MAX_TEXT_BYTES,
                "工作区文本基线超过64MiB，统计不可用"
            );
            merged
        } else {
            sampled
        };
        self.prepared = Some(PreparedCommandBaseline {
            snapshot: Arc::new(snapshot),
            scope,
            excluded_directories: Arc::new(excluded_directories),
        });
        Ok(())
    }
    pub fn prepared_snapshot(&self) -> Result<PreparedCommandBaseline> {
        self.prepared.clone().context("工作区文件基线尚未就绪")
    }
    pub fn use_prepared(&mut self, baseline: PreparedCommandBaseline) -> Result<()> {
        anyhow::ensure!(self.is_finished(), "正在执行的回合不能重新冻结基线");
        self.prepared = Some(baseline);
        Ok(())
    }
    pub fn begin(&mut self, native: &str, turn: &str) -> Result<()> {
        if self.matches(native, turn) {
            return Ok(());
        }
        anyhow::ensure!(self.is_finished(), "上一回合尚未冻结");
        let prepared = self
            .prepared
            .take()
            .context("缺少执行前文件基线，无法统计命令变更")?;
        self.active = Some(Active {
            native: native.into(),
            turn: turn.into(),
            current: (*prepared.snapshot).clone(),
            baseline: (*prepared.snapshot).clone(),
            touched: BTreeSet::new(),
            finished: false,
            scope: prepared.scope,
            commands: None,
            fallback: false,
            seen_commands: BTreeSet::new(),
        });
        Ok(())
    }
    pub fn note_command(&mut self, command: &str, cwd: Option<&str>) -> Result<()> {
        let active = self.active.as_mut().context("缺少当前命令回合")?;
        if active.fallback {
            return Ok(());
        }
        let key = format!("{}\0{command}", cwd.unwrap_or(""));
        if !active.seen_commands.insert(key) {
            return Ok(());
        }
        let cwd = cwd.map(Path::new).unwrap_or(&self.cwd);
        let Some(proof) = parse_powershell_scope(command, cwd) else {
            active.fallback = true;
            return Ok(());
        };
        let mut relative = CommandScope::default();
        for p in proof.files {
            let Some(p) = relative_path(&self.cwd, &p) else {
                active.fallback = true;
                return Ok(());
            };
            relative.files.insert(p);
        }
        for p in proof.prefixes {
            let Some(p) = relative_path(&self.cwd, &p) else {
                active.fallback = true;
                return Ok(());
            };
            relative.prefixes.insert(p);
        }
        let union = active.commands.get_or_insert_with(CommandScope::default);
        union.files.extend(relative.files);
        union.prefixes.extend(relative.prefixes);
        Ok(())
    }
    pub fn refresh(
        &mut self,
        native: &str,
        turn: &str,
        native_paths: &[String],
    ) -> Result<Vec<CommittedFileChange>> {
        anyhow::ensure!(self.matches(native, turn), "文件基线不属于该原生回合");
        let forced: BTreeSet<_> = native_paths
            .iter()
            .filter_map(|p| relative_path(&self.cwd, p))
            .filter(|p| !ignored(Path::new(p), false) && !known_binary(Path::new(p)))
            .collect();
        let active = self.active.as_mut().unwrap();
        let forced: BTreeSet<_> = forced
            .into_iter()
            .filter(|p| !scope_ignored(&self.cwd, Path::new(p), false, &active.scope))
            .collect();
        anyhow::ensure!(!active.finished, "回合已经冻结");
        let mut current = if !active.fallback && active.commands.is_some() {
            let mut selection = active.commands.clone().unwrap();
            selection.files.extend(forced.iter().cloned());
            selection.files.extend(active.touched.iter().cloned());
            let sampled = scan_selected(
                &self.cwd,
                Some(&active.current),
                &forced,
                &active.scope,
                Some(&selection),
                REFRESH_BUDGET,
                None,
            )?;
            let mut merged = active.current.clone();
            merged.retain(|p, _| !selected(p, &selection));
            merged.extend(sampled);
            merged
        } else {
            scan(&self.cwd, Some(&active.current), &forced, &active.scope)?
        };
        // A new small file can change allocation order. Reuse unchanged shared content
        // rather than interpreting budget eviction as a file deletion.
        for (path, entry) in &mut current {
            if !forced.contains(path) {
                if let Some(previous) = active
                    .current
                    .get(path)
                    .filter(|p| p.stamp == entry.stamp && p.unsupported.is_some())
                {
                    entry.text = None;
                    entry.unsupported = previous.unsupported.clone();
                    continue;
                }
            }
            if !forced.contains(path) && entry.unsupported.is_some() {
                if let Some(previous) = active
                    .current
                    .get(path)
                    .filter(|p| p.stamp == entry.stamp && p.text.is_some())
                {
                    entry.text = previous.text.clone();
                    entry.unsupported = None;
                }
            }
        }
        let mut allocations = BTreeSet::new();
        let mut retained = 0usize;
        for entry in active.baseline.values().chain(current.values()) {
            if let Some(text) = &entry.text {
                if allocations.insert(Arc::as_ptr(text) as *const u8 as usize) {
                    retained += text.len();
                }
            }
        }
        anyhow::ensure!(
            retained <= MAX_TEXT_BYTES * 2,
            "本轮保留文本超过128MiB总限制，统计不可用"
        );
        let paths: BTreeSet<_> = active
            .baseline
            .keys()
            .chain(current.keys())
            .chain(active.touched.iter())
            .chain(forced.iter())
            .cloned()
            .collect();
        let mut changes = vec![];
        for path in paths {
            let before = active.baseline.get(&path);
            let after = current.get(&path);
            let before_text = before.and_then(|e| e.text.as_deref());
            let after_text = after.and_then(|e| e.text.as_deref());
            let same_bytes = before
                .and_then(|e| e.fingerprint)
                .is_some_and(|hash| after.and_then(|e| e.fingerprint) == Some(hash));
            if same_bytes {
                if forced.contains(&path) || active.touched.contains(&path) {
                    changes.push(CommittedFileChange {
                        path,
                        before: before_text.map(str::to_owned),
                        after: before_text.map(str::to_owned),
                    });
                }
                continue;
            }
            let metadata_changed = before.map(|e| &e.stamp) != after.map(|e| &e.stamp);
            if metadata_changed || forced.contains(&path) || active.touched.contains(&path) {
                if let Some(reason) = before
                    .and_then(|e| e.unsupported.as_ref())
                    .or_else(|| after.and_then(|e| e.unsupported.as_ref()))
                {
                    bail!("{reason}：{path}，无法确认执行前后文本，统计不可用");
                }
            }
            let changed = before_text != after_text;
            // A binary conversion cannot be shown as a fictitious text deletion/addition.
            if changed
                && (before.is_some_and(|e| e.text.is_none())
                    || after.is_some_and(|e| e.text.is_none()))
            {
                bail!("文件变为非文本或文本基线不完整：{path}");
            }
            if changed {
                active.touched.insert(path.clone());
            }
            if changed || active.touched.contains(&path) || forced.contains(&path) {
                // Native evidence outside our scan scope stays in the core native layer.
                if before.is_none() && after.is_none() && !active.touched.contains(&path) {
                    continue;
                }
                if before_text.is_none() && after_text.is_none() && before.is_some() {
                    continue;
                }
                changes.push(CommittedFileChange {
                    path,
                    before: before_text.map(str::to_owned),
                    after: after_text.map(str::to_owned),
                });
            }
        }
        active.current = current;
        Ok(changes)
    }
    pub fn finish(&mut self, native: &str, turn: &str) {
        if self.matches(native, turn) {
            self.active.as_mut().unwrap().finished = true;
        }
    }
    pub fn resume(&mut self, native: &str, turn: &str) -> Result<()> {
        anyhow::ensure!(
            self.matches(native, turn),
            "不能恢复不匹配的原生回合文件基线"
        );
        self.active.as_mut().unwrap().finished = false;
        Ok(())
    }
}
pub fn relevant_baseline_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return true;
    };
    !ignored(relative, true) && !known_binary(relative)
}
fn relative_path(cwd: &Path, path: &str) -> Option<String> {
    let normalized = path.replace('\\', "/");
    let path = Path::new(&normalized);
    let relative = if path.is_absolute() {
        path.strip_prefix(cwd).ok()?
    } else {
        path
    };
    let mut result = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(p) => result.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!result.as_os_str().is_empty()).then(|| result.to_string_lossy().replace('\\', "/"))
}
fn ignored(path: &Path, directory: bool) -> bool {
    let parts: Vec<_> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(p) => p.to_str(),
            _ => None,
        })
        .collect();
    parts.iter().enumerate().any(|(i, p)| {
        if (directory || i + 1 < parts.len())
            && (p.starts_with("target-")
                || p.starts_with("dist-")
                || p.starts_with("cargo-test-target")
                || p.starts_with(".publish-worktree")
                || p.starts_with(".gradle-")
                || matches!(*p, ".worktrees" | ".cache" | ".gradle" | ".pytest_cache")
                || (*p == "cache"
                    && (i == 0
                        || (i == 1
                            && !matches!(
                                parts[0],
                                "src" | "source" | "sources" | "lib" | "app" | "packages" | "docs"
                            )))))
        {
            return true;
        }
        matches!(
            *p,
            ".git"
                | "node_modules"
                | "target"
                | "dist"
                | "dist-mobile"
                | ".next"
                | ".nuxt"
                | ".venv"
                | "venv"
                | "__pycache__"
        )
    }) || parts
        .windows(2)
        .any(|p| p[0] == ".agent" && matches!(p[1], "cache" | "logs"))
        || (!directory
            && path
                .extension()
                .and_then(|p| p.to_str())
                .is_some_and(|ext| {
                    matches!(ext.to_ascii_lowercase().as_str(), "log" | "pid" | "lock")
                })
            && !parts.last().is_some_and(|name| {
                matches!(
                    *name,
                    "Cargo.lock"
                        | "yarn.lock"
                        | "bun.lock"
                        | "composer.lock"
                        | "Gemfile.lock"
                        | "Pipfile.lock"
                        | "poetry.lock"
                        | "uv.lock"
                )
            }))
}
fn known_binary(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "exe"
                | "dll"
                | "pdb"
                | "lib"
                | "obj"
                | "o"
                | "a"
                | "so"
                | "dylib"
                | "zip"
                | "7z"
                | "rar"
                | "gz"
                | "jar"
                | "class"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "ico"
                | "pdf"
                | "mp3"
                | "mp4"
                | "wav"
                | "ogg"
                | "woff"
                | "woff2"
                | "ttf"
                | "db"
                | "sqlite"
                | "sqlite3"
                | "bin"
        )
    })
}
fn reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}
fn stamp(meta: &fs::Metadata) -> Stamp {
    Stamp {
        len: meta.len(),
        modified: meta.modified().ok(),
        created: meta.created().ok(),
    }
}
fn validate_root(root: &Path) -> Result<()> {
    for ancestor in root.ancestors() {
        if !ancestor.as_os_str().is_empty() {
            anyhow::ensure!(
                !reparse(&fs::symlink_metadata(ancestor)?),
                "工作区包含链接祖先，禁止读取外部目录"
            );
        }
    }
    let meta = fs::symlink_metadata(root)
        .with_context(|| format!("无法读取工作区基线：{}", root.display()))?;
    anyhow::ensure!(
        meta.is_dir() && !reparse(&meta),
        "工作区根目录不是普通目录，禁止跟随链接"
    );
    Ok(())
}
fn scope_ignored(root: &Path, relative: &Path, directory: bool, scope: &Gitignore) -> bool {
    // User command probes in the root .agent/tmp remain visible even if search hides .agent.
    if relative == Path::new(".agent") || relative.starts_with(".agent/tmp") {
        return false;
    }
    if relative.starts_with(".agent") {
        return scope
            .matched_path_or_any_parents(root.join(relative), directory)
            .is_ignore();
    }
    scope.matched(root.join(relative), directory).is_ignore()
}
fn workspace_scope(root: &Path) -> Result<Gitignore> {
    validate_root(root)?;
    let path = root.join(".ignore");
    let mut builder = GitignoreBuilder::new(root);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() && !reparse(&meta) => {
            if let Some(error) = builder.add(&path) {
                return Err(error).context("无法解析工作区.ignore，统计不可用");
            }
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).context("无法读取工作区.ignore，统计不可用"),
    }
    builder.build().context("无法构建工作区.ignore范围")
}
fn scan(
    root: &Path,
    cache: Option<&Snapshot>,
    forced: &BTreeSet<String>,
    scope: &Gitignore,
) -> Result<Snapshot> {
    scan_selected(root, cache, forced, scope, None, REFRESH_BUDGET, None)
}
fn selected(path: &str, scope: &CommandScope) -> bool {
    scope.files.contains(path)
        || scope
            .prefixes
            .iter()
            .any(|p| path == p || path.starts_with(&(p.trim_end_matches('/').to_owned() + "/")))
}
#[derive(Default)]
struct BrowserMarkers {
    local_state: bool,
    preferences: bool,
    network: bool,
    runtime_dirs: usize,
    children: Vec<String>,
}
impl BrowserMarkers {
    fn note(&mut self, name: &str, kind: fs::FileType) {
        if kind.is_symlink() {
            return;
        }
        if kind.is_file() {
            match name {
                "Local State" => self.local_state = true,
                "Preferences" => self.preferences = true,
                _ => {}
            }
        }
        if kind.is_dir() {
            if matches!(
                name,
                "Network"
                    | "Cache"
                    | "Code Cache"
                    | "GPUCache"
                    | "IndexedDB"
                    | "Local Storage"
                    | "WebStorage"
                    | "blob_storage"
            ) {
                self.runtime_dirs += 1;
            }
            if name == "Network" {
                self.network = true;
            }
            if name == "Default" || name.starts_with("Profile ") {
                self.children.push(name.into());
            }
        }
    }
    fn confirmed(&self, path: &Path) -> bool {
        let plain_file =
            |p: PathBuf| fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && !reparse(&m));
        if self.local_state && self.preferences && self.runtime_dirs > 0 {
            return true;
        }
        if self.preferences
            && self.network
            && (self.runtime_dirs >= 2
                || plain_file(path.join("Network/Cookies"))
                || plain_file(path.join("Network/Cookies-journal")))
        {
            return true;
        }
        self.local_state
            && self.children.iter().any(|name| {
                let child = path.join(name);
                fs::symlink_metadata(&child).is_ok_and(|m| m.is_dir() && !reparse(&m))
                    && plain_file(child.join("Preferences"))
            })
    }
}
fn browser_profile_root(root: &Path, path: &Path) -> Option<PathBuf> {
    let plain_file =
        |p: PathBuf| fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && !reparse(&m));
    for dir in path.ancestors() {
        if !dir.starts_with(root) {
            break;
        }
        if plain_file(dir.join("Preferences"))
            && fs::symlink_metadata(dir.join("Network")).is_ok_and(|m| m.is_dir() && !reparse(&m))
        {
            if plain_file(dir.join("Local State"))
                || plain_file(dir.join("Network/Cookies"))
                || plain_file(dir.join("Network/Cookies-journal"))
            {
                return Some(dir.to_path_buf());
            }
        }
        if plain_file(dir.join("Local State")) && plain_file(dir.join("Default/Preferences")) {
            return Some(dir.to_path_buf());
        }
        if dir == root {
            break;
        }
    }
    None
}
fn scan_selected(
    root: &Path,
    cache: Option<&Snapshot>,
    forced: &BTreeSet<String>,
    scope: &Gitignore,
    selection: Option<&CommandScope>,
    budget: Duration,
    mut exclusions: Option<&mut BTreeSet<PathBuf>>,
) -> Result<Snapshot> {
    let started = Instant::now();
    validate_root(root)?;
    let mut stack = selection
        .map(|s| s.prefixes.iter().map(PathBuf::from).collect::<Vec<_>>())
        .unwrap_or_else(|| vec![PathBuf::new()]);
    let mut result = Snapshot::new();
    let mut count = 0usize;
    let mut candidates = Vec::new();
    if let Some(selection) = selection {
        for name in &selection.files {
            let relative = Path::new(name);
            if ignored(relative, false)
                || known_binary(relative)
                || scope_ignored(root, relative, false, scope)
            {
                continue;
            }
            let path = root.join(relative);
            if let Some(profile) = browser_profile_root(root, &path) {
                if let Some(exclusions) = &mut exclusions {
                    exclusions.insert(profile);
                }
                continue;
            }
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e).context("无法读取命令目标元数据"),
            };
            if !meta.is_file() || reparse(&meta) {
                continue;
            }
            if let Some(parent) = path.parent() {
                validate_root(parent)?;
            }
            candidates.push((name.clone(), path, stamp(&meta)));
        }
    }
    while let Some(relative_dir) = stack.pop() {
        if selection.is_some_and(|s| {
            s.prefixes
                .contains(&relative_dir.to_string_lossy().replace('\\', "/"))
        }) {
            let path = root.join(&relative_dir);
            if let Some(profile) = browser_profile_root(root, &path) {
                if let Some(exclusions) = &mut exclusions {
                    exclusions.insert(profile);
                }
                continue;
            }
            let meta = match fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e).context("无法读取命令目录元数据"),
            };
            if !meta.is_dir()
                || reparse(&meta)
                || ignored(&relative_dir, true)
                || scope_ignored(root, &relative_dir, true, scope)
            {
                continue;
            }
            validate_root(&path)?;
        }
        let candidate_start = candidates.len();
        let stack_start = stack.len();
        let mut browser = BrowserMarkers::default();
        for entry in fs::read_dir(root.join(&relative_dir))
            .with_context(|| format!("无法完整对账目录：{}", relative_dir.display()))?
        {
            let entry = entry?;
            let relative = relative_dir.join(entry.file_name());
            anyhow::ensure!(
                started.elapsed() < budget,
                "工作区完整对账超过{}秒，统计不可用",
                budget.as_secs()
            );
            // Windows directory enumeration already supplies the file type.
            // Reject noise before any additional filesystem metadata operation.
            let kind = entry.file_type()?;
            browser.note(&entry.file_name().to_string_lossy(), kind);
            if kind.is_symlink() || ignored(&relative, kind.is_dir()) {
                continue;
            }
            if !kind.is_dir() && (!kind.is_file() || known_binary(&relative)) {
                continue;
            }
            let path = entry.path();
            if scope_ignored(root, &relative, kind.is_dir(), scope) {
                continue;
            }
            // On Windows this reuses enumeration metadata instead of reopening each entry.
            // DirEntry::metadata does not follow symlinks.
            let meta = entry.metadata()?;
            if reparse(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push(relative);
                continue;
            }
            if !meta.is_file() || known_binary(&relative) {
                continue;
            }
            count += 1;
            anyhow::ensure!(
                count <= MAX_ENTRIES,
                "工作区受监测文件超过{MAX_ENTRIES}项，统计不可用"
            );
            let name = relative
                .to_str()
                .context("工作区路径不是有效Unicode，无法精确统计")?
                .replace('\\', "/");
            candidates.push((name, path, stamp(&meta)));
        }
        // Identify Chromium by profile metadata, not the task/folder name.
        // No Cookies/database bytes are opened, including extensionless journals.
        let directory = root.join(&relative_dir);
        if browser.confirmed(&directory) {
            if let Some(exclusions) = &mut exclusions {
                exclusions.insert(directory.clone());
            }
            candidates.truncate(candidate_start);
            stack.truncate(stack_start);
            candidates.retain(|(_, p, _)| !p.starts_with(&directory));
            stack.retain(|p| !root.join(p).starts_with(&directory));
        }
    }
    // Small source/config/probe files get complete baselines before large assets.
    // Stable allocation prevents a traversal-order change from evicting tiny files.
    candidates.sort_by(|a, b| a.2.len.cmp(&b.2.len).then_with(|| a.0.cmp(&b.0)));
    candidates.dedup_by(|a, b| a.0 == b.0);
    let mut reserved = 0usize;
    let mut reads = Vec::new();
    for (name, path, initial_stamp) in candidates {
        let cached = cache.and_then(|c| c.get(&name)).filter(|c| {
            initial_stamp.modified.is_some() && c.stamp == initial_stamp && !forced.contains(&name)
        });
        if let Some(binary) = cached.filter(|c| c.text.is_none() && c.unsupported.is_none()) {
            result.insert(name, binary.clone());
            continue;
        }
        let size = initial_stamp.len as usize;
        let reason = if initial_stamp.len > MAX_FILE_BYTES {
            Some(format!(
                "文件超过单文件{}MiB文本限制",
                MAX_FILE_BYTES / 1024 / 1024
            ))
        } else if reserved.saturating_add(size) > MAX_TEXT_BYTES {
            Some(format!(
                "工作区文本基线超过{}MiB总限制",
                MAX_TEXT_BYTES / 1024 / 1024
            ))
        } else {
            None
        };
        if let Some(reason) = reason {
            if initial_stamp.len <= MAX_FILE_BYTES {
                if let Some(cached) = cached.filter(|c| c.fingerprint.is_some()) {
                    result.insert(
                        name,
                        Entry {
                            stamp: initial_stamp,
                            text: None,
                            unsupported: Some(reason),
                            fingerprint: cached.fingerprint,
                        },
                    );
                } else {
                    reads.push((name, path, initial_stamp, false, Some(reason)));
                }
                continue;
            }
            result.insert(
                name,
                Entry {
                    stamp: initial_stamp,
                    text: None,
                    unsupported: Some(reason),
                    fingerprint: None,
                },
            );
            continue;
        }
        reserved += size;
        if let Some(cached) = cached.filter(|c| c.fingerprint.is_some()) {
            result.insert(name, cached.clone());
        } else {
            reads.push((name, path, initial_stamp, true, None));
        }
    }
    // Bound concurrent filesystem reads. Windows antivirus/open latency dominates cold captures.
    let next = std::sync::atomic::AtomicUsize::new(0);
    let batches = std::thread::scope(|scope| {
        let readers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(4, 8);
        let handles: Vec<_> = (0..readers.min(reads.len()))
            .map(|_| {
                scope.spawn(|| -> Result<Vec<(String, Entry)>> {
                    let mut batch = Vec::new();
                    loop {
                        let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((name, path, initial_stamp, retain, reason)) = reads.get(index)
                        else {
                            break;
                        };
                        anyhow::ensure!(
                            started.elapsed() < budget,
                            "工作区完整对账超过{}秒，统计不可用",
                            budget.as_secs()
                        );
                        let read = read_entry(
                            path,
                            name,
                            initial_stamp,
                            started + budget,
                            *retain,
                            budget,
                        );
                        let entry = match read {
                            Ok(mut entry) => {
                                entry.unsupported = reason.clone();
                                entry
                            }
                            Err(error) => {
                                anyhow::ensure!(
                                    started.elapsed() < budget,
                                    "工作区完整对账超过{}秒，统计不可用",
                                    budget.as_secs()
                                );
                                // Metadata was enumerated. Preserve uncertainty until this path
                                // changes or is explicitly attributed, never invent raw before.
                                let observed = fs::symlink_metadata(path)
                                    .ok()
                                    .filter(|m| m.is_file() && !reparse(m))
                                    .map(|m| stamp(&m))
                                    .unwrap_or_else(|| initial_stamp.clone());
                                Entry {
                                    stamp: observed,
                                    text: None,
                                    fingerprint: None,
                                    unsupported: Some(format!("无法完整读取原文：{error}")),
                                }
                            }
                        };
                        batch.push((name.clone(), entry));
                    }
                    Ok(batch)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .map_err(|_| anyhow::anyhow!("文本基线读取线程异常"))?
            })
            .collect::<Result<Vec<_>>>()
    })?;
    for batch in batches {
        result.extend(batch);
    }
    // Files may grow after enumeration. Account actual stable bytes, not reservations.
    let actual_text_bytes: usize = result
        .values()
        .filter_map(|e| e.text.as_ref())
        .map(|t| t.len())
        .sum();
    anyhow::ensure!(
        actual_text_bytes <= MAX_TEXT_BYTES,
        "稳定读取文本超过64MiB总限制，统计不可用"
    );
    anyhow::ensure!(
        started.elapsed() < budget,
        "工作区完整对账超过{}秒，统计不可用",
        budget.as_secs()
    );
    Ok(result)
}

fn read_entry(
    path: &Path,
    name: &str,
    initial_stamp: &Stamp,
    deadline: Instant,
    retain: bool,
    budget: Duration,
) -> Result<Entry> {
    let started = Instant::now();
    let mut last_error = None;
    for attempt in 0..3 {
        anyhow::ensure!(
            Instant::now() < deadline,
            "工作区完整对账超过{}秒，统计不可用",
            budget.as_secs()
        );
        if attempt > 0 {
            if started.elapsed() >= Duration::from_millis(200) {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let read = (|| -> Result<Entry> {
            let before = fs::symlink_metadata(path)?;
            anyhow::ensure!(
                before.is_file() && !reparse(&before),
                "文本路径不是普通文件，禁止跟随链接：{name}"
            );
            let actual_stamp = stamp(&before);
            // Enumeration already validated directory links. Revalidate the chain when
            // adopting a newer file revision or retrying an in-flight replacement.
            if attempt > 0 || actual_stamp != *initial_stamp {
                if let Some(parent) = path.parent() {
                    validate_root(parent)?;
                }
            }
            anyhow::ensure!(
                actual_stamp.len <= MAX_FILE_BYTES,
                "文件超过单文件{}MiB文本限制：{name}，统计不可用",
                MAX_FILE_BYTES / 1024 / 1024
            );
            let mut options = fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.custom_flags(0x00200000);
            }
            let mut file = options
                .open(path)
                .with_context(|| format!("无法读取文本基线：{name}"))?;
            let opened = file.metadata()?;
            anyhow::ensure!(
                opened.is_file() && !reparse(&opened) && stamp(&opened) == actual_stamp,
                "文件在读取基线时变化：{name}"
            );
            let mut bytes = Vec::with_capacity(if retain { actual_stamp.len as usize } else { 0 });
            let mut hasher = Sha256::new();
            let mut count = 0u64;
            let mut buffer = [0u8; 64 * 1024];
            let mut limited = file.by_ref().take(MAX_FILE_BYTES + 1);
            loop {
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "工作区完整对账超过{}秒，统计不可用",
                    budget.as_secs()
                );
                let size = limited.read(&mut buffer)?;
                if size == 0 {
                    break;
                }
                count += size as u64;
                hasher.update(&buffer[..size]);
                if retain {
                    bytes.extend_from_slice(&buffer[..size]);
                }
            }
            let handle_after = file.metadata()?;
            let path_after = fs::symlink_metadata(path)?;
            anyhow::ensure!(
                !reparse(&handle_after)
                    && !reparse(&path_after)
                    && stamp(&handle_after) == actual_stamp
                    && stamp(&path_after) == actual_stamp
                    && count == actual_stamp.len,
                "文件在读取基线时变化：{name}"
            );
            anyhow::ensure!(
                count <= MAX_FILE_BYTES,
                "文件超过单文件{}MiB文本限制：{name}，统计不可用",
                MAX_FILE_BYTES / 1024 / 1024
            );
            let text = if !retain || bytes.contains(&0) || std::str::from_utf8(&bytes).is_err() {
                None
            } else {
                Some(Arc::<str>::from(String::from_utf8(bytes)?))
            };
            Ok(Entry {
                stamp: actual_stamp,
                text,
                unsupported: None,
                fingerprint: Some(hasher.finalize().into()),
            })
        })();
        match read {
            Ok(entry) => return Ok(entry),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("文件未在读取预算内稳定：{name}")))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changes_created_deleted_and_next_turn_created() {
        let root = tempfile::tempdir().unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("native", "one").unwrap();
        fs::create_dir_all(root.path().join(".agent/tmp/case")).unwrap();
        let file = root.path().join(".agent/tmp/case/change.txt");
        fs::write(&file, "line\n").unwrap();
        let created = tracker.refresh("native", "one", &[]).unwrap();
        assert_eq!(created[0].before, None);
        fs::remove_file(&file).unwrap();
        let deleted = tracker.refresh("native", "one", &[]).unwrap();
        assert_eq!(deleted[0].before, deleted[0].after);
        tracker.finish("native", "one");
        tracker.prepare().unwrap();
        tracker.begin("native", "two").unwrap();
        fs::write(file, "next\n").unwrap();
        let next = tracker.refresh("native", "two", &[]).unwrap();
        assert_eq!(next[0].after.as_deref(), Some("next\n"));
        assert!(next[0].before.is_none());
    }
    #[test]
    fn changes_restore_and_nonzero_command_write() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("x.txt");
        fs::write(&path, "before\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("native", "turn").unwrap();
        // Writes remain real when their containing command subsequently fails.
        fs::write(&path, "committed before failure\n").unwrap();
        assert_ne!(
            tracker.refresh("native", "turn", &[]).unwrap()[0].before,
            Some("committed before failure\n".into())
        );
        tracker.begin("native", "turn").unwrap();
        fs::write(path, "before\n").unwrap();
        let restored = tracker.refresh("native", "turn", &[]).unwrap();
        assert_eq!(restored[0].before, restored[0].after);
    }
    #[test]
    fn changes_limits_fail_and_noise_is_excluded() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".agent/cache")).unwrap();
        fs::write(
            root.path().join(".agent/cache/huge.txt"),
            vec![b'x'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        fs::write(
            root.path().join("huge.txt"),
            vec![b'x'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        assert!(tracker
            .refresh("n", "t", &[])
            .unwrap_err()
            .to_string()
            .contains("单文件"));
    }
    #[test]
    fn changes_native_forces_unchanged_override() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("x.txt"), "same\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        let unchanged = tracker.refresh("n", "t", &["x.txt".into()]).unwrap();
        assert_eq!(unchanged[0].before, unchanged[0].after);
        assert!(relative_path(root.path(), "../outside").is_none());
    }
    #[test]
    fn changes_utf8_bom_crlf_and_deleted_baseline() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("powershell.txt");
        fs::write(&path, b"\xef\xbb\xbfbefore\r\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        fs::write(&path, b"\xef\xbb\xbfafter\r\n").unwrap();
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert_eq!(changes[0].before.as_deref(), Some("\u{feff}before\r\n"));
        assert_eq!(changes[0].after.as_deref(), Some("\u{feff}after\r\n"));
        fs::remove_file(path).unwrap();
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert!(changes[0].after.is_none());
        assert!(changes[0].before.is_some());
    }
    #[test]
    fn changes_unchanged_oversize_baseline_is_metadata_only_until_modified() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("large.txt");
        fs::write(&path, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        assert!(tracker.refresh("n", "t", &[]).unwrap().is_empty());
        fs::write(path, "small replacement\n").unwrap();
        assert!(tracker
            .refresh("n", "t", &[])
            .unwrap_err()
            .to_string()
            .contains("单文件"));
    }
    #[test]
    fn changes_total_budget_never_silently_hides_modified_file() {
        let root = tempfile::tempdir().unwrap();
        let block = vec![b'x'; MAX_FILE_BYTES as usize];
        for i in 0..=MAX_TEXT_BYTES / MAX_FILE_BYTES as usize {
            fs::write(root.path().join(format!("{i}.txt")), &block).unwrap();
        }
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        let unsupported = tracker
            .active
            .as_ref()
            .unwrap()
            .baseline
            .iter()
            .find(|(_, e)| e.unsupported.is_some())
            .unwrap()
            .0
            .clone();
        fs::write(root.path().join(unsupported), "modified outside budget\n").unwrap();
        assert!(tracker
            .refresh("n", "t", &[])
            .unwrap_err()
            .to_string()
            .contains("总限制"));
    }
    #[test]
    fn changes_build_noise_and_source_lockfiles_are_distinct() {
        for path in [
            "src-tauri/target-script-tools-staging/source.rs",
            "src-tauri/cargo-test-target-new/source.rs",
            ".publish-worktree-new/README.md",
            ".worktrees/private/README.md",
            ".agent/cache/native.log",
            "server.log",
            "run.pid",
            "collector.lock",
            "WorldGuard/cache/generated.json",
            "Blockbench/dist-web/generated.js",
            "Orryx源码/Orryx-2.39.103/.gradle-user-home/daemon/8.14.4/registry.bin",
        ] {
            assert!(ignored(Path::new(path), false), "{path}");
        }
        for path in [
            ".agent/tmp/change-detection-20261013/change-detection.txt",
            "src-tauri/Cargo.lock",
            "package-lock.json",
            "yarn.lock",
            "src/target-state.ts",
            "src/cache/service.ts",
            "src/main/java/pkg/cache/Entry.java",
        ] {
            assert!(!ignored(Path::new(path), false), "{path}");
        }
        assert!(known_binary(Path::new("registry.bin")));
    }
    #[test]
    fn changes_resume_keeps_original_baseline_and_rejects_other_turn() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("x.txt");
        fs::write(&path, "original\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("native", "turn").unwrap();
        fs::write(&path, "first\n").unwrap();
        tracker.refresh("native", "turn", &[]).unwrap();
        tracker.finish("native", "turn");
        assert!(tracker.resume("other", "turn").is_err());
        assert!(tracker.resume("native", "other").is_err());
        assert!(tracker.is_finished());
        tracker.resume("native", "turn").unwrap();
        fs::write(path, "continued\n").unwrap();
        let changes = tracker.refresh("native", "turn", &[]).unwrap();
        assert_eq!(changes[0].before.as_deref(), Some("original\n"));
        assert_eq!(changes[0].after.as_deref(), Some("continued\n"));
    }
    #[test]
    fn changes_ignore_scope_is_frozen_and_agent_tmp_stays_visible() {
        let root = tempfile::tempdir().unwrap();
        let rules = root.path().join(".ignore");
        fs::write(&rules, "/ignored/\n/.agent/\n").unwrap();
        for dir in ["ignored", "watched", ".agent/tmp/probe"] {
            fs::create_dir_all(root.path().join(dir)).unwrap();
            fs::write(root.path().join(dir).join("x.txt"), "before\n").unwrap();
        }
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        fs::write(&rules, "/watched/\n/.agent/\n").unwrap();
        for dir in ["ignored", "watched", ".agent/tmp/probe"] {
            fs::write(root.path().join(dir).join("x.txt"), "after\n").unwrap();
        }
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert!(changes.iter().any(|c| c.path == "watched/x.txt"));
        assert!(changes.iter().any(|c| c.path == ".agent/tmp/probe/x.txt"));
        assert!(!changes.iter().any(|c| c.path == "ignored/x.txt"));
    }
    #[test]
    fn changes_full_budget_new_small_file_does_not_evict_unchanged_content() {
        let root = tempfile::tempdir().unwrap();
        let block = vec![b'x'; MAX_FILE_BYTES as usize];
        for i in 0..MAX_TEXT_BYTES / MAX_FILE_BYTES as usize {
            fs::write(root.path().join(format!("{i}.txt")), &block).unwrap();
        }
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "one").unwrap();
        let small = root.path().join("small.txt");
        fs::write(&small, "one line\n").unwrap();
        let changes = tracker.refresh("n", "one", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "small.txt");
        fs::remove_file(small).unwrap();
        let changes = tracker.refresh("n", "one", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].before, changes[0].after);
        tracker.finish("n", "one");
        tracker.prepare().unwrap();
        tracker.begin("n", "two").unwrap();
        assert!(tracker.refresh("n", "two", &[]).unwrap().is_empty());
    }
    #[test]
    fn changes_stable_revision_after_enumeration_is_captured_as_actual_before() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("gradle.properties");
        fs::write(&path, "old\n").unwrap();
        let enumerated = stamp(&fs::symlink_metadata(&path).unwrap());
        fs::write(&path, "updated before dispatch\r\n").unwrap();
        let captured = read_entry(
            &path,
            "gradle.properties",
            &enumerated,
            Instant::now() + Duration::from_secs(20),
            true,
            REFRESH_BUDGET,
        )
        .unwrap();
        assert_eq!(
            captured.text.as_deref(),
            Some("updated before dispatch\r\n")
        );
        assert_eq!(captured.stamp.len, 25);
        assert!(captured.stamp == stamp(&fs::symlink_metadata(&path).unwrap()));
        fs::write(&path, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        assert!(read_entry(
            &path,
            "gradle.properties",
            &enumerated,
            Instant::now() + Duration::from_secs(20),
            true,
            REFRESH_BUDGET
        )
        .err()
        .unwrap()
        .to_string()
        .contains("单文件"));
    }
    #[test]
    fn changes_budget_hash_distinguishes_same_rewrite_and_real_change() {
        let root = tempfile::tempdir().unwrap();
        let block = vec![b'x'; MAX_FILE_BYTES as usize];
        for i in 0..=MAX_TEXT_BYTES / MAX_FILE_BYTES as usize {
            fs::write(root.path().join(format!("{i}.txt")), &block).unwrap();
        }
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        let path = tracker
            .active
            .as_ref()
            .unwrap()
            .baseline
            .iter()
            .find(|(_, e)| e.unsupported.is_some())
            .unwrap()
            .0
            .clone();
        assert!(tracker.active.as_ref().unwrap().baseline[&path]
            .fingerprint
            .is_some());
        let file = root.path().join(&path);
        fs::write(&file, &block).unwrap();
        // Force a fresh read independently of filesystem timestamp resolution.
        let changes = tracker
            .refresh("n", "t", std::slice::from_ref(&path))
            .unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].before, changes[0].after);
        fs::write(root.path().join("probe.txt"), "one line\n").unwrap();
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "probe.txt");
        fs::write(file, "actual new content\n").unwrap();
        assert!(tracker
            .refresh("n", "t", std::slice::from_ref(&path))
            .is_err());
    }
    fn ps(script: &str) -> String {
        shlex::try_join([
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            "-NoProfile",
            "-Command",
            script,
        ])
        .unwrap()
    }
    #[test]
    fn changes_exact_command_union_excludes_external_unsupported_changes() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("external.json"), "original\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        // The baseline fingerprint is real; simulate raw-text eviction at the memory boundary.
        let active = tracker.active.as_mut().unwrap();
        for snapshot in [&mut active.baseline, &mut active.current] {
            let entry = snapshot.get_mut("external.json").unwrap();
            entry.text = None;
            entry.unsupported = Some("预算未保留原文".into());
        }
        fs::write(root.path().join("external.json"), "external real change\n").unwrap();
        let first = ps("$p=Join-Path (Get-Location) 'one.txt'; [IO.File]::WriteAllText($p,'one')");
        tracker.note_command(&first, None).unwrap();
        tracker.note_command(&first, None).unwrap();
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$p=Join-Path (Get-Location) 'one.txt'; [IO.File]::WriteAllText($p,'one')",
            ])
            .current_dir(root.path())
            .output()
            .unwrap()
            .status;
        assert!(status.success());
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "one.txt");
        tracker
            .note_command(
                &ps("Set-Content -LiteralPath 'two.txt' -Value 'two'; exit 7"),
                None,
            )
            .unwrap();
        let status = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Set-Content -LiteralPath 'two.txt' -Value 'two'; exit 7",
            ])
            .current_dir(root.path())
            .output()
            .unwrap()
            .status;
        assert_eq!(status.code(), Some(7));
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert_eq!(changes.len(), 2);
        assert!(!changes.iter().any(|c| c.path == "external.json"));
        tracker
            .note_command(&ps("Remove-Item -LiteralPath 'one.txt'"), None)
            .unwrap();
        fs::remove_file(root.path().join("one.txt")).unwrap();
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert!(changes
            .iter()
            .any(|c| c.path == "one.txt" && c.before == c.after));
        tracker.note_command("unknown.exe", None).unwrap();
        assert!(tracker.refresh("n", "t", &[]).is_err());
    }
    #[test]
    fn changes_read_only_exact_scope_still_tracks_native_paths() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("native.txt"), "old\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        tracker
            .note_command(&ps("Get-Content -LiteralPath 'native.txt'"), None)
            .unwrap();
        fs::write(root.path().join("native.txt"), "new\n").unwrap();
        assert!(tracker.refresh("n", "t", &[]).unwrap().is_empty());
        let changes = tracker.refresh("n", "t", &["native.txt".into()]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].after.as_deref(), Some("new\n"));
    }
    #[test]
    fn changes_chromium_profile_markers_exclude_runtime_not_plain_tmp_text() {
        let root = tempfile::tempdir().unwrap();
        let browser = root.path().join(".agent/tmp/unrelated-name/browser-state");
        for dir in ["Network", "GPUCache"] {
            fs::create_dir_all(browser.join(dir)).unwrap();
        }
        for name in ["Local State", "Preferences", "Network/Cookies-journal"] {
            fs::write(browser.join(name), "runtime fixture").unwrap();
        }
        let ordinary = root.path().join(".agent/tmp/plain-user-data");
        fs::create_dir_all(&ordinary).unwrap();
        fs::write(ordinary.join("Preferences"), "ordinary source\n").unwrap();
        fs::write(ordinary.join("Cookies-journal"), "ordinary text\n").unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        assert!(!tracker
            .active
            .as_ref()
            .unwrap()
            .baseline
            .keys()
            .any(|p| p.contains("browser-state")));
        assert!(tracker
            .active
            .as_ref()
            .unwrap()
            .baseline
            .contains_key(".agent/tmp/plain-user-data/Cookies-journal"));
        fs::write(browser.join("Network/Cookies-journal"), "runtime changed").unwrap();
        fs::write(ordinary.join("Cookies-journal"), "source changed\n").unwrap();
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].path,
            ".agent/tmp/plain-user-data/Cookies-journal"
        );
        let runtime = ".agent/tmp/unrelated-name/browser-state/Network/Cookies-journal".to_owned();
        let changes = tracker.refresh("n", "t", &[runtime]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes[0].path,
            ".agent/tmp/plain-user-data/Cookies-journal"
        );
    }
    #[cfg(windows)]
    #[test]
    fn changes_locked_plain_text_retains_unknown_before_and_does_not_block_exact_other_target() {
        use std::io::Write;
        use std::os::windows::fs::OpenOptionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("locked.txt");
        fs::write(&path, "before\n").unwrap();
        let mut lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let mut tracker = CommandChanges::new(root.path());
        tracker.prepare().unwrap();
        tracker.begin("n", "t").unwrap();
        assert!(tracker.active.as_ref().unwrap().baseline["locked.txt"]
            .unsupported
            .is_some());
        tracker
            .note_command(
                &ps("Set-Content -LiteralPath 'owned.txt' -Value 'owned'"),
                None,
            )
            .unwrap();
        fs::write(root.path().join("owned.txt"), "owned\n").unwrap();
        let changes = tracker.refresh("n", "t", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "owned.txt");
        lock.write_all(b"updated while locked\n").unwrap();
        lock.sync_all().unwrap();
        assert!(tracker.refresh("n", "t", &["locked.txt".into()]).is_err());
        drop(lock);
    }
}
