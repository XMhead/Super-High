use std::{collections::HashSet, fs, path::Path};

use serde::{Deserialize, Serialize};

use crate::{fs_ops::normalize_path, skills::SkillScope};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    commands: Vec<RegisteredCommand>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisteredCommand {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCompletionItem {
    command_id: String,
    name: String,
    description: String,
    content: String,
    scope: SkillScope,
    path: String,
}

pub fn list_commands(project: Option<&Path>) -> Result<Vec<CommandCompletionItem>, String> {
    let global_root = crate::cli_workspace::app_data_path().map_err(|error| error.to_string())?;
    let mut commands = read_registry(&global_root.join("commands.json"), SkillScope::Global)?;
    if let Some(project) = project {
        let mut project_commands: Vec<CommandCompletionItem> = Vec::new();
        for root in crate::extension_projects::roots(project, "commands").map_err(|error| format!("{error:#}"))?.into_iter().rev() {
            for command in read_registry(&root.join(".superhigh/commands.json"), SkillScope::Project)? {
                project_commands.retain(|existing| existing.command_id != command.command_id && !existing.name.eq_ignore_ascii_case(&command.name));
                project_commands.push(command);
            }
        }
        commands.extend(project_commands);
    }
    Ok(commands)
}

fn read_registry(path: &Path, scope: SkillScope) -> Result<Vec<CommandCompletionItem>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取指令注册表 {}：{error}", path.display())),
    };
    let registry: Registry = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("指令注册表 {}：{error}", path.display()))?;
    if registry.version != 1 {
        return Err(format!("指令注册表 {}：version 必须为 1", path.display()));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    registry.commands.into_iter().map(|command| {
        let id = command.id.trim();
        let name = command.name.trim();
        if id.is_empty() || name.is_empty() || name.contains('/') || name.chars().any(char::is_whitespace)
            || name.eq_ignore_ascii_case("prompt") || command.content.trim().is_empty()
            || !ids.insert(id.to_string()) || !names.insert(name.to_lowercase())
        {
            return Err(format!("指令注册表 {}：无效或重复的 id/name，prompt 为系统保留名称，content 不能为空", path.display()));
        }
        Ok(CommandCompletionItem {
            command_id: id.to_string(), name: name.to_string(),
            description: command.description.trim().to_string(), content: command.content,
            scope, path: normalize_path(path),
        })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_projects_commands_respect_local_precedence_and_isolation() {
        let temp = tempfile::tempdir().unwrap();
        for directory in ["local", "shared", "other"] { fs::create_dir_all(temp.path().join(directory).join(".superhigh")).unwrap(); }
        let write = |directory: &str, commands: serde_json::Value| fs::write(temp.path().join(directory).join(".superhigh/commands.json"),
            serde_json::json!({"version":1,"commands":commands}).to_string()).unwrap();
        write("local", serde_json::json!([{"id":"review","name":"review","content":"local"}]));
        write("shared", serde_json::json!([
            {"id":"review","name":"review","content":"shared"},
            {"id":"build","name":"build","content":"build shared"}
        ]));
        let local = temp.path().join("local");
        crate::extension_projects::save(&local, vec![crate::extension_projects::ExtensionProject {
            path: "../shared".into(), commands: true, script_tools: false, editors: false,
        }]).unwrap();
        let commands: Vec<_> = list_commands(Some(&local)).unwrap().into_iter().filter(|item| matches!(item.scope, SkillScope::Project)).collect();
        assert_eq!(commands.len(), 2);
        assert_eq!(commands.iter().find(|item| item.command_id == "review").unwrap().content, "local");
        assert!(list_commands(Some(&temp.path().join("other"))).unwrap().into_iter().all(|item| !matches!(item.scope, SkillScope::Project)));
    }

    #[test]
    fn loads_scoped_commands_with_stable_ids_and_preserves_multiline_content() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("commands.json");
        assert!(read_registry(&path, SkillScope::Global).unwrap().is_empty());
        fs::write(&path, serde_json::json!({"version":1,"commands":[
            {"id":"review","name":"审查","content":"第一行\n第二行"}
        ]}).to_string()).unwrap();
        let commands = read_registry(&path, SkillScope::Project).unwrap();
        assert_eq!(commands[0].command_id, "review");
        assert_eq!(commands[0].content, "第一行\n第二行");
        assert_eq!(commands[0].scope, SkillScope::Project);
        assert_eq!(commands[0].path, normalize_path(&path));
    }

    #[test]
    fn rejects_reserved_names_duplicates_and_invalid_registries() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("commands.json");
        for value in [
            serde_json::json!({"version":2,"commands":[]}),
            serde_json::json!({"version":1,"commands":[{"id":"p","name":"prompt","content":"test"}]}),
            serde_json::json!({"version":1,"commands":[{"id":"p","name":"has space","content":"test"}]}),
            serde_json::json!({"version":1,"commands":[{"id":"p","name":"test","content":" "}]}),
            serde_json::json!({"version":1,"commands":[{"id":"p","name":"a","content":"a"},{"id":"p","name":"b","content":"b"}]}),
        ] {
            fs::write(&path, value.to_string()).unwrap();
            assert!(read_registry(&path, SkillScope::Project).is_err());
        }
    }
}
