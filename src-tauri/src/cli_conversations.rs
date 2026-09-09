use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    CliNativeConversationDetail, CliNativeConversationMessage, CliNativeConversationSummary,
};

const SUMMARY_SCAN_LINE_LIMIT: usize = 360;

#[derive(Clone, Copy)]
struct ConversationSource {
    provider: &'static str,
    compressed: bool,
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
            let Some(parsed) = parse_conversation(&path, source, false)? else {
                continue;
            };
            if !workspace_cwd_matches(&parsed.cwd, workspace_path) {
                continue;
            }
            conversations.push(build_summary(&path, source, parsed, metadata.as_ref()));
        }
    }
    conversations.extend(list_opencode_workspace_conversations(workspace_path, home)?);
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
        (
            home.join(".claude").join("projects"),
            ConversationSource {
                provider: "claude",
                compressed: false,
            },
        ),
        (
            home.join(".codex").join("sessions"),
            ConversationSource {
                provider: "codex",
                compressed: false,
            },
        ),
        (
            home.join(".dsh").join("sessions"),
            ConversationSource {
                provider: "dsh",
                compressed: true,
            },
        ),
        (
            home.join(".kimi-code").join("sessions"),
            ConversationSource {
                provider: "kimi",
                compressed: false,
            },
        ),
        (
            home.join(".grok").join("sessions"),
            ConversationSource {
                provider: "grok",
                compressed: false,
            },
        ),
    ]
}

fn collect_session_files(root: &Path, source: ConversationSource) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
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
        "dsh" => normalized.ends_with(".jsonl.zstd"),
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
    if normalized.contains("/.claude/projects/") && normalized.ends_with(".jsonl") {
        return Some(ConversationSource {
            provider: "claude",
            compressed: false,
        });
    }
    if normalized.contains("/.codex/sessions/") && normalized.ends_with(".jsonl") {
        return Some(ConversationSource {
            provider: "codex",
            compressed: false,
        });
    }
    if normalized.contains("/.dsh/sessions/") && normalized.ends_with(".jsonl.zstd") {
        return Some(ConversationSource {
            provider: "dsh",
            compressed: true,
        });
    }
    if normalized.contains("/.kimi-code/sessions/") && normalized.ends_with("/state.json") {
        return Some(ConversationSource {
            provider: "kimi",
            compressed: false,
        });
    }
    if normalized.contains("/.grok/sessions/") && normalized.ends_with("/summary.json") {
        return Some(ConversationSource {
            provider: "grok",
            compressed: false,
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
        "kimi" => return parse_kimi_conversation(path, include_all_messages),
        "grok" => return parse_grok_conversation(path, include_all_messages),
        _ => {}
    }
    if source.compressed {
        let file =
            File::open(path).with_context(|| format!("读取 DSH 会话失败：{}", path.display()))?;
        let decoder = zstd::stream::read::Decoder::new(file)
            .with_context(|| format!("解压 DSH 会话失败：{}", path.display()))?;
        return parse_conversation_lines(BufReader::new(decoder), source, include_all_messages);
    }

    let file =
        File::open(path).with_context(|| format!("读取 CLI 会话失败：{}", path.display()))?;
    parse_conversation_lines(BufReader::new(file), source, include_all_messages)
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
                compressed: false,
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
            compressed: false,
        },
        parsed,
        metadata.as_ref(),
    );
    summary.source_path = opencode_source_path(&session.id);
    Ok(CliNativeConversationDetail { summary, messages })
}

fn opencode_database_path(home: &Path) -> PathBuf {
    home.join(".local")
        .join("share")
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
    let mut statement = connection
        .prepare(
            "SELECT id, directory, title, time_created, time_updated
             FROM session
             ORDER BY time_updated DESC, id",
        )
        .context("读取 OpenCode 会话列表失败")?;
    let rows = statement
        .query_map([], |row| {
            Ok(OpenCodeSession {
                id: row.get(0)?,
                directory: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .context("读取 OpenCode 会话列表失败")?;
    rows.collect::<Result<Vec<_>, _>>()
        .context("读取 OpenCode 会话列表失败")
}

fn opencode_session_by_id(
    connection: &Connection,
    session_id: &str,
) -> anyhow::Result<Option<OpenCodeSession>> {
    connection
        .query_row(
            "SELECT id, directory, title, time_created, time_updated
             FROM session
             WHERE id = ?1",
            [session_id],
            |row| {
                Ok(OpenCodeSession {
                    id: row.get(0)?,
                    directory: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .context("读取 OpenCode 原生会话失败")
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
            "dsh" => parse_dsh_record(&value, &mut parsed, index),
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

fn parse_dsh_record(value: &Value, parsed: &mut ParsedConversation, index: usize) {
    let record_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = value.get("data").unwrap_or(&Value::Null);
    if record_type == "session" {
        if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
            parsed.cwd = cwd.to_string();
        }
        if parsed.native_session_id.is_none() {
            parsed.native_session_id = value
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
        }
        if parsed.created_at.is_empty() {
            parsed.created_at = value
                .get("createdAt")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        return;
    }
    if record_type == "session/title" {
        parsed.title = data
            .get("title")
            .or_else(|| value.get("title"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        return;
    }
    let (role, content) = match record_type {
        "user/message" => (
            "user",
            extract_text(data.get("content")).or_else(|| extract_text(value.get("content"))),
        ),
        "assistant/message" => (
            "assistant",
            extract_text(data.pointer("/message/content"))
                .or_else(|| extract_text(data.get("content")))
                .or_else(|| extract_text(value.pointer("/message/content"))),
        ),
        _ => return,
    };
    if let Some(content) = content {
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
        resume_supported: native_session_id.is_some(),
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
    let name = name
        .strip_suffix(".jsonl.zstd")
        .or_else(|| name.strip_suffix(".jsonl"))?;
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
    use super::*;
    use crate::dsh_profiles::tests::ENV_LOCK;
    use tempfile::TempDir;

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
        write(&gemini.join(".project_root"), "d:/super high/\n");
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

        let dsh_path = home
            .path()
            .join(".dsh/sessions/--D-Super~0020High--/dsh-valid/session.jsonl.zstd");
        let mut dsh_content = vec![0xff, 0xfe, b'\n'];
        dsh_content.extend_from_slice(
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "session", "id": "dsh-valid", "cwd": workspace
                })
            )
            .as_bytes(),
        );
        dsh_content.extend_from_slice(
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "user/message",
                    "data": { "content": [{ "type": "text", "text": "DSH 有效记录" }] }
                })
            )
            .as_bytes(),
        );
        fs::create_dir_all(dsh_path.parent().unwrap()).unwrap();
        fs::write(
            &dsh_path,
            zstd::stream::encode_all(dsh_content.as_slice(), 0).unwrap(),
        )
        .unwrap();

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();

        assert_eq!(conversations.len(), 3);
        assert!(conversations
            .iter()
            .any(|conversation| conversation.id == "claude:claude-valid"));
        assert!(conversations
            .iter()
            .any(|conversation| conversation.id == "codex:codex-valid"));
        assert!(conversations
            .iter()
            .any(|conversation| conversation.id == "dsh:dsh-valid"));
    }

    #[test]
    fn reads_zstd_dsh_conversation_and_uses_saved_title() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = TempDir::new().unwrap();
        let workspace = Path::new(r"D:\Demo Files");
        let path = home
            .path()
            .join(".dsh/sessions/--D-Super~0020High--/dsh-1/session.jsonl.zstd");
        let content = format!(
            "{}\n{}\n{}\n",
            serde_json::json!({ "type": "session", "id": "dsh-1", "cwd": workspace, "createdAt": "2026-08-25T03:00:00Z" }),
            serde_json::json!({ "type": "session/title", "data": { "title": "地图模式设计" } }),
            serde_json::json!({ "type": "user/message", "data": { "content": [{ "type": "text", "text": "给地图加卡片" }] }, "timestamp": "2026-08-25T03:01:00Z" })
        );
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            zstd::stream::encode_all(content.as_bytes(), 0).unwrap(),
        )
        .unwrap();

        let conversations = list_workspace_conversations_from_home(workspace, home.path()).unwrap();
        assert_eq!(conversations.len(), 1);
        assert_eq!(conversations[0].title, "地图模式设计");
        assert_eq!(conversations[0].native_session_id.as_deref(), Some("dsh-1"));

        let detail = read_workspace_conversation(workspace, &display_path(&path)).unwrap();
        assert_eq!(detail.messages[0].content, "给地图加卡片");
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
            .join(".grok/sessions/D%3A%5CSuper%20High/grok-1/summary.json");
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
