use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::{mpsc, Mutex}, time::Duration};

use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::fs_ops::{
    create_directory, create_empty_file, delete_path, list_directory, normalize_path,
    read_text_file, rename_path, write_text_file,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePathResult {
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileReadResult {
    path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileRenameResult {
    path: String,
    new_path: String,
}

pub(crate) fn handle_files(
    args: &mut Vec<String>,
    stdout: &mut dyn std::io::Write,
) -> anyhow::Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_files_help(stdout);
    }

    let subcommand = args.remove(0);
    match subcommand.as_str() {
        "ls" => files_ls(args, stdout),
        "read" => files_read(args, stdout),
        "write" => files_write(args, stdout),
        "touch" => files_touch(args, stdout),
        "mkdir" => files_mkdir(args, stdout),
        "rename" => files_rename(args, stdout),
        "delete" => files_delete(args, stdout),
        "open" => files_open(args, stdout),
        _ => bail!("unknown files command `{subcommand}`. Run `superhigh-cli files --help`."),
    }
}

type PendingOpen = mpsc::Sender<std::result::Result<Value, String>>;
static PENDING_OPEN: Lazy<Mutex<BTreeMap<String, PendingOpen>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));

/// 桌面端完成 `files open` 后经 `files_cli_complete_command` 回执。
pub fn complete_open(id: &str, result: Value, error: Option<String>) {
    if let Some(sender) = PENDING_OPEN.lock().unwrap().remove(id) {
        let _ = sender.send(match error { Some(error) => Err(error), None => Ok(result) });
    }
}

/// 本地控制管道收到 `files.open` 后，请桌面端在代码预览中打开文件并等待回执。
pub fn execute_open_bridge(app: &tauri::AppHandle, raw: &str) -> Value {
    let run = || -> Result<Value> {
        let request: Value = serde_json::from_str(raw)?;
        let path = request["path"].as_str().context("files.open requires path")?.to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        PENDING_OPEN.lock().unwrap().insert(id.clone(), sender);
        let result = (|| {
            app.emit("files-open-request", json!({"id": id, "path": path, "sessionId": request["sessionId"]}))?;
            receiver.recv_timeout(Duration::from_secs(20))
                .context("SuperHigh did not open the file in time; make sure a workspace is open")?
                .map_err(anyhow::Error::msg)
        })();
        PENDING_OPEN.lock().unwrap().remove(&id);
        result
    };
    match run() {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

fn files_open(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json_output = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files open requires <path>")?;
    let absolute = std::path::absolute(&path).with_context(|| format!("failed to resolve {}", path.display()))?;
    if !absolute.is_file() {
        bail!("file not found: {}", absolute.display());
    }
    let request = json!({"operation": "files.open", "path": normalize_path(&absolute), "sessionId": std::env::var("SUPERHIGH_SESSION_ID").ok().filter(|id| !id.is_empty())});
    #[cfg(windows)]
    let response: Value = tauri::async_runtime::block_on(crate::local_control::send_request_async(&request))?;
    #[cfg(not(windows))]
    let response: Value = { let _ = request; bail!("files open requires the running Windows desktop app"); };
    if response["ok"] != true {
        bail!("{}", response["error"].as_str().unwrap_or("files open failed"));
    }
    if json_output {
        return write_json(stdout, &response["result"]);
    }
    writeln!(stdout, "Opened {}", response["result"]["path"].as_str().unwrap_or(&normalize_path(&absolute)))?;
    Ok(())
}

pub(crate) fn write_files_help(stdout: &mut dyn std::io::Write) -> anyhow::Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli files ls <path> [--json]
  superhigh-cli files read <path> [--json]
  superhigh-cli files write <path> [--content <text> | --content-file <path>] [--json]
  superhigh-cli files touch <path> [--json]
  superhigh-cli files mkdir <path> [--json]
  superhigh-cli files rename <path> <new-path> [--json]
  superhigh-cli files delete <path> --force [--json]
  superhigh-cli files open <path> [--json]

`open` shows a file of the current workspace in the desktop code preview and
turns preview mode on for .shui and .html files. The desktop app must be running.
"
    )?;
    Ok(())
}

fn files_ls(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files ls requires <path>")?;

    let listing = list_directory(&path)?;
    if json {
        return write_json(stdout, &listing);
    }

    writeln!(stdout, "Directory: {}", listing.path)?;
    for entry in listing.entries {
        let kind = match entry.entry_type {
            crate::models::FileEntryType::Directory => "dir",
            crate::models::FileEntryType::File => "file",
        };
        match entry.size {
            Some(size) => writeln!(stdout, "{kind}\t{size}\t{}", entry.name)?,
            None => writeln!(stdout, "{kind}\t-\t{}", entry.name)?,
        }
    }
    Ok(())
}

fn files_read(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files read requires <path>")?;

    let content = read_text_file(&path)?;
    if json {
        return write_json(
            stdout,
            &FileReadResult {
                path: normalize_path(&path),
                content,
            },
        );
    }

    write!(stdout, "{content}")?;
    Ok(())
}

fn files_write(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    let content = take_option(args, "--content")?;
    let content_file = take_option(args, "--content-file")?;
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files write requires <path>")?;

    let content = match (content, content_file) {
        (Some(_), Some(_)) => bail!("use either --content or --content-file, not both"),
        (Some(content), None) => content,
        (None, Some(path)) => {
            fs::read_to_string(&path).with_context(|| format!("failed to read {path}"))?
        }
        (None, None) => String::new(),
    };

    write_text_file(&path, &content)?;
    if json {
        return write_json(
            stdout,
            &FilePathResult {
                path: normalize_path(&path),
            },
        );
    }

    writeln!(stdout, "Wrote {}", normalize_path(&path))?;
    Ok(())
}

fn files_touch(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files touch requires <path>")?;

    create_empty_file(&path)?;
    if json {
        return write_json(
            stdout,
            &FilePathResult {
                path: normalize_path(&path),
            },
        );
    }

    writeln!(stdout, "Created file {}", normalize_path(&path))?;
    Ok(())
}

fn files_mkdir(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files mkdir requires <path>")?;

    create_directory(&path)?;
    if json {
        return write_json(
            stdout,
            &FilePathResult {
                path: normalize_path(&path),
            },
        );
    }

    writeln!(stdout, "Created directory {}", normalize_path(&path))?;
    Ok(())
}

fn files_rename(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    let (path, new_path) = take_two_paths(args, "files rename requires <path> <new-path>")?;

    rename_path(&path, &new_path)?;
    if json {
        return write_json(
            stdout,
            &FileRenameResult {
                path: normalize_path(&path),
                new_path: normalize_path(&new_path),
            },
        );
    }

    writeln!(
        stdout,
        "Renamed {} -> {}",
        normalize_path(&path),
        normalize_path(&new_path)
    )?;
    Ok(())
}

fn files_delete(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    let force = take_flag(args, "--force");
    ensure_no_unexpected_options(args)?;
    let path = take_one_path(args, "files delete requires <path> --force")?;
    if !force {
        bail!("files delete requires --force");
    }

    let normalized = normalize_path(&path);
    delete_path(&path)?;
    if json {
        return write_json(stdout, &FilePathResult { path: normalized });
    }

    writeln!(stdout, "Deleted {normalized}")?;
    Ok(())
}

fn take_one_path(args: &mut Vec<String>, message: &str) -> Result<PathBuf> {
    if args.len() != 1 {
        bail!("{message}");
    }
    Ok(PathBuf::from(args.remove(0)))
}

fn take_two_paths(args: &mut Vec<String>, message: &str) -> Result<(PathBuf, PathBuf)> {
    if args.len() != 2 {
        bail!("{message}");
    }
    Ok((PathBuf::from(args.remove(0)), PathBuf::from(args.remove(0))))
}

fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    let mut value = None;
    let prefix = format!("{name}=");
    let mut index = 0;
    while index < args.len() {
        let current = args[index].clone();
        if current == name {
            if index + 1 >= args.len() {
                bail!("{name} requires a value");
            }
            if value.is_some() {
                bail!("{name} was provided more than once");
            }
            value = Some(args.remove(index + 1));
            args.remove(index);
            continue;
        }
        if let Some(raw) = current.strip_prefix(&prefix) {
            if value.is_some() {
                bail!("{name} was provided more than once");
            }
            value = Some(raw.to_string());
            args.remove(index);
            continue;
        }
        index += 1;
    }
    Ok(value)
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    let mut found = false;
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            found = true;
            args.remove(index);
            continue;
        }
        index += 1;
    }
    found
}

fn ensure_no_unexpected_options(args: &[String]) -> Result<()> {
    if let Some(option) = args.iter().find(|arg| arg.starts_with('-')) {
        bail!("unknown option `{option}`");
    }
    Ok(())
}

fn write_json<T: Serialize>(stdout: &mut dyn Write, value: &T) -> Result<()> {
    serde_json::to_writer_pretty(&mut *stdout, value)?;
    writeln!(stdout)?;
    Ok(())
}

fn is_help(value: &str) -> bool {
    matches!(value, "help" | "-h" | "--help")
}
