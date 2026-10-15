//! Keep command baselines ready without filesystem work on the CLI transport.
use crate::command_changes::{relevant_baseline_path, CommandChanges, PreparedCommandBaseline};
use anyhow::{Context, Result};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Default)]
struct State {
    revision: u64,
    published: u64,
    snapshot: Option<PreparedCommandBaseline>,
    paths: BTreeSet<PathBuf>,
    reload: bool,
    error: Option<String>,
}

pub struct CommandBaseline {
    state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    wake: mpsc::SyncSender<()>,
    worker: Option<JoinHandle<()>>,
}

impl CommandBaseline {
    pub fn start(root: &Path) -> Self {
        let root = root.to_path_buf();
        let state = Arc::new(Mutex::new(State::default()));
        let stop = Arc::new(AtomicBool::new(false));
        let (wake, ready) = mpsc::sync_channel(1);
        let shared = state.clone();
        let stopping = stop.clone();
        let notify = wake.clone();
        let worker = thread::spawn(move || {
            if let Err(error) = capture(&root, &shared, &stopping, notify, ready) {
                let mut state = shared.lock().unwrap();
                state.snapshot = None;
                state.error = Some(error.to_string());
            }
        });
        Self {
            state,
            stop,
            wake,
            worker: Some(worker),
        }
    }

    /// Freeze the last fully reconciled generation, never wait for a scan.
    pub fn snapshot(&self) -> Result<PreparedCommandBaseline> {
        let state = self
            .state
            .try_lock()
            .map_err(|_| anyhow::anyhow!("工作区文件基线正在更新，本轮命令变更统计不可用"))?;
        anyhow::ensure!(
            state.revision == state.published,
            "工作区文件基线正在更新，本轮命令变更统计不可用"
        );
        state.snapshot.clone().with_context(|| {
            state
                .error
                .clone()
                .unwrap_or_else(|| "工作区文件基线尚未就绪，本轮命令变更统计不可用".into())
        })
    }
}

impl Drop for CommandBaseline {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
        if let Some(worker) = self.worker.take().filter(|w| w.is_finished()) {
            let _ = worker.join();
        }
        // An in-progress bounded scan owns only its private cache. Closing the
        // terminal must not wait for filesystem I/O; it exits before publishing.
    }
}

fn invalidate(root: &Path, state: &Mutex<State>, result: notify::Result<Event>) -> bool {
    let mut paths = Vec::new();
    let reload = match result {
        Ok(event) => {
            if matches!(event.kind, EventKind::Access(_)) {
                return false;
            }
            let reload = event.need_rescan() || event.paths.is_empty();
            paths.extend(
                event
                    .paths
                    .into_iter()
                    .filter(|p| relevant_baseline_path(root, p)),
            );
            if paths.is_empty() && !reload {
                return false;
            }
            reload
        }
        Err(_) => true,
    };
    let mut state = state.lock().unwrap();
    if let Some(snapshot) = &state.snapshot {
        paths.retain(|p| snapshot.watches_path(root, p));
        if paths.is_empty() && !reload {
            return false;
        }
    }
    state.revision += 1;
    state.reload |= reload;
    if !state.reload {
        state.paths.extend(paths);
        if state.paths.len() > 4096 {
            state.reload = true;
        }
    }
    if state.reload {
        state.paths.clear();
    }
    true
}

fn capture(
    root: &Path,
    state: &Arc<Mutex<State>>,
    stop: &AtomicBool,
    wake: mpsc::SyncSender<()>,
    ready: mpsc::Receiver<()>,
) -> Result<()> {
    let callback_root = root.to_path_buf();
    let callback_state = state.clone();
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            if invalidate(&callback_root, &callback_state, event) {
                let _ = wake.try_send(());
            }
        },
        notify::Config::default(),
    )?;
    // Subscribe before reading so writes during the initial scan invalidate it.
    watcher.watch(root, RecursiveMode::Recursive)?;
    let mut cache = CommandChanges::new(root);
    loop {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let (revision, paths, reload) = {
            let mut state = state.lock().unwrap();
            (
                state.revision,
                std::mem::take(&mut state.paths)
                    .into_iter()
                    .collect::<Vec<_>>(),
                std::mem::take(&mut state.reload),
            )
        };
        let result = cache
            .prepare_changed(&paths, reload)
            .and_then(|_| cache.prepared_snapshot());
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        {
            let mut state = state.lock().unwrap();
            let mut reconciled = revision;
            if let Ok(snapshot) = &result {
                // The initial scan discovers ignored/browser directories. Drop
                // their queued notifications before deciding the scan is stale.
                state.paths.retain(|p| snapshot.watches_path(root, p));
                if state.paths.is_empty() && !state.reload {
                    reconciled = state.revision;
                }
            }
            match result {
                Ok(snapshot) => {
                    state.snapshot = Some(snapshot);
                    state.error = None;
                }
                Err(error) => {
                    state.snapshot = None;
                    state.error = Some(error.to_string());
                }
            }
            if state.revision != reconciled {
                continue;
            }
            state.published = reconciled;
        }
        loop {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            {
                let state = state.lock().unwrap();
                if state.revision != state.published {
                    break;
                }
            }
            match ready.recv_timeout(Duration::from_millis(100)) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, time::Instant};

    fn ready(baseline: &CommandBaseline) -> PreparedCommandBaseline {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(snapshot) = baseline.snapshot() {
                return snapshot;
            }
            assert!(Instant::now() < deadline, "baseline never became ready");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn changes_snapshot_does_not_wait_for_capture_or_publish_stale_generations() {
        let state = Arc::new(Mutex::new(State::default()));
        let (wake, _) = mpsc::sync_channel(1);
        let baseline = CommandBaseline {
            state: state.clone(),
            stop: Arc::new(AtomicBool::new(false)),
            wake,
            worker: None,
        };
        let guard = state.lock().unwrap();
        let start = Instant::now();
        assert!(baseline.snapshot().is_err());
        assert!(start.elapsed() < Duration::from_millis(100));
        drop(guard);
        assert!(baseline.snapshot().is_err());
        let root = tempfile::tempdir().unwrap();
        let mut cache = CommandChanges::new(root.path());
        cache.prepare().unwrap();
        state.lock().unwrap().snapshot = Some(cache.prepared_snapshot().unwrap());
        assert!(baseline.snapshot().is_ok());
        invalidate(root.path(), &state, Ok(Event::new(EventKind::Any)));
        assert!(baseline.snapshot().is_err());
    }

    #[test]
    fn changes_watcher_keeps_frozen_turn_and_next_turn_baselines_separate() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("probe.txt");
        fs::write(&file, "before\n").unwrap();
        let baseline = CommandBaseline::start(root.path());
        let mut turn = CommandChanges::new(root.path());
        turn.use_prepared(ready(&baseline)).unwrap();
        turn.begin("native", "one").unwrap();
        fs::write(&file, "after\n").unwrap();
        let changes = turn.refresh("native", "one", &[]).unwrap();
        assert_eq!(changes[0].before.as_deref(), Some("before\n"));
        assert_eq!(changes[0].after.as_deref(), Some("after\n"));
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut next = CommandChanges::new(root.path());
            next.use_prepared(ready(&baseline)).unwrap();
            next.begin("native", "two").unwrap();
            if next.refresh("native", "two", &[]).unwrap().is_empty() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "watcher did not refresh baseline"
            );
            thread::sleep(Duration::from_millis(10));
        }
        fs::remove_file(file).unwrap();
        assert_eq!(
            turn.refresh("native", "one", &[]).unwrap()[0]
                .before
                .as_deref(),
            Some("before\n")
        );
    }

    #[test]
    fn changes_background_cache_handles_same_stamp_writes_renames_and_deletes() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("old");
        fs::create_dir(&dir).unwrap();
        let file = dir.join("probe.txt");
        fs::write(&file, "before\n").unwrap();
        let mut cache = CommandChanges::new(root.path());
        cache.prepare_changed(&[], false).unwrap();
        let modified = fs::metadata(&file).unwrap().modified().unwrap();
        fs::write(&file, "edited\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        cache.prepare_changed(&[file.clone()], false).unwrap();
        let mut turn = CommandChanges::new(root.path());
        turn.use_prepared(cache.prepared_snapshot().unwrap())
            .unwrap();
        turn.begin("native", "one").unwrap();
        assert!(turn
            .refresh("native", "one", &["old/probe.txt".into()])
            .unwrap()
            .iter()
            .all(|c| c.before == c.after));
        let renamed = root.path().join("new");
        fs::rename(&dir, &renamed).unwrap();
        cache
            .prepare_changed(&[dir, renamed.clone()], false)
            .unwrap();
        turn.finish("native", "one");
        turn.use_prepared(cache.prepared_snapshot().unwrap())
            .unwrap();
        turn.begin("native", "two").unwrap();
        fs::remove_file(renamed.join("probe.txt")).unwrap();
        let changes = turn.refresh("native", "two", &[]).unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "new/probe.txt");
        assert_eq!(changes[0].before.as_deref(), Some("edited\n"));
        assert_eq!(changes[0].after, None);
    }

    #[test]
    fn changes_ignored_and_browser_activity_does_not_starve_baseline() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(".ignore"), "noise/\n").unwrap();
        fs::create_dir(root.path().join("noise")).unwrap();
        let profile = root.path().join(".agent/tmp/renderer");
        fs::create_dir_all(profile.join("Default/Network")).unwrap();
        fs::write(profile.join("Local State"), "{}").unwrap();
        fs::write(profile.join("Default/Preferences"), "{}").unwrap();
        fs::write(profile.join("Default/Network/Cookies"), "cache").unwrap();
        let baseline = CommandBaseline::start(root.path());
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            fs::write(profile.join("Default/Network/Cookies"), "churn").unwrap();
            fs::write(root.path().join("noise/changing.txt"), "churn").unwrap();
            if let Ok(snapshot) = baseline.snapshot() {
                assert!(
                    !snapshot.watches_path(root.path(), &profile.join("Default/Network/Cookies"))
                );
                assert!(
                    !snapshot.watches_path(root.path(), &root.path().join("noise/changing.txt"))
                );
                assert!(
                    snapshot.watches_path(root.path(), &root.path().join(".agent/tmp/probe.txt"))
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "irrelevant writes kept invalidating baseline"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
