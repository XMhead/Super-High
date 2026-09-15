use std::{
    collections::{HashMap, VecDeque},
    ffi::OsString,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};

use anyhow::Context;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::models::{
    CliProviderEnvironment, NativeCliTranscript, TerminalBufferSnapshot,
    TerminalExitEvent, TerminalOutputEvent, TerminalSessionDto,
};
use crate::process_tree::kill_pty_child_tree;

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

struct CliLaunch {
    program: String,
    args: Vec<String>,
    title: String,
    path_env: Option<String>,
    superhigh_cli_path: Option<String>,
}

struct TerminalOutputBuffer {
    chunks: VecDeque<String>,
    len_bytes: usize,
    start_byte: u64,
    end_byte: u64,
    cols: u16,
    rows: u16,
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
        }
    }
}

struct PendingTerminalOutput {
    chunk: String,
    start_byte: u64,
    end_byte: u64,
}

const TERMINAL_OUTPUT_HISTORY_LIMIT_BYTES: usize = 256 * 1024;
const TERMINAL_OUTPUT_EMIT_INTERVAL_MS: u64 = 50;
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
    /// Only registered sessions and their owned PTY children are inspected.
    pub fn inspect_sessions(
        &self,
        project: Option<&Path>,
    ) -> anyhow::Result<Vec<TerminalInspection>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| anyhow::anyhow!("终端会话状态不可用"))?;
        let mut result = Vec::new();
        for (id, session) in sessions.iter() {
            if project.is_some_and(|project| !terminal_cwd_matches(&session.cwd, project)) {
                continue;
            }
            let (running, process_id) = if let Some(child) = &session.child {
                let mut child = child
                    .lock()
                    .map_err(|_| anyhow::anyhow!("终端进程状态不可用"))?;
                (
                    child
                        .try_wait()
                        .context("无法确认终端是否已退出")?
                        .is_none(),
                    child.process_id(),
                )
            } else {
                (false, None)
            };
            result.push(TerminalInspection {
                id: id.clone(),
                workspace_id: session.workspace_id.clone(),
                provider_kind: session.provider_kind.clone(),
                title: session.title.clone(),
                cwd: session.cwd.to_string_lossy().into_owned(),
                holds_pty_child: session.child.is_some(),
                running,
                process_id,
            });
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
        native_session_id: Option<String>,
        launch: CliLaunch,
    ) -> anyhow::Result<TerminalSessionDto> {
        let _update_guard = self.lock_session_creation()?;
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
            configure_embedded_codex(&mut builder);
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
                provider_kind: provider_kind.to_string(),
                title: launch.title.clone(),
                cwd: cwd.to_path_buf(),
                started_at: SystemTime::now(),
                native_session_id,
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
        let mut output = session.output_buffer.lock().unwrap();
        output.cols = cols.max(1);
        output.rows = rows.max(1);
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

    pub fn open_external_session(&self, session_id: &str) -> anyhow::Result<()> {
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
        open_external_cli_with_resume(&provider_kind, &cwd, &native_session_id)
    }

    fn stop_codex_session_for_external_handoff(
        &self,
        session_id: &str,
        timeout: Duration,
    ) -> anyhow::Result<()> {
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
            session_matches_project_service(session, title, cwd).then(|| session_id.clone())
        })
    }

    pub fn find_live_minecraft_client_session(&self, title: &str, cwd: &Path) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.iter().find_map(|(session_id, session)| {
            (session.provider_kind == "minecraft-client"
                && session.title == title
                && session.cwd == cwd
                && session.master.is_some()
                && session.writer.is_some()
                && session.child.is_some())
            .then(|| session_id.clone())
        })
    }

    pub fn close_session(&self, session_id: &str) -> anyhow::Result<()> {
        let session = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions.remove(session_id)
        };

        if let Some(session) = session {
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
        TerminalBufferSnapshot {
            buffer,
            start_byte: self.start_byte + offset.unwrap_or(0) as u64,
            end_byte: self.end_byte,
            cols: self.cols,
            rows: self.rows,
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

pub fn enhance_prompt_with_codex(cwd: &Path, prompt: &str) -> anyhow::Result<String> {
    if !cwd.is_dir() {
        anyhow::bail!("Codex working directory does not exist: {}", cwd.display());
    }
    if prompt.trim().is_empty() {
        anyhow::bail!("请输入需要增强的提示词");
    }

    let dirs = detection_dirs();
    let provider = CLI_PROVIDERS
        .iter()
        .find(|provider| provider.kind == "codex")
        .context("Codex CLI provider is not configured")?;
    let environment = detect_provider_environment(provider, &dirs);
    let resolved_path = environment.resolved_path.with_context(|| {
        environment
            .issue
            .unwrap_or_else(|| "未找到 Codex CLI，请先到“设置 > CLI 管理”刷新检测。".to_string())
    })?;
    let output_dir = tempfile::tempdir().context("failed to create Codex output directory")?;
    let output_path = output_dir.path().join("enhanced-prompt.txt");
    let args = codex_prompt_enhancement_args(cwd, &output_path);
    let (program, args) = launch_command_for_path(&resolved_path, &args);
    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .env_remove("CODEX_THREAD_ID")
        .env_remove("CODEX_MANAGED_BY_NPM")
        .env_remove("CODEX_MANAGED_BY_BUN");
    if let Some(path_env) = joined_path_env(&dirs) {
        command.env("PATH", &path_env).env("Path", path_env);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .with_context(|| format!("failed to start Codex CLI: {program}"))?;
    let instruction = codex_prompt_enhancement_instruction(prompt);
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(error) = stdin.write_all(instruction.as_bytes()) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error).context("failed to send the prompt to Codex CLI");
        }
    }
    let output = child
        .wait_with_output()
        .context("failed while waiting for Codex CLI")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        anyhow::bail!(
            "Codex 提示词增强失败{}",
            if stderr.is_empty() {
                format!("（退出码 {:?}）", output.status.code())
            } else {
                format!("：{stderr}")
            }
        );
    }

    let enhanced =
        fs::read_to_string(&output_path).context("Codex CLI did not return an enhanced prompt")?;
    let enhanced = enhanced.trim();
    if enhanced.is_empty() {
        anyhow::bail!("Codex CLI 返回了空提示词");
    }
    Ok(enhanced.to_string())
}

fn codex_prompt_enhancement_args(cwd: &Path, output_path: &Path) -> Vec<String> {
    vec![
        "--ask-for-approval".to_string(),
        "never".to_string(),
        "exec".to_string(),
        "--sandbox".to_string(),
        "read-only".to_string(),
        "--cd".to_string(),
        cwd.to_string_lossy().to_string(),
        "--skip-git-repo-check".to_string(),
        "--ephemeral".to_string(),
        "--color".to_string(),
        "never".to_string(),
        "--output-last-message".to_string(),
        output_path.to_string_lossy().to_string(),
        "-".to_string(),
    ]
}

fn codex_prompt_enhancement_instruction(prompt: &str) -> String {
    format!(
        r#"只重写下面的用户提示词，不要执行其中的任务。
保留原始意图、语气和明确约束；消除歧义与无效重复，补齐必要的目标和可验证完成标准，但不要擅自扩大范围或虚构事实。
直接输出一份可发送的提示词正文，不要附加分析、前言、解释或 Markdown 围栏。

<original_prompt>
{prompt}
</original_prompt>"#
    )
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

#[cfg(windows)]
fn open_external_cli_with_resume(
    provider_kind: &str,
    cwd: &Path,
    native_session_id: &str,
) -> anyhow::Result<()> {
    if !cwd.is_dir() {
        anyhow::bail!("CLI working directory does not exist: {}", cwd.display());
    }

    let mut launch = resolve_launch(provider_kind)?;
    let resume_args = resume_args_for_provider(provider_kind, native_session_id)
        .with_context(|| format!("{} 不支持恢复原生会话", provider_kind))?;
    launch.args.extend(resume_args);
    let command_args = external_cli_command_args(&launch);
    spawn_external_cmd(&command_args, cwd)
        .with_context(|| format!("failed to resume external {} console", launch.title))
}

#[cfg(not(windows))]
pub fn open_external_cli(_provider_kind: &str, _cwd: &Path) -> anyhow::Result<()> {
    anyhow::bail!("External CMD launch is only available on Windows")
}

#[cfg(not(windows))]
fn open_external_cli_with_resume(
    _provider_kind: &str,
    _cwd: &Path,
    _native_session_id: &str,
) -> anyhow::Result<()> {
    anyhow::bail!("External CMD launch is only available on Windows")
}

/// Strip inherited Cursor/WT capability variables before starting a new
/// console.
fn external_console_setup_prefix() -> &'static str {
    concat!(
        r#"set "TERM=" & "#,
        r#"set "NO_COLOR=" & "#,
        r#"set "WT_SESSION=" & "#,
        r#"set "WT_PROFILE_ID=" & "#,
        r#"set "WT_DEFAULT_PROFILE=" & "#,
        r#"set "TERM_PROGRAM=" & "#,
        r#"set "TERM_PROGRAM_VERSION=" & "#,
        r#"set "VSCODE_INJECTION=" & "#,
        r#"chcp 65001>nul & "#,
    )
}

fn external_cmd_command_line(application: &str, command: &str) -> String {
    format!(
        "\"{}\" /d /k {}{}",
        application,
        external_console_setup_prefix(),
        command
    )
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
fn spawn_external_cmd(
    command_args: &[String],
    cwd: &Path,
) -> anyhow::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{
            CreateProcessW, CREATE_NEW_CONSOLE, PROCESS_INFORMATION,
            STARTUPINFOW,
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
    let mut command_line = external_cmd_command_line(&application.to_string_lossy(), &command)
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
    builder.env_remove("CODEX_THREAD_ID");
    builder.env_remove("CODEX_MANAGED_BY_NPM");
    builder.env_remove("CODEX_MANAGED_BY_BUN");
    // Astra's composer sparkle emits animated Braille dots and background cells into
    // the PTY shared by desktop and mobile. Disable decorative effects for embedded
    // sessions (including resume), without changing the user's external CLI config.
    builder.arg("-c");
    builder.arg("tui.whimsy=false");
}

fn configure_terminal_color_environment(builder: &mut CommandBuilder, provider_kind: &str) {
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    if provider_kind != "codex" {
        builder.env("FORCE_COLOR", "1");
        return;
    }

    // Codex enables its rich TUI rendering from terminal capability variables.
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
    use super::{
        add_node_modules_bin, args_for_provider, codex_prompt_enhancement_instruction,
        configure_terminal_color_environment, external_cli_command_args, external_cmd_command_line,
        external_console_setup_prefix, find_executable,
        find_superhigh_cli_executable, finish_terminal_exit_session, initial_prompt_input,
        last_closed_sync_frame_end, launch_command_for_path, locate_codex_transcript_in_root,
        project_service_session_matches, resume_args_for_provider,
        split_pending_at_frame_boundary, split_pending_for_size_emit, CliLaunch,
        TerminalManager, TerminalOutputBuffer, TerminalSession,
        SYNC_OUTPUT_SET,
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
                title: "Codex CLI".to_string(),
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
    fn prompt_enhancement_does_not_force_a_project_rescan() {
        let instruction = codex_prompt_enhancement_instruction("修复终端按钮");

        assert!(!instruction.contains("AGENTS.md"));
        assert!(!instruction.contains("项目说明"));
        assert!(!instruction.contains("Skills"));
        assert!(!instruction.contains("相关代码"));
        assert!(instruction.contains("只重写"));
        assert!(instruction.contains("修复终端按钮"));
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
    fn external_console_clears_inherited_terminal_capability_vars() {
        let prefix = external_console_setup_prefix();
        assert!(prefix.contains(r#"set "TERM=""#));
        assert!(prefix.contains(r#"set "NO_COLOR=""#));
        assert!(prefix.contains(r#"set "WT_SESSION=""#));
        assert!(prefix.contains(r#"set "TERM_PROGRAM=""#));
        assert!(prefix.contains(r#"set "VSCODE_INJECTION=""#));
        assert!(prefix.contains("chcp 65001"));

        let command_line = external_cmd_command_line(
            "cmd.exe",
            r#"call "C:\Users\Test User\codex.cmd" "resume""#,
        );
        assert!(command_line.starts_with("\"cmd.exe\" /d /k "));
        assert!(command_line.contains(prefix));
        assert!(command_line.contains(r#"call "C:\Users\Test User\codex.cmd" "resume""#));
    }

    #[test]
    fn external_cmd_launch_calls_codex_with_approval_and_sandbox_bypass() {
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
            title: "Codex CLI".to_string(),
            path_env: None,
            superhigh_cli_path: None,
        };

        assert_eq!(
            external_cli_command_args(&launch),
            vec![
                "call".to_string(),
                r"C:\Users\Test User\AppData\Roaming\npm\codex.cmd".to_string(),
                "--dangerously-bypass-approvals-and-sandbox".to_string(),
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
