use std::{collections::BTreeMap, io::{Read, Write}, sync::{mpsc, Mutex, atomic::{AtomicBool, Ordering}}, time::Duration};

use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::db::AppDb;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoRequest {
    pub operation: String,
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

type PendingReply = mpsc::Sender<std::result::Result<Value, String>>;
static PENDING: Lazy<Mutex<BTreeMap<String, PendingReply>>> = Lazy::new(|| Mutex::new(BTreeMap::new()));
static READY: AtomicBool = AtomicBool::new(false);

pub fn set_ready(ready: bool) { READY.store(ready, Ordering::Release); }

pub fn complete(id: &str, result: Value, error: Option<String>) {
    if let Some(sender) = PENDING.lock().unwrap().remove(id) {
        let _ = sender.send(match error { Some(error) => Err(error), None => Ok(result) });
    }
}

pub fn execute_bridge(app: &tauri::AppHandle, raw: &str) -> Value {
    let run = || -> Result<Value> {
        let request: MemoRequest = serde_json::from_str(raw)?;
        validate(&request)?;
        anyhow::ensure!(READY.load(Ordering::Acquire), "memo UI is not ready; open a workspace and retry after it loads");
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        PENDING.lock().unwrap().insert(id.clone(), sender);
        let result = (|| {
            app.emit("memo-cli-request", json!({"id": id, "request": request}))?;
            receiver.recv_timeout(Duration::from_secs(30))
                .context("memo operation timed out; inspect memo status before retrying")?
                .map_err(anyhow::Error::msg)
        })();
        PENDING.lock().unwrap().remove(&id);
        result
    };
    match run() {
        Ok(result) => json!({"ok": true, "result": result}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

pub fn handle_memo(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || args.iter().any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help")) {
        return write_help(stdout);
    }
    let (request, json_output, output) = parse(args)?;
    #[cfg(windows)]
    let response: Value = tauri::async_runtime::block_on(crate::local_control::send_request_async(&request))?;
    #[cfg(not(windows))]
    let response: Value = { let _ = request; bail!("memo CLI requires the running Windows desktop app"); };
    if response["ok"] != true {
        bail!("{}", response["error"].as_str().unwrap_or("memo operation failed"));
    }
    let result = &response["result"];
    if let Some(path) = output {
        let text = result.as_str().context("--output requires a text result")?;
        std::fs::write(&path, text).with_context(|| format!("failed to write {path}"))?;
    }
    if json_output {
        serde_json::to_writer_pretty(&mut *stdout, &response)?;
        writeln!(stdout)?;
    } else if let Some(text) = result.as_str() {
        write!(stdout, "{text}")?;
    } else if request.operation == "memo.list" {
        for memo in result["items"].as_array().context("invalid memo list")? {
            writeln!(stdout, "{}\t{}\t{}\t{}", memo["id"].as_str().unwrap_or(""), memo["category"].as_str().unwrap_or(""), memo["title"].as_str().unwrap_or(""), memo["createdAt"].as_str().unwrap_or(""))?;
        }
        if result["hasMore"] == true { writeln!(stdout, "More memos available; use --offset with --limit.")?; }
    } else {
        serde_json::to_writer_pretty(&mut *stdout, result)?;
        writeln!(stdout)?;
    }
    Ok(())
}

fn parse(args: &mut Vec<String>) -> Result<(MemoRequest, bool, Option<String>)> {
    let mut operation = args.remove(0);
    if matches!(operation.as_str(), "category" | "attachment" | "image") {
        anyhow::ensure!(!args.is_empty(), "{operation} requires a subcommand");
        operation = format!("{operation}-{}", args.remove(0));
    }
    let mut options = BTreeMap::new();
    let mut json_output = false;
    let mut output = None;
    while !args.is_empty() {
        let arg = args.remove(0);
        if arg == "--json" { json_output = true; continue; }
        let (name, inline) = arg.split_once('=').map_or((arg.as_str(), None), |(a, b)| (a, Some(b)));
        anyhow::ensure!(name.starts_with("--"), "unexpected argument: {arg}; use --id for memo IDs");
        let value = match inline { Some(value) => value.to_string(), None => {
            anyhow::ensure!(!args.is_empty(), "{name} requires a value");
            args.remove(0)
        }};
        anyhow::ensure!(options.insert(name[2..].to_string(), value).is_none(), "duplicate option: {name}");
    }
    if let Some(path) = options.remove("content-file") {
        anyhow::ensure!(!options.contains_key("content"), "use only one of --content and --content-file");
        let text = if path == "-" {
            let mut text = String::new(); std::io::stdin().read_to_string(&mut text)?; text
        } else { std::fs::read_to_string(&path).with_context(|| format!("failed to read UTF-8 content: {path}"))? };
        options.insert("content".into(), text);
    }
    if let Some(path) = options.remove("output") {
        anyhow::ensure!(operation == "text", "--output is supported by memo text only");
        output = Some(path);
    }
    if let Some(path) = options.get_mut("path") {
        if matches!(operation.as_str(), "attachment-add" | "attachment-remove" | "image-open") {
            let absolute = std::path::absolute(&*path)?;
            *path = absolute.to_string_lossy().replace('\\', "/");
        }
    }
    let request = MemoRequest { operation: format!("memo.{operation}"), options };
    validate(&request)?;
    Ok((request, json_output, output))
}

fn required<'a>(request: &'a MemoRequest, key: &str) -> Result<&'a str> {
    request.options.get(key).map(String::as_str).filter(|v| !v.trim().is_empty())
        .with_context(|| format!("{} requires --{key}", request.operation))
}

pub fn validate(request: &MemoRequest) -> Result<()> {
    let (allowed, needed): (&[&str], &[&str]) = match request.operation.as_str() {
        "memo.list" => (&["query", "from", "before", "category", "days", "limit", "offset"], &[]),
        "memo.get" | "memo.delete" | "memo.text" | "memo.select" | "memo.copy" | "memo.insert" => (&["id"], &["id"]),
        "memo.create" => (&["title", "content", "category"], &[]),
        "memo.update" => (&["id", "title", "content", "category"], &["id"]),
        "memo.append" => (&["id", "content"], &["id", "content"]),
        "memo.category-list" | "memo.status" | "memo.close" | "memo.image-close" | "memo.image-fit" => (&[], &[]),
        "memo.category-create" | "memo.category-delete" => (&["name"], &["name"]),
        "memo.category-rename" => (&["name", "new-name"], &["name", "new-name"]),
        "memo.attachment-list" => (&["id"], &["id"]),
        "memo.attachment-add" | "memo.attachment-remove" => (&["id", "path"], &["id", "path"]),
        "memo.links" => (&["id", "content"], &["id", "content"]),
        "memo.open" => (&["id", "mode"], &[]),
        "memo.mode" => (&["mode"], &["mode"]),
        "memo.filter" => (&["query", "from", "to", "category", "days"], &[]),
        "memo.frame" => (&["left", "top", "width", "height"], &[]),
        "memo.image-open" => (&["id", "path"], &["id", "path"]),
        "memo.image-zoom" => (&["scale"], &["scale"]),
        "memo.image-pan" => (&["left", "top"], &[]),
        "memo.paste" => (&["id"], &["id"]),
        _ => bail!("unknown memo command: {}; run superhigh-cli memo --help", request.operation),
    };
    for key in request.options.keys() { anyhow::ensure!(allowed.contains(&key.as_str()), "unexpected option: --{key}"); }
    for key in needed { required(request, key)?; }
    if let Some(mode) = request.options.get("mode") {
        anyhow::ensure!(matches!(mode.as_str(), "edit" | "preview"), "--mode must be edit or preview");
    }
    for key in if request.operation == "memo.list" { vec!["from", "before"] } else { vec![] } {
        if let Some(value) = request.options.get(key) {
            if !value.is_empty() { time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).with_context(|| format!("--{key} must be an RFC3339 timestamp"))?; }
        }
    }
    if let Some(days) = request.options.get("days") {
        let days = days.parse::<i64>().context("--days must be an integer")?;
        anyhow::ensure!((1..=36500).contains(&days), "--days must be between 1 and 36500");
        anyhow::ensure!(!request.options.contains_key("from") && !request.options.contains_key("before") && !request.options.contains_key("to"), "--days cannot be combined with date boundaries");
    }
    for key in ["left", "top", "width", "height", "scale"] {
        if let Some(value) = request.options.get(key) {
            let number = value.parse::<f64>().with_context(|| format!("--{key} must be a number"))?;
            anyhow::ensure!(number.is_finite() && number >= 0.0, "--{key} must be finite and nonnegative");
            if matches!(key, "width" | "height" | "scale") { anyhow::ensure!(number > 0.0, "--{key} must be positive"); }
        }
    }
    for key in ["limit", "offset"] {
        if let Some(value) = request.options.get(key) {
            let value = value.parse::<usize>().with_context(|| format!("--{key} must be a nonnegative integer"))?;
            if key == "limit" { anyhow::ensure!((1..=200).contains(&value), "--limit must be between 1 and 200"); }
        }
    }
    Ok(())
}

pub async fn execute_data(db: &AppDb, request: &MemoRequest) -> Result<Value> {
    validate(request)?;
    let get = |key: &str| request.options.get(key).map(String::as_str);
    let operation = request.operation.as_str();
    match operation {
        "memo.list" => {
            let from = get("days").map(|days| (time::OffsetDateTime::now_utc() - time::Duration::days(days.parse().unwrap())).format(&time::format_description::well_known::Rfc3339)).transpose()?;
            let utc_boundary = |value: Option<&str>| -> Result<Option<String>> {
                value.filter(|value| !value.is_empty()).map(|value| {
                    Ok(time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)?
                        .to_offset(time::UtcOffset::UTC).format(&time::format_description::well_known::Rfc3339)?)
                }).transpose()
            };
            let from = utc_boundary(from.as_deref().or(get("from")))?;
            let before = utc_boundary(get("before"))?;
            let memos = db.list_memos(get("query"), from.as_deref(), before.as_deref(), get("category"))?;
            let total = memos.len();
            let offset = get("offset").unwrap_or("0").parse::<usize>()?;
            let limit = get("limit").unwrap_or("50").parse::<usize>()?;
            let items: Vec<Value> = memos.into_iter().skip(offset).take(limit).map(|memo| json!({
                "id": memo.id, "title": memo.title, "category": memo.category,
                "createdAt": memo.created_at, "updatedAt": memo.updated_at,
                "attachmentCount": memo.attachments.len(), "contentLength": memo.content.chars().count(),
            })).collect();
            Ok(json!({"hasMore": offset.saturating_add(items.len()) < total, "items": items, "total": total, "offset": offset}))
        }
        "memo.category-list" => Ok(json!(db.list_memo_categories()?)),
        "memo.category-create" => Ok(json!(db.create_memo_category(required(request, "name")?)?)),
        "memo.category-rename" => {
            db.rename_memo_category(required(request, "name")?, required(request, "new-name")?)?;
            Ok(json!(db.list_memo_categories()?))
        }
        "memo.category-delete" => {
            db.delete_memo_category(required(request, "name")?)?;
            Ok(json!(db.list_memo_categories()?))
        }
        "memo.create" => {
            let category = get("category").unwrap_or("");
            if !category.trim().is_empty() { db.create_memo_category(category)?; }
            let memo = db.create_memo(category)?;
            Ok(json!(db.update_memo(&memo.id, get("title").unwrap_or(""), get("content").unwrap_or(""), category, &[])?))
        }
        _ => {
            let id = required(request, "id")?;
            let mut memo = db.get_memo(id)?;
            match operation {
                "memo.get" => return Ok(json!(memo)),
                "memo.delete" => { db.delete_memo(id)?; return Ok(json!({"deleted": id})); }
                "memo.text" => return Ok(json!([vec![memo.content], memo.attachments].concat().into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"))),
                "memo.attachment-list" => return Ok(json!(memo.attachments)),
                "memo.update" => {
                    if let Some(value) = get("title") { memo.title = value.into(); }
                    if let Some(value) = get("content") { memo.content = value.into(); }
                    if let Some(value) = get("category") { memo.category = value.trim().into(); }
                }
                "memo.append" => memo.content.push_str(required(request, "content")?),
                "memo.attachment-add" => {
                    let path = required(request, "path")?;
                    crate::fs_ops::read_image_as_data_url(std::path::Path::new(path))?;
                    if !memo.attachments.iter().any(|p| p == path) { memo.attachments.push(path.into()); }
                }
                "memo.attachment-remove" => {
                    let path = required(request, "path")?;
                    let before = memo.attachments.len(); memo.attachments.retain(|p| p != path);
                    anyhow::ensure!(memo.attachments.len() != before, "attachment not found: {path}");
                }
                "memo.links" => {
                    let pattern = regex::Regex::new(r#"https?://[^\s<>\"'`]+"#)?;
                    let content = required(request, "content")?;
                    let urls: Vec<String> = pattern.find_iter(content).map(|m| m.as_str().trim_end_matches(&['.', ',', ';', '!', '?', '，', '。', '；', '！', '？'][..]).to_string()).collect();
                    anyhow::ensure!(!urls.is_empty(), "no webpage links found");
                    let titles = crate::webpage_titles::fetch_webpage_titles(urls).await.map_err(anyhow::Error::msg)?;
                    let lines: Vec<String> = titles.into_iter().map(|item| {
                        let title = item.title.unwrap_or_else(|| item.url.clone()).replace(&['\\', '[', ']', '`', '\r', '\n'][..], " ");
                        format!("[{title}]({})", item.url)
                    }).collect();
                    if !memo.content.is_empty() && !memo.content.ends_with('\n') { memo.content.push('\n'); }
                    memo.content.push_str(&lines.join("\n"));
                }
                _ => bail!("not a memo data operation: {operation}"),
            }
            if !memo.category.is_empty() { db.create_memo_category(&memo.category)?; }
            Ok(json!(db.update_memo(id, &memo.title, &memo.content, &memo.category, &memo.attachments)?))
        }
    }
}

fn write_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(stdout, "Usage: superhigh-cli memo <command> [options] [--json]
Requires the running desktop app. Waits for saved edits and returns completed results.
  list [--query <text>] [--category <name>] [--from <RFC3339>] [--before <RFC3339>] [--days <n>] [--limit <1..200>] [--offset <n>]
  List returns summaries (default limit 50); get retrieves full content and attachments.
  get|delete|text --id <id>                      text supports --output <UTF-8 file>
  create [--title <text>] [--content <text>] [--category <name>]
  update --id <id> [--title <text>] [--content <text>] [--category <name>]
  append|links --id <id> --content <text>        links fetches webpage titles
  Content input: --content-file <UTF-8 file or -> replaces --content; - reads stdin.
  category list|create|rename|delete [--name <name>] [--new-name <name>]
  Category deletion keeps notes and clears their category; attachment removal keeps files.
  attachment list|add|remove --id <id> [--path <image file>]
  status|close
  open [--id <id>] [--mode edit|preview]
  select|copy|paste|insert --id <id>             clipboard or active CLI draft; insert does not send
  mode --mode edit|preview
  filter [--query <text>] [--category <name>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--days <n>]
  frame [--left <px>] [--top <px>] [--width <px>] [--height <px>]
  image open --id <id> --path <attached image>
  image zoom --scale <percent> | fit | close | pan [--left <px>] [--top <px>]
  UI commands return the applied window state; frame sizes are clamped to the viewport.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(op: &str, options: &[(&str, &str)]) -> MemoRequest {
        MemoRequest { operation: format!("memo.{op}"), options: options.iter().map(|(a,b)| (a.to_string(), b.to_string())).collect() }
    }
    #[tokio::test]
    async fn memo_edits_preserve_fields_and_category_operations_keep_notes() {
        let dir = tempfile::tempdir().unwrap(); let db = AppDb::new(dir.path()).unwrap();
        let note = execute_data(&db, &request("create", &[("title", "标题"), ("content", "中文\n正文"), ("category", "分类")])).await.unwrap();
        let id = note["id"].as_str().unwrap();
        execute_data(&db, &request("update", &[("id", id), ("title", "新标题")])).await.unwrap();
        assert_eq!(db.get_memo(id).unwrap().content, "中文\n正文");
        execute_data(&db, &request("category-rename", &[("name", "分类"), ("new-name", "新分类")])).await.unwrap();
        assert_eq!(db.get_memo(id).unwrap().category, "新分类");
        execute_data(&db, &request("category-delete", &[("name", "新分类")])).await.unwrap();
        assert_eq!(db.get_memo(id).unwrap().category, "");
        assert!(execute_data(&db, &request("update", &[("id", "missing"), ("content", "x")])).await.is_err());
        execute_data(&db, &request("delete", &[("id", id)])).await.unwrap();
        assert!(db.list_memos(None, None, None, None).unwrap().is_empty());
    }
    #[test]
    fn rejects_invalid_options_before_mutation() {
        for r in [request("delete", &[]), request("create", &[("unknown", "x")]), request("mode", &[("mode", "bad")]), request("frame", &[("width", "NaN")]), request("list", &[("days", "0")])] { assert!(validate(&r).is_err()); }
    }
}
