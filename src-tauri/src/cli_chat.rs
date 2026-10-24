//! Chat mode reads the CLI's native log: tool calls become thinking steps, the final message the answer.
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, path::Path, sync::Mutex, time::SystemTime};
use serde::Serialize;
use serde_json::Value;

const MAX_TURNS: usize = 40;
const MAX_DETAIL: usize = 400;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTranscript {
    pub model: String,
    pub turns: Vec<ChatTurn>,
    pub agents: Vec<crate::codex_agents::ChatAgent>,
    pub agent_error: Option<String>,
    #[serde(skip)]
    pub agent_calls: HashMap<String, Value>,
    #[serde(skip)]
    pub agent_links: Vec<Value>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub id: String,
    #[serde(skip)]
    fingerprint: String,
    pub prompt: String,
    pub started_at: i64,
    pub steps: Vec<ChatStep>,
    pub answer: String,
    pub completed_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub interrupted: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStep {
    /// `think` reasoning summary, `tool` a CLI tool call, `text` interim assistant text.
    pub kind: &'static str,
    pub title: String,
    pub detail: String,
}

type Stamp = Option<(SystemTime, u64)>;

/// Reuse native history readers for providers whose storage is not Claude/Codex JSONL.
pub(crate) fn read_native_chat(workspace: &Path, source: &str, completed_at: Option<i64>) -> anyhow::Result<ChatTranscript> {
    let mut detail = crate::cli_conversations::read_workspace_conversation(workspace, source)?;
    // Some Grok/Kimi versions omit per-message timestamps. Keep a stable first-observed
    // start time instead of displaying a duration measured from the Unix epoch.
    static OBSERVED: std::sync::OnceLock<Mutex<HashMap<String, HashMap<String, i64>>>> = std::sync::OnceLock::new();
    let mut observed = OBSERVED.get_or_init(Default::default).lock().unwrap();
    if observed.len() > 32 { observed.clear(); }
    let times = observed.entry(source.to_owned()).or_default();
    let last_user = detail.messages.iter().rposition(|message| message.role == "user");
    let has_answer = last_user.is_some_and(|index| detail.messages[index + 1..].iter().any(|message| message.role == "assistant"));
    for message in &mut detail.messages {
        if message.role != "user" || time::OffsetDateTime::parse(&message.timestamp, &time::format_description::well_known::Rfc3339).is_ok() { continue; }
        let at = *times.entry(message.id.clone()).or_insert_with(|| {
            completed_at.filter(|_| has_answer).unwrap_or_else(|| crate::cli_completion::unix_millis(SystemTime::now()))
        });
        message.timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(at) * 1_000_000)?
            .format(&time::format_description::well_known::Rfc3339)?;
    }
    let ids: std::collections::HashSet<&str> = detail.messages.iter().map(|message| message.id.as_str()).collect();
    times.retain(|id, _| ids.contains(id.as_str()));
    drop(observed);
    Ok(from_native_messages(detail.messages, completed_at))
}

fn from_native_messages(messages: Vec<crate::models::CliNativeConversationMessage>, completed_at: Option<i64>) -> ChatTranscript {
    let mut transcript = ChatTranscript::default();
    for message in messages {
        let at = time::OffsetDateTime::parse(&message.timestamp, &time::format_description::well_known::Rfc3339)
            .ok().map(|at| (at.unix_timestamp_nanos() / 1_000_000) as i64).unwrap_or_default();
        if message.role == "user" {
            if let Some(turn) = transcript.turns.last_mut() {
                turn.completed_at = Some(at);
                turn.duration_ms = Some(at - turn.started_at).filter(|ms| *ms >= 0);
            }
            transcript.turns.push(ChatTurn { id: message.id, prompt: message.content, started_at: at, ..Default::default() });
        } else if message.role == "assistant" {
            if let Some(turn) = transcript.turns.last_mut() {
                if !turn.answer.is_empty() { turn.answer.push_str("\n\n"); }
                turn.answer.push_str(&message.content);
            }
        }
    }
    if let Some(turn) = transcript.turns.last_mut() {
        if let Some(at) = completed_at.filter(|at| *at >= turn.started_at && !turn.answer.is_empty()) {
            turn.completed_at = Some(at);
            turn.duration_ms = Some(at - turn.started_at);
        }
    }
    transcript
}

pub(crate) fn read_chat(provider: &str, source: &str) -> anyhow::Result<ChatTranscript> {
    let mut transcript = read_chat_window(provider, source, MAX_TURNS)?;
    let excess = transcript.turns.len().saturating_sub(MAX_TURNS);
    transcript.turns.drain(..excess);
    Ok(transcript)
}

/// Read backwards in growing blocks until there is one complete older turn.
/// The extra turn is a continuation marker; no fixed byte tail loses old history.
pub(crate) fn read_chat_window(provider: &str, source: &str, limit: usize) -> anyhow::Result<ChatTranscript> {
    static CACHE: std::sync::OnceLock<Mutex<HashMap<String, (Stamp, ChatTranscript)>>> = std::sync::OnceLock::new();
    let metadata = std::fs::metadata(source)?;
    let stamp = metadata.modified().ok().map(|modified| (modified, metadata.len()));
    let key = format!("{provider}\n{source}\n{limit}");
    if let Some((cached, transcript)) = CACHE.get_or_init(Default::default).lock().unwrap().get(&key) {
        if stamp.is_some() && *cached == stamp { return Ok(transcript.clone()); }
    }
    let mut file = File::open(Path::new(source))?;
    let mut size = 256 * 1024u64;
    let mut transcript = loop {
        let offset = metadata.len().saturating_sub(size);
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        let raw = String::from_utf8_lossy(&bytes);
        let mut lines = raw.lines();
        if offset > 0 { lines.next(); }
        let records = lines.filter_map(|line| serde_json::from_str::<Value>(line).ok());
        let parsed = match provider {
            "codex" => parse_codex(records, raw.contains("\"item_completed\"")),
            "claude" => parse_claude(records),
            _ => anyhow::bail!("{provider} 暂不支持聊天模式"),
        };
        // The first parsed turn may begin mid-turn. Require another older turn.
        if offset == 0 || parsed.turns.len() > limit.saturating_add(1) { break parsed; }
        size = size.saturating_mul(2);
    };
    let excess = transcript.turns.len().saturating_sub(limit.saturating_add(1));
    transcript.turns.drain(..excess);
    for turn in &mut transcript.turns { turn.fingerprint = turn_fingerprint(turn); }
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    // Replacing windows for one source avoids retaining 40, 80, 120... copies.
    let prefix = format!("{provider}\n{source}\n");
    cache.retain(|entry, _| !entry.starts_with(&prefix));
    if cache.len() >= 32 {
        if let Some(oldest) = cache.keys().next().cloned() { cache.remove(&oldest); }
    }
    cache.insert(key, (stamp, transcript.clone()));
    Ok(transcript)
}

fn timestamp_ms(value: &Value) -> Option<i64> {
    let text = value.get("timestamp")?.as_str()?;
    let time = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339).ok()?;
    Some((time.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn clip(text: &str, limit: usize) -> String {
    let text = text.trim();
    let mut chars = text.chars();
    let clipped: String = chars.by_ref().take(limit).collect();
    if chars.next().is_some() { format!("{clipped}…") } else { clipped }
}

fn step(kind: &'static str, title: impl Into<String>, detail: impl AsRef<str>) -> ChatStep {
    ChatStep { kind, title: title.into(), detail: clip(detail.as_ref(), MAX_DETAIL) }
}

fn open_turn<'a>(turns: &'a mut Vec<ChatTurn>, id: &str, started_at: i64) -> &'a mut ChatTurn {
    if turns.last().is_none_or(|turn| turn.completed_at.is_some()) {
        turns.push(ChatTurn { id: if id.is_empty() { format!("turn-{started_at}") } else { id.to_owned() }, started_at, ..Default::default() });
    }
    turns.last_mut().unwrap()
}

fn texts(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items.iter()
            .filter_map(|item| item.get("text").or_else(|| item.get("output_text")).or_else(|| item.get("input_text")).and_then(Value::as_str))
            .collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Shell wrappers (`pwsh -Command <script>`) are noise; show the script itself.
fn command_line(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
            match parts.iter().position(|part| matches!(part.to_ascii_lowercase().as_str(), "-command" | "-c" | "/c" | "-lc")) {
                Some(index) if index + 1 < parts.len() => parts[index + 1..].join(" "),
                _ => parts.join(" "),
            }
        }
        _ => String::new(),
    }
}

fn parse_codex(records: impl Iterator<Item = Value>, has_items: bool) -> ChatTranscript {
    let mut transcript = ChatTranscript::default();
    let turns = &mut transcript.turns;
    for value in records {
        let at = timestamp_ms(&value).unwrap_or_default();
        let payload = &value["payload"];
        if value["type"] == "response_item" && payload["type"] == "function_call" && payload["name"] == "spawn_agent" {
            if let (Some(id), Some(raw)) = (payload["call_id"].as_str(), payload["arguments"].as_str()) {
                if let Ok(mut call) = serde_json::from_str::<Value>(raw) {
                    call["turnId"] = Value::String(turns.last().map(|turn| turn.id.clone()).unwrap_or_default());
                    // V2 string messages are encrypted unless the function call explicitly
                    // declares plaintext. The encrypted payload is not a displayable task.
                    let v2 = payload["namespace"] == "collaboration" || call.get("task_name").is_some();
                    call["encrypted"] = Value::Bool(v2 && !payload["encrypted_function_args"].as_array().is_some_and(Vec::is_empty));
                    transcript.agent_calls.insert(id.into(), call);
                }
            }
        }
        if value["type"] == "event_msg" {
            if payload["type"] == "collab_agent_spawn_end" {
                transcript.agent_links.push(serde_json::json!({"turnId":turns.last().map(|t| &t.id),"callId":payload["call_id"],"id":payload["new_thread_id"]}));
            } else if payload["type"] == "sub_agent_activity" && payload["kind"] == "started" {
                transcript.agent_links.push(serde_json::json!({"turnId":turns.last().map(|t| &t.id),"callId":payload["event_id"],"id":payload["agent_thread_id"]}));
            } else if payload["type"] == "item_completed" && payload["item"]["type"] == "SubAgentActivity" && payload["item"]["kind"] == "started" {
                let item = &payload["item"];
                transcript.agent_links.push(serde_json::json!({"turnId":payload["turn_id"],"callId":item["id"],"id":item["agent_thread_id"]}));
            }
        }
        match (value["type"].as_str().unwrap_or_default(), payload["type"].as_str().unwrap_or_default()) {
            ("turn_context", _) => {
                let model = payload["model"].as_str().unwrap_or_default();
                let effort = payload.pointer("/collaboration_mode/settings/reasoning_effort").or_else(|| payload.get("effort")).and_then(Value::as_str).unwrap_or_default();
                if !model.is_empty() { transcript.model = format!("{model} {effort}").trim().to_owned(); }
            }
            ("event_msg", "task_started") => {
                if turns.last().is_some_and(|turn| turn.completed_at.is_none() && !turn.prompt.is_empty()) {
                    turns.last_mut().unwrap().completed_at = Some(at);
                }
                let started = payload["started_at"].as_i64().map_or(at, |seconds| seconds * 1000);
                open_turn(turns, payload["turn_id"].as_str().unwrap_or_default(), started);
            }
            ("event_msg", "item_completed") => {
                let item = &payload["item"];
                let turn = open_turn(turns, payload["turn_id"].as_str().unwrap_or_default(), at);
                match item["type"].as_str().unwrap_or_default() {
                    "UserMessage" => if turn.prompt.is_empty() { turn.prompt = texts(item.get("content")); },
                    "AgentMessage" => {
                        let text = texts(item.get("content"));
                        if item["phase"] == "final_answer" { turn.answer = text; }
                        else if !text.trim().is_empty() { turn.steps.push(step("text", "说明", text)); }
                    }
                    "Reasoning" => {
                        let summary = item["summary_text"].as_array().into_iter().flatten().filter_map(Value::as_str)
                            .collect::<Vec<_>>().join("\n").replace("**", "");
                        if !summary.trim().is_empty() { turn.steps.push(step("think", "思考", summary)); }
                    }
                    "CommandExecution" => turn.steps.push(step("tool", "运行命令", command_line(&item["command"]))),
                    "FileChange" => {
                        let files = item["changes"].as_object().map(|changes| changes.keys().map(|path| path.rsplit(['\\', '/']).next().unwrap_or(path).to_owned()).collect::<Vec<_>>().join("、")).unwrap_or_default();
                        turn.steps.push(step("tool", "修改文件", files));
                    }
                    "McpToolCall" => {
                        let title = format!("{}.{}", item["server"].as_str().unwrap_or("mcp"), item["tool"].as_str().unwrap_or_default());
                        let detail = item.pointer("/arguments/title").and_then(Value::as_str).map(ToOwned::to_owned).unwrap_or_else(|| item["arguments"].to_string());
                        turn.steps.push(step("tool", title, detail));
                    }
                    "ImageView" => turn.steps.push(step("tool", "查看图片", item["path"].as_str().unwrap_or_default())),
                    "SubAgentActivity" => {
                        let title = match item["kind"].as_str() {
                            Some("started") => "启动子 Agent",
                            Some("completed") => "子 Agent 已完成",
                            Some("interrupted") => "中断子 Agent",
                            _ => "联系子 Agent",
                        };
                        turn.steps.push(step("tool", title, item["agent_path"].as_str().unwrap_or_default()));
                    }
                    "Extension" if item["kind"] == "web.search" => turn.steps.push(step("tool", "搜索网页", item["query"].as_str().unwrap_or_default())),
                    "" => {}
                    other => turn.steps.push(step("tool", other.to_owned(), item["kind"].as_str().unwrap_or_default())),
                }
            }
            ("event_msg", "user_message") if !has_items => {
                let turn = open_turn(turns, "", at);
                if turn.prompt.is_empty() { turn.prompt = payload["message"].as_str().unwrap_or_default().to_owned(); }
            }
            ("event_msg", "agent_message") if !has_items => {
                let text = payload["message"].as_str().unwrap_or_default();
                if !text.trim().is_empty() { open_turn(turns, "", at).steps.push(step("text", "说明", text)); }
            }
            ("response_item", "function_call" | "custom_tool_call" | "local_shell_call") if !has_items => {
                let arguments = payload["arguments"].as_str().and_then(|raw| serde_json::from_str::<Value>(raw).ok()).unwrap_or(Value::Null);
                let detail = arguments.get("command").or_else(|| arguments.get("cmd")).map(command_line)
                    .or_else(|| payload["input"].as_str().map(ToOwned::to_owned)).unwrap_or_else(|| payload["arguments"].as_str().unwrap_or_default().to_owned());
                open_turn(turns, "", at).steps.push(step("tool", payload["name"].as_str().unwrap_or("工具").to_owned(), detail));
            }
            ("event_msg", kind @ ("task_complete" | "turn_aborted")) => {
                let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none()) else { continue };
                turn.completed_at = Some(payload["completed_at"].as_i64().map_or(at, |seconds| seconds * 1000).max(at));
                turn.duration_ms = payload["duration_ms"].as_i64().or(Some(at - turn.started_at).filter(|ms| *ms >= 0));
                turn.interrupted = kind == "turn_aborted";
                if turn.answer.is_empty() {
                    turn.answer = payload["last_agent_message"].as_str().map(ToOwned::to_owned).unwrap_or_else(|| take_last_text(&mut turn.steps));
                }
            }
            ("event_msg", "error") if payload["will_retry"] != true => {
                if let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none()) {
                    turn.answer = payload["message"].as_str().unwrap_or("CLI 请求失败").to_owned();
                    turn.completed_at = Some(at);
                    turn.interrupted = true;
                }
            }
            _ => {}
        }
    }
    transcript.turns.retain(|turn| !turn.prompt.trim().is_empty() || !turn.steps.is_empty() || !turn.answer.is_empty());
    transcript
}

fn take_last_text(steps: &mut Vec<ChatStep>) -> String {
    match steps.iter().rposition(|step| step.kind == "text") {
        Some(index) if steps[index + 1..].iter().all(|step| step.kind != "tool") => steps.remove(index).detail,
        _ => String::new(),
    }
}

fn tag_body<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let start = text.find(&format!("<{tag}>"))? + tag.len() + 2;
    let end = text[start..].find(&format!("</{tag}>"))? + start;
    Some(&text[start..end])
}

fn strip_reminders(text: &str) -> String {
    let mut text = text.to_owned();
    while let (Some(start), Some(end)) = (text.find("<system-reminder>"), text.find("</system-reminder>")) {
        if end < start { break; }
        text.replace_range(start..end + "</system-reminder>".len(), "");
    }
    text.trim().to_owned()
}

fn claude_tool_detail(name: &str, input: &Value) -> String {
    for key in ["command", "file_path", "pattern", "url", "query", "description", "prompt", "skill"] {
        if let Some(text) = input.get(key).and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
            return if key == "file_path" { text.rsplit(['\\', '/']).next().unwrap_or(text).to_owned() } else { text.to_owned() };
        }
    }
    if name == "TodoWrite" { return String::new(); }
    input.to_string()
}

fn parse_claude(records: impl Iterator<Item = Value>) -> ChatTranscript {
    let mut transcript = ChatTranscript::default();
    let turns = &mut transcript.turns;
    let mut prompt_id = String::new();
    for value in records {
        if value["isSidechain"] == true || value.get("agentId").and_then(Value::as_str).is_some() { continue; }
        let at = timestamp_ms(&value).unwrap_or_default();
        match value["type"].as_str().unwrap_or_default() {
            "user" if value["isMeta"] != true => {
                let content = value.pointer("/message/content");
                if content.and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item["type"] == "tool_result")) { continue; }
                let text = strip_reminders(&texts(content));
                if text.is_empty() { continue; }
                if text.starts_with("[Request interrupted") {
                    if let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none()) {
                        turn.interrupted = true;
                        turn.completed_at = Some(at);
                        turn.duration_ms = Some(at - turn.started_at).filter(|ms| *ms >= 0);
                    }
                    continue;
                }
                if let Some(output) = tag_body(&text, "local-command-stdout") {
                    if let Some(turn) = turns.last_mut() { turn.answer = output.trim().to_owned(); turn.completed_at.get_or_insert(at); }
                    continue;
                }
                let text = match tag_body(&text, "command-name") {
                    _ if text.starts_with("<task-notification>") => "（后台任务通知）".to_owned(),
                    Some(name) => format!("{} {}", name.trim(), tag_body(&text, "command-args").unwrap_or_default().trim()).trim().to_owned(),
                    None => text,
                };
                let id = value["promptId"].as_str().unwrap_or_default();
                // One typed prompt can span several records (text plus image references).
                if let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none() && turn.steps.is_empty() && !id.is_empty() && id == prompt_id) {
                    turn.prompt = format!("{}\n{text}", turn.prompt);
                    continue;
                }
                if let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none()) { turn.completed_at = Some(at); }
                prompt_id = id.to_owned();
                turns.push(ChatTurn { id: value["uuid"].as_str().unwrap_or_default().to_owned(), prompt: text, started_at: at, ..Default::default() });
            }
            "assistant" => {
                if let Some(model) = value.pointer("/message/model").and_then(Value::as_str).filter(|model| !model.starts_with('<')) {
                    transcript.model = model.to_owned();
                }
                let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none()) else { continue };
                for block in value.pointer("/message/content").and_then(Value::as_array).into_iter().flatten() {
                    match block["type"].as_str().unwrap_or_default() {
                        "thinking" => if let Some(text) = block["thinking"].as_str().filter(|text| !text.trim().is_empty()) { turn.steps.push(step("think", "思考", text)); },
                        "text" => if let Some(text) = block["text"].as_str().filter(|text| !text.trim().is_empty()) { turn.steps.push(ChatStep { kind: "text", title: "说明".into(), detail: text.to_owned() }); },
                        "tool_use" => {
                            let name = block["name"].as_str().unwrap_or("工具");
                            turn.steps.push(step("tool", name.to_owned(), claude_tool_detail(name, &block["input"])));
                        }
                        _ => {}
                    }
                }
                if value["isApiErrorMessage"] == true {
                    turn.answer = take_last_text(&mut turn.steps);
                    turn.completed_at = Some(at);
                    turn.interrupted = true;
                }
            }
            "system" if value["subtype"] == "turn_duration" => {
                let Some(turn) = turns.last_mut().filter(|turn| turn.completed_at.is_none()) else { continue };
                turn.completed_at = Some(at);
                turn.duration_ms = value["durationMs"].as_i64().or(Some(at - turn.started_at).filter(|ms| *ms >= 0));
                turn.answer = take_last_text(&mut turn.steps);
            }
            "system" if value["subtype"] == "local_command" => {
                let command = value.pointer("/commandRun/command").and_then(Value::as_str).unwrap_or_default();
                if command.is_empty() { continue; }
                let args = value.pointer("/commandRun/args").and_then(Value::as_str).unwrap_or_default();
                let output = value["content"].as_str().and_then(|text| tag_body(text, "local-command-stdout")).unwrap_or_default();
                turns.push(ChatTurn {
                    id: value["uuid"].as_str().unwrap_or_default().to_owned(),
                    prompt: format!("/{command} {args}").trim().to_owned(), started_at: at,
                    answer: output.trim().to_owned(), completed_at: Some(at), duration_ms: Some(0), ..Default::default()
                });
            }
            _ => {}
        }
    }
    // Interim text stays visible as steps; long text steps are only clipped when they become tool noise.
    for turn in turns.iter_mut() {
        for step in &mut turn.steps { if step.kind == "text" { step.detail = clip(&step.detail, 4000); } }
    }
    transcript
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_chat_preserves_streamed_answers_and_waits_for_current_turn_completion() {
        let message = |id: &str, role: &str, content: &str, seconds: u8| crate::models::CliNativeConversationMessage {
            id: id.into(), role: role.into(), content: content.into(), timestamp: format!("2026-10-16T10:00:{seconds:02}Z"),
        };
        let messages = vec![
            message("1", "user", "first", 0), message("2", "assistant", "first answer", 1),
            message("3", "user", "second", 3), message("4", "assistant", "stream one", 4),
            message("5", "assistant", "stream two", 5),
        ];
        let start = timestamp_ms(&json!({"timestamp":"2026-10-16T10:00:00Z"})).unwrap();
        let pending = from_native_messages(messages.clone(), Some(start + 1000));
        assert!(pending.turns[0].completed_at.is_some());
        assert!(pending.turns[1].completed_at.is_none());
        assert_eq!(pending.turns[1].answer, "stream one\n\nstream two");
        let complete = from_native_messages(messages, Some(start + 6000));
        assert_eq!(complete.turns[1].duration_ms, Some(3000));
    }

    #[test]
    fn claude_api_error_finishes_without_a_duration_record() {
        let transcript = parse_claude(vec![
            json!({"timestamp":"2026-10-16T10:00:00Z","type":"user","message":{"content":"hello"}}),
            json!({"timestamp":"2026-10-16T10:00:01Z","type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error: unavailable"}]}}),
        ].into_iter());
        assert_eq!(transcript.turns[0].answer, "API Error: unavailable");
        assert!(transcript.turns[0].completed_at.is_some());
        assert!(transcript.turns[0].interrupted);
    }

    #[test]
    fn codex_retry_keeps_running_but_terminal_error_finishes() {
        let mut records = vec![
            json!({"timestamp":"2026-10-16T10:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"hello"}}),
            json!({"timestamp":"2026-10-16T10:00:01Z","type":"event_msg","payload":{"type":"error","message":"retrying","will_retry":true}}),
        ];
        assert!(parse_codex(records.clone().into_iter(), false).turns[0].completed_at.is_none());
        records.push(json!({"timestamp":"2026-10-16T10:00:02Z","type":"event_msg","payload":{"type":"error","message":"request failed"}}));
        let transcript = parse_codex(records.into_iter(), false);
        assert_eq!(transcript.turns[0].answer, "request failed");
        assert!(transcript.turns[0].completed_at.is_some());
    }

    #[test]
    fn restores_v2_spawn_links_from_legacy_and_paginated_rollouts() {
        for activity in [
            json!({"type":"sub_agent_activity","kind":"started","event_id":"call","agent_thread_id":"child"}),
            json!({"type":"item_completed","turn_id":"turn","item":{"type":"SubAgentActivity","kind":"started","id":"call","agent_thread_id":"child"}}),
        ] {
            let transcript = parse_codex(vec![
                json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
                json!({"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call","arguments":"{\"message\":\"inspect files\",\"task_name\":\"inspect\"}"}}),
                json!({"type":"event_msg","payload":activity}),
            ].into_iter(), true);
            assert_eq!(transcript.agent_calls["call"]["message"], "inspect files");
            assert_eq!(transcript.agent_links[0]["id"], "child");
            assert_eq!(transcript.agent_links[0]["turnId"], "turn");
        }
    }

    #[test]
    fn distinguishes_encrypted_v2_tasks_from_explicit_plaintext_and_v1_tasks() {
        for (namespace, encrypted_args, encrypted) in [
            ("collaboration", Value::Null, true),
            ("collaboration", json!(["message"]), true),
            ("collaboration", json!([]), false),
            ("multi_agent_v1", Value::Null, false),
        ] {
            let transcript = parse_codex(vec![json!({"type":"response_item","payload":{
                "type":"function_call","namespace":namespace,"name":"spawn_agent","call_id":"call",
                "arguments":"{\"message\":\"task body\"}","encrypted_function_args":encrypted_args,
            }})].into_iter(), false);
            assert_eq!(transcript.agent_calls["call"]["encrypted"], encrypted);
        }
    }

    #[test]
    fn codex_items_become_steps_and_final_answer() {
        let records = vec![
            json!({"timestamp":"2026-10-16T10:00:00Z","type":"turn_context","payload":{"model":"gpt-6.1-sol","collaboration_mode":{"settings":{"reasoning_effort":"high"}}}}),
            json!({"timestamp":"2026-10-16T10:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1","started_at":1792144800}}),
            json!({"timestamp":"2026-10-16T10:00:01Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","content":[{"type":"text","text":"say hi"}]}}}),
            json!({"timestamp":"2026-10-16T10:00:02Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","command":["pwsh.exe","-Command","Get-ChildItem"]}}}),
            json!({"timestamp":"2026-10-16T10:00:03Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"AgentMessage","phase":"final_answer","content":[{"type":"Text","text":"hi"}]}}}),
            json!({"timestamp":"2026-10-16T10:00:04Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","duration_ms":4000,"completed_at":1792144804}}),
        ];
        let transcript = parse_codex(records.into_iter(), true);
        assert_eq!(transcript.model, "gpt-6.1-sol high");
        let turn = &transcript.turns[0];
        assert_eq!((turn.prompt.as_str(), turn.answer.as_str(), turn.duration_ms), ("say hi", "hi", Some(4000)));
        assert_eq!(turn.steps[0].detail, "Get-ChildItem");
    }

    #[test]
    fn claude_final_text_after_tools_is_the_answer() {
        let records = vec![
            json!({"timestamp":"2026-10-16T10:00:00Z","type":"user","promptId":"p1","message":{"role":"user","content":"fix it"}}),
            json!({"timestamp":"2026-10-16T10:00:01Z","type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"looking"},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}),
            json!({"timestamp":"2026-10-16T10:00:02Z","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"a"}]}}),
            json!({"timestamp":"2026-10-16T10:00:03Z","type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"done"}]}}),
            json!({"timestamp":"2026-10-16T10:00:04Z","type":"system","subtype":"turn_duration","durationMs":4000}),
        ];
        let transcript = parse_claude(records.into_iter());
        assert_eq!(transcript.model, "claude-opus-5-5");
        let turn = &transcript.turns[0];
        assert_eq!((turn.answer.as_str(), turn.steps.len(), turn.duration_ms), ("done", 2, Some(4000)));
        assert_eq!(turn.steps[1].detail, "ls");
    }
}

/// A bounded window over the complete native history. Unchanged polls carry no text.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    revision: String,
    has_more: bool,
    versions: HashMap<String, String>,
    order: Vec<String>,
    transcript: Option<ChatTranscript>,
}

fn turn_fingerprint(turn: &ChatTurn) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    serde_json::to_vec(turn).unwrap_or_default().hash(&mut hash);
    format!("{:x}", hash.finish())
}

pub(crate) fn page_chat(mut transcript: ChatTranscript, revision: Option<String>, limit: usize, known: HashMap<String, String>) -> ChatPage {
    use std::hash::{Hash, Hasher};
    let total = transcript.turns.len();
    let start = total.saturating_sub(limit.max(1));
    transcript.turns.drain(..start);
    let order = transcript.turns.iter().map(|turn| turn.id.clone()).collect();
    let versions: HashMap<String, String> = transcript.turns.iter().map(|turn| {
        (turn.id.clone(), if turn.fingerprint.is_empty() { turn_fingerprint(turn) } else { turn.fingerprint.clone() })
    }).collect();
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    transcript.model.hash(&mut hash);
    serde_json::to_vec(&transcript.agents).unwrap_or_default().hash(&mut hash);
    transcript.agent_error.hash(&mut hash);
    for turn in &transcript.turns { turn.id.hash(&mut hash); versions.get(&turn.id).hash(&mut hash); }
    let current = format!("{:x}:{start}", hash.finish());
    let changed = revision.as_deref() != Some(current.as_str());
    transcript.turns.retain(|turn| known.get(&turn.id) != versions.get(&turn.id));
    ChatPage { revision: current, has_more: total > limit, versions, order, transcript: changed.then_some(transcript) }
}

#[cfg(test)]
mod page_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn pages_reach_before_eight_megabytes_and_keep_old_reader_bounded() {
        let mut source = tempfile::NamedTempFile::new().unwrap();
        let answer = "a".repeat(160_000);
        for index in 0..70 {
            for record in [
                serde_json::json!({"timestamp":"2026-10-16T10:00:00Z","type":"user","promptId":format!("p{index}"),"uuid":format!("p{index}"),"message":{"role":"user","content":format!("prompt {index}")}}),
                serde_json::json!({"timestamp":"2026-10-16T10:00:01Z","type":"assistant","message":{"content":[{"type":"text","text":answer}]}}),
                serde_json::json!({"timestamp":"2026-10-16T10:00:02Z","type":"system","subtype":"turn_duration","durationMs":2000}),
            ] { writeln!(source, "{record}").unwrap(); }
        }
        assert!(source.as_file().metadata().unwrap().len() > 8 * 1024 * 1024);
        let path = source.path().to_str().unwrap();
        let recent = read_chat_window("claude", path, 40).unwrap();
        assert_eq!(recent.turns.len(), 41);
        assert!(recent.turns.iter().all(|turn| !turn.fingerprint.is_empty()));
        let cached = read_chat_window("claude", path, 40).unwrap();
        assert_eq!(recent.turns[0].fingerprint, cached.turns[0].fingerprint);
        assert_eq!(read_chat("claude", path).unwrap().turns.len(), 40);
        let full = read_chat_window("claude", path, 80).unwrap();
        assert_eq!(full.turns.len(), 70);
        assert_eq!(full.turns[0].prompt, "prompt 0");
        assert_eq!(full.turns[0].answer.len(), answer.len());
    }

    #[test]
    fn unchanged_pages_have_no_text_and_updates_only_send_changed_turns() {
        let mut transcript = ChatTranscript { turns: (0..240).map(|index| ChatTurn {
            id: format!("t{index}"), answer: format!("answer {index}"), ..Default::default()
        }).collect(), ..Default::default() };
        let first = page_chat(transcript.clone(), None, 240, HashMap::new());
        assert_eq!(first.transcript.as_ref().unwrap().turns.len(), 240);
        let unchanged = page_chat(transcript.clone(), Some(first.revision.clone()), 240, first.versions.clone());
        assert!(unchanged.transcript.is_none());
        transcript.turns[239].answer = "updated".into();
        let updated = page_chat(transcript, Some(first.revision), 240, first.versions);
        let delta = updated.transcript.unwrap();
        assert_eq!(delta.turns.len(), 1);
        assert_eq!(delta.turns[0].id, "t239");
        assert_eq!(updated.order.len(), 240);
    }
}
