use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    project_services::{self, ProjectServiceStatus, ProjectServicesStartResult},
    project_startup::{self, ProjectStartupMode},
    project_terminal_actions,
    terminal::SharedTerminalManager,
};

const PIPE_NAME: &str = r"\\.\pipe\SuperHigh.ServiceControl.v1";
const SCHEMA: &str = "superhigh-service-control-v1";

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

fn validate_terminal_request(request: &TerminalBridgeRequest) -> anyhow::Result<()> {
    if let Some(project) = &request.project_path {
        anyhow::ensure!(
            Path::new(project).is_absolute(),
            "invalid bridge request: projectPath must be absolute"
        );
    }
    match request.operation.as_str() {
        "terminal.list" => anyhow::ensure!(
            request.session_id.is_none() && request.tail.is_none(),
            "invalid bridge request: list does not accept sessionId or tail"
        ),
        "terminal.logs" => {
            anyhow::ensure!(
                request
                    .session_id
                    .as_deref()
                    .is_some_and(|id| !id.trim().is_empty()),
                "invalid bridge request: logs requires sessionId"
            );
            anyhow::ensure!(
                (1..=TERMINAL_MAX_TAIL).contains(&request.tail.unwrap_or(TERMINAL_DEFAULT_TAIL)),
                "invalid bridge request: tail must be between 1 and {TERMINAL_MAX_TAIL}"
            );
        }
        _ => bail!("invalid bridge operation: {}", request.operation),
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

fn execute_terminal_request(terminal: &SharedTerminalManager, raw: &str) -> TerminalBridgeResponse {
    let result = (|| -> anyhow::Result<TerminalBridgeResponse> {
        let request: TerminalBridgeRequest =
            serde_json::from_str(raw).context("invalid bridge request")?;
        validate_terminal_request(&request)?;
        let sessions = terminal.inspect_sessions(request.project_path.as_deref().map(Path::new))?;
        if request.operation == "terminal.list" {
            return Ok(TerminalBridgeResponse {
                ok: true,
                sessions: Some(sessions),
                logs: None,
                error: None,
            });
        }
        let session_id = request
            .session_id
            .context("invalid bridge request: logs requires sessionId")?;
        anyhow::ensure!(
            sessions.iter().any(|session| session.id == session_id),
            "terminal session not found in requested project"
        );
        let snapshot = terminal.terminal_buffer(&session_id)?;
        let logs = terminal_log_tail(
            session_id,
            snapshot,
            request.tail.unwrap_or(TERMINAL_DEFAULT_TAIL),
        );
        Ok(TerminalBridgeResponse {
            ok: true,
            sessions: None,
            logs: Some(logs),
            error: None,
        })
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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBridgeRequest {
    pub operation: String,
    pub project_path: String,
    #[serde(default)]
    pub service_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBridgeResponse {
    pub ok: bool,
    pub receipt: Option<ServiceBridgeReceipt>,
    pub error: Option<ServiceBridgeError>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBridgeReceipt {
    pub schema: String,
    pub ok: bool,
    pub operation: String,
    pub changed: bool,
    pub summary: String,
    pub project_path: String,
    pub services: Vec<ServiceBridgeService>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceBridgeService {
    pub service_id: String,
    pub status: String,
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_exited: Option<bool>,
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

pub fn send_request(request: &ServiceBridgeRequest) -> anyhow::Result<ServiceBridgeResponse> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::block_on(send_request_async(request));
    }
    #[cfg(not(windows))]
    {
        let _ = request;
        bail!("bridge unavailable: Super High service control is only available on Windows")
    }
}

fn parse_request(raw: &str) -> anyhow::Result<ServiceBridgeRequest> {
    let request: ServiceBridgeRequest =
        serde_json::from_str(raw).context("invalid bridge request")?;
    if !matches!(
        request.operation.as_str(),
        "status" | "start" | "restart"
    ) {
        bail!("invalid bridge operation: {}", request.operation);
    }
    if request.project_path.trim().is_empty() {
        bail!("invalid bridge request: projectPath is required");
    }
    Ok(request)
}

fn execute_request(
    app: &AppHandle,
    terminal: &SharedTerminalManager,
    request: ServiceBridgeRequest,
) -> ServiceBridgeResponse {
    match execute_request_inner(app, terminal, &request) {
        Ok(receipt) => ServiceBridgeResponse {
            ok: true,
            receipt: Some(receipt),
            error: None,
        },
        Err(error) => ServiceBridgeResponse {
            ok: false,
            receipt: None,
            error: Some(ServiceBridgeError {
                kind: error_kind(&error.to_string()).to_string(),
                message: error.to_string(),
            }),
        },
    }
}

fn execute_request_inner(
    app: &AppHandle,
    terminal: &SharedTerminalManager,
    request: &ServiceBridgeRequest,
) -> anyhow::Result<ServiceBridgeReceipt> {
    let workspace = Path::new(request.project_path.trim());
    if !workspace.is_absolute() {
        bail!("invalid bridge request: projectPath must be absolute");
    }
    let config = project_startup::load_project_startup_config(workspace)?;
    if config
        .as_ref()
        .is_some_and(|config| config.mode != ProjectStartupMode::Services)
    {
        bail!("project startup config is not a service chain");
    }
    let selected_service = if request.operation == "status" && request.service_id.is_none() {
        None
    } else {
        selected_service_id(
            config.as_ref(),
            request.service_id.as_deref(),
        )?
    };

    match request.operation.as_str() {
        "status" => status_receipt(
            request,
            terminal,
            config.as_ref(),
            selected_service.as_deref(),
        ),
        "start" => {
            let config = config.context("project startup config not found")?;
            let started =
                project_services::start_project_services(app, terminal, None, workspace, config)?;
            Ok(start_receipt(
                request,
                started,
                "服务链已交给 Super High 本地终端启动",
            ))
        }
        "restart" => {
            let service_id = selected_service
                .context("restart requires --service because this project has multiple services")?;
            let action = project_terminal_actions::load_project_terminal_actions(workspace)?
                .into_iter()
                .find(|action| {
                    action.kind == "restart-project"
                        && action.service_id.as_deref() == Some(service_id.as_str())
                });
            let input = action
                .as_ref()
                .and_then(|action| action.input.as_deref())
                .unwrap_or("stop");
            let delay = action
                .as_ref()
                .map(|action| action.restart_delay_ms)
                .unwrap_or(5_000);
            let started = project_services::restart_project_service(
                app,
                terminal,
                None,
                workspace,
                Some(&service_id),
                &format!("{input}\r"),
                Duration::from_millis(delay),
            )?;
            Ok(start_receipt(
                request,
                started,
                "已重启托管服务并重新启动服务链",
            ))
        }
        _ => unreachable!("parse_request validates the operation"),
    }
}

fn selected_service_id(
    config: Option<&project_startup::ProjectStartupInfo>,
    requested_service_id: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let Some(service_id) = requested_service_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(config
            .filter(|config| config.services.len() == 1)
            .map(|config| config.services[0].id.clone()));
    };
    if !config.is_some_and(|config| {
        config
            .services
            .iter()
            .any(|service| service.id == service_id)
    }) {
        bail!("unknown service: {service_id}");
    }
    Ok(Some(service_id.to_string()))
}

fn status_receipt(
    request: &ServiceBridgeRequest,
    terminal: &SharedTerminalManager,
    config: Option<&project_startup::ProjectStartupInfo>,
    selected_service_id: Option<&str>,
) -> anyhow::Result<ServiceBridgeReceipt> {
    let services = config
        .map(|config| config.services.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|service| selected_service_id.map_or(true, |id| service.id == id))
        .map(|service| {
            let managed = terminal
                .find_live_project_service_session(
                    &service.name,
                    Path::new(&service.working_directory),
                )
                .is_some();
            ServiceBridgeService {
                service_id: service.id.clone(),
                status: if managed { "managed" } else { "stopped" }.to_string(),
                message: None,
                process_id: None,
                process_exited: None,
            }
        })
        .collect::<Vec<_>>();
    let active_count = services
        .iter()
        .filter(|service| matches!(service.status.as_str(), "managed" | "running" | "starting"))
        .count();
    Ok(ServiceBridgeReceipt {
        schema: SCHEMA.to_string(),
        ok: true,
        operation: request.operation.clone(),
        changed: false,
        summary: format!(
            "bridge ready; {active_count}/{} configured services are active",
            services.len()
        ),
        project_path: request.project_path.clone(),
        services,
    })
}

fn start_receipt(
    request: &ServiceBridgeRequest,
    result: ProjectServicesStartResult,
    summary: &str,
) -> ServiceBridgeReceipt {
    ServiceBridgeReceipt {
        schema: SCHEMA.to_string(),
        ok: true,
        operation: request.operation.clone(),
        changed: true,
        summary: summary.to_string(),
        project_path: result.project_path,
        services: result
            .services
            .into_iter()
            .map(|service| ServiceBridgeService {
                service_id: service.service_id,
                status: project_service_status_name(&service.status).to_string(),
                message: service.message,
                process_id: None,
                process_exited: None,
            })
            .collect(),
    }
}

fn project_service_status_name(status: &ProjectServiceStatus) -> &'static str {
    match status {
        ProjectServiceStatus::Starting => "starting",
        ProjectServiceStatus::Running => "running",
        ProjectServiceStatus::ExternalRunning => "externalRunning",
        ProjectServiceStatus::Failed => "failed",
    }
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
            eprintln!("[Super High] local service bridge unavailable (another instance may own it): {error}");
            return;
        }
    };
    loop {
        if let Err(error) = server.connect().await {
            eprintln!("[Super High] local service bridge connection failed: {error}");
            continue;
        }
        let connected = server;
        server = match ServerOptions::new().create(PIPE_NAME) {
            Ok(server) => server,
            Err(error) => {
                eprintln!("[Super High] local service bridge could not create next pipe instance: {error}");
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
                let response =
                    tokio::task::spawn_blocking(move || execute_terminal_request(&terminal, &raw))
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
            match parse_request(&raw) {
                Ok(request) => {
                    tokio::task::spawn_blocking(move || execute_request(&app, &terminal, request))
                        .await
                        .unwrap_or_else(|error| ServiceBridgeResponse {
                            ok: false,
                            receipt: None,
                            error: Some(ServiceBridgeError {
                                kind: "request_failed".to_string(),
                                message: format!("bridge request task failed: {error}"),
                            }),
                        })
                }
                Err(error) => ServiceBridgeResponse {
                    ok: false,
                    receipt: None,
                    error: Some(ServiceBridgeError {
                        kind: error_kind(&error.to_string()).to_string(),
                        message: error.to_string(),
                    }),
                },
            }
        }
        Err(error) => ServiceBridgeResponse {
            ok: false,
            receipt: None,
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
async fn send_request_async<T: Serialize, R: serde::de::DeserializeOwned>(
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

#[cfg(windows)]
fn classify_connection_error(error: std::io::Error) -> anyhow::Error {
    let kind = error.kind();
    let code = error.raw_os_error();
    if matches!(
        kind,
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
    ) || matches!(code, Some(2 | 233))
    {
        anyhow::anyhow!("bridge unavailable: start a newer Super High and retry")
    } else if matches!(kind, std::io::ErrorKind::WouldBlock) || matches!(code, Some(231)) {
        anyhow::anyhow!(
            "bridge busy: Super High is handling another service request; retry shortly"
        )
    } else {
        anyhow::anyhow!("bridge unavailable: {error}")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn terminal_tail_preserves_utf8_offsets_and_line_endings() {
        let text = "one\r\n你好\r\nlast";
        let snapshot = crate::models::TerminalBufferSnapshot {
            buffer: text.into(),
            start_byte: 10,
            end_byte: 10 + text.len() as u64,
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
        };
        let logs = super::terminal_log_tail("id".into(), snapshot, 100);
        assert!(logs.text.len() <= super::TERMINAL_LOG_BYTE_LIMIT);
        assert_eq!(logs.text, text[logs.start_byte as usize..]);
    }

    #[test]
    fn terminal_requests_reject_write_operations_and_invalid_tail() {
        let mut request = super::TerminalBridgeRequest {
            operation: "terminal.input".into(),
            project_path: None,
            session_id: Some("a".into()),
            tail: None,
        };
        assert!(super::validate_terminal_request(&request).is_err());
        request.operation = "terminal.logs".into();
        assert!(super::validate_terminal_request(&request).is_ok());
        request.tail = Some(0);
        assert!(super::validate_terminal_request(&request).is_err());
    }
    use super::{
        parse_request, selected_service_id, ServiceBridgeRequest,
    };
    use crate::project_startup::{
        ProjectStartupInfo, ProjectStartupMode, ProjectStartupServiceInfo,
    };

    fn config() -> ProjectStartupInfo {
        ProjectStartupInfo {
            name: "Test".to_string(),
            mode: ProjectStartupMode::Services,
            script_path: None,
            working_directory: None,
            services: vec![ProjectStartupServiceInfo {
                id: "server".to_string(),
                name: "Server".to_string(),
                script_path: Some("D:/server/start.bat".to_string()),
                command_path: None,
                args: Vec::new(),
                working_directory: "D:/server".to_string(),
                start_after: Vec::new(),
                health_check: None,
            }],
        }
    }

    #[test]
    fn parses_restart_request() {
        let request = parse_request(
            r#"{"operation":"restart","projectPath":"D:/server","serviceId":"server"}"#,
        )
        .unwrap();
        assert_eq!(request.operation, "restart");
        assert_eq!(request.service_id.as_deref(), Some("server"));
    }


    #[test]
    fn rejects_unknown_service() {
        let error = selected_service_id(Some(&config()), Some("missing")).unwrap_err();
        assert!(error.to_string().starts_with("unknown service:"));
    }


    #[test]
    fn request_serializes_with_camel_case_fields() {
        let request = ServiceBridgeRequest {
            operation: "status".to_string(),
            project_path: "D:/server".to_string(),
            service_id: Some("server".to_string()),
        };
        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("projectPath"));
        assert!(json.contains("serviceId"));
    }
}
