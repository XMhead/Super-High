use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    thread::{self, JoinHandle},
    time::Duration,
};

pub struct ClaudeSession {
    directory: PathBuf,
    settings: PathBuf,
    stopping: Arc<AtomicBool>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

impl ClaudeSession {
    pub fn settings_path(&self) -> &Path { &self.settings }
    pub fn status(&self) -> Option<Value> { serde_json::from_slice(&fs::read(self.directory.join("status.json")).ok()?).ok() }

    pub fn pending_plan(&self, id: &Value) -> Option<crate::codex_plan::PlanRequest> {
        crate::claude_plan::pending(&self.directory, id)
    }

    pub fn reply_plan(&self, id: &Value, answers: HashMap<String, Vec<String>>) -> Result<()> {
        crate::claude_plan::reply(&self.directory, id, answers)
    }

    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        for worker in self.workers.lock().unwrap_or_else(|e| e.into_inner()).drain(..) {
            let _ = worker.join();
        }
        for name in ["settings.json", "session.json", "session.pending", "status.json"] {
            let _ = fs::remove_file(self.directory.join(name));
        }
        let _ = fs::remove_dir_all(self.directory.join("plans"));
        let _ = fs::remove_dir(&self.directory);
    }
}

impl Drop for ClaudeSession {
    fn drop(&mut self) { self.shutdown(); }
}

pub fn prepare(
    session_id: &str,
    data_dir: &Path,
    helper_executable: &Path,
    cwd: &Path,
    environment: &HashMap<String, String>,
    on_session: Arc<dyn Fn(String) + Send + Sync>,
    on_plan: Arc<dyn Fn(crate::codex_plan::PlanRequest) + Send + Sync>,
) -> Result<ClaudeSession> {
    anyhow::ensure!(!session_id.is_empty() && session_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')), "invalid Claude terminal session ID");
    let directory = data_dir.join("claude-sessions").join(session_id);
    let executable = helper_executable.to_string_lossy();
    let queue = directory.to_string_lossy();
    anyhow::ensure!(!executable.contains(['"', '\n', '\r']) && !queue.contains(['"', '\n', '\r']), "unsupported hook command path");
    crate::claude_plan::prepare_dir(&directory)?;
    let settings = directory.join("settings.json");
    let command = format!("\"{executable}\" claude-session-hook --queue \"{queue}\"");
    let mut hooks = serde_json::Map::new();
    hooks.insert("SessionStart".into(), json!([{"hooks":[{"type":"command","command":command,"timeout":10}]}]));
    crate::claude_plan::install_hooks(&mut hooks, &executable, &queue);
    let mut configuration = json!({"hooks":hooks});
    let mut candidates = vec![];
    let config = environment.get("CLAUDE_CONFIG_DIR").map(PathBuf::from)
        .or_else(|| environment.get("USERPROFILE").map(|home| PathBuf::from(home).join(".claude")))
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from))
        .or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join(".claude")));
    if let Some(config) = config { candidates.push(config.join("settings.json")); }
    for ancestor in cwd.ancestors() { candidates.push(ancestor.join(".claude/settings.json")); candidates.push(ancestor.join(".claude/settings.local.json")); }
    let configured = candidates.iter().any(|path| fs::read(path).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| v.get("statusLine").is_some()));
    if !configured { configuration["statusLine"] = json!({"type":"command","command":format!("\"{executable}\" claude-status-hook --queue \"{queue}\"")}); }
    fs::write(&settings, serde_json::to_vec(&configuration)?)?;
    let stopping = Arc::new(AtomicBool::new(false));
    let identity_path = directory.join("session.json");
    let identity_stop = stopping.clone();
    let worker = thread::spawn(move || {
        let mut previous = None;
        while !identity_stop.load(Ordering::Acquire) {
            let current = fs::read(&identity_path).ok().and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok());
            if let Some(native) = current.filter(|native| !native.is_empty() && previous.as_ref() != Some(native)) {
                on_session(native.clone());
                previous = Some(native);
            }
            thread::sleep(Duration::from_millis(100));
        }
    });
    let plan_worker = crate::claude_plan::watch(directory.clone(), stopping.clone(), on_plan);
    Ok(ClaudeSession { directory, settings, stopping, workers: Mutex::new(vec![worker, plan_worker]) })
}

fn publish_session(queue: &Path, event: &Value) -> Result<()> {
    anyhow::ensure!(queue.join("settings.json").is_file(), "session relay has ended");
    anyhow::ensure!(event["hook_event_name"] == "SessionStart", "unsupported session event");
    let native = event["session_id"].as_str().filter(|id| !id.is_empty()).context("missing native session ID")?;
    let pending = queue.join("session.pending");
    fs::write(&pending, serde_json::to_vec(native)?)?;
    fs::rename(pending, queue.join("session.json"))?;
    Ok(())
}

pub fn run_hook(args: &[String]) -> i32 {
    let _ = (|| -> Result<()> {
        let queue = args.windows(2).find(|pair| pair[0] == "--queue").map(|p| PathBuf::from(&p[1])).context("missing session queue")?;
        let mut input = Vec::new();
        std::io::stdin().take(1024 * 1024).read_to_end(&mut input)?;
        publish_session(&queue, &serde_json::from_slice(&input)?)
    })();
    0
}

pub fn run_status_hook(args: &[String]) -> i32 {
    let _ = (|| -> Result<()> {
        let queue = args.windows(2).find(|p| p[0] == "--queue").map(|p| PathBuf::from(&p[1])).context("missing queue")?;
        anyhow::ensure!(queue.join("settings.json").is_file(), "session ended");
        let mut input = Vec::new();
        std::io::stdin().take(1024 * 1024).read_to_end(&mut input)?;
        let value: Value = serde_json::from_slice(&input)?;
        fs::write(queue.join("status.json"), serde_json::to_vec(&value)?)?;
        Ok(())
    })();
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn project_status_line_is_preserved() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".claude")).unwrap();
        fs::write(root.path().join(".claude/settings.local.json"), r#"{"statusLine":{"type":"command","command":"existing"}}"#).unwrap();
        let session = prepare("status-test", root.path(), Path::new("helper.exe"), root.path(), &HashMap::new(), Arc::new(|_| {}), Arc::new(|_| {})).unwrap();
        let settings: Value = serde_json::from_slice(&fs::read(session.settings_path()).unwrap()).unwrap();
        assert!(settings.get("statusLine").is_none());
    }
    #[test]
    fn session_identity_and_plan_hooks_survive_without_file_capture() {
        let root = tempfile::tempdir().unwrap();
        let (send, receive) = mpsc::channel();
        let session = prepare("session-1", root.path(), Path::new("superhigh-cli.exe"), root.path(), &HashMap::new(), Arc::new(move |id| { send.send(id).unwrap(); }), Arc::new(|_| {})).unwrap();
        let settings: Value = serde_json::from_slice(&fs::read(session.settings_path()).unwrap()).unwrap();
        assert!(settings["hooks"].get("PreToolUse").is_none());
        assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "^(AskUserQuestion|ExitPlanMode)$");
        assert!(settings["hooks"].get("PermissionRequest").is_some());
        publish_session(&session.directory, &json!({"hook_event_name":"SessionStart","session_id":"native-1"})).unwrap();
        assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap(), "native-1");
        publish_session(&session.directory, &json!({"hook_event_name":"SessionStart","session_id":"native-2"})).unwrap();
        assert_eq!(receive.recv_timeout(Duration::from_secs(2)).unwrap(), "native-2");
        let directory = session.directory.clone();
        session.shutdown();
        assert!(!directory.exists());
    }
}
