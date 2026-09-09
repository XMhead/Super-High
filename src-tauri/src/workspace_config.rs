use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};

use anyhow::{ensure, Context};

const DEFAULT_FILES: &[(&str, &str)] = &[
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

/// 打开工作区时补齐基础扩展文件，不覆盖用户配置或登记模板页面。
pub fn initialize(workspace: &Path) -> anyhow::Result<()> {
    ensure!(
        workspace.is_dir(),
        "工作区目录不存在：{}",
        workspace.display()
    );
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
        initialize(workspace.path()).unwrap();
        let root = workspace.path().join(".superhigh");
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join("editor/editor.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["pages"], serde_json::json!([]));
        let tools = crate::script_tools::list_project_script_tools(workspace.path()).unwrap();
        assert!(tools.tools.is_empty());
        for relative in ["editor/editor.json", "script-tools/template.html"] {
            fs::write(root.join(relative), "user content").unwrap();
        }
        initialize(workspace.path()).unwrap();
        for relative in ["editor/editor.json", "script-tools/template.html"] {
            assert_eq!(
                fs::read_to_string(root.join(relative)).unwrap(),
                "user content"
            );
        }
    }
}
