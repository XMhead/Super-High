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

const WATCHABLE_SUPERHIGH_DIRS: &[&str] = &[
    ".superhigh",
    ".superhigh/item-library-ignore.yml",
];
const WORKSPACE_WATCH_DEBOUNCE_MS: u64 = 200;
const WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT: usize = 512;

pub struct WorkspaceWatcherManager {
    watchers: Mutex<HashMap<String, WorkspaceWatcher>>,
    sequence: Arc<AtomicU64>,
}

struct WorkspaceWatcher {
    watcher: RecommendedWatcher,
    directories: BTreeSet<String>,
}

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
        merge_watch_kind(&mut self.kind, kind);
        extend_limited_paths(&mut self.changed_paths, changed_paths);
        extend_limited_paths(&mut self.affected_directories, affected_directories);
    }

    fn into_event(self, root_path: String, sequence: u64) -> WorkspaceFilesChangedEvent {
        WorkspaceFilesChangedEvent {
            root_path,
            changed_paths: self.changed_paths.into_iter().collect(),
            affected_directories: self.affected_directories.into_iter().collect(),
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

        for (root_path, (root, _directories)) in &next_targets {
            // The workspace root is watched recursively, so registering its
            // expanded descendants again only duplicates Windows events.
            let directories = BTreeSet::from([normalize_path(root)]);
            if let Some(existing) = watchers.get_mut(root_path) {
                reconcile_watched_directories(root_path, existing, &directories)?;
            } else {
                let watcher =
                    self.create_watcher(app, root_path.clone(), root.clone(), &directories)?;
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
    ) -> anyhow::Result<WorkspaceWatcher> {
        let app_handle = app.clone();
        let sequence_counter = Arc::clone(&self.sequence);
        let callback_root = root.clone();
        let pending_state = Arc::new(Mutex::new(PendingWorkspaceChangeState::default()));
        let callback_pending_state = Arc::clone(&pending_state);
        let mut watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| {
                let Ok(event) = result else {
                    return;
                };
                let Some(kind) = watch_kind(&event.kind) else {
                    return;
                };
                let changed_paths = changed_paths_for_event(&callback_root, &event.paths);
                if changed_paths.is_empty() {
                    return;
                }
                let affected_directories =
                    affected_directories_for_paths(&callback_root, &event.paths);
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
    if pending.changed_paths.is_empty() {
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
        if !path_belongs_to_root(&root, &path) || is_ignored_watch_path(&root, &path) {
            continue;
        }
        directories.insert(normalize_path(&path));
    }
    Some((root_key, (root, directories)))
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

fn changed_paths_for_event(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut changed_paths = BTreeSet::new();
    for path in paths {
        if !path_belongs_to_root(root, path) || is_ignored_watch_path(root, path) {
            continue;
        }
        insert_limited_path(&mut changed_paths, normalize_path(path));
    }
    changed_paths.into_iter().collect()
}

pub(crate) fn affected_directories_for_paths(root: &Path, paths: &[PathBuf]) -> Vec<String> {
    let mut directories = BTreeSet::new();
    for path in paths {
        if !path_belongs_to_root(root, path) || is_ignored_watch_path(root, path) {
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
    if target.len() < WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT || target.contains(&path) {
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
    let dragoncore_gui = root.join("DragonCore").join("Gui");
    let item_library_roots = [
        root.join("plugins").join("NeigeItems").join("Items"),
        root.join("plugins").join("MythicMobs").join("Items"),
    ];
    if normalized_watch_key(path) == normalized_watch_key(root)
        || normalized_watch_key(path) == normalized_watch_key(&dragoncore_gui)
        || item_library_roots
            .iter()
            .any(|item_root| normalized_watch_key(path) == normalized_watch_key(item_root))
    {
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
        normalize_watch_target, recursive_mode_for_watch_directory, PendingWorkspaceChange,
        WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT,
    };
    use std::{fs, path::PathBuf};

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
        let other = root.join(".superhigh").join("skills").join("x.md");

        assert!(!is_ignored_watch_path(&root, &superhigh));
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

        assert_eq!(
            event.changed_paths.len(),
            WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT
        );
        assert_eq!(
            event.affected_directories.len(),
            WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT
        );
    }

    #[test]
    fn changed_paths_for_event_caps_paths_before_coalescing() {
        let root = PathBuf::from(r"D:\Projects\App");
        let paths = (0..WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT + 40)
            .map(|index| root.join("src").join(format!("file-{index}.ts")))
            .collect::<Vec<_>>();

        let changed = changed_paths_for_event(&root, &paths);

        assert_eq!(changed.len(), WORKSPACE_WATCH_PAYLOAD_PATH_LIMIT);
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
    fn affected_directories_skip_ignored_paths() {
        let root = PathBuf::from(r"D:\Projects\App");
        let ignored = root.join("node_modules").join("pkg").join("index.js");

        let affected = affected_directories_for_paths(&root, &[ignored]);

        assert_eq!(affected, vec![root.to_string_lossy().replace('\\', "/")]);
    }

    #[test]
    fn watch_target_keeps_only_requested_existing_non_ignored_directories() {
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
        assert!(!directories.iter().any(|path| path.ends_with("target")));
        assert!(!directories
            .iter()
            .any(|path| path.ends_with("node_modules")));
        assert!(!directories
            .iter()
            .any(|path| path.ends_with(".superhigh/skills")));
    }

    #[test]
    fn dragoncore_and_item_library_watch_directories_are_recursive() {
        let root = PathBuf::from(r"D:\Project");
        let dragoncore_gui = root.join("DragonCore").join("Gui");
        let neige_items = root.join("plugins").join("NeigeItems").join("Items");
        let mythic_items = root.join("plugins").join("MythicMobs").join("Items");
        let nested_dragoncore_gui = dragoncore_gui.join("d队伍");
        let ordinary = root.join("DragonCore");

        assert_eq!(
            recursive_mode_for_watch_directory(&root, &root),
            notify::RecursiveMode::Recursive
        );
        assert_eq!(
            recursive_mode_for_watch_directory(&root, &dragoncore_gui),
            notify::RecursiveMode::Recursive
        );
        assert_eq!(
            recursive_mode_for_watch_directory(&root, &neige_items),
            notify::RecursiveMode::Recursive
        );
        assert_eq!(
            recursive_mode_for_watch_directory(&root, &mythic_items),
            notify::RecursiveMode::Recursive
        );
        assert_eq!(
            recursive_mode_for_watch_directory(&root, &nested_dragoncore_gui),
            notify::RecursiveMode::NonRecursive
        );
        assert_eq!(
            recursive_mode_for_watch_directory(&root, &ordinary),
            notify::RecursiveMode::NonRecursive
        );
    }
}
