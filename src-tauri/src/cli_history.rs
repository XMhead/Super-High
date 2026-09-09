use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use rusqlite::params;
use serde_json::Value;
use walkdir::WalkDir;

use crate::{
    db::AppDb,
    models::{CliHistoryMessage, CliHistoryPath, CliHistorySnapshot},
};

const HISTORY_SESSION_ID: &str = "cli-history";
const MESSAGE_LIMIT: usize = 800;
const PATH_LIMIT: usize = 200;
const MAX_CONTENT_CHARS: usize = 2000;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedMessage {
    id: String,
    source: String,
    content: String,
    timestamp: String,
    cwd: String,
}

#[derive(Clone, Debug)]
struct FileScanState {
    mtime_ms: i64,
    size: i64,
    cursor: Option<i64>,
    line_count: usize,
    cwd: String,
}

#[derive(Debug)]
struct FileScanResult {
    messages: Vec<ParsedMessage>,
    cursor: i64,
    line_count: usize,
    cwd: String,
}

pub fn load_cached(db: &AppDb) -> anyhow::Result<CliHistorySnapshot> {
    load_snapshot(db)
}

pub fn refresh(db: &AppDb) -> anyhow::Result<CliHistorySnapshot> {
    let home = user_home().context("无法确定用户目录，历史补全索引未执行")?;
    let full = !has_disk_index(db)?;
    let since_ms = if full {
        None
    } else {
        meta_i64(db, "last_scan_ms")?
    };
    let files = discover_session_files(&home, since_ms);
    let states = load_file_states(db)?;

    let mut scanned_files = 0u32;
    let mut indexed_files = 0u32;
    for path in &files {
        scanned_files += 1;
        let key = path.to_string_lossy().replace('\\', "/");
        let (mtime_ms, size) = match file_stamp(path) {
            Some(stamp) => stamp,
            None => continue,
        };
        let previous = states.get(&key);
        if previous.is_some_and(|state| state.mtime_ms == mtime_ms && state.size == size) {
            continue;
        }
        let source = source_for_path(path);
        let incremental = previous.is_some_and(|state| {
            state
                .cursor
                .is_some_and(|cursor| cursor >= 0 && cursor <= state.size)
                && size > state.size
        });
        let (start_cursor, start_line_count, start_cwd) = if incremental {
            let state = previous.expect("incremental scan requires previous state");
            (
                state.cursor.unwrap_or_default(),
                state.line_count,
                state.cwd.as_str(),
            )
        } else {
            (0, 0, "")
        };
        let scan = parse_session_file(path, &source, start_cursor, start_line_count, start_cwd);
        store_file_scan(db, &key, mtime_ms, size, &scan, !incremental)?;
        indexed_files += 1;
    }
    if full {
        let current_paths: HashSet<String> = files
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect();
        prune_missing_files(db, &current_paths)?;
    }
    set_meta(db, "last_scan_ms", &now_ms().to_string())?;

    let mut snapshot = load_snapshot(db)?;
    snapshot.scanned_files = scanned_files;
    snapshot.indexed_files = indexed_files;
    Ok(snapshot)
}

pub fn record_superhigh_message(
    db: &AppDb,
    content: &str,
    timestamp: &str,
    cwd: Option<&str>,
    session_id: &str,
) -> anyhow::Result<()> {
    let content = (!content.trim().is_empty() && !is_injected_prompt(content))
        .then(|| content.replace("\r\n", "\n").trim().to_string());
    if content.is_none() {
        return Ok(());
    }
    let content = content.unwrap();
    let cwd = cwd.unwrap_or("").trim().to_string();
    let file_path = format!("superhigh:{session_id}");
    let id = stable_id(&["superhigh", &file_path, timestamp, &content]);
    db.with_connection(|connection| {
        connection.execute(
            r#"
            INSERT OR REPLACE INTO cli_history_messages
              (id, source, file_path, content, timestamp, cwd)
            VALUES (?1, 'superhigh', ?2, ?3, ?4, ?5)
            "#,
            params![id, file_path, content, timestamp, cwd],
        )?;
        Ok(())
    })
}

pub fn list_workspace_prompt_history(
    db: &AppDb,
    workspace: &Path,
) -> anyhow::Result<Vec<CliHistoryMessage>> {
    let key = normalize_path_key(&workspace.to_string_lossy());
    if key.is_empty() {
        return Ok(Vec::new());
    }
    let local = db.with_connection(|connection| {
        let mut statement = connection.prepare(
            "SELECT id, content, timestamp, cwd FROM cli_history_messages WHERE source = 'superhigh' AND julianday(timestamp) >= julianday('now', '-7 days') ORDER BY timestamp DESC"
        )?;
        let mut rows = statement.query([])?;
        let mut messages = Vec::new();
        while let Some(row) = rows.next()? {
            let cwd: String = row.get(3)?;
            if normalize_path_key(&cwd) != key { continue; }
            messages.push(CliHistoryMessage { id: row.get(0)?, session_id: HISTORY_SESSION_ID.into(),
                role: "user".into(), content: row.get(1)?, timestamp: row.get(2)? });
        }
        Ok(messages)
    })?;
    let native = crate::cli_conversations::workspace_prompt_messages(workspace)?;
    Ok(merge_workspace_prompts(local, native, now_ms()))
}

fn prompt_timestamp_ms(timestamp: &str) -> Option<i64> {
    time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
        .ok()
        .map(|value| (value.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn merge_workspace_prompts(
    local: Vec<CliHistoryMessage>,
    native: Vec<CliHistoryMessage>,
    now: i64,
) -> Vec<CliHistoryMessage> {
    let cutoff = now.saturating_sub(7 * 86_400_000);
    let recent = |message: &CliHistoryMessage| {
        prompt_timestamp_ms(&message.timestamp)
            .filter(|timestamp| *timestamp >= cutoff && *timestamp <= now)
    };
    let mut native: Vec<_> = native
        .into_iter()
        .filter_map(|message| recent(&message).map(|timestamp| (timestamp, message)))
        .collect();
    let mut matched = HashSet::new();
    for message in local {
        let Some(timestamp) = recent(&message) else {
            continue;
        };
        // Match each native submission once so repeated identical sends stay separate.
        let duplicate = native
            .iter()
            .enumerate()
            .filter(|(index, (_, candidate))| {
                !matched.contains(index) && candidate.content == message.content
            })
            .filter(|(_, (native_time, _))| native_time.abs_diff(timestamp) <= 30_000)
            .min_by_key(|(_, (native_time, _))| native_time.abs_diff(timestamp))
            .map(|(index, _)| index);
        if let Some(index) = duplicate {
            matched.insert(index);
        } else {
            native.push((timestamp, message));
            matched.insert(native.len() - 1);
        }
    }
    native.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.id.cmp(&left.1.id))
    });
    native
        .into_iter()
        .take(50)
        .map(|(_, message)| message)
        .collect()
}

fn load_snapshot(db: &AppDb) -> anyhow::Result<CliHistorySnapshot> {
    db.with_connection(|connection| {
        let mut statement = connection.prepare(
            r#"
            SELECT id, content, timestamp
            FROM cli_history_messages
            ORDER BY timestamp DESC, id DESC
            LIMIT ?1
            "#,
        )?;
        let mut rows = statement.query(params![MESSAGE_LIMIT as i64])?;
        let mut messages = Vec::new();
        while let Some(row) = rows.next()? {
            messages.push(CliHistoryMessage {
                id: row.get(0)?,
                session_id: HISTORY_SESSION_ID.to_string(),
                role: "user".to_string(),
                content: row.get(1)?,
                timestamp: row.get(2)?,
            });
        }

        let mut path_map: HashMap<String, (String, u32, String)> = HashMap::new();
        let mut cwd_statement = connection.prepare(
            r#"
            SELECT cwd, COUNT(DISTINCT file_path), MAX(timestamp)
            FROM cli_history_messages
            WHERE cwd != ''
            GROUP BY cwd
            "#,
        )?;
        let mut cwd_rows = cwd_statement.query([])?;
        while let Some(row) = cwd_rows.next()? {
            let cwd: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            let timestamp: String = row.get(2)?;
            if looks_like_abs_path(&cwd) {
                remember_path(&mut path_map, cwd, &timestamp, count.max(0) as u32);
            }
        }

        let mut ranked: Vec<(String, u32, String)> =
            path_map.into_iter().map(|(_, value)| value).collect();
        ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.2.cmp(&left.2)));
        let paths = ranked
            .into_iter()
            .take(PATH_LIMIT)
            .enumerate()
            .map(|(index, (path, count, _))| CliHistoryPath {
                path,
                count,
                last_index: index as u32,
            })
            .collect();

        let indexed_messages: u32 =
            connection.query_row("SELECT COUNT(*) FROM cli_history_messages", [], |row| {
                row.get(0)
            })?;

        Ok(CliHistorySnapshot {
            messages,
            paths,
            scanned_files: 0,
            indexed_files: 0,
            indexed_messages,
        })
    })
}

fn remember_path(
    path_map: &mut HashMap<String, (String, u32, String)>,
    path: String,
    timestamp: &str,
    count: u32,
) {
    let key = normalize_path_key(&path);
    if key.len() < 4 {
        return;
    }
    match path_map.get_mut(&key) {
        Some(existing) => {
            existing.1 = existing.1.saturating_add(count);
            if timestamp > existing.2.as_str() {
                existing.0 = path;
                existing.2 = timestamp.to_string();
            }
        }
        None => {
            path_map.insert(key, (path, count, timestamp.to_string()));
        }
    }
}

fn load_file_states(db: &AppDb) -> anyhow::Result<HashMap<String, FileScanState>> {
    db.with_connection(|connection| {
        let mut statement = connection.prepare(
            r#"
            SELECT files.path, files.mtime_ms, files.size,
                   cursors.cursor, cursors.line_count, cursors.cwd
            FROM cli_history_files AS files
            LEFT JOIN cli_history_file_cursors AS cursors ON cursors.path = files.path
            "#,
        )?;
        let mut rows = statement.query([])?;
        let mut states = HashMap::new();
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            let line_count = row
                .get::<_, Option<i64>>(4)?
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or_default();
            states.insert(
                path,
                FileScanState {
                    mtime_ms: row.get(1)?,
                    size: row.get(2)?,
                    cursor: row.get(3)?,
                    line_count,
                    cwd: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                },
            );
        }
        Ok(states)
    })
}

fn store_file_scan(
    db: &AppDb,
    path: &str,
    mtime_ms: i64,
    size: i64,
    scan: &FileScanResult,
    replace: bool,
) -> anyhow::Result<()> {
    db.with_connection(|connection| {
        let tx = connection.unchecked_transaction()?;
        if replace {
            tx.execute(
                "DELETE FROM cli_history_messages WHERE file_path = ?1",
                params![path],
            )?;
        }
        tx.execute(
            r#"
            INSERT INTO cli_history_files (path, mtime_ms, size)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size
            "#,
            params![path, mtime_ms, size],
        )?;
        tx.execute(
            r#"
            INSERT INTO cli_history_file_cursors (path, cursor, line_count, cwd)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(path) DO UPDATE SET
              cursor = excluded.cursor,
              line_count = excluded.line_count,
              cwd = excluded.cwd
            "#,
            params![path, scan.cursor, scan.line_count as i64, scan.cwd.as_str()],
        )?;
        for message in &scan.messages {
            tx.execute(
                r#"
                INSERT OR REPLACE INTO cli_history_messages
                  (id, source, file_path, content, timestamp, cwd)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                "#,
                params![
                    message.id,
                    message.source,
                    path,
                    message.content,
                    message.timestamp,
                    message.cwd,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

fn prune_missing_files(db: &AppDb, current_paths: &HashSet<String>) -> anyhow::Result<()> {
    db.with_connection(|connection| {
        let mut statement = connection.prepare("SELECT path FROM cli_history_files")?;
        let mut rows = statement.query([])?;
        let mut stale = Vec::new();
        while let Some(row) = rows.next()? {
            let path: String = row.get(0)?;
            if path.starts_with("superhigh:") {
                continue;
            }
            if !current_paths.contains(&path) {
                stale.push(path);
            }
        }
        for path in stale {
            connection.execute(
                "DELETE FROM cli_history_messages WHERE file_path = ?1",
                params![path],
            )?;
            connection.execute(
                "DELETE FROM cli_history_files WHERE path = ?1",
                params![path],
            )?;
            connection.execute(
                "DELETE FROM cli_history_file_cursors WHERE path = ?1",
                params![path],
            )?;
        }
        Ok(())
    })
}

fn discover_session_files(home: &Path, since_ms: Option<i64>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_jsonl(&home.join(".claude").join("projects"), &mut files);
    collect_codex_jsonl(&home.join(".codex").join("sessions"), since_ms, &mut files);
    collect_jsonl(&home.join(".dsh").join("sessions"), &mut files);
    files.sort();
    files
}

fn collect_codex_jsonl(root: &Path, since_ms: Option<i64>, files: &mut Vec<PathBuf>) {
    if since_ms.is_none() {
        collect_jsonl(root, files);
        return;
    }
    if !root.exists() {
        return;
    }
    let cutoff = millis_to_ymd_utc(since_ms.unwrap().saturating_sub(86_400_000));
    let Ok(years) = fs::read_dir(root) else {
        return;
    };
    for year_entry in years.flatten() {
        let year_path = year_entry.path();
        if !year_path.is_dir() {
            continue;
        }
        let Some(year) = parse_u32_name(&year_entry.file_name()) else {
            continue;
        };
        if (year as i32) < cutoff.0 {
            continue;
        }
        let Ok(months) = fs::read_dir(&year_path) else {
            continue;
        };
        for month_entry in months.flatten() {
            let month_path = month_entry.path();
            if !month_path.is_dir() {
                continue;
            }
            let Some(month) = parse_u32_name(&month_entry.file_name()) else {
                continue;
            };
            if (year as i32, month) < (cutoff.0, cutoff.1) {
                continue;
            }
            let Ok(days) = fs::read_dir(&month_path) else {
                continue;
            };
            for day_entry in days.flatten() {
                let day_path = day_entry.path();
                if !day_path.is_dir() {
                    continue;
                }
                let Some(day) = parse_u32_name(&day_entry.file_name()) else {
                    continue;
                };
                if (year as i32, month, day) < cutoff {
                    continue;
                }
                collect_jsonl(&day_path, files);
            }
        }
    }
}

fn parse_u32_name(name: &std::ffi::OsStr) -> Option<u32> {
    name.to_str()?.parse().ok()
}

fn millis_to_ymd_utc(ms: i64) -> (i32, u32, u32) {
    civil_from_days(ms.div_euclid(86_400_000))
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn has_disk_index(db: &AppDb) -> anyhow::Result<bool> {
    db.with_connection(|connection| {
        let count: i64 = connection.query_row(
            "SELECT COUNT(*) FROM cli_history_files WHERE path NOT LIKE 'superhigh:%'",
            [],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    })
}

fn meta_i64(db: &AppDb, key: &str) -> anyhow::Result<Option<i64>> {
    db.with_connection(|connection| {
        let value: Option<String> = connection
            .query_row(
                "SELECT value FROM cli_history_meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();
        Ok(value.and_then(|item| item.parse().ok()))
    })
}

fn set_meta(db: &AppDb, key: &str, value: &str) -> anyhow::Result<()> {
    db.with_connection(|connection| {
        connection.execute(
            r#"
            INSERT INTO cli_history_meta (key, value)
            VALUES (?1, ?2)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
            params![key, value],
        )?;
        Ok(())
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn collect_jsonl(root: &Path, files: &mut Vec<PathBuf>) {
    if !root.exists() {
        return;
    }
    for entry in WalkDir::new(root).into_iter().filter_map(|item| item.ok()) {
        let path = entry.path();
        if !path.is_file() || !should_scan_file(path) {
            continue;
        }
        files.push(path.to_path_buf());
    }
}

fn should_scan_file(path: &Path) -> bool {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return false;
    }
    let text = path.to_string_lossy();
    !text.contains("subagents") && !text.contains("tool-results") && !text.contains("node_modules")
}

fn source_for_path(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if text.contains("/.claude/") {
        "claude".to_string()
    } else if text.contains("/.codex/") {
        "codex".to_string()
    } else if text.contains("/.dsh/") {
        "dsh".to_string()
    } else {
        "unknown".to_string()
    }
}

fn parse_session_file(
    path: &Path,
    source: &str,
    start_cursor: i64,
    start_line_count: usize,
    start_cwd: &str,
) -> FileScanResult {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            return FileScanResult {
                messages: Vec::new(),
                cursor: start_cursor,
                line_count: start_line_count,
                cwd: start_cwd.to_string(),
            };
        }
    };
    if file
        .seek(SeekFrom::Start(start_cursor.max(0) as u64))
        .is_err()
    {
        return FileScanResult {
            messages: Vec::new(),
            cursor: start_cursor,
            line_count: start_line_count,
            cwd: start_cwd.to_string(),
        };
    }
    let reader = BufReader::new(file);
    let mut cwd = start_cwd.to_string();
    let mut messages = Vec::new();
    let mut cursor = start_cursor;
    let mut line_count = start_line_count;
    let mut reader = reader;
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        let Ok(read) = reader.read_until(b'\n', &mut bytes) else {
            break;
        };
        if read == 0 {
            break;
        }
        let complete_line = bytes.ends_with(b"\n");
        let line = String::from_utf8_lossy(&bytes);
        let trimmed = line.trim();
        let parsed = if trimmed.is_empty() || !line_looks_useful(trimmed) {
            None
        } else {
            serde_json::from_str::<Value>(trimmed).ok()
        };
        if !complete_line && parsed.is_none() {
            break;
        }
        if let Some(value) = parsed {
            if let Some(found) = extract_cwd(&value) {
                cwd = found;
            }
            if let Some(message) = extract_user_message(&value, source, path, line_count, &cwd) {
                messages.push(message);
            }
        }
        cursor = cursor.saturating_add(read as i64);
        line_count = line_count.saturating_add(1);
    }
    FileScanResult {
        messages,
        cursor,
        line_count,
        cwd,
    }
}

fn line_looks_useful(line: &str) -> bool {
    line.contains("\"type\":\"user\"")
        || line.contains("\"type\": \"user\"")
        || line.contains("\"role\":\"user\"")
        || line.contains("\"role\": \"user\"")
        || line.contains("session_meta")
        || line.contains("\"cwd\"")
}

fn extract_cwd(value: &Value) -> Option<String> {
    if value.get("type").and_then(Value::as_str) == Some("session_meta") {
        if let Some(cwd) = value
            .pointer("/payload/cwd")
            .and_then(Value::as_str)
            .filter(|item| looks_like_abs_path(item))
        {
            return Some(cwd.to_string());
        }
    }
    value
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|item| looks_like_abs_path(item))
        .map(ToString::to_string)
}

fn extract_user_message(
    value: &Value,
    source: &str,
    path: &Path,
    index: usize,
    cwd: &str,
) -> Option<ParsedMessage> {
    let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    let (content, timestamp, message_cwd) = if record_type == "user" {
        if !claude_is_human(value) {
            return None;
        }
        let content = extract_text(value.get("message").and_then(|item| item.get("content"))?)?;
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let message_cwd = value
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(cwd)
            .to_string();
        (content, timestamp, message_cwd)
    } else if record_type == "response_item" {
        let payload = value.get("payload")?;
        if payload.get("type").and_then(Value::as_str) != Some("message")
            || payload.get("role").and_then(Value::as_str) != Some("user")
        {
            return None;
        }
        let content = extract_text(payload.get("content")?)?;
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        (content, timestamp, cwd.to_string())
    } else {
        return None;
    };

    let content = normalize_user_content(&content)?;
    let timestamp = if timestamp.is_empty() {
        format!("{index:08}")
    } else {
        timestamp
    };
    let file_key = path.to_string_lossy();
    Some(ParsedMessage {
        id: stable_id(&[source, &file_key, &timestamp, &content]),
        source: source.to_string(),
        content,
        timestamp,
        cwd: message_cwd,
    })
}

fn claude_is_human(value: &Value) -> bool {
    if value.pointer("/origin/kind").and_then(Value::as_str) == Some("human") {
        return true;
    }
    if value.get("promptSource").and_then(Value::as_str) == Some("typed") {
        return true;
    }
    let content = value.get("message").and_then(|item| item.get("content"));
    matches!(content, Some(Value::String(_)))
}

fn extract_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    let items = content.as_array()?;
    if items
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))
    {
        return None;
    }
    let mut parts = Vec::new();
    for item in items {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "text" || kind == "input_text" {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                parts.push(text);
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

fn normalize_user_content(content: &str) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() || is_injected_prompt(trimmed) {
        return None;
    }
    let mut text = trimmed.to_string();
    if text.chars().count() > MAX_CONTENT_CHARS {
        text = text.chars().take(MAX_CONTENT_CHARS).collect();
    }
    Some(text)
}

fn is_injected_prompt(text: &str) -> bool {
    let start = text.trim_start();
    start.starts_with("# AGENTS.md")
        || start.starts_with("<INSTRUCTIONS>")
        || start.starts_with("<environment_context>")
}

fn looks_like_abs_path(path: &str) -> bool {
    path.len() >= 3 && path.as_bytes().get(1) == Some(&b':') && {
        let first = path.as_bytes()[0];
        first.is_ascii_alphabetic()
    }
}

fn normalize_path_key(path: &str) -> String {
    path.trim()
        .to_ascii_lowercase()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Some((mtime, meta.len() as i64))
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn stable_id(parts: &[&str]) -> String {
    let mut hash = 14695981039346656037u64;
    for part in parts {
        for byte in part.as_bytes() {
            hash ^= *byte as u64;
            hash = hash.wrapping_mul(1099511628211);
        }
        hash ^= 0xFF;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("h-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsh_profiles::tests::ENV_LOCK;
    use std::io::Write as _;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn open_db(dir: &Path) -> AppDb {
        AppDb::new(dir).unwrap()
    }

    #[test]
    fn workspace_prompt_window_limit_and_submission_deduplication() {
        let now = prompt_timestamp_ms("2026-09-08T12:00:00Z").unwrap();
        let message = |id: &str, content: &str, timestamp: &str| CliHistoryMessage {
            id: id.into(),
            session_id: "test".into(),
            role: "user".into(),
            content: content.into(),
            timestamp: timestamp.into(),
        };
        let long = "提示词\n".repeat(1500);
        let native = vec![
            message("native-1", &long, "2026-09-08T11:59:02Z"),
            message("native-2", &long, "2026-09-08T11:59:12Z"),
            message("boundary", "七天边界", "2026-09-01T12:00:00Z"),
            message("old", "过期", "2026-09-01T11:59:59Z"),
            message("invalid", "无时间", "00000123"),
        ];
        let local = vec![
            message("input-1", &long, "2026-09-08T19:59:00+08:00"),
            message("input-2", &long, "2026-09-08T11:59:10Z"),
        ];
        let result = merge_workspace_prompts(local, native, now);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].content, long);
        assert_eq!(result[1].content, long);
        assert_eq!(result[2].id, "boundary");
        let many = (0..60)
            .map(|i| message(&format!("n-{i:02}"), "重复发送", "2026-09-08T11:00:00Z"))
            .collect();
        assert_eq!(merge_workspace_prompts(Vec::new(), many, now).len(), 50);
    }

    #[test]
    fn extracts_claude_human_prompt_and_skips_tool_results() {
        let claude = serde_json::json!({
            "type": "user",
            "timestamp": "2026-08-22T17:46:49.055Z",
            "cwd": r"D:\Projects\Example\plugins",
            "origin": { "kind": "human" },
            "message": { "role": "user", "content": "看看super系列插件都能做什么东西" }
        });
        let parsed = extract_user_message(
            &claude,
            "claude",
            Path::new("s.jsonl"),
            0,
            r"D:\Projects\Example\plugins",
        )
        .unwrap();
        assert_eq!(parsed.content, "看看super系列插件都能做什么东西");

        let tool = serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "tool_result", "content": "x" }] }
        });
        assert!(extract_user_message(&tool, "claude", Path::new("s.jsonl"), 1, "").is_none());
    }

    #[test]
    fn extracts_codex_user_text_and_skips_agents_md() {
        let user = serde_json::json!({
            "timestamp": "2026-08-23T07:43:52.826Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "hi" }]
            }
        });
        let parsed =
            extract_user_message(&user, "codex", Path::new("rollout.jsonl"), 8, r"D:\x").unwrap();
        assert_eq!(parsed.content, "hi");
        assert_eq!(parsed.cwd, r"D:\x");

        let injected = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "# AGENTS.md instructions for D:\\x\n\n<INSTRUCTIONS>\n规则" }]
            }
        });
        assert!(
            extract_user_message(&injected, "codex", Path::new("rollout.jsonl"), 5, "").is_none()
        );
    }

    #[test]
    fn indexes_claude_and_codex_sessions_and_keeps_cwd_paths() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let old_profile = std::env::var("USERPROFILE").ok();
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("USERPROFILE", tmp.path());
        std::env::set_var("HOME", tmp.path());

        let cwd = r"D:\Projects\Example\plugins";
        write(
            &tmp.path()
                .join(".claude/projects/D-----------------plugins/a.jsonl"),
            &format!(
                "{}\n{}\n",
                r#"{"type":"mode","mode":"normal"}"#,
                serde_json::json!({
                    "type": "user",
                    "timestamp": "2026-08-22T17:46:49.055Z",
                    "cwd": cwd,
                    "origin": { "kind": "human" },
                    "message": { "role": "user", "content": "看看super系列插件都能做什么东西" }
                })
            ),
        );
        write(
            &tmp.path().join(".codex/sessions/2026/08/23/rollout.jsonl"),
            &format!(
                "{}\n{}\n{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": { "cwd": cwd }
                }),
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "# AGENTS.md instructions for D:\\x" }]
                    }
                }),
                serde_json::json!({
                    "timestamp": "2026-08-23T07:43:52.826Z",
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": "继续改这个插件" }]
                    }
                })
            ),
        );

        let db = open_db(&tmp.path().join("db"));
        let cached_empty = load_cached(&db).unwrap();
        assert_eq!(cached_empty.indexed_messages, 0);
        assert_eq!(cached_empty.scanned_files, 0);

        let first = refresh(&db).unwrap();
        assert_eq!(first.scanned_files, 2);
        assert_eq!(first.indexed_files, 2);
        assert_eq!(first.indexed_messages, 2);
        assert!(first
            .messages
            .iter()
            .any(|item| item.content.contains("看看super系列")));
        assert!(first
            .messages
            .iter()
            .any(|item| item.content.contains("继续改这个插件")));
        let plugins = first
            .paths
            .iter()
            .find(|item| item.path.replace('\\', "/") == cwd.replace('\\', "/"))
            .unwrap();
        assert!(plugins.count >= 2);

        let second = refresh(&db).unwrap();
        assert_eq!(second.indexed_files, 0);
        assert_eq!(second.indexed_messages, 2);
        let cached = load_cached(&db).unwrap();
        assert_eq!(cached.indexed_messages, 2);
        assert_eq!(cached.scanned_files, 0);

        if let Some(value) = old_profile {
            std::env::set_var("USERPROFILE", value);
        } else {
            std::env::remove_var("USERPROFILE");
        }
        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn records_superhigh_messages_without_rescanning() {
        let tmp = TempDir::new().unwrap();
        let db = open_db(tmp.path());
        record_superhigh_message(
            &db,
            "把 D:\\Projects\\Example\\plugins 打开",
            "2026-08-23T10:00:00.000Z",
            Some(r"D:\Projects\Example\plugins"),
            "session-1",
        )
        .unwrap();
        let snapshot = load_snapshot(&db).unwrap();
        assert_eq!(snapshot.messages.len(), 1);
        assert!(snapshot
            .paths
            .iter()
            .any(|item| item.path.contains("plugins")));
    }

    #[test]
    fn refresh_uses_byte_cursor_and_recovers_from_partial_or_truncated_jsonl() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let old_profile = std::env::var("USERPROFILE").ok();
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("USERPROFILE", tmp.path());
        std::env::set_var("HOME", tmp.path());

        let cwd = r"D:\incremental";
        let (year, month, day) = millis_to_ymd_utc(now_ms());
        let path = tmp.path().join(format!(
            ".codex/sessions/{year:04}/{month:02}/{day:02}/incremental.jsonl"
        ));
        let session_meta = serde_json::json!({
            "type": "session_meta",
            "payload": { "cwd": cwd }
        })
        .to_string();
        let prompt = |text: &str, timestamp: &str| {
            serde_json::json!({
                "timestamp": timestamp,
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": text }]
                }
            })
            .to_string()
        };
        write(
            &path,
            &format!(
                "{}\n{}\n",
                session_meta,
                prompt("第一条", "2026-08-29T01:00:00.000Z")
            ),
        );
        let file_key = path.to_string_lossy().replace('\\', "/");

        let db = open_db(&tmp.path().join("db"));
        let first = refresh(&db).unwrap();
        assert_eq!(first.indexed_messages, 1);
        let first_cursor = db
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT cursor FROM cli_history_file_cursors WHERE path = ?1",
                        params![&file_key],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(first_cursor, fs::metadata(&path).unwrap().len() as i64);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", prompt("第二条", "2026-08-29T02:00:00.000Z")).unwrap();
        drop(file);
        let second = refresh(&db).unwrap();
        assert_eq!(second.indexed_files, 1);
        assert_eq!(second.indexed_messages, 2);
        assert!(second
            .messages
            .iter()
            .any(|message| message.content == "第二条"));
        assert!(
            second
                .messages
                .iter()
                .filter(|message| message.content == "第一条")
                .count()
                == 1
        );
        let matching_cwd_count = db
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM cli_history_messages WHERE file_path = ?1 AND cwd = ?2",
                        params![&file_key, cwd],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(matching_cwd_count, 2);

        let complete_cursor = fs::metadata(&path).unwrap().len() as i64;
        let third = prompt("第三条", "2026-08-29T03:00:00.000Z");
        let split = third.len() - 3;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(third[..split].as_bytes()).unwrap();
        drop(file);
        let partial = refresh(&db).unwrap();
        assert_eq!(partial.indexed_messages, 2);
        let partial_cursor = db
            .with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT cursor FROM cli_history_file_cursors WHERE path = ?1",
                        params![&file_key],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(partial_cursor, complete_cursor);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{}", &third[split..]).unwrap();
        drop(file);
        let completed = refresh(&db).unwrap();
        assert_eq!(completed.indexed_messages, 3);
        assert!(completed
            .messages
            .iter()
            .any(|message| message.content == "第三条"));

        write(
            &path,
            &format!(
                "{}\n{}\n",
                session_meta,
                prompt("截断后", "2026-08-29T04:00:00.000Z")
            ),
        );
        let truncated = refresh(&db).unwrap();
        assert_eq!(truncated.indexed_messages, 1);
        assert_eq!(truncated.messages[0].content, "截断后");

        if let Some(value) = old_profile {
            std::env::set_var("USERPROFILE", value);
        } else {
            std::env::remove_var("USERPROFILE");
        }
        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }

    #[test]
    fn incremental_refresh_skips_old_codex_days() {
        let _guard = ENV_LOCK.lock().unwrap();
        let tmp = TempDir::new().unwrap();
        let old_profile = std::env::var("USERPROFILE").ok();
        let old_home = std::env::var("HOME").ok();
        std::env::set_var("USERPROFILE", tmp.path());
        std::env::set_var("HOME", tmp.path());

        let prompt = |text: &str, ts: &str| {
            format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": { "cwd": r"D:\old" }
                }),
                serde_json::json!({
                    "timestamp": ts,
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text": text }]
                    }
                })
            )
        };
        write(
            &tmp.path().join(".codex/sessions/2026/01/01/old.jsonl"),
            &prompt("一月旧对话", "2026-01-01T10:00:00.000Z"),
        );
        let (year, month, day) = millis_to_ymd_utc(now_ms());
        write(
            &tmp.path().join(format!(
                ".codex/sessions/{year:04}/{month:02}/{day:02}/new.jsonl"
            )),
            &prompt("今天对话", "2026-08-23T10:00:00.000Z"),
        );

        let db = open_db(&tmp.path().join("db"));
        let first = refresh(&db).unwrap();
        assert_eq!(first.scanned_files, 2);
        assert_eq!(first.indexed_messages, 2);

        let second = refresh(&db).unwrap();
        assert_eq!(second.scanned_files, 1);
        assert_eq!(second.indexed_files, 0);
        assert_eq!(second.indexed_messages, 2);

        if let Some(value) = old_profile {
            std::env::set_var("USERPROFILE", value);
        } else {
            std::env::remove_var("USERPROFILE");
        }
        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
    }
}
