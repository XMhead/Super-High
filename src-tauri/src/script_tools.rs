use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};
const CONFIG_RELATIVE_PATH: &str = ".superhigh/script-tools.json";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptToolsConfig {
    version: u8,
    directories: Vec<RegisteredDirectory>,
    tools: Vec<ToolManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredDirectory {
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolManifest {
    version: u8,
    id: String,
    title: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    tooltip: String,
    script: String,
    runtime: String,
    #[serde(default)]
    ui: String,
    #[serde(default = "default_tool_kind")]
    kind: String,
    #[serde(default)]
    parameters: Vec<ToolParameter>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolParameter {
    id: String,
    flag: String,
    #[serde(default)]
    required: bool,
    /// 参数类型：缺省或 "string" 按普通值拼 [flag, value]；"bool" 为布尔开关。
    /// bool 参数 true 只追加裸 flag，false 不追加，与脚本 store_true 语义一致，
    /// 避免拼出 `--flag true` 让 argparse 把 true 当成多余参数。
    #[serde(rename = "type", default)]
    parameter_type: String,
}

#[derive(Debug, Clone)]
struct DiscoveredTool {
    manifest: ToolManifest,
    script_path: PathBuf,
    ui_path: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptToolListResponse {
    pub config_path: Option<String>,
    pub directories: Vec<String>,
    pub tools: Vec<ScriptToolDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptToolDescriptor {
    pub id: String,
    pub display_name: String,
    pub tooltip: String,
    pub source_path: String,
    pub ui_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptToolRunResponse {
    pub tool_id: String,
    pub title: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn list_project_script_tools(workspace: &Path) -> anyhow::Result<ScriptToolListResponse> {
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("工作区不存在：{}", workspace.display()))?;
    let (config_path, directories, tools) = discover_tools(&workspace)?;
    Ok(ScriptToolListResponse {
        config_path: config_path.map(|path| normalize_path(&path)),
        directories: directories
            .iter()
            .map(|path| workspace_relative_path(&workspace, path))
            .collect(),
        tools: tools
            .iter()
            .map(|tool| tool_descriptor(&workspace, tool))
            .collect(),
    })
}

pub fn run_project_script_tool(
    workspace: &Path,
    tool_id: &str,
    values: &HashMap<String, String>,
) -> anyhow::Result<ScriptToolRunResponse> {
    let (_, _, tools) = discover_tools(workspace)?;
    let tool = tools
        .into_iter()
        .find(|candidate| candidate.manifest.id == tool_id)
        .with_context(|| format!("未找到已登记的脚本工具：{tool_id}"))?;
    let mut arguments = Vec::new();
    for parameter in &tool.manifest.parameters {
        let value = values
            .get(&parameter.id)
            .map(String::as_str)
            .unwrap_or("")
            .trim();
        if value.is_empty() && parameter.required {
            bail!("脚本参数不能为空：{}", parameter.id);
        }
        if !value.is_empty() {
            if parameter.parameter_type == "bool" {
                // 布尔开关：true 只追加裸 flag，false 不追加。
                let truthy = matches!(
                    value.to_ascii_lowercase().as_str(),
                    "true" | "1" | "yes" | "on"
                );
                if truthy {
                    arguments.push(parameter.flag.clone());
                }
            } else {
                arguments.push(parameter.flag.clone());
                arguments.push(value.to_string());
            }
        }
    }

    let mut command = command_for_tool(&tool, &arguments)?;
    command.current_dir(workspace);
    let output = command
        .output()
        .with_context(|| format!("无法启动脚本工具：{}", tool.manifest.title))?;
    Ok(ScriptToolRunResponse {
        tool_id: tool.manifest.id,
        title: tool.manifest.title,
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    })
}

fn discover_tools(
    workspace: &Path,
) -> anyhow::Result<(Option<PathBuf>, Vec<PathBuf>, Vec<DiscoveredTool>)> {
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("工作区不存在：{}", workspace.display()))?;
    let config_path = workspace.join(CONFIG_RELATIVE_PATH);
    if !config_path.is_file() {
        return Ok((None, Vec::new(), Vec::new()));
    }
    let config_text = fs::read_to_string(&config_path)
        .with_context(|| format!("无法读取脚本工具配置：{}", config_path.display()))?;
    let config: ScriptToolsConfig = serde_json::from_str(&config_text)
        .with_context(|| format!("脚本工具配置不是有效 JSON：{}", config_path.display()))?;
    if config.version != 1 {
        bail!("script-tools.json 仅支持 version: 1。");
    }

    let mut directories = Vec::new();
    let mut tools = Vec::new();
    let mut ids = HashMap::new();
    for registered in config.directories {
        let directory = resolve_workspace_child(&workspace, &registered.path)?;
        if is_superhigh_metadata_path(&workspace, &directory) {
            bail!("脚本目录不能位于 .superhigh 中：{}", registered.path);
        }
        if !directory.is_dir() {
            bail!("已登记的脚本目录不存在：{}", registered.path);
        }
        directories.push(directory.clone());
    }
    for manifest in config.tools {
        validate_manifest(&manifest)?;
        if let Some(previous) = ids.insert(manifest.id.clone(), manifest.script.clone()) {
            bail!(
                "脚本工具 ID 重复：{}（{} 与 {}）",
                manifest.id,
                previous,
                manifest.script
            );
        }
        let script_path = resolve_workspace_child(&workspace, &manifest.script)?;
        if !script_path.is_file() {
            bail!("已登记的工具脚本不存在：{}", manifest.script);
        }
        if !directories
            .iter()
            .any(|directory| script_path.starts_with(directory))
        {
            bail!("工具脚本必须位于已登记目录中：{}", manifest.script);
        }
        ensure_runtime_matches_script(&manifest.runtime, &script_path)?;
        let ui_path = resolve_tool_ui_path(&workspace, &manifest)?;
        tools.push(DiscoveredTool {
            manifest,
            script_path,
            ui_path,
        });
    }
    tools.sort_by(|left, right| left.manifest.title.cmp(&right.manifest.title));
    Ok((Some(config_path), directories, tools))
}

fn validate_manifest(manifest: &ToolManifest) -> anyhow::Result<()> {
    if manifest.version != 1 {
        bail!("脚本工具仅支持 version: 1：{}", manifest.id);
    }
    if !is_safe_id(&manifest.id) || manifest.title.trim().is_empty() {
        bail!("脚本工具必须提供合法的 id 和 title。");
    }
    if !matches!(manifest.kind.as_str(), "query" | "maintenance") {
        bail!("工具 kind 只能是 query 或 maintenance：{}", manifest.id);
    }
    let mut parameter_ids = HashMap::new();
    for parameter in &manifest.parameters {
        if !is_safe_id(&parameter.id) || parameter.flag.trim().is_empty() {
            bail!("工具参数必须提供合法的 id 和 flag：{}", manifest.id);
        }
        if parameter_ids.insert(&parameter.id, ()).is_some() {
            bail!("工具参数 ID 重复：{}", parameter.id);
        }
    }
    Ok(())
}

fn resolve_tool_ui_path(
    workspace: &Path,
    manifest: &ToolManifest,
) -> anyhow::Result<Option<PathBuf>> {
    let ui = manifest.ui.trim();
    if ui.is_empty() {
        return Ok(None);
    }
    let path = resolve_workspace_child(workspace, ui)?;
    if !path.starts_with(workspace.join(".superhigh")) {
        bail!("脚本扩展 UI 必须位于 .superhigh 中：{}", manifest.ui);
    }
    if !path.is_file()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
    {
        bail!("脚本扩展 UI 必须是存在的 .html 文件：{}", manifest.ui);
    }
    Ok(Some(path))
}

fn command_for_tool(tool: &DiscoveredTool, arguments: &[String]) -> anyhow::Result<Command> {
    let runtime = tool.manifest.runtime.to_ascii_lowercase();
    let mut command = match runtime.as_str() {
        "python" => {
            let mut command = Command::new("python");
            command.env("PYTHONIOENCODING", "utf-8");
            command.arg(&tool.script_path);
            command
        }
        "powershell" => {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
            command.arg(&tool.script_path);
            command
        }
        "node" => {
            let mut command = Command::new("node");
            command.arg(&tool.script_path);
            command
        }
        "cmd" => {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/C"]);
            command.arg(&tool.script_path);
            command
        }
        _ => bail!("不支持的脚本 runtime：{}", tool.manifest.runtime),
    };
    command.args(arguments);
    Ok(command)
}

fn tool_descriptor(workspace: &Path, tool: &DiscoveredTool) -> ScriptToolDescriptor {
    ScriptToolDescriptor {
        id: tool.manifest.id.clone(),
        display_name: if tool.manifest.display_name.trim().is_empty() {
            tool.manifest.title.clone()
        } else {
            tool.manifest.display_name.clone()
        },
        tooltip: tool.manifest.tooltip.clone(),
        source_path: workspace_relative_path(workspace, &tool.script_path),
        ui_path: tool
            .ui_path
            .as_ref()
            .map(|path| workspace_relative_path(workspace, path)),
    }
}

fn resolve_workspace_child(workspace: &Path, relative: &str) -> anyhow::Result<PathBuf> {
    let path = resolve_child(workspace, relative)?;
    let canonical = path
        .canonicalize()
        .with_context(|| format!("已登记路径不存在：{}", relative))?;
    if !canonical.starts_with(workspace) {
        bail!("脚本目录必须位于当前工作区内：{}", relative);
    }
    Ok(canonical)
}

fn resolve_child(parent: &Path, relative: &str) -> anyhow::Result<PathBuf> {
    if relative.trim().is_empty() || !is_safe_relative_path(relative) {
        bail!("路径必须是当前工作区内的相对路径：{relative}");
    }
    Ok(parent.join(relative))
}

fn is_superhigh_metadata_path(workspace: &Path, path: &Path) -> bool {
    path.starts_with(workspace.join(".superhigh"))
}

fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn ensure_runtime_matches_script(runtime: &str, script_path: &Path) -> anyhow::Result<()> {
    let extension = script_path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let matches = match runtime.to_ascii_lowercase().as_str() {
        "python" => extension == "py",
        "powershell" => extension == "ps1",
        "node" => matches!(extension.as_str(), "js" | "mjs" | "cjs"),
        "cmd" => matches!(extension.as_str(), "bat" | "cmd"),
        _ => false,
    };
    if !matches {
        bail!("runtime 与脚本扩展名不匹配：{}", script_path.display());
    }
    Ok(())
}

fn workspace_relative_path(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn default_tool_kind() -> String {
    "query".to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        command_for_tool, list_project_script_tools, resolve_child, DiscoveredTool, ToolManifest,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
    };

    #[test]
    fn python_commands_force_utf8_output() {
        let tool = DiscoveredTool {
            manifest: ToolManifest {
                version: 1,
                id: "utf8-check".to_string(),
                title: "UTF-8 check".to_string(),
                display_name: String::new(),
                tooltip: String::new(),
                script: "scripts/check.py".to_string(),
                runtime: "python".to_string(),
                ui: String::new(),
                kind: "query".to_string(),
                parameters: Vec::new(),
            },
            script_path: PathBuf::from("scripts/check.py"),
            ui_path: None,
        };

        let command = command_for_tool(&tool, &[]).unwrap();
        let encoding = command
            .get_envs()
            .find_map(|(key, value)| (key == "PYTHONIOENCODING").then_some(value))
            .flatten()
            .unwrap();

        assert_eq!(encoding, "utf-8");
    }

    #[test]
    fn discovers_tools_only_from_registered_directories() {
        let workspace = tempfile::tempdir().unwrap();
        let scripts = workspace.path().join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::write(
            workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"mob-report","title":"怪物查询","script":"scripts/mob_report.py","runtime":"python","parameters":[{"id":"query","label":"名称","flag":"--query","required":true}]}]}"#,
        )
        .unwrap();
        fs::write(scripts.join("mob_report.py"), "print('ok')").unwrap();

        let result = list_project_script_tools(workspace.path()).unwrap();

        assert_eq!(result.directories, vec!["scripts"]);
        assert_eq!(result.tools.len(), 1);
        assert_eq!(result.tools[0].id, "mob-report");
        assert_eq!(result.tools[0].display_name, "怪物查询");
        assert_eq!(result.tools[0].source_path, "scripts/mob_report.py");
    }

    #[test]
    fn discovers_script_ui_from_superhigh() {
        let workspace = tempfile::tempdir().unwrap();
        let scripts = workspace.path().join("scripts");
        let ui = workspace
            .path()
            .join(".superhigh/script-tools/mob-report.html");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(ui.parent().unwrap()).unwrap();
        fs::write(scripts.join("mob_report.py"), "print('ok')").unwrap();
        fs::write(&ui, "<main>UI</main>").unwrap();
        fs::write(
            workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"mob-report","title":"怪物查询","displayName":"怪物面板","script":"scripts/mob_report.py","runtime":"python","ui":".superhigh/script-tools/mob-report.html"}]}"#,
        )
        .unwrap();

        let result = list_project_script_tools(workspace.path()).unwrap();

        assert_eq!(result.tools[0].display_name, "怪物面板");
        assert!(result.tools[0].tooltip.is_empty());
        assert_eq!(
            result.tools[0].ui_path.as_deref(),
            Some(".superhigh/script-tools/mob-report.html")
        );
    }

    #[test]
    fn rejects_scripts_stored_in_superhigh_metadata_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let scripts = workspace.path().join(".superhigh/scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(
            workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":".superhigh/scripts"}],"tools":[]}"#,
        )
        .unwrap();

        let error = list_project_script_tools(workspace.path()).unwrap_err();

        assert!(error.to_string().contains("不能位于 .superhigh"));
    }

    #[test]
    fn rejects_script_ui_outside_superhigh() {
        let workspace = tempfile::tempdir().unwrap();
        let scripts = workspace.path().join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::write(scripts.join("mob_report.py"), "print('ok')").unwrap();
        fs::write(workspace.path().join("tool.html"), "<main>UI</main>").unwrap();
        fs::write(
            workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"mob-report","title":"怪物查询","script":"scripts/mob_report.py","runtime":"python","ui":"tool.html"}]}"#,
        )
        .unwrap();

        let error = list_project_script_tools(workspace.path()).unwrap_err();

        assert!(error.to_string().contains("扩展 UI 必须位于 .superhigh"));
    }

    #[test]
    fn rejects_parent_directory_paths() {
        assert!(resolve_child(Path::new("C:/workspace"), "../outside").is_err());
    }
}
