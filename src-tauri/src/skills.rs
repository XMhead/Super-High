use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_yaml::Value;

use crate::fs_ops::normalize_path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCompletionItem {
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillScope {
    Global,
    Project,
}

#[derive(Debug)]
struct SkillRoot {
    path: PathBuf,
    scope: SkillScope,
    include_codex_system: bool,
}

pub fn list_skills(project_path: Option<&Path>) -> Vec<SkillCompletionItem> {
    discover_skills(&skill_roots(project_path))
}

fn skill_roots(project_path: Option<&Path>) -> Vec<SkillRoot> {
    let mut roots = Vec::new();
    if let Some(project_path) = project_path {
        for relative in [
            ".dsh/skills",
            ".agents/skills",
            ".codex/skills",
            ".claude/skills",
            ".gemini/skills",
            ".grok/skills",
            ".opencode/skills",
        ] {
            roots.push(SkillRoot {
                path: project_path.join(relative),
                scope: SkillScope::Project,
                include_codex_system: relative == ".codex/skills",
            });
        }
    }

    if let Some(project_path) = project_path {
        roots.push(SkillRoot {
            path: project_path.join(".superhigh/skills"),
            scope: SkillScope::Global,
            include_codex_system: false,
        });
    }

    let Some(home) = user_home() else {
        return roots;
    };
    let dsh_home = env_path_or("DSH_HOME", &home.join(".dsh"));
    let agents_home = env_path_or("DSH_AGENTS_HOME", &home.join(".agents"));
    let codex_home = env_path_or("CODEX_HOME", &home.join(".codex"));
    let claude_home = env_path_or("CLAUDE_CONFIG_DIR", &home.join(".claude"));
    for (path, include_codex_system) in [
        (home.join(".superhigh/skills"), false),
        (dsh_home.join("skills"), false),
        (agents_home.join("skills"), false),
        (codex_home.join("skills"), true),
        (claude_home.join("skills"), false),
        (home.join(".gemini/skills"), false),
        (home.join(".grok/skills"), false),
        (home.join(".config/opencode/skills"), false),
    ] {
        roots.push(SkillRoot {
            path,
            scope: SkillScope::Global,
            include_codex_system,
        });
    }
    roots
}

fn user_home() -> Option<PathBuf> {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn env_path_or(key: &str, fallback: &Path) -> PathBuf {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf())
}

fn discover_skills(roots: &[SkillRoot]) -> Vec<SkillCompletionItem> {
    let mut skills = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        for path in skill_files(root) {
            let Some(skill) = parse_skill_file(&path, root.scope) else {
                continue;
            };
            if seen.insert(skill.name.to_lowercase()) {
                skills.push(skill);
            }
        }
    }
    skills
}

fn skill_files(root: &SkillRoot) -> Vec<PathBuf> {
    let mut paths = direct_skill_files(&root.path);
    if root.include_codex_system {
        paths.extend(direct_skill_files(&root.path.join(".system")));
    }
    paths.sort_by_key(|path| normalize_path(path).to_lowercase());
    paths
}

fn direct_skill_files(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                let skill_file = path.join("SKILL.md");
                return skill_file.is_file().then_some(skill_file);
            }
            let is_markdown = path
                .extension()
                .map(|extension| extension.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            is_markdown.then_some(path)
        })
        .collect()
}

fn parse_skill_file(path: &Path, scope: SkillScope) -> Option<SkillCompletionItem> {
    let content = fs::read_to_string(path).ok()?;
    let frontmatter = parse_frontmatter(&content)?;
    if yaml_bool(frontmatter.get("disable-model-invocation")) == Some(true)
        || yaml_bool(frontmatter.get("user-invocable")) == Some(false)
    {
        return None;
    }
    let name = frontmatter.get("name")?.as_str()?.trim();
    let description = frontmatter.get("description")?.as_str()?.trim();
    if name.is_empty()
        || name.len() > 120
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
        || description.is_empty()
    {
        return None;
    }
    Some(SkillCompletionItem {
        name: name.to_string(),
        description: description.to_string(),
        scope,
        path: normalize_path(path),
    })
}

fn parse_frontmatter(content: &str) -> Option<serde_yaml::Mapping> {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let body = normalized.strip_prefix("---\n")?;
    let end = body.find("\n---").or_else(|| body.find("\n..."))?;
    serde_yaml::from_str::<serde_yaml::Mapping>(&body[..end]).ok()
}

fn yaml_bool(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::Number(value) => value.as_i64().and_then(|value| match value {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => Some(true),
            "false" | "no" | "off" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(path: &Path, name: &str, description: &str, extra: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!("---\nname: {name}\ndescription: {description}\n{extra}---\n"),
        )
        .unwrap();
    }

    #[test]
    fn project_skill_wins_over_global_duplicate() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        let global_root = temp.path().join("global");
        write_skill(
            &project_root.join("demo/SKILL.md"),
            "demo-skill",
            "project description",
            "",
        );
        write_skill(
            &global_root.join("demo.md"),
            "demo-skill",
            "global description",
            "",
        );
        let roots = [
            SkillRoot {
                path: project_root,
                scope: SkillScope::Project,
                include_codex_system: false,
            },
            SkillRoot {
                path: global_root,
                scope: SkillScope::Global,
                include_codex_system: false,
            },
        ];

        let skills = discover_skills(&roots);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].scope, SkillScope::Project);
        assert_eq!(skills[0].description, "project description");
    }

    #[test]
    fn reads_codex_system_bundles_and_filters_unavailable_skills() {
        let temp = tempfile::tempdir().unwrap();
        write_skill(
            &temp.path().join(".system/system-skill/SKILL.md"),
            "system-skill",
            "available system skill",
            "",
        );
        write_skill(
            &temp.path().join("hidden/SKILL.md"),
            "hidden-skill",
            "hidden",
            "user-invocable: false\n",
        );
        let roots = [SkillRoot {
            path: temp.path().to_path_buf(),
            scope: SkillScope::Global,
            include_codex_system: true,
        }];

        let skills = discover_skills(&roots);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "system-skill");
    }
}
