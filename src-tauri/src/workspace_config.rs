use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};

use anyhow::{ensure, Context};

const DEFAULT_FILES: &[(&str, &str)] = &[
    ("commands.json", "{\n  \"version\": 1,\n  \"commands\": []\n}\n"),
    ("cache/.gitignore", "*\n!.gitignore\n"),
    (
        "script-tools.json",
        "{\n  \"version\": 1,\n  \"directories\": [],\n  \"tools\": []\n}\n",
    ),
    (
        "editor/editor.json",
        "{\n  \"version\": 1,\n  \"pages\": []\n}\n",
    ),
    (
        "editor/template.html",
        include_str!("workspace_templates/editor.html"),
    ),
    (
        "script-tools/template.html",
        include_str!("workspace_templates/script-tool.html"),
    ),
];

/// 仅为有 Agent 指令或项目 Skill 的工作区补齐基础扩展文件。
pub fn initialize(workspace: &Path) -> anyhow::Result<()> {
    ensure!(
        workspace.is_dir(),
        "工作区目录不存在：{}",
        workspace.display()
    );
    if !["AGENTS.md", "CLAUDE.md"]
        .iter()
        .any(|name| workspace.join(name).is_file())
        && !crate::skills::has_project_skills(workspace)
    {
        return Ok(());
    }
    let root = workspace.join(".superhigh");
    for (relative, content) in DEFAULT_FILES {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("default file parent"))
            .with_context(|| format!("无法创建扩展目录：{}", path.display()))?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => file
                .write_all(content.as_bytes())
                .with_context(|| format!("无法写入默认扩展文件：{}", path.display()))?,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("无法创建默认扩展文件：{}", path.display()));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_empty_registries_without_overwriting_project_files() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("AGENTS.md"), "# Rules\n").unwrap();
        initialize(workspace.path()).unwrap();
        let root = workspace.path().join(".superhigh");
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("editor/editor.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["pages"], serde_json::json!([]));
        let commands: serde_json::Value = serde_json::from_str(&fs::read_to_string(root.join("commands.json")).unwrap()).unwrap();
        assert_eq!(commands["commands"], serde_json::json!([]));
        let tools = crate::script_tools::inspect_script_tools(workspace.path(), false, "project").unwrap();
        assert!(tools.tools.is_empty());
        for relative in ["commands.json", "editor/editor.json", "script-tools/template.html"] {
            fs::write(root.join(relative), "user content").unwrap();
        }
        initialize(workspace.path()).unwrap();
        for relative in ["commands.json", "editor/editor.json", "script-tools/template.html"] {
            assert_eq!(
                fs::read_to_string(root.join(relative)).unwrap(),
                "user content"
            );
        }
        assert!(!root.join("item-library.json").exists());
        assert!(!root.join("item-library-ignore.yml").exists());
    }

    #[test]
    fn initializes_workspace_cache_without_replacing_existing_data() {
        let workspace = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("CLAUDE.md"), "# Rules\n").unwrap();
        initialize(workspace.path()).unwrap();
        let cache = workspace.path().join(".superhigh/cache");
        assert_eq!(fs::read_to_string(cache.join(".gitignore")).unwrap(), "*\n!.gitignore\n");
        fs::write(cache.join("snapshot.json"), "cached data").unwrap();
        fs::write(cache.join(".gitignore"), "custom rules").unwrap();
        initialize(workspace.path()).unwrap();
        assert_eq!(fs::read_to_string(cache.join("snapshot.json")).unwrap(), "cached data");
        assert_eq!(fs::read_to_string(cache.join(".gitignore")).unwrap(), "custom rules");
    }

    #[test]
    fn unmarked_directories_are_not_initialized_or_replenished() {
        let workspace = tempfile::tempdir().unwrap();
        // Ancestor and child projects must not qualify this exact workspace.
        fs::write(workspace.path().join("AGENTS.md"), "rules").unwrap();
        let ordinary = workspace.path().join("ordinary");
        fs::create_dir_all(ordinary.join("child/.codex/skills/demo")).unwrap();
        fs::write(ordinary.join("child/CLAUDE.md"), "rules").unwrap();
        fs::write(ordinary.join("child/.codex/skills/demo/SKILL.md"), "skill").unwrap();
        // Empty provider folders and directories named like instruction files are not markers.
        fs::create_dir_all(ordinary.join(".agents/skills")).unwrap();
        fs::create_dir(ordinary.join("AGENTS.md")).unwrap();
        for _ in 0..2 {
            initialize(&ordinary).unwrap();
            assert!(!ordinary.join(".superhigh").exists());
        }
        let root = ordinary.join(".superhigh");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("commands.json"), "existing content").unwrap();
        initialize(&ordinary).unwrap();
        assert_eq!(fs::read_to_string(root.join("commands.json")).unwrap(), "existing content");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn project_skills_qualify_without_instruction_files() {
        for relative in [
            ".agents/skills/demo/SKILL.md", ".agent/skills/demo/SKILL.md",
            ".codex/skills/demo/SKILL.md", ".codex/skills/.system/demo/SKILL.md",
            ".claude/skills/demo/SKILL.md", ".cursor/skills/demo/SKILL.md",
            ".codebuddy/skills/demo/SKILL.md", ".gemini/skills/demo/SKILL.md",
            ".kimi/skills/demo/SKILL.md", ".grok/skills/demo/SKILL.md",
            ".opencode/skills/demo/SKILL.md", ".superhigh/skills/demo/SKILL.md",
            ".claude/skills/legacy.md",
        ] {
            let workspace = tempfile::tempdir().unwrap();
            let skill = workspace.path().join(relative);
            fs::create_dir_all(skill.parent().unwrap()).unwrap();
            fs::write(skill, "---\nname: demo\ndescription: demo\ndisable-model-invocation: true\n---\n").unwrap();
            initialize(workspace.path()).unwrap();
            assert!(workspace.path().join(".superhigh/commands.json").is_file(), "{relative}");
        }
    }
}
