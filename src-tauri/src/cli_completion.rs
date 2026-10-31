//! Completion notifications use native turn boundaries, never PTY silence.
use std::{fs::File, io::{BufRead, BufReader, Read, Seek, SeekFrom}, path::Path, time::{SystemTime, UNIX_EPOCH}};
use serde_json::Value;
use tauri::{AppHandle, Listener, Manager, WebviewUrl};

pub(crate) fn latest_completion(provider: &str, source: &str) -> anyhow::Result<Option<(String, i64)>> {
    if provider == "opencode" {
        return crate::cli_conversations::opencode_completion(source);
    }
    if !matches!(provider, "codex" | "claude") {
        return crate::cli_completion_adapters::latest_completion(provider, source);
    }
    let mut file = File::open(Path::new(source))?;
    // Read only the final records. A partial final line is ignored until the next poll.
    let size = file.metadata()?.len();
    let offset = size.saturating_sub(256 * 1024);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let raw = String::from_utf8_lossy(&bytes);
    Ok(parse_completion_tail(provider, &raw, offset != 0))
}

fn parse_completion_tail(provider: &str, raw: &str, partial_first_line: bool) -> Option<(String, i64)> {
    let mut latest = None;
    for (index, line) in raw.lines().enumerate() {
        if partial_first_line && index == 0 { continue }
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        if let Some((token, completed)) = record_completion(provider, &value) {
            latest = Some((token, completed));
        }
    }
    latest
}

pub(crate) fn record_completion(provider: &str, value: &Value) -> Option<(String, i64)> {
    let completed = match provider {
        "codex" => value["type"] == "event_msg" && value["payload"]["type"] == "task_complete",
        "claude" => value["isSidechain"] != true && value.get("agentId").and_then(Value::as_str).is_none()
            && value["type"] == "system" && value["subtype"] == "turn_duration"
            && value["pendingBackgroundAgentCount"].as_u64().unwrap_or_default() == 0
            && value["pendingWorkflowCount"].as_u64().unwrap_or_default() == 0,
        _ => false,
    };
    if !completed { return None }
    let timestamp = value["timestamp"].as_str()?;
    let time = time::OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339).ok()?;
    // Timestamp identifies the boundary even on CLI versions without an explicit turn ID.
    let token = value.pointer("/payload/turn_id").or_else(|| value.get("uuid"))
        .and_then(Value::as_str).unwrap_or(timestamp).to_owned();
    Some((token, (time.unix_timestamp_nanos() / 1_000_000) as i64))
}

pub(crate) fn unix_millis(value: SystemTime) -> i64 {
    value.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}

/// Codex async questions are completed agent messages, not blocking Plan requests.
fn async_question_item(thread: &str, item: &Value) -> Option<(String, String, String)> {
    if !matches!(item["type"].as_str(), Some("agentMessage" | "AgentMessage")) || item["delivery"] != "async" { return None; }
    let thread = thread.to_owned();
    let id = item["id"].as_str()?.to_owned();
    let questions = item["questions"].as_array()?.iter().filter_map(|question| {
        let title = question["title"].as_str()?.trim();
        if title.is_empty() { return None; }
        let mut text = title.to_owned();
        if let Some(options) = question["options"].as_array() {
            for option in options.iter().filter_map(Value::as_str) {
                text.push_str("\n- ");
                text.push_str(option);
            }
        }
        Some(text)
    }).collect::<Vec<_>>();
    if questions.is_empty() { return None; }
    Some((thread, id, format!("{}\n\n回到原会话后按终端提示展开问题并回答。", questions.join("\n\n"))))
}

pub(crate) fn codex_async_question(message: &Value) -> Option<(String, String, String)> {
    if message["method"] != "item/completed" { return None; }
    async_question_item(message["params"]["threadId"].as_str()?, &message["params"]["item"])
}

pub(crate) fn claim_async_question(seen: &std::sync::Mutex<std::collections::HashSet<(String, String)>>, thread: &str, item: &str) -> bool {
    seen.lock().unwrap().insert((thread.to_owned(), item.to_owned()))
}

/// Read complete rollout records incrementally; a partially written line is retried.
pub(crate) fn codex_async_question_records<R: BufRead + Seek>(reader: &mut R, offset: &mut u64, started_at: i64, thread: &str) -> std::io::Result<Vec<(String, String, String)>> {
    reader.seek(SeekFrom::Start(*offset))?;
    let mut found = Vec::new();
    loop {
        let mut line = Vec::new();
        let size = reader.read_until(b'\n', &mut line)?;
        if size == 0 || !line.ends_with(b"\n") { break; }
        *offset += size as u64;
        let Ok(value) = serde_json::from_slice::<Value>(&line) else { continue };
        if value["type"] != "event_msg" || value["payload"]["type"] != "item_completed" || value["payload"]["thread_id"] != thread { continue; }
        let Some(timestamp) = value["timestamp"].as_str().and_then(|s| time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()) else { continue; };
        if timestamp.unix_timestamp_nanos() / 1_000_000 < started_at as i128 { continue; }
        if let Some(question) = async_question_item(thread, &value["payload"]["item"]) { found.push(question); }
    }
    Ok(found)
}

pub(crate) fn read_codex_async_questions(path: &Path, offset: &mut u64, started_at: i64, thread: &str) -> std::io::Result<Vec<(String, String, String)>> {
    let file = File::open(path)?;
    if file.metadata()?.len() < *offset { *offset = 0; }
    codex_async_question_records(&mut BufReader::new(file), offset, started_at, thread)
}

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompletionNotice {
    pub title: String,
    pub provider: String,
    pub workspace: String,
    pub conversation_id: String,
    pub task: String,
    pub answer: String,
    pub session_id: String,
    pub plan_request: Option<crate::codex_plan::PlanRequest>,
    pub async_question: bool,
    pub duration_ms: Option<i64>,
}

const NOTICE_WIDTH: f64 = 420.0;
const NOTICE_HEIGHT: f64 = 176.0;
const NOTICE_SLOT: f64 = NOTICE_HEIGHT + 8.0;

/// Phone clients poll this feed; it mirrors every desktop notice without its interactive payload.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileNotice {
    pub seq: u64,
    pub title: String,
    pub provider: String,
    pub workspace: String,
    pub body: String,
    pub duration_ms: Option<i64>,
    pub plan: bool,
}

fn mobile_feed() -> &'static std::sync::Mutex<(u64, std::collections::VecDeque<MobileNotice>)> {
    static FEED: std::sync::OnceLock<std::sync::Mutex<(u64, std::collections::VecDeque<MobileNotice>)>> = std::sync::OnceLock::new();
    FEED.get_or_init(Default::default)
}

fn publish_mobile(notice: &CompletionNotice) {
    let body = if let Some(plan) = &notice.plan_request {
        plan.questions.first().map(|q| if q.header.is_empty() { q.question.clone() } else { format!("{}：{}", q.header, q.question) }).unwrap_or_default()
    } else if notice.answer.trim().is_empty() { notice.task.clone() } else { notice.answer.clone() };
    let body: String = body.trim().chars().take(400).collect();
    let mut feed = mobile_feed().lock().unwrap();
    feed.0 += 1;
    let seq = feed.0;
    feed.1.push_back(MobileNotice {
        seq, title: if notice.title.trim().is_empty() { notice.task.chars().take(80).collect() } else { notice.title.clone() },
        provider: notice.provider.clone(), workspace: notice.workspace.clone(), body,
        duration_ms: notice.duration_ms, plan: notice.plan_request.is_some(),
    });
    while feed.1.len() > 50 { feed.1.pop_front(); }
}

/// Without `after` only the latest sequence is returned, so a new client never replays old notices.
pub(crate) fn mobile_notices(after: Option<u64>) -> (u64, Vec<MobileNotice>) {
    let feed = mobile_feed().lock().unwrap();
    let notices = // A smaller sequence than the client's means the desktop restarted.
    after.map(|after| if after > feed.0 { 0 } else { after }).map(|after| feed.1.iter().filter(|n| n.seq > after).cloned().collect()).unwrap_or_default();
    (feed.0, notices)
}

pub(crate) fn notify(app: &AppHandle, notice: CompletionNotice) {
    publish_mobile(&notice);
    static SLOTS: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeSet<usize>>> = std::sync::OnceLock::new();
    let app = app.clone();
    // Native windows remain visible when the workspace is minimized or behind another app.
    std::thread::spawn(move || {
        let monitor = app.get_webview_window("main").and_then(|window| window.primary_monitor().ok().flatten());
        let interactive = notice.plan_request.is_some() || notice.async_question;
        let capacity = monitor.as_ref().map(|monitor| ((monitor.work_area().size.height as f64 / monitor.scale_factor() - 16.0) / NOTICE_SLOT).floor().max(1.0) as usize).unwrap_or(3);
        let max_height = (if notice.plan_request.is_some() { 480.0 } else { NOTICE_HEIGHT }).min(capacity as f64 * NOTICE_SLOT - 8.0);
        let span = (max_height / NOTICE_SLOT).ceil() as usize;
        let slot = loop {
            let free = {
                let mut slots = SLOTS.get_or_init(Default::default).lock().unwrap();
                (0..=capacity.saturating_sub(span)).find(|slot| (*slot..(*slot + span)).all(|s| !slots.contains(&s)))
                    .inspect(|slot| { slots.extend(*slot..(*slot + span)); })
            };
            if let Some(slot) = free { break slot }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        let label = format!("cli-completion-{}", uuid::Uuid::new_v4());
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        // The page reports its content height so short answers get a short window.
        let ready_listener = app.listen(format!("{label}-ready"), move |event| {
            let _ = ready_tx.try_send(event.payload().trim().parse::<f64>().ok());
        });
        let held = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let held_listener = std::sync::Arc::clone(&held);
        let hold_listener = app.listen(format!("{label}-hold"), move |event| {
            held_listener.store(event.payload() == "true", std::sync::atomic::Ordering::Relaxed);
        });
        let query = serde_json::to_string(&notice).unwrap_or_default();
        let encoded = query.as_bytes().iter().map(|byte| format!("%{byte:02X}")).collect::<String>();
        let url = format!("index.html?cliCompletion={encoded}");
        let Ok(window) = tauri::WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
            .title("SuperHigh 管家").inner_size(NOTICE_WIDTH, max_height).decorations(false).resizable(false)
            .always_on_top(true).skip_taskbar(true).focused(false).shadow(false).visible(false).build() else {
                app.unlisten(ready_listener);
                app.unlisten(hold_listener);
                SLOTS.get_or_init(Default::default).lock().unwrap().retain(|s| *s < slot || *s >= slot + span);
                return
            };
        // A native ShowWindow call does not update the WebView2 controller's visibility.
        let _ = window.as_ref().show();
        let ready = ready_rx.recv_timeout(std::time::Duration::from_secs(10));
        app.unlisten(ready_listener);
        let Ok(content_height) = ready else {
            let _ = window.close();
            app.unlisten(hold_listener);
            SLOTS.get_or_init(Default::default).lock().unwrap().retain(|s| *s < slot || *s >= slot + span);
            return;
        };
        let height = content_height.filter(|height| height.is_finite() && *height > 0.0)
            .map_or(max_height, |height| height.clamp(64.0, max_height));
        let _ = window.set_size(tauri::LogicalSize::new(NOTICE_WIDTH, height));
        if let Ok(Some(monitor)) = window.primary_monitor() {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let x = area.position.x as f64 / scale + 16.0;
            // Each slot keeps the full height; shorter notices sit at its bottom edge.
            let y = (area.position.y as f64 + area.size.height as f64) / scale - 8.0 - height - slot as f64 * NOTICE_SLOT;
            let _ = window.set_position(tauri::LogicalPosition::new(x, y));
        }
        #[cfg(windows)]
        if let Ok(hwnd) = window.hwnd() {
            unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0 as _, windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
        }
        #[cfg(not(windows))]
        let _ = window.show();
        #[cfg(windows)]
        unsafe { windows_sys::Win32::System::Diagnostics::Debug::MessageBeep(0x40); }
        let mut remaining = std::time::Duration::from_secs(20);
        let tick = std::time::Duration::from_millis(250);
        while app.get_webview_window(&label).is_some() && (interactive || !remaining.is_zero()) {
            std::thread::sleep(tick);
            if !held.load(std::sync::atomic::Ordering::Relaxed) { remaining = remaining.saturating_sub(tick); }
        }
        app.unlisten(hold_listener);
        let _ = window.close();
        SLOTS.get_or_init(Default::default).lock().unwrap().retain(|s| *s < slot || *s >= slot + span);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn recognizes_only_async_question_items() {
        let mut item = json!({"type":"AgentMessage","id":"question-1","delivery":"async","questions":[{"title":"启动了吗？","options":["已启动","稍后"]}]});
        let (thread, id, text) = async_question_item("thread-1", &item).unwrap();
        assert_eq!((thread.as_str(), id.as_str()), ("thread-1", "question-1"));
        assert!(text.contains("启动了吗？\n- 已启动\n- 稍后"));
        item["delivery"] = Value::Null;
        assert!(async_question_item("thread-1", &item).is_none());
    }
    #[test]
    fn first_async_question_is_read_once_from_its_bound_thread() {
        let record = |thread: &str, id: &str, timestamp: &str| json!({"timestamp":timestamp,"type":"event_msg","payload":{"type":"item_completed","thread_id":thread,"item":{"type":"AgentMessage","id":id,"delivery":"async","questions":[{"title":"启动了吗？","options":["已启动","稍后"]}]}}}).to_string();
        let old = record("thread-1", "old", "2026-10-29T00:00:00Z");
        let other = record("thread-2", "other", "2026-10-29T00:00:02Z");
        let first = record("thread-1", "first", "2026-10-29T00:00:02Z");
        let started = time::OffsetDateTime::parse("2026-10-29T00:00:01Z", &time::format_description::well_known::Rfc3339).unwrap().unix_timestamp() * 1000;
        let mut offset = 0;
        let mut partial = std::io::Cursor::new(format!("{old}\n{other}\n{first}"));
        assert!(codex_async_question_records(&mut partial, &mut offset, started, "thread-1").unwrap().is_empty());
        let mut completed = std::io::Cursor::new(format!("{old}\n{other}\n{first}\n"));
        let found = codex_async_question_records(&mut completed, &mut offset, started, "thread-1").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, "first");
        assert!(codex_async_question_records(&mut completed, &mut offset, started, "thread-1").unwrap().is_empty());
        let seen = std::sync::Mutex::new(std::collections::HashSet::new());
        assert!(claim_async_question(&seen, "thread-1", "first"));
        assert!(!claim_async_question(&seen, "thread-1", "first"));
        assert!(claim_async_question(&seen, "thread-1", "second"));
        assert!(claim_async_question(&seen, "thread-2", "first"));
        // A bounded tail can begin inside a UTF-8 character from an older record.
        let mut tail = std::io::Cursor::new([vec![0xb8, 0xad, b'\n'], format!("{first}\n").into_bytes()].concat());
        let recovered = codex_async_question_records(&mut tail, &mut 0, started, "thread-1").unwrap();
        assert_eq!(recovered.len(), 1);
    }
    #[test]
    fn ignores_tools_streaming_and_side_agents() {
        let timestamp = "2026-10-12T08:00:00Z";
        for kind in ["task_started", "agent_message", "item_completed", "exec_command_end"] {
            assert!(record_completion("codex", &json!({"type":"event_msg","timestamp":timestamp,"payload":{"type":kind}})).is_none());
        }
        assert!(record_completion("codex", &json!({"type":"event_msg","timestamp":timestamp,"payload":{"type":"task_complete","turn_id":"turn-1"}})).is_some());
        assert!(record_completion("claude", &json!({"type":"assistant","timestamp":timestamp,"message":{"stop_reason":"tool_use"}})).is_none());
        assert!(record_completion("claude", &json!({"type":"assistant","timestamp":timestamp,"isSidechain":true,"message":{"stop_reason":"end_turn"}})).is_none());
        assert!(record_completion("claude", &json!({"type":"assistant","timestamp":timestamp,"uuid":"reply-1","message":{"stop_reason":"end_turn"}})).is_none());
        assert!(record_completion("claude", &json!({"type":"system","subtype":"turn_duration","timestamp":timestamp,"uuid":"footer-1","pendingBackgroundAgentCount":1})).is_none());
        assert!(record_completion("claude", &json!({"type":"system","subtype":"turn_duration","timestamp":timestamp,"uuid":"footer-1"})).is_some());
    }
    #[test]
    fn claude_notifies_only_final_footer_and_accepts_null_stop_reason_turn() {
        let first = json!({"type":"assistant","timestamp":"2026-10-12T08:00:00Z","uuid":"final-1","message":{"stop_reason":"end_turn"}});
        let footer = json!({"type":"system","subtype":"turn_duration","timestamp":"2026-10-12T08:00:01Z","uuid":"footer-1"});
        let text = format!("{first}\n{footer}\n");
        assert!(parse_completion_tail("claude", &format!("{first}\n"), false).is_none());
        assert_eq!(parse_completion_tail("claude", &text, false).unwrap().0, "footer-1");
        let user = json!({"type":"user","message":{"content":"next"}});
        let reply = json!({"type":"assistant","message":{"stop_reason":null}});
        let footer2 = json!({"type":"system","subtype":"turn_duration","timestamp":"2026-10-12T08:01:00Z","uuid":"footer-2"});
        let text = format!("{text}{user}\n{reply}\n{footer2}\n");
        assert_eq!(parse_completion_tail("claude", &text, false).unwrap().0, "footer-2");
    }
}
