use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::Context;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{
    CliProviderEnvironment, SshConnectionConfig, TerminalBufferSnapshot, TerminalExitEvent,
    TerminalOutputEvent, TerminalSessionDto,
};
use crate::process_tree::kill_pty_child_tree;

struct TerminalSession {
    #[allow(dead_code)]
    workspace_id: Option<String>,
    master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    writer: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    child: Option<Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>>,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
}

struct CliProviderDefinition {
    kind: &'static str,
    name: &'static str,
    command: &'static str,
}

struct CliLaunch {
    program: String,
    args: Vec<String>,
    title: String,
    path_env: Option<String>,
    superhigh_cli_path: Option<String>,
}

#[derive(Default)]
struct TerminalOutputBuffer {
    chunks: VecDeque<String>,
    len_bytes: usize,
    start_byte: u64,
    end_byte: u64,
}

struct PendingTerminalOutput {
    chunk: String,
    start_byte: u64,
    end_byte: u64,
}

const TERMINAL_OUTPUT_HISTORY_LIMIT_BYTES: usize = 256 * 1024;
const TERMINAL_OUTPUT_EMIT_INTERVAL_MS: u64 = 50;
const TERMINAL_OUTPUT_EMIT_LIMIT_BYTES: usize = 64 * 1024;
const TERMINAL_OUTPUT_CHANNEL_CAPACITY: usize = 64;
// Exit handlers read the final buffer immediately after terminal-exit.
const TERMINAL_EXIT_SESSION_REMOVAL_GRACE_MS: u64 = 5_000;
const AI_INITIAL_PROMPT_READY_DELAY_MS: u64 = 800;
const AI_INITIAL_PROMPT_SUBMIT_DELAY_MS: u64 = 150;

const CLI_PROVIDERS: [CliProviderDefinition; 6] = [
    CliProviderDefinition {
        kind: "claude",
        name: "Claude Code",
        command: "claude",
    },
    CliProviderDefinition {
        kind: "codex",
        name: "Codex CLI",
        command: "codex",
    },
    CliProviderDefinition {
        kind: "kimi",
        name: "Kimi Code CLI",
        command: "kimi",
    },
    CliProviderDefinition {
        kind: "grok",
        name: "Grok Build CLI",
        command: "grok",
    },
    CliProviderDefinition {
        kind: "gemini",
        name: "Gemini CLI",
        command: "gemini",
    },
    CliProviderDefinition {
        kind: "opencode",
        name: "OpenCode",
        command: "opencode",
    },
];

impl TerminalManager {
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
            launch,
        )
    }

    pub fn create_script_session_for_workspace(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        title: &str,
        script_path: &Path,
        cwd: &Path,
    ) -> anyhow::Result<TerminalSessionDto> {
        let dirs = detection_dirs();
        let path_env = joined_path_env(&dirs);
        let superhigh_cli_path =
            find_superhigh_cli_executable(&dirs).map(|path| normalize_display_path(&path));
        let (program, args) = launch_command_for_path(&script_path.to_string_lossy(), &[]);

        self.create_session_from_launch(
            app,
            workspace_id,
            provider_kind,
            cwd,
            HashMap::new(),
            None,
            CliLaunch {
                program,
                args,
                title: title.to_string(),
                path_env,
                superhigh_cli_path,
            },
        )
    }

    pub fn create_command_session_for_workspace(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        title: &str,
        command_path: &Path,
        args: &[String],
        cwd: &Path,
    ) -> anyhow::Result<TerminalSessionDto> {
        let dirs = detection_dirs();
        let path_env = joined_path_env(&dirs);
        let superhigh_cli_path =
            find_superhigh_cli_executable(&dirs).map(|path| normalize_display_path(&path));

        self.create_session_from_launch(
            app,
            workspace_id,
            provider_kind,
            cwd,
            HashMap::new(),
            None,
            CliLaunch {
                program: command_path.to_string_lossy().to_string(),
                args: args.to_vec(),
                title: title.to_string(),
                path_env,
                superhigh_cli_path,
            },
        )
    }

    fn create_session_from_launch(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        provider_kind: &str,
        cwd: &Path,
        env: HashMap<String, String>,
        initial_input: Option<String>,
        launch: CliLaunch,
    ) -> anyhow::Result<TerminalSessionDto> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut builder = CommandBuilder::new(launch.program.as_str());
        builder.cwd(cwd);
        for arg in &launch.args {
            builder.arg(arg);
        }
        if let Some(path_env) = &launch.path_env {
            builder.env("PATH", path_env);
            builder.env("Path", path_env);
        }
        if let Some(superhigh_cli_path) = &launch.superhigh_cli_path {
            builder.env("SUPERHIGH_CLI", superhigh_cli_path);
        }
        if provider_kind == "codex" {
            builder.env_remove("CODEX_THREAD_ID");
            builder.env_remove("CODEX_MANAGED_BY_NPM");
            builder.env_remove("CODEX_MANAGED_BY_BUN");
        }
        for (key, value) in env {
            builder.env(key, value);
        }
        configure_terminal_color_environment(&mut builder, provider_kind);

        let child =
            Arc::new(Mutex::new(pair.slave.spawn_command(builder).with_context(
                || format!("failed to spawn terminal {}", launch.program),
            )?));
        let master = Arc::new(Mutex::new(pair.master));
        let reader = master.lock().unwrap().try_clone_reader()?;
        let writer = Arc::new(Mutex::new(master.lock().unwrap().take_writer()?));
        let session_id = Uuid::new_v4().to_string();
        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::default()));

        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            TerminalSession {
                workspace_id,
                master: Some(master),
                writer: Some(writer),
                child: Some(Arc::clone(&child)),
                output_buffer: Arc::clone(&output_buffer),
            },
        );
        spawn_terminal_background_tasks(
            app,
            Arc::clone(&self.sessions),
            session_id.clone(),
            child,
            reader,
            output_buffer,
        );

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
        })
    }

    pub fn create_ssh_session(
        &self,
        app: &AppHandle,
        workspace_id: Option<String>,
        config: &SshConnectionConfig,
        cwd: &Path,
    ) -> anyhow::Result<TerminalSessionDto> {
        let ssh_args: Vec<String> = vec![
            config.username.clone(),
            config.host.clone(),
            "-p".to_string(),
            config.port.to_string(),
        ]
        .into_iter()
        .chain(
            config
                .extra_args
                .split_whitespace()
                .map(str::to_string)
                .filter(|a| !a.is_empty()),
        )
        .collect();

        let title = format!("SSH: {}@{}", config.username, config.host);

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 32,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut builder = CommandBuilder::new("ssh");
        builder.cwd(cwd);
        for arg in &ssh_args {
            builder.arg(arg.as_str());
        }
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");

        let child =
            Arc::new(Mutex::new(pair.slave.spawn_command(builder).with_context(
                || format!("failed to spawn ssh {}", config.host),
            )?));
        let master = Arc::new(Mutex::new(pair.master));
        let reader = master.lock().unwrap().try_clone_reader()?;
        let writer = Arc::new(Mutex::new(master.lock().unwrap().take_writer()?));
        let session_id = Uuid::new_v4().to_string();
        let output_buffer = Arc::new(Mutex::new(TerminalOutputBuffer::default()));

        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            TerminalSession {
                workspace_id,
                master: Some(master),
                writer: Some(writer),
                child: Some(Arc::clone(&child)),
                output_buffer: Arc::clone(&output_buffer),
            },
        );
        spawn_terminal_background_tasks(
            app,
            Arc::clone(&self.sessions),
            session_id.clone(),
            child,
            reader,
            output_buffer,
        );

        Ok(TerminalSessionDto {
            id: session_id,
            title,
            provider_kind: "ssh".to_string(),
            cwd: cwd.to_string_lossy().replace('\\', "/"),
        })
    }

    pub fn write_input(&self, session_id: &str, input: &str) -> anyhow::Result<()> {
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
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .context("terminal session not found")?;
        let master = session.master.as_ref().context("terminal pty not found")?;
        master.lock().unwrap().resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    pub fn terminal_buffer(&self, session_id: &str) -> anyhow::Result<TerminalBufferSnapshot> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .context("terminal session not found")?;
        let snapshot = session.output_buffer.lock().unwrap().snapshot();
        Ok(snapshot)
    }

    pub fn live_session_ids(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions
            .iter()
            .filter_map(|(session_id, session)| {
                (session.master.is_some() && session.writer.is_some() && session.child.is_some())
                    .then(|| session_id.clone())
            })
            .collect()
    }

    pub fn close_session(&self, session_id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(session_id) {
            close_terminal_session(session);
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub fn close_sessions_for_workspace(&self, workspace_id: &str) -> anyhow::Result<()> {
        let sessions_to_close = {
            let mut sessions = self.sessions.lock().unwrap();
            let session_ids = sessions
                .iter()
                .filter_map(|(session_id, session)| {
                    (session.workspace_id.as_deref() == Some(workspace_id))
                        .then(|| session_id.clone())
                })
                .collect::<Vec<_>>();

            session_ids
                .into_iter()
                .filter_map(|session_id| sessions.remove(&session_id))
                .collect::<Vec<_>>()
        };

        for session in sessions_to_close {
            close_terminal_session(session);
        }

        Ok(())
    }

    pub fn close_all_sessions(&self) -> anyhow::Result<()> {
        let sessions_to_close = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };

        for session in sessions_to_close {
            close_terminal_session(session);
        }

        Ok(())
    }
}

fn spawn_terminal_background_tasks(
    app: &AppHandle,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    session_id: String,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    mut reader: Box<dyn Read + Send>,
    output_buffer: Arc<Mutex<TerminalOutputBuffer>>,
) {
    let (emit_tx, emit_rx) =
        mpsc::sync_channel::<PendingTerminalOutput>(TERMINAL_OUTPUT_CHANNEL_CAPACITY);
    let emit_app_handle = app.clone();
    let emit_session_id = session_id.clone();
    let emit_thread = thread::spawn(move || {
        emit_terminal_output_batches(emit_app_handle, emit_session_id, emit_rx);
    });

    let reader_output_buffer = Arc::clone(&output_buffer);
    let reader_thread = thread::spawn(move || {
        let mut buffer = [0u8; 16384];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let chunk = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let (start_byte, end_byte) = {
                        let mut output = reader_output_buffer.lock().unwrap();
                        let start_byte = output.end_byte;
                        output.append(&chunk);
                        (start_byte, output.end_byte)
                    };
                    if emit_tx
                        .send(PendingTerminalOutput {
                            chunk,
                            start_byte,
                            end_byte,
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    let exit_app = app.clone();
    thread::spawn(move || {
        let exit_code = wait_for_terminal_exit(&child);
        let event_session_id = session_id.clone();
        finish_terminal_exit_session(
            &sessions,
            &session_id,
            Duration::from_millis(TERMINAL_EXIT_SESSION_REMOVAL_GRACE_MS),
            move || {
                drop(child);
                let _ = exit_app.emit(
                    "terminal-exit",
                    TerminalExitEvent {
                        session_id: event_session_id,
                        exit_code,
                    },
                );
            },
        );
        join_finished_terminal_thread(reader_thread);
        join_finished_terminal_thread(emit_thread);
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

        if limit_bytes == 0 {
            self.chunks.clear();
            self.len_bytes = 0;
            self.start_byte = self.end_byte;
            return;
        }

        if chunk.len() >= limit_bytes {
            let suffix = utf8_suffix_with_limit(chunk, limit_bytes).to_string();
            self.len_bytes = suffix.len();
            self.chunks.clear();
            if !suffix.is_empty() {
                self.chunks.push_back(suffix);
            }
            self.start_byte = self.end_byte.saturating_sub(self.len_bytes as u64);
            return;
        }

        if !chunk.is_empty() {
            self.len_bytes += chunk.len();
            self.chunks.push_back(chunk.to_string());
        }
        self.trim_to_limit(limit_bytes);
        self.start_byte = self.end_byte.saturating_sub(self.len_bytes as u64);
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

    fn snapshot(&self) -> TerminalBufferSnapshot {
        TerminalBufferSnapshot {
            buffer: self.chunks.iter().map(String::as_str).collect(),
            start_byte: self.start_byte,
            end_byte: self.end_byte,
        }
    }
}

fn emit_terminal_output_batches(
    app_handle: AppHandle,
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

        if pending.len() >= TERMINAL_OUTPUT_EMIT_LIMIT_BYTES {
            emit_terminal_output_batch(
                &app_handle,
                &session_id,
                std::mem::take(&mut pending),
                pending_start_byte,
                pending_end_byte,
            );
            emit_at = None;
            continue;
        }

        let Some(deadline) = emit_at else {
            continue;
        };
        let now = Instant::now();
        if now >= deadline {
            emit_terminal_output_batch(
                &app_handle,
                &session_id,
                std::mem::take(&mut pending),
                pending_start_byte,
                pending_end_byte,
            );
            emit_at = None;
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
                emit_terminal_output_batch(
                    &app_handle,
                    &session_id,
                    std::mem::take(&mut pending),
                    pending_start_byte,
                    pending_end_byte,
                );
                emit_at = None;
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
    app_handle: &AppHandle,
    session_id: &str,
    chunk: String,
    start_byte: u64,
    end_byte: u64,
) {
    if chunk.is_empty() {
        return;
    }
    let _ = app_handle.emit(
        "terminal-output",
        TerminalOutputEvent {
            session_id: session_id.to_string(),
            chunk,
            start_byte,
            end_byte,
        },
    );
}

fn utf8_suffix_with_limit(value: &str, limit_bytes: usize) -> &str {
    if value.len() <= limit_bytes {
        return value;
    }
    let start = next_char_boundary(value, value.len() - limit_bytes);
    &value[start..]
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
pub fn open_external_cli(provider_kind: &str, cwd: &Path) -> anyhow::Result<()> {
    if !cwd.is_dir() {
        anyhow::bail!("CLI working directory does not exist: {}", cwd.display());
    }

    let launch = resolve_launch(provider_kind)?;
    let command_args = external_cli_command_args(&launch);
    spawn_external_cmd(&command_args, cwd)
        .with_context(|| format!("failed to open external {} console", launch.title))
}

#[cfg(not(windows))]
pub fn open_external_cli(_provider_kind: &str, _cwd: &Path) -> anyhow::Result<()> {
    anyhow::bail!("External CMD launch is only available on Windows")
}

fn external_cli_command_args(launch: &CliLaunch) -> Vec<String> {
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
        .chain(args.iter().cloned())
        .collect()
}

#[cfg(windows)]
fn spawn_external_cmd(command_args: &[String], cwd: &Path) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            CreateProcessW, CREATE_NEW_CONSOLE, PROCESS_INFORMATION, STARTUPINFOW,
        },
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
    let mut command_line = format!("\"{}\" /d /k {}", application.to_string_lossy(), command)
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

    if provider_kind == "ssh" {
        // 'ssh' provider args are built from SshConnectionConfig; this never
        // reaches resolve_launch directly — create_session_for_workspace
        // handles it before falling into the PTY path.  Keep a stub that
        // returns an error so accidental direct calls are loud.
        anyhow::bail!("SSH sessions must be created via the dedicated code path");
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

fn configure_terminal_color_environment(builder: &mut CommandBuilder, provider_kind: &str) {
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    if provider_kind != "codex" {
        builder.env("FORCE_COLOR", "1");
        return;
    }

    // Codex enables its rich transcript colors from terminal capability variables.
    // Do not let a NO_COLOR value inherited by the desktop app override the embedded PTY.
    builder.env_remove("NO_COLOR");
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
            "未找到 {}。已检查 PATH、npm、pnpm、Bun、Cargo 和 Cherry Studio 常见目录。",
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
    for directory in preferred_provider_dirs(provider.kind) {
        if let Some(path) = find_executable(provider.command, &[directory]) {
            return Some(path);
        }
    }

    find_executable(provider.command, dirs)
}

fn args_for_provider(provider_kind: &str) -> Vec<&'static str> {
    match provider_kind {
        "claude" => vec!["--dangerously-skip-permissions"],
        "codex" => vec![
            "--ask-for-approval",
            "never",
            "--sandbox",
            "danger-full-access",
        ],
        // Fully autonomous: no permission prompts and no clarifying questions.
        "kimi" => vec!["--auto"],
        // Always-approve tools + unrestricted sandbox (same intent as Claude/Codex full access).
        "grok" => vec!["--always-approve", "--sandbox", "off"],
        "gemini" => vec!["--skip-trust", "--approval-mode", "yolo"],
        "local" => vec!["-NoLogo"],
        _ => Vec::new(),
    }
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
        "claude" | "kimi" => {
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
        let user_profile = PathBuf::from(user_profile);
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
}

fn add_superhigh_cli_dirs(dirs: &mut Vec<PathBuf>) {
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

fn initial_prompt_input(provider_kind: &str, cwd: &Path, prompt: &str) -> anyhow::Result<String> {
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
    use super::{
        args_for_provider, configure_terminal_color_environment, external_cli_command_args,
        find_executable, find_superhigh_cli_executable, finish_terminal_exit_session,
        initial_prompt_input, launch_command_for_path, CliLaunch, TerminalManager,
        TerminalOutputBuffer, TerminalSession,
    };
    use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::{fs, io, path::Path, time::Duration};

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
    fn codex_terminal_forces_truecolor_and_clears_no_color() {
        let mut builder = CommandBuilder::new("codex");
        builder.env("NO_COLOR", "1");

        configure_terminal_color_environment(&mut builder, "codex");

        assert_eq!(builder.get_env("TERM").unwrap(), "xterm-256color");
        assert_eq!(builder.get_env("COLORTERM").unwrap(), "truecolor");
        assert_eq!(builder.get_env("FORCE_COLOR").unwrap(), "3");
        assert_eq!(builder.get_env("CLICOLOR_FORCE").unwrap(), "1");
        assert!(builder.get_env("NO_COLOR").is_none());
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
    fn terminal_exit_cleanup_releases_handles_before_event_and_then_removes_session() {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        sessions.lock().unwrap().insert(
            "session-1".to_string(),
            TerminalSession {
                workspace_id: None,
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
                master: test_master(),
                writer: Some(Arc::new(Mutex::new(Box::new(io::sink())))),
                child: Some(Arc::new(Mutex::new(Box::new(TestChild)))),
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );

        assert_eq!(manager.live_session_ids(), vec!["live".to_string()]);
    }

    #[test]
    fn codex_launch_preserves_upstream_overlay_scrolling() {
        let args = args_for_provider("codex");

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
    fn external_cmd_launch_calls_the_resolved_cli_directly() {
        let launch = CliLaunch {
            program: "cmd.exe".to_string(),
            args: vec![
                "/d".to_string(),
                "/s".to_string(),
                "/c".to_string(),
                "call".to_string(),
                "C:/Users/Test User/AppData/Roaming/npm/claude.cmd".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ],
            title: "Claude Code".to_string(),
            path_env: None,
            superhigh_cli_path: None,
        };

        assert_eq!(
            external_cli_command_args(&launch),
            vec![
                "call".to_string(),
                r"C:\Users\Test User\AppData\Roaming\npm\claude.cmd".to_string(),
                "--dangerously-skip-permissions".to_string(),
            ]
        );
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
        let script_path = "C:/Tools/npm/claude.cmd";
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
        let script_path = r"D:\Work\server\start.bat";
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
                master: None,
                writer: None,
                child: None,
                output_buffer: Arc::new(Mutex::new(TerminalOutputBuffer::default())),
            },
        );
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
    struct TestChild;

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
