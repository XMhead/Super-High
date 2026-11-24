use std::{path::Path, sync::Arc};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::terminal::SharedTerminalManager;

const PIPE_NAME: &str = r"\\.\pipe\SuperHigh.ServiceControl.v1";

pub const TERMINAL_DEFAULT_TAIL: usize = 100;
pub const TERMINAL_MAX_TAIL: usize = 2000;
const TERMINAL_LOG_BYTE_LIMIT: usize = 32 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalBridgeRequest {
    pub operation: String,
    pub project_path: Option<String>,
    pub session_id: Option<String>,
    pub tail: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enter: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBridgeResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<crate::terminal::TerminalInspection>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logs: Option<TerminalBridgeLogs>,
    pub error: Option<ServiceBridgeError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalBridgeLogs {
    pub session_id: String,
    pub text: String,
    pub truncated: bool,
    pub start_byte: u64,
    pub end_byte: u64,
}

pub fn send_terminal_request(
    request: &TerminalBridgeRequest,
) -> anyhow::Result<TerminalBridgeResponse> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::block_on(send_request_async(request));
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        bail!("bridge unavailable: terminal inspection is only available on Windows")
    }
}

fn terminal_key_input(key: &str) -> anyhow::Result<&'static str> {
    match key {
        "ctrl+c" => Ok("\u{3}"),
        "enter" => Ok("\r"),
        "escape" => Ok("\u{1b}"),
        "tab" => Ok("\t"),
        "backspace" => Ok("\u{7f}"),
        "ctrl+d" => Ok("\u{4}"),
        _ => bail!("invalid bridge request: unsupported terminal key: {key}"),
    }
}

pub(crate) fn validate_terminal_request(request: &TerminalBridgeRequest) -> anyhow::Result<()> {
    if let Some(project) = &request.project_path {
        anyhow::ensure!(
            Path::new(project).is_absolute(),
            "invalid bridge request: projectPath must be absolute"
        );
    }
    let allowed: &[&str] = match request.operation.as_str() {
        "terminal.list" => &[],
        "terminal.logs" => &["sessionId", "tail"],
        "terminal.create" => &["providerKind"],
        "terminal.write" => &["sessionId", "input", "enter"],
        "terminal.key" => &["sessionId", "key"],
        "terminal.close" => &["sessionId"],
        "terminal.resize" => &["sessionId", "cols", "rows"],
        _ => bail!("invalid bridge operation: {}", request.operation),
    };
    for (name, present) in [
        ("sessionId", request.session_id.is_some()),
        ("tail", request.tail.is_some()),
        ("providerKind", request.provider_kind.is_some()),
        ("input", request.input.is_some()),
        ("key", request.key.is_some()),
        ("cols", request.cols.is_some()),
        ("rows", request.rows.is_some()),
        ("enter", request.enter.is_some()),
    ] {
        anyhow::ensure!(
            !present || allowed.contains(&name),
            "invalid bridge request: {} does not accept {name}",
            request.operation
        );
    }
    if allowed.contains(&"sessionId") {
        anyhow::ensure!(
            request
                .session_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty()),
            "invalid bridge request: {} requires sessionId",
            request.operation
        );
    }
    match request.operation.as_str() {
        "terminal.logs" => anyhow::ensure!(
            (1..=TERMINAL_MAX_TAIL).contains(&request.tail.unwrap_or(TERMINAL_DEFAULT_TAIL)),
            "invalid bridge request: tail must be between 1 and {TERMINAL_MAX_TAIL}"
        ),
        "terminal.create" => {
            let project = request
                .project_path
                .as_deref()
                .context("invalid bridge request: create requires projectPath")?;
            anyhow::ensure!(
                Path::new(project).is_dir(),
                "invalid bridge request: projectPath must be an existing directory"
            );
            anyhow::ensure!(
                !request
                    .provider_kind
                    .as_deref()
                    .unwrap_or("local")
                    .trim()
                    .is_empty(),
                "invalid bridge request: providerKind must not be empty"
            );
        }
        "terminal.write" => anyhow::ensure!(
            request.input.is_some(),
            "invalid bridge request: write requires input"
        ),
        "terminal.key" => {
            terminal_key_input(
                request
                    .key
                    .as_deref()
                    .context("invalid bridge request: key requires key")?,
            )?;
        }
        "terminal.resize" => anyhow::ensure!(
            request.cols.is_some_and(|v| v > 0) && request.rows.is_some_and(|v| v > 0),
            "invalid bridge request: resize requires positive cols and rows"
        ),
        _ => {}
    }
    Ok(())
}

fn terminal_log_tail(
    session_id: String,
    snapshot: crate::models::TerminalBufferSnapshot,
    tail: usize,
) -> TerminalBridgeLogs {
    let text = snapshot.buffer.as_str();
    let mut start = text.len();
    for line in text.split_inclusive('\n').rev().take(tail) {
        start -= line.len();
    }
    start = start.max(text.len().saturating_sub(TERMINAL_LOG_BYTE_LIMIT));
    while !text.is_char_boundary(start) {
        start += 1;
    }
    TerminalBridgeLogs {
        session_id,
        text: text[start..].to_string(),
        truncated: snapshot.start_byte > 0 || start > 0,
        start_byte: snapshot.start_byte + start as u64,
        end_byte: snapshot.end_byte,
    }
}

fn execute_terminal_request(
    app: &AppHandle,
    terminal: &SharedTerminalManager,
    raw: &str,
) -> TerminalBridgeResponse {
    let result = (|| -> anyhow::Result<TerminalBridgeResponse> {
        let request: TerminalBridgeRequest =
            serde_json::from_str(raw).context("invalid bridge request")?;
        validate_terminal_request(&request)?;
        let mut response = TerminalBridgeResponse {
            ok: true,
            sessions: None,
            logs: None,
            error: None,
        };
        if request.operation == "terminal.create" {
            let provider_kind = request.provider_kind.as_deref().unwrap_or("local");
            let cwd = Path::new(request.project_path.as_deref().unwrap());
            let created = terminal.create_session_for_workspace(
                app, None, provider_kind, cwd, Default::default(), None,
            )?;
            // Register CLI-created sessions in the desktop workspace as well as the PTY manager.
            let _ = app.emit("mobile-terminal-created", &created);
            let session = terminal
                .inspect_sessions(None)?
                .into_iter()
                .find(|session| session.id == created.id)
                .context("created terminal session not found")?;
            response.sessions = Some(vec![session]);
            return Ok(response);
        }
        let sessions = terminal.inspect_sessions(request.project_path.as_deref().map(Path::new))?;
        if request.operation == "terminal.list" {
            response.sessions = Some(sessions);
            return Ok(response);
        }
        let session_id = request.session_id.as_deref().unwrap();
        anyhow::ensure!(
            sessions.iter().any(|session| session.id == session_id),
            "terminal session not found in requested project"
        );
        match request.operation.as_str() {
            "terminal.logs" => {
                response.logs = Some(terminal_log_tail(
                    session_id.to_string(),
                    terminal.terminal_buffer(session_id)?,
                    request.tail.unwrap_or(TERMINAL_DEFAULT_TAIL),
                ));
            }
            "terminal.write" => {
                let mut input = request.input.unwrap();
                if request.enter.unwrap_or(false) {
                    input.push('\r');
                }
                terminal.write_input(session_id, &input)?;
            }
            "terminal.key" => terminal.write_input(
                session_id,
                terminal_key_input(request.key.as_deref().unwrap())?,
            )?,
            "terminal.resize" => {
                terminal.resize_session(session_id, request.cols.unwrap(), request.rows.unwrap())?
            }
            "terminal.close" => terminal.close_session(session_id)?,
            _ => unreachable!("validated terminal operation"),
        }
        Ok(response)
    })();
    result.unwrap_or_else(|error| TerminalBridgeResponse {
        ok: false,
        sessions: None,
        logs: None,
        error: Some(ServiceBridgeError {
            kind: error_kind(&error.to_string()).to_string(),
            message: error.to_string(),
        }),
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBridgeError {
    pub kind: String,
    pub message: String,
}

pub fn start(app: AppHandle, terminal: SharedTerminalManager) {
    #[cfg(windows)]
    tauri::async_runtime::spawn(async move {
        run_server(app, terminal).await;
    });
}

fn error_kind(message: &str) -> &'static str {
    if message.starts_with("unknown service:") {
        "unknown_service"
    } else if message.starts_with("invalid bridge")
        || message.starts_with("invalid bridge operation")
    {
        "invalid_request"
    } else {
        "request_failed"
    }
}

#[cfg(windows)]
async fn run_server(app: AppHandle, terminal: SharedTerminalManager) {
    use tokio::net::windows::named_pipe::ServerOptions;

    let mut server = match ServerOptions::new()
        .first_pipe_instance(true)
        .create(PIPE_NAME)
    {
        Ok(server) => server,
        Err(error) => {
            eprintln!("[Super High] local control bridge unavailable (another instance may own it): {error}");
            return;
        }
    };
    loop {
        if let Err(error) = server.connect().await {
            eprintln!("[Super High] local control bridge connection failed: {error}");
            continue;
        }
        let connected = server;
        server = match ServerOptions::new().create(PIPE_NAME) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("[Super High] local control bridge could not create next pipe instance: {error}");
                return;
            }
        };
        let app = app.clone();
        let terminal = Arc::clone(&terminal);
        tauri::async_runtime::spawn(async move {
            handle_client(connected, app, terminal).await;
        });
    }
}

#[cfg(windows)]
async fn handle_client(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    app: AppHandle,
    terminal: SharedTerminalManager,
) {
    use tokio::io::AsyncWriteExt;

    let response = match read_json_line(&mut pipe).await {
        Ok(raw) => {
            if serde_json::from_str::<serde_json::Value>(&raw).ok()
                .is_some_and(|v| v["operation"] == "mobile.control")
            {
                let response = tokio::task::spawn_blocking(move || crate::mobile_device::execute_bridge(&app, &raw))
                    .await.unwrap_or_else(|error| serde_json::json!({"ok":false,"error":{"code":"mobile_request_failed","message":error.to_string()}}));
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = pipe.write_all(&payload).await;
                    let _ = pipe.flush().await;
                }
                return;
            }
            if serde_json::from_str::<serde_json::Value>(&raw).ok()
                .is_some_and(|v| v["operation"].as_str().is_some_and(|op| op.starts_with("agent.")))
            {
                let response = tokio::task::spawn_blocking(move || crate::agent_control::execute_bridge(&app, &terminal, &raw))
                    .await.unwrap_or_else(|error| serde_json::json!({"ok": false, "error": {"code": "request_failed", "message": error.to_string()}}));
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = pipe.write_all(&payload).await;
                    let _ = pipe.flush().await;
                }
                return;
            }
            if serde_json::from_str::<serde_json::Value>(&raw).ok()
                .is_some_and(|v| v.get("operation").and_then(|op| op.as_str()) == Some("appearance.reload"))
            {
                // CLI 已写入设置库；通知前端重新读取。
                let response = match app.emit("app-settings-updated", ()) {
                    Ok(()) => serde_json::json!({"ok": true}),
                    Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
                };
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = pipe.write_all(&payload).await;
                    let _ = pipe.flush().await;
                }
                return;
            }
            if serde_json::from_str::<serde_json::Value>(&raw).ok()
                .and_then(|v| v.get("operation").and_then(|op| op.as_str()).map(|op| op.starts_with("memo.")))
                .unwrap_or(false)
            {
                let response = tokio::task::spawn_blocking(move || crate::cli_memo::execute_bridge(&app, &raw))
                    .await.unwrap_or_else(|error| serde_json::json!({"ok": false, "error": error.to_string()}));
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = pipe.write_all(&payload).await;
                    let _ = pipe.flush().await;
                }
                return;
            }
            if serde_json::from_str::<serde_json::Value>(&raw).ok()
                .is_some_and(|v| v.get("operation").and_then(|op| op.as_str()) == Some("files.open"))
            {
                let response = tokio::task::spawn_blocking(move || crate::cli_files::execute_open_bridge(&app, &raw))
                    .await.unwrap_or_else(|error| serde_json::json!({"ok": false, "error": error.to_string()}));
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = pipe.write_all(&payload).await;
                    let _ = pipe.flush().await;
                }
                return;
            }
            if serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|value| {
                    value
                        .get("operation")
                        .and_then(|v| v.as_str())
                        .map(|op| op.starts_with("terminal."))
                })
                .unwrap_or(false)
            {
                let response = tokio::task::spawn_blocking(move || {
                    execute_terminal_request(&app, &terminal, &raw)
                })
                .await
                .unwrap_or_else(|error| TerminalBridgeResponse {
                    ok: false,
                    sessions: None,
                    logs: None,
                    error: Some(ServiceBridgeError {
                        kind: "request_failed".to_string(),
                        message: format!("bridge request task failed: {error}"),
                    }),
                });
                if let Ok(mut payload) = serde_json::to_vec(&response) {
                    payload.push(b'\n');
                    let _ = pipe.write_all(&payload).await;
                    let _ = pipe.flush().await;
                }
                return;
            }
            TerminalBridgeResponse {
                ok: false,
                sessions: None,
                logs: None,
                error: Some(ServiceBridgeError {
                    kind: "invalid_request".to_string(),
                    message: "invalid bridge operation".to_string(),
                }),
            }
        }
        Err(error) => TerminalBridgeResponse {
            ok: false,
            sessions: None,
            logs: None,
            error: Some(ServiceBridgeError {
                kind: error_kind(&error.to_string()).to_string(),
                message: error.to_string(),
            }),
        },
    };
    if let Ok(mut payload) = serde_json::to_vec(&response) {
        payload.push(b'\n');
        let _ = pipe.write_all(&payload).await;
        let _ = pipe.flush().await;
    }
}

#[cfg(windows)]
pub(crate) async fn send_request_async<T: Serialize, R: serde::de::DeserializeOwned>(
    request: &T,
) -> anyhow::Result<R> {
    use tokio::{io::AsyncWriteExt, net::windows::named_pipe::ClientOptions};

    let mut pipe = ClientOptions::new()
        .open(PIPE_NAME)
        .map_err(classify_connection_error)?;
    let mut payload = serde_json::to_vec(request)?;
    payload.push(b'\n');
    pipe.write_all(&payload)
        .await
        .map_err(classify_connection_error)?;
    pipe.flush().await.map_err(classify_connection_error)?;
    let raw = read_json_line(&mut pipe)
        .await
        .map_err(classify_connection_error)?;
    serde_json::from_str(&raw).context("bridge returned an invalid response")
}

#[cfg(windows)]
async fn read_json_line<T>(stream: &mut T) -> std::io::Result<String>
where
    T: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    // Allows 32 KiB of PTY text even when JSON expands each control byte to six bytes.
    const LIMIT: usize = 256 * 1024;
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let size = stream.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        let take = buffer[..size]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(size);
        output.extend_from_slice(&buffer[..take]);
        if output.len() > LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "bridge payload is too large",
            ));
        }
        if take < size || output.last() == Some(&b'\n') {
            break;
        }
    }
    if output.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "bridge closed without a response",
        ));
    }
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

pub const APP_NOT_RUNNING: &str = "app not running:";

// 枚举进程判断桌面应用是否在运行；superhigh-cli/agent 的进程名不带连字符，不会误判。
#[cfg(windows)]
fn super_high_app_running() -> Option<bool> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut running = false;
    while found != 0 {
        let length = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        if is_super_high_app_name(&String::from_utf16_lossy(&entry.szExeFile[..length])) {
            running = true;
            break;
        }
        found = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    Some(running)
}

fn is_super_high_app_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("super-high") && name.ends_with(".exe")
}

#[cfg(windows)]
fn classify_connection_error(error: std::io::Error) -> anyhow::Error {
    let kind = error.kind();
    let code = error.raw_os_error();
    // 管道不存在时区分“应用没开”和“开着但无桥接”，前者是确定结果而不是查询失败。
    if (matches!(kind, std::io::ErrorKind::NotFound) || code == Some(2))
        && super_high_app_running() == Some(false)
    {
        anyhow::anyhow!("{APP_NOT_RUNNING} Super High is not running")
    } else if matches!(
        kind,
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    ) || matches!(code, Some(2 | 233))
    {
        anyhow::anyhow!("bridge unavailable: start a newer Super High and retry")
    } else if matches!(kind, std::io::ErrorKind::WouldBlock) || matches!(code, Some(231)) {
        anyhow::anyhow!(
            "bridge busy: Super High is handling another request; retry shortly"
        )
    } else {
        anyhow::anyhow!("bridge unavailable: {error}")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn recognizes_only_desktop_app_process_names() {
        assert!(super::is_super_high_app_name("super-high.exe"));
        assert!(super::is_super_high_app_name("Super-High-running-18232.EXE"));
        assert!(!super::is_super_high_app_name("superhigh-cli.exe"));
        assert!(!super::is_super_high_app_name("superhigh-agent.exe"));
    }

    #[test]
    fn terminal_tail_preserves_utf8_offsets_and_line_endings() {
        let text = "one\r\n你好\r\nlast";
        let snapshot = crate::models::TerminalBufferSnapshot {
            buffer: text.into(),
            start_byte: 10,
            end_byte: 10 + text.len() as u64,
            cols: 120,
            rows: 32,
            modes: String::new(),
            sizes: Vec::new(),
        };
        let logs = super::terminal_log_tail("id".into(), snapshot, 2);
        assert_eq!(logs.text, "你好\r\nlast");
        assert_eq!(logs.start_byte, 15);
        assert_eq!(logs.end_byte, 10 + text.len() as u64);
        assert!(logs.truncated);
        let text = "你".repeat(super::TERMINAL_LOG_BYTE_LIMIT);
        let snapshot = crate::models::TerminalBufferSnapshot {
            buffer: text.clone(),
            start_byte: 0,
            end_byte: text.len() as u64,
            cols: 120,
            rows: 32,
            modes: String::new(),
            sizes: Vec::new(),
        };
        let logs = super::terminal_log_tail("id".into(), snapshot, 100);
        assert!(logs.text.len() <= super::TERMINAL_LOG_BYTE_LIMIT);
        assert_eq!(logs.text, text[logs.start_byte as usize..]);
    }

    #[test]
    fn terminal_requests_reject_unknown_operations_and_invalid_tail() {
        let mut request = super::TerminalBridgeRequest {
            operation: "terminal.input".into(),
            project_path: None,
            session_id: Some("a".into()),
            tail: None,
            provider_kind: None,
            input: None,
            key: None,
            cols: None,
            rows: None,
            enter: None,
        };
        assert!(super::validate_terminal_request(&request).is_err());
        request.operation = "terminal.logs".into();
        assert!(super::validate_terminal_request(&request).is_ok());
        request.tail = Some(0);
        assert!(super::validate_terminal_request(&request).is_err());
    }

    #[test]
    fn terminal_read_requests_omit_new_fields_for_older_bridges() {
        for operation in ["terminal.list", "terminal.logs"] {
            let request: super::TerminalBridgeRequest = serde_json::from_value(serde_json::json!({
                "operation": operation, "sessionId": "a"
            }))
            .unwrap();
            let value = serde_json::to_value(request).unwrap();
            for field in ["providerKind", "input", "key", "cols", "rows", "enter"] {
                assert!(value.get(field).is_none(), "unexpected {field}");
            }
        }
    }

    #[test]
    fn terminal_mutations_require_specific_parameters_and_reject_extras() {
        fn valid(value: serde_json::Value) -> bool {
            serde_json::from_value::<super::TerminalBridgeRequest>(value)
                .is_ok_and(|request| super::validate_terminal_request(&request).is_ok())
        }
        use serde_json::json;
        for operation in [
            "terminal.write",
            "terminal.key",
            "terminal.close",
            "terminal.resize",
        ] {
            assert!(!valid(json!({"operation": operation})));
            assert!(!valid(json!({"operation": operation, "sessionId": " "})));
        }
        assert!(valid(
            json!({"operation":"terminal.write", "sessionId":"a", "input":"", "enter":true})
        ));
        assert!(!valid(
            json!({"operation":"terminal.write", "sessionId":"a"})
        ));
        assert!(!valid(
            json!({"operation":"terminal.write", "sessionId":"a", "input":"test", "key":"enter"})
        ));
        assert!(valid(
            json!({"operation":"terminal.close", "sessionId":"a"})
        ));
        assert!(!valid(
            json!({"operation":"terminal.close", "sessionId":"a", "enter":false})
        ));
        assert!(valid(
            json!({"operation":"terminal.resize", "sessionId":"a", "cols":80, "rows":24})
        ));
        for (cols, rows) in [(0, 24), (80, 0), (65536, 24)] {
            assert!(!valid(
                json!({"operation":"terminal.resize", "sessionId":"a", "cols":cols, "rows":rows})
            ));
        }
        for key in ["ctrl+c", "enter", "escape", "tab", "backspace", "ctrl+d"] {
            assert!(valid(
                json!({"operation":"terminal.key", "sessionId":"a", "key":key})
            ));
        }
        assert!(!valid(
            json!({"operation":"terminal.key", "sessionId":"a", "key":"ctrl+x"})
        ));
        for operation in ["terminal.list", "terminal.logs"] {
            let mut value = json!({"operation":operation, "input":"test"});
            if operation == "terminal.logs" {
                value["sessionId"] = json!("a");
            }
            assert!(!valid(value));
        }
        assert!(!valid(json!({"operation":"terminal.create"})));
        assert!(!valid(
            json!({"operation":"terminal.create", "projectPath":"relative"})
        ));
        let project = std::env::current_dir().unwrap();
        assert!(valid(
            json!({"operation":"terminal.create", "projectPath":project})
        ));
        assert!(!valid(
            json!({"operation":"terminal.create", "projectPath":project, "providerKind":" "})
        ));
        assert!(!valid(
            json!({"operation":"terminal.create", "projectPath":project.join("Cargo.toml")})
        ));
        assert!(!valid(
            json!({"operation":"terminal.create", "projectPath":project, "sessionId":"a"})
        ));
        assert_eq!(
            super::terminal_key_input("ctrl+c").unwrap().as_bytes(),
            &[3]
        );
        assert_eq!(super::terminal_key_input("enter").unwrap(), "\r");
    }

}
