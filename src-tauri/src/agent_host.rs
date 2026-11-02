//! A session host owns the PTY and provider connections independently of the desktop.
use std::{
    collections::{HashMap, VecDeque}, fs,
    io::{BufRead, BufReader, Read, Write}, net::{TcpListener, TcpStream},
    path::{Path, PathBuf}, process::{Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, thread, time::{Duration, Instant, SystemTime},
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{cli_completion::CompletionNotice, models::{TerminalBufferSnapshot, TerminalSessionDto},
    service_console::{current_identity, process_matches, ProcessIdentity},
    terminal::{CliLaunch, TerminalEvents, TerminalInspection, TerminalManager}};

const VERSION: u32 = 1;
const MAX_MESSAGE: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
pub(crate) struct Launch {
    pub session: TerminalSessionDto,
    pub workspace_id: Option<String>,
    pub project: PathBuf,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub initial_input: Option<String>,
    pub native_session_id: Option<String>,
    pub launch: CliLaunch,
    pub data_dir: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Record {
    pub version: u32,
    pub session: TerminalSessionDto,
    pub project: PathBuf,
    pub started_at: SystemTime,
    pub process: ProcessIdentity,
    pub port: u16,
    token: String,
}

#[derive(Clone)]
pub(crate) struct Client { pub record: Record }

pub(crate) struct Connection { reader: BufReader<TcpStream>, token: String }

impl Client {
    pub fn request<T: serde::de::DeserializeOwned>(&self, operation: &str, params: Value) -> Result<T> {
        self.connect()?.request(operation, params)
    }

    pub fn connect(&self) -> Result<Connection> {
        anyhow::ensure!(process_matches(self.record.process), "Agent 会话宿主已退出");
        let stream = TcpStream::connect_timeout(&([127, 0, 0, 1], self.record.port).into(), Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(12)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        Ok(Connection { reader: BufReader::new(stream), token: self.record.token.clone() })
    }

    pub fn terminate(&self) -> Result<()> {
        if !process_matches(self.record.process) { return Ok(()); }
        let _: Value = match self.request("terminate", Value::Null) {
            Ok(result) => result,
            Err(_) if !process_matches(self.record.process) => return Ok(()),
            Err(error) => return Err(error),
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while process_matches(self.record.process) && Instant::now() < deadline { thread::sleep(Duration::from_millis(25)); }
        anyhow::ensure!(!process_matches(self.record.process), "Agent 会话宿主尚未退出");
        Ok(())
    }
}

impl Connection {
    pub fn request<T: serde::de::DeserializeOwned>(&mut self, operation: &str, params: Value) -> Result<T> {
        let mut stream = self.reader.get_mut();
        serde_json::to_writer(&mut stream, &json!({"token":self.token,"operation":operation,"params":params}))?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        self.reader.by_ref().take(MAX_MESSAGE).read_line(&mut line)?;
        let response: Value = serde_json::from_str(&line).context("Agent 会话宿主响应不完整")?;
        anyhow::ensure!(response["ok"] == true, "{}", response["error"].as_str().unwrap_or("Agent 会话宿主请求失败"));
        Ok(serde_json::from_value(response["result"].clone())?)
    }

}

#[derive(Default)]
pub(crate) struct Notices { sequence: u64, acknowledged: u64, entries: VecDeque<(u64, CompletionNotice)> }
impl Notices {
    pub fn push(&mut self, notice: CompletionNotice) {
        self.sequence += 1;
        self.entries.push_back((self.sequence, notice));
        while self.entries.len() > 32 { self.entries.pop_front(); }
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Poll {
    pub snapshot: TerminalBufferSnapshot,
    pub native_session_id: Option<String>,
    pub source: Option<String>,
    pub chat_source: Option<String>,
    pub inspection: TerminalInspection,
    pub notices: Vec<(u64, CompletionNotice)>,
    pub notice_cursor: u64,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct AgentView {
    pub model: String,
    pub agents: Vec<crate::codex_agents::ChatAgent>,
    pub error: Option<String>,
}

pub(crate) fn existing(data_dir: &Path) -> Vec<Client> {
    let Ok(entries) = fs::read_dir(data_dir.join("agent-hosts")) else { return Vec::new() };
    entries.filter_map(|entry| {
        let bytes = fs::read(entry.ok()?.path().join("state.json")).ok()?;
        let record: Record = serde_json::from_slice(&bytes).ok()?;
        (record.version == VERSION && process_matches(record.process)).then_some(Client { record })
    }).collect()
}

pub(crate) fn executable(data_dir: &Path) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let source = std::env::current_exe()?.with_file_name("superhigh-cli.exe");
    let bytes = fs::read(&source).context("找不到 Agent 会话宿主启动程序")?;
    let cache = data_dir.join("cache").join("agent-host");
    fs::create_dir_all(&cache)?;
    let target = cache.join(format!("{:x}.exe", Sha256::digest(&bytes)));
    if !target.exists() {
        let mut temporary = tempfile::NamedTempFile::new_in(&cache)?;
        temporary.write_all(&bytes)?;
        if let Err(error) = temporary.persist_noclobber(&target) {
            if !target.exists() { return Err(error.error.into()); }
        }
    }
    Ok(target)
}

pub(crate) fn start(mut spec: Launch) -> Result<Client> {
    let directory = spec.data_dir.join("agent-hosts").join(&spec.session.id);
    fs::create_dir_all(&directory)?;
    let helper = executable(&spec.data_dir)?;
    // Hooks and MCP helpers must survive replacement of the desktop installation too.
    spec.launch.superhigh_cli_path = Some(helper.to_string_lossy().into_owned());
    let mut command = Command::new(&helper);
    command.arg("__agent-host").arg(&directory).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().context("无法启动独立 Agent 会话宿主")?;
    let result = (|| -> Result<Client> {
        let mut input = child.stdin.take().context("Agent 宿主输入不可用")?;
        serde_json::to_writer(&mut input, &spec)?;
        drop(input);
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(bytes) = fs::read(directory.join("state.json")) {
                let record: Record = serde_json::from_slice(&bytes)?;
                let client = Client { record };
                let _: Value = client.request("ready", Value::Null)?;
                return Ok(client);
            }
            if let Ok(error) = fs::read_to_string(directory.join("error.txt")) { anyhow::bail!("{error}") }
            anyhow::ensure!(child.try_wait()?.is_none(), "Agent 会话宿主在启动时退出");
            anyhow::ensure!(Instant::now() < deadline, "等待 Agent 会话宿主启动超时");
            thread::sleep(Duration::from_millis(25));
        }
    })();
    if result.is_err() {
        crate::process_tree::kill_std_child_tree(&mut child);
        let _ = child.wait();
    }
    result
}

pub fn worker_from_env() -> i32 {
    let directory = std::env::args_os().nth(2).map(PathBuf::from).unwrap_or_default();
    match run_worker(&directory) {
        Ok(()) => 0,
        Err(error) => { let _ = fs::write(directory.join("error.txt"), format!("{error:#}")); 1 }
    }
}

fn run_worker(directory: &Path) -> Result<()> {
    let spec: Launch = serde_json::from_reader(std::io::stdin().take(MAX_MESSAGE))?;
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let record = Record { version: VERSION, session: spec.session.clone(), project: spec.project,
        started_at: SystemTime::now(), process: current_identity()?, port: listener.local_addr()?.port(),
        token: uuid::Uuid::new_v4().to_string() };
    let manager = Arc::new(TerminalManager::with_data_dir(spec.data_dir));
    let notices = Arc::new(Mutex::new(Notices::default()));
    manager.create_owned_session(&TerminalEvents::Host(notices.clone()), spec.workspace_id,
        &spec.session.provider_kind, &spec.cwd, spec.env, spec.initial_input, spec.native_session_id,
        Some(spec.session.id.clone()), spec.launch)?;
    fs::write(directory.join("state.pending"), serde_json::to_vec(&record)?)?;
    fs::rename(directory.join("state.pending"), directory.join("state.json"))?;
    let mut finished_at = None;
    let stopping = Arc::new(AtomicBool::new(false));
    loop {
        if stopping.load(Ordering::Acquire) { break; }
        let running = manager.inspect_sessions(None)?.iter().any(|session| session.running);
        if running { finished_at = None; }
        else if finished_at.get_or_insert_with(Instant::now).elapsed() > Duration::from_secs(8) { break; }
        match listener.accept() {
            Ok((stream, _)) => {
                let manager = manager.clone(); let notices = notices.clone(); let record = record.clone(); let stopping = stopping.clone();
                thread::spawn(move || { let _ = serve(stream, &record, &manager, &notices, &stopping); });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
            Err(error) => return Err(error.into()),
        }
    }
    let _ = fs::remove_file(directory.join("state.json"));
    let _ = fs::remove_dir(directory);
    Ok(())
}

fn serve(mut stream: TcpStream, record: &Record, manager: &TerminalManager, notices: &Mutex<Notices>, stopping: &AtomicBool) -> Result<()> {
    // Accepted sockets inherit the listener's non-blocking mode on Windows.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    loop {
    let mut line = String::new();
    if reader.by_ref().take(MAX_MESSAGE).read_line(&mut line)? == 0 { return Ok(()); }
    let mut terminate = false;
    let result = (|| -> Result<Value> {
        let request: Value = serde_json::from_str(&line)?;
        anyhow::ensure!(request["token"].as_str() == Some(&record.token), "Agent 宿主标识不匹配");
        let params = &request["params"];
        let id = &record.session.id;
        match request["operation"].as_str().unwrap_or_default() {
            "ready" => Ok(Value::Null),
            "status" => Ok(serde_json::to_value(manager.inspect_sessions(None)?.into_iter().find(|session| &session.id == id))?),
            "poll" => {
                let inspection = manager.inspect_sessions(None)?.into_iter().find(|session| &session.id == id)
                    .unwrap_or(TerminalInspection { id: id.clone(), workspace_id: None, provider_kind: record.session.provider_kind.clone(),
                        title: record.session.title.clone(), cwd: record.session.cwd.clone(), holds_pty_child: false, running: false, process_id: None });
                let context = manager.session_chat_context(id);
                let native_session_id = context.as_ref().and_then(|(_, _, native)| native.clone());
                let source = crate::terminal::claimed_cli_source(id);
                let chat_source = context.as_ref().and_then(|(cwd, started, native)| crate::terminal::chat_source(id, &record.session.provider_kind, cwd, *started, native.as_deref()).ok().flatten());
                let snapshot = manager.terminal_buffer_since(id, params["after"].as_u64())
                    .unwrap_or(TerminalBufferSnapshot { buffer: String::new(), start_byte: 0, end_byte: 0, cols: 120, rows: 32, modes: String::new(), sizes: Vec::new() });
                let mut queue = notices.lock().unwrap();
                if let Some(ack) = params["notice"].as_u64() { queue.acknowledged = queue.acknowledged.max(ack.min(queue.sequence)); }
                let after_notice = params["notice"].as_u64().unwrap_or(queue.acknowledged);
                let notice_cursor = queue.sequence;
                let candidates = queue.entries.iter().cloned().collect::<Vec<_>>();
                drop(queue);
                let reconnecting = params["notice"].is_null();
                let pending_notices = candidates.into_iter().filter(|(seq, notice)| {
                    *seq > after_notice || (reconnecting && notice.plan_request.as_ref().is_some_and(|plan|
                        manager.pending_plan(id, plan.connection, &plan.request_id).is_some()))
                }).collect();
                Ok(serde_json::to_value(Poll { snapshot,
                    native_session_id, source, chat_source, inspection,
                    notices: pending_notices, notice_cursor })?)
            }
            "buffer" => Ok(serde_json::to_value(manager.terminal_buffer_since(id, params["after"].as_u64())?)?),
            "input" => { manager.write_input(id, params["input"].as_str().context("缺少输入")?)?; Ok(Value::Null) }
            "resize" => { manager.resize_session_with(id, params["cols"].as_u64().unwrap_or(120) as u16, params["rows"].as_u64().unwrap_or(32) as u16, params["force"] == true)?; Ok(Value::Null) }
            "pending_plan" => Ok(serde_json::to_value(manager.pending_plan(id, params["connection"].as_u64().unwrap_or(0), &params["requestId"]))?),
            "reply_plan" => { manager.reply_plan(id, params["connection"].as_u64().unwrap_or(0), params["requestId"].clone(), serde_json::from_value(params["answers"].clone())?)?; Ok(Value::Null) }
            "chat_controls" => crate::local_chat_controls(manager, id),
            "agents" => Ok(serde_json::to_value(manager.agent_view_data(id, params["root"].as_str(), &serde_json::from_value(params["calls"].clone())?, &serde_json::from_value::<Vec<Value>>(params["links"].clone())?)?)?),
            "handoff" => { manager.stop_codex_session_for_external_handoff(id, Duration::from_secs(10))?; Ok(Value::Null) }
            "terminate" => { manager.close_session(id)?; terminate = true; Ok(Value::Null) }
            _ => anyhow::bail!("未知 Agent 宿主操作"),
        }
    })();
    let response = match result { Ok(value) => json!({"ok":true,"result":value}), Err(error) => json!({"ok":false,"error":format!("{error:#}")}) };
    serde_json::to_writer(&mut stream, &response)?;
    stream.write_all(b"\n")?;
    if terminate { stopping.store(true, Ordering::Release); return Ok(()); }
    }
}
