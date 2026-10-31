use std::{collections::HashSet, fs, path::{Path, PathBuf}};

use anyhow::{ensure, Context};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionProject {
    pub path: String,
    #[serde(default = "enabled")]
    pub commands: bool,
    #[serde(default = "enabled")]
    pub script_tools: bool,
    #[serde(default = "enabled")]
    pub editors: bool,
}

fn enabled() -> bool { true }

fn read_config(workspace: &Path) -> anyhow::Result<serde_json::Value> {
    let path = workspace.join(".superhigh/project.json");
    if !path.exists() { return Ok(serde_json::json!({"version": 1})); }
    let raw = fs::read_to_string(&path).with_context(|| format!("无法读取项目配置：{}", path.display()))?;
    let config: serde_json::Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .with_context(|| format!("项目配置不是有效 JSON：{}", path.display()))?;
    ensure!(config["version"] == 1, "project.json 仅支持 version: 1：{}", path.display());
    Ok(config)
}

pub fn load(workspace: &Path) -> anyhow::Result<Vec<ExtensionProject>> {
    let config = read_config(workspace)?;
    match config.get("extensionProjects") {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone()).context("extensionProjects 必须是项目引用数组"),
    }
}

fn resolve(workspace: &Path, value: &str) -> anyhow::Result<PathBuf> {
    ensure!(!value.trim().is_empty(), "引用项目路径不能为空");
    let path = workspace.join(value.trim());
    let path = path.canonicalize().with_context(|| format!("引用项目不存在：{}", path.display()))?;
    ensure!(path.is_dir(), "引用项目必须是目录：{}", path.display());
    Ok(path)
}

/// 只读取显式直接引用，不继承来源项目的引用；顺序为当前工作区、引用列表。
pub fn roots(workspace: &Path, feature: &str) -> anyhow::Result<Vec<PathBuf>> {
    let root = workspace.canonicalize()?;
    let mut seen = HashSet::from([root.clone()]);
    let mut result = vec![root];
    for project in load(workspace)? {
        let active = match feature {
            "commands" => project.commands,
            "scriptTools" => project.script_tools,
            "editors" => project.editors,
            _ => anyhow::bail!("未知的项目引用类型：{feature}"),
        };
        if active {
            let path = resolve(workspace, &project.path)?;
            if seen.insert(path.clone()) { result.push(path); }
        }
    }
    Ok(result)
}

pub fn save(workspace: &Path, projects: Vec<ExtensionProject>) -> anyhow::Result<()> {
    let root = workspace.canonicalize()?;
    let mut seen = HashSet::from([root]);
    for project in &projects {
        // Disabled references may be retained while their drive is offline.
        if project.commands || project.script_tools || project.editors {
            ensure!(seen.insert(resolve(workspace, &project.path)?), "引用项目重复或指向当前工作区：{}", project.path);
        }
    }
    let mut config = read_config(workspace)?;
    config["extensionProjects"] = serde_json::to_value(projects)?;
    let path = workspace.join(".superhigh/project.json");
    fs::create_dir_all(path.parent().unwrap())?;
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&config)?))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_are_explicit_direct_deduplicated_and_preserve_startup() {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        let b = temp.path().join("b");
        let c = temp.path().join("c");
        for path in [&a, &b, &c] { fs::create_dir_all(path.join(".superhigh")).unwrap(); }
        fs::write(a.join(".superhigh/project.json"), r#"{"version":1,"startup":{"name":"keep"}}"#).unwrap();
        let reference = |path: &str| ExtensionProject { path: path.into(), commands: true, script_tools: false, editors: true };
        save(&b, vec![reference("../c")]).unwrap();
        save(&a, vec![reference("../b")]).unwrap();
        assert_eq!(roots(&a, "editors").unwrap(), vec![a.canonicalize().unwrap(), b.canonicalize().unwrap()]);
        assert_eq!(roots(&a, "scriptTools").unwrap().len(), 1);
        assert_eq!(roots(&c, "commands").unwrap().len(), 1);
        assert_eq!(read_config(&a).unwrap()["startup"]["name"], "keep");
        assert!(save(&a, vec![reference("../b"), reference("../b")]).is_err());
        save(&a, vec![]).unwrap();
        assert_eq!(roots(&a, "editors").unwrap().len(), 1);
    }
}
