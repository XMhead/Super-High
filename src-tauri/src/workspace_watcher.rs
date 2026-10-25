use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use anyhow::Context;
use notify::{
    event::{ModifyKind, RenameMode},
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use tauri::{AppHandle, Emitter};

use crate::{
    fs_ops::normalize_path,
    models::{WorkspaceFilesChangedEvent, WorkspaceWatchTarget},
};

const IGNORED_WATCH_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "logs",
    ".superhigh",
    "coverage",
    ".vite",
    ".turbo",
    ".next",
    "out",
    "skills-backup",
];

const WATCHABLE_SUPERHIGH_DIRS: &[&str] = &[".superhigh"];
const WATCHABLE_SUPERHIGH_EDITOR_DIR: &str = ".superhigh/editor";
const WORKSPACE_WATCH_DEBOUNCE_MS: u64 = 200;
const WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT: usize = 512;

pub struct WorkspaceWatcherManager {
    watchers: Mutex<HashMap<String, WorkspaceWatcher>>,
    sequence: Arc<AtomicU64>,
}

struct WorkspaceWatcher {
    watcher: RecommendedWatcher,
    directories: BTreeSet<String>,
    visible_directories: VisibleDirectories,
}

/// Directories the explorer currently shows (expanded nodes and open tab
/// parents). Changes inside ignored directories still pass when they are
/// visible, so the tree never shows stale entries.
type VisibleDirectories = Arc<Mutex<BTreeSet<String>>>;

#[derive(Default)]
struct PendingWorkspaceChangeState {
    pending: Option<PendingWorkspaceChange>,
    scheduled: bool,
}

struct PendingWorkspaceChange {
    changed_paths: BTreeSet<String>,
    affected_directories: BTreeSet<String>,
    kind: Option<String>,
}

impl PendingWorkspaceChange {
    fn new(kind: &str, changed_paths: Vec<String>, affected_directories: Vec<String>) -> Self {
        let mut pending = Self {
            changed_paths: BTreeSet::new(),
            affected_directories: BTreeSet::new(),
            kind: None,
        };
        pending.merge(kind, changed_paths, affected_directories);
        pending
    }

    fn merge(&mut self, kind: &str, changed_paths: Vec<String>, affected_directories: Vec<String>) {
        if self.kind.as_deref() == Some("rescan") {
            return;
        }
        merge_watch_kind(&mut self.kind, kind);
        extend_limited_paths(&mut self.changed_paths, changed_paths);
        extend_limited_paths(&mut self.affected_directories, affected_directories);
        if kind == "rescan"
            || self.changed_paths.len() > WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT
            || self.affected_directories.len() > WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT
        {
            self.kind = Some("rescan".to_string());
            self.changed_paths.clear();
            self.affected_directories.clear();
        }
    }

    fn into_event(self, root_path: String, sequence: u64) -> WorkspaceFilesChangedEvent {
        let rescan = self.kind.as_deref() == Some("rescan");
        WorkspaceFilesChangedEvent {
            changed_paths: if rescan { vec![root_path.clone()] } else { self.changed_paths.into_iter().collect() },
            affected_directories: if rescan { vec![root_path.clone()] } else { self.affected_directories.into_iter().collect() },
            root_path,
            kind: self.kind.unwrap_or_else(|| "other".to_string()),
            sequence,
        }
    }
}

impl Default for WorkspaceWatcherManager {
    fn default() -> Self {
        Self {
            watchers: Mutex::new(HashMap::new()),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl WorkspaceWatcherManager {
    pub fn sync_roots(&self, app: &AppHandle, root_paths: Vec<String>) -> anyhow::Result<()> {
        let targets = root_paths
            .into_iter()
            .map(|root_path| WorkspaceWatchTarget {
                directories: vec![root_path.clone()],
                root_path,
            })
            .collect::<Vec<_>>();
        self.sync_targets(app, targets)
    }

    pub fn sync_targets(
        &self,
        app: &AppHandle,
        targets: Vec<WorkspaceWatchTarget>,
    ) -> anyhow::Result<()> {
        let next_targets = targets
            .into_iter()
            .filter_map(normalize_watch_target)
            .collect::<HashMap<_, _>>();

        let mut watchers = self.watchers.lock().unwrap();

        watchers.retain(|key, _| next_targets.contains_key(key));

        for (root_path, (root, visible)) in &next_targets {
            // The root already covers descendants. External open tabs need
            // their parent watched non-recursively, including atomic saves.
            let directories = watched_directories_for_target(root, visible);
            let visible = visible_directory_keys(visible);
            if let Some(existing) = watchers.get_mut(root_path) {
                *existing.visible_directories.lock().unwrap() = visible;
                reconcile_watched_directories(root_path, existing, &directories)?;
            } else {
                let watcher = self.create_watcher(
                    app,
                    root_path.clone(),
                    root.clone(),
                    &directories,
                    visible,
                )?;
                watchers.insert(root_path.clone(), watcher);
            }
        }

        Ok(())
    }

    fn create_watcher(
        &self,
        app: &AppHandle,
        root_path: String,
        root: PathBuf,
        directories: &BTreeSet<String>,
        visible: BTreeSet<String>,
    ) -> anyhow::Result<WorkspaceWatcher> {
        let visible_directories: VisibleDirectories = Arc::new(Mutex::new(visible));
        let callback_visible = Arc::clone(&visible_directories);
        let app_handle = app.clone();
        let sequence_counter = Arc::clone(&self.sequence);
        let callback_root = root.clone();
        let pending_state = Arc::new(Mutex::new(PendingWorkspaceChangeState::default()));
        let callback_pending_state = Arc::clone(&pending_state);
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let event = match result {
                    Ok(event) => {
                        crate::fs_ops::update_search_index_event(&callback_root, &event);
                        Some(event)
                    }
                    Err(_) => {
                        crate::fs_ops::update_search_index_paths(&callback_root, &[callback_root.clone()]);
                        None
                    }
                };
                // Native overflow/error means paths may be missing entirely. Keep
                // recovery in the same bounded debounce as ordinary changes.
                if event.as_ref().is_none_or(Event::need_rescan) {
                    enqueue_workspace_change(
                        &app_handle, &root_path, &sequence_counter, &callback_pending_state,
                        "rescan", Vec::new(), Vec::new(),
                    );
                    return;
                }
                let event = event.unwrap();
                let Some(kind) = watch_kind(&event.kind) else {
                    return;
                };
                let paths = {
                    let visible = callback_visible.lock().unwrap();
                    reportable_paths(&callback_root, &visible, &event.paths)
                };
                let changed_paths = changed_paths_for_event(&paths);
                if changed_paths.is_empty() {
                    return;
                }
                let affected_directories = affected_directories_for_paths(&callback_root, &paths);
                enqueue_workspace_change(
                    &app_handle,
                    &root_path,
                    &sequence_counter,
                    &callback_pending_state,
                    kind,
                    changed_paths,
                    affected_directories,
                );
            },
            Config::default(),
        )?;
        let mut watched_directories = BTreeSet::new();
        for directory in directories {
            let directory_path = PathBuf::from(directory);
            let recursive_mode = recursive_mode_for_watch_directory(&root, &directory_path);
            watcher
                .watch(&directory_path, recursive_mode)
                .with_context(|| {
                    format!("failed to watch directory {}", directory_path.display())
                })?;
            watched_directories.insert(directory.clone());
        }
        Ok(WorkspaceWatcher {
            watcher,
            directories: watched_directories,
            visible_directories,
        })
    }
}

fn enqueue_workspace_change(
    app_handle: &AppHandle,
    root_path: &str,
    sequence_counter: &Arc<AtomicU64>,
    pending_state: &Arc<Mutex<PendingWorkspaceChangeState>>,
    kind: &str,
    changed_paths: Vec<String>,
    affected_directories: Vec<String>,
) {
    let should_schedule = {
        let mut state = pending_state.lock().unwrap();
        if let Some(pending) = state.pending.as_mut() {
            pending.merge(kind, changed_paths, affected_directories);
        } else {
            state.pending = Some(PendingWorkspaceChange::new(
                kind,
                changed_paths,
                affected_directories,
            ));
        }

        if state.scheduled {
            false
        } else {
            state.scheduled = true;
            true
        }
    };

    if !should_schedule {
        return;
    }

    let app_handle = app_handle.clone();
    let root_path = root_path.to_string();
    let sequence_counter = Arc::clone(sequence_counter);
    let pending_state = Arc::clone(pending_state);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(WORKSPACE_WATCH_DEBOUNCE_MS));
        flush_workspace_change(&app_handle, root_path, &sequence_counter, &pending_state);
    });
}

fn flush_workspace_change(
    app_handle: &AppHandle,
    root_path: String,
    sequence_counter: &Arc<AtomicU64>,
    pending_state: &Arc<Mutex<PendingWorkspaceChangeState>>,
) {
    let pending = {
        let mut state = pending_state.lock().unwrap();
        let pending = state.pending.take();
        state.scheduled = false;
        pending
    };

    let Some(pending) = pending else {
        return;
    };
    if pending.changed_paths.is_empty() && pending.kind.as_deref() != Some("rescan") {
        return;
    }

    let sequence = sequence_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = app_handle.emit(
        "workspace-files-changed",
        pending.into_event(root_path, sequence),
    );
}

fn normalize_watch_target(
    target: WorkspaceWatchTarget,
) -> Option<(String, (PathBuf, BTreeSet<String>))> {
    let root = PathBuf::from(target.root_path.trim());
    if root.as_os_str().is_empty() || !root.is_dir() {
        return None;
    }
    let root_key = normalize_path(&root);
    let mut directories = BTreeSet::new();
    directories.insert(root_key.clone());
    for directory in target.directories {
        let path = PathBuf::from(directory.trim());
        if path.as_os_str().is_empty() || !path.is_dir() {
            continue;
        }
        if !path.is_absolute() {
            continue;
        }
        directories.insert(normalize_path(&path));
    }
    Some((root_key, (root, directories)))
}

fn watched_directories_for_target(root: &Path, visible: &BTreeSet<String>) -> BTreeSet<String> {
    let mut directories = BTreeSet::from([normalize_path(root)]);
    directories.extend(
        visible.iter().filter(|directory| !path_belongs_to_root(root, Path::new(directory))).cloned(),
    );
    directories
}

fn reconcile_watched_directories(
    root_path: &str,
    existing: &mut WorkspaceWatcher,
    next_directories: &BTreeSet<String>,
) -> anyhow::Result<()> {
    let current_directories = existing.directories.clone();
    for directory in current_directories.difference(next_directories) {
        let path = PathBuf::from(directory);
        let _ = existing.watcher.unwatch(&path);
        existing.directories.remove(directory);
    }

    let directories_to_add = next_directories
        .difference(&existing.directories)
        .cloned()
        .collect::<Vec<_>>();
    for directory in directories_to_add {
        let path = PathBuf::from(&directory);
        let recursive_mode = recursive_mode_for_watch_directory(&PathBuf::from(root_path), &path);
        existing
            .watcher
            .watch(&path, recursive_mode)
            .with_context(|| {
                format!(
                    "failed to watch directory {} for workspace {}",
                    path.display(),
                    root_path
                )
            })?;
        existing.directories.insert(directory);
    }

    Ok(())
}

fn watch_kind(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Access(_) => None,
        EventKind::Create(_) => Some("create"),
        EventKind::Remove(_) => Some("remove"),
        EventKind::Modify(ModifyKind::Name(
            RenameMode::Any | RenameMode::Both | RenameMode::From | RenameMode::To,
        )) => Some("rename"),
        EventKind::Modify(_) => Some("modify"),
        EventKind::Any | EventKind::Other => Some("other"),
    }
}

fn visible_directory_keys(directories: &BTreeSet<String>) -> BTreeSet<String> {
    directories
        .iter()
        .map(|directory| normalized_watch_key(Path::new(directory)))
        .collect()
}

/// Keeps paths that are not ignored, plus ignored paths whose directory (or
/// the path itself) is visible in the explorer.
fn reportable_paths(root: &Path, visible: &BTreeSet<String>, paths: &[PathBuf]) -> Vec<PathBuf> {
    paths
        .iter()
        .filter(|path| {
            is_visible_path(visible, path)
                || (path_belongs_to_root(root, path) && !is_ignored_watch_path(root, path))
        })
        .cloned()
        .collect()
}

fn is_visible_path(visible: &BTreeSet<String>, path: &Path) -> bool {
    visible.contains(&normalized_watch_key(path))
        || path
            .parent()
            .is_some_and(|parent| visible.contains(&normalized_watch_key(parent)))
}

// Paths have already passed reportable_paths, including external tab parents.
fn changed_paths_for_event(paths: &[PathBuf]) -> Vec<String> {
    let mut changed_paths = BTreeSet::new();
    for path in paths {
        insert_limited_path(&mut changed_paths, normalize_path(path));
    }
    changed_paths.into_iter().collect()
}

pub(crate) fn affected_directories_for_paths(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut directories = BTreeSet::new();
    for path in paths {
        if !path_belongs_to_root(root, path) {
            continue;
        }
        insert_limited_path(&mut directories, normalize_path(path));
        if let Some(parent) = path.parent() {
            insert_limited_path(&mut directories, normalize_path(parent));
        }
    }
    if directories.is_empty() {
        directories.insert(normalize_path(root));
    }
    directories.into_iter().collect()
}

fn merge_watch_kind(current: &mut Option<String>, next: &str) {
    match current {
        None => *current = Some(next.to_string()),
        Some(existing) if existing == next => {}
        Some(existing) => *existing = "other".to_string(),
    }
}

fn extend_limited_paths(target: &mut BTreeSet<String>, paths: Vec<String>) {
    for path in paths {
        insert_limited_path(target, path);
    }
}

fn insert_limited_path(target: &mut BTreeSet<String>, path: String) {
    // Keep one sentinel entry so callers can distinguish exact capacity from
    // dropped paths, without retaining an unbounded native event burst.
    if target.len() <= WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT || target.contains(&path) {
        target.insert(path);
    }
}

pub(crate) fn is_ignored_watch_path(root: &Path, path: &Path) -> bool {
    let root_key = normalized_watch_key(root);
    let path_key = normalized_watch_key(path);
    let relative = if path_key == root_key {
        ""
    } else if let Some(relative) = path_key.strip_prefix(&format!("{}/", root_key)) {
        relative
    } else {
        path_key.as_str()
    };

    // Selected Super High state directories are watched even though the rest
    // of `.superhigh` is ignored.
    if WATCHABLE_SUPERHIGH_DIRS
        .iter()
        .any(|item| relative == *item)
        || relative == WATCHABLE_SUPERHIGH_EDITOR_DIR
        || relative.starts_with(&format!("{WATCHABLE_SUPERHIGH_EDITOR_DIR}/"))
    {
        return false;
    }

    relative
        .split('/')
        .filter(|part| !part.is_empty())
        .any(|name| {
            IGNORED_WATCH_DIRS
                .iter()
                .any(|ignored| ignored.eq_ignore_ascii_case(name))
        })
}

fn path_belongs_to_root(root: &Path, path: &Path) -> bool {
    let root_key = normalized_watch_key(root);
    let path_key = normalized_watch_key(path);
    path_key == root_key || path_key.starts_with(&format!("{}/", root_key))
}

pub(crate) fn recursive_mode_for_watch_directory(root: &Path, path: &Path) -> RecursiveMode {
    if normalized_watch_key(path) == normalized_watch_key(root) {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    }
}

fn normalized_watch_key(path: &Path) -> String {
    let normalized = normalize_path(path).replace('\\', "/");
    normalized
        .strip_prefix("//?/")
        .unwrap_or(&normalized)
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

pub type SharedWorkspaceWatcherManager = std::sync::Arc<WorkspaceWatcherManager>;

#[cfg(test)]
mod tests {
    use super::{
        affected_directories_for_paths, changed_paths_for_event, is_ignored_watch_path,
        normalize_watch_target, recursive_mode_for_watch_directory, reportable_paths,
        visible_directory_keys, watched_directories_for_target, PendingWorkspaceChange, WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT,
    };
    use std::{collections::BTreeSet, fs, path::PathBuf};

    use tempfile::tempdir;

    use crate::models::WorkspaceWatchTarget;

    #[test]
    fn ignored_paths_are_checked_relative_to_root() {
        let root = PathBuf::from(r"D:\Projects\node_modules");
        let child = root.join("src").join("main.ts");
        let ignored = root.join(".git").join("HEAD");

        assert!(!is_ignored_watch_path(&root, &child));
        assert!(is_ignored_watch_path(&root, &ignored));
    }

    #[test]
    fn superhigh_state_dirs_are_watchable_despite_superhigh_ignore() {
        let root = PathBuf::from(r"D:\Projects\App");
        let superhigh = root.join(".superhigh");
        let editor = superhigh.join("editor");
        let editor_page = editor.join("main.html");
        let editor_manifest = editor.join("editor.json");
        let other = root.join(".superhigh").join("skills").join("x.md");

        assert!(!is_ignored_watch_path(&root, &superhigh));
        assert!(!is_ignored_watch_path(&root, &editor));
        assert!(!is_ignored_watch_path(&root, &editor_page));
        assert!(!is_ignored_watch_path(&root, &editor_manifest));
        assert!(is_ignored_watch_path(&root, &other));
    }

    #[test]
    fn pending_workspace_change_coalesces_paths_and_kind() {
        let mut pending = PendingWorkspaceChange::new(
            "modify",
            vec!["D:/One/src/main.ts".to_string()],
            vec!["D:/One/src".to_string()],
        );

        pending.merge(
            "modify",
            vec![
                "D:/One/src/main.ts".to_string(),
                "D:/One/src/lib.ts".to_string(),
            ],
            vec!["D:/One/src".to_string(), "D:/One".to_string()],
        );

        let event = pending.into_event("D:/One".to_string(), 7);

        assert_eq!(event.root_path, "D:/One");
        assert_eq!(event.sequence, 7);
        assert_eq!(event.kind, "modify");
        assert_eq!(
            event.changed_paths,
            vec!["D:/One/src/lib.ts", "D:/One/src/main.ts"]
        );
        assert_eq!(event.affected_directories, vec!["D:/One", "D:/One/src"]);
    }

    #[test]
    fn pending_workspace_change_uses_other_for_mixed_kinds() {
        let mut pending = PendingWorkspaceChange::new(
            "modify",
            vec!["D:/One/src/main.ts".to_string()],
            vec!["D:/One/src".to_string()],
        );

        pending.merge(
            "create",
            vec!["D:/One/src/new.ts".to_string()],
            vec!["D:/One/src".to_string()],
        );

        let event = pending.into_event("D:/One".to_string(), 8);

        assert_eq!(event.kind, "other");
        assert_eq!(event.changed_paths.len(), 2);
    }

    #[test]
    fn pending_workspace_change_caps_payload_paths() {
        let changed_paths = (0..WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT + 40)
            .map(|index| format!("D:/One/src/file-{index}.ts"))
            .collect::<Vec<_>>();
        let affected_directories = (0..WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT + 40)
            .map(|index| format!("D:/One/src/dir-{index}"))
            .collect::<Vec<_>>();

        let event = PendingWorkspaceChange::new("modify", changed_paths, affected_directories)
            .into_event("D:/One".to_string(), 9);

        assert_eq!(event.kind, "rescan");
        assert_eq!(event.changed_paths, vec!["D:/One"]);
        assert_eq!(event.affected_directories, vec!["D:/One"]);
    }

    #[test]
    fn rescan_is_sticky_across_ordinary_changes() {
        let mut pending = PendingWorkspaceChange::new("modify", vec!["D:/One/a".into()], vec![]);
        pending.merge("rescan", vec![], vec![]);
        pending.merge("create", vec!["D:/One/b".into()], vec!["D:/One/src".into()]);
        let event = pending.into_event("D:/One".into(), 10);
        assert_eq!(event.kind, "rescan");
        assert_eq!(event.changed_paths, vec!["D:/One"]);
        assert_eq!(event.affected_directories, vec!["D:/One"]);
    }

    #[test]
    fn exact_capacity_and_duplicates_do_not_trigger_rescan_but_merged_overflow_does() {
        let paths = (0..WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT)
            .map(|index| format!("D:/One/{index}"))
            .collect::<Vec<_>>();
        let mut pending = PendingWorkspaceChange::new("modify", paths.clone(), vec![]);
        pending.merge("modify", paths, vec![]);
        assert_eq!(pending.kind.as_deref(), Some("modify"));
        pending.merge("modify", vec!["D:/One/new".into()], vec![]);
        assert_eq!(pending.kind.as_deref(), Some("rescan"));
        assert!(pending.changed_paths.is_empty());
        assert!(pending.affected_directories.is_empty());
    }

    #[test]
    fn changed_paths_for_event_caps_paths_before_coalescing() {
        let root = PathBuf::from(r"D:\Projects\App");
        let paths = (0..WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT + 40)
            .map(|index| root.join("src").join(format!("file-{index}.ts")))
            .collect::<Vec<_>>();

        let changed = changed_paths_for_event(&paths);

        assert_eq!(changed.len(), WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT + 1);
    }

    #[test]
    fn affected_directories_include_changed_path_and_parent() {
        let root = PathBuf::from(r"D:\Projects\App");
        let file = root.join("src").join("main.ts");

        let affected = affected_directories_for_paths(&root, &[file]);

        assert!(affected
            .iter()
            .any(|path| path.ends_with("src/main.ts") || path.ends_with(r"src\main.ts")));
        assert!(affected.iter().any(|path| path.ends_with("src")));
    }

    #[test]
    fn reportable_paths_skip_hidden_ignored_paths() {
        let root = PathBuf::from(r"D:\Projects\App");
        let ignored = root.join("node_modules").join("pkg").join("index.js");
        let log = root.join(".superhigh").join("log").join("a").join("x.json");
        let source = root.join("src").join("main.ts");

        let reportable =
            reportable_paths(&root, &BTreeSet::new(), &[ignored, log, source.clone()]);

        assert_eq!(reportable, vec![source]);
    }

    #[test]
    fn reportable_paths_keep_ignored_paths_in_visible_directories() {
        let root = PathBuf::from(r"D:\Projects\App");
        let log_dir = root.join(".superhigh").join("log").join("agents-updater");
        let renamed_from = log_dir.join("2026-10-14.jsonl");
        let renamed_to = log_dir.join("2026-10-14-130112-2033db59.json");
        let deeper = log_dir.join("nested").join("x.json");
        let visible =
            visible_directory_keys(&BTreeSet::from([log_dir.to_string_lossy().to_string()]));

        let reportable = reportable_paths(
            &root,
            &visible,
            &[renamed_from.clone(), renamed_to.clone(), deeper],
        );

        assert_eq!(reportable, vec![renamed_from, renamed_to]);
    }

    #[test]
    fn external_tab_parent_is_watched_without_recursive_siblings() {
        let temp = tempdir().unwrap();
        let root = temp.path().join("workspace");
        let external = temp.path().join("client").join("gui");
        fs::create_dir(&root).unwrap();
        fs::create_dir_all(&external).unwrap();
        let (_, (_, visible)) = normalize_watch_target(WorkspaceWatchTarget {
            root_path: root.to_string_lossy().to_string(),
            directories: vec![external.to_string_lossy().to_string()],
        }).unwrap();
        let directories = watched_directories_for_target(&root, &visible);
        assert!(directories.contains(&external.to_string_lossy().replace('\\', "/")));
        assert!(matches!(recursive_mode_for_watch_directory(&root, &external), notify::RecursiveMode::NonRecursive));
        let file = external.join("slot1.png");
        let atomic_temp = external.join("slot1.tmp");
        let reportable = reportable_paths(&root, &visible_directory_keys(&visible), &[
            file.clone(), atomic_temp.clone(), external.join("nested").join("other.png"),
            temp.path().join("unrelated.png"),
        ]);
        assert_eq!(reportable, vec![file.clone(), atomic_temp]);
        assert!(changed_paths_for_event(&reportable).contains(&file.to_string_lossy().replace('\\', "/")));
        let removed = watched_directories_for_target(&root, &BTreeSet::new());
        assert_eq!(removed, BTreeSet::from([root.to_string_lossy().replace('\\', "/")]));
    }

    #[test]
    fn watch_target_keeps_requested_existing_directories() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        fs::create_dir(root.join("src")).unwrap();
        fs::create_dir(root.join("src").join("nested")).unwrap();
        fs::create_dir(root.join("src").join("target")).unwrap();
        fs::create_dir(root.join("target")).unwrap();
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join(".superhigh").join("skills")).unwrap();
        fs::write(root.join("README.md"), "readme").unwrap();

        let (_, (_, directories)) = normalize_watch_target(WorkspaceWatchTarget {
            root_path: root.to_string_lossy().to_string(),
            directories: vec![
                root.join("src").to_string_lossy().to_string(),
                root.join("src")
                    .join("nested")
                    .to_string_lossy()
                    .to_string(),
                root.join("src")
                    .join("target")
                    .to_string_lossy()
                    .to_string(),
                root.join("node_modules").to_string_lossy().to_string(),
                root.join(".superhigh")
                    .join("skills")
                    .to_string_lossy()
                    .to_string(),
                root.join("README.md").to_string_lossy().to_string(),
            ],
        })
        .unwrap();

        assert!(directories.contains(&root.to_string_lossy().replace('\\', "/")));
        assert!(directories.iter().any(|path| path.ends_with("src")));
        assert!(directories.iter().any(|path| path.ends_with("src/nested")));
        assert!(!directories.iter().any(|path| path.ends_with("README.md")));
        // Expanded ignored directories stay visible so their changes still refresh the tree.
        assert!(directories.iter().any(|path| path.ends_with("src/target")));
        assert!(directories
            .iter()
            .any(|path| path.ends_with("node_modules")));
        assert!(directories
            .iter()
            .any(|path| path.ends_with(".superhigh/skills")));
    }

}
