use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
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
    description: String,
    #[serde(default)]
    output: Option<ToolOutputContract>,
    #[serde(default)]
    examples: Vec<HashMap<String, String>>,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    tooltip: String,
    /// Internal tools can be invoked by editor integrations without appearing
    /// in the user-facing script toolbox.
    #[serde(default)]
    hidden: bool,
    script: String,
    runtime: String,
    #[serde(default)]
    ui: String,
    #[serde(default = "default_tool_kind")]
    kind: String,
    #[serde(default)]
    parameters: Vec<ToolParameter>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolParameter {
    pub id: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub flag: String,
    /// 位置参数从 0 开始连续编号；未设置时保持原有 flag 参数行为。
    #[serde(default)]
    pub position: Option<usize>,
    /// 固定位置 token，例如子命令 `build`。只允许与 position 一起使用。
    #[serde(default)]
    pub literal: Option<String>,
    #[serde(default)]
    pub required: bool,
    /// 参数类型：缺省或 "string" 按普通值拼 [flag, value]；"bool" 为布尔开关。
    /// bool 参数 true 只追加裸 flag，false 不追加，与脚本 store_true 语义一致，
    /// 避免拼出 `--flag true` 让 argparse 把 true 当成多余参数。
    #[serde(rename = "type", default)]
    pub parameter_type: String,
}

/// Documentation for stdout; schema is descriptive, not a runtime validator.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutputContract {
    pub format: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub schema: Option<serde_json::Value>,
    #[serde(default)]
    pub example: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
struct DiscoveredTool {
    manifest: ToolManifest,
    script_path: PathBuf,
    ui_path: Option<PathBuf>,
    scope: String,
    registry_path: PathBuf,
    base_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptToolListResponse {
    pub config_path: Option<String>,
    pub global_config_path: Option<String>,
    pub directories: Vec<String>,
    pub tools: Vec<ScriptToolDescriptor>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptToolDescriptor {
    pub id: String,
    pub title: String,
    pub description: String,
    pub runtime: String,
    pub kind: String,
    pub output: Option<ToolOutputContract>,
    pub examples: Vec<HashMap<String, String>>,
    pub display_name: String,
    pub tooltip: String,
    pub source_path: String,
    pub scope: String,
    pub registry_path: String,
    pub base_path: String,
    pub source_absolute_path: String,
    pub ui_absolute_path: Option<String>,
    pub ui_path: Option<String>,
    pub hidden: bool,
    pub parameters: Vec<ToolParameter>,
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

#[derive(Debug, Clone, Serialize)]
pub struct ScriptToolProgress {
    pub stream: String,
    pub chunk: String,
}

pub fn list_project_script_tools(workspace: &Path) -> anyhow::Result<ScriptToolListResponse> {
    inspect_project_script_tools(workspace, false)
}

pub fn inspect_project_script_tools(workspace: &Path, include_hidden: bool) -> anyhow::Result<ScriptToolListResponse> {
    inspect_script_tools(workspace, include_hidden, "effective")
}

pub fn inspect_script_tools(workspace: &Path, include_hidden: bool, scope: &str) -> anyhow::Result<ScriptToolListResponse> {
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("工作区不存在：{}", workspace.display()))?;
    let global_root = crate::cli_workspace::app_data_path()?;
    let (config_path, directories, tools) = discover_scoped_tools(&workspace, &global_root, scope)?;
    Ok(ScriptToolListResponse {
        config_path: config_path.map(|path| normalize_path(&path)),
        global_config_path: global_root.join("script-tools.json").is_file().then(|| normalize_path(&global_root.join("script-tools.json"))),
        directories: directories
            .iter()
            .map(|path| workspace_relative_path(&workspace, path))
            .collect(),
        tools: tools
            .iter()
            .filter(|tool| include_hidden || !tool.manifest.hidden)
            .map(|tool| tool_descriptor(&workspace, tool))
            .collect(),
    })
}

pub fn run_project_script_tool(
    workspace: &Path,
    tool_id: &str,
    values: &HashMap<String, String>,
) -> anyhow::Result<ScriptToolRunResponse> {
    run_project_script_tool_inner(workspace, tool_id, values, false, "effective", &|_| {})
}

pub fn run_project_script_tool_streaming(
    workspace: &Path,
    tool_id: &str,
    values: &HashMap<String, String>,
    progress: &(dyn Fn(ScriptToolProgress) + Sync),
) -> anyhow::Result<ScriptToolRunResponse> {
    run_project_script_tool_inner(workspace, tool_id, values, false, "effective", progress)
}

pub fn run_project_script_tool_checked(
    workspace: &Path,
    tool_id: &str,
    values: &HashMap<String, String>,
) -> anyhow::Result<ScriptToolRunResponse> {
    run_script_tool_checked(workspace, tool_id, values, "effective")
}

pub fn run_script_tool_checked(workspace: &Path, tool_id: &str, values: &HashMap<String, String>, scope: &str) -> anyhow::Result<ScriptToolRunResponse> {
    run_project_script_tool_inner(workspace, tool_id, values, true, scope, &|_| {})
}

fn run_project_script_tool_inner(
    workspace: &Path,
    tool_id: &str,
    values: &HashMap<String, String>,
    strict: bool,
    scope: &str,
    progress: &(dyn Fn(ScriptToolProgress) + Sync),
) -> anyhow::Result<ScriptToolRunResponse> {
    let workspace_path = workspace.canonicalize().with_context(|| format!("工作区不存在：{}", workspace.display()))?;
    let workspace = workspace_path.as_path();
    let (_, _, tools) = discover_scoped_tools(workspace, &crate::cli_workspace::app_data_path()?, scope)?;
    let tool = tools
        .into_iter()
        .find(|candidate| candidate.manifest.id == tool_id)
        .with_context(|| format!("未找到已登记的脚本工具：{tool_id}"))?;
    if strict {
        validate_cli_values(&tool.manifest, values)?;
    }
    let arguments = build_arguments(&tool.manifest, values)?;

    let mut command = command_for_tool(&tool, &arguments)?;
    command.env("SUPERHIGH_WORKSPACE", crate::fs_ops::normalize_path(workspace));
    if tool.manifest.runtime.eq_ignore_ascii_case("node") {
        command.current_dir(crate::fs_ops::normalize_path(workspace));
    } else {
        command.current_dir(workspace);
    }
    let mut child = command
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("无法启动脚本工具：{}", tool.manifest.title))?;
    #[cfg(not(test))]
    crate::script_usage::record_direct(&tool.script_path);
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let (status, stdout, stderr) = std::thread::scope(|scope| {
        let out = scope.spawn(|| collect_output(stdout, "stdout", progress));
        let err = scope.spawn(|| collect_output(stderr, "stderr", progress));
        let status = child.wait();
        let stdout = out.join().map_err(|_| anyhow::anyhow!("stdout reader panicked"))?;
        let stderr = err.join().map_err(|_| anyhow::anyhow!("stderr reader panicked"))?;
        Ok::<_, anyhow::Error>((status?, stdout?, stderr?))
    })?;
    Ok(ScriptToolRunResponse {
        tool_id: tool.manifest.id,
        title: tool.manifest.title,
        exit_code: status.code(),
        stdout: stdout.trim().to_string(),
        stderr: stderr.trim().to_string(),
    })
}

fn collect_output(reader: impl Read, stream: &str, progress: &(dyn Fn(ScriptToolProgress) + Sync)) -> std::io::Result<String> {
    let mut reader = BufReader::new(reader);
    let mut output = String::new();
    let mut line = Vec::new();
    while reader.read_until(b'\n', &mut line)? != 0 {
        let chunk = String::from_utf8_lossy(&line).into_owned();
        output.push_str(&chunk);
        progress(ScriptToolProgress { stream: stream.into(), chunk });
        line.clear();
    }
    Ok(output)
}

fn validate_cli_values(
    manifest: &ToolManifest,
    values: &HashMap<String, String>,
) -> anyhow::Result<()> {
    for (id, value) in values {
        let parameter = manifest
            .parameters
            .iter()
            .find(|parameter| &parameter.id == id)
            .with_context(|| format!("unknown tool argument `{id}`"))?;
        if parameter.literal.is_some() {
            bail!("tool argument `{id}` is a fixed literal and cannot be supplied");
        }
        if parameter.parameter_type == "bool"
            && !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "true" | "false" | "1" | "0" | "yes" | "no" | "on" | "off"
            )
        {
            bail!("tool argument `{id}` requires a boolean value");
        }
    }
    Ok(())
}

fn discover_tools(
    workspace: &Path,
) -> anyhow::Result<(Option<PathBuf>, Vec<PathBuf>, Vec<DiscoveredTool>)> {
    discover_registry(workspace, &workspace.join(CONFIG_RELATIVE_PATH), false)
}

fn discover_scoped_tools(workspace: &Path, global_root: &Path, scope: &str) -> anyhow::Result<(Option<PathBuf>, Vec<PathBuf>, Vec<DiscoveredTool>)> {
    if !matches!(scope, "effective" | "project" | "global") { bail!("scope 必须是 effective、project 或 global：{scope}"); }
    // The workspace must exist even when only global tools are requested: it is the run context.
    workspace.canonicalize().with_context(|| format!("工作区不存在：{}", workspace.display()))?;
    let (mut config, mut directories, mut tools) = if scope != "project" {
        discover_registry(global_root, &global_root.join("script-tools.json"), true)
            .map_err(|error| anyhow::anyhow!("全局脚本工具注册错误：{}；{error:#}", global_root.join("script-tools.json").display()))?
    } else { (None, Vec::new(), Vec::new()) };
    if scope != "global" {
        let (project_config, project_directories, project_tools) = discover_tools(workspace)?;
        config = project_config;
        directories.extend(project_directories);
        for tool in project_tools {
            tools.retain(|global| global.manifest.id != tool.manifest.id);
            tools.push(tool);
        }
    }
    tools.sort_by(|left, right| left.manifest.title.cmp(&right.manifest.title));
    Ok((config, directories, tools))
}

fn discover_registry(
    workspace: &Path, config_path: &Path, global: bool,
) -> anyhow::Result<(Option<PathBuf>, Vec<PathBuf>, Vec<DiscoveredTool>)> {
    if !config_path.is_file() {
        return Ok((None, Vec::new(), Vec::new()));
    }
    let workspace = workspace
        .canonicalize()
        .with_context(|| format!("工作区不存在：{}", workspace.display()))?;
    let config_path = config_path.to_path_buf();
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
        let directory = resolve_registered_path(&workspace, &registered.path, global)?;
        if !global && is_superhigh_metadata_path(&workspace, &directory) {
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
        let script_path = resolve_registered_path(&workspace, &manifest.script, global)?;
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
        let ui_path = if global && !manifest.ui.trim().is_empty() {
            let path = resolve_workspace_child(&workspace, &manifest.ui)?;
            if !path.starts_with(workspace.join("script-tools")) || !path.is_file() || !path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("html")) {
                bail!("全局脚本扩展 UI 必须是 script-tools 中的 .html 文件：{}", manifest.ui);
            }
            Some(path)
        } else { resolve_tool_ui_path(&workspace, &manifest)? };
        tools.push(DiscoveredTool {
            manifest,
            script_path,
            ui_path,
            scope: if global { "global" } else { "project" }.into(),
            registry_path: config_path.clone(),
            base_path: workspace.clone(),
        });
    }
    tools.sort_by(|left, right| left.manifest.title.cmp(&right.manifest.title));
    Ok((Some(config_path), directories, tools))
}

fn resolve_registered_path(base: &Path, value: &str, global: bool) -> anyhow::Result<PathBuf> {
    if global && Path::new(value).is_absolute() {
        return Path::new(value).canonicalize().with_context(|| format!("已登记路径不存在：{value}"));
    }
    resolve_workspace_child(base, value)
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
    if let Some(output) = &manifest.output {
        if !matches!(output.format.as_str(), "json" | "text" | "markdown") {
            bail!("工具 output.format 只能是 json、text 或 markdown：{}", manifest.id);
        }
        if output.schema.as_ref().is_some_and(|schema| !schema.is_object()) {
            bail!("工具 output.schema 必须是 JSON Schema 对象：{}", manifest.id);
        }
    }
    let mut parameter_ids = HashMap::new();
    let mut positions = HashMap::new();
    for parameter in &manifest.parameters {
        if !is_safe_id(&parameter.id) {
            bail!("工具参数必须提供合法的 id：{}", manifest.id);
        }
        if parameter_ids.insert(&parameter.id, ()).is_some() {
            bail!("工具参数 ID 重复：{}", parameter.id);
        }
        if let Some(position) = parameter.position {
            if !parameter.flag.trim().is_empty() {
                bail!("位置参数不能同时声明 flag：{}", parameter.id);
            }
            if parameter.parameter_type == "bool" {
                bail!("位置参数不能使用 bool 类型：{}", parameter.id);
            }
            if let Some(literal) = &parameter.literal {
                if literal.trim().is_empty() {
                    bail!("固定位置参数 literal 不能为空：{}", parameter.id);
                }
                if parameter.required {
                    bail!("固定位置参数不需要 required：{}", parameter.id);
                }
            }
            if let Some(previous) = positions.insert(position, parameter.id.as_str()) {
                bail!(
                    "位置参数 position 重复：{}（{} 与 {}）",
                    position,
                    previous,
                    parameter.id
                );
            }
        } else {
            if parameter.literal.is_some() {
                bail!("literal 必须和 position 一起声明：{}", parameter.id);
            }
            if parameter.flag.trim().is_empty() {
                bail!("flag 参数必须提供非空 flag：{}", parameter.id);
            }
        }
    }

    let mut positionals = manifest
        .parameters
        .iter()
        .filter_map(|parameter| parameter.position.map(|position| (position, parameter)))
        .collect::<Vec<_>>();
    positionals.sort_by_key(|(position, _)| *position);
    for (expected, (actual, _)) in positionals.iter().enumerate() {
        if *actual != expected {
            bail!(
                "位置参数 position 必须从 0 连续编号：{} 缺少 {}",
                manifest.id,
                expected
            );
        }
    }
    let mut optional_position = None;
    for (position, parameter) in positionals {
        if let Some(previous) = optional_position {
            bail!(
                "可选位置参数只能位于位置段末尾：{} 的 position {} 位于可选 position {} 之后",
                parameter.id,
                position,
                previous
            );
        }
        if parameter.literal.is_none() && !parameter.required {
            optional_position = Some(position);
        }
    }
    for example in &manifest.examples {
        validate_cli_values(manifest, example)?;
        build_arguments(manifest, example)?;
    }
    Ok(())
}

fn build_arguments(
    manifest: &ToolManifest,
    values: &HashMap<String, String>,
) -> anyhow::Result<Vec<String>> {
    let mut arguments = Vec::new();
    let mut positionals = manifest
        .parameters
        .iter()
        .filter_map(|parameter| parameter.position.map(|position| (position, parameter)))
        .collect::<Vec<_>>();
    positionals.sort_by_key(|(position, _)| *position);

    for (_, parameter) in positionals {
        if let Some(literal) = &parameter.literal {
            arguments.push(literal.trim().to_string());
            continue;
        }
        let value = parameter_value(values, parameter);
        if value.is_empty() && parameter.required {
            bail!("脚本参数不能为空：{}", parameter.id);
        }
        if !value.is_empty() {
            arguments.push(value.to_string());
        }
    }

    for parameter in manifest
        .parameters
        .iter()
        .filter(|parameter| parameter.position.is_none())
    {
        let value = parameter_value(values, parameter);
        if value.is_empty() && parameter.required {
            bail!("脚本参数不能为空：{}", parameter.id);
        }
        if value.is_empty() {
            continue;
        }
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

    Ok(arguments)
}

fn parameter_value<'a>(values: &'a HashMap<String, String>, parameter: &ToolParameter) -> &'a str {
    values
        .get(&parameter.id)
        .map(String::as_str)
        .unwrap_or("")
        .trim()
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
            command.env("PYTHONUNBUFFERED", "1");
            command.arg(&tool.script_path);
            command
        }
        "powershell" | "pwsh" => {
            let executable = if runtime == "pwsh" { "pwsh" } else { "powershell.exe" };
            let mut command = Command::new(executable);
            command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
            // PowerShell cannot dot-source a script when -File receives a verbatim drive path.
            command.arg(crate::fs_ops::normalize_path(&tool.script_path));
            command
        }
        "node" => {
            let mut command = Command::new("node");
            // Node's main-module resolution rejects Windows verbatim drive paths.
            command.arg(crate::fs_ops::normalize_path(&tool.script_path));
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
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    Ok(command)
}

fn tool_descriptor(workspace: &Path, tool: &DiscoveredTool) -> ScriptToolDescriptor {
    ScriptToolDescriptor {
        id: tool.manifest.id.clone(),
        title: tool.manifest.title.clone(),
        description: tool.manifest.description.clone(),
        runtime: tool.manifest.runtime.clone(),
        kind: tool.manifest.kind.clone(),
        output: tool.manifest.output.clone(),
        examples: tool.manifest.examples.clone(),
        display_name: if tool.manifest.display_name.trim().is_empty() {
            tool.manifest.title.clone()
        } else {
            tool.manifest.display_name.clone()
        },
        tooltip: tool.manifest.tooltip.clone(),
        source_path: workspace_relative_path(if tool.scope == "global" { &tool.base_path } else { workspace }, &tool.script_path),
        scope: tool.scope.clone(),
        registry_path: normalize_path(&tool.registry_path),
        base_path: normalize_path(&tool.base_path),
        source_absolute_path: normalize_path(&tool.script_path),
        ui_absolute_path: tool.ui_path.as_ref().map(|path| normalize_path(path)),
        ui_path: tool
            .ui_path
            .as_ref()
            .map(|path| workspace_relative_path(if tool.scope == "global" { &tool.base_path } else { workspace }, path)),
        hidden: tool.manifest.hidden,
        parameters: tool
            .manifest
            .parameters
            .iter()
            .cloned()
            .map(|mut parameter| {
                if parameter.parameter_type.is_empty() {
                    parameter.parameter_type = "string".into();
                }
                parameter
            })
            .collect(),
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
        "powershell" | "pwsh" => extension == "ps1",
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
    normalize_path(path.strip_prefix(workspace).unwrap_or(path))
}

fn normalize_path(path: &Path) -> String {
    crate::fs_ops::normalize_path(path)
}

fn default_tool_kind() -> String {
    "query".to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        build_arguments, command_for_tool, discover_tools,
        resolve_child, run_project_script_tool, run_project_script_tool_checked,
        validate_cli_values, validate_manifest, DiscoveredTool, ToolManifest,
    };
    use serde_json::json;
    use std::{
        collections::HashMap,
        fs,
        path::{Path, PathBuf},
    };

    fn list_project_script_tools(workspace: &Path) -> anyhow::Result<super::ScriptToolListResponse> {
        super::inspect_script_tools(workspace, false, "project")
    }

    #[test]
    fn global_registry_uses_its_own_base_and_project_ids_override_it() {
        let global = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::create_dir_all(global.path().join("script-tools/shared")).unwrap();
        fs::write(global.path().join("script-tools/shared/main.py"), "print('global')").unwrap();
        fs::write(global.path().join("script-tools/shared/panel.html"), "<button>Run</button>").unwrap();
        fs::write(external.path().join("external.py"), "print('external')").unwrap();
        let config = json!({"version":1,"directories":[{"path":"script-tools"},{"path":external.path()}],"tools":[
            {"version":1,"id":"shared","title":"Global","script":"script-tools/shared/main.py","runtime":"python","ui":"script-tools/shared/panel.html"},
            {"version":1,"id":"external","title":"External","script":external.path().join("external.py"),"runtime":"python","hidden":true}
        ]});
        fs::write(global.path().join("script-tools.json"), config.to_string()).unwrap();
        let (_, _, global_tools) = super::discover_scoped_tools(workspace.path(), global.path(), "effective").unwrap();
        assert_eq!(global_tools.len(), 2); // A workspace without .superhigh still gets global tools.
        let descriptor = super::tool_descriptor(workspace.path(), global_tools.iter().find(|tool| tool.manifest.id == "shared").unwrap());
        assert_eq!(descriptor.scope, "global");
        assert_eq!(descriptor.source_path, "script-tools/shared/main.py");
        assert_eq!(descriptor.ui_path.as_deref(), Some("script-tools/shared/panel.html"));
        assert!(descriptor.ui_absolute_path.unwrap().ends_with("script-tools/shared/panel.html"));
        assert!(descriptor.registry_path.ends_with("script-tools.json"));
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::create_dir_all(workspace.path().join("scripts")).unwrap();
        fs::write(workspace.path().join("scripts/project.py"), "print('project')").unwrap();
        fs::write(workspace.path().join(super::CONFIG_RELATIVE_PATH), json!({"version":1,"directories":[{"path":"scripts"}],"tools":[
            {"version":1,"id":"shared","title":"Project","script":"scripts/project.py","runtime":"python"}
        ]}).to_string()).unwrap();
        let (_, _, effective) = super::discover_scoped_tools(workspace.path(), global.path(), "effective").unwrap();
        assert_eq!(effective.len(), 2);
        assert_eq!(effective.iter().find(|tool| tool.manifest.id == "shared").unwrap().scope, "project");
        assert_eq!(super::discover_scoped_tools(workspace.path(), global.path(), "global").unwrap().2.iter().find(|tool| tool.manifest.id == "shared").unwrap().scope, "global");
        assert_eq!(super::discover_scoped_tools(workspace.path(), global.path(), "project").unwrap().2.len(), 1);
        assert!(super::discover_scoped_tools(workspace.path(), global.path(), "bad").is_err());
        fs::write(global.path().join("script-tools.json"), "{broken").unwrap();
        let error = super::discover_scoped_tools(workspace.path(), global.path(), "effective").unwrap_err();
        assert!(error.to_string().contains("全局脚本工具注册错误"));
        assert!(super::discover_scoped_tools(workspace.path(), global.path(), "project").is_ok());
    }

    fn manifest_with_parameters(parameters: serde_json::Value) -> ToolManifest {
        serde_json::from_value(json!({
            "version": 1,
            "id": "argument-check",
            "title": "Argument check",
            "script": "scripts/check.py",
            "runtime": "python",
            "parameters": parameters
        }))
        .unwrap()
    }

    #[test]
    fn streams_both_pipes_before_exit_and_preserves_final_output() {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir_all(workspace.path().join("scripts")).unwrap();
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::write(workspace.path().join("scripts/progress.py"),
            "import pathlib, sys, time\nprint('进度')\nprint('warning', file=sys.stderr)\ndeadline = time.monotonic() + 5\nwhile not pathlib.Path('ack').exists() and time.monotonic() < deadline: time.sleep(0.01)\nif not pathlib.Path('ack').exists(): sys.exit(9)\nprint('tail', end='')\nsys.exit(7)\n").unwrap();
        fs::write(workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"progress","title":"Progress","script":"scripts/progress.py","runtime":"python"}]}"#).unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        let result = super::run_project_script_tool_streaming(workspace.path(), "progress", &HashMap::new(), &|event| {
            let mut events = events.lock().unwrap();
            events.push(event);
            if events.len() == 2 { fs::write(workspace.path().join("ack"), "ok").unwrap(); }
        }).unwrap();
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(result.stdout.replace('\r', ""), "进度\ntail");
        assert_eq!(result.stderr, "warning");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| event.stream == "stderr" && event.chunk.trim() == "warning"));
        assert_eq!(events.last().unwrap().chunk, "tail");
    }

    #[test]
    fn powershell_runtimes_select_explicit_executable() {
        for (runtime, executable) in [("powershell", "powershell.exe"), ("pwsh", "pwsh")] {
            let mut manifest = manifest_with_parameters(json!([]));
            manifest.runtime = runtime.into();
            manifest.script = "scripts/check.ps1".into();
            let tool = DiscoveredTool {
                manifest,
                script_path: PathBuf::from("scripts/check.ps1"),
                ui_path: None,
                scope: "project".into(), registry_path: PathBuf::new(), base_path: PathBuf::new(),
            };
            super::ensure_runtime_matches_script(runtime, &tool.script_path).unwrap();
            let command = command_for_tool(&tool, &["-Value".into(), "hello world".into()]).unwrap();
            assert_eq!(command.get_program(), executable);
            assert_eq!(command.get_args().collect::<Vec<_>>(), [
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts/check.ps1",
                "-Value", "hello world",
            ]);
        }
        assert!(super::ensure_runtime_matches_script("pwsh", Path::new("scripts/check.py")).is_err());
    }

    #[test]
    fn python_commands_force_utf8_output() {
        let tool = DiscoveredTool {
            manifest: ToolManifest {
                version: 1,
                id: "utf8-check".to_string(),
                title: "UTF-8 check".to_string(),
                description: String::new(),
                output: None,
                examples: Vec::new(),
                display_name: String::new(),
                tooltip: String::new(),
                hidden: false,
                script: "scripts/check.py".to_string(),
                runtime: "python".to_string(),
                ui: String::new(),
                kind: "query".to_string(),
                parameters: Vec::new(),
            },
            script_path: PathBuf::from("scripts/check.py"),
            ui_path: None,
            scope: "project".into(), registry_path: PathBuf::new(), base_path: PathBuf::new(),
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
    fn builds_literal_dynamic_positionals_and_flags_in_stable_order() {
        let manifest = manifest_with_parameters(json!([
            {"id":"command","position":0,"literal":"build"},
            {"id":"source","position":1,"required":true},
            {"id":"verbose","flag":"--verbose","type":"bool"},
            {"id":"format","flag":"--format"}
        ]));
        validate_manifest(&manifest).unwrap();
        let values = HashMap::from([
            ("source".to_string(), " models/input.bbmodel ".to_string()),
            ("verbose".to_string(), "true".to_string()),
            ("format".to_string(), "json".to_string()),
        ]);

        let arguments = build_arguments(&manifest, &values).unwrap();

        assert_eq!(
            arguments,
            vec![
                "build",
                "models/input.bbmodel",
                "--verbose",
                "--format",
                "json"
            ]
        );
    }

    #[test]
    fn preserves_existing_string_and_bool_flag_arguments() {
        let manifest = manifest_with_parameters(json!([
            {"id":"query","flag":"--query","required":true},
            {"id":"force","flag":"--force","type":"bool"}
        ]));
        validate_manifest(&manifest).unwrap();
        let values = HashMap::from([
            ("query".to_string(), "boss".to_string()),
            ("force".to_string(), "yes".to_string()),
        ]);

        let arguments = build_arguments(&manifest, &values).unwrap();

        assert_eq!(arguments, vec!["--query", "boss", "--force"]);
    }

    #[test]
    fn enforces_required_and_optional_positional_values() {
        let required = manifest_with_parameters(json!([
            {"id":"command","position":0,"required":true}
        ]));
        let optional = manifest_with_parameters(json!([
            {"id":"target","position":0}
        ]));
        validate_manifest(&required).unwrap();
        validate_manifest(&optional).unwrap();

        assert!(build_arguments(&required, &HashMap::new())
            .unwrap_err()
            .to_string()
            .contains("command"));
        assert!(build_arguments(&optional, &HashMap::new())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_ambiguous_positional_manifests() {
        let invalid = [
            manifest_with_parameters(json!([
                {"id":"first","position":0,"literal":"scan"},
                {"id":"second","position":0,"literal":"apply"}
            ])),
            manifest_with_parameters(json!([
                {"id":"second","position":1,"required":true}
            ])),
            manifest_with_parameters(json!([
                {"id":"command","position":0,"flag":"--command","required":true}
            ])),
            manifest_with_parameters(json!([
                {"id":"command","position":0,"type":"bool"}
            ])),
            manifest_with_parameters(json!([
                {"id":"command","flag":"--command","literal":"scan"}
            ])),
            manifest_with_parameters(json!([
                {"id":"command","position":0,"literal":"  "}
            ])),
            manifest_with_parameters(json!([
                {"id":"optional","position":0},
                {"id":"later","position":1,"required":true}
            ])),
        ];

        for manifest in invalid {
            assert!(validate_manifest(&manifest).is_err());
        }
    }

    #[test]
    fn runs_positional_manifest_through_the_real_process_entrypoint() {
        let workspace = tempfile::tempdir().unwrap();
        let scripts = workspace.path().join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::write(
            scripts.join("argv_probe.py"),
            "import json, sys\nprint(json.dumps(sys.argv[1:], ensure_ascii=False))\n",
        )
        .unwrap();
        fs::write(
            workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"argv-probe","title":"Argv probe","script":"scripts/argv_probe.py","runtime":"python","parameters":[{"id":"command","position":0,"literal":"build"},{"id":"source","position":1,"required":true},{"id":"verbose","flag":"--verbose","type":"bool"}]}]}"#,
        )
        .unwrap();
        let values = HashMap::from([
            ("source".to_string(), "models/example.bbmodel".to_string()),
            ("verbose".to_string(), "true".to_string()),
        ]);

        let response = run_project_script_tool(workspace.path(), "argv-probe", &values).unwrap();
        let arguments: Vec<String> = serde_json::from_str(&response.stdout).unwrap();

        assert_eq!(response.exit_code, Some(0));
        assert_eq!(
            arguments,
            vec!["build", "models/example.bbmodel", "--verbose"]
        );
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
        assert_eq!(result.tools[0].scope, "project");
        assert_eq!(result.tools[0].display_name, "怪物查询");
        assert_eq!(result.tools[0].source_path, "scripts/mob_report.py");
        let descriptor = serde_json::to_value(&result.tools[0]).unwrap();
        assert_eq!(descriptor["parameters"][0]["id"], "query");
        assert_eq!(descriptor["parameters"][0]["required"], true);
        assert_eq!(descriptor["parameters"][0]["type"], "string");
        assert!(run_project_script_tool_checked(
            workspace.path(),
            "mob-report",
            &HashMap::from([("typo".into(), "value".into())])
        )
        .unwrap_err()
        .to_string()
        .contains("unknown tool argument"));
        assert!(
            run_project_script_tool_checked(workspace.path(), "mob-report", &HashMap::new())
                .unwrap_err()
                .to_string()
                .contains("query")
        );
    }

    #[test]
    fn cli_validation_rejects_invalid_boolean_and_literal_override() {
        let manifest: ToolManifest = serde_json::from_str(r#"{"version":1,"id":"report","title":"Report","script":"scripts/report.py","runtime":"python","parameters":[{"id":"enabled","flag":"--enabled","type":"bool"},{"id":"command","position":0,"literal":"build"}]}"#).unwrap();
        assert!(validate_cli_values(
            &manifest,
            &HashMap::from([("enabled".into(), "maybe".into())])
        )
        .is_err());
        assert!(validate_cli_values(
            &manifest,
            &HashMap::from([("command".into(), "delete".into())])
        )
        .is_err());
        for value in ["true", "false", "1", "0", "yes", "no", "on", "off"] {
            assert!(validate_cli_values(
                &manifest,
                &HashMap::from([("enabled".into(), value.into())])
            )
            .is_ok());
        }
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

        assert_eq!(result.tools[0].scope, "project");
        assert_eq!(result.tools[0].display_name, "怪物面板");
        assert!(result.tools[0].tooltip.is_empty());
        assert_eq!(
            result.tools[0].ui_path.as_deref(),
            Some(".superhigh/script-tools/mob-report.html")
        );
    }

    #[test]
    fn hides_editor_only_tools_from_listing_but_keeps_them_discoverable() {
        let workspace = tempfile::tempdir().unwrap();
        let scripts = workspace.path().join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir_all(workspace.path().join(".superhigh")).unwrap();
        fs::write(scripts.join("bbmodel.py"), "print('ok')").unwrap();
        fs::write(
            workspace.path().join(".superhigh/script-tools.json"),
            r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"bbmodel","title":"BBModel","script":"scripts/bbmodel.py","runtime":"python","hidden":true}]}"#,
        )
        .unwrap();

        let listed = list_project_script_tools(workspace.path()).unwrap();
        assert!(listed.tools.is_empty());

        let (_, _, discovered) = discover_tools(workspace.path()).unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].manifest.id, "bbmodel");
        assert!(discovered[0].manifest.hidden);
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

    #[cfg(windows)]
    #[test]
    fn runs_node_tool_from_canonical_windows_path() {
        let workspace = tempfile::Builder::new().prefix("superhigh node 路径 ").tempdir().unwrap();
        fs::create_dir(workspace.path().join("scripts")).unwrap();
        fs::create_dir(workspace.path().join(".superhigh")).unwrap();
        fs::write(workspace.path().join(".superhigh/script-tools.json"), r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"node-check","title":"Node check","script":"scripts/check.cjs","runtime":"node","parameters":[{"id":"value","flag":"--value","required":true}]}]}"#).unwrap();
        fs::write(workspace.path().join("scripts/check.cjs"), "console.log(JSON.stringify(process.argv.slice(2))); if (process.argv.includes('fail')) { console.error('expected failure'); process.exit(7); }").unwrap();
        let canonical = workspace.path().canonicalize().unwrap();
        assert!(canonical.to_string_lossy().starts_with(r"\\?\"));
        for project in [workspace.path(), canonical.as_path()] {
            let result = run_project_script_tool_checked(project, "node-check", &HashMap::from([("value".into(), "a=b 空格".into())])).unwrap();
            assert_eq!(result.exit_code, Some(0), "{}", result.stderr);
            assert_eq!(serde_json::from_str::<serde_json::Value>(&result.stdout).unwrap(), json!(["--value", "a=b 空格"]));
        }
        let failed = run_project_script_tool_checked(&canonical, "node-check", &HashMap::from([("value".into(), "fail".into())])).unwrap();
        assert_eq!(failed.exit_code, Some(7));
        assert_eq!(failed.stderr, "expected failure");
    }
}
