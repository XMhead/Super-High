use std::{env, io::Write, path::PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::item_library::{query_item_library_text, ItemLibrarySource, ItemLibraryTextEntry};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemsResponse {
    total_items: usize,
    offset: usize,
    limit: usize,
    items: Vec<ItemLibraryTextEntry>,
}

pub(crate) fn handle_items(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "-h" | "--help") {
        writeln!(stdout, "Usage:
  superhigh-cli items search <query> [--project <path>] [--source ni|mm|all] [--limit <n>] [--offset <n>] [--json]
  superhigh-cli items keys [--project <path>] [--source ni|mm|all] [--limit <n>] [--offset <n>] [--json]

Defaults: current project, all sources, limit 20 (1..200), offset 0.
Search matches item keys and display names. Results include source, file and line.
Only project-local NeigeItems/Items and MythicMobs/Items are scanned.
Pagination orders NI before MM. No image data is loaded.")?;
        return Ok(());
    }
    let command = args.remove(0);
    if !matches!(command.as_str(), "search" | "keys") {
        bail!("unknown items command `{command}`. Run `superhigh-cli items --help`.");
    }
    let mut project = None;
    let mut source = None;
    let mut limit = None;
    let mut offset = None;
    let mut json = false;
    let mut query = Vec::new();
    while !args.is_empty() {
        let arg = args.remove(0);
        if arg == "--json" {
            json = true;
            continue;
        }
        if arg.starts_with('-') {
            let (name, inline) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(n, v)| (n, Some(v)));
            let target = match name {
                "--project" => &mut project,
                "--source" => &mut source,
                "--limit" => &mut limit,
                "--offset" => &mut offset,
                _ => bail!("unknown option `{name}`"),
            };
            let value = match inline {
                Some(value) => value.to_string(),
                None if !args.is_empty() && !args[0].starts_with('-') => args.remove(0),
                None => bail!("{name} requires a value"),
            };
            if value.trim().is_empty() {
                bail!("{name} requires a nonempty value");
            }
            if target.replace(value).is_some() {
                bail!("{name} was provided more than once");
            }
        } else {
            query.push(arg);
        }
    }
    let query = query.join(" ");
    if command == "search" && query.trim().is_empty() {
        bail!("items search requires a query");
    }
    if command == "keys" && !query.is_empty() {
        bail!("items keys does not accept a query");
    }
    let project = match project {
        Some(path) => PathBuf::from(path),
        None => env::current_dir().context("failed to resolve current directory")?,
    };
    if !project.is_dir() {
        bail!("project directory does not exist: {}", project.display());
    }
    let source = source.as_deref().unwrap_or("all");
    if !matches!(source, "ni" | "mm" | "all") {
        bail!("invalid --source `{source}`; expected ni, mm or all");
    }
    let limit = parse_number(limit, "--limit", 20)?;
    if !(1..=200).contains(&limit) {
        bail!("--limit must be between 1 and 200");
    }
    let offset = parse_number(offset, "--offset", 0)?;
    let mut response = ItemsResponse {
        total_items: 0,
        offset,
        limit,
        items: Vec::new(),
    };
    let mut found_source = false;
    for (name, kind) in [
        ("ni", ItemLibrarySource::Ni),
        ("mm", ItemLibrarySource::Mm),
    ] {
        if source != "all" && source != name {
            continue;
        }
        if source == "all" && kind.workspace_library_root(&project).is_none() {
            continue;
        }
        found_source = true;
        let (total, items) = query_item_library_text(
            &project,
            kind,
            &query,
            offset.saturating_sub(response.total_items),
            limit.saturating_sub(response.items.len()),
        )?;
        response.total_items += total;
        response.items.extend(items);
    }
    if !found_source {
        bail!(
            "no item library found under {} (NeigeItems/Items or MythicMobs/Items)",
            project.display()
        );
    }
    if json {
        serde_json::to_writer_pretty(&mut *stdout, &response)?;
        writeln!(stdout)?;
    } else {
        writeln!(
            stdout,
            "{} matches; offset {}, showing {}",
            response.total_items,
            offset,
            response.items.len()
        )?;
        for item in response.items {
            writeln!(
                stdout,
                "{}\t{}\t{}\t{}:{}",
                item.source,
                item.item_key,
                item.display_name.as_deref().unwrap_or("-"),
                item.file_path,
                item.line_number
            )?;
        }
    }
    Ok(())
}

fn parse_number(value: Option<String>, name: &str, default: usize) -> Result<usize> {
    match value {
        Some(value) => value
            .parse()
            .with_context(|| format!("invalid {name} value `{value}`")),
        None => Ok(default),
    }
}

#[cfg(test)]
mod tests {
    use super::handle_items;
    use serde_json::Value;
    use std::{fs, path::Path};

    fn run(project: &Path, arguments: &[&str]) -> anyhow::Result<Value> {
        let mut args = arguments
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        args.extend([
            "--project".into(),
            project.to_string_lossy().into_owned(),
            "--json".into(),
        ]);
        let mut output = Vec::new();
        handle_items(&mut args, &mut output)?;
        Ok(serde_json::from_slice(&output)?)
    }

    #[test]
    fn searches_both_sources_and_paginates_across_them_without_images() {
        let project = tempfile::tempdir().unwrap();
        for (directory, content) in [
            (
                "NeigeItems",
                "ni_sword:\n  name: Shared Sword\n  material: DIAMOND_SWORD\n",
            ),
            (
                "MythicMobs",
                "mm_sword:\n  Display: Shared Sword\n  Id: IRON_SWORD\n",
            ),
        ] {
            let root = project.path().join(directory).join("Items");
            fs::create_dir_all(&root).unwrap();
            fs::write(root.join("items.yml"), content).unwrap();
        }
        for (source, key) in [("ni", "ni_sword"), ("mm", "mm_sword")] {
            let result = run(project.path(), &["search", "Shared", "--source", source]).unwrap();
            assert_eq!(result["totalItems"], 1);
            assert_eq!(result["items"][0]["itemKey"], key);
            assert_eq!(result["items"][0]["source"], source);
            assert_eq!(result["items"][0]["lineNumber"], 1);
            assert!(result["items"][0].get("dragonCoreIcon").is_none());
        }
        let result = run(project.path(), &["keys", "--offset", "1", "--limit", "1"]).unwrap();
        assert_eq!(result["totalItems"], 2);
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["source"], "mm");
        let result = run(project.path(), &["keys", "--offset", "999"]).unwrap();
        assert_eq!(result["totalItems"], 2);
        assert!(result["items"].as_array().unwrap().is_empty());
        assert!(!project.path().join(".superhigh").exists());
    }

    #[test]
    fn all_sources_supports_server_and_plugin_workspaces() {
        let project = tempfile::tempdir().unwrap();
        for directory in ["NeigeItems", "MythicMobs"] {
            let plugin = project.path().join("plugins").join(directory);
            fs::create_dir_all(plugin.join("Items")).unwrap();
            fs::write(plugin.join("Items/items.yml"), "test:\n  Id: STONE\n").unwrap();
            assert_eq!(run(&plugin, &["keys"]).unwrap()["totalItems"], 1);
            assert!(!plugin.join(".superhigh").exists());
        }
        assert_eq!(run(project.path(), &["keys"]).unwrap()["totalItems"], 2);
        assert!(!project.path().join(".superhigh").exists());
    }

    #[test]
    fn reads_existing_shared_and_source_ignore_rules_without_rewriting() {
        let project = tempfile::tempdir().unwrap();
        for directory in ["NeigeItems", "MythicMobs"] {
            let root = project.path().join(directory).join("Items");
            fs::create_dir_all(&root).unwrap();
            for file in ["shared.yml", "ni.yml", "mm.yml", "keep.yml"] {
                fs::write(
                    root.join(file),
                    format!(
                        "{}:\n  material: STONE\n  Id: STONE\n",
                        file.trim_end_matches(".yml")
                    ),
                )
                .unwrap();
            }
        }
        let config = project.path().join(".superhigh/item-library-ignore.yml");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        let content = "# Preserve this comment\nshared: [shared.yml]\nni: [ni.yml]\nmm: [mm.yml]\n";
        fs::write(&config, content).unwrap();
        for (source, expected) in [("ni", "mm"), ("mm", "ni")] {
            let result = run(project.path(), &["keys", "--source", source]).unwrap();
            assert_eq!(result["totalItems"], 2);
            let keys = result["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["itemKey"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert!(keys.contains(&"keep"));
            assert!(keys.contains(&expected));
            let result = run(project.path(), &["search", "shared", "--source", source]).unwrap();
            assert_eq!(result["totalItems"], 0);
        }
        assert_eq!(fs::read_to_string(&config).unwrap(), content);
    }

    #[test]
    fn handles_single_source_and_rejects_bad_inputs() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().join("MythicMobs/Items");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("items.yml"), "test:\n  Id: STONE\n").unwrap();
        assert_eq!(run(project.path(), &["keys"]).unwrap()["totalItems"], 1);
        for args in [
            vec!["search"],
            vec!["keys", "--source", "bad"],
            vec!["keys", "--limit", "0"],
            vec!["keys", "--limit", "201"],
            vec!["keys", "--offset", "abc"],
            vec!["keys", "--source", "ni"],
            vec!["keys", "--unknown"],
            vec!["keys", "--limit", "1", "--limit", "2"],
        ] {
            assert!(run(project.path(), &args).is_err(), "{args:?}");
        }
    }
}
