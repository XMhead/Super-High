use std::{
    collections::HashSet,
    env, fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;

pub(crate) fn handle_workspace(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        return help(stdout);
    }
    let operation = args.remove(0);
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        return help(stdout);
    }
    if !matches!(operation.as_str(), "list" | "inspect") {
        bail!("unknown workspace command `{operation}`");
    }
    let mut project = None;
    let mut filter = String::new();
    let mut limit = 20usize;
    let mut offset = 0usize;
    let mut json_output = false;
    let mut seen = HashSet::new();
    let mut index = 0;
    while index < args.len() {
        let key = args[index].split('=').next().unwrap();
        if !seen.insert(key.to_string()) {
            bail!("duplicate option `{key}`");
        }
        if key == "--json" && args[index] == key {
            json_output = true;
        } else {
            let valid = match operation.as_str() {
                "list" => matches!(key, "--filter" | "--limit" | "--offset"),
                _ => key == "--project",
            };
            if !valid {
                bail!("unknown option `{}` for workspace {operation}", args[index]);
            }
            let value = if let Some((_, value)) = args[index].split_once('=') {
                value.to_string()
            } else {
                index += 1;
                args.get(index)
                    .filter(|value| !value.starts_with("--"))
                    .context("option requires a value")?
                    .clone()
            };
            match key {
                "--project" => {
                    if value.trim().is_empty() {
                        bail!("--project requires a path");
                    }
                    project = Some(PathBuf::from(value));
                }
                "--filter" => filter = value,
                "--limit" => {
                    limit = value.parse().context("--limit requires an integer")?;
                    if !(1..=100).contains(&limit) {
                        bail!("--limit must be between 1 and 100");
                    }
                }
                "--offset" => offset = value.parse().context("--offset requires an integer")?,
                _ => unreachable!(),
            }
        }
        index += 1;
    }
    let result = if operation == "inspect" {
        inspect(&project.unwrap_or(env::current_dir()?), true)
    } else {
        history(&database_path()?, &filter, offset, limit)?
    };
    if json_output {
        serde_json::to_writer_pretty(&mut *stdout, &result)?;
        writeln!(stdout)?;
    } else if operation == "list" {
        for item in result["items"].as_array().unwrap() {
            write_summary(stdout, item)?;
        }
        writeln!(
            stdout,
            "total={} offset={} hasMore={}",
            result["total"], result["offset"], result["hasMore"]
        )?;
    } else {
        write_summary(stdout, &result)?;
        serde_json::to_writer_pretty(&mut *stdout, &result)?;
        writeln!(stdout)?;
    }
    Ok(())
}

fn help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(stdout, "Usage:\n  superhigh-cli workspace list [--filter <name-or-path>] [--limit <1..100>] [--offset <n>] [--json]\n  superhigh-cli workspace inspect [--project <path>] [--json]\n\nList reads SuperHigh workspace history without starting the desktop app.\nInspect defaults to the current directory. Both commands are read-only.\nResults contain .superhigh file metadata, real editor pages, tools (including hidden), and contract gaps.\nImages, pasted-images, and unregistered template.html pages are skipped. Config values and page content are not dumped.")?;
    Ok(())
}

pub(crate) fn database_path() -> Result<PathBuf> {
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let identifier = config["identifier"]
        .as_str()
        .context("missing app identifier")?;
    #[cfg(target_os = "windows")]
    let base = PathBuf::from(env::var_os("APPDATA").context("APPDATA is unavailable")?);
    #[cfg(target_os = "macos")]
    let base = PathBuf::from(env::var_os("HOME").context("HOME is unavailable")?)
        .join("Library/Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or(
        PathBuf::from(env::var_os("HOME").context("HOME is unavailable")?).join(".local/share"),
    );
    Ok(base.join(identifier).join("super-high.db"))
}

fn history(path: &Path, filter: &str, offset: usize, limit: usize) -> Result<Value> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("cannot read SuperHigh workspace history; open a workspace in SuperHigh first")?;
    connection.busy_timeout(std::time::Duration::from_secs(3))?;
    let mut statement = connection.prepare(
        "SELECT path, name, last_opened_at FROM recent_projects ORDER BY last_opened_at DESC, path",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let filter = filter.to_lowercase();
    let mut records = Vec::new();
    for row in rows {
        let (path, name, last_opened_at) = row?;
        if filter.is_empty()
            || path.to_lowercase().contains(&filter)
            || name.to_lowercase().contains(&filter)
        {
            records.push((path, name, last_opened_at));
        }
    }
    let total = records.len();
    let items: Vec<Value> = records
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(path, name, timestamp)| {
            let mut item = inspect(Path::new(&path), false);
            item["name"] = json!(name);
            item["lastOpenedAt"] = json!(timestamp);
            item
        })
        .collect();
    Ok(
        json!({"items": items, "total": total, "offset": offset, "hasMore": offset.saturating_add(limit) < total}),
    )
}

fn read_json(path: &Path) -> Result<Value> {
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        bail!("config exceeds 2 MiB");
    }
    let text = std::str::from_utf8(&bytes)?.trim_start_matches('\u{feff}');
    Ok(serde_json::from_str(text)?)
}

fn inspect(project: &Path, detailed: bool) -> Value {
    let root = project.join(".superhigh");
    let mut errors = Vec::<String>::new();
    let mut files = Vec::new();
    if root.is_dir() {
        inventory(&root, &root, &mut files, &mut errors);
    }
    files.sort_by(|a: &Value, b: &Value| a["path"].as_str().cmp(&b["path"].as_str()));
    let mut pages = Vec::new();
    let manifest_path = root.join("editor/editor.json");
    if manifest_path.is_file() {
        match read_json(&manifest_path) {
            Ok(manifest) => {
                if manifest["version"] != 1 || !manifest["pages"].is_array() {
                    errors.push("editor/editor.json: expected version 1 and pages array".into());
                }
                for page in manifest["pages"].as_array().into_iter().flatten() {
                    let entry = page["entry"].as_str().unwrap_or("");
                    let safe = !entry.is_empty()
                        && !entry.contains(['/', '\\', ':'])
                        && entry.to_ascii_lowercase().ends_with(".html");
                    let path = root.join("editor").join(entry);
                    let exists = safe && path.is_file();
                    let mut calls = Vec::new();
                    let mut legacy_apis = Vec::new();
                    if exists {
                        match fs::read_to_string(&path) {
                            Ok(text) => {
                                legacy_apis = legacy_host_api_references(&text);
                                let pattern = regex::Regex::new(
                                    r#"runScriptTool(?:Json)?\s*\(\s*['"]([^'"]+)['"]"#,
                                )
                                .unwrap();
                                calls = pattern
                                    .captures_iter(&text)
                                    .map(|capture| capture[1].to_string())
                                    .collect();
                                calls.sort();
                                calls.dedup();
                            }
                            Err(error) => errors.push(format!("editor/{entry}: {error}")),
                        }
                    }
                    if !exists {
                        errors.push(format!("editor/{entry}: missing or invalid entry"));
                    }
                    pages.push(json!({"id": page["id"], "title": page["title"], "entry": entry, "codePreviewRoot": page["codePreviewRoot"], "exists": exists, "scriptToolIds": calls, "legacyHostApiReferences": legacy_apis}));
                }
            }
            Err(error) => errors.push(format!("editor/editor.json: {error}")),
        }
    }
    let mut tools = Vec::new();
    if root.join("script-tools.json").is_file() {
        match crate::script_tools::inspect_project_script_tools(project, true) {
            Ok(list) => {
                tools = list
                    .tools
                    .into_iter()
                    .map(|tool| {
                        let mut gaps = Vec::<String>::new();
                        if tool.description.trim().is_empty() {
                            gaps.push("description".into());
                        }
                        if tool.output.is_none() {
                            gaps.push("output".into());
                        }
                        if tool.examples.is_empty() {
                            gaps.push("examples".into());
                        }
                        for parameter in &tool.parameters {
                            if parameter.description.trim().is_empty() {
                                gaps.push(format!("parameters.{}.description", parameter.id));
                            }
                        }
                        if let Some(output) = &tool.output {
                            if output.description.trim().is_empty() {
                                gaps.push("output.description".into());
                            }
                            if output.format == "json" && output.schema.is_none() {
                                gaps.push("output.schema".into());
                            }
                        }
                        let mut value = serde_json::to_value(tool).unwrap();
                        value["contractGaps"] = json!(gaps);
                        value
                    })
                    .collect()
            }
            Err(error) => errors.push(format!("script-tools.json: {error}")),
        }
    }
    let ids: HashSet<&str> = tools
        .iter()
        .filter_map(|tool| tool["id"].as_str())
        .collect();
    for page in &mut pages {
        let missing: Vec<&str> = page["scriptToolIds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !ids.contains(id))
            .collect();
        page["unregisteredScriptToolIds"] = json!(missing);
    }
    if !detailed {
        tools = tools.into_iter().map(|tool| json!({"id": tool["id"], "title": tool["title"], "sourcePath": tool["sourcePath"], "hidden": tool["hidden"], "contractGaps": tool["contractGaps"]})).collect();
    }
    let state = if !project.is_dir() {
        "missing-workspace"
    } else if !root.is_dir() {
        "no-superhigh"
    } else if !errors.is_empty() {
        "invalid"
    } else {
        "ready"
    };
    json!({"path": crate::fs_ops::normalize_path(project), "state": state, "files": files, "pages": pages, "tools": tools, "errors": errors,
        "cache": {"path": crate::fs_ops::normalize_path(&root.join("cache")), "exists": root.join("cache").is_dir(), "disposable": true},
        "scriptToolReferences": "static references only; dynamic IDs, wrappers and capability fallbacks require targeted page inspection"})
}

fn legacy_host_api_references(text: &str) -> Vec<String> {
    let aliases =
        regex::Regex::new(r"\b(\w+)\s*=\s*window\.superhighEditor\b").unwrap();
    let mut names = vec!["window.superhighEditor".to_string()];
    names.extend(
        aliases
            .captures_iter(text)
            .map(|capture| capture[1].to_string()),
    );
    let mut references = Vec::new();
    for name in names {
        for method in [
            "rcon",
            "minecraft",
            "dragonCore",
            "searchItemLibrary",
            "getItemKeys",
        ] {
            let pattern = format!(r"{}\s*\.\s*{}\s*\(", regex::escape(&name), method);
            if regex::Regex::new(&pattern).unwrap().is_match(text) {
                references.push(method.to_string());
            }
        }
    }
    if regex::Regex::new(r"\bsuperhigh\s*(?:\?\.|\.)\s*itemLibrary\b").unwrap().is_match(text) {
        references.push("superhigh.itemLibrary".into());
    }
    references.sort();
    references.dedup();
    references
}

fn skipped(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png"
                    | "jpg"
                    | "jpeg"
                    | "gif"
                    | "webp"
                    | "bmp"
                    | "ico"
                    | "svg"
                    | "avif"
                    | "tif"
                    | "tiff"
            )
        })
}

fn inventory(root: &Path, directory: &Path, files: &mut Vec<Value>, errors: &mut Vec<String>) {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) => {
            errors.push(format!("{}: {error}", directory.display()));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(error) => {
                errors.push(format!("{relative}: {error}"));
                continue;
            }
        };
        if kind.is_symlink() || matches!(relative.as_str(), "pasted-images" | "cache") || skipped(&path) {
            continue;
        }
        if kind.is_dir() {
            // Only inspect the defined extension directories, one level deep.
            if directory == root
                && matches!(relative.as_str(), "editor" | "script-tools" | "plugins")
            {
                inventory(root, &path, files, errors);
            }
            continue;
        }
        if !kind.is_file()
            || matches!(
                relative.as_str(),
                "editor/template.html" | "script-tools/template.html"
            )
        {
            continue;
        }
        match entry.metadata() {
            Ok(metadata) => {
                let mut file =
                    json!({"path": format!(".superhigh/{relative}"), "bytes": metadata.len()});
                if path.extension().is_some_and(|ext| ext == "json") {
                    match read_json(&path) {
                        Ok(value) => {
                            file["jsonValid"] = json!(true);
                            file["version"] = value.get("version").cloned().unwrap_or(Value::Null);
                        }
                        Err(error) => {
                            file["jsonValid"] = json!(false);
                            errors.push(format!("{relative}: {error}"));
                        }
                    }
                }
                files.push(file);
            }
            Err(error) => errors.push(format!("{relative}: {error}")),
        }
    }
}

fn write_summary(stdout: &mut dyn Write, item: &Value) -> Result<()> {
    writeln!(
        stdout,
        "{} [{}] pages={} tools={} files={}",
        item["path"].as_str().unwrap_or(""),
        item["state"].as_str().unwrap_or(""),
        item["pages"].as_array().map_or(0, Vec::len),
        item["tools"].as_array().map_or(0, Vec::len),
        item["files"].as_array().map_or(0, Vec::len)
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspection_reports_cache_without_reading_derived_files() {
        let workspace = tempfile::tempdir().unwrap();
        crate::workspace_config::initialize(workspace.path()).unwrap();
        fs::write(workspace.path().join(".superhigh/cache/broken.json"), "not valid JSON").unwrap();
        let result = inspect(workspace.path(), true);
        assert_eq!(result["state"], "ready");
        assert_eq!(result["cache"]["exists"], true);
        assert_eq!(result["cache"]["disposable"], true);
        assert!(result["files"].as_array().unwrap().iter().all(|file| !file["path"].as_str().unwrap().contains("/cache/")));
        assert!(!result.to_string().contains("broken.json"));
    }

    #[test]
    fn identifies_legacy_bridges_without_marking_generic_tool_calls() {
        assert_eq!(legacy_host_api_references("const root=document.body, api = window.superhighEditor; api.rcon('reload'); api.runScriptTool('query'); window.superhigh?.itemLibrary?.getKeys('ni')"), vec!["rcon", "superhigh.itemLibrary"]);
        assert!(legacy_host_api_references("const api = window.superhighEditor; api.fs('read', 'a'); api.runScriptToolJson('query')").is_empty());
    }

    #[test]
    fn inspection_skips_images_and_templates_but_keeps_registered_template_and_hidden_contracts() {
        let directory = tempfile::tempdir().unwrap();
        let project = directory.path();
        crate::workspace_config::initialize(project).unwrap();
        fs::create_dir(project.join("scripts")).unwrap();
        fs::write(
            project.join("scripts/query.py"),
            "raise Exception('must not run')",
        )
        .unwrap();
        fs::write(
            project.join(".superhigh/editor/template.html"),
            "<script>superhighEditor.runScriptTool('missing')</script>",
        )
        .unwrap();
        fs::write(
            project.join(".superhigh/editor/editor.json"),
            r#"{"version":1,"pages":[{"id":"real","title":"Real","entry":"template.html"}]}"#,
        )
        .unwrap();
        fs::write(project.join(".superhigh/editor/asset.png"), "not read").unwrap();
        fs::create_dir(project.join(".superhigh/pasted-images")).unwrap();
        fs::write(
            project.join(".superhigh/pasted-images/not-json.json"),
            "not read",
        )
        .unwrap();
        fs::write(
            project.join(".superhigh/minecraft-rcon.json"),
            r#"{"password":"secret"}"#,
        )
        .unwrap();
        fs::write(project.join(".superhigh/script-tools.json"), r#"{"version":1,"directories":[{"path":"scripts"}],"tools":[{"version":1,"id":"query","title":"Query","script":"scripts/query.py","runtime":"python","hidden":true,"description":"Read","examples":[{}],"output":{"format":"json","description":"One JSON result","schema":{"type":"object"},"example":{"items":[]}}}]}"#).unwrap();
        let result = inspect(project, true);
        assert_eq!(result["tools"][0]["hidden"], true);
        assert_eq!(result["tools"][0]["contractGaps"], json!([]));
        assert_eq!(
            result["pages"][0]["unregisteredScriptToolIds"],
            json!(["missing"])
        );
        let text = result.to_string();
        assert!(!text.contains("secret"));
        assert!(!text.contains("asset.png"));
        assert!(!text.contains("not-json.json"));
        assert!(!result["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == ".superhigh/editor/template.html"));
    }

    #[test]
    fn history_paginates_all_records_without_migrating_database() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("history.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE recent_projects(path TEXT, name TEXT, last_opened_at TEXT);",
            )
            .unwrap();
        for index in 0..15 {
            connection
                .execute(
                    "INSERT INTO recent_projects VALUES (?1, ?2, ?3)",
                    rusqlite::params![
                        format!("missing/{index}"),
                        "Workspace",
                        format!("{index:02}")
                    ],
                )
                .unwrap();
        }
        drop(connection);
        let before = fs::read(&path).unwrap();
        let result = history(&path, "WORKSPACE", 12, 2).unwrap();
        assert_eq!(result["total"], 15);
        assert_eq!(result["items"].as_array().unwrap().len(), 2);
        assert_eq!(result["hasMore"], true);
        assert_eq!(result["items"][0]["state"], "missing-workspace");
        assert_eq!(before, fs::read(&path).unwrap());
    }
}
