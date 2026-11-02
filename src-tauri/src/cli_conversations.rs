use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH, Instant, Duration},
};

use anyhow::Context;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    CliNativeConversationDetail, CliNativeConversationMessage, CliNativeConversationSummary,
};

const SUMMARY_SCAN_LINE_LIMIT: usize = 360;

#[derive(Clone, Copy)]
struct ConversationSource {
    provider: &'static str,
}

#[derive(Default)]
struct ParsedConversation {
    native_session_id: Option<String>,
    cwd: String,
    created_at: String,
    updated_at: String,
    title: String,
    messages: Vec<CliNativeConversationMessage>,
}

impl ParsedConversation {
    fn remember_message(&mut self, role: &str, content: String, timestamp: String) {
        let content = normalize_message_content(&content);
        if content.is_empty() || (role == "user" && is_injected_prompt(&content)) {
            return;
        }
        if self.messages.last().is_some_and(|message| {
            message.role == role && message.content == content && message.timestamp == timestamp
        }) {
            return;
        }
        self.messages.push(CliNativeConversationMessage {
            id: format!("m-{}", self.messages.len() + 1),
            role: role.to_string(),
            content,
            timestamp,
        });
    }

    fn title_or_first_user(&self, provider: &str) -> String {
        if !self.title.trim().is_empty() {
            return compact_text(&self.title, 72);
        }
        self.messages
            .iter()
            .find(|message| message.role == "user")
            .map(|message| compact_text(&message.content, 72))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("{provider} 会话"))
    }
}


/// Global native history index; scans only known CLI storage roots.
pub fn list_all_conversations(refresh: bool) -> anyhow::Result<Vec<CliNativeConversationSummary>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<CliNativeConversationSummary>)>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if !refresh {
        if let Some((at, entries)) = &*cache {
            if at.elapsed() < Duration::from_secs(15) { return Ok(entries.clone()); }
        }
    }
    let home = user_home().context("无法确定用户目录")?;
    let entries = list_all_from_home(&home);
    *cache = Some((Instant::now(), entries.clone()));
    Ok(entries)
}

fn list_all_from_home(home: &Path) -> Vec<CliNativeConversationSummary> {
    static FILE_CACHE: OnceLock<Mutex<HashMap<PathBuf, (Option<PromptFileStamp>, CliNativeConversationSummary)>>> = OnceLock::new();
    let mut cache = FILE_CACHE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for (root, source) in session_roots(home) {
        for path in collect_session_files(&root, source) {
            let stamp = prompt_file_stamp(&path);
            seen.insert(path.clone());
            if let Some((old_stamp, summary)) = cache.get(&path) {
                if stamp.is_some() && *old_stamp == stamp { result.push(summary.clone()); continue; }
            }
            if let Ok(Some(parsed)) = parse_conversation(&path, source, false) {
                if !parsed.cwd.is_empty() {
                    let summary = build_summary(&path, source, parsed, fs::metadata(&path).ok().as_ref());
                    if cache.len() < 8192 { cache.insert(path, (stamp, summary.clone())); }
                    result.push(summary);
                }
            }
        }
    }
    cache.retain(|path, _| seen.contains(path));
    drop(cache);
    let codex_home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    apply_codex_titles(&mut result, &load_codex_titles(&codex_home));
    let db = opencode_database_path(home);
    static DB_CACHE: OnceLock<Mutex<Option<(PathBuf, Vec<Option<PromptFileStamp>>, Vec<CliNativeConversationSummary>)>>> = OnceLock::new();
    let mut db_cache = DB_CACHE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let stamps = vec![prompt_file_stamp(&db), prompt_file_stamp(&db.with_extension("db-wal"))];
    if let Some((_, _, entries)) = db_cache.as_ref().filter(|(path, previous, _)| *path == db && *previous == stamps && stamps[0].is_some()) {
        result.extend(entries.clone());
    } else if let Ok(Some(conn)) = open_opencode_database(&db) {
        let mut entries = Vec::new();
        if let Ok(sessions) = opencode_sessions(&conn) {
            for session in sessions {
                let mut parsed = parsed_opencode_session(&session);
                parsed.messages = read_opencode_messages(&conn, &session.id).unwrap_or_default();
                let mut summary = build_summary(&db, ConversationSource { provider: "opencode" }, parsed, fs::metadata(&db).ok().as_ref());
                summary.source_path = opencode_source_path(&session.id);
                entries.push(summary);
            }
        }
        result.extend(entries.clone());
        *db_cache = Some((db, stamps, entries));
    }
    drop(db_cache);
    let existing: HashSet<String> = result.iter().filter(|s| s.provider_kind == "opencode").filter_map(|s| s.native_session_id.clone()).collect();
    result.extend(legacy_opencode_summaries(home).into_iter().filter(|s| s.native_session_id.as_ref().is_some_and(|id| !existing.contains(id))));
    result.sort_by(|a,b| b.updated_at.cmp(&a.updated_at).then_with(|| a.id.cmp(&b.id)));
    result
}

pub(crate) fn historical_chat(workspace: &Path, source: &str, limit: usize) -> anyhow::Result<crate::cli_chat::ChatTranscript> {
    let path = Path::new(source);
    let lightweight = source_for_path(path).filter(|s| matches!(s.provider, "claude" | "codex"));
    let summary = if let Some(provider) = lightweight {
        let parsed = parse_conversation(path, provider, false)?.filter(|p| workspace_cwd_matches(&p.cwd, workspace)).context("该原生 CLI 对话不属于当前工作区")?;
        build_summary(path, provider, parsed, fs::metadata(path).ok().as_ref())
    } else { read_workspace_conversation(workspace, source)?.summary };
    let completed_at = time::OffsetDateTime::parse(&summary.updated_at, &time::format_description::well_known::Rfc3339).ok().map(|v| (v.unix_timestamp_nanos() / 1_000_000) as i64)
        .into_iter().chain(fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64)).max();
    let mut transcript = match summary.provider_kind.as_str() {
        "claude" | "codex" => crate::cli_chat::read_chat_window(&summary.provider_kind, source, limit)?,
        "dsh" => crate::cli_chat::read_dsh_chat(Path::new(source), limit)?,
        "opencode" => {
            let home = user_home().context("无法确定用户目录")?;
            crate::cli_chat::parse_opencode_chat(opencode_chat_records(&home, source)?, limit)
        },
        _ => crate::cli_chat::read_native_chat(workspace, source, completed_at)?,
    };
    for turn in &mut transcript.turns {
        if turn.completed_at.is_none() {
            let at = completed_at.unwrap_or(turn.started_at).max(turn.started_at);
            turn.completed_at = Some(at);
            turn.duration_ms = Some(at - turn.started_at);
        }
    }
    let excess = transcript.turns.len().saturating_sub(limit.saturating_add(1));
    transcript.turns.drain(..excess);
    Ok(transcript)
}

pub fn list_workspace_conversations(
    workspace_path: &Path,
) -> anyhow::Result<Vec<CliNativeConversationSummary>> {
    let home = user_home().context("无法确定用户目录，无法读取本机 CLI 对话")?;
    list_workspace_conversations_from_home(workspace_path, &home)
}

pub fn read_workspace_conversation(
    workspace_path: &Path,
    source_path: &str,
) -> anyhow::Result<CliNativeConversationDetail> {
    if let Some(id) = source_path.strip_prefix("opencode-legacy://") {
        let home = user_home().context("无法确定用户目录")?;
        return read_legacy_opencode(workspace_path, &home, id);
    }
    if let Some(session_id) = opencode_session_id_from_source_path(source_path) {
        let home = user_home().context("无法确定用户目录，无法读取本机 CLI 对话")?;
        return read_opencode_workspace_conversation(workspace_path, &home, session_id);
    }
    read_native_workspace_conversation(workspace_path, source_path)
}

/// Read native user submissions, including input sent directly through a PTY.
pub fn workspace_prompt_messages(
    workspace: &Path,
) -> anyhow::Result<Vec<crate::models::CliHistoryMessage>> {
    let home = user_home().context("无法确定用户目录，无法读取提示词历史")?;
    workspace_prompt_messages_from_home(workspace, &home)
}

#[derive(Clone, PartialEq, Eq)]
struct PromptFileStamp {
    modified: SystemTime,
    size: u64,
}

struct PromptCacheEntry {
    stamps: Vec<Option<PromptFileStamp>>,
    cwd: String,
    // None means only the workspace metadata has been parsed so far.
    messages: Option<Vec<crate::models::CliHistoryMessage>>,
    touched: u64,
}

#[derive(Default)]
struct PromptCache {
    entries: HashMap<PathBuf, PromptCacheEntry>,
    generation: u64,
    #[cfg(test)]
    parses: usize,
}

static PROMPT_CACHE: OnceLock<Mutex<PromptCache>> = OnceLock::new();
const PROMPT_CACHE_BYTES: usize = 32 * 1024 * 1024;
const PROMPT_CACHE_FILES: usize = 4096;

fn prompt_file_stamp(path: &Path) -> Option<PromptFileStamp> {
    let metadata = fs::metadata(path).ok()?;
    Some(PromptFileStamp {
        modified: metadata.modified().ok()?,
        size: metadata.len(),
    })
}

fn retain_recent_prompt_messages(messages: &mut Vec<crate::models::CliHistoryMessage>) {
    let now = time::OffsetDateTime::now_utc();
    let cutoff = now - time::Duration::days(7);
    messages.retain(|message| {
        time::OffsetDateTime::parse(
            &message.timestamp,
            &time::format_description::well_known::Rfc3339,
        )
        .is_ok_and(|timestamp| timestamp >= cutoff && timestamp <= now)
    });
    messages.sort_by(|a, b| {
        let parse = |value: &str| {
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
        };
        parse(&b.timestamp)
            .cmp(&parse(&a.timestamp))
            .then_with(|| b.id.cmp(&a.id))
    });
    messages.truncate(50);
}

impl PromptCache {
    fn read(
        &mut self,
        key: &Path,
        stamps: Vec<Option<PromptFileStamp>>,
        workspace: &Path,
        mut load: impl FnMut(
            bool,
        )
            -> anyhow::Result<Option<(String, Vec<crate::models::CliHistoryMessage>)>>,
    ) -> anyhow::Result<Vec<crate::models::CliHistoryMessage>> {
        let changed = self
            .entries
            .get(key)
            .is_some_and(|entry| entry.stamps != stamps);
        let previously_matched = changed
            && self
                .entries
                .get(key)
                .is_some_and(|entry| workspace_cwd_matches(&entry.cwd, workspace));
        if changed {
            self.entries.remove(key);
        }
        if !self.entries.contains_key(key) {
            #[cfg(test)]
            {
                self.parses += 1;
            }
            let (cwd, mut messages) = load(previously_matched)?.unwrap_or_default();
            if previously_matched {
                retain_recent_prompt_messages(&mut messages);
            }
            self.entries.insert(
                key.to_path_buf(),
                PromptCacheEntry {
                    stamps,
                    cwd,
                    messages: previously_matched.then_some(messages),
                    touched: self.generation,
                },
            );
        }
        let entry = self.entries.get_mut(key).expect("entry inserted above");
        entry.touched = self.generation;
        if !workspace_cwd_matches(&entry.cwd, workspace) {
            return Ok(Vec::new());
        }
        if entry.messages.is_none() {
            #[cfg(test)]
            {
                self.parses += 1;
            }
            let loaded = load(true)?;
            // A file may be rewritten while being read. Never expose another workspace's messages.
            let mut messages = loaded
                .filter(|(cwd, _)| workspace_cwd_matches(cwd, workspace))
                .map(|(_, messages)| messages)
                .unwrap_or_default();
            retain_recent_prompt_messages(&mut messages);
            entry.messages = Some(messages);
        }
        Ok(entry.messages.as_ref().cloned().unwrap_or_default())
    }

    fn finish(&mut self, seen: &HashSet<PathBuf>, home: &Path) {
        self.entries
            .retain(|path, _| !path.starts_with(home) || seen.contains(path));
        let bytes = |entry: &PromptCacheEntry| {
            entry.cwd.len()
                + entry.messages.as_ref().map_or(0, |messages| {
                    messages
                        .iter()
                        .map(|m| {
                            m.content.len()
                                + m.id.len()
                                + m.session_id.len()
                                + m.timestamp.len()
                                + 128
                        })
                        .sum::<usize>()
                })
                + 256
        };
        let mut used: usize = self.entries.values().map(bytes).sum();
        if used <= PROMPT_CACHE_BYTES && self.entries.len() <= PROMPT_CACHE_FILES {
            return;
        }
        let mut oldest: Vec<_> = self
            .entries
            .iter()
            .map(|(key, entry)| (entry.touched, key.clone()))
            .collect();
        oldest.sort_by_key(|(generation, _)| *generation);
        for (_, key) in oldest {
            if used <= PROMPT_CACHE_BYTES && self.entries.len() <= PROMPT_CACHE_FILES {
                break;
            }
            if self.entries.len() > PROMPT_CACHE_FILES {
                if let Some(entry) = self.entries.remove(&key) {
                    used = used.saturating_sub(bytes(&entry));
                }
            } else if let Some(entry) = self.entries.get_mut(&key) {
                let before = bytes(entry);
                entry.messages = None;
                used = used.saturating_sub(before.saturating_sub(bytes(entry)));
            }
        }
    }
}

fn workspace_prompt_messages_from_home(
    workspace: &Path,
    home: &Path,
) -> anyhow::Result<Vec<crate::models::CliHistoryMessage>> {
    let mut cache = PROMPT_CACHE
        .get_or_init(|| Mutex::new(PromptCache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    workspace_prompt_messages_with_cache(workspace, home, &mut cache)
}

fn workspace_prompt_messages_with_cache(
    workspace: &Path,
    home: &Path,
    cache: &mut PromptCache,
) -> anyhow::Result<Vec<crate::models::CliHistoryMessage>> {
    cache.generation = cache.generation.wrapping_add(1);
    let mut seen = HashSet::new();
    let mut messages = Vec::new();
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(7 * 86400))
        .unwrap_or(UNIX_EPOCH);
    for (root, source) in session_roots(home) {
        for path in collect_session_files(&root, source) {
            let mut stamps = vec![prompt_file_stamp(&path)];
            if let Some(parent) = path.parent() {
                match source.provider {
                    "kimi" => {
                        stamps.push(prompt_file_stamp(&parent.join("agents/main/wire.jsonl")))
                    }
                    "grok" => stamps.push(prompt_file_stamp(&parent.join("chat_history.jsonl"))),
                    _ => {}
                }
            }
            if !stamps
                .iter()
                .flatten()
                .any(|stamp| stamp.modified >= cutoff)
            {
                continue;
            }
            seen.insert(path.clone());
            let loaded = cache.read(&path, stamps, workspace, |full| {
                Ok(parse_conversation(&path, source, full)
                    .ok()
                    .flatten()
                    .map(|parsed| {
                        let session_id = format!("{}:{}", source.provider, path.display());
                        let messages = if full {
                            parsed
                                .messages
                                .into_iter()
                                .filter(|m| m.role == "user")
                                .map(|m| crate::models::CliHistoryMessage {
                                    id: format!("{session_id}:{}", m.id),
                                    session_id: session_id.clone(),
                                    role: m.role,
                                    content: m.content,
                                    timestamp: m.timestamp,
                                })
                                .collect()
                        } else {
                            Vec::new()
                        };
                        (parsed.cwd, messages)
                    }))
            });
            if let Ok(loaded) = loaded {
                messages.extend(loaded);
            }
        }
    }
    let database = opencode_database_path(home);
    if database.is_file() {
        // SQLite writes may only touch the WAL; its stamp is part of the cache identity.
        let stamps = vec![
            prompt_file_stamp(&database),
            prompt_file_stamp(&database.with_extension("db-wal")),
        ];
        let key = database.join(
            normalize_path_key(&workspace.to_string_lossy())
                .bytes()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        );
        // Keep other workspace results while the same database/WAL version still exists.
        seen.extend(
            cache
                .entries
                .iter()
                .filter(|(path, entry)| path.starts_with(&database) && entry.stamps == stamps)
                .map(|(path, _)| path.clone()),
        );
        seen.insert(key.clone());
        messages.extend(cache.read(&key, stamps, workspace, |full| {
            let cwd = workspace.to_string_lossy().into_owned();
            if !full {
                return Ok(Some((cwd, Vec::new())));
            }
            let Some(connection) = open_opencode_database(&database)? else {
                return Ok(None);
            };
            let mut messages = Vec::new();
            for session in opencode_sessions(&connection)? {
                if !workspace_cwd_matches(&session.directory, workspace) {
                    continue;
                }
                for message in read_opencode_messages(&connection, &session.id)?
                    .into_iter()
                    .filter(|m| m.role == "user")
                {
                    messages.push(crate::models::CliHistoryMessage {
                        id: format!("opencode:{}:{}", session.id, message.id),
                        session_id: session.id.clone(),
                        role: message.role,
                        content: message.content,
                        timestamp: message.timestamp,
                    });
                }
            }
            Ok(Some((cwd, messages)))
        })?);
    }
    if let Ok(projects) = fs::read_dir(home.join(".gemini/tmp")) {
        for project in projects.flatten() {
            let project_root = project.path().join(".project_root");
            let Ok(chats) = fs::read_dir(project.path().join("chats")) else {
                continue;
            };
            for chat in chats.flatten() {
                let path = chat.path();
                if !matches!(
                    path.extension().and_then(|v| v.to_str()),
                    Some("json" | "jsonl")
                ) {
                    continue;
                }
                let stamp = prompt_file_stamp(&path);
                if !stamp.as_ref().is_some_and(|stamp| stamp.modified >= cutoff) {
                    continue;
                }
                seen.insert(path.clone());
                let loaded = cache.read(
                    &path,
                    vec![stamp, prompt_file_stamp(&project_root)],
                    workspace,
                    |full| {
                        let cwd = fs::read_to_string(&project_root).unwrap_or_default();
                        Ok(Some((
                            cwd,
                            if full {
                                read_gemini_prompt_messages(&path)?
                            } else {
                                Vec::new()
                            },
                        )))
                    },
                );
                if let Ok(loaded) = loaded {
                    messages.extend(loaded);
                }
            }
        }
    }
    cache.finish(&seen, home);
    Ok(messages)
}

fn read_gemini_prompt_messages(
    path: &Path,
) -> anyhow::Result<Vec<crate::models::CliHistoryMessage>> {
    let mut messages = Vec::new();
    let file = File::open(path)?;
    let stream = serde_json::Deserializer::from_reader(BufReader::new(file)).into_iter::<Value>();
    for (index, value) in stream.enumerate() {
        let Ok(value) = value else { break };
        let entries = value
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| vec![value]);
        for (entry_index, entry) in entries.iter().enumerate() {
            if entry.get("type").and_then(Value::as_str) != Some("user") {
                continue;
            }
            let Some(content) = extract_text(entry.get("content")) else {
                continue;
            };
            if is_injected_prompt(&content) {
                continue;
            }
            messages.push(crate::models::CliHistoryMessage {
                id: format!("gemini:{}:{index}:{entry_index}", path.display()),
                session_id: format!("gemini:{}", path.display()),
                role: "user".into(),
                content: normalize_message_content(&content),
                timestamp: record_timestamp(entry, entry_index),
            });
        }
    }
    Ok(messages)
}

pub fn find_current_native_session_id(
    workspace_path: &Path,
    provider: &str,
    started_at: SystemTime,
) -> anyhow::Result<Option<String>> {
    let home = user_home().context("无法确定用户目录，无法定位当前 CLI 会话")?;
    let Some((root, source)) = session_roots(&home)
        .into_iter()
        .find(|(_, source)| source.provider == provider)
    else {
        return Ok(None);
    };
    let earliest = started_at
        .checked_sub(std::time::Duration::from_secs(10))
        .unwrap_or(UNIX_EPOCH);
    let mut candidates = collect_session_files(&root, source)
        .into_iter()
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            let created_at = metadata.created().or_else(|_| metadata.modified()).ok()?;
            (created_at >= earliest).then_some((path, created_at))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(_, created_at)| {
        created_at
            .duration_since(started_at)
            .or_else(|_| started_at.duration_since(*created_at))
            .unwrap_or_default()
    });

    for (path, _) in candidates {
        let Ok(Some(parsed)) = parse_conversation(&path, source, false) else {
            continue;
        };
        if workspace_cwd_matches(&parsed.cwd, workspace_path) {
            if let Some(native_session_id) = parsed.native_session_id {
                return Ok(Some(native_session_id));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
fn read_workspace_conversation_from_home(
    workspace_path: &Path,
    source_path: &str,
    home: &Path,
) -> anyhow::Result<CliNativeConversationDetail> {
    if let Some(session_id) = opencode_session_id_from_source_path(source_path) {
        return read_opencode_workspace_conversation(workspace_path, home, session_id);
    }
    read_native_workspace_conversation(workspace_path, source_path)
}

fn read_native_workspace_conversation(
    workspace_path: &Path,
    source_path: &str,
) -> anyhow::Result<CliNativeConversationDetail> {
    let path = PathBuf::from(source_path);
    let source = source_for_path(&path).context("不是可读取的原生 CLI 会话文件")?;
    let parsed = parse_conversation(&path, source, true)?
        .filter(|parsed| workspace_cwd_matches(&parsed.cwd, workspace_path))
        .context("该原生 CLI 对话不属于当前工作区")?;
    let metadata = fs::metadata(&path).ok();
    Ok(build_detail(&path, source, parsed, metadata.as_ref()))
}

fn list_workspace_conversations_from_home(
    workspace_path: &Path,
    home: &Path,
) -> anyhow::Result<Vec<CliNativeConversationSummary>> {
    let mut conversations = Vec::new();
    for (root, source) in session_roots(home) {
        for path in collect_session_files(&root, source) {
            let metadata = fs::metadata(&path).ok();
            let Ok(Some(parsed)) = parse_conversation(&path, source, false) else {
                continue;
            };
            if !workspace_cwd_matches(&parsed.cwd, workspace_path) {
                continue;
            }
            conversations.push(build_summary(&path, source, parsed, metadata.as_ref()));
        }
    }
    let codex_home = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
    apply_codex_titles(&mut conversations, &load_codex_titles(&codex_home));
    conversations.extend(list_opencode_workspace_conversations(workspace_path, home).unwrap_or_default());
    let ids: HashSet<_> = conversations.iter().filter(|s| s.provider_kind == "opencode").filter_map(|s| s.native_session_id.clone()).collect();
    conversations.extend(legacy_opencode_summaries(home).into_iter().filter(|s| workspace_cwd_matches(&s.cwd, workspace_path) && s.native_session_id.as_ref().is_some_and(|id| !ids.contains(id))));
    conversations.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(conversations)
}

fn session_roots(home: &Path) -> Vec<(PathBuf, ConversationSource)> {
    vec![
        (std::env::var_os("DSH_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".dsh")).join("sessions"), ConversationSource { provider: "dsh" }),
        (
            std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".claude")).join("projects"),
            ConversationSource {
                provider: "claude",
            },
        ),
        (
            std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex")).join("sessions"),
            ConversationSource {
                provider: "codex",
            },
        ),
        (std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".codex")).join("archived_sessions"), ConversationSource { provider: "codex" }),
        (
            home.join(".kimi-code").join("sessions"),
            ConversationSource {
                provider: "kimi",
            },
        ),
        (
            home.join(".grok").join("sessions"),
            ConversationSource {
                provider: "grok",
            },
        ),
        (
            home.join(".codebuddy").join("projects"),
            ConversationSource {
                provider: "codebuddy",
            },
        ),
    ]
}

/// Bind the watcher to this PTY's native session, never to an old workspace chat.
pub(crate) fn completion_source(
    workspace: &Path,
    provider: &str,
    native_id: Option<&str>,
    started_at: SystemTime,
    excluded: &HashSet<String>,
) -> anyhow::Result<Option<String>> {
    let home = user_home().context("无法确定 CLI 会话目录")?;
    completion_source_from_home(workspace, provider, native_id, started_at, excluded, &home)
}

fn completion_source_from_home(
    workspace: &Path,
    provider: &str,
    native_id: Option<&str>,
    started_at: SystemTime,
    excluded: &HashSet<String>,
    home: &Path,
) -> anyhow::Result<Option<String>> {
    if provider == "opencode" {
        let database = opencode_database_path(home);
        let Some(connection) = open_opencode_database(&database)? else { return Ok(None) };
        let mut sessions = opencode_sessions(&connection)?;
        sessions.retain(|session| !excluded.contains(&opencode_source_path(&session.id)) && workspace_cwd_matches(&session.directory, workspace)
            && native_id.map_or_else(|| {
                UNIX_EPOCH + std::time::Duration::from_millis(session.created_at.max(0) as u64) >= started_at
            }, |id| session.id == id));
        sessions.sort_by_key(|session| session.created_at);
        return Ok(sessions.first().map(|session| opencode_source_path(&session.id)));
    }
    let root = if provider == "gemini" {
        Some((home.join(".gemini/tmp"), ConversationSource { provider: "gemini" }))
    } else { session_roots(home).into_iter().find(|(_, source)| source.provider == provider) };
    let Some((root, source)) = root else {
        return Ok(None);
    };
    let mut candidates = collect_session_files(&root, source);
    candidates.retain(|path| !excluded.contains(&path.to_string_lossy().into_owned())
        && (native_id.is_some() || fs::metadata(path).and_then(|m| m.created().or_else(|_| m.modified())).is_ok_and(|created| created >= started_at)));
    candidates.sort_by_key(|path| fs::metadata(path).and_then(|m| m.created()).ok());
    for path in candidates {
        let Ok(Some(parsed)) = parse_conversation(&path, source, false) else { continue };
        if workspace_cwd_matches(&parsed.cwd, workspace)
            && native_id.is_none_or(|id| parsed.native_session_id.as_deref().or_else(|| path.file_stem().and_then(|s| s.to_str())) == Some(id)) {
            return Ok(Some(path.to_string_lossy().into_owned()));
        }
    }
    Ok(None)
}

pub(crate) fn opencode_completion(source: &str) -> anyhow::Result<Option<(String, i64)>> {
    let Some(id) = opencode_session_id_from_source_path(source) else { return Ok(None) };
    let home = user_home().context("无法确定 OpenCode 数据库目录")?;
    let Some(connection) = open_opencode_database(&opencode_database_path(&home))? else { return Ok(None) };
    opencode_completion_from_connection(&connection, id)
}

fn opencode_completion_from_connection(connection: &Connection, session_id: &str) -> anyhow::Result<Option<(String, i64)>> {
    let mut statement = connection.prepare("SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created DESC, id DESC")?;
    let rows = statement.query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, data) = row?;
        let Ok(value) = serde_json::from_str::<Value>(&data) else { continue };
        // A newer user or unfinished assistant makes an older stop event stale.
        if value["role"] == "user" { return Ok(None); }
        if value["role"] != "assistant" { continue; }
        if value["finish"] != "stop" { return Ok(None); }
        if value["role"] == "assistant" && value["finish"] == "stop" {
            if let Some(completed) = value.pointer("/time/completed").and_then(Value::as_i64) {
                let mut parts = connection.prepare("SELECT data FROM part WHERE message_id = ?1")?;
                let rows = parts.query_map([&id], |row| row.get::<_, String>(0))?;
                for row in rows {
                    let Ok(part) = serde_json::from_str::<Value>(&row?) else { continue };
                    if part["type"] == "tool" && part.pointer("/metadata/providerExecuted") != Some(&Value::Bool(true))
                        && matches!(part.pointer("/state/status").and_then(Value::as_str), Some("pending" | "running")) {
                        return Ok(None);
                    }
                }
                return Ok(Some((id, completed)));
            }
            return Ok(None);
        }
    }
    Ok(None)
}

fn collect_session_files(root: &Path, source: ConversationSource) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    if source.provider == "dsh" {
        let mut selected: HashMap<PathBuf, (u64, PathBuf)> = HashMap::new();
        for entry in WalkDir::new(root).min_depth(3).max_depth(3).follow_links(false).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file()) {
            let path = entry.into_path();
            let Some(version) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix("session.v")).and_then(|n| n.strip_suffix(".jsonl.zstd").or_else(|| n.strip_suffix(".jsonl"))).and_then(|n| n.parse::<u64>().ok()) else { continue };
            let parent = path.parent().unwrap().to_path_buf();
            let candidate = (version, path);
            if selected.get(&parent).is_none_or(|old| candidate > *old) { selected.insert(parent, candidate); }
        }
        return selected.into_values().map(|(_, path)| path).collect();
    }
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| source_file_matches(path, source))
        .collect()
}

/// Read the completed turn from its claimed history, never from another active session.
pub(crate) fn completion_notice(
    provider: &str,
    source_path: &str,
    token: &str,
    completed_at: i64,
    workspace: &Path,
) -> anyhow::Result<crate::cli_completion::CompletionNotice> {
    let mut notice = crate::cli_completion::CompletionNotice::default();
    if matches!(provider, "codex" | "claude") {
        use std::io::{Read, Seek, SeekFrom};
        let path = Path::new(source_path);
        let source = ConversationSource { provider: if provider == "codex" { "codex" } else { "claude" } };
        let head = parse_conversation_lines(BufReader::new(File::open(path)?), source, false)?;
        if let Some(head) = head {
            if !workspace_cwd_matches(&head.cwd, workspace) { return Ok(notice); }
            notice.title = head.title_or_first_user(provider);
            notice.conversation_id = head.native_session_id.unwrap_or_default();
        }
        if provider == "codex" {
            if let Some(title) = codex_stored_title(path, &notice.conversation_id) {
                notice.title = compact_text(&title, 120);
            }
        }
        let mut file = File::open(path)?;
        let offset = file.metadata()?.len().saturating_sub(1024 * 1024);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let mut parsed = ParsedConversation::default();
        for (index, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
            if offset > 0 && index == 0 { continue; }
            let Ok(value) = serde_json::from_str::<Value>(line) else { continue; };
            if provider == "codex" {
                if value["type"] == "event_msg" && value["payload"]["type"] == "task_started" {
                    parsed.messages.clear();
                }
                // Commentary is progress, not the final answer.
                if value.pointer("/payload/role").and_then(Value::as_str) != Some("assistant")
                    || value.pointer("/payload/phase").and_then(Value::as_str) == Some("final_answer")
                {
                    parse_codex_record(&value, &mut parsed, index);
                }
                if value["type"] == "event_msg" && value["payload"]["type"] == "user_message" {
                    if let Some(text) = value.pointer("/payload/message").and_then(Value::as_str) {
                        parsed.remember_message("user", text.to_owned(), record_timestamp(&value, index));
                    }
                }
            } else if value["isSidechain"] != true && value.get("agentId").and_then(Value::as_str).is_none() {
                parse_claude_record(&value, &mut parsed, index);
                if value["type"] == "custom-title" {
                    if let Some(title) = value["customTitle"].as_str() { notice.title = compact_text(title, 120); }
                }
            }
            if crate::cli_completion::record_completion(provider, &value).is_some_and(|(id, _)| id == token) {
                notice.task = parsed.messages.iter().rev().find(|m| m.role == "user")
                    .map(|m| compact_text(&m.content, 240)).unwrap_or_default();
                notice.answer = value.pointer("/payload/last_agent_message").and_then(Value::as_str)
                    .map(ToString::to_string)
                    .unwrap_or_else(|| parsed.messages.iter().rev().take_while(|m| m.role != "user")
                        .find(|m| m.role == "assistant").map(|m| m.content.clone()).unwrap_or_default());
                notice.answer = clip_notice_answer(&notice.answer);
                // Native turn durations exclude idle time before the prompt; fall back to the prompt timestamp.
                notice.duration_ms = value.pointer("/payload/duration_ms").or_else(|| value.get("durationMs"))
                    .and_then(Value::as_i64)
                    .or_else(|| turn_duration(parsed.messages.iter().rev().find(|m| m.role == "user"), completed_at));
                break;
            }
        }
        return Ok(notice);
    }
    // Other providers keep their native titles. Missing hook text remains explicitly unavailable.
    if let Ok(detail) = read_workspace_conversation(workspace, source_path) {
        notice.title = detail.summary.title;
        notice.conversation_id = detail.summary.native_session_id.unwrap_or_default();
        let messages: Vec<_> = detail.messages.iter().filter(|message| {
            time::OffsetDateTime::parse(&message.timestamp, &time::format_description::well_known::Rfc3339)
                .is_ok_and(|time| time.unix_timestamp_nanos() / 1_000_000 <= i128::from(completed_at))
        }).collect();
        let prompt = messages.iter().rev().find(|m| m.role == "user").copied();
        notice.task = prompt.map(|m| compact_text(&m.content, 240)).unwrap_or_default();
        notice.answer = messages.iter().rev().take_while(|m| m.role != "user")
            .find(|m| m.role == "assistant").map(|m| clip_notice_answer(&m.content)).unwrap_or_default();
        notice.duration_ms = turn_duration(prompt, completed_at);
    }
    Ok(notice)
}

fn turn_duration(prompt: Option<&CliNativeConversationMessage>, completed_at: i64) -> Option<i64> {
    let time = time::OffsetDateTime::parse(&prompt?.timestamp, &time::format_description::well_known::Rfc3339).ok()?;
    let started = (time.unix_timestamp_nanos() / 1_000_000) as i64;
    (completed_at >= started).then_some(completed_at - started)
}

fn clip_notice_answer(text: &str) -> String {
    let mut chars = text.trim().chars();
    let answer = chars.by_ref().take(8000).collect::<String>();
    if chars.next().is_some() { format!("{answer}\n\n（回答较长，请回到原会话查看全文）") } else { answer }
}

fn codex_stored_title(source: &Path, session_id: &str) -> Option<String> {
    let root = source.ancestors().find(|path| matches!(path.file_name().and_then(|n| n.to_str()), Some("sessions" | "archived_sessions")))?.parent()?;
    load_codex_titles(root).remove(session_id)
}

fn apply_codex_titles(summaries: &mut [CliNativeConversationSummary], titles: &HashMap<String, String>) {
    for summary in summaries.iter_mut().filter(|s| s.provider_kind == "codex") {
        if let Some(title) = summary.native_session_id.as_ref().and_then(|id| titles.get(id)) {
            summary.title = compact_text(title, 72);
        }
    }
}

fn load_codex_titles(root: &Path) -> HashMap<String, String> {
    let mut titles = HashMap::new();
    // Use only the known state databases in CODEX_HOME, newest version first.
    let mut dbs: Vec<_> = fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|path| {
        path.file_name().and_then(|n| n.to_str()).is_some_and(|name| name.strip_prefix("state_").and_then(|n| n.strip_suffix(".sqlite")).is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()) && !n.is_empty()))
    }).collect();
    let version = |p: &PathBuf| p.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix("state_")).and_then(|n| n.strip_suffix(".sqlite")).and_then(|n| n.parse::<u64>().ok()).unwrap_or_default();
    dbs.sort_by_key(|p| std::cmp::Reverse(version(p)));
    for db in dbs {
        let Ok(connection) = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX) else { continue };
        let _ = connection.busy_timeout(Duration::from_millis(100));
        let Ok(mut statement) = connection.prepare("SELECT id, title FROM threads WHERE title IS NOT NULL AND TRIM(title) <> ''") else { continue };
        let Ok(rows) = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else { continue };
        for (id, title) in rows.flatten() {
            if !id.trim().is_empty() && !title.trim().is_empty() { titles.entry(id).or_insert_with(|| title.trim().to_owned()); }
        }
    }
    if let Ok(file) = File::open(root.join("session_index.jsonl")) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
            let (Some(id), Some(title)) = (value["id"].as_str().filter(|v| !v.trim().is_empty()), value["thread_name"].as_str().filter(|v| !v.trim().is_empty())) else { continue };
            titles.insert(id.to_owned(), title.trim().to_owned());
        }
    }
    titles
}

fn source_file_matches(path: &Path, source: ConversationSource) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if normalized.contains("/subagents/")
        || normalized.contains("/tool-results/")
        || normalized.contains("/agents/")
    {
        return false;
    }
    match source.provider {
        "gemini" => path.parent().and_then(|parent| parent.file_name()).is_some_and(|name| name == "chats")
            && matches!(path.extension().and_then(|extension| extension.to_str()), Some("json" | "jsonl")),
        "kimi" => path.file_name().and_then(|name| name.to_str()) == Some("state.json"),
        "grok" => path.file_name().and_then(|name| name.to_str()) == Some("summary.json"),
        _ => path.extension().and_then(|extension| extension.to_str()) == Some("jsonl"),
    }
}

fn source_for_path(path: &Path) -> Option<ConversationSource> {
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    for (root, source) in session_roots(&user_home()?) {
        if path.starts_with(&root) && (source.provider == "dsh" || source_file_matches(path, source)) { return Some(source); }
    }
    if normalized.contains("/.gemini/tmp/") && source_file_matches(path, ConversationSource { provider: "gemini" }) {
        return Some(ConversationSource { provider: "gemini" });
    }
    if normalized.contains("/.claude/projects/") && normalized.ends_with(".jsonl") {
        return Some(ConversationSource {
            provider: "claude",
        });
    }
    if normalized.contains("/.codex/sessions/") && normalized.ends_with(".jsonl") {
        return Some(ConversationSource {
            provider: "codex",
        });
    }
    if normalized.contains("/.kimi-code/sessions/") && normalized.ends_with("/state.json") {
        return Some(ConversationSource {
            provider: "kimi",
        });
    }
    if normalized.contains("/.grok/sessions/") && normalized.ends_with("/summary.json") {
        return Some(ConversationSource {
            provider: "grok",
        });
    }
    if normalized.contains("/.codebuddy/projects/") && normalized.ends_with(".jsonl") {
        return Some(ConversationSource {
            provider: "codebuddy",
        });
    }
    None
}

fn parse_conversation(
    path: &Path,
    source: ConversationSource,
    include_all_messages: bool,
) -> anyhow::Result<Option<ParsedConversation>> {
    match source.provider {
        "dsh" => return parse_dsh_conversation(path),
        "gemini" => return parse_gemini_conversation(path),
        "kimi" => return parse_kimi_conversation(path, include_all_messages),
        "grok" => return parse_grok_conversation(path, include_all_messages),
        _ => {}
    }
    let file =
        File::open(path).with_context(|| format!("读取 CLI 会话失败：{}", path.display()))?;
    parse_conversation_lines(BufReader::new(file), source, include_all_messages)
}


pub(crate) fn dsh_records(path: &Path) -> anyhow::Result<Vec<Value>> {
    use std::io::Read;
    const MAX: u64 = 128 * 1024 * 1024;
    let bytes = fs::read(path)?;
    if bytes.len() as u64 > MAX { anyhow::bail!("DSH 会话过大"); }
    let mut output = Vec::new();
    if path.extension().is_some_and(|x| x == "zstd") {
        let mut offset = 0;
        while offset < bytes.len() {
            let frame = &bytes[offset..];
            let size = match zstd::zstd_safe::find_frame_compressed_size(frame) {
                Ok(size) => size,
                Err(_) if frame.len() < 4 || frame.starts_with(&[0x28,0xb5,0x2f,0xfd]) => break,
                Err(_) => anyhow::bail!("DSH 压缩帧损坏"),
            };
            zstd::stream::read::Decoder::new(&frame[..size])?.take(MAX + 1 - output.len() as u64).read_to_end(&mut output)?;
            if output.len() as u64 > MAX { anyhow::bail!("DSH 会话过大"); }
            offset += size;
        }
    } else { output = bytes; }
    Ok(output.split_inclusive(|b| *b == b'\n').filter(|line| line.ends_with(b"\n")).filter_map(|line| serde_json::from_slice(line).ok()).collect())
}

fn parse_dsh_conversation(path: &Path) -> anyhow::Result<Option<ParsedConversation>> {
    let records = dsh_records(path)?;
    let Some(header) = records.first().filter(|v| matches!(v["type"].as_str(), Some("session" | "header"))) else { return Ok(None) };
    let mut parsed = ParsedConversation { native_session_id: header["id"].as_str().map(str::to_owned), cwd: header["cwd"].as_str().unwrap_or_default().to_owned(), created_at: timestamp_value(header.get("createdAt")).unwrap_or_default(), ..Default::default() };
    let mut seen = HashSet::new();
    for record in records.iter().skip(1) {
        if record["surfaceOp"]["op"] == "replace" { continue; }
        let (raw, role) = match record["type"].as_str() {
            Some("user/message") => (&record["data"], "user"),
            Some("assistant/message") => (&record["data"]["message"], "assistant"),
            _ => continue,
        };
        if role == "user" && raw["source"]["kind"].as_str().is_some_and(|k| k != "user") { continue; }
        if let Some(id) = raw["id"].as_str() { if !seen.insert(id.to_owned()) { continue; } }
        if let Some(content) = extract_text(raw.get("content")) { parsed.remember_message(role, content, timestamp_value(record.get("time")).unwrap_or_default()); }
    }
    Ok((parsed.native_session_id.is_some() && !parsed.cwd.is_empty()).then_some(parsed))
}

fn parse_gemini_conversation(path: &Path) -> anyhow::Result<Option<ParsedConversation>> {
    let cwd = path.parent().and_then(Path::parent)
        .and_then(|directory| fs::read_to_string(directory.join(".project_root")).ok()).unwrap_or_default();
    let mut parsed = ParsedConversation { cwd: cwd.trim().to_owned(), ..Default::default() };
    let stream = serde_json::Deserializer::from_reader(BufReader::new(File::open(path)?)).into_iter::<Value>();
    for value in stream {
        // An active JSON/JSONL file can end in a partial write. Keep complete records.
        let Ok(value) = value else { break };
        if let Some(id) = value["sessionId"].as_str() { parsed.native_session_id = Some(id.to_owned()); }
        if let Some(title) = value["summary"].as_str() { parsed.title = title.to_owned(); }
        let entries = value["messages"].as_array().cloned().unwrap_or_else(|| vec![value]);
        for entry in entries {
            let role = match entry["type"].as_str() {
                Some("user") => "user",
                Some("gemini" | "assistant") => "assistant",
                _ => continue,
            };
            if let Some(content) = extract_text(entry.get("content")) {
                let at = record_timestamp(&entry, parsed.messages.len());
                parsed.remember_message(role, content, at);
            }
        }
    }
    Ok((!parsed.cwd.is_empty() && parsed.native_session_id.is_some()).then_some(parsed))
}

fn parse_kimi_conversation(
    path: &Path,
    include_all_messages: bool,
) -> anyhow::Result<Option<ParsedConversation>> {
    let Ok(state) = read_json_file(path) else {
        return Ok(None);
    };
    let mut parsed = ParsedConversation {
        cwd: state
            .get("workDir")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        native_session_id: kimi_session_id_from_state_path(path),
        created_at: timestamp_value(state.get("createdAt")).unwrap_or_default(),
        updated_at: timestamp_value(state.get("updatedAt")).unwrap_or_default(),
        title: state
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        messages: Vec::new(),
    };

    let wire_path = path
        .parent()
        .map(|directory| directory.join("agents").join("main").join("wire.jsonl"));
    if let Some(wire_path) = wire_path.filter(|wire_path| wire_path.is_file()) {
        let file = File::open(&wire_path)
            .with_context(|| format!("读取 Kimi 会话失败：{}", wire_path.display()))?;
        parse_kimi_lines(BufReader::new(file), &mut parsed, include_all_messages)?;
    }

    if !parsed.messages.iter().any(|message| message.role == "user") {
        if let Some(last_prompt) = state.get("lastPrompt").and_then(Value::as_str) {
            parsed.remember_message("user", last_prompt.to_string(), parsed.updated_at.clone());
        }
    }
    Ok((!parsed.cwd.is_empty()).then_some(parsed))
}

fn parse_kimi_lines<R: BufRead>(
    reader: R,
    parsed: &mut ParsedConversation,
    include_all_messages: bool,
) -> anyhow::Result<()> {
    let mut assistant_message_indexes = HashMap::new();
    read_jsonl_records(reader, |value, index| {
        parse_kimi_record(&value, parsed, index, &mut assistant_message_indexes);
        !include_all_messages && index >= SUMMARY_SCAN_LINE_LIMIT
    })
}

fn parse_kimi_record(
    value: &Value,
    parsed: &mut ParsedConversation,
    index: usize,
    assistant_message_indexes: &mut HashMap<String, usize>,
) {
    let record_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let timestamp = record_timestamp(value, index);
    match record_type {
        "turn.prompt" => {
            if let Some(content) = extract_text(value.get("input")) {
                parsed.remember_message("user", content, timestamp);
            }
        }
        "context.append_message" => {
            let message = value.get("message").unwrap_or(&Value::Null);
            if message.get("role").and_then(Value::as_str) == Some("user") {
                if let Some(content) = extract_text(message.get("content")) {
                    parsed.remember_message("user", content, timestamp);
                }
            }
        }
        "context.append_loop_event" => {
            let event = value.get("event").unwrap_or(&Value::Null);
            if event.get("type").and_then(Value::as_str) != Some("content.part") {
                return;
            }
            let part = event.get("part").unwrap_or(&Value::Null);
            if part.get("type").and_then(Value::as_str) != Some("text") {
                return;
            }
            let Some(content) = part.get("text").and_then(Value::as_str) else {
                return;
            };
            let turn_id = event
                .get("turnId")
                .and_then(value_as_string)
                .unwrap_or_else(|| format!("record-{index}"));
            remember_kimi_assistant_fragment(
                parsed,
                assistant_message_indexes,
                &turn_id,
                content,
                timestamp,
            );
        }
        _ => {}
    }
}

fn remember_kimi_assistant_fragment(
    parsed: &mut ParsedConversation,
    assistant_message_indexes: &mut HashMap<String, usize>,
    turn_id: &str,
    content: &str,
    timestamp: String,
) {
    let content = normalize_message_content(content);
    if content.is_empty() {
        return;
    }
    if let Some(index) = assistant_message_indexes.get(turn_id).copied() {
        parsed.messages[index].content.push_str(&content);
        return;
    }
    let index = parsed.messages.len();
    parsed.remember_message("assistant", content, timestamp);
    if parsed.messages.len() > index {
        assistant_message_indexes.insert(turn_id.to_string(), index);
    }
}

fn parse_grok_conversation(
    path: &Path,
    include_all_messages: bool,
) -> anyhow::Result<Option<ParsedConversation>> {
    let Ok(summary) = read_json_file(path) else {
        return Ok(None);
    };
    let mut parsed = ParsedConversation {
        native_session_id: summary
            .pointer("/info/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(ToString::to_string)
            .or_else(|| grok_session_id_from_summary_path(path)),
        cwd: summary
            .get("git_root_dir")
            .and_then(Value::as_str)
            .filter(|cwd| !cwd.is_empty())
            .or_else(|| summary.pointer("/info/cwd").and_then(Value::as_str))
            .map(ToString::to_string)
            .unwrap_or_else(|| grok_workspace_from_summary_path(path)),
        created_at: timestamp_value(summary.get("created_at")).unwrap_or_default(),
        updated_at: timestamp_value(summary.get("updated_at")).unwrap_or_default(),
        title: summary
            .get("generated_title")
            .or_else(|| summary.get("session_summary"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        messages: Vec::new(),
    };
    let history_path = path
        .parent()
        .map(|directory| directory.join("chat_history.jsonl"));
    if let Some(history_path) = history_path.filter(|history_path| history_path.is_file()) {
        let file = File::open(&history_path)
            .with_context(|| format!("读取 Grok 会话失败：{}", history_path.display()))?;
        parse_grok_lines(BufReader::new(file), &mut parsed, include_all_messages)?;
    }
    if !parsed
        .messages
        .iter()
        .any(|message| message.role == "assistant")
    {
        if let Some(last_turn_summary) = summary.get("last_turn_summary").and_then(Value::as_str) {
            parsed.remember_message(
                "assistant",
                last_turn_summary.to_string(),
                parsed.updated_at.clone(),
            );
        }
    }
    Ok((!parsed.cwd.is_empty()).then_some(parsed))
}

fn parse_grok_lines<R: BufRead>(
    reader: R,
    parsed: &mut ParsedConversation,
    include_all_messages: bool,
) -> anyhow::Result<()> {
    read_jsonl_records(reader, |value, index| {
        let role = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(role, "user" | "assistant") {
            if let Some(content) = extract_text(value.get("content")) {
                parsed.remember_message(role, content, record_timestamp(&value, index));
            }
        }
        !include_all_messages && index >= SUMMARY_SCAN_LINE_LIMIT
    })
}

fn read_json_file(path: &Path) -> anyhow::Result<Value> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("读取原生 CLI 会话失败：{}", path.display()))?;
    serde_json::from_str(&content)
        .with_context(|| format!("解析原生 CLI 会话失败：{}", path.display()))
}

fn kimi_session_id_from_state_path(path: &Path) -> Option<String> {
    path.parent()?
        .file_name()?
        .to_str()
        .filter(|id| id.starts_with("session_") && id.len() > "session_".len())
        .map(ToString::to_string)
}

fn grok_session_id_from_summary_path(path: &Path) -> Option<String> {
    path.parent()?
        .file_name()?
        .to_str()
        .filter(|id| !id.is_empty())
        .map(ToString::to_string)
}

fn grok_workspace_from_summary_path(path: &Path) -> String {
    let Some(encoded_workspace) = path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
    else {
        return String::new();
    };
    percent_decode_path(encoded_workspace)
}

fn percent_decode_path(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

const OPENCODE_SOURCE_PREFIX: &str = "opencode://";

struct OpenCodeSession {
    id: String,
    directory: String,
    title: String,
    created_at: i64,
    updated_at: i64,
}

struct OpenCodeMessageParts {
    role: String,
    timestamp: String,
    parts: Vec<String>,
}

fn list_opencode_workspace_conversations(
    workspace_path: &Path,
    home: &Path,
) -> anyhow::Result<Vec<CliNativeConversationSummary>> {
    let database_path = opencode_database_path(home);
    let Some(connection) = open_opencode_database(&database_path)? else {
        return Ok(Vec::new());
    };
    let metadata = fs::metadata(&database_path).ok();
    let mut conversations = Vec::new();
    for session in opencode_sessions(&connection)? {
        if !workspace_cwd_matches(&session.directory, workspace_path) {
            continue;
        }
        let mut parsed = parsed_opencode_session(&session);
        parsed.messages = read_opencode_messages(&connection, &session.id)?;
        let mut summary = build_summary(
            &database_path,
            ConversationSource {
                provider: "opencode",
            },
            parsed,
            metadata.as_ref(),
        );
        summary.source_path = opencode_source_path(&session.id);
        conversations.push(summary);
    }
    Ok(conversations)
}

fn read_opencode_workspace_conversation(
    workspace_path: &Path,
    home: &Path,
    session_id: &str,
) -> anyhow::Result<CliNativeConversationDetail> {
    let database_path = opencode_database_path(home);
    let connection =
        open_opencode_database(&database_path)?.context("没有找到 OpenCode 本地会话数据库")?;
    let session =
        opencode_session_by_id(&connection, session_id)?.context("没有找到 OpenCode 原生会话")?;
    if !workspace_cwd_matches(&session.directory, workspace_path) {
        anyhow::bail!("该 OpenCode 原生会话不属于当前工作区");
    }
    let mut parsed = parsed_opencode_session(&session);
    parsed.messages = read_opencode_messages(&connection, &session.id)?;
    let metadata = fs::metadata(&database_path).ok();
    let messages = parsed.messages.clone();
    let mut summary = build_summary(
        &database_path,
        ConversationSource {
            provider: "opencode",
        },
        parsed,
        metadata.as_ref(),
    );
    summary.source_path = opencode_source_path(&session.id);
    Ok(CliNativeConversationDetail { summary, messages })
}

fn opencode_storage(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share")).join("opencode/storage")
}

fn legacy_opencode_summaries(home: &Path) -> Vec<CliNativeConversationSummary> {
    let storage = opencode_storage(home);
    WalkDir::new(storage.join("session")).max_depth(2).follow_links(false).into_iter().filter_map(Result::ok).filter(|e| e.file_type().is_file() && e.path().extension().is_some_and(|x| x == "json")).filter_map(|entry| {
        let value: Value = serde_json::from_slice(&fs::read(entry.path()).ok()?).ok()?;
        let id = value["id"].as_str()?.to_owned();
        if id.is_empty() || id.contains(['/', '\\']) { return None; }
        let parsed = ParsedConversation { native_session_id: Some(id.clone()), cwd: value["directory"].as_str()?.to_owned(), title: value["title"].as_str().unwrap_or_default().to_owned(), created_at: timestamp_value(value.pointer("/time/created")).unwrap_or_default(), updated_at: timestamp_value(value.pointer("/time/updated")).unwrap_or_default(), ..Default::default() };
        let mut summary = build_summary(entry.path(), ConversationSource { provider: "opencode" }, parsed, entry.metadata().ok().as_ref());
        summary.source_path = format!("opencode-legacy://{id}");
        Some(summary)
    }).collect()
}

fn read_legacy_opencode(workspace: &Path, home: &Path, id: &str) -> anyhow::Result<CliNativeConversationDetail> {
    if id.is_empty() || id.contains(['/', '\\']) { anyhow::bail!("无效的 OpenCode 会话 ID"); }
    let summary = legacy_opencode_summaries(home).into_iter().find(|s| s.native_session_id.as_deref() == Some(id) && workspace_cwd_matches(&s.cwd, workspace)).context("没有找到属于当前工作区的 OpenCode 会话")?;
    let storage = opencode_storage(home);
    let mut files: Vec<_> = fs::read_dir(storage.join("message").join(id)).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.path()).collect();
    files.sort();
    let mut parsed = ParsedConversation::default();
    for file in files {
        let Ok(data) = fs::read(&file) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&data) else { continue };
        let Some(role @ ("user" | "assistant")) = value["role"].as_str() else { continue };
        let Some(msg_id) = value["id"].as_str().filter(|id| !id.contains(['/', '\\'])) else { continue };
        let mut parts: Vec<_> = fs::read_dir(storage.join("part").join(msg_id)).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.path()).collect();
        parts.sort();
        let text = parts.into_iter().filter_map(|path| serde_json::from_slice::<Value>(&fs::read(path).ok()?).ok()).filter(|part| part["type"] == "text").filter_map(|part| part["text"].as_str().map(str::to_owned)).collect::<Vec<_>>().join("\n");
        parsed.remember_message(role, text, timestamp_value(value.pointer("/time/created")).unwrap_or_default());
    }
    Ok(CliNativeConversationDetail { summary, messages: parsed.messages })
}

pub(crate) struct OpenCodeChatMessage {
    pub id: String,
    pub role: String,
    pub timestamp: i64,
    pub parts: Vec<Value>,
    pub usage: Value,
}

pub(crate) fn read_opencode_live_chat(workspace: &Path, source: &str, limit: usize, completed_at: Option<i64>) -> anyhow::Result<crate::cli_chat::ChatTranscript> {
    let home = user_home().context("无法确定 OpenCode 数据目录")?;
    let id = opencode_session_id_from_source_path(source).context("无效的 OpenCode 会话")?;
    let connection = open_opencode_database(&opencode_database_path(&home))?.context("没有找到 OpenCode 数据库")?;
    let session = opencode_session_by_id(&connection, id)?.context("没有找到 OpenCode 会话")?;
    if !workspace_cwd_matches(&session.directory, workspace) { anyhow::bail!("该 OpenCode 会话不属于当前工作区"); }
    Ok(crate::cli_chat::opencode_live_transcript(opencode_sqlite_chat_records(&connection, id)?, limit, completed_at))
}

fn opencode_chat_records(home: &Path, source: &str) -> anyhow::Result<Vec<OpenCodeChatMessage>> {
    if let Some(id) = source.strip_prefix("opencode-legacy://") {
        return legacy_opencode_chat_records(home, id);
    }
    let id = opencode_session_id_from_source_path(source).context("无效的 OpenCode 会话")?;
    let connection = open_opencode_database(&opencode_database_path(home))?.context("没有找到 OpenCode 数据库")?;
    opencode_sqlite_chat_records(&connection, id)
}

fn opencode_sqlite_chat_records(connection: &Connection, session_id: &str) -> anyhow::Result<Vec<OpenCodeChatMessage>> {
    let v2 = connection.query_row("SELECT EXISTS(SELECT 1 FROM session_v2 WHERE id = ?1)", [session_id], |row| row.get::<_, bool>(0)).unwrap_or(false);
    let mut result = Vec::new();
    if v2 {
        let mut statement = connection.prepare("SELECT id, type, time_created, data FROM session_message WHERE session_id = ?1 ORDER BY seq, rowid")?;
        let rows = statement.query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?)))?;
        for (id, role, timestamp, raw) in rows.flatten() {
            if !matches!(role.as_str(), "user" | "assistant") { continue; }
            let Ok(value) = serde_json::from_str::<Value>(&raw) else { continue };
            let parts = if role == "user" && value["text"].is_string() { vec![serde_json::json!({"type":"text","text":value["text"]})] }
                else if let Some(parts) = value["content"].as_array() { parts.clone() }
                else if let Some(text) = value["content"].as_str().or_else(|| value["text"].as_str()) { vec![serde_json::json!({"type":"text","text":text})] }
                else { Vec::new() };
            result.push(OpenCodeChatMessage { id, role, timestamp, parts, usage: value });
        }
    } else {
        let mut statement = connection.prepare("SELECT m.id, m.time_created, m.data, p.data FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = ?1 ORDER BY m.time_created, m.id, p.time_created, p.id")?;
        let rows = statement.query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)))?;
        for (id, timestamp, raw, part) in rows.flatten() {
            if result.last().is_none_or(|message: &OpenCodeChatMessage| message.id != id) {
                let Ok(info) = serde_json::from_str::<Value>(&raw) else { continue };
                let Some(role @ ("user" | "assistant")) = info["role"].as_str() else { continue };
                result.push(OpenCodeChatMessage { id: id.clone(), role: role.to_owned(), timestamp, parts: Vec::new(), usage: info.clone() });
            }
            if let Some(message) = result.last_mut().filter(|m| m.id == id) {
                if let Some(part) = part.and_then(|p| serde_json::from_str::<Value>(&p).ok()) { message.parts.push(part); }
            }
        }
    }
    Ok(result)
}

fn legacy_opencode_chat_records(home: &Path, id: &str) -> anyhow::Result<Vec<OpenCodeChatMessage>> {
    if id.is_empty() || id.contains(['/', '\\']) { anyhow::bail!("无效的 OpenCode 会话 ID"); }
    let storage = opencode_storage(home);
    let mut messages = Vec::new();
    for entry in fs::read_dir(storage.join("message").join(id))?.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())) {
        let Ok(bytes) = fs::read(entry.path()) else { continue };
        let Ok(info) = serde_json::from_slice::<Value>(&bytes) else { continue };
        let Some(message_id) = info["id"].as_str().filter(|id| !id.is_empty() && !id.contains(['/', '\\'])) else { continue };
        let Some(role @ ("user" | "assistant")) = info["role"].as_str() else { continue };
        let timestamp = info.pointer("/time/created").and_then(Value::as_i64).unwrap_or_default();
        let mut files: Vec<_> = fs::read_dir(storage.join("part").join(message_id)).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.path()).collect();
        files.sort();
        let parts = files.into_iter().filter_map(|file| serde_json::from_slice(&fs::read(file).ok()?).ok()).collect();
        messages.push(OpenCodeChatMessage { id: message_id.to_owned(), role: role.to_owned(), timestamp, parts, usage: info.clone() });
    }
    messages.sort_by(|a,b| (a.timestamp, &a.id).cmp(&(b.timestamp, &b.id)));
    Ok(messages)
}

fn opencode_database_path(home: &Path) -> PathBuf {
    std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local").join("share"))
        .join("opencode")
        .join("opencode.db")
}

fn open_opencode_database(database_path: &Path) -> anyhow::Result<Option<Connection>> {
    if !database_path.is_file() {
        return Ok(None);
    }
    Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map(Some)
    .with_context(|| {
        format!(
            "无法读取 OpenCode 本地会话数据库：{}",
            database_path.display()
        )
    })
}

fn opencode_sessions(connection: &Connection) -> anyhow::Result<Vec<OpenCodeSession>> {
    let mut result = Vec::new();
    let mut ids = HashSet::new();
    for table in ["session_v2", "session"] {
        let sql = format!("SELECT id, directory, COALESCE(title, ''), time_created, time_updated FROM {table} ORDER BY time_updated DESC, id");
        let Ok(mut statement) = connection.prepare(&sql) else { continue };
        let Ok(rows) = statement.query_map([], |row| Ok(OpenCodeSession { id: row.get(0)?, directory: row.get(1)?, title: row.get(2)?, created_at: row.get(3)?, updated_at: row.get(4)? })) else { continue };
        for session in rows.flatten() { if ids.insert(session.id.clone()) { result.push(session); } }
    }
    Ok(result)
}

fn opencode_session_by_id(connection: &Connection, session_id: &str) -> anyhow::Result<Option<OpenCodeSession>> {
    Ok(opencode_sessions(connection)?.into_iter().find(|s| s.id == session_id))
}

fn parsed_opencode_session(session: &OpenCodeSession) -> ParsedConversation {
    ParsedConversation {
        native_session_id: Some(session.id.clone()),
        cwd: session.directory.clone(),
        created_at: timestamp_from_millis(session.created_at),
        updated_at: timestamp_from_millis(session.updated_at),
        title: session.title.clone(),
        messages: Vec::new(),
    }
}

fn read_opencode_messages(
    connection: &Connection,
    session_id: &str,
) -> anyhow::Result<Vec<CliNativeConversationMessage>> {
    let v2 = connection.query_row("SELECT EXISTS(SELECT 1 FROM session_v2 WHERE id = ?1)", [session_id], |row| row.get::<_, bool>(0)).unwrap_or(false);
    if v2 {
        let mut statement = connection.prepare("SELECT type, time_created, data FROM session_message WHERE session_id = ?1 ORDER BY seq, rowid")?;
        let rows = statement.query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)))?;
        let mut parsed = ParsedConversation::default();
        for (role, at, data) in rows.flatten() {
            if !matches!(role.as_str(), "user" | "assistant") { continue; }
            let Ok(value) = serde_json::from_str::<Value>(&data) else { continue };
            let text = value["text"].as_str().map(str::to_owned).or_else(|| extract_text(value.get("content"))).unwrap_or_default();
            parsed.remember_message(&role, text, timestamp_from_millis(at));
        }
        return Ok(parsed.messages);
    }
    let mut statement = connection
        .prepare(
            "SELECT m.id, m.time_created, m.data, p.data
             FROM message m
             LEFT JOIN part p ON p.message_id = m.id
             WHERE m.session_id = ?1
             ORDER BY m.time_created ASC, p.time_created ASC, p.id ASC",
        )
        .context("读取 OpenCode 对话内容失败")?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .context("读取 OpenCode 对话内容失败")?;

    let mut current_message_id = None;
    let mut current_message_index = None;
    let mut messages = Vec::<OpenCodeMessageParts>::new();
    for row in rows {
        let (message_id, created_at, message_data, part_data) =
            row.context("读取 OpenCode 对话内容失败")?;
        if current_message_id.as_deref() != Some(message_id.as_str()) {
            current_message_id = Some(message_id);
            current_message_index = serde_json::from_str::<Value>(&message_data)
                .ok()
                .and_then(|message| {
                    message
                        .get("role")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|role| matches!(role.as_str(), "user" | "assistant"))
                .map(|role| {
                    messages.push(OpenCodeMessageParts {
                        role,
                        timestamp: timestamp_from_millis(created_at),
                        parts: Vec::new(),
                    });
                    messages.len() - 1
                });
        }
        let Some(message_index) = current_message_index else {
            continue;
        };
        let Some(part_data) = part_data else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<Value>(&part_data) else {
            continue;
        };
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(text) = part.get("text").and_then(Value::as_str) {
            messages[message_index].parts.push(text.to_string());
        }
    }

    let mut parsed = ParsedConversation::default();
    for message in messages {
        parsed.remember_message(&message.role, message.parts.join("\n"), message.timestamp);
    }
    Ok(parsed.messages)
}

fn opencode_source_path(session_id: &str) -> String {
    format!("{OPENCODE_SOURCE_PREFIX}{session_id}")
}

fn opencode_session_id_from_source_path(source_path: &str) -> Option<&str> {
    source_path
        .strip_prefix(OPENCODE_SOURCE_PREFIX)
        .map(str::trim)
        .filter(|session_id| !session_id.is_empty())
}

fn parse_conversation_lines<R: BufRead>(
    reader: R,
    source: ConversationSource,
    include_all_messages: bool,
) -> anyhow::Result<Option<ParsedConversation>> {
    let mut parsed = ParsedConversation::default();
    read_jsonl_records(reader, |value, index| {
        match source.provider {
            "claude" => parse_claude_record(&value, &mut parsed, index),
            "codex" => parse_codex_record(&value, &mut parsed, index),
            "codebuddy" => parse_codebuddy_record(&value, &mut parsed, index),
            _ => {}
        }

        !include_all_messages
            && index >= SUMMARY_SCAN_LINE_LIMIT
            && !parsed.cwd.is_empty()
            && (!parsed.title.is_empty() || !parsed.messages.is_empty())
    })?;
    Ok((!parsed.cwd.is_empty()).then_some(parsed))
}

fn read_jsonl_records<R, F>(mut reader: R, mut parse_record: F) -> anyhow::Result<()>
where
    R: BufRead,
    F: FnMut(&Value, usize) -> bool,
{
    let mut buffer = Vec::new();
    let mut index = 0;
    loop {
        buffer.clear();
        if reader.read_until(b'\n', &mut buffer)? == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buffer);
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            if parse_record(&value, index) {
                break;
            }
        }
        index += 1;
    }
    Ok(())
}

fn parse_claude_record(value: &Value, parsed: &mut ParsedConversation, index: usize) {
    // 会话归属启动目录；Bash 进入子目录后记录里的 cwd 会跟着变，不能覆盖。
    if parsed.cwd.is_empty() {
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            parsed.cwd = cwd.to_string();
        }
    }
    if parsed.native_session_id.is_none() {
        parsed.native_session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    let record_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let role = value
        .pointer("/message/role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let timestamp = record_timestamp(value, index);
    if record_type == "user" && role == "user" && claude_is_human(value) {
        if let Some(content) = extract_text(value.pointer("/message/content")) {
            parsed.remember_message("user", content, timestamp);
        }
    } else if record_type == "assistant" && role == "assistant" {
        if let Some(content) = extract_text(value.pointer("/message/content")) {
            parsed.remember_message("assistant", content, timestamp);
        }
    }
}

fn parse_codex_record(value: &Value, parsed: &mut ParsedConversation, index: usize) {
    let record_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if record_type == "session_meta" {
        if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
            parsed.cwd = cwd.to_string();
        }
        if parsed.native_session_id.is_none() {
            parsed.native_session_id = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
        }
        if parsed.created_at.is_empty() {
            parsed.created_at = record_timestamp(value, index);
        }
        return;
    }
    if record_type != "response_item"
        || payload.get("type").and_then(Value::as_str) != Some("message")
    {
        return;
    }
    let role = payload
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(role, "user" | "assistant") {
        return;
    }
    if let Some(content) = extract_text(payload.get("content")) {
        parsed.remember_message(role, content, record_timestamp(value, index));
    }
}

/// CodeBuddy Code 每行一条扁平记录（`type: "message"` + 顶层 `role`/`content`），
/// 与 Claude Code 的 `message` 嵌套结构不同，因此单独解析。
fn parse_codebuddy_record(value: &Value, parsed: &mut ParsedConversation, index: usize) {
    if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
        parsed.cwd = cwd.to_string();
    }
    if parsed.native_session_id.is_none() {
        parsed.native_session_id = value
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return;
    }
    let role = value.get("role").and_then(Value::as_str).unwrap_or_default();
    if !matches!(role, "user" | "assistant") {
        return;
    }
    // 流式输出会先落盘未完成的助手记录，只保留 CLI 标记为完成的记录。
    if role == "assistant"
        && value
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| status != "completed")
    {
        return;
    }
    if let Some(content) = extract_text(value.get("content")) {
        parsed.remember_message(role, content, record_timestamp(value, index));
    }
}

fn claude_is_human(value: &Value) -> bool {
    value
        .pointer("/origin/kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "human")
        || value
            .get("promptSource")
            .and_then(Value::as_str)
            .is_some_and(|source| source == "typed")
        || value
            .pointer("/message/content")
            .is_some_and(Value::is_string)
}

fn extract_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    let items = value.as_array()?;
    if items
        .iter()
        .any(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))
    {
        return None;
    }
    let mut parts = Vec::new();
    for item in items {
        if let Some(text) = item
            .get("text")
            .or_else(|| item.get("output_text"))
            .or_else(|| item.get("input_text"))
            .and_then(Value::as_str)
        {
            parts.push(text);
        }
    }
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn value_as_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(ToString::to_string)
        .or_else(|| value.as_i64().map(|value| value.to_string()))
        .or_else(|| value.as_u64().map(|value| value.to_string()))
}

fn record_timestamp(value: &Value, index: usize) -> String {
    value
        .get("timestamp")
        .or_else(|| value.pointer("/data/timestamp"))
        .or_else(|| value.get("time"))
        .and_then(|timestamp| timestamp_value(Some(timestamp)))
        .unwrap_or_else(|| format!("{index:08}"))
}

fn timestamp_value(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(timestamp) = value.as_str().filter(|timestamp| !timestamp.is_empty()) {
        return Some(timestamp.to_string());
    }
    value
        .as_i64()
        .or_else(|| {
            value
                .as_u64()
                .and_then(|timestamp| i64::try_from(timestamp).ok())
        })
        .map(timestamp_from_millis)
        .filter(|timestamp| !timestamp.is_empty())
}

fn build_summary(
    path: &Path,
    source: ConversationSource,
    parsed: ParsedConversation,
    metadata: Option<&fs::Metadata>,
) -> CliNativeConversationSummary {
    let title = parsed.title_or_first_user(source.provider);
    let summary = parsed
        .messages
        .iter()
        .rev()
        .find(|message| message.role == "assistant")
        .or_else(|| {
            parsed
                .messages
                .iter()
                .find(|message| message.role == "user")
        })
        .map(|message| compact_text(&message.content, 180))
        .unwrap_or_else(|| "没有可显示的对话文本".to_string());
    let fallback_time = metadata
        .and_then(|metadata| metadata.modified().ok())
        .map(timestamp_from_system_time)
        .unwrap_or_default();
    let created_at = if parsed.created_at.is_empty() {
        parsed
            .messages
            .first()
            .map(|message| message.timestamp.clone())
            .filter(|timestamp| {
                !timestamp
                    .chars()
                    .all(|character| character.is_ascii_digit())
            })
            .unwrap_or_else(|| fallback_time.clone())
    } else {
        parsed.created_at.clone()
    };
    let updated_at = if parsed.updated_at.is_empty() {
        parsed
            .messages
            .last()
            .map(|message| message.timestamp.clone())
            .filter(|timestamp| {
                !timestamp
                    .chars()
                    .all(|character| character.is_ascii_digit())
            })
            .unwrap_or_else(|| fallback_time.clone())
    } else {
        parsed.updated_at.clone()
    };
    let native_session_id = parsed.native_session_id.or_else(|| file_session_id(path));
    let id = native_session_id
        .as_deref()
        .map(|id| format!("{}:{id}", source.provider))
        .unwrap_or_else(|| format!("{}:{}", source.provider, stable_path_id(path)));
    CliNativeConversationSummary {
        id,
        provider_kind: source.provider.to_string(),
        native_session_id: native_session_id.clone(),
        title,
        summary,
        cwd: parsed.cwd,
        created_at,
        updated_at,
        message_count: parsed.messages.len() as u32,
        source_path: display_path(path),
        resume_supported: source.provider != "dsh" && native_session_id.is_some(),
    }
}

fn build_detail(
    path: &Path,
    source: ConversationSource,
    parsed: ParsedConversation,
    metadata: Option<&fs::Metadata>,
) -> CliNativeConversationDetail {
    let summary = build_summary(
        path,
        source,
        ParsedConversation {
            native_session_id: parsed.native_session_id.clone(),
            cwd: parsed.cwd.clone(),
            created_at: parsed.created_at.clone(),
            updated_at: parsed.updated_at.clone(),
            title: parsed.title.clone(),
            messages: parsed.messages.clone(),
        },
        metadata,
    );
    CliNativeConversationDetail {
        summary,
        messages: parsed.messages,
    }
}

fn workspace_cwd_matches(cwd: &str, workspace_path: &Path) -> bool {
    let workspace = normalize_path_key(&workspace_path.to_string_lossy());
    !workspace.is_empty() && normalize_path_key(cwd) == workspace
}

fn normalize_path_key(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn normalize_message_content(value: &str) -> String {
    value.replace("\r\n", "\n").trim().to_string()
}

fn is_injected_prompt(value: &str) -> bool {
    let value = value.trim_start();
    value.starts_with("# AGENTS.md")
        || value.starts_with("<INSTRUCTIONS>")
        || value.starts_with("<environment_context>")
        || value.starts_with("<local-command")
        || value.starts_with("<command-name")
        || value.starts_with("<system-reminder")
}

fn compact_text(value: &str, limit: usize) -> String {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = value.chars();
    let compact = chars.by_ref().take(limit).collect::<String>();
    if chars.next().is_some() {
        format!("{compact}...")
    } else {
        compact
    }
}

fn file_session_id(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let name = name.strip_suffix(".jsonl")?;
    if name.is_empty() || name.starts_with("rollout-") {
        return None;
    }
    Some(name.to_string())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn timestamp_from_system_time(time: SystemTime) -> String {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn timestamp_from_millis(milliseconds: i64) -> String {
    if milliseconds <= 0 {
        return String::new();
    }
    let seconds = milliseconds.div_euclid(1_000);
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn stable_path_id(path: &Path) -> String {
    let mut hash = 14695981039346656037u64;
    for byte in display_path(path).as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("p-{hash:016x}")
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    #[test]
    fn opencode_all_storage_formats_preserve_reasoning_tool_inputs_and_outputs() {
        let parts = [serde_json::json!({"type":"reasoning","text":"inspect"}), serde_json::json!({"type":"tool","tool":"bash","callID":"c","state":{"status":"error","input":{"command":"ls"},"error":"failed"}}), serde_json::json!({"type":"text","text":"answer"})];
        let verify = |messages| {
            let chat = crate::cli_chat::parse_opencode_chat(messages, 40);
            assert_eq!(chat.turns.len(), 1);
            assert_eq!(chat.turns[0].prompt, "question");
            assert_eq!(chat.turns[0].steps[0].detail, "inspect");
            assert!(chat.turns[0].steps[1].detail.contains("ls"));
            assert_eq!(chat.turns[0].steps[1].output, "failed");
            assert_eq!(chat.turns[0].answer, "answer");
        };
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);").unwrap();
        for (id, role, time) in [("u", "user", 1), ("a", "assistant", 2)] {
            conn.execute("INSERT INTO message VALUES (?1,'v1',?2,?3)", rusqlite::params![id, time, serde_json::json!({"role":role}).to_string()]).unwrap();
        }
        conn.execute("INSERT INTO part VALUES ('p','u','v1',1,?1)", [serde_json::json!({"type":"text","text":"question"}).to_string()]).unwrap();
        for (i, part) in parts.iter().enumerate() { conn.execute("INSERT INTO part VALUES (?1,'a','v1',?2,?3)", rusqlite::params![format!("p{i}"),i as i64,part.to_string()]).unwrap(); }
        verify(opencode_sqlite_chat_records(&conn, "v1").unwrap());
        conn.execute("INSERT INTO session_v2 VALUES ('v2','D:/Demo','title',1,2)", []).unwrap();
        conn.execute("INSERT INTO session_message VALUES ('u','v2','user',1,?1,1,1)", [serde_json::json!({"text":"question"}).to_string()]).unwrap();
        conn.execute("INSERT INTO session_message VALUES ('a','v2','assistant',2,?1,2,2)", [serde_json::json!({"content":parts}).to_string()]).unwrap();
        verify(opencode_sqlite_chat_records(&conn, "v2").unwrap());
        let home = tempfile::tempdir().unwrap();
        let storage = opencode_storage(home.path());
        write(&storage.join("message/legacy/u.json"), &serde_json::json!({"id":"u","role":"user","time":{"created":1}}).to_string());
        write(&storage.join("message/legacy/a.json"), &serde_json::json!({"id":"a","role":"assistant","time":{"created":2}}).to_string());
        write(&storage.join("part/u/p.json"), &serde_json::json!({"type":"text","text":"question"}).to_string());
        for (i, part) in parts.iter().enumerate() { write(&storage.join(format!("part/a/{i}.json")), &part.to_string()); }
        verify(legacy_opencode_chat_records(home.path(), "legacy").unwrap());
    }

    #[test]
    fn reads_opencode_v2_and_legacy() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE session_v2 (id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER); INSERT INTO session_v2 VALUES ('ses_v2','D:/Demo','V2',1,2); INSERT INTO session_message VALUES ('m','ses_v2','user',1,'{\"text\":\"hello\"}',1,1);").unwrap();
        assert_eq!(opencode_sessions(&connection).unwrap().len(), 1);
        assert_eq!(read_opencode_messages(&connection, "ses_v2").unwrap()[0].content, "hello");
        let home = tempfile::tempdir().unwrap();
        let storage = opencode_storage(home.path());
        write(&storage.join("session/p/ses_old.json"), &serde_json::json!({"id":"ses_old","directory":"D:/Demo","title":"old"}).to_string());
        write(&storage.join("message/ses_old/m.json"), &serde_json::json!({"id":"m","role":"user"}).to_string());
        write(&storage.join("part/m/p.json"), &serde_json::json!({"type":"text","text":"legacy"}).to_string());
        let detail = read_legacy_opencode(Path::new("D:/Demo"), home.path(), "ses_old").unwrap();
        assert_eq!(detail.messages[0].content, "legacy");
    }

    #[test]
    fn dsh_history_selects_latest_and_preserves_steps() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".dsh/sessions/project/session");
        let old = dir.join("session.v1.jsonl");
        let file = dir.join("session.v2.jsonl.zstd");
        write(&old, "{}\n");
        let lines = [
            serde_json::json!({"type":"session","id":"abc","cwd":"D:/Demo","createdAt":1000}),
            serde_json::json!({"type":"user/message","time":1001,"data":{"id":"u","source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}),
            serde_json::json!({"type":"assistant/message","time":1002,"data":{"message":{"id":"a","content":[{"type":"thinking","text":"think"},{"type":"tool-call","name":"read","arguments":"{}"},{"type":"text","text":"done"}]}}}),
            serde_json::json!({"type":"assistant/message","surfaceOp":{"op":"replace"},"data":{"message":{"id":"replace","content":[{"type":"text","text":"hidden"}]}}})
        ].iter().map(|v| format!("{v}\n")).collect::<String>();
        std::fs::write(&file, zstd::stream::encode_all(lines.as_bytes(), 0).unwrap()).unwrap();
        let paths = collect_session_files(&home.path().join(".dsh/sessions"), ConversationSource { provider: "dsh" });
        assert_eq!(paths, vec![file.clone()]);
        let parsed = parse_dsh_conversation(&file).unwrap().unwrap();
        assert_eq!(parsed.messages.len(), 2);
        let transcript = crate::cli_chat::read_dsh_chat(&file, 40).unwrap();
        assert_eq!(transcript.turns[0].answer, "done");
        assert_eq!(transcript.turns[0].steps.len(), 2);
        assert!(!build_summary(&file, ConversationSource { provider: "dsh" }, parsed, None).resume_supported);
    }

    #[test]
    #[ignore = "本机原生会话只读 smoke test；显式运行"]
    fn real_global_history_read_only_smoke() {
        let entries = list_all_conversations(true).unwrap();
        for provider in ["claude", "codex", "dsh", "opencode"] {
            let matches: Vec<_> = entries.iter().filter(|e| e.provider_kind == provider).collect();
            println!("{provider}: {}", matches.len());
            if matches.is_empty() { println!("{provider}: unavailable"); continue; }
            let readable = matches.iter().any(|entry| historical_chat(Path::new(&entry.cwd), &entry.source_path, 40).is_ok_and(|chat| !chat.turns.is_empty()));
            assert!(readable, "{provider}: no readable nonempty transcript");
            println!("{provider}: transcript ok");
        }
    }

    #[test]
    fn gemini_chat_reads_native_json_and_jsonl_and_binds_restored_session() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".gemini/tmp/project");
        write(&project.join(".project_root"), "D:/Demo Files");
        let entry = |role: &str, text: &str| serde_json::json!({"type":role,"content":[{"text":text}],"timestamp":"2026-10-16T10:00:00Z"});
        let json_path = project.join("chats/session-first.json");
        write(&json_path, &serde_json::json!({"sessionId":"first","messages":[entry("user", "hello"),entry("gemini", "reply")]}).to_string());
        let jsonl_path = project.join("chats/session-second.jsonl");
        write(&jsonl_path, &format!("{}\n{}\n{{", serde_json::json!({"sessionId":"second","messages":[entry("user", "second")]}), entry("gemini", "stream")));
        let workspace = Path::new("D:/Demo Files");
        for (path, answer) in [(&json_path, "reply"), (&jsonl_path, "stream")] {
            let detail = read_workspace_conversation(workspace, &path.to_string_lossy()).unwrap();
            assert_eq!(detail.messages.len(), 2);
            assert_eq!(detail.messages[1].content, answer);
            assert!(read_workspace_conversation(Path::new("D:/Other"), &path.to_string_lossy()).is_err());
        }
        let source = completion_source_from_home(workspace, "gemini", Some("second"), SystemTime::now(), &HashSet::new(), home.path()).unwrap().unwrap();
        assert_eq!(Path::new(&source), jsonl_path);
        let excluded = HashSet::from([source]);
        assert!(completion_source_from_home(workspace, "gemini", Some("second"), SystemTime::now(), &excluded, home.path()).unwrap().is_none());
    }
    #[test]
    fn opencode_live_tools_stay_open_until_latest_stop_is_complete() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);").unwrap();
        let insert_message = |id: &str, at: i64, value: Value| { connection.execute("INSERT INTO message VALUES (?1,'s',?2,?3)", rusqlite::params![id,at,value.to_string()]).unwrap(); };
        let insert_part = |id: &str, msg: &str, at: i64, value: Value| { connection.execute("INSERT INTO part VALUES (?1,?2,'s',?3,?4)", rusqlite::params![id,msg,at,value.to_string()]).unwrap(); };
        insert_message("u1", 100, serde_json::json!({"role":"user"}));
        insert_part("p1", "u1", 100, serde_json::json!({"type":"text","text":"previous"}));
        insert_message("a1", 200, serde_json::json!({"role":"assistant","finish":"stop","time":{"completed":250}}));
        insert_part("p2", "a1", 200, serde_json::json!({"type":"text","text":"old answer"}));
        insert_message("u2", 300, serde_json::json!({"role":"user"}));
        insert_part("p3", "u2", 300, serde_json::json!({"type":"text","text":"next"}));
        insert_message("a2", 400, serde_json::json!({"role":"assistant","finish":"stop","time":{"completed":500}}));
        insert_part("p4", "a2", 400, serde_json::json!({"type":"reasoning","text":"thinking"}));
        insert_part("p5", "a2", 401, serde_json::json!({"type":"tool","tool":"bash","state":{"status":"running","input":{"command":"ls"}}}));
        insert_part("p6", "a2", 402, serde_json::json!({"type":"text","text":"answer"}));
        let records = || opencode_sqlite_chat_records(&connection, "s").unwrap();
        let completion = || opencode_completion_from_connection(&connection, "s").unwrap().map(|(_,at)| at);
        let pending = crate::cli_chat::opencode_live_transcript(records(), 40, completion());
        assert!(pending.turns[0].completed_at.is_some());
        assert!(pending.turns[1].completed_at.is_none());
        assert_eq!(pending.turns[1].answer, "answer");
        assert_eq!(pending.turns[1].steps[0].kind, "think");
        assert!(pending.turns[1].steps[1].detail.contains("ls"));
        connection.execute("UPDATE part SET data=?1 WHERE id='p5'", [serde_json::json!({"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"ls"},"output":"done"}}).to_string()]).unwrap();
        let done = crate::cli_chat::opencode_live_transcript(records(), 40, completion());
        assert_eq!(done.turns[1].completed_at, Some(500));
        assert_eq!(done.turns[1].steps[1].output, "done");
        insert_message("a3", 600, serde_json::json!({"role":"assistant","finish":"tool-calls"}));
        assert!(completion().is_none(), "newer unfinished assistant supersedes earlier stop");
    }

    #[test]
    fn opencode_completion_waits_for_non_provider_tools() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(message_id TEXT, data TEXT);").unwrap();
        connection.execute("INSERT INTO message VALUES ('reply', 'session', 1, ?1)", [r#"{"role":"assistant","finish":"stop","time":{"completed":1234}}"#]).unwrap();
        connection.execute("INSERT INTO part VALUES ('reply', ?1)", [r#"{"type":"tool","state":{"status":"running"}}"#]).unwrap();
        assert!(opencode_completion_from_connection(&connection, "session").unwrap().is_none());
        connection.execute("UPDATE part SET data = ?1", [r#"{"type":"tool","state":{"status":"completed"}}"#]).unwrap();
        assert_eq!(opencode_completion_from_connection(&connection, "session").unwrap(), Some(("reply".into(),1234)));
        connection.execute("UPDATE message SET data = ?1", [r#"{"role":"assistant","finish":"tool-calls","time":{"completed":1234}}"#]).unwrap();
        assert!(opencode_completion_from_connection(&connection, "session").unwrap().is_none());
    }
    #[test]
    fn completion_sources_are_unique_and_restored_chats_remain_bound() {
        let home = tempfile::tempdir().unwrap();
        let workspace = Path::new(r"D:\Super High");
        // Allow filesystem timestamp granularity; the test targets source ownership.
        let started_at = SystemTime::now() - std::time::Duration::from_secs(1);
        let first = home.path().join(".codex/sessions/first.jsonl");
        let second = home.path().join(".codex/sessions/second.jsonl");
        write(&first, &serde_json::json!({"type":"session_meta","payload":{"id":"first","cwd":workspace.to_string_lossy()}}).to_string());
        write(&second, &serde_json::json!({"type":"session_meta","payload":{"id":"second","cwd":workspace.to_string_lossy()}}).to_string());
        let mut excluded = HashSet::new();
        let source1 = completion_source_from_home(workspace, "codex", None, started_at, &excluded, home.path()).unwrap().unwrap();
        excluded.insert(source1.clone());
        let source2 = completion_source_from_home(workspace, "codex", None, started_at, &excluded, home.path()).unwrap().unwrap();
        assert_ne!(source1, source2);
        excluded.insert(source2);
        assert!(completion_source_from_home(workspace, "codex", None, started_at, &excluded, home.path()).unwrap().is_none());
        assert!(completion_source_from_home(workspace, "codex", None, SystemTime::now() + std::time::Duration::from_secs(1), &HashSet::new(), home.path()).unwrap().is_none());
        // Releasing a PTY's claim makes exactly that native source available again.
        excluded.remove(&source1);
        let id = Path::new(&source1).file_stem().unwrap().to_str().unwrap();
        assert_eq!(completion_source_from_home(workspace, "codex", Some(id), SystemTime::now() + std::time::Duration::from_secs(10), &excluded, home.path()).unwrap(), Some(source1));
    }
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn codex_titles_use_native_index_and_read_only_state_with_fallback() {
        let home = TempDir::new().unwrap();
        let root = home.path().join("custom-codex-home");
        fs::create_dir_all(&root).unwrap();
        let conn = Connection::open(root.join("state_5.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE threads (id TEXT, title TEXT); INSERT INTO threads VALUES ('db-only','数据库标题'), ('both','旧数据库标题'), ('empty','');").unwrap();
        drop(conn);
        write(&root.join("session_index.jsonl"), "{\"id\":\"both\",\"thread_name\":\"第一次标题\"}\ninvalid\n{\"id\":\"both\",\"thread_name\":\"最新标题\"}\n{\"id\":\"empty\",\"thread_name\":\"\"}\n");
        let titles = load_codex_titles(&root);
        assert_eq!(titles.get("db-only").map(String::as_str), Some("数据库标题"));
        assert_eq!(titles.get("both").map(String::as_str), Some("最新标题"));
        assert!(!titles.contains_key("empty"));
        let make = |id: &str| CliNativeConversationSummary { id: format!("codex:{id}"), provider_kind: "codex".into(), native_session_id: Some(id.into()), title: "首条内容".into(), summary: String::new(), cwd: String::new(), created_at: String::new(), updated_at: String::new(), message_count: 0, source_path: String::new(), resume_supported: true };
        let mut summaries = vec![make("both"), make("db-only"), make("missing")];
        apply_codex_titles(&mut summaries, &titles);
        assert_eq!(summaries.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(), ["最新标题", "数据库标题", "首条内容"]);
        write(&root.join("session_index.jsonl"), "{\"id\":\"both\",\"thread_name\":\"修改后的标题\"}\n");
        apply_codex_titles(&mut summaries, &load_codex_titles(&root));
        assert_eq!(summaries[0].title, "修改后的标题");
    }

    #[test]
    fn completion_notice_uses_stored_title_and_exact_completed_turn() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\NoticeTest");
        let path = home.path().join(".codex/sessions/rollout.jsonl");
        let records = vec![
            serde_json::json!({"type":"session_meta","payload":{"id":"thread-1","cwd":workspace}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"# AGENTS.md instructions"}]}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"修复导出按钮"}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"text":"正在检查"}]}}),
            serde_json::json!({"type":"event_msg","timestamp":"2026-10-12T08:00:00Z","payload":{"type":"task_complete","turn_id":"turn-1","duration_ms":72328,"last_agent_message":"已修复导出按钮。测试通过。"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"task_started"}}),
            serde_json::json!({"type":"event_msg","payload":{"type":"user_message","message":"下一轮请求"}}),
        ];
        write(&path, &records.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"));
        write(&home.path().join(".codex/session_index.jsonl"), "{\"id\":\"thread-1\",\"thread_name\":\"旧名称\"}\n{\"id\":\"thread-1\",\"thread_name\":\"修复文件导出\"}\n");
        let notice = completion_notice("codex", path.to_str().unwrap(), "turn-1", 0, workspace).unwrap();
        assert_eq!(notice.title, "修复文件导出");
        assert_eq!(notice.task, "修复导出按钮");
        assert_eq!(notice.answer, "已修复导出按钮。测试通过。");
        assert_eq!(notice.conversation_id, "thread-1");
        assert_eq!(notice.duration_ms, Some(72328));
        assert!(completion_notice("codex", path.to_str().unwrap(), "turn-1", 0, Path::new(r"D:\Other")).unwrap().task.is_empty());
    }

    #[test]
    fn completion_notice_does_not_report_progress_as_final_answer() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\NoticeTest");
        let path = home.path().join(".codex/sessions/rollout.jsonl");
        let records = vec![
            serde_json::json!({"type":"session_meta","payload":{"id":"thread-1","cwd":workspace}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"检查打包问题"}]}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","phase":"commentary","content":[{"text":"正在打包"}]}}),
            serde_json::json!({"type":"event_msg","timestamp":"2026-10-12T08:00:00Z","payload":{"type":"task_complete","turn_id":"turn-1"}}),
        ];
        write(&path, &records.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"));
        let notice = completion_notice("codex", path.to_str().unwrap(), "turn-1", 0, workspace).unwrap();
        assert_eq!(notice.title, "检查打包问题");
        assert!(notice.answer.is_empty());
    }

    #[test]
    fn claude_completion_notice_keeps_launch_workspace_after_cd() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\NoticeTest");
        let path = home.path().join(".claude/projects/notice/session-1.jsonl");
        let records = vec![
            serde_json::json!({"type":"user","sessionId":"session-1","cwd":workspace,"timestamp":"2026-10-12T08:00:00Z","message":{"role":"user","content":"统计蒸馏进度"}}),
            serde_json::json!({"type":"assistant","sessionId":"session-1","cwd":r"D:\NoticeTest\skills\kit","timestamp":"2026-10-12T08:00:30Z","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"收录和笔记分开进行。"}]}}),
            serde_json::json!({"type":"system","subtype":"turn_duration","sessionId":"session-1","cwd":r"D:\NoticeTest\skills\kit","timestamp":"2026-10-12T08:00:31Z","uuid":"footer-1","durationMs":31000}),
        ];
        write(&path, &records.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n"));
        let notice = completion_notice("claude", path.to_str().unwrap(), "footer-1", 0, workspace).unwrap();
        assert_eq!(notice.title, "统计蒸馏进度");
        assert_eq!(notice.answer, "收录和笔记分开进行。");
        assert_eq!(notice.duration_ms, Some(31000));
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn write_bytes(path: &Path, content: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn prompt_cache_tracks_kimi_wire_without_state_file_changes() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let state = home
            .path()
            .join(".kimi-code/sessions/project/session/state.json");
        write(
            &state,
            &serde_json::json!({"workDir":workspace,"title":"Kimi"}).to_string(),
        );
        let wire = state.parent().unwrap().join("agents/main/wire.jsonl");
        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let record = |input: &str| {
            format!(
                "{}\n",
                serde_json::json!({"type":"turn.prompt","timestamp":now,"input":input})
            )
        };
        write(&wire, &record("首条"));
        let state_stamp = prompt_file_stamp(&state);
        let mut cache = PromptCache::default();
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .len(),
            1
        );
        let parses = cache.parses;
        write(&wire, &(record("首条") + &record("直接终端新增")));
        assert!(prompt_file_stamp(&state) == state_stamp);
        let messages =
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache).unwrap();
        assert_eq!(messages.len(), 2);
        assert!(messages
            .iter()
            .any(|message| message.content == "直接终端新增"));
        assert_eq!(cache.parses, parses + 1);
    }

    #[test]
    fn prompt_cache_reuses_parses_and_tracks_appends_new_files_deletes_and_workspace_switches() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let other = Path::new(r"D:\Other");
        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        let record = |content: &str| {
            serde_json::json!({"type":"response_item", "timestamp":now,
            "payload":{"type":"message","role":"user","content":[{"type":"input_text","text":content}]}}).to_string()
        };
        let transcript = |cwd: &Path, content: &str| {
            format!(
                "{}\n{}\n",
                serde_json::json!({"type":"session_meta","payload":{"cwd":cwd,"id":content}}),
                record(content)
            )
        };
        let current_file = home.path().join(".codex/sessions/rollout-current.jsonl");
        let other_file = home.path().join(".codex/sessions/rollout-other.jsonl");
        write(&current_file, &transcript(workspace, "首条"));
        write(&other_file, &transcript(other, "别的工作区"));
        let mut cache = PromptCache::default();
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(cache.parses, 3); // one target metadata/detail + one foreign metadata
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(cache.parses, 3);
        assert_eq!(
            workspace_prompt_messages_with_cache(other, home.path(), &mut cache).unwrap()[0]
                .content,
            "别的工作区"
        );
        assert_eq!(cache.parses, 4); // only lazily load this workspace's full transcript
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache).unwrap()[0]
                .content,
            "首条"
        );
        assert_eq!(cache.parses, 4);
        write(
            &current_file,
            &format!(
                "{}{}\n",
                transcript(workspace, "首条"),
                record("直接终端追加")
            ),
        );
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(cache.parses, 5); // changed known workspace is parsed only once
        let new_file = home.path().join(".codex/sessions/rollout-new.jsonl");
        write(&new_file, &transcript(workspace, "新会话"));
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .len(),
            3
        );
        assert_eq!(cache.parses, 7);
        fs::remove_file(&current_file).unwrap();
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .len(),
            1
        );
        assert!(!cache.entries.contains_key(&current_file));
        assert_eq!(cache.parses, 7);
    }

    #[test]
    fn prompt_cache_invalidates_auxiliary_file_changes_and_bounds_entries() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let project = home.path().join(".gemini/tmp/project");
        write(&project.join(".project_root"), "D:/Other");
        let now = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        write(
            &project.join("chats/session.json"),
            &serde_json::json!({"type":"user","content":"Gemini输入","timestamp":now}).to_string(),
        );
        let mut cache = PromptCache::default();
        assert!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .is_empty()
        );
        let count = cache.parses;
        assert!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache)
                .unwrap()
                .is_empty()
        );
        assert_eq!(cache.parses, count);
        write(&project.join(".project_root"), "D:/Demo Files");
        assert_eq!(
            workspace_prompt_messages_with_cache(workspace, home.path(), &mut cache).unwrap()[0]
                .content,
            "Gemini输入"
        );
        let mut seen = HashSet::new();
        for index in 0..PROMPT_CACHE_FILES + 1 {
            let key = home.path().join(format!("cache-{index}"));
            seen.insert(key.clone());
            cache.entries.insert(
                key,
                PromptCacheEntry {
                    stamps: Vec::new(),
                    cwd: String::new(),
                    messages: None,
                    touched: index as u64,
                },
            );
        }
        cache.finish(&seen, home.path());
        assert_eq!(cache.entries.len(), PROMPT_CACHE_FILES);
    }

    #[test]
    fn reads_direct_native_prompts_full_text_and_exact_workspace() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let now = time::OffsetDateTime::now_utc();
        let timestamp = |minutes| {
            (now - time::Duration::minutes(minutes))
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap()
        };
        let long = "完整提示词\n".repeat(1500);
        let user = |timestamp: &str| {
            serde_json::json!({ "type": "response_item", "timestamp": timestamp,
            "payload": { "type": "message", "role": "user", "content": [{"type": "input_text", "text": long}] } })
        };
        write(
            &home.path().join(".codex/sessions/rollout-direct.jsonl"),
            &format!(
                "{}\n{}\n{}\n",
                serde_json::json!({"type": "session_meta", "payload": {"id": "direct", "cwd": workspace}}),
                user(&timestamp(4)),
                user(&timestamp(3))
            ),
        );
        let gemini = home.path().join(".gemini/tmp/super-high");
        write(&gemini.join(".project_root"), "d:/demo files/\n");
        write(
            &gemini.join("chats/session-test.jsonl"),
            &format!(
                "{}\n{}\n",
                serde_json::json!({"sessionId":"gemini", "messages":[{"type":"user","content":"Gemini首条","timestamp":timestamp(2)}]}),
                serde_json::json!({"type":"user", "content":"Gemini直接输入", "timestamp":timestamp(1)})
            ),
        );
        let result = workspace_prompt_messages_from_home(workspace, home.path()).unwrap();
        assert_eq!(result.len(), 4);
        assert_eq!(
            result.iter().filter(|m| m.content == long.trim()).count(),
            2
        );
        assert!(result.iter().any(|m| m.content == "Gemini直接输入"));
        assert!(workspace_prompt_messages_from_home(
            Path::new(r"D:\Demo Files\child"),
            home.path()
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn lists_claude_and_codex_conversations_for_exact_workspace() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        write(
            &home
                .path()
                .join(".claude/projects/D--Super-High/claude-1.jsonl"),
            &format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "user", "sessionId": "claude-1", "cwd": workspace,
                    "timestamp": "2026-08-25T01:00:00Z", "origin": { "kind": "human" },
                    "message": { "role": "user", "content": "修复地图视图" }
                }),
                serde_json::json!({
                    "type": "assistant", "cwd": workspace, "timestamp": "2026-08-25T01:01:00Z",
                    "message": { "role": "assistant", "content": [{ "type": "text", "text": "已经定位入口。" }] }
                })
            ),
        );
        write(
            &home
                .path()
                .join(".codex/sessions/2026/08/25/rollout-codex.jsonl"),
            &format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session_meta", "payload": { "id": "codex-1", "cwd": workspace }
                }),
                serde_json::json!({
                    "type": "response_item", "timestamp": "2026-08-25T02:00:00Z",
                    "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "# AGENTS.md ignored" }] }
                })
            ),
        );
        write(
            &home
                .path()
                .join(".codex/sessions/2026/08/25/rollout-other.jsonl"),
            &serde_json::json!({
                "type": "session_meta", "payload": { "id": "codex-other", "cwd": r"D:\Other" }
            })
            .to_string(),
        );

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();

        assert_eq!(conversations.len(), 2);
        assert!(conversations
            .iter()
            .any(|item| item.id == "claude:claude-1"));
        let codex = conversations
            .iter()
            .find(|item| item.id == "codex:codex-1")
            .unwrap();
        assert_eq!(codex.title, "codex 会话");
        assert!(codex.resume_supported);
    }

    #[test]
    fn lists_codebuddy_conversations_and_skips_injected_records() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        write(
            &home
                .path()
                .join(".codebuddy/projects/D--Demo-Files/codebuddy-1.jsonl"),
            &format!(
                "{}\n{}\n{}\n{}\n{}\n",
                serde_json::json!({
                    "type": "message", "role": "user", "sessionId": "codebuddy-1", "cwd": workspace,
                    "timestamp": 1791568000000i64,
                    "content": [{ "type": "input_text", "text": "<command-name>/model</command-name>" }]
                }),
                serde_json::json!({
                    "type": "message", "role": "user", "sessionId": "codebuddy-1", "cwd": workspace,
                    "timestamp": 1791568001000i64,
                    "content": [{ "type": "input_text", "text": "给会话地图加上 CodeBuddy" }]
                }),
                serde_json::json!({
                    "type": "file-history-snapshot", "cwd": workspace, "timestamp": 1791568002000i64
                }),
                serde_json::json!({
                    "type": "message", "role": "assistant", "sessionId": "codebuddy-1", "cwd": workspace,
                    "status": "completed", "timestamp": 1791568003000i64,
                    "content": [{ "type": "output_text", "text": "已登记 provider。" }]
                }),
                serde_json::json!({
                    "type": "message", "role": "assistant", "sessionId": "codebuddy-1", "cwd": workspace,
                    "status": "streaming", "timestamp": 1791568004000i64,
                    "content": [{ "type": "output_text", "text": "半截回答" }]
                })
            ),
        );
        write(
            &home
                .path()
                .join(".codebuddy/projects/D--Other/codebuddy-other.jsonl"),
            &serde_json::json!({
                "type": "message", "role": "user", "sessionId": "codebuddy-other", "cwd": r"D:\Other",
                "timestamp": 1791568100000i64,
                "content": [{ "type": "input_text", "text": "别的项目" }]
            })
            .to_string(),
        );

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();

        assert_eq!(conversations.len(), 1);
        let conversation = conversations.first().unwrap();
        assert_eq!(conversation.id, "codebuddy:codebuddy-1");
        assert_eq!(conversation.title, "给会话地图加上 CodeBuddy");
        assert!(conversation.summary.contains("已登记 provider"));
        assert!(conversation.resume_supported);
    }

    #[test]
    fn skips_invalid_utf8_jsonl_records_and_keeps_later_conversations() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");

        let claude_path = home
            .path()
            .join(".claude/projects/D--Super-High/claude-valid.jsonl");
        let mut claude_content = vec![0xff, 0xfe, b'\n'];
        claude_content.extend_from_slice(
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "user", "sessionId": "claude-valid", "cwd": workspace,
                    "origin": { "kind": "human" },
                    "message": { "role": "user", "content": "Claude 有效记录" }
                })
            )
            .as_bytes(),
        );
        write_bytes(&claude_path, &claude_content);

        let codex_path = home
            .path()
            .join(".codex/sessions/2026/08/25/rollout-codex-valid.jsonl");
        let mut codex_content = vec![0xff, 0xfe, b'\n'];
        codex_content.extend_from_slice(
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": { "id": "codex-valid", "cwd": workspace }
                })
            )
            .as_bytes(),
        );
        codex_content.extend_from_slice(
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": "message", "role": "user",
                        "content": [{ "type": "input_text", "text": "Codex 有效记录" }]
                    }
                })
            )
            .as_bytes(),
        );
        write_bytes(&codex_path, &codex_content);

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();

        assert_eq!(conversations.len(), 2);
        assert!(conversations
            .iter()
            .any(|conversation| conversation.id == "claude:claude-valid"));
        assert!(conversations
            .iter()
            .any(|conversation| conversation.id == "codex:codex-valid"));
    }


    #[test]
    fn lists_and_reads_kimi_and_grok_conversations() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let kimi_state = home
            .path()
            .join(".kimi-code/sessions/wd_super-high/session_kimi-1/state.json");
        write(
            &kimi_state,
            &serde_json::json!({
                "createdAt": "2026-08-21T01:00:00Z",
                "updatedAt": "2026-08-21T01:02:00Z",
                "title": "Kimi 地图会话",
                "workDir": workspace,
            })
            .to_string(),
        );
        let kimi_wire = kimi_state.parent().unwrap().join("agents/main/wire.jsonl");
        write(
            &kimi_wire,
            &format!(
                "{}\n{}\n{}\n",
                serde_json::json!({
                    "type": "turn.prompt", "time": 1_787_040_000_000i64,
                    "input": [{ "type": "text", "text": "Kimi 用户问题" }]
                }),
                serde_json::json!({
                    "type": "context.append_loop_event", "time": 1_787_040_001_000i64,
                    "event": {
                        "type": "content.part", "turnId": "turn-1",
                        "part": { "type": "text", "text": "Kimi 回答" }
                    }
                }),
                serde_json::json!({
                    "type": "context.append_loop_event", "time": 1_787_040_002_000i64,
                    "event": {
                        "type": "content.part", "turnId": "turn-1",
                        "part": { "type": "text", "text": "续段" }
                    }
                })
            ),
        );

        let grok_summary = home
            .path()
            .join(".grok/sessions/D%3A%5CDemo%20Files/grok-1/summary.json");
        write(
            &grok_summary,
            &serde_json::json!({
                "info": { "id": "grok-1" },
                "generated_title": "Grok 地图会话",
                "created_at": "2026-08-22T01:00:00Z",
                "updated_at": "2026-08-22T01:02:00Z",
            })
            .to_string(),
        );
        write(
            &grok_summary.parent().unwrap().join("chat_history.jsonl"),
            &format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "user", "content": [{ "type": "text", "text": "Grok 用户问题" }]
                }),
                serde_json::json!({
                    "type": "assistant", "content": "Grok 回答"
                })
            ),
        );

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();
        assert_eq!(conversations.len(), 2);
        let kimi = conversations
            .iter()
            .find(|conversation| conversation.id == "kimi:session_kimi-1")
            .unwrap();
        assert_eq!(kimi.title, "Kimi 地图会话");
        assert_eq!(kimi.summary, "Kimi 回答续段");
        let kimi_detail =
            read_workspace_conversation_from_home(workspace, &kimi.source_path, home.path())
                .unwrap();
        assert_eq!(kimi_detail.messages.len(), 2);
        assert_eq!(kimi_detail.messages[1].content, "Kimi 回答续段");

        let grok = conversations
            .iter()
            .find(|conversation| conversation.id == "grok:grok-1")
            .unwrap();
        assert_eq!(grok.title, "Grok 地图会话");
        assert_eq!(grok.cwd, r"D:\Demo Files");
        let grok_detail =
            read_workspace_conversation_from_home(workspace, &grok.source_path, home.path())
                .unwrap();
        assert_eq!(grok_detail.messages[1].content, "Grok 回答");
    }

    #[test]
    fn lists_and_reads_opencode_conversations_from_its_database() {
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let database_path = opencode_database_path(home.path());
        fs::create_dir_all(database_path.parent().unwrap()).unwrap();
        let connection = Connection::open(&database_path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    directory TEXT NOT NULL,
                    title TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                );
                CREATE TABLE message (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL,
                    data TEXT NOT NULL
                );",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session (id, directory, title, time_created, time_updated)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "ses-map",
                    "D:/Demo Files",
                    "OpenCode 地图会话",
                    1_787_126_400_000i64,
                    1_787_126_402_000i64,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session (id, directory, title, time_created, time_updated)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "ses-other",
                    "D:/Other",
                    "其他项目",
                    1_787_126_400_000i64,
                    1_787_126_402_000i64,
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    "msg-user",
                    "ses-map",
                    1_787_126_400_000i64,
                    serde_json::json!({ "role": "user" }).to_string(),
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO message (id, session_id, time_created, data) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    "msg-assistant",
                    "ses-map",
                    1_787_126_401_000i64,
                    serde_json::json!({ "role": "assistant" }).to_string(),
                ],
            )
            .unwrap();
        for (id, message_id, time_created, text) in [
            (
                "part-user",
                "msg-user",
                1_787_126_400_000i64,
                "OpenCode 用户问题",
            ),
            (
                "part-answer",
                "msg-assistant",
                1_787_126_401_000i64,
                "OpenCode 回答",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO part (id, message_id, session_id, time_created, data)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        id,
                        message_id,
                        "ses-map",
                        time_created,
                        serde_json::json!({ "type": "text", "text": text }).to_string(),
                    ],
                )
                .unwrap();
        }
        drop(connection);

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();
        assert_eq!(conversations.len(), 1);
        let conversation = &conversations[0];
        assert_eq!(conversation.id, "opencode:ses-map");
        assert_eq!(conversation.source_path, "opencode://ses-map");
        assert_eq!(conversation.summary, "OpenCode 回答");
        assert!(conversation.resume_supported);

        let detail = read_workspace_conversation_from_home(
            workspace,
            &conversation.source_path,
            home.path(),
        )
        .unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].content, "OpenCode 用户问题");
        assert_eq!(detail.messages[1].content, "OpenCode 回答");
    }
}
