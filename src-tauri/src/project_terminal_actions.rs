use std::{fs, path::Path};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTerminalAction {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub tooltip: Option<String>,
    pub service_id: Option<String>,
    pub input: Option<String>,
    pub start_after_command: bool,
    pub restart_delay_ms: u64,
    pub operation: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTerminalActionsFile {
    version: u32,
    #[serde(default)]
    actions: Vec<ProjectTerminalActionConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectTerminalActionConfig {
    id: String,
    label: String,
    kind: String,
    tooltip: Option<String>,
    service_id: Option<String>,
    input: Option<String>,
    #[serde(default)]
    start_after_command: bool,
    restart_delay_ms: Option<u64>,
    operation: Option<String>,
}

// 读取当前工作区的本地终端动作配置；缺失文件表示隐藏动作按钮。
pub fn load_project_terminal_actions(
    workspace: &Path,
) -> anyhow::Result<Vec<ProjectTerminalAction>> {
    let config_path = workspace.join(".superhigh").join("terminal-actions.json");
    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&config_path)
        .with_context(|| format!("读取本地终端动作配置 {}", config_path.display()))?;
    let config: ProjectTerminalActionsFile = serde_json::from_str(&raw)
        .with_context(|| format!("解析本地终端动作配置 {}", config_path.display()))?;
    if config.version != 1 {
        bail!("不支持的本地终端动作配置版本 {}", config.version);
    }

    config
        .actions
        .into_iter()
        .map(normalize_action)
        .collect::<anyhow::Result<Vec<_>>>()
}

// 规范化单个动作，保证前端拿到的按钮都是可执行的紧凑结构。
fn normalize_action(action: ProjectTerminalActionConfig) -> anyhow::Result<ProjectTerminalAction> {
    let id = trim_required(action.id, "action id")?;
    if !id
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        bail!("action id 只能包含字母、数字、- 或 _: {id}");
    }

    let label = trim_required(action.label, &format!("action {id} label"))?;
    let kind = trim_required(action.kind, &format!("action {id} kind"))?;
    match kind.as_str() {
        "start-project" | "restart-project" | "minecraft-client" => {}
        _ => bail!("action {id} 使用了未知 kind: {kind}"),
    }

    let operation = action
        .operation
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if kind == "minecraft-client" {
        let op = operation.as_deref().unwrap_or("start");
        match op {
            "start" | "stop" | "restart" | "release" | "status" => {}
            _ => bail!("action {id} 使用了未知 Minecraft operation: {op}"),
        }
    }

    Ok(ProjectTerminalAction {
        id,
        label,
        kind,
        tooltip: action
            .tooltip
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        service_id: action
            .service_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        input: action
            .input
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        start_after_command: action.start_after_command,
        restart_delay_ms: action.restart_delay_ms.unwrap_or(5_000).clamp(500, 120_000),
        operation,
    })
}

// 提取必填字符串，错误信息直接指向配置字段。
fn trim_required(value: String, label: &str) -> anyhow::Result<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        bail!("{label} 不能为空");
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::load_project_terminal_actions;

    #[test]
    fn missing_terminal_actions_returns_empty_list() {
        let workspace = tempfile::tempdir().unwrap();
        assert!(load_project_terminal_actions(workspace.path())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn loads_valid_terminal_actions() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::write(
            workspace.path().join(".superhigh").join("terminal-actions.json"),
            r#"{
              "version": 1,
              "actions": [
                {"id":"start","label":"启动服务端","kind":"start-project"},
                {"id":"restart","label":"重启主服","kind":"restart-project","serviceId":"server","input":"stop","startAfterCommand":true}
              ]
            }"#,
        )
        .unwrap();

        let actions = load_project_terminal_actions(workspace.path()).unwrap();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[1].service_id.as_deref(), Some("server"));
        assert!(actions[1].start_after_command);
    }
}
