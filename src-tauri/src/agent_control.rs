//! One desktop-owned task registry, shared by the CLI and every MCP connection.
//! PTY delivery is only submission; native turn evidence confirms acceptance and completion.
use crate::{
    cli_chat::{ChatTranscript, ChatTurn},
    terminal::{SharedTerminalManager, TerminalInspection},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};
use tauri::Emitter;

const MAX_TASKS: usize = 256;
const OUTPUT_BYTES: usize = 16 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentRequest {
    pub operation: String,
    pub arguments: Value,
    pub caller_session_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionArgs {
    project: Option<String>,
    session_id: Option<String>,
    provider: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubmitArgs {
    session_id: Option<String>,
    project: Option<String>,
    provider: Option<String>,
    prompt: String,
    request_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskArgs {
    task_id: Option<String>,
    session_id: Option<String>,
    timeout_ms: Option<u64>,
    offset: Option<usize>,
    #[serde(default)]
    include_logs: bool,
}

struct Task {
    id: String,
    session_id: String,
    provider: String,
    project: String,
    caller: Option<String>,
    original: SubmitArgs,
    marker: String,
    status: &'static str,
    created_at: i64,
    turn_id: Option<String>,
    native_session_id: Option<String>,
    answer: String,
    progress: Vec<Value>,
    error: Option<String>,
}

impl Task {
    fn finished(&self) -> bool {
        matches!(
            self.status,
            "completed" | "interrupted" | "failed" | "superseded"
        )
    }
    fn view(&self, offset: usize) -> Value {
        let (answer, next) = chunk(&self.answer, offset, OUTPUT_BYTES);
        json!({"taskId": self.id, "sessionId": self.session_id, "provider": self.provider,
            "project": self.project, "status": self.status, "finished": self.finished(),
            "createdAt": self.created_at, "turnId": self.turn_id, "nativeSessionId": self.native_session_id,
            "answer": answer, "answerNextOffset": next, "answerTotalBytes": self.answer.len(),
            "progress": self.progress, "error": self.error})
    }
}

#[derive(Default)]
struct Store {
    tasks: BTreeMap<String, Task>,
    created_sessions: HashSet<String>,
}
fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}

struct Observation {
    transcript: ChatTranscript,
    completion: Option<(String, i64)>,
}
fn observe(
    _terminal: &SharedTerminalManager,
    session: &TerminalInspection,
) -> Result<Option<Observation>> {
    let Some(source) = crate::terminal::claimed_cli_source(&session.id) else {
        return Ok(None);
    };
    Ok(Some(Observation {
        transcript: crate::cli_chat::read_chat(&session.provider_kind, &source)?,
        completion: crate::cli_completion::latest_completion(&session.provider_kind, &source)?,
    }))
}

fn native_finished(turn: &ChatTurn, observation: &Observation) -> bool {
    observation.completion.as_ref().is_some_and(|(id, at)| {
        turn.completed_at.is_some() && (*at == turn.completed_at.unwrap() || id == &turn.id)
    })
}

fn apply_observation(task: &mut Task, observation: &Observation) {
    if task.finished() {
        return;
    }
    let Some(turn) = observation
        .transcript
        .turns
        .iter()
        .find(|turn| match &task.turn_id {
            Some(id) => &turn.id == id,
            None => turn.prompt.contains(&task.marker),
        })
    else {
        return;
    };
    task.turn_id = Some(turn.id.clone());
    task.answer = turn.answer.clone();
    task.progress = turn
        .steps
        .iter()
        .rev()
        .filter(|step| step.kind == "tool")
        .take(8)
        .map(|step| json!({"title": step.title, "detail": step.detail}))
        .collect();
    task.progress.reverse();
    if turn.interrupted {
        task.status = "interrupted";
    } else if native_finished(turn, observation) {
        task.status = "completed";
    } else if observation
        .transcript
        .turns
        .last()
        .is_some_and(|last| last.id != turn.id)
    {
        task.status = "superseded";
        task.error = Some(
            "Another turn replaced this task before its native completion was confirmed.".into(),
        );
    } else if task.status != "cancelling" {
        task.status = "running";
    }
}

fn refresh(terminal: &SharedTerminalManager, task: &mut Task) -> Result<()> {
    if task.finished() {
        return Ok(());
    }
    let session = terminal
        .inspect_sessions(None)?
        .into_iter()
        .find(|s| s.id == task.session_id);
    if let Some(session) = &session {
        if let Some(observation) = observe(terminal, session)? {
            apply_observation(task, &observation);
        }
        task.native_session_id = terminal.session_chat_context(&task.session_id).and_then(|(_, _, native)| native);
    }
    if !task.finished() && !session.is_some_and(|s| s.running) {
        task.status = "failed";
        task.error = Some("Session exited or closed without a confirmed task result.".into());
    }
    Ok(())
}

fn session(terminal: &SharedTerminalManager, id: &str) -> Result<TerminalInspection> {
    terminal
        .inspect_sessions(None)?
        .into_iter()
        .find(|s| s.id == id)
        .context("session not found")
}
fn supported(provider: &str) -> Result<()> {
    anyhow::ensure!(
        matches!(provider, "codex" | "claude"),
        "agent control supports codex and claude sessions only"
    );
    Ok(())
}
fn project(value: &str) -> Result<&Path> {
    let path = Path::new(value);
    anyhow::ensure!(
        path.is_absolute() && path.is_dir(),
        "project must be an existing absolute directory"
    );
    Ok(path)
}
fn required<'a>(value: &'a Option<String>, name: &str) -> Result<&'a str> {
    value
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .with_context(|| format!("{name} is required"))
}

fn reject_cycle(registry: &Store, caller: Option<&str>, target: Option<&str>) -> Result<()> {
    let mut current = caller;
    let mut seen = HashSet::new();
    while let Some(id) = current {
        anyhow::ensure!(
            target != Some(id),
            "cannot delegate to or wait for your own session or an ancestor session"
        );
        anyhow::ensure!(
            seen.insert(id) && seen.len() <= 8,
            "delegation chain exceeds 8 sessions or contains a cycle"
        );
        current = registry
            .tasks
            .values()
            .find(|t| t.session_id == id && !t.finished())
            .and_then(|t| t.caller.as_deref());
    }
    Ok(())
}

fn make_room(registry: &mut Store) -> Result<()> {
    if registry.tasks.len() >= MAX_TASKS {
        let oldest = registry
            .tasks
            .values()
            .filter(|t| t.finished())
            .min_by_key(|t| t.created_at)
            .map(|t| t.id.clone());
        if let Some(id) = oldest {
            registry.tasks.remove(&id);
        }
    }
    anyhow::ensure!(
        registry.tasks.len() < MAX_TASKS,
        "task registry is full; finish existing tasks first"
    );
    Ok(())
}

fn create(
    app: &tauri::AppHandle,
    terminal: &SharedTerminalManager,
    provider: &str,
    path: &str,
) -> Result<TerminalInspection> {
    supported(provider)?;
    let created = terminal.create_session_for_workspace(
        app,
        None,
        provider,
        project(path)?,
        Default::default(),
        None,
    )?;
    let _ = app.emit("agent-terminal-created", &created);
    session(terminal, &created.id)
}

fn submit(
    app: &tauri::AppHandle,
    terminal: &SharedTerminalManager,
    args: SubmitArgs,
    caller: Option<String>,
) -> Result<Value> {
    anyhow::ensure!(
        !args.prompt.trim().is_empty() && args.prompt.len() <= 64 * 1024,
        "prompt must contain 1..65536 UTF-8 bytes"
    );
    anyhow::ensure!(
        args.request_id
            .as_ref()
            .is_none_or(|id| !id.trim().is_empty() && id.len() <= 128),
        "requestId must contain 1..128 bytes"
    );
    let mut registry = store()
        .lock()
        .map_err(|_| anyhow::anyhow!("task registry unavailable"))?;
    if let Some(request_id) = &args.request_id {
        if let Some(id) = registry
            .tasks
            .values()
            .find(|t| t.original.request_id.as_ref() == Some(request_id) && t.caller == caller)
            .map(|t| t.id.clone())
        {
            let task = registry.tasks.get_mut(&id).unwrap();
            anyhow::ensure!(
                task.original == args,
                "requestId already belongs to a different submission"
            );
            refresh(terminal, task)?;
            return Ok(task.view(0));
        }
    }
    reject_cycle(&registry, caller.as_deref(), args.session_id.as_deref())?;
    for task in registry.tasks.values_mut().filter(|t| !t.finished()) {
        refresh(terminal, task)?;
    }
    make_room(&mut registry)?;
    let target = if let Some(id) = &args.session_id {
        anyhow::ensure!(
            args.project.is_none() && args.provider.is_none(),
            "use sessionId OR project/provider, not both"
        );
        session(terminal, id)?
    } else {
        create(
            app,
            terminal,
            required(&args.provider, "provider")?,
            required(&args.project, "project")?,
        )?
    };
    supported(&target.provider_kind)?;
    anyhow::ensure!(target.running, "session has exited");
    anyhow::ensure!(
        !registry
            .tasks
            .values()
            .any(|t| t.session_id == target.id && !t.finished()),
        "session already has an active delegated task"
    );
    let is_new = args.session_id.is_none();
    if is_new {
        registry.created_sessions.insert(target.id.clone());
    }
    if !is_new {
        match observe(terminal, &target)? {
            Some(observation) => {
                if let Some(last) = observation.transcript.turns.last() {
                    anyhow::ensure!(
                        last.interrupted || native_finished(last, &observation),
                        "session has an unfinished native turn; choose a new session"
                    );
                }
            }
            None => anyhow::ensure!(
                registry.created_sessions.contains(&target.id),
                "native session state is not available yet; inspect it or create a new session"
            ),
        }
    }
    let input = crate::terminal::initial_prompt_input(
        &target.provider_kind,
        Path::new(&target.cwd),
        &args.prompt,
    )?;
    let marker = input
        .rsplit('/')
        .next()
        .context("prompt file marker missing")?
        .to_owned();
    let id = uuid::Uuid::new_v4().to_string();
    let mut task = Task {
        id: id.clone(),
        session_id: target.id.clone(),
        provider: target.provider_kind,
        project: target.cwd,
        caller,
        original: args,
        marker,
        status: "submitted",
        created_at: now(),
        turn_id: None,
        native_session_id: None,
        answer: String::new(),
        progress: Vec::new(),
        error: None,
    };
    // Same startup allowance as the desktop launch path. Acceptance is still proved by the native log.
    if let Some((_, started, _)) = terminal.session_chat_context(&task.session_id) {
        if let Some(delay) =
            Duration::from_millis(800).checked_sub(started.elapsed().unwrap_or_default())
        {
            std::thread::sleep(delay);
        }
    }
    if let Err(error) = terminal
        .write_input(&task.session_id, &input)
        .and_then(|_| {
            std::thread::sleep(Duration::from_millis(150));
            terminal.write_input(&task.session_id, "\r")
        })
    {
        task.status = "failed";
        task.error = Some(error.to_string());
    }
    if is_new {
        registry.created_sessions.insert(task.session_id.clone());
    }
    let view = task.view(0);
    registry.tasks.insert(id, task);
    Ok(view)
}

fn task_result(terminal: &SharedTerminalManager, args: &TaskArgs) -> Result<Value> {
    let mut registry = store()
        .lock()
        .map_err(|_| anyhow::anyhow!("task registry unavailable"))?;
    let task = registry
        .tasks
        .get_mut(required(&args.task_id, "taskId")?)
        .context("task not found (tasks are retained until desktop exit or history eviction)")?;
    refresh(terminal, task)?;
    let mut view = task.view(args.offset.unwrap_or(0));
    if args.include_logs {
        view["logs"] = logs(terminal, &task.session_id).unwrap_or(Value::Null);
    }
    Ok(view)
}

fn logs(terminal: &SharedTerminalManager, id: &str) -> Result<Value> {
    let buffer = terminal.terminal_buffer(id)?;
    let start = buffer.buffer.len().saturating_sub(8192);
    let (text, _) = chunk(&buffer.buffer, start, 8192);
    Ok(
        json!({"text": text, "startByte": buffer.start_byte + (buffer.buffer.len() - text.len()) as u64,
        "endByte": buffer.end_byte, "truncated": buffer.start_byte > 0 || start > 0}),
    )
}

fn execute(
    app: &tauri::AppHandle,
    terminal: &SharedTerminalManager,
    request: AgentRequest,
) -> Result<Value> {
    crate::cli_mcp::validate_arguments(
        request
            .operation
            .strip_prefix("agent.")
            .context("invalid agent operation")?,
        &request.arguments,
    )?;
    match request.operation.as_str() {
        "agent.sessions_list" => {
            let args: SessionArgs = serde_json::from_value(request.arguments)?;
            anyhow::ensure!(
                args.session_id.is_none() && args.provider.is_none(),
                "sessions_list only accepts project"
            );
            let path = args.project.as_deref().map(project).transpose()?;
            let mut registry = store().lock().unwrap();
            for task in registry.tasks.values_mut().filter(|t| !t.finished()) {
                refresh(terminal, task)?;
            }
            let sessions = terminal.inspect_sessions(path)?.into_iter().filter(|s| matches!(s.provider_kind.as_str(), "codex" | "claude")).map(|s| {
                let active = registry.tasks.values().find(|t| t.session_id == s.id && !t.finished());
                json!({"session": s, "activeTaskId": active.map(|t| &t.id), "callerSession": request.caller_session_id.as_ref() == Some(&s.id)})
            }).collect::<Vec<_>>();
            Ok(json!({"sessions": sessions, "callerSessionId": request.caller_session_id}))
        }
        "agent.sessions_create" => {
            let args: SessionArgs = serde_json::from_value(request.arguments)?;
            anyhow::ensure!(
                args.session_id.is_none(),
                "sessions_create does not accept sessionId"
            );
            let mut registry = store().lock().unwrap();
            reject_cycle(&registry, request.caller_session_id.as_deref(), None)?;
            let created = create(
                app,
                terminal,
                required(&args.provider, "provider")?,
                required(&args.project, "project")?,
            )?;
            registry.created_sessions.insert(created.id.clone());
            Ok(json!({"session": created}))
        }
        "agent.sessions_get" | "agent.sessions_close" => {
            let args: SessionArgs = serde_json::from_value(request.arguments)?;
            anyhow::ensure!(
                args.project.is_none() && args.provider.is_none(),
                "this operation only accepts sessionId"
            );
            let id = required(&args.session_id, "sessionId")?;
            let target = session(terminal, id)?;
            supported(&target.provider_kind)?;
            if request.operation == "agent.sessions_close" {
                let mut registry = store().lock().unwrap();
                reject_cycle(&registry, request.caller_session_id.as_deref(), Some(id))?;
                anyhow::ensure!(registry.created_sessions.contains(id), "only agent-created sessions can be closed here; use the desktop for other sessions");
                for task in registry.tasks.values_mut().filter(|t| t.session_id == id) {
                    refresh(terminal, task)?;
                }
                anyhow::ensure!(
                    !registry
                        .tasks
                        .values()
                        .any(|t| t.session_id == id && !t.finished()),
                    "session has an active task; cancel it and confirm completion before closing"
                );
                if let Some(observation) = observe(terminal, &target)? {
                    if let Some(last) = observation.transcript.turns.last() {
                        anyhow::ensure!(
                            last.interrupted || native_finished(last, &observation),
                            "session has an unfinished native turn"
                        );
                    }
                }
                terminal.close_session(id)?;
                registry.created_sessions.remove(id);
                return Ok(json!({"sessionId": id, "closed": true}));
            }
            let observation = observe(terminal, &target)?;
            let current = observation.as_ref().and_then(|o| {
                o.transcript.turns.last().map(|turn| {
                    json!({"turnId": turn.id, "prompt": chunk(&turn.prompt, 0, 2048).0,
                    "completed": native_finished(turn, o), "interrupted": turn.interrupted,
                    "answer": chunk(&turn.answer, 0, OUTPUT_BYTES).0})
                })
            });
            Ok(json!({"session": target, "currentTurn": current, "logs": logs(terminal, id)?}))
        }
        "agent.tasks_submit" => submit(
            app,
            terminal,
            serde_json::from_value(request.arguments)?,
            request.caller_session_id,
        ),
        "agent.tasks_get" | "agent.tasks_wait" | "agent.tasks_cancel" | "agent.tasks_list" => {
            let args: TaskArgs = serde_json::from_value(request.arguments)?;
            if request.operation == "agent.tasks_list" {
                anyhow::ensure!(
                    args.task_id.is_none()
                        && args.timeout_ms.is_none()
                        && args.offset.is_none()
                        && !args.include_logs,
                    "tasks_list only accepts sessionId"
                );
                let mut registry = store().lock().unwrap();
                for task in registry.tasks.values_mut().filter(|t| !t.finished()) {
                    refresh(terminal, task)?;
                }
                let tasks = registry.tasks.values().filter(|t| args.session_id.as_ref().is_none_or(|id| id == &t.session_id))
                    .map(|t| json!({"taskId": t.id, "sessionId": t.session_id, "provider": t.provider, "status": t.status, "finished": t.finished(), "createdAt": t.created_at})).collect::<Vec<_>>();
                return Ok(json!({"tasks": tasks}));
            }
            anyhow::ensure!(args.session_id.is_none(), "use taskId for this operation");
            if request.operation == "agent.tasks_cancel" {
                anyhow::ensure!(
                    args.timeout_ms.is_none() && args.offset.is_none() && !args.include_logs,
                    "tasks_cancel only accepts taskId"
                );
                let mut registry = store().lock().unwrap();
                let id = required(&args.task_id, "taskId")?;
                let target = registry
                    .tasks
                    .get(id)
                    .context("task not found")?
                    .session_id
                    .clone();
                reject_cycle(
                    &registry,
                    request.caller_session_id.as_deref(),
                    Some(&target),
                )?;
                let task = registry.tasks.get_mut(id).unwrap();
                refresh(terminal, task)?;
                if !task.finished() && task.status != "cancelling" {
                    anyhow::ensure!(task.turn_id.is_some(), "task is not yet accepted; inspect session logs before cancelling or resubmitting");
                    let observation = observe(terminal, &session(terminal, &target)?)?
                        .context("native state unavailable")?;
                    anyhow::ensure!(
                        observation.transcript.turns.last().map(|t| &t.id) == task.turn_id.as_ref(),
                        "a different turn owns this session; refusing to interrupt it"
                    );
                    terminal.write_input(&target, "\u{3}")?;
                    task.status = "cancelling";
                }
                return Ok(task.view(0));
            }
            if request.operation == "agent.tasks_get" {
                anyhow::ensure!(
                    args.timeout_ms.is_none(),
                    "tasks_get does not accept timeoutMs"
                );
                return task_result(terminal, &args);
            }
            let timeout = args.timeout_ms.unwrap_or(10_000);
            anyhow::ensure!(timeout <= 30_000, "timeoutMs must be between 0 and 30000");
            {
                let registry = store().lock().unwrap();
                let target = &registry
                    .tasks
                    .get(required(&args.task_id, "taskId")?)
                    .context("task not found")?
                    .session_id;
                reject_cycle(
                    &registry,
                    request.caller_session_id.as_deref(),
                    Some(target),
                )?;
            }
            let deadline = Instant::now() + Duration::from_millis(timeout);
            loop {
                let mut view = task_result(terminal, &args)?;
                if view["finished"] == true || Instant::now() >= deadline {
                    view["waitTimedOut"] = json!(view["finished"] != true);
                    return Ok(view);
                }
                std::thread::sleep(
                    Duration::from_millis(250)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
        _ => bail!("unknown agent operation"),
    }
}

pub(crate) fn execute_bridge(
    app: &tauri::AppHandle,
    terminal: &SharedTerminalManager,
    raw: &str,
) -> Value {
    match serde_json::from_str(raw)
        .map_err(anyhow::Error::from)
        .and_then(|request| execute(app, terminal, request))
    {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => {
            json!({"ok": false, "error": {"code": "agent_request_failed", "message": error.to_string()}})
        }
    }
}

pub(crate) fn call(operation: &str, arguments: Value) -> Result<Value> {
    let request = AgentRequest {
        operation: format!("agent.{operation}"),
        arguments,
        caller_session_id: std::env::var("SUPERHIGH_SESSION_ID")
            .ok()
            .filter(|v| !v.is_empty()),
    };
    #[cfg(windows)]
    {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(
                Duration::from_secs(45),
                crate::local_control::send_request_async(&request),
            )
            .await
            .context("SuperHigh request timed out; query tasks_list before retrying a submission")?
        })
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        bail!("agent control requires the running Windows desktop app")
    }
}

fn now() -> i64 {
    crate::cli_completion::unix_millis(SystemTime::now())
}
fn chunk(text: &str, offset: usize, limit: usize) -> (&str, Option<usize>) {
    let mut start = offset.min(text.len());
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let mut end = start.saturating_add(limit).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[start..end], (end < text.len()).then_some(end))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn task() -> Task {
        Task {
            id: "task".into(),
            session_id: "session".into(),
            provider: "codex".into(),
            project: "project".into(),
            caller: None,
            original: SubmitArgs {
                session_id: Some("session".into()),
                project: None,
                provider: None,
                prompt: "work".into(),
                request_id: None,
            },
            marker: "prompt-unique.md".into(),
            status: "submitted",
            created_at: 100,
            turn_id: None,
            native_session_id: None,
            answer: String::new(),
            progress: Vec::new(),
            error: None,
        }
    }
    fn observation(prompt: &str, completed: bool) -> Observation {
        let mut turn = ChatTurn::default();
        turn.id = "turn".into();
        turn.prompt = prompt.into();
        turn.answer = "answer".into();
        turn.completed_at = completed.then_some(200);
        Observation {
            transcript: ChatTranscript {
                turns: vec![turn],
                ..Default::default()
            },
            completion: completed.then(|| ("turn".into(), 200)),
        }
    }
    #[test]
    fn old_answers_and_pty_silence_never_complete_new_tasks() {
        let mut task = task();
        apply_observation(&mut task, &observation("old prompt", true));
        assert_eq!(task.status, "submitted");
        assert!(task.answer.is_empty());
        let mut observed = observation("read prompt-unique.md", true);
        observed.completion = None;
        apply_observation(&mut task, &observed);
        assert_eq!(task.status, "running");
        apply_observation(&mut task, &observation("read prompt-unique.md", true));
        assert_eq!(task.status, "completed");
        assert_eq!(task.answer, "answer");
    }
    #[test]
    fn replacement_turn_is_not_mistaken_for_success_and_final_result_is_frozen() {
        let mut task = task();
        let mut observed = observation("read prompt-unique.md", false);
        let mut other = ChatTurn::default();
        other.id = "other".into();
        observed.transcript.turns.push(other);
        apply_observation(&mut task, &observed);
        assert_eq!(task.status, "superseded");
        apply_observation(&mut task, &observation("read prompt-unique.md", true));
        assert_eq!(task.status, "superseded");
    }
    #[test]
    fn rejects_self_ancestor_and_excessive_delegation() {
        let mut registry = Store::default();
        let mut parent = task();
        parent.caller = Some("ancestor".into());
        registry.tasks.insert(parent.id.clone(), parent);
        assert!(reject_cycle(&registry, Some("session"), Some("session")).is_err());
        assert!(reject_cycle(&registry, Some("session"), Some("ancestor")).is_err());
        assert!(reject_cycle(&registry, Some("session"), Some("unrelated")).is_ok());
    }
    #[test]
    fn output_pages_preserve_utf8_and_bound_response_size() {
        let text = "a中文b";
        assert_eq!(chunk(text, 0, 5), ("a中", Some(4)));
        assert_eq!(chunk(text, 4, 5), ("文b", None));
        assert_eq!(chunk(text, 2, 10), ("文b", None));
        assert_eq!(chunk(text, 100, 10), ("", None));
    }
}
