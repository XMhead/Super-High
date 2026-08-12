use std::{
    collections::HashMap,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::{
    models::TerminalSessionDto,
    project_startup::{
        ProjectServiceHealthCheckInfo, ProjectStartupInfo, ProjectStartupMode,
        ProjectStartupServiceInfo,
    },
    terminal::TerminalManager,
};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectServiceStatus {
    Starting,
    Running,
    ExternalRunning,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceRunService {
    pub service_id: String,
    pub status: ProjectServiceStatus,
    pub session: Option<TerminalSessionDto>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServicesStartResult {
    pub project_path: String,
    pub run_id: String,
    pub services: Vec<ProjectServiceRunService>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectServiceStatusEvent {
    project_path: String,
    run_id: String,
    service_id: String,
    status: ProjectServiceStatus,
    session: Option<TerminalSessionDto>,
    message: Option<String>,
}

pub fn start_project_services(
    app: &AppHandle,
    terminal: &TerminalManager,
    workspace_id: Option<String>,
    workspace: &Path,
    config: ProjectStartupInfo,
) -> anyhow::Result<ProjectServicesStartResult> {
    if config.mode != ProjectStartupMode::Services {
        bail!("project startup config is not a service chain");
    }
    let project_path = workspace.to_string_lossy().replace('\\', "/");
    let run_id = Uuid::new_v4().to_string();
    let mut results = Vec::with_capacity(config.services.len());
    let mut status_by_id = HashMap::new();

    for service in config.services {
        let dependency_failure = service.start_after.iter().find(|dependency| {
            !matches!(
                status_by_id.get(dependency.as_str()),
                Some(ProjectServiceStatus::Running | ProjectServiceStatus::ExternalRunning)
            )
        });
        if let Some(dependency) = dependency_failure {
            let result = report(
                app,
                &project_path,
                &run_id,
                &service.id,
                ProjectServiceStatus::Failed,
                None,
                Some(format!("依赖服务 {dependency} 未就绪")),
            )?;
            status_by_id.insert(service.id.clone(), result.status.clone());
            results.push(result);
            continue;
        }

        if service.health_check.as_ref().is_some_and(tcp_health_check) {
            let result = report(
                app,
                &project_path,
                &run_id,
                &service.id,
                ProjectServiceStatus::ExternalRunning,
                None,
                Some("检测到端口已在监听，未重复启动".to_string()),
            )?;
            status_by_id.insert(service.id.clone(), result.status.clone());
            results.push(result);
            continue;
        }

        report(
            app,
            &project_path,
            &run_id,
            &service.id,
            ProjectServiceStatus::Starting,
            None,
            None,
        )?;
        let session = match start_service_terminal(app, terminal, workspace_id.clone(), &service) {
            Ok(session) => session,
            Err(error) => {
                let result = report(
                    app,
                    &project_path,
                    &run_id,
                    &service.id,
                    ProjectServiceStatus::Failed,
                    None,
                    Some(error.to_string()),
                )?;
                status_by_id.insert(service.id.clone(), result.status.clone());
                results.push(result);
                continue;
            }
        };
        let ready = service
            .health_check
            .as_ref()
            .map(wait_for_tcp_health_check)
            .transpose();
        let result = match ready {
            Ok(Some(())) | Ok(None) => report(
                app,
                &project_path,
                &run_id,
                &service.id,
                ProjectServiceStatus::Running,
                Some(session),
                None,
            )?,
            Err(error) => report(
                app,
                &project_path,
                &run_id,
                &service.id,
                ProjectServiceStatus::Failed,
                Some(session),
                Some(error.to_string()),
            )?,
        };
        status_by_id.insert(service.id.clone(), result.status.clone());
        results.push(result);
    }

    Ok(ProjectServicesStartResult {
        project_path,
        run_id,
        services: results,
    })
}

fn start_service_terminal(
    app: &AppHandle,
    terminal: &TerminalManager,
    workspace_id: Option<String>,
    service: &ProjectStartupServiceInfo,
) -> anyhow::Result<TerminalSessionDto> {
    let cwd = Path::new(&service.working_directory);
    if let Some(script_path) = &service.script_path {
        terminal.create_script_session_for_workspace(
            app,
            workspace_id,
            "project-service",
            &service.name,
            Path::new(script_path),
            cwd,
        )
    } else if let Some(command_path) = &service.command_path {
        terminal.create_command_session_for_workspace(
            app,
            workspace_id,
            "project-service",
            &service.name,
            Path::new(command_path),
            &service.args,
            cwd,
        )
    } else {
        bail!("service {} has no launch path", service.id)
    }
}

fn report(
    app: &AppHandle,
    project_path: &str,
    run_id: &str,
    service_id: &str,
    status: ProjectServiceStatus,
    session: Option<TerminalSessionDto>,
    message: Option<String>,
) -> anyhow::Result<ProjectServiceRunService> {
    let event = ProjectServiceStatusEvent {
        project_path: project_path.to_string(),
        run_id: run_id.to_string(),
        service_id: service_id.to_string(),
        status: status.clone(),
        session: session.clone(),
        message: message.clone(),
    };
    app.emit("project-service-status", event)
        .context("emit project service status")?;
    Ok(ProjectServiceRunService {
        service_id: service_id.to_string(),
        status,
        session,
        message,
    })
}

fn tcp_health_check(check: &ProjectServiceHealthCheckInfo) -> bool {
    resolve_socket_address(check)
        .map(|address| TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok())
        .unwrap_or(false)
}

fn wait_for_tcp_health_check(check: &ProjectServiceHealthCheckInfo) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_millis(check.timeout_ms);
    while Instant::now() < deadline {
        if tcp_health_check(check) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    bail!("等待 {}:{} 就绪超时", check.host, check.port)
}

fn resolve_socket_address(check: &ProjectServiceHealthCheckInfo) -> anyhow::Result<SocketAddr> {
    (check.host.as_str(), check.port)
        .to_socket_addrs()
        .with_context(|| format!("解析服务地址 {}:{}", check.host, check.port))?
        .next()
        .context("服务地址没有可用的 TCP 地址")
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::{tcp_health_check, ProjectServiceHealthCheckInfo};

    #[test]
    fn tcp_health_check_detects_open_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let check = ProjectServiceHealthCheckInfo {
            kind: "tcp".to_string(),
            host: "127.0.0.1".to_string(),
            port: listener.local_addr().unwrap().port(),
            timeout_ms: 1000,
        };
        assert!(tcp_health_check(&check));
    }

    #[test]
    fn tcp_health_check_reports_closed_port() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let check = ProjectServiceHealthCheckInfo {
            kind: "tcp".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            timeout_ms: 1000,
        };
        assert!(!tcp_health_check(&check));
    }
}
