use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::fs_ops::normalize_path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStartupInfo {
    pub name: String,
    pub mode: ProjectStartupMode,
    pub script_path: Option<String>,
    pub working_directory: Option<String>,
    pub services: Vec<ProjectStartupServiceInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProjectStartupMode {
    Single,
    Services,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStartupServiceInfo {
    pub id: String,
    pub name: String,
    pub script_path: Option<String>,
    pub command_path: Option<String>,
    pub args: Vec<String>,
    pub working_directory: String,
    pub start_after: Vec<String>,
    pub health_check: Option<ProjectServiceHealthCheckInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectServiceHealthCheckInfo {
    pub kind: String,
    pub host: String,
    pub port: u16,
    pub timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ProjectConfigFile {
    version: u32,
    startup: Option<ProjectStartupConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStartupConfig {
    name: Option<String>,
    script: Option<String>,
    working_directory: Option<String>,
    #[serde(default)]
    services: Vec<ProjectStartupServiceConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectStartupServiceConfig {
    id: String,
    name: Option<String>,
    script: Option<String>,
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    working_directory: Option<String>,
    #[serde(default)]
    start_after: Vec<String>,
    health_check: Option<ProjectServiceHealthCheckConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectServiceHealthCheckConfig {
    #[serde(rename = "type")]
    kind: String,
    host: Option<String>,
    port: u16,
    timeout_ms: Option<u64>,
}

pub fn load_project_startup_config(workspace: &Path) -> anyhow::Result<Option<ProjectStartupInfo>> {
    let config_path = workspace.join(".superhigh").join("project.json");
    if !config_path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&config_path)
        .with_context(|| format!("read project startup config {}", config_path.display()))?;
    let config: ProjectConfigFile = serde_json::from_str(&raw)
        .with_context(|| format!("parse project startup config {}", config_path.display()))?;
    if config.version != 1 {
        bail!(
            "unsupported project startup config version {}",
            config.version
        );
    }

    let Some(startup) = config.startup else {
        return Ok(None);
    };
    let name = startup
        .name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "项目服务端".to_string());
    let script = startup
        .script
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if script.is_some() && !startup.services.is_empty() {
        bail!("startup config must use either script or services, not both");
    }

    if let Some(script) = script {
        let script_path = canonical_file(workspace, &script, "startup script")?;
        let working_directory = canonical_directory(
            workspace,
            startup.working_directory.as_deref(),
            script_path.parent(),
            "startup working directory",
        )?;
        return Ok(Some(ProjectStartupInfo {
            name,
            mode: ProjectStartupMode::Single,
            script_path: Some(normalize_path(&script_path)),
            working_directory: Some(normalize_path(&working_directory)),
            services: Vec::new(),
        }));
    }

    if startup.services.is_empty() {
        bail!("startup config requires script or non-empty services");
    }

    let services = startup
        .services
        .into_iter()
        .map(|service| normalize_service(workspace, service))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let services = order_services(services)?;
    Ok(Some(ProjectStartupInfo {
        name,
        mode: ProjectStartupMode::Services,
        script_path: None,
        working_directory: None,
        services,
    }))
}

fn normalize_service(
    workspace: &Path,
    service: ProjectStartupServiceConfig,
) -> anyhow::Result<ProjectStartupServiceInfo> {
    let id = service.id.trim().to_string();
    if id.is_empty() {
        bail!("service id must not be empty");
    }
    let script = service
        .script
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let command = service
        .command
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if script.is_some() == command.is_some() {
        bail!("service {id} must define exactly one of script or command");
    }
    if script.is_some() && !service.args.is_empty() {
        bail!("service {id} args are only supported with command");
    }

    let script_path = script
        .as_deref()
        .map(|value| canonical_file(workspace, value, &format!("service {id} script")))
        .transpose()?;
    let command_path = command
        .as_deref()
        .map(|value| canonical_file(workspace, value, &format!("service {id} command")))
        .transpose()?;
    let executable_path = script_path
        .as_deref()
        .or(command_path.as_deref())
        .expect("validated executable path");
    let working_directory = canonical_directory(
        workspace,
        service.working_directory.as_deref(),
        executable_path.parent(),
        &format!("service {id} working directory"),
    )?;
    let health_check = service
        .health_check
        .map(normalize_health_check)
        .transpose()?;

    Ok(ProjectStartupServiceInfo {
        name: service
            .name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| id.clone()),
        id,
        script_path: script_path.as_ref().map(|path| normalize_path(path)),
        command_path: command_path.as_ref().map(|path| normalize_path(path)),
        args: service.args,
        working_directory: normalize_path(&working_directory),
        start_after: service
            .start_after
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect(),
        health_check,
    })
}

fn normalize_health_check(
    value: ProjectServiceHealthCheckConfig,
) -> anyhow::Result<ProjectServiceHealthCheckInfo> {
    if !value.kind.eq_ignore_ascii_case("tcp") {
        bail!("unsupported service health check type: {}", value.kind);
    }
    Ok(ProjectServiceHealthCheckInfo {
        kind: "tcp".to_string(),
        host: value
            .host
            .map(|host| host.trim().to_string())
            .filter(|host| !host.is_empty())
            .unwrap_or_else(|| "127.0.0.1".to_string()),
        port: value.port,
        timeout_ms: value.timeout_ms.unwrap_or(60_000).clamp(1_000, 300_000),
    })
}

fn canonical_file(workspace: &Path, value: &str, label: &str) -> anyhow::Result<PathBuf> {
    let path = resolve_workspace_path(workspace, value);
    if !path.is_file() {
        bail!("{label} not found: {}", path.display());
    }
    fs::canonicalize(&path).with_context(|| format!("resolve {label} {}", path.display()))
}

fn canonical_directory(
    workspace: &Path,
    value: Option<&str>,
    default: Option<&Path>,
    label: &str,
) -> anyhow::Result<PathBuf> {
    let path = value
        .map(|value| resolve_workspace_path(workspace, value))
        .or_else(|| default.map(Path::to_path_buf))
        .unwrap_or_else(|| workspace.to_path_buf());
    if !path.is_dir() {
        bail!("{label} not found: {}", path.display());
    }
    fs::canonicalize(&path).with_context(|| format!("resolve {label} {}", path.display()))
}

fn order_services(
    services: Vec<ProjectStartupServiceInfo>,
) -> anyhow::Result<Vec<ProjectStartupServiceInfo>> {
    let indexes = services
        .iter()
        .enumerate()
        .map(|(index, service)| (service.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    if indexes.len() != services.len() {
        bail!("service ids must be unique");
    }
    for service in &services {
        for dependency in &service.start_after {
            if !indexes.contains_key(dependency.as_str()) {
                bail!(
                    "service {} depends on missing service {}",
                    service.id,
                    dependency
                );
            }
        }
    }

    fn visit(
        index: usize,
        services: &[ProjectStartupServiceInfo],
        indexes: &HashMap<&str, usize>,
        states: &mut [u8],
        ordered: &mut Vec<usize>,
    ) -> anyhow::Result<()> {
        match states[index] {
            1 => bail!("service dependency cycle includes {}", services[index].id),
            2 => return Ok(()),
            _ => {}
        }
        states[index] = 1;
        for dependency in &services[index].start_after {
            visit(
                indexes[dependency.as_str()],
                services,
                indexes,
                states,
                ordered,
            )?;
        }
        states[index] = 2;
        ordered.push(index);
        Ok(())
    }

    let mut states = vec![0; services.len()];
    let mut ordered = Vec::with_capacity(services.len());
    for index in 0..services.len() {
        visit(index, &services, &indexes, &mut states, &mut ordered)?;
    }
    Ok(ordered
        .into_iter()
        .map(|index| services[index].clone())
        .collect())
}

fn resolve_workspace_path(workspace: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::{load_project_startup_config, ProjectStartupMode};

    #[test]
    fn missing_project_config_returns_none() {
        let directory = tempfile::tempdir().unwrap();
        assert!(load_project_startup_config(directory.path())
            .unwrap()
            .is_none());
    }

    #[test]
    fn single_script_config_still_loads() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("plugins");
        fs::create_dir_all(workspace.join(".superhigh")).unwrap();
        fs::write(directory.path().join("start.bat"), "@echo off\r\n").unwrap();
        fs::write(
            workspace.join(".superhigh/project.json"),
            r#"{"version":1,"startup":{"script":"../start.bat","workingDirectory":".."}}"#,
        )
        .unwrap();
        let config = load_project_startup_config(&workspace).unwrap().unwrap();
        assert_eq!(config.mode, ProjectStartupMode::Single);
        assert_eq!(
            PathBuf::from(config.script_path.unwrap()),
            directory.path().join("start.bat")
        );
        assert!(config.services.is_empty());
    }

    #[test]
    fn services_config_orders_dependencies_and_resolves_paths() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("plugins");
        fs::create_dir_all(workspace.join(".superhigh")).unwrap();
        fs::write(directory.path().join("mysql.exe"), "").unwrap();
        fs::write(directory.path().join("redis.bat"), "@echo off\r\n").unwrap();
        fs::write(directory.path().join("main.bat"), "@echo off\r\n").unwrap();
        fs::write(workspace.join(".superhigh/project.json"), r#"{
          "version": 1, "startup": {"name":"Stack", "services": [
            {"id":"main","script":"../main.bat","workingDirectory":"..","startAfter":["mysql","redis"],"healthCheck":{"type":"tcp","port":32271}},
            {"id":"mysql","command":"../mysql.exe","workingDirectory":"..","healthCheck":{"type":"tcp","port":3306}},
            {"id":"redis","script":"../redis.bat","workingDirectory":".."}
          ]}}
        "#).unwrap();
        let config = load_project_startup_config(&workspace).unwrap().unwrap();
        assert_eq!(config.mode, ProjectStartupMode::Services);
        assert_eq!(
            config
                .services
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["mysql", "redis", "main"]
        );
        assert_eq!(
            PathBuf::from(config.services[0].command_path.clone().unwrap()),
            directory.path().join("mysql.exe")
        );
        assert_eq!(
            config.services[2].health_check.as_ref().unwrap().timeout_ms,
            60_000
        );
    }

    #[test]
    fn mixed_or_invalid_dependencies_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("plugins");
        fs::create_dir_all(workspace.join(".superhigh")).unwrap();
        fs::write(directory.path().join("start.bat"), "@echo off\r\n").unwrap();
        fs::write(workspace.join(".superhigh/project.json"), r#"{"version":1,"startup":{"script":"../start.bat","services":[{"id":"a","script":"../start.bat"}]}}"#).unwrap();
        assert!(load_project_startup_config(&workspace)
            .unwrap_err()
            .to_string()
            .contains("either script or services"));
    }
}
