use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use anyhow::{anyhow, Context};

use crate::{
    fs_ops::normalize_path,
    models::{
        PluginActivationCondition, PluginDescriptor, PluginEnvironment, PluginListResponse,
        PluginManifest, PluginRuntimeStatus, PluginShellExecRequest, PluginShellExecResult,
        PluginSource, PluginWorkspaceContext,
    },
};

pub fn plugin_paths(
    data_dir: &Path,
    workspace: Option<&PluginWorkspaceContext>,
) -> PluginEnvironment {
    let plugin_root = data_dir.join("plugins");
    let disable_flag_path = data_dir.join("disable-plugins.flag");
    let log_path = data_dir.join("logs").join("plugins.log");
    let project_plugin_root = workspace.map(|item| {
        normalize_path(
            &PathBuf::from(&item.root_path)
                .join(".superhigh")
                .join("plugins"),
        )
    });
    PluginEnvironment {
        plugin_root: normalize_path(&plugin_root),
        project_plugin_root,
        disable_flag_path: normalize_path(&disable_flag_path),
        log_path: normalize_path(&log_path),
        all_disabled: false,
        disabled_reason: None,
    }
}

pub fn discover_plugins(
    data_dir: &Path,
    workspace: Option<&PluginWorkspaceContext>,
    disabled_plugin_ids: &[String],
    disabled_by_cli: bool,
) -> anyhow::Result<PluginListResponse> {
    let mut environment = plugin_paths(data_dir, workspace);
    let global_root = PathBuf::from(&environment.plugin_root);
    fs::create_dir_all(&global_root)
        .with_context(|| format!("failed to create {}", environment.plugin_root))?;
    if let Some(parent) = PathBuf::from(&environment.log_path).parent() {
        fs::create_dir_all(parent).ok();
    }

    let disabled_by_flag = PathBuf::from(&environment.disable_flag_path).is_file();
    let global_disabled_reason = if disabled_by_cli {
        Some("--disable-plugins".to_string())
    } else if disabled_by_flag {
        Some("disable-plugins.flag".to_string())
    } else {
        None
    };
    environment.all_disabled = global_disabled_reason.is_some();
    environment.disabled_reason = global_disabled_reason.clone();

    let mut plugins = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // Project plugins load first and win on id conflicts with global plugins.
    if let Some(project_root) = environment.project_plugin_root.as_ref().map(PathBuf::from) {
        if project_root.is_dir() {
            for plugin in read_plugin_root(
                &project_root,
                PluginSource::Project,
                workspace,
                disabled_plugin_ids,
                global_disabled_reason.as_deref(),
            ) {
                seen_ids.insert(plugin.id.clone());
                plugins.push(plugin);
            }
        } else {
            fs::create_dir_all(&project_root).ok();
        }
    }

    for plugin in read_plugin_root(
        &global_root,
        PluginSource::Global,
        workspace,
        disabled_plugin_ids,
        global_disabled_reason.as_deref(),
    ) {
        if seen_ids.contains(&plugin.id) {
            continue;
        }
        plugins.push(plugin);
    }

    plugins.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(PluginListResponse {
        environment,
        plugins,
    })
}

pub fn read_plugin_asset(
    data_dir: &Path,
    workspace: Option<&PluginWorkspaceContext>,
    plugin_id: &str,
    relative_path: &str,
) -> anyhow::Result<String> {
    let relative = safe_relative_path(relative_path)?;
    let mut candidates = Vec::new();
    if let Some(workspace) = workspace {
        candidates.push(
            PathBuf::from(&workspace.root_path)
                .join(".superhigh")
                .join("plugins")
                .join(plugin_id),
        );
    }
    candidates.push(data_dir.join("plugins").join(plugin_id));

    let mut last_error = anyhow!("plugin not found: {plugin_id}");
    for root in candidates {
        match read_asset_from_root(&root, &relative, relative_path) {
            Ok(content) => return Ok(content),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

pub fn exec_plugin_shell(request: PluginShellExecRequest) -> anyhow::Result<PluginShellExecResult> {
    if request.command.trim().is_empty() {
        return Err(anyhow!("plugin shell command is required"));
    }

    let mut command = shell_command(&request.command);
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    for (key, value) in &request.env {
        command.env(key, value);
    }

    let output = command
        .output()
        .context("failed to execute plugin shell command")?;

    Ok(PluginShellExecResult {
        command: request.command,
        cwd: request.cwd,
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[cfg(windows)]
fn shell_command(command: &str) -> std::process::Command {
    let mut process = std::process::Command::new("powershell");
    process
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(command);
    process
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> std::process::Command {
    let mut process = std::process::Command::new("sh");
    process.arg("-lc").arg(command);
    process
}

fn read_plugin_root(
    root: &Path,
    source: PluginSource,
    workspace: Option<&PluginWorkspaceContext>,
    disabled_plugin_ids: &[String],
    global_disabled_reason: Option<&str>,
) -> Vec<PluginDescriptor> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut plugins = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        plugins.push(read_plugin_folder(
            &entry.path(),
            source.clone(),
            workspace,
            disabled_plugin_ids,
            global_disabled_reason,
        ));
    }
    plugins
}

fn read_asset_from_root(
    root: &Path,
    relative: &Path,
    relative_path: &str,
) -> anyhow::Result<String> {
    let path = root.join(relative);
    let canonical_root = root
        .canonicalize()
        .with_context(|| format!("plugin not found: {}", normalize_path(root)))?;
    let canonical_path = path
        .canonicalize()
        .with_context(|| format!("plugin asset not found: {relative_path}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(anyhow!("plugin asset must stay inside plugin directory"));
    }
    fs::read_to_string(&canonical_path)
        .with_context(|| format!("failed to read {}", normalize_path(&canonical_path)))
}

fn read_plugin_folder(
    folder: &Path,
    source: PluginSource,
    workspace: Option<&PluginWorkspaceContext>,
    disabled_plugin_ids: &[String],
    global_disabled_reason: Option<&str>,
) -> PluginDescriptor {
    let fallback_id = folder
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let manifest_path = folder.join("plugin.json");
    let root_path = normalize_path(folder);

    let manifest = match fs::read_to_string(&manifest_path) {
        Ok(raw) => match serde_json::from_str::<PluginManifest>(&raw) {
            Ok(manifest) => match validate_manifest(folder, manifest) {
                Ok(manifest) => manifest,
                Err(error) => {
                    return manifest_error_descriptor(
                        &fallback_id,
                        &root_path,
                        source,
                        error.to_string(),
                    )
                }
            },
            Err(error) => {
                return manifest_error_descriptor(
                    &fallback_id,
                    &root_path,
                    source,
                    format!("invalid plugin.json: {error}"),
                )
            }
        },
        Err(error) => {
            return manifest_error_descriptor(
                &fallback_id,
                &root_path,
                source,
                format!("missing plugin.json: {error}"),
            )
        }
    };

    let main_relative = match safe_relative_path(&manifest.main) {
        Ok(path) => path,
        Err(error) => {
            return manifest_error_descriptor(&manifest.id, &root_path, source, error.to_string())
        }
    };
    let main_path = folder.join(&main_relative);
    if !main_path.is_file() {
        return manifest_error_descriptor(
            &manifest.id,
            &root_path,
            source,
            format!("main file not found: {}", manifest.main),
        );
    }

    let style_relative = match &manifest.style {
        Some(style) => match safe_relative_path(style) {
            Ok(path) => Some(path),
            Err(error) => {
                return manifest_error_descriptor(
                    &manifest.id,
                    &root_path,
                    source,
                    error.to_string(),
                )
            }
        },
        None => None,
    };
    let style_path = style_relative.as_ref().map(|path| folder.join(path));
    if let Some(path) = &style_path {
        if !path.is_file() {
            return manifest_error_descriptor(
                &manifest.id,
                &root_path,
                source,
                format!(
                    "style file not found: {}",
                    manifest.style.clone().unwrap_or_default()
                ),
            );
        }
    }

    let mut descriptor = PluginDescriptor {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        root_path,
        main: manifest.main.clone(),
        main_path: normalize_path(&main_path),
        style: manifest.style.clone(),
        style_path: style_path.as_ref().map(|path| normalize_path(path)),
        source,
        permissions: if manifest.permissions.is_empty() {
            vec!["all".to_string()]
        } else {
            manifest.permissions.clone()
        },
        unsafe_enabled: manifest.unsafe_enabled,
        status: PluginRuntimeStatus::Matched,
        match_reason: None,
        disabled_reason: None,
        error: None,
    };

    if let Some(reason) = global_disabled_reason {
        descriptor.status = PluginRuntimeStatus::Disabled;
        descriptor.disabled_reason = Some(reason.to_string());
        return descriptor;
    }
    if disabled_plugin_ids.iter().any(|id| id == &descriptor.id) {
        descriptor.status = PluginRuntimeStatus::Disabled;
        descriptor.disabled_reason = Some("disabled in settings".to_string());
        return descriptor;
    }

    match evaluate_activation(manifest.activation.as_ref(), workspace, &descriptor.source) {
        ActivationResult::Matched(reason) => {
            descriptor.status = PluginRuntimeStatus::Matched;
            descriptor.match_reason = Some(reason);
        }
        ActivationResult::NotMatched(reason) => {
            descriptor.status = PluginRuntimeStatus::NotMatched;
            descriptor.match_reason = Some(reason);
        }
    }
    descriptor
}

fn manifest_error_descriptor(
    id: &str,
    root_path: &str,
    source: PluginSource,
    error: String,
) -> PluginDescriptor {
    PluginDescriptor {
        id: id.to_string(),
        name: id.to_string(),
        version: "0.0.0".to_string(),
        root_path: root_path.to_string(),
        main: String::new(),
        main_path: String::new(),
        style: None,
        style_path: None,
        source,
        permissions: Vec::new(),
        unsafe_enabled: false,
        status: PluginRuntimeStatus::ManifestError,
        match_reason: None,
        disabled_reason: None,
        error: Some(error),
    }
}

fn validate_manifest(folder: &Path, manifest: PluginManifest) -> anyhow::Result<PluginManifest> {
    if manifest.id.trim().is_empty() {
        return Err(anyhow!("plugin id is required"));
    }
    validate_plugin_id(folder, &manifest.id)?;
    if manifest.name.trim().is_empty() {
        return Err(anyhow!("plugin name is required"));
    }
    if manifest.version.trim().is_empty() {
        return Err(anyhow!("plugin version is required"));
    }
    if manifest.main.trim().is_empty() {
        return Err(anyhow!("plugin main is required"));
    }
    Ok(manifest)
}

fn validate_plugin_id(folder: &Path, plugin_id: &str) -> anyhow::Result<()> {
    let plugin_id_path = Path::new(plugin_id);
    if plugin_id_path.is_absolute() {
        return Err(anyhow!("plugin id must not be an absolute path"));
    }
    let mut components = plugin_id_path.components();
    let Some(Component::Normal(component)) = components.next() else {
        return Err(anyhow!("plugin id must be a single path segment"));
    };
    if components.next().is_some() {
        return Err(anyhow!("plugin id must be a single path segment"));
    }
    let folder_name = folder
        .file_name()
        .ok_or_else(|| anyhow!("plugin folder name is required"))?
        .to_string_lossy();
    if component != folder_name.as_ref() {
        return Err(anyhow!("plugin id must match plugin folder name"));
    }
    Ok(())
}

enum ActivationResult {
    Matched(String),
    NotMatched(String),
}

fn evaluate_activation(
    condition: Option<&PluginActivationCondition>,
    workspace: Option<&PluginWorkspaceContext>,
    source: &PluginSource,
) -> ActivationResult {
    // Project-local plugins default to active for the open workspace.
    if condition.is_none() {
        return match source {
            PluginSource::Project => {
                if workspace.is_some() {
                    ActivationResult::Matched("project plugin for current workspace".to_string())
                } else {
                    ActivationResult::NotMatched("no workspace is open".to_string())
                }
            }
            PluginSource::Global => {
                ActivationResult::Matched("no activation condition".to_string())
            }
        };
    }

    let Some(condition) = condition else {
        return ActivationResult::Matched("no activation condition".to_string());
    };
    let Some(workspace) = workspace else {
        return ActivationResult::NotMatched("no workspace is open".to_string());
    };
    if condition_matches(condition, workspace) {
        ActivationResult::Matched("activation matched current workspace".to_string())
    } else {
        ActivationResult::NotMatched("activation did not match current workspace".to_string())
    }
}

fn condition_matches(
    condition: &PluginActivationCondition,
    workspace: &PluginWorkspaceContext,
) -> bool {
    match condition {
        PluginActivationCondition::WorkspaceName { workspace_name } => {
            workspace.name.eq_ignore_ascii_case(workspace_name)
                || workspace.display_name.eq_ignore_ascii_case(workspace_name)
        }
        PluginActivationCondition::WorkspacePathIncludes {
            workspace_path_includes,
        } => workspace
            .root_path
            .to_lowercase()
            .contains(&workspace_path_includes.to_lowercase()),
        PluginActivationCondition::Exists { exists } => safe_relative_path(exists)
            .map(|relative| PathBuf::from(&workspace.root_path).join(relative).exists())
            .unwrap_or(false),
        PluginActivationCondition::All { all } => {
            all.iter().all(|item| condition_matches(item, workspace))
        }
        PluginActivationCondition::Any { any } => {
            any.iter().any(|item| condition_matches(item, workspace))
        }
    }
}

fn safe_relative_path(value: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Err(anyhow!("plugin relative path must not be absolute"));
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err(anyhow!(
                "plugin relative path must stay inside plugin directory"
            ));
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_plugin(root: &Path, id: &str, manifest: &str) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.json"), manifest).unwrap();
        fs::write(
            dir.join("main.js"),
            "export default function activate() {}\n",
        )
        .unwrap();
        fs::write(dir.join("style.css"), "body {}\n").unwrap();
    }

    fn workspace(root: &Path) -> PluginWorkspaceContext {
        PluginWorkspaceContext {
            name: "示例工作区".to_string(),
            display_name: "示例工作区".to_string(),
            root_path: root.to_string_lossy().replace('\\', "/"),
        }
    }

    #[test]
    fn discovers_matching_plugin_by_workspace_name_and_exists() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("示例工作区");
        fs::create_dir_all(project.join("docs")).unwrap();
        fs::write(project.join("AGENTS.md"), "# rules\n").unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "sample-tools",
            r#"{
              "id":"sample-tools",
              "name":"示例工具",
              "version":"0.1.0",
              "main":"main.js",
              "style":"style.css",
              "activation":{"all":[{"workspaceName":"示例工作区"},{"exists":"docs"}]},
              "permissions":["all"],
              "unsafe":true
            }"#,
        );
        let response =
            discover_plugins(temp.path(), Some(&workspace(&project)), &[], false).unwrap();
        assert_eq!(response.plugins.len(), 1);
        let plugin = &response.plugins[0];
        assert_eq!(plugin.status, PluginRuntimeStatus::Matched);
        assert_eq!(plugin.source, PluginSource::Global);
        assert_eq!(plugin.permissions, vec!["all"]);
        assert!(plugin.unsafe_enabled);
    }

    #[test]
    fn marks_unmatched_when_workspace_missing() {
        let temp = tempfile::tempdir().unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "sample-tools",
            r#"{"id":"sample-tools","name":"示例工具","version":"0.1.0","main":"main.js","activation":{"exists":"AGENTS.md"}}"#,
        );
        let response = discover_plugins(temp.path(), None, &[], false).unwrap();
        assert_eq!(response.plugins[0].status, PluginRuntimeStatus::NotMatched);
    }

    #[test]
    fn disables_all_plugins_when_cli_flag_set() {
        let temp = tempfile::tempdir().unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "sample-tools",
            r#"{"id":"sample-tools","name":"示例工具","version":"0.1.0","main":"main.js"}"#,
        );
        let response = discover_plugins(temp.path(), None, &[], true).unwrap();
        assert!(response.environment.all_disabled);
        assert_eq!(response.plugins[0].status, PluginRuntimeStatus::Disabled);
    }

    #[test]
    fn disables_all_plugins_when_flag_file_exists() {
        let temp = tempfile::tempdir().unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "sample-tools",
            r#"{"id":"sample-tools","name":"示例工具","version":"0.1.0","main":"main.js"}"#,
        );
        fs::write(temp.path().join("disable-plugins.flag"), "1").unwrap();
        let response = discover_plugins(temp.path(), None, &[], false).unwrap();
        assert!(response.environment.all_disabled);
        assert_eq!(response.plugins[0].status, PluginRuntimeStatus::Disabled);
    }

    #[test]
    fn disables_selected_plugin_ids() {
        let temp = tempfile::tempdir().unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "sample-tools",
            r#"{"id":"sample-tools","name":"示例工具","version":"0.1.0","main":"main.js"}"#,
        );
        let response =
            discover_plugins(temp.path(), None, &["sample-tools".to_string()], false).unwrap();
        assert_eq!(response.plugins[0].status, PluginRuntimeStatus::Disabled);
    }

    #[test]
    fn reports_manifest_errors_without_stopping_other_plugins() {
        let temp = tempfile::tempdir().unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "good",
            r#"{"id":"good","name":"Good","version":"1.0.0","main":"main.js"}"#,
        );
        let bad = temp.path().join("plugins").join("bad");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("plugin.json"), "{not-json").unwrap();
        let response = discover_plugins(temp.path(), None, &[], false).unwrap();
        assert!(response
            .plugins
            .iter()
            .any(|item| item.status == PluginRuntimeStatus::ManifestError));
        assert!(response
            .plugins
            .iter()
            .any(|item| item.id == "good" && item.status == PluginRuntimeStatus::Matched));
    }

    #[test]
    fn loads_project_local_plugins_and_prefers_them_over_global() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("示例项目");
        let project_plugins = project.join(".superhigh").join("plugins");
        fs::create_dir_all(&project_plugins).unwrap();
        write_plugin(
            &temp.path().join("plugins"),
            "shared-tools",
            r#"{"id":"shared-tools","name":"Global Shared","version":"1.0.0","main":"main.js"}"#,
        );
        write_plugin(
            &project_plugins,
            "shared-tools",
            r#"{"id":"shared-tools","name":"Project Shared","version":"2.0.0","main":"main.js"}"#,
        );
        write_plugin(
            &project_plugins,
            "sample-tools",
            r#"{"id":"sample-tools","name":"示例工具","version":"0.1.0","main":"main.js"}"#,
        );

        let response =
            discover_plugins(temp.path(), Some(&workspace(&project)), &[], false).unwrap();
        assert_eq!(response.plugins.len(), 2);
        let shared = response
            .plugins
            .iter()
            .find(|item| item.id == "shared-tools")
            .unwrap();
        assert_eq!(shared.source, PluginSource::Project);
        assert_eq!(shared.name, "Project Shared");
        assert_eq!(shared.version, "2.0.0");
        let tide = response
            .plugins
            .iter()
            .find(|item| item.id == "sample-tools")
            .unwrap();
        assert_eq!(tide.source, PluginSource::Project);
        assert_eq!(tide.status, PluginRuntimeStatus::Matched);
        assert!(response
            .environment
            .project_plugin_root
            .as_ref()
            .unwrap()
            .contains(".superhigh"));
    }

    #[test]
    fn rejects_plugin_id_mismatch() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("plugins").join("folder-id");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            r#"{"id":"other-id","name":"X","version":"1.0.0","main":"main.js"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("main.js"),
            "export default function activate() {}\n",
        )
        .unwrap();
        let response = discover_plugins(temp.path(), None, &[], false).unwrap();
        assert_eq!(
            response.plugins[0].status,
            PluginRuntimeStatus::ManifestError
        );
    }

    #[test]
    fn reads_project_plugin_assets() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let plugins = project.join(".superhigh").join("plugins");
        write_plugin(
            &plugins,
            "tide-tools",
            r#"{"id":"tide-tools","name":"潮汐","version":"0.1.0","main":"main.js"}"#,
        );
        let content = read_plugin_asset(
            temp.path(),
            Some(&workspace(&project)),
            "tide-tools",
            "main.js",
        )
        .unwrap();
        assert!(content.contains("activate"));
    }
}
