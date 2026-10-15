//! Session-scoped Edit/Write evidence and command filesystem changes.
//! Command baselines are acknowledged before the model or command can execute.
use crate::agent_changes::{self, AgentTurnChanges, CommittedFileChange};
use crate::command_changes::CommandChanges;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_CONTENT: usize = 4 * 1024 * 1024;
type Observer = Arc<dyn Fn(AgentTurnChanges) + Send + Sync>;

pub struct ClaudeHooks {
    directory: PathBuf,
    settings: PathBuf,
    stopping: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
    plan_worker: Mutex<Option<JoinHandle<()>>>,
}

impl ClaudeHooks {
    pub fn settings_path(&self) -> &Path {
        &self.settings
    }
    pub fn pending_plan(&self, id: &Value) -> Option<crate::codex_plan::PlanRequest> {
        crate::claude_plan::pending(&self.directory, id)
    }
    pub fn reply_plan(&self, id: &Value, answers: HashMap<String, Vec<String>>) -> Result<()> {
        crate::claude_plan::reply(&self.directory, id, answers)
    }
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        for worker in [&self.worker, &self.plan_worker] {
            if let Some(worker) = worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = worker.join();
            }
        }
        // This is an exact session-owned directory, never a user configuration directory.
        let _ = fs::remove_file(&self.settings);
        for subdir in ["events", "acks", "plans"] {
            let _ = fs::remove_dir_all(self.directory.join(subdir));
        }
        let _ = fs::remove_dir(&self.directory);
    }
}
impl Drop for ClaudeHooks {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn prepare(
    session_id: &str,
    cwd: &Path,
    data_dir: &Path,
    helper_executable: &Path,
    observer: Observer,
    on_plan: Arc<dyn Fn(crate::codex_plan::PlanRequest) + Send + Sync>,
) -> Result<ClaudeHooks> {
    let safe: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    anyhow::ensure!(
        !safe.is_empty() && safe == session_id,
        "invalid Claude terminal session ID"
    );
    let directory = data_dir
        .join("agent-turn-changes")
        .join("claude-hooks")
        .join(safe);
    fs::create_dir_all(directory.join("events"))?;
    fs::create_dir_all(directory.join("acks"))?;
    let settings = directory.join("settings.json");
    let executable = helper_executable.to_string_lossy();
    let queue = directory.to_string_lossy();
    anyhow::ensure!(
        !executable.contains(['"', '\n', '\r']) && !queue.contains(['"', '\n', '\r']),
        "unsupported hook command path"
    );
    // Claude executes command hooks through its shell. Quoted absolute paths also work on Windows.
    let command = format!("\"{executable}\" agent-changes-hook --queue \"{queue}\"");
    let mut hooks = serde_json::Map::new();
    for event in [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "SubagentStart",
        "SubagentStop",
        "Stop",
        "StopFailure",
        "SessionEnd",
    ] {
        let mut entry = json!({"hooks":[{"type":"command","command":command,"timeout":45}]});
        if matches!(event, "PreToolUse" | "PostToolUse" | "PostToolUseFailure") {
            entry["matcher"] = json!("^(Edit|Write|Bash)$");
        }
        hooks.insert(event.into(), json!([entry]));
    }
    crate::claude_plan::prepare_dir(&directory)?;
    crate::claude_plan::install_hooks(&mut hooks, &executable, &queue);
    fs::write(&settings, serde_json::to_vec(&json!({"hooks":hooks}))?)?;
    let stopping = Arc::new(AtomicBool::new(false));
    let worker_dir = directory.clone();
    let worker_stop = Arc::clone(&stopping);
    let id = session_id.to_owned();
    let cwd = cwd.to_path_buf();
    let worker = thread::spawn(move || consume(&id, &cwd, &worker_dir, &worker_stop, observer));
    let plan_worker = crate::claude_plan::watch(directory.clone(), Arc::clone(&stopping), on_plan);
    Ok(ClaudeHooks {
        directory,
        settings,
        stopping,
        worker: Mutex::new(Some(worker)),
        plan_worker: Mutex::new(Some(plan_worker)),
    })
}

/// Invoked by superhigh-cli. Intentionally always silent and non-blocking to Claude policy.
/// A synchronous acknowledgement locks PreToolUse to its originating turn before the tool runs.
pub fn run_hook(args: &[String]) -> i32 {
    let result = (|| -> Result<()> {
        let queue = args
            .windows(2)
            .find(|pair| pair[0] == "--queue")
            .map(|p| PathBuf::from(&p[1]))
            .context("missing hook queue")?;
        anyhow::ensure!(queue.join("events").is_dir(), "hook collector has ended");
        let mut input = Vec::new();
        std::io::stdin()
            .take((MAX_CONTENT * 6 + 1) as u64)
            .read_to_end(&mut input)?;
        let event: Value = serde_json::from_slice(&input)
            .unwrap_or_else(|_| json!({"hook_event_name":"MalformedInput"}));
        let mut envelope = json!({"event":event});
        if envelope["event"]["hook_event_name"] == "PreToolUse"
            && envelope["event"]["tool_name"] != "Bash"
        {
            match capture_before(&envelope["event"]) {
                Ok(before) => envelope["before"] = before.map(Value::String).unwrap_or(Value::Null),
                Err(error) => envelope["captureError"] = json!(error.to_string()),
            }
        }
        // Malformed payloads are delivered as an unavailable event rather than silently counted.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let name = format!("{nanos:030}-{}", uuid::Uuid::new_v4());
        atomic_json(
            &queue.join("events").join(format!("{name}.json")),
            &envelope,
        )?;
        let ack = queue.join("acks").join(&name);
        for _ in 0..4000 {
            if ack.is_file() {
                let _ = fs::remove_file(ack);
                return Ok(());
            }
            if !queue.join("events").is_dir() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        bail!("hook collector acknowledgement timed out")
    })();
    let _ = result;
    0
}

fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let temp = path.with_extension("pending");
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    Ok(())
}

fn capture_before(event: &Value) -> Result<Option<String>> {
    let path = event
        .pointer("/tool_input/file_path")
        .and_then(Value::as_str)
        .context("missing native tool path")?;
    let path = Path::new(path);
    anyhow::ensure!(path.is_absolute(), "native file path is not absolute");
    if let Ok(metadata) = fs::metadata(path) {
        anyhow::ensure!(
            metadata.is_file() && metadata.len() <= MAX_CONTENT as u64,
            "before exceeds precise capture limit or is not a file"
        );
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    anyhow::ensure!(
        bytes.len() <= MAX_CONTENT,
        "before exceeds precise capture limit"
    );
    anyhow::ensure!(
        !bytes.starts_with(&[0xef, 0xbb, 0xbf]) && !bytes.contains(&0),
        "unsupported before encoding"
    );
    Ok(Some(
        String::from_utf8(bytes).context("before is not UTF-8")?,
    ))
}

#[derive(Clone)]
struct Pending {
    turn: String,
    before: Option<String>,
    input: Value,
    capture_error: Option<String>,
    command: bool,
}
#[derive(Default)]
struct Turn {
    pending: usize,
    active_agents: usize,
    stopping: bool,
    invalid: bool,
    chains: HashMap<String, Option<String>>,
    commands: Option<CommandChanges>,
    command_error: Option<String>,
    has_commands: bool,
}
struct State {
    native: String,
    current: Option<String>,
    agents: HashMap<String, String>,
    stopped_agents: HashSet<String>,
    pending: HashMap<String, Pending>,
    turns: HashMap<String, Turn>,
    seen: HashSet<String>,
    cwd: Option<PathBuf>,
    command_cache: Option<CommandChanges>,
}
impl State {
    fn new() -> Self {
        Self {
            native: String::new(),
            current: None,
            agents: HashMap::new(),
            stopped_agents: HashSet::new(),
            pending: HashMap::new(),
            turns: HashMap::new(),
            seen: HashSet::new(),
            cwd: None,
            command_cache: None,
        }
    }
    fn with_cwd(cwd: Option<&Path>) -> Self {
        let mut state = Self::new();
        state.cwd = cwd.map(Path::to_path_buf);
        state
    }
    fn chain_path(&self, path: &str) -> String {
        let path = Path::new(path);
        let full = if path.is_absolute() {
            path.to_path_buf()
        } else if let Some(cwd) = &self.cwd {
            cwd.join(path)
        } else {
            path.to_path_buf()
        };
        let key = full.to_string_lossy().replace('\\', "/");
        if cfg!(windows) {
            key.to_lowercase()
        } else {
            key
        }
    }
    fn refresh_commands(&mut self, id: &str, turn: &str, observer: &Observer) {
        if !self
            .turns
            .get(turn)
            .is_some_and(|state| state.has_commands && !state.invalid)
        {
            return;
        }
        let view = agent_changes::get_turn_changes(id);
        if view.native_session_id.as_deref() != Some(&self.native)
            || view.turn_id.as_deref() != Some(turn)
        {
            self.invalidate(
                id,
                Some(turn),
                "命令所属回合已切换，无法读取其结束时文件内容",
                observer,
            );
            return;
        }
        if view.completed
            && self
                .turns
                .get(turn)
                .is_some_and(|state| state.commands.is_none())
        {
            return;
        }
        let paths = view
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        let state = self.turns.get_mut(turn).unwrap();
        let result = if let Some(error) = &state.command_error {
            Err(anyhow::anyhow!(error.clone()))
        } else if let Some(commands) = &mut state.commands {
            commands.refresh(&self.native, turn, &paths)
        } else {
            Err(anyhow::anyhow!("缺少命令执行前文件基线"))
        };
        match result {
            Ok(changes) => {
                let chains = changes
                    .iter()
                    .map(|change| (self.chain_path(&change.path), change.after.clone()))
                    .collect::<Vec<_>>();
                let state = self.turns.get_mut(turn).unwrap();
                for (path, after) in chains {
                    state.chains.insert(path, after);
                }
                observer(agent_changes::overwrite_workspace_contents(
                    id,
                    &self.native,
                    turn,
                    &changes,
                ));
            }
            Err(error) => self.invalidate(
                id,
                Some(turn),
                &format!("命令文件变更无法完整统计：{error}"),
                observer,
            ),
        }
    }
    fn invalidate(&mut self, id: &str, turn: Option<&str>, reason: &str, observer: &Observer) {
        if let Some(turn) = turn {
            self.turns.entry(turn.into()).or_default().invalid = true;
        }
        if let Some(turn) = turn {
            observer(agent_changes::mark_native_unavailable(
                id,
                &self.native,
                turn,
                reason,
            ));
        } else if agent_changes::get_turn_changes(id)
            .native_session_id
            .as_deref()
            == Some(&self.native)
        {
            observer(agent_changes::mark_unavailable(id, None, reason));
        }
    }
    fn finish_if_ready(&mut self, id: &str, turn: &str, observer: &Observer) {
        if self
            .turns
            .get(turn)
            .is_some_and(|state| state.stopping && state.pending == 0 && state.active_agents == 0)
        {
            self.refresh_commands(id, turn, observer);
            if let Some(mut commands) = self
                .turns
                .get_mut(turn)
                .and_then(|state| state.commands.take())
            {
                commands.finish(&self.native, turn);
                if self.current.as_deref() == Some(turn) {
                    self.command_cache = Some(commands);
                }
            }
            observer(agent_changes::complete_turn(id, &self.native, turn));
        }
    }
    fn handle(&mut self, id: &str, envelope: &Value, observer: &Observer) -> Result<()> {
        let event = &envelope["event"];
        let kind = event["hook_event_name"]
            .as_str()
            .context("missing hook event")?;
        let native = event["session_id"]
            .as_str()
            .context("missing native session ID")?;
        if self.native.is_empty() {
            self.native = native.into();
        }
        anyhow::ensure!(
            self.native == native,
            "hook native session identity changed"
        );
        let agent = event["agent_id"].as_str().unwrap_or("");
        match kind {
            "SessionStart" => {}
            "UserPromptSubmit" => {
                // Native dispatches include background reports; each is a real main-agent round.
                if !agent.is_empty() {
                    return Ok(());
                }
                let turn = uuid::Uuid::new_v4().to_string();
                let mut state = Turn::default();
                if let Some(cwd) = &self.cwd {
                    let mut commands = self
                        .command_cache
                        .take()
                        .unwrap_or_else(|| CommandChanges::new(cwd));
                    state.command_error = commands
                        .prepare()
                        .and_then(|()| commands.begin(native, &turn))
                        .err()
                        .map(|error| error.to_string());
                    state.commands = Some(commands);
                }
                self.turns.insert(turn.clone(), state);
                self.current = Some(turn.clone());
                observer(agent_changes::begin_turn(id, native, &turn));
            }
            "SubagentStart" => {
                let turn = self
                    .current
                    .clone()
                    .context("subagent started without a main turn")?;
                anyhow::ensure!(!agent.is_empty(), "subagent lacks identity");
                // This event names the new child, not its spawning parent. A child spawned
                // by an old background agent cannot be attributed to the new main round.
                anyhow::ensure!(
                    !self
                        .turns
                        .iter()
                        .any(|(key, value)| key != &turn && value.active_agents > 0),
                    "overlapping background agent makes new child turn attribution unavailable"
                );
                if !self.agents.contains_key(agent) {
                    self.turns.entry(turn.clone()).or_default().active_agents += 1;
                    self.agents.insert(agent.into(), turn);
                }
            }
            "PreToolUse" => {
                let turn = if agent.is_empty() {
                    self.current.clone()
                } else {
                    self.agents.get(agent).cloned()
                }
                .context("tool has no trustworthy originating turn")?;
                let tool = event["tool_use_id"]
                    .as_str()
                    .context("tool lacks native identity")?;
                let key = format!("{native}\0{agent}\0{tool}");
                if self.pending.contains_key(&key) || self.seen.contains(&key) {
                    return Ok(());
                }
                // Another Stop hook can request continuation in the same native round.
                // Restore that round's original baseline, never a new post-tool baseline.
                if self.current.as_deref() == Some(&turn)
                    && self
                        .turns
                        .get(&turn)
                        .is_some_and(|state| state.commands.is_none())
                {
                    if let Some(mut commands) = self.command_cache.take() {
                        let error = commands
                            .resume(native, &turn)
                            .err()
                            .map(|error| error.to_string());
                        let state = self.turns.get_mut(&turn).unwrap();
                        state.commands = Some(commands);
                        if error.is_some() {
                            state.command_error = error;
                        }
                    }
                }
                let command = event["tool_name"] == "Bash";
                let state = self.turns.entry(turn.clone()).or_default();
                state.stopping = false;
                state.has_commands |= command;
                self.turns.entry(turn.clone()).or_default().pending += 1;
                self.pending.insert(
                    key,
                    Pending {
                        turn,
                        before: envelope["before"].as_str().map(str::to_owned),
                        input: event["tool_input"].clone(),
                        capture_error: envelope["captureError"].as_str().map(str::to_owned),
                        command,
                    },
                );
            }
            "PostToolUse" | "PostToolUseFailure" => {
                let tool = event["tool_use_id"]
                    .as_str()
                    .context("tool lacks native identity")?;
                let key = format!("{native}\0{agent}\0{tool}");
                if self.seen.contains(&key) {
                    return Ok(());
                }
                let pending = self
                    .pending
                    .remove(&key)
                    .context("tool completion lacks acknowledged before")?;
                self.seen.insert(key);
                let turn_state = self.turns.entry(pending.turn.clone()).or_default();
                turn_state.pending = turn_state.pending.saturating_sub(1);
                if pending.command {
                    // Exit status does not undo filesystem writes, including partial failure.
                    self.refresh_commands(id, &pending.turn, observer);
                    self.finish_if_ready(id, &pending.turn, observer);
                    return Ok(());
                }
                let reconstructed = if kind == "PostToolUseFailure" {
                    Err(anyhow::anyhow!("failed tool may have partially committed"))
                } else if let Some(error) = &pending.capture_error {
                    Err(anyhow::anyhow!(error.clone()))
                } else {
                    reconstruct(&pending, event)
                };
                match reconstructed {
                    Ok(Some(change)) => {
                        let chain_path = self.chain_path(&change.path);
                        let state = self.turns.entry(pending.turn.clone()).or_default();
                        if state
                            .chains
                            .get(&chain_path)
                            .is_some_and(|last| last != &change.before)
                        {
                            self.invalidate(
                                id,
                                Some(&pending.turn),
                                "同文件工具提交链不连续，无法精确统计本轮",
                                observer,
                            );
                        } else if !state.invalid {
                            state.chains.insert(chain_path, change.after.clone());
                            observer(agent_changes::commit_changes(
                                id,
                                native,
                                &pending.turn,
                                &[change],
                            ));
                        }
                    }
                    Ok(None) => {}
                    Err(_) => self.invalidate(
                        id,
                        Some(&pending.turn),
                        "Claude 工具结果不足以确认完整提交，本轮变更不可用",
                        observer,
                    ),
                }
                self.finish_if_ready(id, &pending.turn, observer);
            }
            "SubagentStop" => {
                // Retain originating bindings for duplicate/late tool events.
                if let Some(turn) = self.agents.get(agent).cloned() {
                    if self.stopped_agents.insert(agent.into()) {
                        let turn_state = self.turns.entry(turn.clone()).or_default();
                        turn_state.active_agents = turn_state.active_agents.saturating_sub(1);
                    }
                    self.finish_if_ready(id, &turn, observer);
                }
            }
            "Stop" | "StopFailure" | "SessionEnd" => {
                if let Some(turn) = self.current.clone() {
                    if kind == "StopFailure" {
                        self.invalidate(
                            id,
                            Some(&turn),
                            "Claude 本轮异常结束，无法确认完整提交",
                            observer,
                        );
                    }
                    self.turns.entry(turn.clone()).or_default().stopping = true;
                    self.finish_if_ready(id, &turn, observer);
                }
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Default)]
struct SessionStates {
    current_native: Option<String>,
    states: HashMap<String, State>,
    cwd: Option<PathBuf>,
}
impl SessionStates {
    fn handle(&mut self, id: &str, envelope: &Value, observer: &Observer) -> Result<()> {
        let event = &envelope["event"];
        let native = event["session_id"]
            .as_str()
            .context("missing native session ID")?;
        let session_start = event["hook_event_name"] == "SessionStart";
        if self.current_native.is_none() || session_start {
            if self.current_native.as_deref() != Some(native) {
                if let Some(old) = self
                    .current_native
                    .as_ref()
                    .and_then(|old| self.states.get_mut(old))
                {
                    old.command_cache = None;
                }
            }
            self.current_native = Some(native.into());
            observer(agent_changes::bind_native_session(id, native));
            let cwd = self.cwd.clone();
            self.states
                .entry(native.into())
                .or_insert_with(|| State::with_cwd(cwd.as_deref()));
        }
        let state = self
            .states
            .get_mut(native)
            .context("unknown native session without SessionStart")?;
        state.handle(id, envelope, observer)
    }
    fn invalidate_event(&mut self, id: &str, envelope: Option<&Value>, observer: &Observer) {
        let native = envelope
            .and_then(|e| e["event"]["session_id"].as_str())
            .map(str::to_owned)
            .or_else(|| self.current_native.clone());
        if let Some(state) = native.and_then(|native| self.states.get_mut(&native)) {
            let turn = state.current.clone();
            state.invalidate(
                id,
                turn.as_deref(),
                "Claude 原生工具事件缺失或顺序不可信，本轮变更不可用",
                observer,
            );
        }
    }
}

fn consume(id: &str, cwd: &Path, directory: &Path, stopping: &AtomicBool, observer: Observer) {
    let mut sessions = SessionStates {
        cwd: Some(cwd.to_path_buf()),
        ..SessionStates::default()
    };
    loop {
        let mut files: Vec<_> = fs::read_dir(directory.join("events"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect();
        files.sort();
        for path in files {
            let event = fs::read(&path)
                .map_err(anyhow::Error::from)
                .and_then(|bytes| Ok(serde_json::from_slice::<Value>(&bytes)?));
            let result = event
                .as_ref()
                .map_err(|e| anyhow::anyhow!(e.to_string()))
                .and_then(|event| sessions.handle(id, event, &observer));
            if result.is_err() {
                sessions.invalidate_event(id, event.as_ref().ok(), &observer);
            }
            if let Some(name) = path.file_stem() {
                let _ = fs::write(directory.join("acks").join(name), b"");
            }
            let _ = fs::remove_file(path);
        }
        if stopping.load(Ordering::Acquire) {
            for state in sessions.states.values_mut() {
                let turns: Vec<_> = state
                    .pending
                    .values()
                    .map(|pending| pending.turn.clone())
                    .collect();
                for turn in turns {
                    state.invalidate(
                        id,
                        Some(&turn),
                        "Claude 退出前工具未提供提交结果，本轮变更不可用",
                        &observer,
                    );
                }
            }
            break;
        }
        thread::sleep(Duration::from_millis(15));
    }
}

fn reconstruct(pending: &Pending, event: &Value) -> Result<Option<CommittedFileChange>> {
    let output = &event["tool_response"];
    anyhow::ensure!(output.is_object(), "native structured output missing");
    if output["staged"] == true {
        return Ok(None);
    }
    let path = output["filePath"].as_str().context("output path missing")?;
    anyhow::ensure!(
        Some(path) == pending.input["file_path"].as_str() && Path::new(path).is_absolute(),
        "output path changed"
    );
    let original = output.get("originalFile").context("originalFile missing")?;
    let before = if original.is_null() {
        pending.before.clone()
    } else {
        Some(
            original
                .as_str()
                .context("invalid originalFile")?
                .to_owned(),
        )
    };
    anyhow::ensure!(
        before == pending.before,
        "tool original differs from captured before"
    );
    anyhow::ensure!(
        !output["userModified"].as_bool().unwrap_or(false),
        "user modified tool proposal"
    );
    let after = match event["tool_name"].as_str() {
        Some("Write") => {
            anyhow::ensure!(
                matches!(output["type"].as_str(), Some("create" | "update")),
                "write status missing"
            );
            anyhow::ensure!(
                (output["type"] == "create") == before.is_none(),
                "write creation state differs"
            );
            output["content"]
                .as_str()
                .context("committed write content missing")?
                .to_owned()
        }
        Some("Edit") => {
            let base = before.as_deref().context("edit before missing")?;
            // Native fuzzy matching/newline normalisation is not guessed from requested strings.
            anyhow::ensure!(
                !base.contains('\r'),
                "CRLF edit cannot be proven byte-exact by this adapter"
            );
            let old = output["oldString"]
                .as_str()
                .context("executed oldString missing")?;
            let new = output["newString"]
                .as_str()
                .context("executed newString missing")?;
            anyhow::ensure!(
                !old.is_empty() && !old.contains('\r') && !new.contains('\r'),
                "unsupported edit newline or empty match"
            );
            let all = output["replaceAll"]
                .as_bool()
                .context("executed replaceAll missing")?;
            let count = base.matches(old).count();
            anyhow::ensure!(
                count > 0 && (all || count == 1),
                "replacement is not unambiguous"
            );
            if all {
                base.replace(old, new)
            } else {
                base.replacen(old, new, 1)
            }
        }
        _ => bail!("unsupported native tool"),
    };
    anyhow::ensure!(
        after.len() <= MAX_CONTENT && !after.contains('\0') && !after.starts_with('\u{feff}'),
        "unsupported after encoding or size"
    );
    // A verified patch prevents silently accepting stale input, fuzzy replacements, or truncated outputs.
    validate_patch(
        before.as_deref().unwrap_or(""),
        &after,
        &output["structuredPatch"],
    )?;
    Ok(Some(CommittedFileChange {
        path: path.into(),
        before,
        after: Some(after),
    }))
}

fn lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<_> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}
fn validate_patch(before: &str, after: &str, patch: &Value) -> Result<()> {
    // Patch format is line based. CRLF writes are accepted only with identical, proven line content.
    let old_text = before.replace("\r\n", "\n");
    let new_text = after.replace("\r\n", "\n");
    anyhow::ensure!(
        !old_text.contains('\r') && !new_text.contains('\r'),
        "unsupported lone carriage return"
    );
    let old = lines(&old_text);
    let new = lines(&new_text);
    let hunks = patch.as_array().context("native structuredPatch missing")?;
    if hunks.is_empty() {
        anyhow::ensure!(old == new, "native diff missing or timed out");
        return Ok(());
    }
    let mut result = Vec::<String>::new();
    let mut cursor = 0usize;
    for hunk in hunks {
        let old_start = hunk["oldStart"].as_u64().context("invalid oldStart")? as usize;
        let old_count = hunk["oldLines"].as_u64().context("invalid oldLines")? as usize;
        let new_start = hunk["newStart"].as_u64().context("invalid newStart")? as usize;
        let new_count = hunk["newLines"].as_u64().context("invalid newLines")? as usize;
        let start = if old_count == 0 {
            old_start
        } else {
            old_start.saturating_sub(1)
        };
        anyhow::ensure!(
            start >= cursor && start <= old.len(),
            "overlapping patch or invalid start"
        );
        result.extend(old[cursor..start].iter().map(|line| (*line).to_owned()));
        let expected_new = if new_count == 0 {
            new_start
        } else {
            new_start.saturating_sub(1)
        };
        anyhow::ensure!(expected_new == result.len(), "new patch position mismatch");
        cursor = start;
        let (mut removed, mut added) = (0usize, 0usize);
        for line in hunk["lines"].as_array().context("patch lines missing")? {
            let line = line.as_str().context("patch line is not text")?;
            if line == "\\ No newline at end of file" {
                continue;
            }
            let (sign, text) = line.split_at(
                line.char_indices()
                    .nth(1)
                    .map_or(line.len(), |(offset, _)| offset),
            );
            match sign {
                " " | "-" => {
                    anyhow::ensure!(
                        old.get(cursor).copied() == Some(text),
                        "patch old context mismatch"
                    );
                    cursor += 1;
                    removed += 1;
                    if sign == " " {
                        result.push(text.into());
                        added += 1;
                    }
                }
                "+" => {
                    result.push(text.into());
                    added += 1;
                }
                _ => bail!("unknown patch row"),
            }
        }
        anyhow::ensure!(
            removed == old_count && added == new_count,
            "patch hunk counts mismatch"
        );
    }
    result.extend(old[cursor..].iter().map(|line| (*line).to_owned()));
    anyhow::ensure!(
        result.iter().map(String::as_str).eq(new),
        "patch does not reconstruct committed content"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_session(root: &Path) -> (String, String, SessionStates, Observer) {
        let id = uuid::Uuid::new_v4().to_string();
        let native = uuid::Uuid::new_v4().to_string();
        agent_changes::register_session(&id, "claude", root, None);
        let mut sessions = SessionStates {
            cwd: Some(root.to_path_buf()),
            ..SessionStates::default()
        };
        let observer: Observer = Arc::new(|_| {});
        sessions
            .handle(
                &id,
                &json!({"event":{"session_id":native,"hook_event_name":"SessionStart"}}),
                &observer,
            )
            .unwrap();
        (id, native, sessions, observer)
    }

    fn command_event(
        sessions: &mut SessionStates,
        id: &str,
        native: &str,
        kind: &str,
        tool: &str,
        observer: &Observer,
    ) {
        sessions.handle(id, &json!({"event":{"session_id":native,"hook_event_name":kind,"tool_name":"Bash","tool_use_id":tool,"tool_input":{"command":"write test file"}}}), observer).unwrap();
    }

    #[test]
    fn changes_bash_create_delete_next_turn_and_stop_continuation() {
        let root = tempfile::tempdir().unwrap();
        let (id, native, mut sessions, observer) = command_session(root.path());
        command_event(
            &mut sessions,
            &id,
            &native,
            "UserPromptSubmit",
            "",
            &observer,
        );
        command_event(&mut sessions, &id, &native, "PreToolUse", "one", &observer);
        fs::create_dir_all(root.path().join(".agent/tmp/case")).unwrap();
        let path = root.path().join(".agent/tmp/case/change.txt");
        fs::write(&path, "created\n").unwrap();
        command_event(&mut sessions, &id, &native, "PostToolUse", "one", &observer);
        let first = agent_changes::get_turn_changes(&id);
        assert!(first.available, "{:?}", first.reason);
        assert_eq!((first.files.len(), first.additions), (1, 1));
        command_event(&mut sessions, &id, &native, "PreToolUse", "two", &observer);
        fs::remove_file(&path).unwrap();
        command_event(
            &mut sessions,
            &id,
            &native,
            "PostToolUseFailure",
            "two",
            &observer,
        );
        assert!(agent_changes::get_turn_changes(&id).files.is_empty());
        command_event(&mut sessions, &id, &native, "Stop", "", &observer);

        command_event(
            &mut sessions,
            &id,
            &native,
            "UserPromptSubmit",
            "",
            &observer,
        );
        command_event(
            &mut sessions,
            &id,
            &native,
            "PreToolUse",
            "three",
            &observer,
        );
        fs::write(&path, "next\n").unwrap();
        command_event(
            &mut sessions,
            &id,
            &native,
            "PostToolUseFailure",
            "three",
            &observer,
        );
        command_event(&mut sessions, &id, &native, "Stop", "", &observer);
        command_event(&mut sessions, &id, &native, "SessionEnd", "", &observer);
        let kept = agent_changes::get_turn_changes(&id);
        assert!(kept.available && kept.completed, "{:?}", kept.reason);
        assert_eq!(
            (kept.files.len(), kept.additions, kept.deletions),
            (1, 1, 0)
        );

        // Another Stop hook can continue this same turn after our Stop acknowledgement.
        command_event(&mut sessions, &id, &native, "PreToolUse", "four", &observer);
        fs::remove_file(&path).unwrap();
        command_event(
            &mut sessions,
            &id,
            &native,
            "PostToolUse",
            "four",
            &observer,
        );
        let restored = agent_changes::get_turn_changes(&id);
        assert!(restored.available && !restored.completed);
        assert_eq!(restored.turn_id, kept.turn_id);
        assert!(restored.files.is_empty());
        command_event(&mut sessions, &id, &native, "Stop", "", &observer);
        assert!(agent_changes::get_turn_changes(&id).completed);
    }

    #[test]
    fn changes_bash_and_native_write_share_one_content_chain() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("file.txt");
        fs::write(&path, "base\n").unwrap();
        let (id, native, mut sessions, observer) = command_session(root.path());
        command_event(
            &mut sessions,
            &id,
            &native,
            "UserPromptSubmit",
            "",
            &observer,
        );
        for (tool, before, after) in [
            ("first", "base\n", "native\n"),
            ("last", "shell\n", "final\n"),
        ] {
            sessions.handle(&id, &json!({"before":before,"event":{"session_id":native,"hook_event_name":"PreToolUse","tool_name":"Write","tool_use_id":tool,"tool_input":{"file_path":path}}}), &observer).unwrap();
            fs::write(&path, after).unwrap();
            sessions.handle(&id, &json!({"event":{"session_id":native,"hook_event_name":"PostToolUse","tool_name":"Write","tool_use_id":tool,"tool_response":{"filePath":path,"type":"update","originalFile":before,"content":after,"structuredPatch":[{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":[format!("-{}",before.trim_end()),format!("+{}",after.trim_end())]}]}}}), &observer).unwrap();
            if tool == "first" {
                command_event(
                    &mut sessions,
                    &id,
                    &native,
                    "PreToolUse",
                    "shell",
                    &observer,
                );
                fs::write(&path, "shell\n").unwrap();
                command_event(
                    &mut sessions,
                    &id,
                    &native,
                    "PostToolUse",
                    "shell",
                    &observer,
                );
            }
        }
        let changed = agent_changes::get_turn_changes(&id);
        assert!(changed.available, "{:?}", changed.reason);
        assert_eq!(
            (changed.files.len(), changed.additions, changed.deletions),
            (1, 1, 1)
        );
        assert_eq!(changed.files[0].path, "file.txt");
        command_event(
            &mut sessions,
            &id,
            &native,
            "PreToolUse",
            "restore",
            &observer,
        );
        fs::write(&path, "base\n").unwrap();
        command_event(
            &mut sessions,
            &id,
            &native,
            "PostToolUse",
            "restore",
            &observer,
        );
        let restored = agent_changes::get_turn_changes(&id);
        assert!(
            restored.available && restored.files.is_empty(),
            "{:?}",
            restored.reason
        );
    }

    #[test]
    fn changes_late_bash_after_native_switch_does_not_scan_new_turn() {
        let root = tempfile::tempdir().unwrap();
        let (id, native, mut sessions, observer) = command_session(root.path());
        command_event(
            &mut sessions,
            &id,
            &native,
            "UserPromptSubmit",
            "",
            &observer,
        );
        command_event(&mut sessions, &id, &native, "PreToolUse", "old", &observer);
        fs::write(root.path().join("old.txt"), "old\n").unwrap();
        let next_native = uuid::Uuid::new_v4().to_string();
        command_event(
            &mut sessions,
            &id,
            &next_native,
            "SessionStart",
            "",
            &observer,
        );
        command_event(
            &mut sessions,
            &id,
            &next_native,
            "UserPromptSubmit",
            "",
            &observer,
        );
        command_event(
            &mut sessions,
            &id,
            &next_native,
            "PreToolUse",
            "new",
            &observer,
        );
        fs::write(root.path().join("new.txt"), "new\n").unwrap();
        command_event(
            &mut sessions,
            &id,
            &next_native,
            "PostToolUse",
            "new",
            &observer,
        );
        command_event(&mut sessions, &id, &native, "PostToolUse", "old", &observer);
        let view = agent_changes::get_turn_changes(&id);
        assert!(view.available, "{:?}", view.reason);
        assert_eq!(
            view.native_session_id.as_deref(),
            Some(next_native.as_str())
        );
        assert_eq!(view.files.len(), 1);
        assert_eq!(view.files[0].path, "new.txt");
    }

    #[test]
    fn new_native_session_keeps_late_old_tool_evidence() {
        let id = uuid::Uuid::new_v4().to_string();
        agent_changes::register_session(&id, "claude", Path::new("/workspace"), None);
        let observer: Observer = Arc::new(|_| {});
        let mut sessions = SessionStates::default();
        let (pending, mut post) = edit(
            "a\n",
            "a",
            "b",
            false,
            json!([{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]}]),
        );
        for native in ["mainA", "mainB"] {
            sessions
                .handle(
                    &id,
                    &json!({"event":{"session_id":native,"hook_event_name":"SessionStart"}}),
                    &observer,
                )
                .unwrap();
            sessions
                .handle(
                    &id,
                    &json!({"event":{"session_id":native,"hook_event_name":"UserPromptSubmit"}}),
                    &observer,
                )
                .unwrap();
            sessions.handle(&id,&json!({"before":pending.before,"event":{"session_id":native,"hook_event_name":"PreToolUse","tool_use_id":"tool","tool_input":pending.input}}),&observer).unwrap();
        }
        let old_turn = sessions.states["mainA"].current.clone().unwrap();
        let new_turn = sessions.states["mainB"].current.clone().unwrap();
        post["session_id"] = json!("mainA");
        post["hook_event_name"] = json!("PostToolUse");
        post["tool_use_id"] = json!("tool");
        sessions
            .handle(&id, &json!({"event":post}), &observer)
            .unwrap();
        let current = agent_changes::get_turn_changes(&id);
        assert_eq!(current.native_session_id.as_deref(), Some("mainB"));
        assert_eq!(current.turn_id.as_deref(), Some(new_turn.as_str()));
        assert!(current.files.is_empty());
        let path = pending.input["file_path"].as_str().unwrap();
        assert_eq!(
            agent_changes::get_file_diff(&id, &old_turn, path)
                .unwrap()
                .rows
                .last()
                .unwrap()
                .text,
            "b"
        );
        sessions
            .handle(
                &id,
                &json!({"event":{"session_id":"mainA","hook_event_name":"SessionEnd"}}),
                &observer,
            )
            .unwrap();
        assert!(!agent_changes::get_turn_changes(&id).completed);
        post["session_id"] = json!("mainB");
        sessions
            .handle(&id, &json!({"event":post}), &observer)
            .unwrap();
        let current = agent_changes::get_turn_changes(&id);
        assert_eq!(current.native_session_id.as_deref(), Some("mainB"));
        assert_eq!(current.files.len(), 1);
        assert_eq!(
            agent_changes::get_file_diff(&id, &new_turn, path)
                .unwrap()
                .rows
                .last()
                .unwrap()
                .text,
            "b"
        );
    }
    fn edit(before: &str, old: &str, new: &str, all: bool, patch: Value) -> (Pending, Value) {
        let path = if cfg!(windows) {
            "D:\\example.txt"
        } else {
            "/example.txt"
        };
        (
            Pending {
                turn: "turn".into(),
                before: Some(before.into()),
                input: json!({"file_path":path}),
                capture_error: None,
                command: false,
            },
            json!({"tool_name":"Edit","tool_response":{"filePath":path,"originalFile":before,"oldString":old,"newString":new,
            "replaceAll":all,"userModified":false,"structuredPatch":patch}}),
        )
    }
    #[test]
    fn exact_edit_and_replace_all() {
        let (pre, event) = edit(
            "a\na\n",
            "a",
            "b",
            true,
            json!([{"oldStart":1,"oldLines":2,"newStart":1,"newLines":2,"lines":["-a","-a","+b","+b"]}]),
        );
        assert_eq!(
            reconstruct(&pre, &event).unwrap().unwrap().after.as_deref(),
            Some("b\nb\n")
        );
    }
    #[test]
    fn rejects_ambiguous_crlf_and_missing_delta() {
        for (before, all) in [("a\na\n", false), ("a\r\n", false), ("a\n", false)] {
            let (pre, event) = edit(before, "a", "b", all, json!([]));
            assert!(reconstruct(&pre, &event).is_err());
        }
    }
    #[test]
    fn staged_edit_is_not_committed() {
        let (pre, mut event) = edit("a", "a", "b", false, json!([]));
        event["tool_response"]["staged"] = json!(true);
        assert!(reconstruct(&pre, &event).unwrap().is_none());
    }
    #[test]
    fn patch_validates_disjoint_hunks_and_zero_length_addition() {
        assert!(validate_patch(
            "",
            "hello\n",
            &json!([{"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+hello"]}])
        )
        .is_ok());
        assert!(validate_patch(
            "a\nb\nc\n",
            "x\nb\ny\n",
            &json!([
            {"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+x"]},
            {"oldStart":3,"oldLines":1,"newStart":3,"newLines":1,"lines":["-c","+y"]}])
        )
        .is_ok());
    }
    #[test]
    fn write_uses_structured_content_and_verifies_patch() {
        let path = if cfg!(windows) {
            "D:\\example.txt"
        } else {
            "/example.txt"
        };
        let pending = Pending {
            turn: "turn".into(),
            before: None,
            input: json!({"file_path":path,"content":"requested"}),
            capture_error: None,
            command: false,
        };
        let mut event = json!({"tool_name":"Write","tool_response":{"filePath":path,"type":"create","content":"actual\r\n","originalFile":null,
            "structuredPatch":[{"oldStart":0,"oldLines":0,"newStart":1,"newLines":1,"lines":["+actual"]}]}});
        assert_eq!(
            reconstruct(&pending, &event)
                .unwrap()
                .unwrap()
                .after
                .as_deref(),
            Some("actual\r\n")
        );
        event["tool_response"]["structuredPatch"] = json!([]);
        assert!(reconstruct(&pending, &event).is_err());
    }

    #[test]
    fn late_subagent_completion_keeps_its_originating_turn() {
        let observer: Observer = Arc::new(|_| {});
        let mut state = State::new();
        let session = uuid::Uuid::new_v4().to_string();
        let send = |state: &mut State, event: Value| {
            state
                .handle(&session, &json!({"event":event,"before":"a\n"}), &observer)
                .unwrap();
        };
        send(
            &mut state,
            json!({"session_id":"native","hook_event_name":"UserPromptSubmit"}),
        );
        let first = state.current.clone().unwrap();
        send(
            &mut state,
            json!({"session_id":"native","hook_event_name":"SubagentStart","agent_id":"child"}),
        );
        let path = if cfg!(windows) {
            "D:\\example.txt"
        } else {
            "/example.txt"
        };
        send(
            &mut state,
            json!({"session_id":"native","hook_event_name":"PreToolUse","agent_id":"child","tool_use_id":"tool","tool_input":{"file_path":path}}),
        );
        send(
            &mut state,
            json!({"session_id":"native","hook_event_name":"UserPromptSubmit"}),
        );
        let second = state.current.clone().unwrap();
        send(
            &mut state,
            json!({"session_id":"native","hook_event_name":"PostToolUseFailure","agent_id":"child","tool_use_id":"tool"}),
        );
        assert_ne!(first, second);
        assert!(state.turns[&first].invalid);
        assert!(!state.turns[&second].invalid);
        assert_eq!(state.turns[&first].pending, 0);
    }

    #[test]
    fn successful_duplicate_completion_is_not_counted_twice() {
        let observer: Observer = Arc::new(|_| {});
        let mut state = State::new();
        let session = uuid::Uuid::new_v4().to_string();
        state
            .handle(
                &session,
                &json!({"event":{"session_id":"native","hook_event_name":"UserPromptSubmit"}}),
                &observer,
            )
            .unwrap();
        let (pending, mut event) = edit(
            "a\n",
            "a",
            "b",
            false,
            json!([{"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]}]),
        );
        state.handle(&session, &json!({"before":pending.before,"event":{"session_id":"native","hook_event_name":"PreToolUse","tool_use_id":"tool","tool_input":pending.input}}), &observer).unwrap();
        event["session_id"] = json!("native");
        event["tool_use_id"] = json!("tool");
        event["hook_event_name"] = json!("PostToolUse");
        state
            .handle(&session, &json!({"event":event}), &observer)
            .unwrap();
        state
            .handle(&session, &json!({"event":event}), &observer)
            .unwrap();
        let turn = state.current.as_ref().unwrap();
        assert_eq!(state.turns[turn].pending, 0);
        assert_eq!(state.turns[turn].chains.len(), 1);
        assert!(!state.turns[turn].invalid);
    }
}
