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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOverviewItem {
    pub name: String,
    pub description: String,
    pub scope: SkillScope,
    pub path: String,
    pub body: String,
    /// Estimated tokens of the `- name: description` line that every session preloads.
    pub description_tokens: usize,
    /// Estimated tokens of the SKILL.md body that is only loaded when the skill is invoked.
    pub body_tokens: usize,
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

pub fn list_skill_overview(project_path: Option<&Path>) -> Vec<SkillOverviewItem> {
    list_skills(project_path)
        .into_iter()
        .map(|skill| {
            let body = fs::read_to_string(&skill.path)
                .map(|content| frontmatter_body(&content).trim().to_string())
                .unwrap_or_default();
            SkillOverviewItem {
                description_tokens: estimate_tokens(&format!(
                    "- {}: {}",
                    skill.name, skill.description
                )),
                body_tokens: estimate_tokens(&body),
                name: skill.name,
                description: skill.description,
                scope: skill.scope,
                path: skill.path,
                body,
            }
        })
        .collect()
}

/// Rough tokenizer-free estimate: CJK characters count as one token each,
/// every other character as a quarter token.
pub fn estimate_tokens(text: &str) -> usize {
    let (wide, narrow) = text.chars().fold((0usize, 0usize), |(wide, narrow), character| {
        if is_wide_character(character) {
            (wide + 1, narrow)
        } else {
            (wide, narrow + 1)
        }
    });
    wide + narrow.div_ceil(4)
}

fn is_wide_character(character: char) -> bool {
    matches!(
        character as u32,
        0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x20000..=0x2FA1F
    )
}

fn frontmatter_body(content: &str) -> String {
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return normalized;
    };
    match rest.find("\n---").or_else(|| rest.find("\n...")) {
        Some(end) => {
            let after = &rest[end + 4..];
            after.split_once('\n').map(|(_, body)| body).unwrap_or("").to_string()
        }
        None => normalized,
    }
}

fn skill_roots(project_path: Option<&Path>) -> Vec<SkillRoot> {
    let mut roots = Vec::new();
    if let Some(project_path) = project_path {
        for relative in [
            ".agents/skills",
            ".agent/skills",
            ".codex/skills",
            ".claude/skills",
            ".cursor/skills",
            ".codebuddy/skills",
            ".gemini/skills",
            ".kimi/skills",
            ".grok/skills",
            ".opencode/skills",
            ".superhigh/skills",
        ] {
            roots.push(SkillRoot {
                path: project_path.join(relative),
                scope: SkillScope::Project,
                include_codex_system: relative == ".codex/skills",
            });
        }
    }

    let Some(home) = user_home() else {
        return roots;
    };
    let agents_home = home.join(".agents");
    let codex_home = env_path_or("CODEX_HOME", &home.join(".codex"));
    let claude_home = env_path_or("CLAUDE_CONFIG_DIR", &home.join(".claude"));
    for (path, include_codex_system) in [
        (home.join(".superhigh/skills"), false),
        (agents_home.join("skills"), false),
        (home.join(".agent/skills"), false),
        (codex_home.join("skills"), true),
        (claude_home.join("skills"), false),
        (home.join(".cursor/skills"), false),
        (home.join(".codebuddy/skills"), false),
        (home.join(".gemini/skills"), false),
        (home.join(".kimi/skills"), false),
        (home.join(".grok/skills"), false),
        (home.join(".config/opencode/skills"), false),
        (home.join(".opencode/skills"), false),
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
    // Keep previews and relative Markdown links anchored to the source directory.
    let path = fs::canonicalize(path).ok()?;
    let content = fs::read_to_string(&path).ok()?;
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
        path: normalize_path(&path),
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
    fn workspace_superhigh_skills_are_project_scoped() {
        let temp = tempfile::tempdir().unwrap();
        let name = "workspace-superhigh-scope-regression";
        write_skill(&temp.path().join(".superhigh/skills/demo/SKILL.md"), name, "project skill", "");

        let skills = list_skills(Some(temp.path()));
        let skill = skills.iter().find(|skill| skill.name == name).unwrap();
        assert_eq!(skill.scope, SkillScope::Project);
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
    fn estimates_cjk_and_ascii_tokens_and_strips_frontmatter() {
        assert_eq!(estimate_tokens("技能概览"), 4);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("技能 abc"), 3);
        assert_eq!(
            frontmatter_body("---\r\nname: a\r\ndescription: b\r\n---\r\n# 正文\r\n"),
            "# 正文\n"
        );
        assert_eq!(frontmatter_body("plain"), "plain");
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

    #[cfg(any(unix, windows))]
    fn link_directory(source: &Path, target: &Path) {
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let source: PathBuf = source.components().collect();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&source, target).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&source, target).unwrap();
    }

    #[test]
    #[cfg(any(unix, windows))]
    fn shared_skills_use_source_paths_in_both_scopes() {
        for scope in [SkillScope::Project, SkillScope::Global] {
            let temp = tempfile::tempdir().unwrap();
            let source = temp.path().join(".skillshare/skills/demo/SKILL.md");
            write_skill(&source, "shared-skill", "shared description", "");
            let reference = source.parent().unwrap().join("references/guide.md");
            fs::create_dir_all(reference.parent().unwrap()).unwrap();
            fs::write(&reference, "shared reference").unwrap();
            let sibling = source.parent().unwrap().join("../overview.md");
            fs::write(&sibling, "shared overview").unwrap();

            // Skillshare links can be relative and can pass through another alias.
            link_directory(
                Path::new("../../.skillshare/skills/demo"),
                &temp.path().join(".codex/skills/demo"),
            );
            link_directory(
                Path::new("../../.codex/skills/demo"),
                &temp.path().join(".agents/skills/demo"),
            );
            let skills = discover_skills(&[SkillRoot {
                path: temp.path().join(".agents/skills"),
                scope,
                include_codex_system: false,
            }]);

            assert_eq!(skills.len(), 1);
            assert_eq!(skills[0].scope, scope);
            assert_eq!(
                skills[0].path,
                normalize_path(&source.canonicalize().unwrap())
            );
            let preview_directory = Path::new(&skills[0].path).parent().unwrap();
            assert_eq!(
                fs::read_to_string(preview_directory.join("references/guide.md")).unwrap(),
                "shared reference"
            );
            assert_eq!(
                fs::read_to_string(preview_directory.join("../overview.md")).unwrap(),
                "shared overview"
            );
        }
    }

    #[test]
    #[cfg(any(unix, windows))]
    fn skips_dangling_shared_skill_links() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join(".agents/skills");
        link_directory(&temp.path().join("missing"), &root.join("missing"));
        write_skill(&root.join("valid/SKILL.md"), "valid-skill", "valid", "");

        let skills = discover_skills(&[SkillRoot {
            path: root,
            scope: SkillScope::Project,
            include_codex_system: false,
        }]);

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "valid-skill");
    }
}
