use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};

use anyhow::Context;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::claude_session::ClaudeSession;
use crate::codex_protocol_bridge::CodexBridge;
use crate::models::{
    CliProviderEnvironment, NativeCliTranscript, TerminalBufferSnapshot,
    TerminalExitEvent, TerminalOutputEvent, TerminalSessionDto, TerminalSizeMark,
};
use crate::process_tree::kill_pty_child_tree;

#[derive(Clone)]
pub(crate) enum TerminalEvents {
    Desktop(AppHandle),
    Host(Arc<Mutex<crate::agent_host::Notices>>),
}

impl TerminalEvents {
    fn notify(&self, notice: crate::cli_completion::CompletionNotice) {
        match self {
            Self::Desktop(app) => crate::cli_completion::notify(app, notice),
            Self::Host(notices) => notices.lock().unwrap().push(notice),
        }
    }
    fn output(&self, event: TerminalOutputEvent) {
        if let Self::Desktop(app) = self { let _ = app.emit("terminal-output", event); }
    }
    fn exit(&self, event: TerminalExitEvent) {
        if let Self::Desktop(app) = self { let _ = app.emit("terminal-exit", event); }
    }
}

enum AgentConnection {
    Codex(CodexBridge),
    Claude(ClaudeSession),
}

impl AgentConnection {
    fn shutdown(&self) {
        match self {
            Self::Codex(bridge) => bridge.shutdown(),
            Self::Claude(hooks) => hooks.shutdown(),
        }
    }
}

impl TerminalManager {
    pub(crate) fn claude_status(&self, session_id: &str) -> Option<serde_json::Value> {
        let captures = self.agent_connections.lock().unwrap();
        match captures.get(session_id)?.as_ref() { AgentConnection::Claude(session) => session.status(), _ => None }
    }

    pub(crate) fn codex_agent_view(&self, session_id: &str) -> Option<Arc<crate::codex_agents::CodexAgents>> {
        let captures = self.agent_connections.lock().unwrap();
        match captures.get(session_id)?.as_ref() {
            AgentConnection::Codex(bridge) => Some(bridge.agents.clone()),
            _ => None,
        }
    }
}

struct TerminalSession {
    #[allow(dead_code)]
    workspace_id: Option<String>,
    provider_kind: String,
    title: String,
    cwd: PathBuf,
    started_at: SystemTime,
    native_session_id: Option<String>,
    master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    writer: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    child: Option<Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>>,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    update_installing: Mutex<bool>,
    data_dir: Option<PathBuf>,
    agent_connections: Arc<Mutex<HashMap<String, Arc<AgentConnection>>>>,
    independent_consoles: Arc<Mutex<HashMap<String, crate::service_console::IndependentConsole>>>,
    agent_hosts: Arc<Mutex<HashMap<String, Arc<crate::agent_host::Client>>>>,
    detached_agent_hosts: Mutex<std::collections::HashSet<String>>,
    unsupported_controls_hosts: Mutex<std::collections::HashSet<String>>,
    workspace_roots: Mutex<HashMap<String, PathBuf>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateBlockingSession {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInspection {
    pub id: String,
    pub workspace_id: Option<String>,
    pub provider_kind: String,
    pub title: String,
    pub cwd: String,
    pub holds_pty_child: bool,
    pub running: bool,
    pub process_id: Option<u32>,
}

struct CliProviderDefinition {
    kind: &'static str,
    name: &'static str,
    command: &'static str,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct CliLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub title: String,
    pub path_env: Option<String>,
    pub superhigh_cli_path: Option<String>,
}

struct TerminalOutputBuffer {
    chunks: VecDeque<String>,
    len_bytes: usize,
    start_byte: u64,
    end_byte: u64,
    cols: u16,
    rows: u16,
    modes: TerminalModeState,
    /// 保留历史内的尺寸变化；首项是 `start_byte` 处生效的尺寸。
    size_marks: VecDeque<TerminalSizeMark>,
}

impl Default for TerminalOutputBuffer {
    fn default() -> Self {
        Self {
            chunks: VecDeque::new(),
            len_bytes: 0,
            start_byte: 0,
            end_byte: 0,
            cols: 120,
            rows: 32,
            modes: TerminalModeState::default(),
            size_marks: VecDeque::from([TerminalSizeMark { at_byte: 0, cols: 120, rows: 32 }]),
        }
    }
}

const TERMINAL_SIZE_MARK_LIMIT: usize = 512;

/// 输入相关的 DEC 私有模式只在 CLI 启动时设置一次；历史截断后需单独记住，
/// 否则回放（含 RIS）会关掉鼠标上报，Codex 的滚轮、点击和括号粘贴随之失效。
/// 不含备用屏与同步输出：它们改变画面状态，由历史本身负责。
const TRACKED_TERMINAL_MODES: [u16; 11] = [1, 66, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 2004];

#[derive(Default)]
struct TerminalModeState {
    enabled: std::collections::BTreeSet<u16>,
    carry: String,
}

impl TerminalModeState {
    fn observe(&mut self, chunk: &str) {
        let text = std::mem::take(&mut self.carry) + chunk;
        for (index, _) in text.match_indices('\x1b') {
            let tail = &text[index + 1..];
            let Some(body) = tail.strip_prefix("[?") else {
                if "[?".starts_with(tail) { self.carry = text[index..].to_string(); }
                continue;
            };
            let params_len = body.find(|c: char| !c.is_ascii_digit() && c != ';').unwrap_or(body.len());
            let enable = match body[params_len..].chars().next() {
                Some('h') => true,
                Some('l') => false,
                Some(_) => continue,
                None => {
                    // 序列被切在两次输出之间，留到下一段拼接。
                    if params_len < 64 { self.carry = text[index..].to_string(); }
                    continue;
                }
            };
            for mode in body[..params_len].split(';').filter_map(|value| value.parse::<u16>().ok()) {
                if !TRACKED_TERMINAL_MODES.contains(&mode) { continue }
                if enable { self.enabled.insert(mode); } else { self.enabled.remove(&mode); }
            }
        }
    }

    fn replay(&self) -> String {
        self.enabled.iter().map(|mode| format!("\x1b[?{mode}h")).collect()
    }
}

struct PendingTerminalOutput {
    chunk: String,
    start_byte: u64,
    end_byte: u64,
}

const TERMINAL_OUTPUT_HISTORY_LIMIT_BYTES: usize = 256 * 1024;
const TERMINAL_OUTPUT_EMIT_INTERVAL_MS: u64 = 16;
// Full-screen TUIs repaint large synchronized frames; keep a
// frame together when possible so the WebView does not render intermediate rows.
// 帧以 DEC 2026 同步输出标记（BSU/ESU）界定；切包只允许发生在已闭合帧边界。
const TERMINAL_OUTPUT_EMIT_LIMIT_BYTES: usize = 256 * 1024;
// 同步帧若迟迟不能闭合（异常输出），在此阈值强制切包，避免输出停滞。
const TERMINAL_OUTPUT_SYNC_FRAME_FORCE_LIMIT_BYTES: usize = 1024 * 1024;
const TERMINAL_OUTPUT_CHANNEL_CAPACITY: usize = 64;
// 退出处理会在 terminal-exit 之后立即读取最终缓冲。
const TERMINAL_EXIT_SESSION_REMOVAL_GRACE_MS: u64 = 5_000;
const AI_INITIAL_PROMPT_READY_DELAY_MS: u64 = 800;
const AI_INITIAL_PROMPT_SUBMIT_DELAY_MS: u64 = 150;
const CODEX_EXTERNAL_HANDOFF_SUBMIT_DELAY_MS: u64 = 100;
const CODEX_EXTERNAL_HANDOFF_EXIT_TIMEOUT_MS: u64 = 10_000;
const CLI_PROVIDERS: [CliProviderDefinition; 7] = [
    CliProviderDefinition {
        kind: "claude",
        name: "Claude Code",
        command: "claude",
    },
    CliProviderDefinition {
        kind: "codex",
        name: "Codex",
        command: "codex",
    },
    CliProviderDefinition {
        kind: "kimi",
        name: "Kimi Code",
        command: "kimi",
    },
    CliProviderDefinition {
        kind: "grok",
        name: "Grok Build",
        command: "grok",
    },
    CliProviderDefinition {
        kind: "gemini",
        name: "Gemini",
        command: "gemini",
    },
    CliProviderDefinition {
        kind: "opencode",
        name: "OpenCode",
        command: "opencode",
    },
    CliProviderDefinition {
        kind: "codebuddy",
        name: "CodeBuddy Code",
        command: "codebuddy",
    },
];

impl TerminalManager {
    pub fn register_workspace(&self, id: &str, root: &Path) {
        self.workspace_roots.lock().unwrap().insert(id.to_string(), root.to_path_buf());
    }

    fn agent_host(&self, id: &str) -> Option<Arc<crate::agent_host::Client>> {
        self.agent_hosts.lock().unwrap().get(id).cloned()
    }

    pub fn restore_agent_sessions(&self, app: &AppHandle, workspace_id: Option<String>, project: Option<&Path>) -> anyhow::Result<Vec<TerminalSessionDto>> {
        let Some(data_dir) = &self.data_dir else { return Ok(Vec::new()) };
        let mut restored = Vec::new();
        for client in crate::agent_host::existing(data_dir) {
            if project.is_some_and(|root| !terminal_cwd_matches(&client.record.project, root)) { continue; }
            if self.detached_agent_hosts.lock().unwrap().contains(&client.record.session.id) { continue; }
            restored.push(self.attach_agent_host(app, workspace_id.clone(), client)?);
        }
        Ok(restored)
    }

    fn attach_agent_host(&self, app: &AppHandle, workspace_id: Option<String>, client: crate::agent_host::Client) -> anyhow::Result<TerminalSessionDto> {
        if let Err(error) = crate::agent_console::attach(self.data_dir.as_deref().context("缺少 Agent 会话数据目录")?, &client) {
            let message = format!("Agent 外部终端启动失败：{error:#}");
            eprintln!("[Super High] {message}");
            let _ = app.emit("agent-console-error", message);
        }
        let dto = client.record.session.clone();
        let id = dto.id.clone();
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&id) {
            if workspace_id.is_some() { session.workspace_id = workspace_id; }
            return Ok(dto);
        }
        sessions.insert(id.clone(), TerminalSession { workspace_id, provider_kind: dto.provider_kind.clone(),
            title: dto.title.clone(), cwd: PathBuf::from(&dto.cwd), started_at: client.record.started_at,
            native_session_id: None, master: None, writer: None, child: None,
            output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())) });
        let client = Arc::new(client);
        self.agent_hosts.lock().unwrap().insert(id.clone(), client.clone());
        drop(sessions);
        let sessions = self.sessions.clone();
        let hosts = self.agent_hosts.clone();
        let app = app.clone();
        let console_directory = self.data_dir.as_ref().unwrap().join("agent-hosts").join(&id);
        let console_hosts = hosts.clone();
        let console_id = id.clone();
        let console_client = client.clone();
        let host_process = client.record.process;
        thread::spawn(move || {
            // Host polling may block on transcript I/O. Window ownership must
            // remain enforced independently, including for older console helpers.
            loop {
                {
                    // Serialize ownership writes with detaching the view.
                    let hosts = console_hosts.lock().unwrap();
                    if !hosts.get(&console_id).is_some_and(|host| Arc::ptr_eq(host, &console_client)) || !crate::service_console::process_matches(host_process) { break; }
                    let _ = crate::agent_console::maintain_attachment(&console_directory);
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        thread::spawn(move || {
            let mut after = None;
            let mut notice = None;
            let mut connection = None;
            loop {
                if !hosts.lock().unwrap().get(&id).is_some_and(|host| Arc::ptr_eq(host, &client)) { return; }
                let result = (|| -> anyhow::Result<crate::agent_host::Poll> {
                    if connection.is_none() { connection = Some(client.connect()?); }
                    connection.as_mut().unwrap().request("poll", serde_json::json!({"after":after,"notice":notice}))
                })();
                let poll = match result {
                    Ok(poll) => poll,
                    Err(_) if crate::service_console::process_matches(client.record.process) => {
                        connection = None;
                        thread::sleep(Duration::from_millis(200)); continue;
                    }
                    Err(_) => break,
                };
                if !hosts.lock().unwrap().get(&id).is_some_and(|host| Arc::ptr_eq(host, &client)) { return; }
                if let Some(session) = sessions.lock().unwrap().get_mut(&id) { session.native_session_id = poll.native_session_id; }
                for (registry, source) in [(CLAIMS.get_or_init(Default::default), poll.source), (CHAT_CLAIMS.get_or_init(Default::default), poll.chat_source)] {
                    let mut claims = registry.lock().unwrap();
                    if let Some(source) = source { claims.insert(id.clone(), source); } else { claims.remove(&id); }
                }
                let snapshot = poll.snapshot;
                if !snapshot.buffer.is_empty() {
                    let _ = app.emit("terminal-output", TerminalOutputEvent { session_id: id.clone(),
                        chunk: snapshot.buffer, start_byte: snapshot.start_byte, end_byte: snapshot.end_byte });
                }
                after = Some(snapshot.end_byte);
                notice = Some(poll.notice_cursor);
                for (_, item) in poll.notices { crate::cli_completion::notify(&app, item); }
                if !poll.inspection.running { break; }
                thread::sleep(Duration::from_millis(32));
            }
            if hosts.lock().unwrap().get(&id).is_some_and(|host| Arc::ptr_eq(host, &client)) {
                let _ = app.emit("terminal-exit", TerminalExitEvent { session_id: id.clone(), exit_code: None });
            }
        });
        Ok(dto)
    }

    pub(crate) fn chat_controls(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        if let Some(host) = self.agent_host(id) {
            if self.unsupported_controls_hosts.lock().unwrap().contains(id) { return self.old_host_chat_controls(id); }
            return match host.request("chat_controls", serde_json::Value::Null) {
                Ok(value) => Ok(value),
                Err(error) if error.to_string().contains("未知 Agent 宿主操作") => {
                    self.unsupported_controls_hosts.lock().unwrap().insert(id.into());
                    self.old_host_chat_controls(id)
                }
                Err(error) => Err(error),
            };
        }
        crate::local_chat_controls(self, id)
    }

    fn old_host_chat_controls(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        let mut value = crate::local_chat_controls(self, id)?;
        value["unavailableReason"] = serde_json::json!("宿主版本不支持模型目录");
        Ok(value)
    }

    pub(crate) fn agent_view_data(&self, id: &str, root: Option<&str>, calls: &HashMap<String, serde_json::Value>, links: &[serde_json::Value]) -> anyhow::Result<crate::agent_host::AgentView> {
        if let Some(host) = self.agent_host(id) {
            return host.request("agents", serde_json::json!({"root":root,"calls":calls,"links":links}));
        }
        let Some(agents) = self.codex_agent_view(id) else { return Ok(Default::default()) };
        let model = agents.model(root);
        let (agents, error) = if let Some(root) = root {
            agents.restore_links(root, links);
            agents.read(root, calls)
        } else { (Vec::new(), None) };
        Ok(crate::agent_host::AgentView { model, agents, error })
    }

    pub fn with_data_dir(data_dir: PathBuf) -> Self {
        Self {
            data_dir: Some(data_dir),
            ..Self::default()
        }
    }

    pub fn create_independent_session(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        project: &Path,
        provider_kind: &str,
        title: &str,
        path: &Path,
        args: &[String],
        cwd: &Path,
    ) -> anyhow::Result<TerminalSessionDto> {
        let _guard = self.lock_session_creation()?;
        let data_dir = self.data_dir.as_deref().context("缺少独立控制台数据目录")?;
        if let Some((spec, console)) = crate::service_console::existing(data_dir, project)
            .into_iter().find(|(spec, _)| spec.session.provider_kind == provider_kind && spec.session.title == title && terminal_cwd_matches(&spec.cwd, cwd))
        {
            return self.attach_console(app, workspace_id, spec, console);
        }
        let (program, args) = launch_command_for_path(&path.to_string_lossy(), args);
        let spec = crate::service_console::ConsoleSpec {
            project_path: project.to_path_buf(),
            session: TerminalSessionDto { id: Uuid::new_v4().to_string(), title: title.into(),
                provider_kind: provider_kind.into(), cwd: cwd.to_string_lossy().replace('\\', "/"), read_only: true },
            program, args, cwd: cwd.to_path_buf(), owner: crate::service_console::current_identity()?,
        };
        let console = crate::service_console::start(data_dir, &spec)?;
        self.attach_console(app, workspace_id, spec, console)
    }

    pub fn restore_independent_sessions(&self, app: &AppHandle, workspace_id: Option<String>, project: &Path) -> anyhow::Result<Vec<TerminalSessionDto>> {
        let Some(data_dir) = &self.data_dir else { return Ok(Vec::new()) };
        crate::service_console::existing(data_dir, project).into_iter()
            .map(|(spec, console)| self.attach_console(app, workspace_id.clone(), spec, console)).collect()
    }

    fn attach_console(&self, app: &AppHandle, workspace_id: Option<String>, spec: crate::service_console::ConsoleSpec,
        console: crate::service_console::IndependentConsole) -> anyhow::Result<TerminalSessionDto> {
        console.request("claim", None)?;
        let id = spec.session.id.clone();
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&id) {
            session.workspace_id = workspace_id;
            return Ok(spec.session);
        }
        let output = Arc::new(Mutex::new(TerminalOutputBuffer::default()));
        self.independent_consoles.lock().unwrap().insert(id.clone(), console.clone());
        sessions.insert(id.clone(), TerminalSession {
            workspace_id, provider_kind: spec.session.provider_kind.clone(), title: spec.session.title.clone(),
            cwd: spec.cwd, started_at: SystemTime::now(), native_session_id: None,
            master: None, writer: None, child: None, output_buffer: output.clone(),
        });
        drop(sessions);
        let app = app.clone();
        let sessions = self.sessions.clone();
        let consoles = self.independent_consoles.clone();
        thread::spawn(move || {
            use std::io::{Seek, SeekFrom};
            let path = console.directory.join("output.log");
            let mut position = fs::metadata(&path).map(|meta| meta.len().saturating_sub(TERMINAL_OUTPUT_HISTORY_LIMIT_BYTES as u64)).unwrap_or(0);
            let mut pending = Vec::new();
            let mut first = true;
            let mut exit_seen = false;
            loop {
                if !consoles.lock().unwrap().contains_key(&id) { return; }
                if let Ok(mut file) = fs::File::open(&path) {
                    if file.metadata().is_ok_and(|meta| meta.len() < position) { position = 0; pending.clear(); }
                    if file.seek(SeekFrom::Start(position)).is_ok() {
                        let mut bytes = Vec::new();
                        if file.take(256 * 1024).read_to_end(&mut bytes).is_ok() {
                            position += bytes.len() as u64;
                            if first && position > bytes.len() as u64 {
                                let start = bytes.iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |index| index + 1);
                                bytes.drain(..start);
                            }
                            first = false;
                            let text = decode_service_log_chunk(&mut pending, &bytes, bytes.is_empty() || exit_seen);
                            let text = text.replace("\r\n", "\n").replace('\n', "\r\n");
                            let (start, end) = { let mut buffer = output.lock().unwrap(); let start = buffer.end_byte; buffer.append(&text); (start, buffer.end_byte) };
                            emit_terminal_output_batch(&TerminalEvents::Desktop(app.clone()), &id, text, start, end);
                        }
                    }
                }
                if !console.running() {
                    if !exit_seen { exit_seen = true; continue; }
                    consoles.lock().unwrap().remove(&id);
                    finish_terminal_exit_session(&sessions, &id, Duration::from_secs(2), || {
                        let _ = app.emit("terminal-exit", TerminalExitEvent { session_id: id.clone(), exit_code: None });
                    });
                    return;
                }
                thread::sleep(Duration::from_millis(200));
            }
        });
        Ok(spec.session)
    }

    pub fn stop_independent_session(&self, session_id: &str) -> anyhow::Result<bool> {
        let console = self.independent_consoles.lock().unwrap().get(session_id).cloned();
        let Some(console) = console else { return Ok(false) };
        console.request("terminate", None)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while console.running() && Instant::now() < deadline { thread::sleep(Duration::from_millis(100)); }
        anyhow::ensure!(!console.running(), "独立控制台尚未退出");
        self.close_session(session_id)?;
        Ok(true)
    }

    fn finish_agent_connection(&self, session_id: &str) {
        finish_agent_connection(&self.agent_connections, session_id);
    }

    /// Only registered sessions and their owned PTY children are inspected.
    pub fn inspect_sessions(
        &self,
        project: Option<&Path>,
    ) -> anyhow::Result<Vec<TerminalInspection>> {
        // Network queries must never hold the desktop's session table lock.
        let entries = {
            let sessions = self.sessions.lock().map_err(|_| anyhow::anyhow!("终端会话状态不可用"))?;
            sessions.iter().filter(|(_, session)| !project.is_some_and(|root| !terminal_cwd_matches(&session.cwd, root)))
                .map(|(id, session)| (TerminalInspection { id: id.clone(), workspace_id: session.workspace_id.clone(),
                    provider_kind: session.provider_kind.clone(), title: session.title.clone(), cwd: session.cwd.to_string_lossy().into_owned(),
                    holds_pty_child: session.child.is_some(), running: false, process_id: None }, session.child.clone()))
                .collect::<Vec<_>>()
        };
        let mut result = Vec::new();
        for (mut entry, child) in entries {
            let (running, process_id) = if let Some(child) = child {
                let mut child = child.lock().map_err(|_| anyhow::anyhow!("终端进程状态不可用"))?;
                (child.try_wait().context("无法确认终端是否已退出")?.is_none(), child.process_id())
            } else if let Some(host) = self.agent_host(&entry.id) {
                if crate::service_console::process_matches(host.record.process) {
                    let status: Option<TerminalInspection> = host.request("status", serde_json::Value::Null)?;
                    status.map(|status| (status.running, status.process_id)).unwrap_or((false, None))
                } else { (false, None) }
            } else if let Some(console) = self.independent_consoles.lock().unwrap().get(&entry.id).cloned() {
                console.request("status", None).map(|status| (status.running, Some(status.process_id))).unwrap_or((false, None))
            } else { (false, None) };
            entry.running = running;
            entry.process_id = process_id;
            result.push(entry);
        }
        result.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(result)
    }

    pub fn update_blocking_sessions(&self) -> anyhow::Result<Vec<UpdateBlockingSession>> {
        let sessions = self.sessions.lock().map_err(|_| anyhow::anyhow!("终端会话状态不可用"))?;
        let mut blocking = Vec::new();
        for (id, session) in sessions.iter() {
            if let Some(child) = &session.child {
                let mut child = child
                    .lock()
                    .map_err(|_| anyhow::anyhow!("终端进程状态不可用"))?;
                if child
                    .try_wait()
                    .context("无法确认终端是否已退出")?
                    .is_none()
                {
                    blocking.push(UpdateBlockingSession {
                        id: id.clone(),
                        title: session.title.clone(),
                    });
                }
            }
        }
        blocking.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(blocking)
    }

    pub fn install_update_when_idle(
        &self,
        install: impl FnOnce() -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        // The same gate covers PTY creation through registration, closing the check/install race.
        let mut installing = self.update_installing.lock().map_err(|_| anyhow::anyhow!("更新安装状态不可用"))?;
        anyhow::ensure!(!*installing, "正在安装更新");
        let blocking = self.update_blocking_sessions()?;
        anyhow::ensure!(blocking.is_empty(), "请先结束内部终端会话：{}", blocking.iter().map(|s| s.title.as_str()).collect::<Vec<_>>().join("、"));
        *installing = true;
        let result = install();
        if result.is_err() { *installing = false; }
        result
    }

    fn lock_session_creation(&self) -> anyhow::Result<std::sync::MutexGuard<'_, bool>> {
        let guard = self.update_installing.lock().map_err(|_| anyhow::anyhow!("更新安装状态不可用"))?;
        anyhow::ensure!(!*guard, "正在安装更新，请稍后启动终端");
        Ok(guard)
    }
    #[allow(dead_code)]
    pub fn create_session(
        &self,
        app: &AppHandle,
        provider_kind: &str,
        cwd: &Path,
        env: HashMap<String, String>,
    ) -> anyhow::Result<TerminalSessionDto> {
        self.create_session_for_workspace(app, None, provider_kind, cwd, env, None)
    }

    pub fn create_session_for_workspace(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        cwd: &Path,
        env: HashMap<String, String>,
        initial_prompt: Option<String>,
    ) -> anyhow::Result<TerminalSessionDto> {
        let launch = resolve_launch(provider_kind)?;
        let initial_input = initial_prompt
            .as_deref()
            .filter(|prompt| !prompt.trim().is_empty())
            .map(|prompt| initial_prompt_input(provider_kind, cwd, prompt))
            .transpose()?;

        self.create_session_from_launch(
            app,
            workspace_id,
            provider_kind,
            cwd,
            env,
            initial_input,
            None,
            launch,
        )
    }

    pub fn resume_session_for_workspace(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        cwd: &Path,
        native_session_id: &str,
    ) -> anyhow::Result<TerminalSessionDto> {
        // Reopening a detached conversation reconnects its original CLI.
        if let Some(data_dir) = &self.data_dir {
            for client in crate::agent_host::existing(data_dir) {
                if client.record.session.provider_kind != provider_kind || !terminal_cwd_matches(Path::new(&client.record.session.cwd), cwd) { continue; }
                let poll = client.request::<crate::agent_host::Poll>("poll", serde_json::json!({"after":u64::MAX,"notice":0}));
                if poll.is_ok_and(|poll| poll.inspection.running && poll.native_session_id.as_deref() == Some(native_session_id)) {
                    let dto = self.attach_agent_host(app, workspace_id, client)?;
                    self.detached_agent_hosts.lock().unwrap().remove(&dto.id);
                    return Ok(dto);
                }
            }
        }
        let mut launch = resolve_launch(provider_kind)?;
        let resume_args = resume_args_for_provider(provider_kind, native_session_id)
            .with_context(|| format!("{} 不支持恢复原生会话", provider_kind))?;
        launch.args.extend(resume_args);
        self.create_session_from_launch(
            app,
            workspace_id,
            provider_kind,
            cwd,
            HashMap::new(),
            None,
            Some(native_session_id.to_string()),
            launch,
        )
    }

    /// Runs a plain program (no CLI provider hooks) in a registered PTY session.
    pub fn create_program_session(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        title: &str,
        program: &Path,
        args: &[String],
        cwd: &Path,
    ) -> anyhow::Result<TerminalSessionDto> {
        let dirs = detection_dirs();
        let (program, args) = launch_command_for_path(&program.to_string_lossy(), args);
        let launch = CliLaunch {
            program,
            args,
            title: title.to_string(),
            path_env: joined_path_env(&dirs),
            superhigh_cli_path: None,
        };
        self.create_session_from_launch(app, workspace_id, provider_kind, cwd, HashMap::new(), None, None, launch)
    }

    fn create_session_from_launch(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        cwd: &Path,
        env: HashMap<String, String>,
        initial_input: Option<String>,
        native_session_id: Option<String>,
        launch: CliLaunch,
    ) -> anyhow::Result<TerminalSessionDto> {
        if CLI_PROVIDERS.iter().any(|provider| provider.kind == provider_kind) {
            let _guard = self.lock_session_creation()?;
            let data_dir = self.data_dir.clone().context("缺少 Agent 会话宿主数据目录")?;
            let project = workspace_id.as_ref().and_then(|id| self.workspace_roots.lock().unwrap().get(id).cloned()).unwrap_or_else(|| cwd.to_path_buf());
            let session = TerminalSessionDto { id: Uuid::new_v4().to_string(), title: launch.title.clone(),
                provider_kind: provider_kind.to_string(), cwd: cwd.to_string_lossy().replace('\\', "/"), read_only: false };
            let client = crate::agent_host::start(crate::agent_host::Launch { session,
                workspace_id: workspace_id.clone(), project, cwd: cwd.to_path_buf(), env,
                initial_input, native_session_id, launch, data_dir })?;
            return self.attach_agent_host(app, workspace_id, client);
        }
        self.create_owned_session(&TerminalEvents::Desktop(app.clone()), workspace_id, provider_kind,
            cwd, env, initial_input, native_session_id, None, launch)
    }

    pub(crate) fn create_owned_session(
        &self, app: &TerminalEvents, workspace_id: Option<String>, provider_kind: &str,
        cwd: &Path, env: HashMap<String, String>, initial_input: Option<String>,
        native_session_id: Option<String>, session_id: Option<String>, launch: CliLaunch,
    ) -> anyhow::Result<TerminalSessionDto> {
        let _update_guard = self.lock_session_creation()?;
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let session_id = session_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let started_at = SystemTime::now();
        let mut builder = CommandBuilder::new(launch.program.as_str());
        builder.cwd(cwd);
        for arg in &launch.args {
            builder.arg(arg);
        }
        if provider_kind == "codebuddy" {
            builder.args(["--settings", r#"{"showTurnDuration":true}"#]);
        }
        if let Some(path_env) = &launch.path_env {
            builder.env("PATH", path_env);
            builder.env("Path", path_env);
        }
        if let Some(superhigh_cli_path) = &launch.superhigh_cli_path {
            builder.env("SUPERHIGH_CLI", superhigh_cli_path);
        }
        clear_inherited_agent_environment(&mut builder);
        for (key, value) in &env {
            builder.env(key, value);
        }
        builder.env("SUPERHIGH_SESSION_ID", &session_id);
        configure_terminal_color_environment(&mut builder, provider_kind);
        let identity = Arc::new(NativeSessionBinding { session_id: session_id.clone(), sessions: Arc::clone(&self.sessions), pending: Mutex::new(None) });
        let binding = identity.clone();
        let observer: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |native| binding.update(native));
        let question_seen = Arc::new(Mutex::new(std::collections::HashSet::<(String, String)>::new()));
        let agent_connection = if provider_kind == "codex" {
            configure_embedded_codex(&mut builder);
            // The server receives the same effective environment as the original PTY.
            let effective_env = builder
                .iter_full_env_as_str()
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .collect::<HashMap<_, _>>();
            let server_args = codex_server_args(&launch);
            let bridge = CodexBridge::start(
                &launch.program,
                &server_args,
                cwd,
                &effective_env,
                {
                    let identity = crate::codex_session::observer(Arc::clone(&observer));
                    let app = app.clone();
                    let id = session_id.clone();
                    let workspace = cwd.to_string_lossy().into_owned();
                    let title = launch.title.clone();
                    let sessions = Arc::clone(&self.sessions);
                    let question_seen = Arc::clone(&question_seen);
                    Arc::new(move |envelope: serde_json::Value| {
                        identity(envelope.clone());
                        if envelope["direction"] == "server" {
                            if let Some(plan) = crate::codex_plan::request(envelope["connection"].as_u64().unwrap_or_default(), &envelope["message"]) {
                                app.notify(crate::cli_completion::CompletionNotice {
                                    title: title.clone(), provider: "codex".into(), workspace: workspace.clone(),
                                    conversation_id: plan.thread_id.clone(), session_id: id.clone(), plan_request: Some(plan),
                                    ..Default::default()
                                });
                            }
                            if let Some((thread, item, answer)) = crate::cli_completion::codex_async_question(&envelope["message"]) {
                                let belongs = sessions.lock().unwrap().get(&id).is_some_and(|session| session.child.is_some() && session.native_session_id.as_deref() == Some(thread.as_str()));
                                if belongs && crate::cli_completion::claim_async_question(&question_seen, &thread, &item) {
                                    app.notify(crate::cli_completion::CompletionNotice {
                                        title: title.clone(), provider: "codex".into(), workspace: workspace.clone(),
                                        conversation_id: thread, session_id: id.clone(), answer, async_question: true,
                                        ..Default::default()
                                    });
                                }
                            }
                        }
                    })
                },
            )
            .context("无法启动 Codex 原生会话连接")?;
            let args = codex_remote_args(&launch, bridge.endpoint(), native_session_id.as_deref());
            builder.get_argv_mut().truncate(1);
            builder.args(args);
            Some(Arc::new(AgentConnection::Codex(bridge)))
        } else if provider_kind == "claude" {
            let data_dir = self
                .data_dir
                .as_deref()
                .context("Claude 会话连接需要应用数据目录")?;
            let helper = launch
                .superhigh_cli_path
                .as_deref()
                .context("未找到 SuperHigh CLI 会话辅助程序")?;
            let hooks = crate::claude_session::prepare(
                &session_id,
                data_dir,
                Path::new(helper),
                &cwd,
                &env,
                Arc::clone(&observer),
                {
                    let app = app.clone();
                    let id = session_id.clone();
                    let workspace = cwd.to_string_lossy().into_owned();
                    let title = launch.title.clone();
                    Arc::new(move |plan: crate::codex_plan::PlanRequest| {
                        app.notify(crate::cli_completion::CompletionNotice {
                            title: title.clone(), provider: "claude".into(), workspace: workspace.clone(),
                            conversation_id: plan.thread_id.clone(), session_id: id.clone(), plan_request: Some(plan),
                            ..Default::default()
                        });
                    })
                },
            )
            .context("无法准备 Claude 会话连接")?;
            builder.arg("--settings");
            builder.arg(hooks.settings_path());
            Some(Arc::new(AgentConnection::Claude(hooks)))
        } else {
            None
        };
        if provider_kind == "gemini" {
            if let Err(error) = crate::cli_completion_adapters::prepare_gemini_completion(&mut builder, &session_id) {
                crate::cli_completion_adapters::cleanup_gemini_completion(&session_id);
                return Err(error.context("无法准备 Gemini 对话完成提醒"));
            }
        }
        if provider_kind == "kimi" {
            if let Err(error) = crate::cli_completion_adapters::prepare_kimi_completion(&mut builder, &session_id) {
                crate::cli_completion_adapters::cleanup_kimi_completion(&session_id);
                crate::cli_completion_adapters::cleanup_gemini_completion(&session_id);
                return Err(error.context("无法准备 Kimi 对话完成提醒"));
            }
        }

        let child = match pair.slave.spawn_command(builder) {
            Ok(child) => Arc::new(Mutex::new(child)),
            Err(error) => {
                crate::cli_completion_adapters::cleanup_kimi_completion(&session_id);
                crate::cli_completion_adapters::cleanup_gemini_completion(&session_id);
                return Err(error).with_context(|| format!("failed to spawn terminal {}", launch.program));
            }
        };
        let master = Arc::new(Mutex::new(pair.master));
        let reader = master.lock().unwrap().try_clone_reader()?;
        let writer = Arc::new(Mutex::new(master.lock().unwrap().take_writer()?));
        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::default()));
        if let Some(capture) = agent_connection {
            self.agent_connections
                .lock()
                .unwrap()
                .insert(session_id.clone(), capture);
        }

        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            TerminalSession {
                workspace_id,
                provider_kind: provider_kind.to_string(),
                title: launch.title.clone(),
                cwd: cwd.to_path_buf(),
                started_at,
                native_session_id,
                master: Some(master),
                writer: Some(writer),
                child: Some(Arc::clone(&child)),
                output_buffer: Arc::clone(&output_buffer),
            },
        );
        identity.bind_pending();
        spawn_terminal_background_tasks(
            app,
            Arc::clone(&self.sessions),
            session_id.clone(),
            child,
            reader,
            output_buffer,
            Arc::clone(&self.agent_connections),
        );
        if CLI_PROVIDERS.iter().any(|provider| provider.kind == provider_kind) {
            spawn_cli_completion_watcher(app.clone(), Arc::clone(&self.sessions), session_id.clone(), question_seen);
        }

        if let Some(input) = initial_input {
            if provider_kind == "local" {
                if let Err(error) = self.write_input(&session_id, &input) {
                    let _ = self.close_session(&session_id);
                    return Err(error);
                }
            } else if let Some(writer) = self
                .sessions
                .lock()
                .unwrap()
                .get(&session_id)
                .and_then(|session| session.writer.as_ref().map(Arc::clone))
            {
                write_ai_initial_prompt_async(writer, input);
            } else {
                let _ = self.close_session(&session_id);
                anyhow::bail!("terminal writer not found");
            }
        }

        Ok(TerminalSessionDto {
            id: session_id,
            title: launch.title,
            provider_kind: provider_kind.to_string(),
            cwd: cwd.to_string_lossy().replace('\\', "/"),
            read_only: false,
        })
    }

    pub fn pending_plan(&self, session_id: &str, connection: u64, request_id: &serde_json::Value) -> Option<crate::codex_plan::PlanRequest> {
        if let Some(host) = self.agent_host(session_id) {
            return host.request("pending_plan", serde_json::json!({"connection":connection,"requestId":request_id})).ok().flatten();
        }
        let captures = self.agent_connections.lock().unwrap();
        match captures.get(session_id)?.as_ref() {
            AgentConnection::Codex(bridge) => bridge.plans.pending(connection, request_id),
            AgentConnection::Claude(hooks) => hooks.pending_plan(request_id),
        }
    }

    pub fn reply_plan(&self, session_id: &str, connection: u64, request_id: serde_json::Value, answers: HashMap<String, Vec<String>>) -> anyhow::Result<()> {
        if let Some(host) = self.agent_host(session_id) {
            let _: serde_json::Value = host.request("reply_plan", serde_json::json!({"connection":connection,"requestId":request_id,"answers":answers}))?;
            return Ok(());
        }
        let capture = Arc::clone(self.agent_connections.lock().unwrap().get(session_id).context("CLI 会话已关闭")?);
        match capture.as_ref() {
            AgentConnection::Codex(bridge) => bridge.plans.reply(connection, request_id, answers),
            AgentConnection::Claude(hooks) => hooks.reply_plan(&request_id, answers),
        }
    }

    pub fn write_input(&self, session_id: &str, input: &str) -> anyhow::Result<()> {
        if let Some(host) = self.agent_host(session_id) {
            let _: serde_json::Value = host.request("input", serde_json::json!({"input":input}))?;
            return Ok(());
        }
        if let Some(console) = self.independent_consoles.lock().unwrap().get(session_id).cloned() {
            console.request("input", Some(input))?;
            return Ok(());
        }
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .context("terminal session not found")?;
        let writer = session
            .writer
            .as_ref()
            .context("terminal writer not found")?;
        write_terminal_input_to_writer(writer, input)
    }

    pub fn resize_session(&self, session_id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.resize_session_with(session_id, cols, rows, false)
    }

    /// `force` re-sends an unchanged size so ConPTY and the TUI repaint the visible screen;
    /// used when the replayed history was truncated and cannot rebuild it.
    pub fn resize_session_with(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        force: bool,
    ) -> anyhow::Result<()> {
        if let Some(host) = self.agent_host(session_id) {
            let _: serde_json::Value = host.request("resize", serde_json::json!({"cols":cols,"rows":rows,"force":force}))?;
            return Ok(());
        }
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .context("terminal session not found")?;
        if self.independent_consoles.lock().unwrap().contains_key(session_id) {
            session.output_buffer.lock().unwrap().set_size(cols.max(1), rows.max(1));
            return Ok(());
        }
        let master = session.master.as_ref().context("terminal pty not found")?;
        let mut output = session.output_buffer.lock().unwrap();
        // Tab activation re-reports the same size; a no-op resize still makes TUIs repaint everything.
        if !force && output.cols == cols.max(1) && output.rows == rows.max(1) {
            return Ok(());
        }
        master.lock().unwrap().resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        output.set_size(cols.max(1), rows.max(1));
        Ok(())
    }

    pub fn terminal_buffer(&self, session_id: &str) -> anyhow::Result<TerminalBufferSnapshot> {
        self.terminal_buffer_since(session_id, None)
    }

    pub fn terminal_buffer_since(
        &self,
        session_id: &str,
        after: Option<u64>,
    ) -> anyhow::Result<TerminalBufferSnapshot> {
        if let Some(host) = self.agent_host(session_id) {
            return host.request("buffer", serde_json::json!({"after":after}));
        }
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .context("terminal session not found")?;
        let snapshot = session.output_buffer.lock().unwrap().snapshot_since(after);
        Ok(snapshot)
    }

    /// Locate the native Codex JSONL created for this embedded terminal session.
    /// Matching requires Codex's recorded cwd and a file created after the PTY launch;
    /// it never falls back to an arbitrary historical conversation.
    pub fn native_cli_transcript(
        &self,
        session_id: &str,
    ) -> anyhow::Result<Option<NativeCliTranscript>> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .context("terminal session not found")?;
        if session.provider_kind != "codex" {
            return Ok(None);
        }
        let result = locate_codex_transcript(&session.cwd, session.started_at)?;
        Ok(result)
    }

    pub fn session_provider(&self, session_id: &str) -> Option<String> {
        self.sessions.lock().unwrap().get(session_id).map(|session| session.provider_kind.clone())
    }

    pub fn session_chat_context(&self, session_id: &str) -> Option<(PathBuf, SystemTime, Option<String>)> {
        self.sessions.lock().unwrap().get(session_id)
            .map(|session| (session.cwd.clone(), session.started_at, session.native_session_id.clone()))
    }

    pub fn live_session_ids(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .iter()
            .filter_map(|(session_id, session)| {
                ((session.master.is_some() && session.writer.is_some() && session.child.is_some())
                    || self.independent_consoles.lock().unwrap().contains_key(session_id)
                    || self.agent_hosts.lock().unwrap().contains_key(session_id))
                    .then(|| session_id.clone())
            })
            .collect()
    }

    pub fn open_external_session(&self, session_id: &str, maximized: bool) -> anyhow::Result<()> {
        let (provider_kind, cwd, started_at, stored_native_session_id) = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(session_id)
                .context("terminal session not found")?;
            (
                session.provider_kind.clone(),
                session.cwd.clone(),
                session.started_at,
                session.native_session_id.clone(),
            )
        };
        let native_session_id = match stored_native_session_id {
            Some(value) => value,
            None if matches!(provider_kind.as_str(), "codex" | "claude") => {
                anyhow::bail!("原生会话尚未连接，请等待 CLI 启动完成后重试")
            }
            None => crate::cli_conversations::find_current_native_session_id(
                &cwd,
                &provider_kind,
                started_at,
            )?
            .with_context(|| "还没有找到当前 CLI 的原生会话 ID，请先在会话中发送一条消息后重试")?,
        };
        if provider_kind == "codex" {
            self.stop_codex_session_for_external_handoff(
                session_id,
                Duration::from_millis(CODEX_EXTERNAL_HANDOFF_EXIT_TIMEOUT_MS),
            )?;
        }
        open_external_cli_with_resume(&provider_kind, &cwd, &native_session_id, maximized)
    }

    pub(crate) fn stop_codex_session_for_external_handoff(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> anyhow::Result<()> {
        if let Some(host) = self.agent_host(session_id) {
            let _: serde_json::Value = host.request("handoff", serde_json::Value::Null)?;
            self.agent_hosts.lock().unwrap().remove(session_id);
            self.sessions.lock().unwrap().remove(session_id);
            return Ok(());
        }
        let (writer, child) = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(session_id)
                .context("terminal session not found")?;
            (
                session
                    .writer
                    .as_ref()
                    .map(Arc::clone)
                    .context("terminal writer not found")?,
                session
                    .child
                    .as_ref()
                    .map(Arc::clone)
                    .context("terminal child not found")?,
            )
        };

        write_terminal_input_to_writer(&writer, "/quit")
            .context("无法请求内嵌 Codex 正常退出")?;
        thread::sleep(Duration::from_millis(
            CODEX_EXTERNAL_HANDOFF_SUBMIT_DELAY_MS,
        ));
        write_terminal_input_to_writer(&writer, "\r")
            .context("无法提交内嵌 Codex 退出命令")?;
        drop(writer);
        if !wait_for_terminal_exit_with_timeout(&child, timeout)? {
            anyhow::bail!("内嵌 Codex 尚未结束，请等待当前回复完成或手动停止后重试");
        }
        drop(child);
        self.sessions.lock().unwrap().remove(session_id);
        Ok(())
    }

    pub fn find_live_project_service_session(&self, title: &str, cwd: &Path) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.iter().find_map(|(session_id, session)| {
            (session_matches_project_service(session, title, cwd)
                || (session.provider_kind == "project-service" && session.title == title
                    && terminal_cwd_matches(&session.cwd, cwd)
                    && self.independent_consoles.lock().unwrap().contains_key(session_id)))
                .then(|| session_id.clone())
        })
    }

    pub fn minecraft_client_launcher_active(&self, session_id: &str, names: &[String], timeout: Duration) -> anyhow::Result<bool> {
        let console = self.independent_consoles.lock().unwrap().get(session_id).cloned();
        let Some(console) = console else { return Ok(false) };
        let status = console.request("status", None)?;
        if !status.running { return Ok(false); }
        if !crate::service_console::descendant_processes(status.process_id, names)?.is_empty() { return Ok(true); }
        let created = fs::metadata(console.directory.join("launch.json"))?.modified()?;
        Ok(created.elapsed().unwrap_or_default() < timeout)
    }

    pub fn find_live_minecraft_client_session(&self, title: &str, cwd: &Path) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.iter().find_map(|(session_id, session)| {
            (session.provider_kind == "minecraft-client"
                && session.title == title
                && terminal_cwd_matches(&session.cwd, cwd)
                && ((session.master.is_some() && session.writer.is_some() && session.child.is_some())
                    || self.independent_consoles.lock().unwrap().contains_key(session_id)))
            .then(|| session_id.clone())
        })
    }

    /// Closing a desktop view must not terminate an independent Agent host.
    pub fn close_session_view(&self, session_id: &str) -> anyhow::Result<()> {
        let mut hosts = self.agent_hosts.lock().unwrap();
        if hosts.contains_key(session_id) {
            if let Some(data_dir) = &self.data_dir {
                crate::agent_console::release(data_dir, session_id)?;
            }
            self.detached_agent_hosts.lock().unwrap().insert(session_id.to_string());
            hosts.remove(session_id);
            drop(hosts);
            self.sessions.lock().unwrap().remove(session_id);
            CLAIMS.get_or_init(Default::default).lock().unwrap().remove(session_id);
            CHAT_CLAIMS.get_or_init(Default::default).lock().unwrap().remove(session_id);
            return Ok(());
        }
        drop(hosts);
        self.close_session(session_id)
    }

    pub fn close_session(&self, session_id: &str) -> anyhow::Result<()> {
        let host = self.agent_hosts.lock().unwrap().remove(session_id);
        if let Some(host) = host {
            if let Err(error) = host.terminate() {
                self.agent_hosts.lock().unwrap().insert(session_id.to_string(), host);
                return Err(error);
            }
        }
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(session_id)
        };
        self.independent_consoles.lock().unwrap().remove(session_id);

        if let Some(session) = session {
            close_terminal_session(session);
        }
        self.finish_agent_connection(session_id);
        CLAIMS.get_or_init(Default::default).lock().unwrap().remove(session_id);
        CHAT_CLAIMS.get_or_init(Default::default).lock().unwrap().remove(session_id);
        Ok(())
    }

    #[allow(dead_code)]
    pub fn close_sessions_for_workspace(&self, workspace_id: &str) -> anyhow::Result<()> {
        let ids = self.sessions.lock().unwrap().iter()
            .filter(|(_, session)| session.workspace_id.as_deref() == Some(workspace_id))
            .map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let mut errors = Vec::new();
        for id in ids {
            if let Err(error) = self.close_session_view(&id) { errors.push(format!("{id}: {error}")); }
        }
        anyhow::ensure!(errors.is_empty(), "{}", errors.join("；"));
        Ok(())
    }

    pub fn close_all_sessions(&self) -> anyhow::Result<()> {
        // Keep the desktop open if an Agent cannot be given its external terminal.
        if let Some(data_dir) = &self.data_dir {
            let hosts = self.agent_hosts.lock().unwrap().values().cloned().collect::<Vec<_>>();
            for host in hosts {
                if crate::service_console::process_matches(host.record.process) { crate::agent_console::attach(data_dir, &host)?; }
            }
        }
        let sessions_to_close = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .drain()
                .map(|(session_id, session)| (session_id, session))
                .collect::<Vec<_>>()
        };

        for (session_id, session) in sessions_to_close {
            // Detaching the desktop does not close the worker's PTY or provider backend.
            self.agent_hosts.lock().unwrap().remove(&session_id);
            if let Some(console) = self.independent_consoles.lock().unwrap().remove(&session_id) { console.release(); }
            close_terminal_session(session);
            self.finish_agent_connection(&session_id);
        }

        Ok(())
    }
}

fn finish_agent_connection(
    captures: &Arc<Mutex<HashMap<String, Arc<AgentConnection>>>>,
    session_id: &str,
) {
    let capture = captures.lock().unwrap().remove(session_id);
    if let Some(capture) = capture {
        capture.shutdown();
    }
}

struct NativeSessionBinding {
    session_id: String,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    pending: Mutex<Option<String>>,
}

impl NativeSessionBinding {
    fn update(&self, native: String) {
        let mut pending = self.pending.lock().unwrap();
        *pending = Some(native);
        self.bind(&mut pending);
    }

    fn bind_pending(&self) {
        self.bind(&mut self.pending.lock().unwrap());
    }

    fn bind(&self, pending: &mut Option<String>) {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&self.session_id) {
            if let Some(native) = pending.take().filter(|native| session.native_session_id.as_ref() != Some(native)) {
                session.native_session_id = Some(native);
                CLAIMS.get_or_init(Default::default).lock().unwrap().remove(&self.session_id);
                CHAT_CLAIMS.get_or_init(Default::default).lock().unwrap().remove(&self.session_id);
            }
        }
    }
}

fn claim_cli_source(
    sessions: &Mutex<HashMap<String, TerminalSession>>,
    session_id: &str,
    native_id: &Option<String>,
    source: &str,
) -> bool {
    let sessions = sessions.lock().unwrap();
    if !sessions.get(session_id).is_some_and(|session| &session.native_session_id == native_id) {
        return false;
    }
    let mut claims = CLAIMS.get_or_init(Default::default).lock().unwrap();
    if claims.iter().any(|(id, claimed)| id != session_id && claimed == source) {
        return false;
    }
    claims.insert(session_id.to_owned(), source.to_owned());
    true
}

fn codex_launcher_prefix(launch: &CliLaunch) -> Vec<String> {
    if launch.program.eq_ignore_ascii_case("cmd.exe") {
        // launch_command_for_path owns the /d /s /c call <launcher> prefix.
        launch.args[..5.min(launch.args.len())].to_vec()
    } else {
        Vec::new()
    }
}

fn codex_server_args(launch: &CliLaunch) -> Vec<String> {
    let mut args = codex_launcher_prefix(launch);
    // Remote TUI intentionally leaves permission configuration to its server.
    // Preserve the existing full-access launch behavior on the server side.
    args.extend(
        [
            "-c",
            "approval_policy='never'",
            "-c",
            "sandbox_mode='danger-full-access'",
            "app-server",
        ]
        .map(str::to_owned),
    );
    args
}

fn codex_remote_args(launch: &CliLaunch, endpoint: &str, native: Option<&str>) -> Vec<String> {
    let mut args = codex_launcher_prefix(launch);
    args.extend([
        "--remote".to_owned(),
        endpoint.to_owned(),
        "-c".to_owned(),
        "tui.whimsy=false".to_owned(),
    ]);
    if let Some(native) = native {
        args.extend(["resume".to_owned(), native.to_owned()]);
    }
    args
}

fn session_matches_project_service(session: &TerminalSession, title: &str, cwd: &Path) -> bool {
    project_service_session_matches(
        &session.provider_kind,
        &session.title,
        &session.cwd,
        title,
        cwd,
    ) && session.master.is_some()
        && session.writer.is_some()
        && session.child.is_some()
}

fn terminal_cwd_matches(cwd: &Path, project: &Path) -> bool {
    let normalize = |path: &Path| {
        let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let cwd = normalize(cwd);
    let project = normalize(project);
    cwd == project || cwd.starts_with(&format!("{project}\\"))
}

fn project_service_session_matches(
    provider_kind: &str,
    session_title: &str,
    session_cwd: &Path,
    title: &str,
    cwd: &Path,
) -> bool {
    provider_kind == "project-service" && session_title == title && session_cwd == cwd
}

fn spawn_terminal_background_tasks(
    app: &TerminalEvents,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: String,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    mut reader: Box<dyn Read + Send>,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
    agent_connections: Arc<Mutex<HashMap<String, Arc<AgentConnection>>>>,
) {
    let (emit_tx, emit_rx) =
        mpsc::sync_channel::<PendingTerminalOutput>(TERMINAL_OUTPUT_CHANNEL_CAPACITY);
    let emit_app_handle = app.clone();
    let emit_session_id = session_id.clone();
    let emit_thread = thread::spawn(move || {
        emit_terminal_output_batches(emit_app_handle, emit_session_id, emit_rx);
    });

    let reader_output_buffer = Arc::clone(&output_buffer);
    let reader_session_id = session_id.clone();
    let reader_is_gemini = sessions.lock().unwrap().get(&session_id).is_some_and(|session| session.provider_kind == "gemini");
    let reader_is_kimi = sessions.lock().unwrap().get(&session_id).is_some_and(|session| session.provider_kind == "kimi");
    let reader_thread = thread::spawn(move || {
        let mut buffer = [0u8; 16384];
        let mut pending_utf8 = Vec::new();
        let mut gemini_output = crate::cli_completion_adapters::GeminiOutputState::default();
        let mut kimi_output = crate::cli_completion_adapters::GeminiOutputState::default();
        loop {
            let size = match reader.read(&mut buffer) {
                Ok(size) => size,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => 0,
            };
            if reader_is_gemini {
                crate::cli_completion_adapters::observe_gemini_output(&reader_session_id, &buffer[..size], &mut gemini_output);
            }
            if reader_is_kimi {
                crate::cli_completion_adapters::observe_kimi_output(&reader_session_id, &buffer[..size], &mut kimi_output);
            }
            let chunk = decode_terminal_utf8_chunk(&mut pending_utf8, &buffer[..size], size == 0);
            if !chunk.is_empty() {
                let (start_byte, end_byte) = {
                    let mut output = reader_output_buffer.lock().unwrap();
                    let start_byte = output.end_byte;
                    output.append(&chunk);
                    (start_byte, output.end_byte)
                };
                if emit_tx.send(PendingTerminalOutput { chunk, start_byte, end_byte }).is_err() {
                    break;
                }
            }
            if size == 0 {
                break;
            }
        }
    });

    let exit_app = app.clone();
    thread::spawn(move || {
        let exit_code = wait_for_terminal_exit(&child);
        let event_session_id = session_id.clone();
        let cleanup_session_id = session_id.clone();
        finish_agent_connection(&agent_connections, &cleanup_session_id);
        finish_terminal_exit_session(
            &sessions,
            &session_id,
            Duration::from_millis(TERMINAL_EXIT_SESSION_REMOVAL_GRACE_MS),
            move || {
                drop(child);
                exit_app.exit(TerminalExitEvent { session_id: event_session_id, exit_code });
            },
        );
        join_finished_terminal_thread(reader_thread);
        join_finished_terminal_thread(emit_thread);
    });
}

static CLAIMS: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
static CHAT_CLAIMS: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();

/// Gemini and Kimi completion hooks are separate from their conversation histories.
pub(crate) fn chat_source(session_id: &str, provider: &str, cwd: &Path, started_at: SystemTime, native_id: Option<&str>) -> anyhow::Result<Option<String>> {
    if !matches!(provider, "gemini" | "kimi") { return Ok(claimed_cli_source(session_id)); }
    let mut claims = CHAT_CLAIMS.get_or_init(Default::default).lock().unwrap();
    if let Some(source) = claims.get(session_id) { return Ok(Some(source.clone())); }
    let excluded = claims.values().cloned().collect();
    let source = crate::cli_conversations::completion_source(cwd, provider, native_id, started_at, &excluded)?;
    if let Some(source) = &source { claims.insert(session_id.to_owned(), source.clone()); }
    Ok(source)
}

/// Native log claimed by the completion watcher; chat mode reads the same file.
pub(crate) fn claimed_cli_source(session_id: &str) -> Option<String> {
    CLAIMS.get_or_init(Default::default).lock().unwrap().get(session_id).cloned()
}

fn spawn_cli_completion_watcher(
    app: TerminalEvents,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: String,
    question_seen: Arc<Mutex<std::collections::HashSet<(String, String)>>>,
) {
    thread::spawn(move || {
        let mut source = None;
        let mut last_token = None;
        let mut last_stamp = None;
        let mut source_native = None;
        let mut question_offset = None;
        loop {
            let session = {
                let sessions = sessions.lock().unwrap();
                sessions
                    .get(&session_id)
                    .filter(|session| session.child.is_some())
                    .map(|session| {
                        (
                            session.provider_kind.clone(),
                            session.cwd.clone(),
                            session.started_at,
                            session.native_session_id.clone(),
                            session.title.clone(),
                        )
                    })
            };
            let Some((provider, cwd, started_at, native_id, title)) = session else {
                CLAIMS.get_or_init(Default::default).lock().unwrap().remove(&session_id);
                CHAT_CLAIMS.get_or_init(Default::default).lock().unwrap().remove(&session_id);
                crate::cli_completion_adapters::cleanup_kimi_completion(&session_id);
                crate::cli_completion_adapters::cleanup_gemini_completion(&session_id);
                break;
            };
            if source_native != native_id {
                source = None;
                last_token = None;
                last_stamp = None;
                source_native = native_id.clone();
                question_offset = None;
            }
            if source.is_none() {
                if matches!(provider.as_str(), "codex" | "claude") && native_id.is_none() {
                    thread::sleep(Duration::from_millis(200));
                    continue;
                }
                if matches!(provider.as_str(), "gemini" | "kimi") {
                    source = Some(crate::cli_completion_adapters::gemini_completion_path(&session_id).to_string_lossy().into_owned());
                } else {
                    let excluded = CLAIMS.get_or_init(Default::default).lock().unwrap().values().cloned().collect();
                    source = crate::cli_conversations::completion_source(&cwd, &provider, native_id.as_deref(), started_at, &excluded).ok().flatten()
                        .filter(|source| claim_cli_source(&sessions, &session_id, &native_id, source));
                }
            }
            if let Some(source) = source.as_deref() {
                if provider == "codex" {
                    if let Some(thread) = native_id.as_deref() {
                        let offset = question_offset.get_or_insert_with(|| fs::metadata(source).map(|m| m.len().saturating_sub(256 * 1024)).unwrap_or(0));
                        if let Ok(questions) = crate::cli_completion::read_codex_async_questions(Path::new(source), offset, crate::cli_completion::unix_millis(started_at), thread) {
                            for (question_thread, item, answer) in questions {
                                let current = sessions.lock().unwrap();
                                if current.get(&session_id).is_some_and(|session| session.child.is_some() && session.native_session_id.as_deref() == Some(question_thread.as_str())) && crate::cli_completion::claim_async_question(&question_seen, &question_thread, &item) {
                                    app.notify(crate::cli_completion::CompletionNotice {
                                        title: title.clone(), provider: provider.clone(), workspace: cwd.to_string_lossy().into_owned(),
                                        conversation_id: question_thread, session_id: session_id.clone(), answer, async_question: true,
                                        ..Default::default()
                                    });
                                }
                            }
                        }
                    }
                }
                // File watchers avoid reparsing unchanged histories; SQLite uses its own WAL.
                let watch_path = crate::cli_completion_adapters::watch_path(&provider, source);
                let stamp = fs::metadata(watch_path).ok().and_then(|metadata| {
                    metadata
                        .modified()
                        .ok()
                        .map(|modified| (modified, metadata.len()))
                });
                if provider == "opencode" || stamp != last_stamp || last_stamp.is_none() {
                    last_stamp = stamp;
                    if let Ok(Some((token, completed_at))) = crate::cli_completion::latest_completion(&provider, source) {
                        if last_token.as_ref() != Some(&token) {
                            last_token = Some(token.clone());
                            // Existing final answers are a baseline when a native conversation is restored.
                            if completed_at >= crate::cli_completion::unix_millis(started_at) {
                                let mut notice = crate::cli_conversations::completion_notice(
                                    &provider, source, &token, completed_at, Path::new(&cwd),
                                ).unwrap_or_default();
                                if notice.title.is_empty() { notice.title = title.clone(); }
                                notice.provider = provider.clone();
                                notice.workspace = cwd.to_string_lossy().into_owned();
                                if notice.conversation_id.is_empty() {
                                    notice.conversation_id = native_id.clone().unwrap_or_else(|| session_id.clone());
                                }
                                let current = sessions.lock().unwrap();
                                if current.get(&session_id).is_some_and(|session| session.native_session_id == native_id) {
                                    app.notify(notice);
                                }
                            }
                        }
                    }
                }
            }
            thread::sleep(Duration::from_millis(1000));
        }
    });
}

fn wait_for_terminal_exit(
    child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
) -> Option<i32> {
    loop {
        let status = {
            let mut child = child.lock().unwrap();
            child.try_wait()
        };
        match status {
            Ok(Some(status)) => return Some(status.exit_code() as i32),
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => return None,
        }
    }
}

fn wait_for_terminal_exit_with_timeout(
    child: &Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    timeout: Duration,
) -> anyhow::Result<bool> {
    let started_at = Instant::now();
    loop {
        let status = {
            let mut child = child.lock().unwrap();
            child.try_wait()
        }
        .context("无法确认内嵌 Codex 是否已经退出")?;
        if status.is_some() {
            return Ok(true);
        }
        if started_at.elapsed() >= timeout {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn release_terminal_session_handles(
    sessions: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: &str,
) {
    let mut sessions = sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(session_id) {
        session.master = None;
        session.writer = None;
        session.child = None;
    }
}

fn finish_terminal_exit_session(
    sessions: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: &str,
    removal_grace: Duration,
    emit_exit: impl FnOnce(),
) {
    release_terminal_session_handles(sessions, session_id);
    emit_exit();
    thread::sleep(removal_grace);
    remove_terminal_session(sessions, session_id);
}

fn join_finished_terminal_thread(handle: thread::JoinHandle<()>) {
    if handle.is_finished() {
        let _ = handle.join();
    }
}

fn remove_terminal_session(
    sessions: &Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: &str,
) {
    sessions.lock().unwrap().remove(session_id);
}

fn close_terminal_session(session: TerminalSession) {
    if let Some(child) = session.child {
        let mut child = child.lock().unwrap();
        kill_pty_child_tree(child.as_mut());
    }
}

fn write_terminal_input_to_writer(
    writer: &Arc<Mutex<Box<dyn Write + Send>>>,
    input: &str,
) -> anyhow::Result<()> {
    let mut writer = writer.lock().unwrap();
    writer.write_all(input.as_bytes())?;
    writer.flush()?;
    Ok(())
}

fn write_ai_initial_prompt_async(writer: Arc<Mutex<Box<dyn Write + Send>>>, input: String) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(AI_INITIAL_PROMPT_READY_DELAY_MS));
        if write_terminal_input_to_writer(&writer, &input).is_err() {
            return;
        }
        thread::sleep(Duration::from_millis(AI_INITIAL_PROMPT_SUBMIT_DELAY_MS));
        let _ = write_terminal_input_to_writer(&writer, "\r");
    });
}

impl TerminalOutputBuffer {
    fn append(&mut self, chunk: &str) {
        self.append_with_limit(chunk, TERMINAL_OUTPUT_HISTORY_LIMIT_BYTES);
    }

    fn append_with_limit(&mut self, chunk: &str, limit_bytes: usize) {
        self.end_byte = self.end_byte.saturating_add(chunk.len() as u64);
        self.modes.observe(chunk);

        if limit_bytes == 0 {
            self.chunks.clear();
            self.len_bytes = 0;
            self.start_byte = self.end_byte;
        } else if chunk.len() >= limit_bytes {
            let suffix = utf8_suffix_with_limit(chunk, limit_bytes).to_string();
            self.len_bytes = suffix.len();
            self.chunks.clear();
            if !suffix.is_empty() {
                self.chunks.push_back(suffix);
            }
            self.start_byte = self.end_byte.saturating_sub(self.len_bytes as u64);
        } else {
            if !chunk.is_empty() {
                self.len_bytes += chunk.len();
                self.chunks.push_back(chunk.to_string());
            }
            self.trim_to_limit(limit_bytes);
            self.start_byte = self.end_byte.saturating_sub(self.len_bytes as u64);
        }
        self.trim_size_marks();
    }

    /// 记录尺寸变化发生时的输出偏移；同一偏移的连续 resize 只保留最后一次。
    fn set_size(&mut self, cols: u16, rows: u16) {
        if self.cols == cols && self.rows == rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        let mark = TerminalSizeMark { at_byte: self.end_byte, cols, rows };
        match self.size_marks.back_mut() {
            Some(last) if last.at_byte == mark.at_byte => *last = mark,
            _ => self.size_marks.push_back(mark),
        }
        self.trim_size_marks();
    }

    /// 只保留一个不晚于 `start_byte` 的标记作为回放起始尺寸。
    fn trim_size_marks(&mut self) {
        while self.size_marks.len() > 1
            && (self.size_marks[1].at_byte <= self.start_byte
                || self.size_marks.len() > TERMINAL_SIZE_MARK_LIMIT)
        {
            self.size_marks.pop_front();
        }
    }

    fn size_marks_from(&self, start_byte: u64) -> Vec<TerminalSizeMark> {
        let first = self
            .size_marks
            .iter()
            .rposition(|mark| mark.at_byte <= start_byte)
            .unwrap_or(0);
        self.size_marks.iter().skip(first).copied().collect()
    }

    fn trim_to_limit(&mut self, limit_bytes: usize) {
        while self.len_bytes > limit_bytes {
            let excess_bytes = self.len_bytes - limit_bytes;
            let Some(front) = self.chunks.front_mut() else {
                self.len_bytes = 0;
                return;
            };
            if front.len() <= excess_bytes {
                let removed = front.len();
                self.chunks.pop_front();
                self.len_bytes -= removed;
                continue;
            }

            let trim_to = next_char_boundary(front, excess_bytes);
            if trim_to >= front.len() {
                let removed = front.len();
                self.chunks.pop_front();
                self.len_bytes -= removed;
            } else {
                front.drain(..trim_to);
                self.len_bytes -= trim_to;
            }
        }
    }

    #[cfg(test)]
    fn snapshot(&self) -> TerminalBufferSnapshot {
        self.snapshot_since(None)
    }

    fn snapshot_since(&self, after: Option<u64>) -> TerminalBufferSnapshot {
        let offset = after
            .filter(|after| *after >= self.start_byte && *after <= self.end_byte)
            .map(|after| (after - self.start_byte) as usize);
        if offset == Some(self.len_bytes) {
            return TerminalBufferSnapshot {
                buffer: String::new(),
                start_byte: self.end_byte,
                end_byte: self.end_byte,
                cols: self.cols,
                rows: self.rows,
                modes: self.modes.replay(),
                sizes: self.size_marks_from(self.end_byte),
            };
        }
        let mut skip = offset.unwrap_or(0);
        let mut buffer = String::with_capacity(self.len_bytes.saturating_sub(skip));
        for chunk in &self.chunks {
            if skip >= chunk.len() {
                skip -= chunk.len();
                continue;
            }
            if !chunk.is_char_boundary(skip) {
                return self.snapshot_since(None);
            }
            buffer.push_str(&chunk[skip..]);
            skip = 0;
        }
        let start_byte = self.start_byte + offset.unwrap_or(0) as u64;
        TerminalBufferSnapshot {
            buffer,
            start_byte,
            end_byte: self.end_byte,
            cols: self.cols,
            rows: self.rows,
            modes: self.modes.replay(),
            sizes: self.size_marks_from(start_byte),
        }
    }
}

/// DEC 2026 同步输出标记（BSU/ESU）包裹每一帧差分 patch；
/// xterm.js 不实现 DEC 2026（标记会被忽略），帧原子性必须由传输层保证——
/// 切包只允许发生在已闭合帧边界之后，避免把任一帧切碎导致 patch 错位重叠。
const SYNC_OUTPUT_SET: &str = "\x1b[?2026h";
const SYNC_OUTPUT_RESET: &str = "\x1b[?2026l";

/// 找到 `chunk` 中最后一个已闭合同步帧（ESU 之后）的字节偏移。
/// - 无任何同步标记 → `None`（普通输出，整段可发）。
/// - 有 BSU 但从未闭合 → `None`（帧还没写完，不切）。
/// - 有完整帧对 → `Some(end)`，`end` 落在最后一个 ESU 之后；
///   前段是若干完整帧，后段从某个未闭合 BSU 开始（留给下一次合并）。
fn last_closed_sync_frame_end(chunk: &str) -> Option<usize> {
    let bytes = chunk.as_bytes();
    let set = SYNC_OUTPUT_SET.as_bytes();
    let reset = SYNC_OUTPUT_RESET.as_bytes();
    let mut depth: usize = 0;
    let mut last_close_end: Option<usize> = None;
    let mut i = 0;
    while i + set.len() <= bytes.len() {
        if &bytes[i..i + reset.len()] == reset {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                last_close_end = Some(i + reset.len());
            }
            i += reset.len();
            continue;
        }
        if &bytes[i..i + set.len()] == set {
            depth += 1;
            i += set.len();
            continue;
        }
        i += 1;
    }
    last_close_end
}

/// 把待发缓冲切成 (可以立即发的前段, 需要继续等待/累积的后段)。
/// - 无同步帧标记：普通输出，整段立即发。
/// - 有完整帧对：切在最后闭合帧边界，帧外文本与未闭合帧留给下次合并。
/// - 只有未闭合帧：等待后续字节，直到异常阈值强制整段发出（防输出停滞）。
fn split_pending_at_frame_boundary(pending: &str) -> (String, String) {
    if pending.is_empty() {
        return (String::new(), String::new());
    }
    if !pending.contains(SYNC_OUTPUT_SET) {
        return (pending.to_string(), String::new());
    }
    let Some(end) = last_closed_sync_frame_end(pending) else {
        if pending.len() >= TERMINAL_OUTPUT_SYNC_FRAME_FORCE_LIMIT_BYTES {
            return (pending.to_string(), String::new());
        }
        return (String::new(), pending.to_string());
    };
    if end >= pending.len() {
        return (pending.to_string(), String::new());
    }
    let emit_part = pending[..end].to_string();
    let keep_part = pending[end..].to_string();
    if keep_part.len() >= TERMINAL_OUTPUT_SYNC_FRAME_FORCE_LIMIT_BYTES {
        // 后段一直不闭合（异常），强制整段发出，避免输出停滞。
        return (pending.to_string(), String::new());
    }
    (emit_part, keep_part)
}

fn split_pending_for_size_emit(pending: &str) -> Option<(String, String)> {
    if pending.len() < TERMINAL_OUTPUT_EMIT_LIMIT_BYTES {
        return None;
    }
    let split = split_pending_at_frame_boundary(pending);
    (!split.0.is_empty()).then_some(split)
}

fn emit_terminal_output_batches(
    app_handle: TerminalEvents,
    session_id: String,
    receiver: mpsc::Receiver<PendingTerminalOutput>,
) {
    let emit_interval = Duration::from_millis(TERMINAL_OUTPUT_EMIT_INTERVAL_MS);
    let mut pending = String::new();
    let mut pending_start_byte = 0;
    let mut pending_end_byte = 0;
    let mut emit_at: Option<Instant> = None;

    loop {
        if pending.is_empty() {
            match receiver.recv() {
                Ok(output) => {
                    pending_start_byte = output.start_byte;
                    pending_end_byte = output.end_byte;
                    pending.push_str(&output.chunk);
                    emit_at = Some(Instant::now() + emit_interval);
                }
                Err(_) => break,
            }
        }

        if let Some((emit_part, keep_part)) = split_pending_for_size_emit(&pending) {
            let end_byte = pending_start_byte + emit_part.len() as u64;
            emit_terminal_output_batch(
                &app_handle,
                &session_id,
                emit_part,
                pending_start_byte,
                end_byte,
            );
            pending_start_byte = end_byte;
            pending = keep_part;
            emit_at = if pending.is_empty() {
                None
            } else {
                Some(Instant::now() + emit_interval)
            };
            continue;
        }

        let Some(deadline) = emit_at else {
            // pending 非空却没有发射截止时间时，不能空转；等下一批 PTY 数据。
            match receiver.recv() {
                Ok(output) => {
                    pending_end_byte = output.end_byte;
                    pending.push_str(&output.chunk);
                    emit_at = Some(Instant::now() + emit_interval);
                }
                Err(_) => break,
            }
            continue;
        };
        let now = Instant::now();
        if now >= deadline {
            let (emit_part, keep_part) = split_pending_at_frame_boundary(&pending);
            if !emit_part.is_empty() {
                let end_byte = pending_start_byte + emit_part.len() as u64;
                emit_terminal_output_batch(
                    &app_handle,
                    &session_id,
                    emit_part,
                    pending_start_byte,
                    end_byte,
                );
                pending_start_byte = end_byte;
            }
            pending = keep_part;
            emit_at = if pending.is_empty() {
                None
            } else {
                // 未闭合的同步帧继续等待，直到闭合或强制阈值。
                Some(Instant::now() + emit_interval)
            };
            continue;
        }

        match receiver.recv_timeout(deadline.saturating_duration_since(now)) {
            Ok(output) => {
                if pending.is_empty() {
                    pending_start_byte = output.start_byte;
                    emit_at = Some(Instant::now() + emit_interval);
                }
                pending_end_byte = output.end_byte;
                pending.push_str(&output.chunk);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let (emit_part, keep_part) = split_pending_at_frame_boundary(&pending);
                if !emit_part.is_empty() {
                    let end_byte = pending_start_byte + emit_part.len() as u64;
                    emit_terminal_output_batch(
                        &app_handle,
                        &session_id,
                        emit_part,
                        pending_start_byte,
                        end_byte,
                    );
                    pending_start_byte = end_byte;
                }
                pending = keep_part;
                emit_at = if pending.is_empty() {
                    None
                } else {
                    Some(Instant::now() + emit_interval)
                };
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if !pending.is_empty() {
                    emit_terminal_output_batch(
                        &app_handle,
                        &session_id,
                        std::mem::take(&mut pending),
                        pending_start_byte,
                        pending_end_byte,
                    );
                }
                break;
            }
        }
    }
}

fn emit_terminal_output_batch(
    app_handle: &TerminalEvents,
    session_id: &str,
    chunk: String,
    start_byte: u64,
    end_byte: u64,
) {
    if chunk.is_empty() {
        return;
    }
    app_handle.output(TerminalOutputEvent {
            session_id: session_id.to_string(),
            chunk,
            start_byte,
            end_byte,
        });
}

fn utf8_suffix_with_limit(value: &str, limit_bytes: usize) -> &str {
    if value.len() <= limit_bytes {
        return value;
    }
    let start = next_char_boundary(value, value.len() - limit_bytes);
    &value[start..]
}

// PTY reads may end inside a multibyte character. Only replace invalid bytes,
// carrying an incomplete character into the next read (at most three bytes).
pub(crate) fn decode_terminal_utf8_chunk(pending: &mut Vec<u8>, bytes: &[u8], flush: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut text = String::new();
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(value) => { text.push_str(value); consumed = pending.len(); }
            Err(error) => {
                let valid_end = consumed + error.valid_up_to();
                text.push_str(std::str::from_utf8(&pending[consumed..valid_end]).unwrap());
                consumed = valid_end;
                if let Some(length) = error.error_len() {
                    text.push('\u{fffd}');
                    consumed += length;
                } else {
                    if flush { text.push('\u{fffd}'); consumed = pending.len(); }
                    break;
                }
            }
        }
    }
    pending.drain(..consumed);
    text
}

fn decode_service_log_chunk(pending: &mut Vec<u8>, bytes: &[u8], flush: bool) -> String {
    pending.extend_from_slice(bytes);
    let end = if flush || pending.len() >= TERMINAL_OUTPUT_HISTORY_LIMIT_BYTES {
        pending.len()
    } else {
        pending.iter().rposition(|byte| *byte == b'\n').map_or(0, |index| index + 1)
    };
    let mut text = String::new();
    for line in pending[..end].split_inclusive(|byte| *byte == b'\n') {
        match std::str::from_utf8(line) {
            Ok(value) => text.push_str(value),
            Err(_) => text.push_str(&encoding_rs::GBK.decode(line).0),
        }
    }
    pending.drain(..end);
    text
}

fn next_char_boundary(value: &str, mut index: usize) -> usize {
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

pub fn detect_cli_environments() -> Vec<CliProviderEnvironment> {
    let dirs = detection_dirs();
    CLI_PROVIDERS
        .iter()
        .map(|provider| detect_provider_environment(provider, &dirs))
        .collect()
}

#[cfg(windows)]
pub fn open_external_cli(provider_kind: &str, cwd: &Path, maximized: bool) -> anyhow::Result<()> {
    if !cwd.is_dir() {
        anyhow::bail!("CLI working directory does not exist: {}", cwd.display());
    }

    let launch = resolve_launch(provider_kind)?;
    let command_args = external_cli_command_args(&launch, provider_kind);
    spawn_external_cmd(&command_args, cwd, provider_kind, maximized)
        .with_context(|| format!("failed to open external {} console", launch.title))
}

#[cfg(windows)]
fn open_external_cli_with_resume(
    provider_kind: &str,
    cwd: &Path,
    native_session_id: &str,
    maximized: bool,
) -> anyhow::Result<()> {
    if !cwd.is_dir() {
        anyhow::bail!("CLI working directory does not exist: {}", cwd.display());
    }

    let mut launch = resolve_launch(provider_kind)?;
    let resume_args = resume_args_for_provider(provider_kind, native_session_id)
        .with_context(|| format!("{} 不支持恢复原生会话", provider_kind))?;
    launch.args.extend(resume_args);
    let command_args = external_cli_command_args(&launch, provider_kind);
    spawn_external_cmd(&command_args, cwd, provider_kind, maximized)
        .with_context(|| format!("failed to resume external {} console", launch.title))
}

#[cfg(not(windows))]
pub fn open_external_cli(_provider_kind: &str, _cwd: &Path, _maximized: bool) -> anyhow::Result<()> {
    anyhow::bail!("External CMD launch is only available on Windows")
}

#[cfg(not(windows))]
fn open_external_cli_with_resume(
    _provider_kind: &str,
    _cwd: &Path,
    _native_session_id: &str,
    _maximized: bool,
) -> anyhow::Result<()> {
    anyhow::bail!("External CMD launch is only available on Windows")
}

const INHERITED_AGENT_VARIABLES: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_PID",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "CODEX_THREAD_ID",
    "CODEX_MANAGED_BY_NPM",
    "CODEX_MANAGED_BY_BUN",
    "GEMINI_MODEL",
    "SUPERHIGH_SESSION_ID",
];

fn clear_inherited_agent_environment(builder: &mut CommandBuilder) {
    for key in INHERITED_AGENT_VARIABLES {
        builder.env_remove(key);
    }
}

/// Advertise the new Windows console's color capabilities without carrying
/// over the embedded terminal's Cursor/WT session identity.
fn external_console_setup_prefix(provider_kind: &str) -> String {
    let mut prefix = concat!(
        r#"set "TERM=xterm-256color" & "#,
        r#"set "COLORTERM=truecolor" & "#,
        r#"set "NO_COLOR=" & "#,
        r#"set "WT_SESSION=" & "#,
        r#"set "WT_PROFILE_ID=" & "#,
        r#"set "WT_DEFAULT_PROFILE=" & "#,
        r#"set "TERM_PROGRAM=" & "#,
        r#"set "TERM_PROGRAM_VERSION=" & "#,
        r#"set "VSCODE_INJECTION=" & "#,
        r#"chcp 65001>nul & "#,
    ).to_string();
    for key in INHERITED_AGENT_VARIABLES {
        prefix.push_str(&format!(r#"set "{key}=" & "#));
    }
    // Do not let an inherited color-depth override degrade Codex's native palette.
    if provider_kind == "codex" {
        prefix.push_str(r#"set "FORCE_COLOR=" & "#);
        prefix.push_str(r#"set "CLICOLOR_FORCE=" & "#);
    }
    prefix
}

fn external_cmd_command_line(application: &str, command: &str, provider_kind: &str) -> String {
    format!(
        "\"{}\" /d /k {}{}",
        application,
        external_console_setup_prefix(provider_kind),
        command
    )
}

fn external_cli_command_args(launch: &CliLaunch, provider_kind: &str) -> Vec<String> {
    let (program, args) = if launch.program.eq_ignore_ascii_case("cmd.exe")
        && launch.args.get(0).map(String::as_str) == Some("/d")
        && launch.args.get(1).map(String::as_str) == Some("/s")
        && launch.args.get(2).map(String::as_str) == Some("/c")
        && launch.args.get(3).map(String::as_str) == Some("call")
        && launch.args.get(4).is_some()
    {
        (&launch.args[4], &launch.args[5..])
    } else {
        (&launch.program, launch.args.as_slice())
    };
    std::iter::once("call".to_string())
        .chain(std::iter::once(program.replace('/', "\\")))
        // The new console inherits Super High's token. Codex's shared Windows
        // daemon rejects elevated clients; direct mode also works for resume.
        .chain((provider_kind == "codex").then(|| "--no-daemon".to_string()))
        .chain(args.iter().cloned())
        .collect()
}

#[cfg(windows)]
fn spawn_external_cmd(
    command_args: &[String],
    cwd: &Path,
    provider_kind: &str,
    maximized: bool,
) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            CreateProcessW, CREATE_NEW_CONSOLE, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
            STARTUPINFOW,
        },
        UI::WindowsAndMessaging::{SW_SHOWMAXIMIZED, SW_SHOWNORMAL},
    };

    let application = std::env::var_os("COMSPEC").unwrap_or_else(|| OsString::from("cmd.exe"));
    let application_wide = application
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let command = command_args
        .iter()
        .enumerate()
        .map(|(index, value)| {
            if index == 0 {
                value.clone()
            } else {
                format!("\"{}\"", value.replace('"', "\"\""))
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    let mut command_line = external_cmd_command_line(&application.to_string_lossy(), &command, provider_kind)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let cwd_wide = cwd
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut startup_info = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESHOWWINDOW,
        wShowWindow: if maximized { SW_SHOWMAXIMIZED } else { SW_SHOWNORMAL } as u16,
        ..unsafe { std::mem::zeroed() }
    };
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            application_wide.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            CREATE_NEW_CONSOLE,
            std::ptr::null(),
            cwd_wide.as_ptr(),
            &mut startup_info,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    unsafe {
        CloseHandle(process_info.hThread);
        CloseHandle(process_info.hProcess);
    }
    Ok(())
}

fn resolve_launch(provider_kind: &str) -> anyhow::Result<CliLaunch> {
    let dirs = detection_dirs();
    let path_env = joined_path_env(&dirs);
    let superhigh_cli_path =
        find_superhigh_cli_executable(&dirs).map(|path| normalize_display_path(&path));

    if provider_kind == "local" {
        return Ok(CliLaunch {
            program: "powershell.exe".to_string(),
            args: vec!["-NoLogo".to_string()],
            title: "PowerShell".to_string(),
            path_env,
            superhigh_cli_path,
        });
    }

    let provider = CLI_PROVIDERS
        .iter()
        .find(|item| item.kind == provider_kind)
        .with_context(|| format!("unknown CLI provider: {}", provider_kind))?;
    let environment = detect_provider_environment(provider, &dirs);
    let resolved_path = environment.resolved_path.clone().with_context(|| {
        environment.issue.clone().unwrap_or_else(|| {
            format!(
                "{} 未安装或不在当前 CLI 搜索路径中，请先到“设置 > CLI 管理”刷新检测。",
                provider.name
            )
        })
    })?;
    let provider_args = args_for_provider(provider_kind)
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let (program, args) = launch_command_for_path(&resolved_path, &provider_args);
    Ok(CliLaunch {
        program,
        args,
        title: provider.name.to_string(),
        path_env,
        superhigh_cli_path,
    })
}

fn configure_embedded_codex(builder: &mut CommandBuilder) {
    // Astra's composer sparkle emits animated Braille dots and background cells into
    // the PTY shared by desktop and mobile. Disable decorative effects for embedded
    // sessions (including resume), without changing the user's external CLI config.
    builder.arg("-c");
    builder.arg("tui.whimsy=false");
}

fn configure_terminal_color_environment(builder: &mut CommandBuilder, provider_kind: &str) {
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    // FORCE_COLOR and NO_COLOR are contradictory. Remove a value inherited
    // from the host process before enabling colors for the embedded PTY.
    builder.env_remove("NO_COLOR");
    if provider_kind != "codex" {
        builder.env("FORCE_COLOR", "1");
        return;
    }

    // Codex enables its rich TUI rendering from terminal capability variables.
    builder.env("FORCE_COLOR", "3");
    builder.env("CLICOLOR", "1");
    builder.env("CLICOLOR_FORCE", "1");
    builder.env("TERM_PROGRAM", "SuperHigh");
    builder.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    #[cfg(windows)]
    builder.env("WT_SESSION", "SuperHigh");
}

fn detect_provider_environment(
    provider: &CliProviderDefinition,
    dirs: &[PathBuf],
) -> CliProviderEnvironment {
    let found = find_provider_executable(provider, dirs);
    let checked_locations = dirs.iter().map(normalize_display_path).collect::<Vec<_>>();
    let issue = found.is_none().then(|| {
        format!(
            "未找到 {}。已检查 PATH、原生安装目录、npm、pnpm、Bun、Cargo 和 Cherry Studio 常见目录。",
            provider.command
        )
    });
    let source = found.as_ref().map(|path| classify_cli_source(path));
    let launcher = found
        .as_ref()
        .map(|path| launcher_label(path))
        .unwrap_or_else(|| provider.command.to_string());

    CliProviderEnvironment {
        provider_kind: provider.kind.to_string(),
        name: provider.name.to_string(),
        command: provider.command.to_string(),
        available: found.is_some(),
        resolved_path: found.as_ref().map(normalize_display_path),
        launcher,
        source,
        issue,
        checked_locations,
    }
}

fn find_provider_executable(provider: &CliProviderDefinition, dirs: &[PathBuf]) -> Option<PathBuf> {
    let preferred_dirs = preferred_provider_dirs(provider.kind);
    find_provider_executable_in(provider, &preferred_dirs, dirs)
}

fn find_provider_executable_in(
    provider: &CliProviderDefinition,
    preferred_dirs: &[PathBuf],
    dirs: &[PathBuf],
) -> Option<PathBuf> {
    for directory in preferred_dirs {
        if let Some(path) = find_executable(provider.command, std::slice::from_ref(directory)) {
            return Some(path);
        }
    }

    find_executable(provider.command, dirs)
}

fn args_for_provider(provider_kind: &str) -> Vec<&'static str> {
    match provider_kind {
        "claude" => vec!["--dangerously-skip-permissions"],
        "codex" => vec!["--dangerously-bypass-approvals-and-sandbox"],
        // Fully autonomous: no permission prompts and no clarifying questions.
        "kimi" => vec!["--auto"],
        // Always-approve tools + unrestricted sandbox (same intent as Claude/Codex full access).
        "grok" => vec!["--always-approve", "--sandbox", "off"],
        "gemini" => vec!["--skip-trust", "--approval-mode", "yolo"],
        // Skip permission prompts so the embedded session stays interactive;
        // CodeBuddy still asks for HIGH/CRITICAL operations.
        "codebuddy" => vec!["--dangerously-skip-permissions"],
        "local" => vec!["-NoLogo"],
        _ => Vec::new(),
    }
}

fn resume_args_for_provider(provider_kind: &str, native_session_id: &str) -> Option<Vec<String>> {
    let native_session_id = native_session_id.trim();
    if native_session_id.is_empty() {
        return None;
    }
    let args = match provider_kind {
        "claude" => vec!["--resume", native_session_id],
        "codex" => vec!["resume", native_session_id],
        "kimi" => vec!["-S", native_session_id],
        "grok" => vec!["--resume", native_session_id],
        "gemini" => vec!["--resume", native_session_id],
        "opencode" => vec!["--session", native_session_id],
        "codebuddy" => vec!["--resume", native_session_id],
        _ => return None,
    };
    Some(args.into_iter().map(str::to_string).collect())
}

fn find_executable(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let names = executable_names(command);
    let mut best: Option<((u8, usize, usize), PathBuf)> = None;

    for (dir_index, dir) in dirs.iter().enumerate() {
        for (name_index, name) in names.iter().enumerate() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                let priority = (
                    executable_candidate_group(command, name),
                    dir_index,
                    name_index,
                );
                if best
                    .as_ref()
                    .map(|(best_priority, _)| priority < *best_priority)
                    .unwrap_or(true)
                {
                    best = Some((priority, candidate));
                }
            }
        }
    }

    best.map(|(_, path)| path)
}

fn preferred_provider_dirs(provider_kind: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    match provider_kind {
        "claude" | "kimi" | "codebuddy" => {
            if let Some(app_data) = std::env::var_os("APPDATA") {
                push_unique_path(&mut dirs, PathBuf::from(app_data).join("npm"));
            }
        }
        "codex" => {
            if let Some(user_profile) =
                std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            {
                push_unique_path(
                    &mut dirs,
                    PathBuf::from(user_profile)
                        .join(".cherrystudio")
                        .join("install")
                        .join("global")
                        .join("node_modules")
                        .join("@openai")
                        .join("codex-win32-x64")
                        .join("vendor")
                        .join("x86_64-pc-windows-msvc")
                        .join("codex"),
                );
            }
        }
        "grok" => {
            if let Some(user_profile) =
                std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            {
                push_unique_path(
                    &mut dirs,
                    PathBuf::from(user_profile).join(".grok").join("bin"),
                );
            }
        }
        "opencode" => {
            if let Some(user_profile) =
                std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
            {
                push_unique_path(
                    &mut dirs,
                    PathBuf::from(user_profile)
                        .join(".cherrystudio")
                        .join("install")
                        .join("global")
                        .join("node_modules")
                        .join("opencode-windows-x64")
                        .join("bin"),
                );
            }
        }
        _ => {}
    }

    dirs
}

fn executable_names(command: &str) -> Vec<String> {
    let mut names = Vec::new();
    #[cfg(windows)]
    {
        for extension in ["exe", "cmd", "bat"] {
            push_unique(&mut names, format!("{}.{}", command, extension));
        }
        push_unique(&mut names, command.to_string());
    }
    #[cfg(not(windows))]
    {
        push_unique(&mut names, command.to_string());
    }
    names
}

fn executable_candidate_group(command: &str, name: &str) -> u8 {
    #[cfg(windows)]
    {
        if name.eq_ignore_ascii_case(command) {
            1
        } else {
            0
        }
    }
    #[cfg(not(windows))]
    {
        let _ = command;
        let _ = name;
        0
    }
}

fn detection_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    add_env_path_dirs(&mut dirs);
    add_common_cli_dirs(&mut dirs);
    dirs
}

fn add_env_path_dirs(dirs: &mut Vec<PathBuf>) {
    if let Some(path) = std::env::var_os("PATH").or_else(|| std::env::var_os("Path")) {
        for dir in std::env::split_paths(&path) {
            push_unique_path(dirs, dir);
        }
    }
}

fn add_common_cli_dirs(dirs: &mut Vec<PathBuf>) {
    add_superhigh_cli_dirs(dirs);

    if let Some(app_data) = std::env::var_os("APPDATA") {
        push_unique_path(dirs, PathBuf::from(app_data).join("npm"));
    }

    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local_app_data = PathBuf::from(local_app_data);
        push_unique_path(dirs, local_app_data.join("pnpm"));
        push_unique_path(dirs, local_app_data.join("Programs").join("nodejs"));
    }

    if let Some(user_profile) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))
    {
        add_user_cli_dirs(dirs, &PathBuf::from(user_profile));
    }
}

fn add_user_cli_dirs(dirs: &mut Vec<PathBuf>, user_profile: &Path) {
    push_unique_path(dirs, user_profile.join(".local").join("bin"));
    push_unique_path(dirs, user_profile.join(".bun").join("bin"));
    push_unique_path(dirs, user_profile.join(".cargo").join("bin"));
    push_unique_path(dirs, user_profile.join(".grok").join("bin"));
    push_unique_path(dirs, user_profile.join(".cherrystudio").join("bin"));
    push_unique_path(
        dirs,
        user_profile
            .join(".cherrystudio")
            .join("install")
            .join("global")
            .join("node_modules")
            .join(".bin"),
    );
    push_unique_path(
        dirs,
        user_profile
            .join(".cherrystudio")
            .join("install")
            .join("global")
            .join("node_modules")
            .join("@openai")
            .join("codex-win32-x64")
            .join("vendor")
            .join("x86_64-pc-windows-msvc")
            .join("codex"),
    );
    push_unique_path(
        dirs,
        user_profile
            .join(".cherrystudio")
            .join("install")
            .join("global")
            .join("node_modules")
            .join("opencode-windows-x64")
            .join("bin"),
    );
}

/// 把 `<root>/node_modules/.bin` 加入检测目录（若存在），让内置 npm 依赖的 CLI 可被发现。
fn add_node_modules_bin(dirs: &mut Vec<PathBuf>, root: &Path) {
    let bin = root.join("node_modules").join(".bin");
    if bin.is_dir() {
        push_unique_path(dirs, bin);
    }
}

fn add_superhigh_cli_dirs(dirs: &mut Vec<PathBuf>) {
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(mut dir) = current_exe.parent() {
            for _ in 0..6 {
                add_node_modules_bin(dirs, dir);
                match dir.parent() {
                    Some(parent) => dir = parent,
                    None => break,
                }
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        add_node_modules_bin(dirs, &cwd);
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            push_unique_path(dirs, parent.to_path_buf());
            if parent
                .file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("deps"))
                .unwrap_or(false)
            {
                if let Some(debug_dir) = parent.parent() {
                    push_unique_path(dirs, debug_dir.to_path_buf());
                }
            }
        }
    }
}

/// Locates a program in PATH plus the common CLI install directories (e.g. `~/.cargo/bin`).
pub fn find_program(command: &str) -> Option<PathBuf> {
    find_executable(command, &detection_dirs())
}

fn find_superhigh_cli_executable(dirs: &[PathBuf]) -> Option<PathBuf> {
    find_executable("superhigh-cli", dirs)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    let normalized = normalize_key(&path);
    if paths
        .iter()
        .any(|existing| normalize_key(existing) == normalized)
    {
        return;
    }
    paths.push(path);
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if values
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(&value))
    {
        return;
    }
    values.push(value);
}

fn normalize_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn normalize_display_path(path: &PathBuf) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn classify_cli_source(path: &Path) -> String {
    let key = normalize_key(path);
    if key.contains("/.cherrystudio/") {
        "Cherry Studio 全局安装".to_string()
    } else if key.contains("/.local/bin/") {
        "原生安装目录".to_string()
    } else if key.contains("/appdata/roaming/npm/") {
        "npm 全局目录".to_string()
    } else if key.contains("/appdata/local/pnpm/") {
        "pnpm 全局目录".to_string()
    } else if key.contains("/.bun/bin/") {
        "Bun 全局目录".to_string()
    } else if key.contains("/.cargo/bin/") {
        "Cargo bin".to_string()
    } else {
        "PATH".to_string()
    }
}

fn launcher_label(path: &Path) -> String {
    if needs_cmd_launcher(path) {
        format!(
            "cmd.exe /d /c call \"{}\"",
            normalize_display_path(&path.to_path_buf())
        )
    } else {
        normalize_display_path(&path.to_path_buf())
    }
}

fn launch_command_for_path(path: &str, provider_args: &[String]) -> (String, Vec<String>) {
    let path = PathBuf::from(path);
    if needs_cmd_launcher(&path) {
        let mut args = vec![
            "/d".to_string(),
            "/s".to_string(),
            "/c".to_string(),
            "call".to_string(),
            path.to_string_lossy().to_string(),
        ];
        args.extend(provider_args.iter().cloned());
        return ("cmd.exe".to_string(), args);
    }

    (path.to_string_lossy().to_string(), provider_args.to_vec())
}

fn needs_cmd_launcher(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| {
                extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

pub(crate) fn initial_prompt_input(provider_kind: &str, cwd: &Path, prompt: &str) -> anyhow::Result<String> {
    let prompt = prompt.trim();
    if provider_kind == "local" {
        return Ok(format!("{prompt}\r"));
    }
    let prompt_path = write_initial_prompt_file(cwd, prompt)?;
    let instruction = format!(
        "读取并执行这个任务文件：{}",
        prompt_path.to_string_lossy().replace('\\', "/")
    );
    Ok(instruction)
}

fn write_initial_prompt_file(cwd: &Path, prompt: &str) -> anyhow::Result<PathBuf> {
    let dir = cwd.join(".superhigh").join("terminal-prompts");
    fs::create_dir_all(&dir)
        .with_context(|| format!("create terminal prompt dir {}", dir.display()))?;
    let path = dir.join(format!("prompt-{}.md", Uuid::new_v4()));
    fs::write(&path, format!("{}\n", prompt.trim()))
        .with_context(|| format!("write terminal prompt {}", path.display()))?;
    Ok(path)
}

fn locate_codex_transcript(
    cwd: &Path,
    started_at: SystemTime,
) -> anyhow::Result<Option<NativeCliTranscript>> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Ok(None);
    };
    let sessions_root = PathBuf::from(home).join(".codex").join("sessions");
    locate_codex_transcript_in_root(&sessions_root, cwd, started_at)
}

fn locate_codex_transcript_in_root(
    sessions_root: &Path,
    cwd: &Path,
    started_at: SystemTime,
) -> anyhow::Result<Option<NativeCliTranscript>> {
    if !sessions_root.is_dir() {
        return Ok(None);
    }

    let mut candidates = Vec::new();
    collect_codex_session_files(sessions_root, &mut candidates)?;
    candidates.sort_by_key(|path| fs::metadata(path).and_then(|meta| meta.modified()).ok());
    candidates.reverse();

    // A JSONL may be created just before the PTY timestamp on fast machines, so allow
    // a narrow skew only; cwd must still match exactly.
    let earliest = started_at
        .checked_sub(Duration::from_secs(10))
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for path in candidates.into_iter().take(128) {
        let metadata = match fs::metadata(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata
            .modified()
            .ok()
            .map(|value| value < earliest)
            .unwrap_or(true)
        {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let Some(first_line) = raw.lines().next() else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(first_line) else {
            continue;
        };
        let payload = &value["payload"];
        let recorded_cwd = payload["cwd"].as_str().unwrap_or_default();
        let native_thread_id = payload["id"].as_str().unwrap_or_default();
        if recorded_cwd != cwd.to_string_lossy() || native_thread_id.is_empty() {
            continue;
        }
        return Ok(Some(NativeCliTranscript {
            provider: "codex".to_string(),
            native_thread_id: native_thread_id.to_string(),
            source_path: normalize_display_path(&path),
            transcript: extract_codex_learning_evidence(&raw),
        }));
    }
    Ok(None)
}

fn extract_codex_learning_evidence(raw: &str) -> String {
    const MAX_ENTRIES: usize = 180;
    const MAX_TEXT_CHARS: usize = 12_000;
    const MAX_TOTAL_CHARS: usize = 240_000;
    let mut entries = Vec::new();
    let mut total_chars = 0usize;
    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let outer_type = value["type"].as_str().unwrap_or_default();
        let payload = &value["payload"];
        let selected = match outer_type {
            "session_meta" => Some(format!(
                "[元数据] threadId={} cwd={} originator={} source={}",
                payload["id"].as_str().unwrap_or(""),
                payload["cwd"].as_str().unwrap_or(""),
                payload["originator"].as_str().unwrap_or(""),
                payload["thread_source"].as_str().unwrap_or(""),
            )),
            "response_item" if payload["type"].as_str() == Some("message") => {
                let role = payload["role"].as_str().unwrap_or_default();
                if role == "user" || role == "assistant" {
                    let text = payload["content"]
                        .as_array()
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| {
                                    item["text"]
                                        .as_str()
                                        .or_else(|| item["output_text"].as_str())
                                })
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    (!text.trim().is_empty()).then(|| format!("[{}] {}", role, text.trim()))
                } else {
                    None
                }
            }
            "response_item" if payload["type"].as_str() == Some("custom_tool_call") => {
                Some(format!(
                    "[工具调用:{}] {}",
                    payload["name"].as_str().unwrap_or("unknown"),
                    payload["input"].as_str().unwrap_or("").trim()
                ))
            }
            "event_msg" if payload["type"].as_str() == Some("item_completed") => {
                let item = &payload["item"];
                if item["type"].as_str() == Some("CommandExecution") {
                    Some(format!(
                        "[命令结果:{}] exitCode={} stdout={} stderr={}",
                        item["command"]
                            .as_array()
                            .map(|parts| parts
                                .iter()
                                .filter_map(|part| part.as_str())
                                .collect::<Vec<_>>()
                                .join(" "))
                            .unwrap_or_default(),
                        item["exit_code"]
                            .as_i64()
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "unknown".to_string()),
                        item["stdout"].as_str().unwrap_or("").trim(),
                        item["stderr"].as_str().unwrap_or("").trim(),
                    ))
                } else {
                    None
                }
            }
            _ => None,
        };
        if let Some(entry) = selected {
            let entry = truncate_learning_text(entry, MAX_TEXT_CHARS);
            let entry_len = entry.chars().count();
            if total_chars.saturating_add(entry_len) > MAX_TOTAL_CHARS {
                entries.push("…[结构化记录总量已截断]".to_string());
                break;
            }
            total_chars += entry_len;
            entries.push(entry);
            if entries.len() >= MAX_ENTRIES {
                break;
            }
        }
    }
    entries.join("\n\n")
}

fn truncate_learning_text(mut value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let cutoff = value
        .char_indices()
        .nth(max_chars)
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    value.truncate(cutoff);
    value.push_str("\n…[单项已截断]");
    value
}

fn collect_codex_session_files(dir: &Path, results: &mut Vec<PathBuf>) -> anyhow::Result<()> {
    for item in fs::read_dir(dir)? {
        let path = item?.path();
        if path.is_dir() {
            collect_codex_session_files(&path, results)?;
        } else if path.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
            results.push(path);
        }
    }
    Ok(())
}

fn joined_path_env(dirs: &[PathBuf]) -> Option<String> {
    let path = std::env::join_paths(dirs).ok()?;
    os_string_to_string(path)
}

fn os_string_to_string(value: OsString) -> Option<String> {
    Some(value.to_string_lossy().to_string())
}

pub type SharedTerminalManager = Arc<TerminalManager>;

#[cfg(test)]
mod tests {
    #[test]
    fn native_session_binding_replays_early_identity_and_rejects_stale_sources() {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let id = uuid::Uuid::new_v4().to_string();
        let binding = super::NativeSessionBinding { session_id: id.clone(), sessions: sessions.clone(), pending: Mutex::new(None) };
        binding.update("first".into());
        binding.update("latest".into());
        sessions.lock().unwrap().insert(id.clone(), super::TerminalSession {
            workspace_id: None,
            provider_kind: "codex".into(),
            title: "Codex".into(),
            cwd: PathBuf::from("."),
            started_at: SystemTime::now(),
            native_session_id: None,
            master: None,
            writer: None,
            child: None,
            output_buffer: Arc::new(Mutex::new(super::TerminalOutputBuffer::default())),
        });
        binding.bind_pending();
        assert_eq!(sessions.lock().unwrap()[&id].native_session_id.as_deref(), Some("latest"));
        assert!(super::claim_cli_source(&sessions, &id, &Some("latest".into()), &format!("{id}-old")));
        binding.update("next".into());
        assert!(super::claimed_cli_source(&id).is_none());
        assert!(!super::claim_cli_source(&sessions, &id, &Some("latest".into()), &format!("{id}-old")));
        assert!(super::claim_cli_source(&sessions, &id, &Some("next".into()), &format!("{id}-new")));
        binding.bind_pending();
        assert_eq!(sessions.lock().unwrap()[&id].native_session_id.as_deref(), Some("next"));
        super::CLAIMS.get_or_init(Default::default).lock().unwrap().remove(&id);
    }

    #[test]
    fn terminal_utf8_preserves_every_read_boundary() {
        let source = "\x1b[?2026h中文刷新：路径🎉\r\x1b[2K完成\x1b[?2026l";
        for split in 0..=source.len() {
            let mut pending = Vec::new();
            let mut text = super::decode_terminal_utf8_chunk(&mut pending, &source.as_bytes()[..split], false);
            text.push_str(&super::decode_terminal_utf8_chunk(&mut pending, &source.as_bytes()[split..], false));
            text.push_str(&super::decode_terminal_utf8_chunk(&mut pending, &[], true));
            assert_eq!(text, source, "split at byte {split}");
            assert!(pending.is_empty());
        }
        let mut pending = Vec::new();
        let mut text = String::new();
        for byte in source.bytes() {
            text.push_str(&super::decode_terminal_utf8_chunk(&mut pending, &[byte], false));
            assert!(pending.len() <= 3);
        }
        assert_eq!(text, source);
    }

    #[test]
    fn terminal_utf8_replaces_invalid_bytes_and_flushes_incomplete_eof() {
        let mut pending = Vec::new();
        assert_eq!(super::decode_terminal_utf8_chunk(&mut pending, b"ok\xff\xe4\xb8", false), "ok\u{fffd}");
        assert_eq!(super::decode_terminal_utf8_chunk(&mut pending, &[], true), "\u{fffd}");
        assert!(pending.is_empty());
        assert_eq!(super::decode_terminal_utf8_chunk(&mut pending, b"\xe4\xb8x", false), "\u{fffd}x");
    }

    #[test]
    fn service_log_preserves_split_utf8_and_gbk_lines() {
        let mut pending = Vec::new();
        let utf8 = "路径中文\n".as_bytes();
        let gbk = encoding_rs::GBK.encode("游戏正在启动，请稍候。\n").0.into_owned();
        assert!(super::decode_service_log_chunk(&mut pending, &utf8[..5], false).is_empty());
        assert_eq!(super::decode_service_log_chunk(&mut pending, &utf8[5..], false), "路径中文\n");
        assert!(super::decode_service_log_chunk(&mut pending, &gbk[..3], false).is_empty());
        assert_eq!(super::decode_service_log_chunk(&mut pending, &gbk[3..], false), "游戏正在启动，请稍候。\n");
        assert!(super::decode_service_log_chunk(&mut pending, b">", false).is_empty());
        assert_eq!(super::decode_service_log_chunk(&mut pending, b"", true), ">");
        assert!(pending.is_empty());
    }

    #[test]
    fn service_log_decodes_mixed_launcher_output_without_corrupting_utf8() {
        let mut bytes = "启动路径中文\n".as_bytes().to_vec();
        bytes.extend_from_slice(&encoding_rs::GBK.encode("游戏正在启动\r\n").0);
        bytes.extend_from_slice("[INFO] 加载完成\n".as_bytes());
        assert_eq!(super::decode_service_log_chunk(&mut Vec::new(), &bytes, true), "启动路径中文\n游戏正在启动\r\n[INFO] 加载完成\n");
    }

    use super::{
        add_node_modules_bin, args_for_provider, clear_inherited_agent_environment,
        configure_terminal_color_environment, external_cli_command_args, external_cmd_command_line,
        external_console_setup_prefix, find_executable,
        find_superhigh_cli_executable, finish_terminal_exit_session, initial_prompt_input,
        last_closed_sync_frame_end, launch_command_for_path, locate_codex_transcript_in_root,
        project_service_session_matches, resume_args_for_provider,
        split_pending_at_frame_boundary, split_pending_for_size_emit, CliLaunch,
        TerminalManager, TerminalOutputBuffer, TerminalSession,
        INHERITED_AGENT_VARIABLES, SYNC_OUTPUT_SET,
        TERMINAL_OUTPUT_EMIT_LIMIT_BYTES, TERMINAL_OUTPUT_SYNC_FRAME_FORCE_LIMIT_BYTES,
    };
    use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::{
        fs, io,
        path::{Path, PathBuf},
        time::{Duration, SystemTime},
    };

    #[test]
    fn sync_frame_boundary_split_keeps_unclosed_frames_together() {
        let bsu = "\u{1b}[?2026h";
        let esu = "\u{1b}[?2026l";
        // 一个完整帧 + 一个未闭合帧：只能切在最后一个 ESU 之后；
        // 帧外文本（world）与未闭合帧一起留给下一轮。
        let pending = format!("hello{bsu}frame1{esu}world{bsu}frame2-partial");
        let (emit_part, keep_part) = split_pending_at_frame_boundary(&pending);
        assert_eq!(emit_part, format!("hello{bsu}frame1{esu}"));
        assert_eq!(keep_part, format!("world{bsu}frame2-partial"));
        // 无同步标记：整段可发。
        let (emit_part, keep_part) = split_pending_at_frame_boundary("plain output");
        assert_eq!(emit_part, "plain output");
        assert!(keep_part.is_empty());
        // 一个完整帧 + 帧外文本：帧完整发出，帧外文本留给下一轮合并。
        let (emit_part, keep_part) = split_pending_at_frame_boundary(&format!("x{bsu}f{esu}y"));
        assert_eq!(emit_part, format!("x{bsu}f{esu}"));
        assert_eq!(keep_part, "y");
    }

    #[test]
    fn oversized_open_sync_frame_waits_for_more_output() {
        let pending = format!(
            "{SYNC_OUTPUT_SET}{}",
            "x".repeat(TERMINAL_OUTPUT_EMIT_LIMIT_BYTES)
        );
        assert!(pending.len() < TERMINAL_OUTPUT_SYNC_FRAME_FORCE_LIMIT_BYTES);

        assert!(split_pending_for_size_emit(&pending).is_none());

        let forced = format!(
            "{SYNC_OUTPUT_SET}{}",
            "x".repeat(TERMINAL_OUTPUT_SYNC_FRAME_FORCE_LIMIT_BYTES)
        );
        assert_eq!(split_pending_for_size_emit(&forced).unwrap().0, forced);
    }

    #[test]
    fn last_closed_sync_frame_end_finds_esu_boundary() {
        let bsu = "\u{1b}[?2026h";
        let esu = "\u{1b}[?2026l";
        // BSU/ESU 各 8 字节；闭合点落在 ESU 之后。
        assert_eq!(
            last_closed_sync_frame_end(&format!("{bsu}a{esu}")),
            Some(17)
        );
        assert_eq!(
            last_closed_sync_frame_end(&format!("{bsu}a{esu}{bsu}b")),
            Some(17)
        );
        assert_eq!(last_closed_sync_frame_end(&format!("{bsu}a")), None);
        assert_eq!(last_closed_sync_frame_end("no sync"), None);
        assert_eq!(
            last_closed_sync_frame_end(&format!("{bsu}a{esu}{bsu}b{esu}c")),
            Some(34)
        );
    }

    #[test]
    fn locate_codex_transcript_requires_matching_cwd_and_recent_file() {
        let directory = tempfile::tempdir().unwrap();
        let sessions = directory.path().join("2026").join("08").join("20");
        fs::create_dir_all(&sessions).unwrap();
        let matching = sessions.join("rollout-match.jsonl");
        fs::write(&matching, concat!(
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"native-match\",\"cwd\":\"D:\\\\Project\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"output_text\":\"verified\"}]}}\n"
        )).unwrap();
        let other = sessions.join("rollout-other.jsonl");
        fs::write(&other, "{\"type\":\"session_meta\",\"payload\":{\"id\":\"native-other\",\"cwd\":\"D:\\\\Other\"}}\n").unwrap();

        let transcript = locate_codex_transcript_in_root(
            directory.path(),
            Path::new("D:\\Project"),
            SystemTime::now(),
        )
        .unwrap()
        .expect("matching transcript");
        assert_eq!(transcript.native_thread_id, "native-match");
        assert!(transcript.source_path.ends_with("rollout-match.jsonl"));
        assert!(transcript.transcript.contains("verified"));
    }

    #[test]
    fn output_buffer_keeps_recent_bytes_and_offsets() {
        let mut buffer = TerminalOutputBuffer::default();

        buffer.append_with_limit("abc", 5);
        buffer.append_with_limit("def", 5);

        let snapshot = buffer.snapshot();
        assert_eq!(snapshot.buffer, "bcdef");
        assert_eq!(snapshot.start_byte, 1);
        assert_eq!(snapshot.end_byte, 6);
    }

    #[test]
    fn output_buffer_remembers_input_modes_after_history_is_trimmed() {
        let mut buffer = TerminalOutputBuffer::default();
        // Codex 经 ConPTY 一次性开启鼠标上报；序列可能被切在两段输出之间。
        buffer.append_with_limit("\x1b[?2004h\x1b[?2026h\x1b[?1003;10", 16);
        buffer.append_with_limit("06h\x1b[?1049h\x1b[?2026l", 16);
        buffer.append_with_limit(&"x".repeat(32), 16);
        let snapshot = buffer.snapshot();
        assert!(snapshot.start_byte > 0 && !snapshot.buffer.contains("1006"));
        assert_eq!(snapshot.modes, "\x1b[?1003h\x1b[?1006h\x1b[?2004h");

        buffer.append_with_limit("\x1b[?1003l\x1b", 16);
        buffer.append_with_limit("[?2004l", 16);
        assert_eq!(buffer.snapshot().modes, "\x1b[?1006h");
    }

    #[test]
    fn output_buffer_replays_size_marks_from_history_start() {
        let mark = |at_byte, cols, rows| super::TerminalSizeMark { at_byte, cols, rows };
        let mut buffer = TerminalOutputBuffer::default();
        buffer.append_with_limit("aaaa", 8);
        buffer.set_size(110, 36);
        buffer.set_size(100, 36);
        buffer.set_size(100, 36);
        buffer.append_with_limit("bbbb", 8);
        buffer.set_size(96, 30);
        // 同一偏移的多次 resize 只保留最后一次，重复尺寸不记录。
        assert_eq!(buffer.snapshot().sizes, vec![mark(0, 120, 32), mark(4, 100, 36), mark(8, 96, 30)]);

        buffer.append_with_limit("cc", 8);
        // 截断后首项是起点处生效的尺寸。
        assert_eq!(buffer.snapshot().start_byte, 2);
        assert_eq!(buffer.snapshot().sizes, vec![mark(0, 120, 32), mark(4, 100, 36), mark(8, 96, 30)]);
        assert_eq!(buffer.snapshot_since(Some(9)).sizes, vec![mark(8, 96, 30)]);
        buffer.append_with_limit("dddd", 8);
        assert_eq!(buffer.snapshot().sizes, vec![mark(4, 100, 36), mark(8, 96, 30)]);
        buffer.append_with_limit("eeeeeeee", 8);
        assert_eq!(buffer.snapshot().sizes, vec![mark(8, 96, 30)]);
    }

    #[test]
    fn mobile_terminal_incremental_buffer_preserves_utf8_and_eviction_resets() {
        let mut buffer = TerminalOutputBuffer::default();
        buffer.append_with_limit("old你好", 9);
        buffer.append_with_limit("!", 9);
        let full = buffer.snapshot();
        assert_eq!(full.buffer, "ld你好!");
        for cursor in [1, 3, 6, 9, 10] {
            let tail = buffer.snapshot_since(Some(cursor));
            assert_eq!(tail.buffer, &full.buffer[(cursor - full.start_byte) as usize..]);
            assert_eq!(tail.start_byte, cursor);
            assert_eq!(tail.end_byte, 10);
        }
        for invalid in [0, 4, 11] {
            let reset = buffer.snapshot_since(Some(invalid));
            assert_eq!(reset.buffer, full.buffer);
            assert_eq!(reset.start_byte, full.start_byte);
        }
    }

    #[cfg(windows)]
    #[test]
    fn mobile_terminal_snapshot_retains_desktop_size_after_exit() {
        let manager = TerminalManager::default();
        insert_test_session(&manager, "sized", None);
        manager.sessions.lock().unwrap().get_mut("sized").unwrap().master = test_master();
        let initial = manager.terminal_buffer("sized").unwrap();
        assert_eq!((initial.cols, initial.rows), (120, 32));
        manager.resize_session("sized", 173, 47).unwrap();
        super::release_terminal_session_handles(&manager.sessions, "sized");
        let final_snapshot = manager.terminal_buffer_since("sized", Some(0)).unwrap();
        assert_eq!((final_snapshot.cols, final_snapshot.rows), (173, 47));
    }

    #[test]
    fn embedded_cli_forces_truecolor_and_clears_no_color() {
        for (provider_kind, force_color) in [("codex", "3"), ("gemini", "1")] {
            let mut builder = CommandBuilder::new(provider_kind);
            builder.env("NO_COLOR", "1");

            configure_terminal_color_environment(&mut builder, provider_kind);

            assert_eq!(builder.get_env("TERM").unwrap(), "xterm-256color");
            assert_eq!(builder.get_env("COLORTERM").unwrap(), "truecolor");
            assert_eq!(builder.get_env("FORCE_COLOR").unwrap(), force_color);
            assert!(builder.get_env("NO_COLOR").is_none());
            if provider_kind == "codex" {
                assert_eq!(builder.get_env("CLICOLOR_FORCE").unwrap(), "1");
            }
        }
    }

    #[test]
    fn embedded_codex_disables_decorations_for_new_and_resumed_sessions() {
        for resume in [false, true] {
            let mut builder = CommandBuilder::new("codex");
            builder.args(args_for_provider("codex"));
            if resume {
                builder.args(resume_args_for_provider("codex", "session-id").unwrap());
            }
            let external_args = builder.get_argv().clone();
            super::configure_embedded_codex(&mut builder);
            let args = builder.get_argv();
            assert_eq!(&args[..external_args.len()], &external_args);
            assert_eq!(args[args.len() - 2], "-c");
            assert_eq!(args[args.len() - 1], "tui.whimsy=false");
            assert!(!external_args.iter().any(|arg| arg == "tui.whimsy=false"));
        }
    }

    #[test]
    fn output_buffer_trims_on_utf8_boundaries() {
        let mut buffer = TerminalOutputBuffer::default();

        buffer.append_with_limit("a你b你c", 4);

        let snapshot = buffer.snapshot();
        assert_eq!(snapshot.buffer, "你c");
        assert_eq!(snapshot.start_byte, 5);
        assert_eq!(snapshot.end_byte, 9);
    }

    #[test]
    fn close_session_view_detaches_agent_without_contacting_or_terminating_host() {
        let manager = TerminalManager::default();
        let id = "detached-agent";
        insert_test_session(&manager, id, Some("workspace-a"));
        let process = crate::service_console::current_identity().unwrap();
        let record = serde_json::from_value(serde_json::json!({
            "version": 1, "session": {"id":id,"title":"Test","providerKind":"codex","cwd":"."},
            "project":".", "started_at":SystemTime::now(), "process":process,
            "port":0, "token":"test-no-network"
        })).unwrap();
        manager.agent_hosts.lock().unwrap().insert(id.into(), Arc::new(crate::agent_host::Client { record }));
        manager.close_sessions_for_workspace("workspace-a").unwrap();
        assert!(crate::service_console::process_matches(process));
        assert!(!manager.agent_hosts.lock().unwrap().contains_key(id));
        assert!(!manager.sessions.lock().unwrap().contains_key(id));
        assert!(manager.detached_agent_hosts.lock().unwrap().contains(id));
    }

    #[test]
    fn close_sessions_for_workspace_only_closes_matching_workspace() {
        let manager = TerminalManager::default();
        insert_test_session(&manager, "a-1", Some("workspace-a"));
        insert_test_session(&manager, "a-2", Some("workspace-a"));
        insert_test_session(&manager, "b-1", Some("workspace-b"));
        insert_test_session(&manager, "global-1", None);

        manager
            .close_sessions_for_workspace("workspace-a")
            .expect("close workspace-a sessions");

        let sessions = manager.sessions.lock().unwrap();
        assert!(!sessions.contains_key("a-1"));
        assert!(!sessions.contains_key("a-2"));
        assert!(sessions.contains_key("b-1"));
        assert!(sessions.contains_key("global-1"));
    }

    #[test]
    fn close_sessions_for_workspace_can_close_each_workspace_independently() {
        let manager = TerminalManager::default();
        insert_test_session(&manager, "a-1", Some("workspace-a"));
        insert_test_session(&manager, "b-1", Some("workspace-b"));

        manager
            .close_sessions_for_workspace("workspace-b")
            .expect("close workspace-b sessions");

        {
            let sessions = manager.sessions.lock().unwrap();
            assert!(sessions.contains_key("a-1"));
            assert!(!sessions.contains_key("b-1"));
        }

        manager
            .close_sessions_for_workspace("workspace-a")
            .expect("close workspace-a sessions");

        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn close_all_sessions_removes_every_session() {
        let manager = TerminalManager::default();
        insert_test_session(&manager, "a-1", Some("workspace-a"));
        insert_test_session(&manager, "b-1", Some("workspace-b"));
        insert_test_session(&manager, "global-1", None);

        manager.close_all_sessions().expect("close all sessions");

        assert!(manager.sessions.lock().unwrap().is_empty());
    }

    #[test]
    fn close_session_releases_sessions_lock_before_killing_child() {
        let manager = TerminalManager::default();
        let sessions = Arc::clone(&manager.sessions);
        let sessions_lock_was_released = Arc::new(AtomicBool::new(false));
        manager.sessions.lock().unwrap().insert(
            "session-1".to_string(),
            TerminalSession {
                workspace_id: None,
                provider_kind: "test".to_string(),
                title: "test".to_string(),
                cwd: PathBuf::from("."),
                started_at: SystemTime::now(),
                native_session_id: None,
                master: None,
                writer: None,
                child: Some(Arc::new(Mutex::new(Box::new(LockCheckingChild {
                    sessions,
                    sessions_lock_was_released: Arc::clone(&sessions_lock_was_released),
                })))),
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );

        manager.close_session("session-1").expect("close session");

        assert!(sessions_lock_was_released.load(Ordering::SeqCst));
        assert!(!manager.sessions.lock().unwrap().contains_key("session-1"));
    }

    #[test]
    fn terminal_exit_cleanup_releases_handles_before_event_and_then_removes_session() {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert(
            "session-1".to_string(),
            TerminalSession {
                workspace_id: None,
                provider_kind: "test".to_string(),
                title: "test".to_string(),
                cwd: PathBuf::from("."),
                started_at: SystemTime::now(),
                native_session_id: None,
                master: test_master(),
                writer: Some(Arc::new(Mutex::new(Box::new(io::sink())))),
                child: Some(Arc::new(Mutex::new(Box::new(TestChild)))),
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );
        let emitted = Arc::new(Mutex::new(false));
        let emitted_for_event = Arc::clone(&emitted);

        finish_terminal_exit_session(&sessions, "session-1", Duration::ZERO, || {
            let sessions = sessions.lock().unwrap();
            let session = sessions
                .get("session-1")
                .expect("session kept for exit event");
            assert!(session.master.is_none());
            assert!(session.writer.is_none());
            assert!(session.child.is_none());
            *emitted_for_event.lock().unwrap() = true;
        });

        assert!(*emitted.lock().unwrap());
        assert!(!sessions.lock().unwrap().contains_key("session-1"));
    }

    #[cfg(windows)]
    #[test]
    fn live_session_ids_excludes_sessions_with_released_handles() {
        let manager = TerminalManager::default();
        insert_test_session(&manager, "ended", None);
        manager.sessions.lock().unwrap().insert(
            "live".to_string(),
            TerminalSession {
                workspace_id: None,
                provider_kind: "test".to_string(),
                title: "test".to_string(),
                cwd: PathBuf::from("."),
                started_at: SystemTime::now(),
                native_session_id: None,
                master: test_master(),
                writer: Some(Arc::new(Mutex::new(Box::new(io::sink())))),
                child: Some(Arc::new(Mutex::new(Box::new(TestChild)))),
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );

        assert_eq!(manager.live_session_ids(), vec!["live".to_string()]);
    }

    #[test]
    fn codex_external_handoff_quits_and_removes_the_internal_session() {
        let manager = TerminalManager::default();
        let written = Arc::new(Mutex::new(Vec::new()));
        let writer: Arc<Mutex<Box<dyn io::Write + Send>>> =
            Arc::new(Mutex::new(Box::new(RecordingWriter(Arc::clone(&written)))));
        let child: Arc<Mutex<Box<dyn Child + Send + Sync>>> =
            Arc::new(Mutex::new(Box::new(TestChild)));
        manager.sessions.lock().unwrap().insert(
            "codex-session".to_string(),
            TerminalSession {
                workspace_id: None,
                provider_kind: "codex".to_string(),
                title: "Codex".to_string(),
                cwd: PathBuf::from("."),
                started_at: SystemTime::now(),
                native_session_id: Some("native-session".to_string()),
                master: None,
                writer: Some(writer),
                child: Some(child),
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );

        manager
            .stop_codex_session_for_external_handoff("codex-session", Duration::from_millis(50))
            .expect("handoff should stop the embedded Codex session");

        assert_eq!(
            *written.lock().unwrap(),
            vec![b"/quit".to_vec(), b"\r".to_vec()]
        );
        assert!(!manager
            .sessions
            .lock()
            .unwrap()
            .contains_key("codex-session"));
    }

    #[test]
    fn codex_launch_bypasses_approvals_and_sandbox() {
        let args = args_for_provider("codex");

        assert_eq!(args, vec!["--dangerously-bypass-approvals-and-sandbox"]);
        assert!(!args.contains(&"--no-alt-screen"));
    }

    #[test]
    fn kimi_and_grok_launch_with_full_permissions() {
        assert_eq!(args_for_provider("kimi"), vec!["--auto"]);
        assert_eq!(
            args_for_provider("grok"),
            vec!["--always-approve", "--sandbox", "off"]
        );
    }

    #[test]
    fn native_session_resume_uses_each_cli_real_argv_shape() {
        assert_eq!(
            resume_args_for_provider("claude", "claude-id"),
            Some(vec!["--resume".to_string(), "claude-id".to_string()])
        );
        assert_eq!(
            resume_args_for_provider("codex", "codex-id"),
            Some(vec!["resume".to_string(), "codex-id".to_string()])
        );
        assert_eq!(
            resume_args_for_provider("kimi", "kimi-id"),
            Some(vec!["-S".to_string(), "kimi-id".to_string()])
        );
        assert_eq!(
            resume_args_for_provider("grok", "grok-id"),
            Some(vec!["--resume".to_string(), "grok-id".to_string()])
        );
        assert_eq!(
            resume_args_for_provider("gemini", "gemini-id"),
            Some(vec!["--resume".to_string(), "gemini-id".to_string()])
        );
        assert_eq!(
            resume_args_for_provider("opencode", "open-id"),
            Some(vec!["--session".to_string(), "open-id".to_string()])
        );
    }

    #[test]
    fn external_console_declares_colors_and_clears_inherited_terminal_identity() {
        let prefix = external_console_setup_prefix("codex");
        assert!(prefix.contains(r#"set "TERM=xterm-256color""#));
        assert!(prefix.contains(r#"set "COLORTERM=truecolor""#));
        assert!(prefix.contains(r#"set "FORCE_COLOR=""#));
        assert!(prefix.contains(r#"set "CLICOLOR_FORCE=""#));
        assert!(!external_console_setup_prefix("claude").contains("FORCE_COLOR"));
        assert!(prefix.contains(r#"set "NO_COLOR=""#));
        assert!(prefix.contains(r#"set "WT_SESSION=""#));
        assert!(prefix.contains(r#"set "TERM_PROGRAM=""#));
        assert!(prefix.contains(r#"set "VSCODE_INJECTION=""#));
        assert!(prefix.contains("chcp 65001"));
        for provider in super::CLI_PROVIDERS {
            let provider_kind = provider.kind;
            let prefix = external_console_setup_prefix(provider_kind);
            for key in INHERITED_AGENT_VARIABLES {
                assert!(prefix.contains(&format!(r#"set "{key}=""#)), "{provider_kind}: {key}");
            }
        }

        let command_line = external_cmd_command_line(
            "cmd.exe",
            r#"call "C:\Users\Test User\codex.cmd" "resume""#,
            "codex",
        );
        assert!(command_line.starts_with("\"cmd.exe\" /d /k "));
        assert!(command_line.contains(&prefix));
        assert!(command_line.contains(r#"call "C:\Users\Test User\codex.cmd" "resume""#));
    }

    #[cfg(windows)]
    #[test]
    fn external_console_setup_replaces_stale_color_environment_in_cmd() {
        use std::os::windows::process::CommandExt;

        for provider in super::CLI_PROVIDERS {
            let mut command = std::process::Command::new("cmd.exe");
            command.args(["/d", "/c"])
                .raw_arg(format!("{}set", external_console_setup_prefix(provider.kind)))
                .env("TERM", "dumb")
                .env("COLORTERM", "false")
                .env("FORCE_COLOR", "1")
                .env("CLICOLOR_FORCE", "1")
                .env("NO_COLOR", "1")
                .env("WT_SESSION", "SuperHigh")
                .env("TERM_PROGRAM", "SuperHigh")
                .env("CODEX_HOME", "configured-home")
                .env("ANTHROPIC_API_KEY", "configured-key")
                .env("ANTHROPIC_BASE_URL", "configured-proxy");
            for key in INHERITED_AGENT_VARIABLES {
                command.env(key, "parent-session");
            }
            let output = command.output().expect("run external console setup in cmd");
            assert!(output.status.success());
            let environment = String::from_utf8_lossy(&output.stdout);
            let variables: std::collections::HashMap<_, _> = environment
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(key, value)| (key.to_ascii_uppercase(), value))
                .collect();
            assert_eq!(variables.get("TERM"), Some(&"xterm-256color"));
            assert_eq!(variables.get("COLORTERM"), Some(&"truecolor"));
            assert_eq!(variables.get("CODEX_HOME"), Some(&"configured-home"));
            assert_eq!(variables.get("ANTHROPIC_API_KEY"), Some(&"configured-key"));
            assert_eq!(variables.get("ANTHROPIC_BASE_URL"), Some(&"configured-proxy"));
            for key in ["NO_COLOR", "WT_SESSION", "TERM_PROGRAM"]
                .into_iter().chain(INHERITED_AGENT_VARIABLES.iter().copied())
            {
                assert!(!variables.contains_key(key), "{}: {key}", provider.kind);
            }
            if provider.kind == "codex" {
                assert!(!variables.contains_key("FORCE_COLOR"));
                assert!(!variables.contains_key("CLICOLOR_FORCE"));
            }
        }
    }

    #[test]
    fn embedded_terminal_drops_inherited_agent_environment_and_keeps_configuration() {
        for provider in super::CLI_PROVIDERS {
            let mut builder = CommandBuilder::new(provider.command);
            for key in INHERITED_AGENT_VARIABLES {
                builder.env(key, "parent-session");
            }
            for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "HTTPS_PROXY"] {
                builder.env(key, "configured-value");
            }
            clear_inherited_agent_environment(&mut builder);
            for key in ["ANTHROPIC_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CODEX_THREAD_ID", "GEMINI_MODEL", "SUPERHIGH_SESSION_ID"]
                .into_iter().chain(INHERITED_AGENT_VARIABLES.iter().copied())
            {
                assert!(builder.get_env(key).is_none(), "{}: {key}", provider.kind);
            }
            for key in ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "HTTPS_PROXY"] {
                assert_eq!(builder.get_env(key), Some(std::ffi::OsStr::new("configured-value")));
            }
            builder.env("CLAUDE_CODE_SUBAGENT_MODEL", "explicit-session-model");
            assert_eq!(builder.get_env("CLAUDE_CODE_SUBAGENT_MODEL"), Some(std::ffi::OsStr::new("explicit-session-model")));
        }
    }

    #[test]
    fn external_cmd_launch_calls_codex_without_daemon_and_with_sandbox_bypass() {
        let launch = CliLaunch {
            program: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "call".to_string(),
                "C:/Users/Test User/AppData/Roaming/npm/codex.cmd".to_string(),
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
            ],
            title: "Codex".to_string(),
            path_env: None,
            superhigh_cli_path: None,
        };

        assert_eq!(
            external_cli_command_args(&launch, "codex"),
            vec![
                "call".to_string(),
                r"C:\Users\Test User\AppData\Roaming\npm\codex.cmd".to_string(),
                "--no-daemon".to_string(),
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
            ]
        );
    }

    #[test]
    fn external_cmd_launch_keeps_codex_resume_args_for_native_and_cmd_launchers() {
        let provider_args = args_for_provider("codex")
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        for executable in [r"C:\CLI Tools\codex.exe", r"C:\CLI Tools\codex.cmd"] {
            let (program, mut args) = launch_command_for_path(executable, &provider_args);
            args.extend(resume_args_for_provider("codex", "native-session").unwrap());
            let launch = CliLaunch {
                program,
                args,
                title: "Codex".to_string(),
                path_env: None,
                superhigh_cli_path: None,
            };
            assert_eq!(
                external_cli_command_args(&launch, "codex"),
                vec![
                    "call", executable, "--no-daemon",
                    "--dangerously-bypass-approvals-and-sandbox", "resume", "native-session",
                ]
            );
        }
    }

    #[test]
    fn external_cmd_launch_preserves_other_provider_args() {
        for provider_kind in ["claude", "kimi", "grok", "gemini", "local"] {
            let args = args_for_provider(provider_kind)
                .into_iter()
                .map(str::to_string)
                .collect::<Vec<_>>();
            let launch = CliLaunch {
                program: provider_kind.to_string(),
                args: args.clone(),
                title: provider_kind.to_string(),
                path_env: None,
                superhigh_cli_path: None,
            };
            let mut expected = vec!["call".to_string(), provider_kind.to_string()];
            expected.extend(args);
            assert_eq!(external_cli_command_args(&launch, provider_kind), expected);
        }
    }

    #[test]
    fn ai_initial_prompt_uses_short_prompt_file_reference() {
        let directory = tempfile::tempdir().unwrap();
        let input =
            initial_prompt_input("codex", directory.path(), "  first line\nsecond line  ").unwrap();

        assert!(input.starts_with("读取并执行这个任务文件："));
        assert!(input.contains(".superhigh/terminal-prompts/prompt-"));
        assert!(input.ends_with(".md"));
        assert!(!input.contains("\x1b[200~"));
        assert!(!input.contains("first line\nsecond line"));
        let prompts_dir = directory.path().join(".superhigh").join("terminal-prompts");
        let prompt_files = fs::read_dir(prompts_dir)
            .unwrap()
            .collect::<std::io::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(prompt_files.len(), 1);
        let prompt = fs::read_to_string(prompt_files[0].path()).unwrap();
        assert_eq!(prompt, "first line\nsecond line\n");
    }

    #[test]
    fn local_initial_prompt_uses_plain_enter_input() {
        let input = initial_prompt_input("local", Path::new("."), "  Get-Location  ").unwrap();

        assert_eq!(input, "Get-Location\r");
    }

    #[test]
    fn superhigh_cli_can_be_found_from_added_path_dirs() {
        let directory = tempfile::tempdir().unwrap();
        let file_name = if cfg!(windows) {
            "superhigh-cli.exe"
        } else {
            "superhigh-cli"
        };
        let cli_path = directory.path().join(file_name);
        fs::write(&cli_path, "").unwrap();

        let found = find_superhigh_cli_executable(&[directory.path().to_path_buf()]).unwrap();

        assert_eq!(found, cli_path);
    }

    #[test]
    fn node_modules_bin_is_added_when_present() {
        let directory = tempfile::tempdir().unwrap();
        let bin = directory.path().join("node_modules").join(".bin");
        fs::create_dir_all(&bin).unwrap();

        let mut dirs = Vec::new();
        add_node_modules_bin(&mut dirs, directory.path());

        assert_eq!(dirs, vec![bin]);
    }

    #[test]
    fn node_modules_bin_is_skipped_when_absent() {
        let directory = tempfile::tempdir().unwrap();

        let mut dirs = Vec::new();
        add_node_modules_bin(&mut dirs, directory.path());

        assert!(dirs.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn native_claude_is_detected_and_launches_without_path() {
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("原生 用户");
        let bin = profile.join(".local").join("bin");
        fs::create_dir_all(&bin).unwrap();
        let executable = bin.join("claude.exe");
        fs::write(&executable, "").unwrap();
        let mut dirs = Vec::new();
        super::add_user_cli_dirs(&mut dirs, &profile);
        let provider = super::CLI_PROVIDERS
            .iter()
            .find(|provider| provider.kind == "claude")
            .unwrap();

        let found = super::find_provider_executable_in(provider, &[], &dirs).unwrap();
        assert_eq!(found, executable);
        assert_eq!(super::classify_cli_source(&found), "原生安装目录");

        let (program, args) = launch_command_for_path(
            &found.to_string_lossy(),
            &["--version".to_string()],
        );
        assert_eq!(program, executable.to_string_lossy());
        assert_eq!(args, vec!["--version"]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_prefers_executable_suffixes_over_extensionless_shims() {
        let directory = tempfile::tempdir().unwrap();
        let shim = directory.path().join("claude");
        let cmd = directory.path().join("claude.cmd");
        fs::write(&shim, "").unwrap();
        fs::write(&cmd, "").unwrap();

        let found = find_executable("claude", &[directory.path().to_path_buf()]).unwrap();

        assert_eq!(found, cmd);
    }

    #[cfg(windows)]
    #[test]
    fn windows_respects_directory_order_for_extensioned_launchers() {
        let npm_directory = tempfile::tempdir().unwrap();
        let cherry_directory = tempfile::tempdir().unwrap();
        let cmd = npm_directory.path().join("claude.cmd");
        let exe = cherry_directory.path().join("claude.exe");
        fs::write(&cmd, "").unwrap();
        fs::write(&exe, "").unwrap();

        let found = find_executable(
            "claude",
            &[
                npm_directory.path().to_path_buf(),
                cherry_directory.path().to_path_buf(),
            ],
        )
        .unwrap();

        assert_eq!(found, cmd);
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_extensionless_shims_only_as_last_resort() {
        let shim_directory = tempfile::tempdir().unwrap();
        let exe_directory = tempfile::tempdir().unwrap();
        let shim = shim_directory.path().join("claude");
        let exe = exe_directory.path().join("claude.exe");
        fs::write(&shim, "").unwrap();
        fs::write(&exe, "").unwrap();

        let found = find_executable(
            "claude",
            &[
                shim_directory.path().to_path_buf(),
                exe_directory.path().to_path_buf(),
            ],
        )
        .unwrap();

        assert_eq!(found, exe);
    }

    #[cfg(windows)]
    #[test]
    fn windows_cmd_shims_launch_through_cmd_call() {
        let script_path = "C:/Users/ExampleUser01/AppData/Roaming/npm/claude.cmd";
        let (program, args) = launch_command_for_path(script_path, &["--version".to_string()]);

        assert_eq!(program, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "call".to_string(),
                script_path.to_string(),
                "--version".to_string(),
            ]
        );
        assert!(args.iter().all(|arg| !arg.contains("\\\"")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_batch_startup_scripts_launch_through_cmd_call() {
        let script_path = r"D:\示例项目\示例项目目录名服务端\天灾服务端开启.bat";
        let (program, args) = launch_command_for_path(script_path, &[]);

        assert_eq!(program, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "call".to_string(),
                script_path.to_string(),
            ]
        );
        assert!(args.iter().all(|arg| !arg.contains("\\\"")));
    }

    fn insert_test_session(
        manager: &TerminalManager,
        session_id: &str,
        workspace_id: Option<&str>,
    ) {
        manager.sessions.lock().unwrap().insert(
            session_id.to_string(),
            TerminalSession {
                workspace_id: workspace_id.map(str::to_string),
                provider_kind: "test".to_string(),
                title: "test".to_string(),
                cwd: PathBuf::from("."),
                started_at: SystemTime::now(),
                native_session_id: None,
                master: None,
                writer: None,
                child: None,
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );
    }

    #[test]
    fn update_install_blocks_live_children_but_ignores_exited_or_released_sessions() {
        let manager = TerminalManager::default();
        insert_test_session(&manager, "released", None);
        insert_test_session(&manager, "exited", None);
        insert_test_session(&manager, "live", None);
        {
            let mut sessions = manager.sessions.lock().unwrap();
            sessions.get_mut("exited").unwrap().child = Some(Arc::new(Mutex::new(Box::new(TestChild))));
            sessions.get_mut("live").unwrap().child = Some(Arc::new(Mutex::new(Box::new(LiveUpdateChild))));
        }
        let blocking = manager.update_blocking_sessions().unwrap();
        let inspected = manager.inspect_sessions(None).unwrap();
        assert_eq!(
            inspected
                .iter()
                .filter(|session| session.running)
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec!["live"]
        );
        assert!(
            inspected
                .iter()
                .find(|session| session.id == "live")
                .unwrap()
                .holds_pty_child
        );
        assert!(
            !inspected
                .iter()
                .find(|session| session.id == "released")
                .unwrap()
                .holds_pty_child
        );
        assert_eq!(blocking.len(), 1);
        assert_eq!(blocking[0].id, "live");
        assert!(manager.install_update_when_idle(|| panic!("must not install with live PTY")).is_err());
        assert!(manager.lock_session_creation().is_ok());
        manager.sessions.lock().unwrap().remove("live");
        assert!(manager.update_blocking_sessions().unwrap().is_empty());
        manager.install_update_when_idle(|| Ok(())).unwrap();
        assert!(manager.lock_session_creation().is_err());
    }

    #[test]
    fn update_install_failure_reopens_creation_and_install_holds_creation_gate() {
        let manager = TerminalManager::default();
        let error = manager.install_update_when_idle(|| {
            assert!(manager.update_installing.try_lock().is_err());
            anyhow::bail!("installer failed")
        }).unwrap_err();
        assert_eq!(error.to_string(), "installer failed");
        assert!(manager.lock_session_creation().is_ok());
        manager.install_update_when_idle(|| Ok(())).unwrap();
    }

    #[derive(Debug)]
    struct LiveUpdateChild;

    impl ChildKiller for LiveUpdateChild {
        fn kill(&mut self) -> io::Result<()> { Ok(()) }
        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> { Box::new(Self) }
    }

    impl Child for LiveUpdateChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> { Ok(None) }
        fn wait(&mut self) -> io::Result<ExitStatus> { Ok(ExitStatus::with_exit_code(0)) }
        fn process_id(&self) -> Option<u32> { None }
        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> { None }
    }

    #[test]
    fn project_service_session_selection_requires_kind_title_and_directory() {
        let cwd = PathBuf::from("D:/server");
        assert!(project_service_session_matches(
            "project-service",
            "Server",
            &cwd,
            "Server",
            &cwd,
        ));
        assert!(!project_service_session_matches(
            "project-startup",
            "Server",
            &cwd,
            "Server",
            &cwd,
        ));
        assert!(!project_service_session_matches(
            "project-service",
            "Other",
            &cwd,
            "Server",
            &cwd,
        ));
    }

    #[cfg(windows)]
    fn test_master() -> Option<Arc<Mutex<Box<dyn MasterPty + Send>>>> {
        Some(Arc::new(Mutex::new(Box::new(TestMasterPty))))
    }

    #[cfg(not(windows))]
    fn test_master() -> Option<Arc<Mutex<Box<dyn MasterPty + Send>>>> {
        None
    }

    #[cfg(windows)]
    #[derive(Debug)]
    struct TestMasterPty;

    #[cfg(windows)]
    impl MasterPty for TestMasterPty {
        fn resize(&self, _size: PtySize) -> anyhow::Result<()> {
            Ok(())
        }

        fn get_size(&self) -> anyhow::Result<PtySize> {
            Ok(PtySize::default())
        }

        fn try_clone_reader(&self) -> anyhow::Result<Box<dyn io::Read + Send>> {
            Ok(Box::new(io::empty()))
        }

        fn take_writer(&self) -> anyhow::Result<Box<dyn io::Write + Send>> {
            Ok(Box::new(io::sink()))
        }
    }

    #[derive(Debug)]
    struct RecordingWriter(Arc<Mutex<Vec<Vec<u8>>>>);

    impl io::Write for RecordingWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().push(buffer.to_vec());
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Debug)]
    struct TestChild;

    struct LockCheckingChild {
        sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
        sessions_lock_was_released: Arc<AtomicBool>,
    }

    impl std::fmt::Debug for LockCheckingChild {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("LockCheckingChild")
        }
    }

    impl ChildKiller for LockCheckingChild {
        fn kill(&mut self) -> io::Result<()> {
            self.sessions_lock_was_released
                .store(self.sessions.try_lock().is_ok(), Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(LockCheckingChild {
                sessions: Arc::clone(&self.sessions),
                sessions_lock_was_released: Arc::clone(&self.sessions_lock_was_released),
            })
        }
    }

    impl Child for LockCheckingChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(Some(ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    impl ChildKiller for TestChild {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(TestChild)
        }
    }

    impl Child for TestChild {
        fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
            Ok(Some(ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> io::Result<ExitStatus> {
            Ok(ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }
}
