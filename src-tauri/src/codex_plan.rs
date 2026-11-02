//! Answers travel on the original TUI connection and retain the native request ID.
use std::{collections::{HashMap, HashSet}, sync::{mpsc, Mutex}, time::Duration};
use anyhow::{Context, Result};
use serde_json::{json, Value};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanRequest {
    pub connection: u64,
    pub request_id: Value,
    pub thread_id: String,
    pub questions: Vec<PlanQuestion>,
    #[serde(default)] pub async_question: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanQuestion {
    pub id: String,
    #[serde(default)] pub header: String,
    pub question: String,
    #[serde(default, deserialize_with = "nullable_options")] pub options: Vec<PlanOption>,
    #[serde(default)] pub is_secret: bool,
    #[serde(default)] pub multi_select: bool,
}

fn nullable_options<'de, D: serde::Deserializer<'de>>(value: D) -> Result<Vec<PlanOption>, D::Error> {
    Ok(<Option<Vec<PlanOption>> as serde::Deserialize>::deserialize(value)?.unwrap_or_default())
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct PlanOption {
    pub label: String,
    #[serde(default)] pub description: String,
}

pub(crate) fn request(connection: u64, message: &Value) -> Option<PlanRequest> {
    if !matches!(message["method"].as_str(), Some("item/tool/requestUserInput" | "tool/requestUserInput")) { return None }
    let request_id = message.get("id")?.clone();
    if !request_id.is_string() && !request_id.is_number() { return None }
    let params = &message["params"];
    let questions: Vec<PlanQuestion> = serde_json::from_value(params["questions"].clone()).ok()?;
    if questions.is_empty() { return None }
    Some(PlanRequest { connection, request_id, thread_id: params["threadId"].as_str()?.into(), questions, async_question: false })
}

pub(crate) fn async_request(connection: u64, thread: &str, item: &Value) -> Option<PlanRequest> {
    if !matches!(item["type"].as_str(), Some("agentMessage" | "AgentMessage")) || item["delivery"] != "async" { return None; }
    let item_id = item["id"].as_str()?;
    let questions = item["questions"].as_array()?.iter().enumerate().map(|(index, q)| {
        Some(PlanQuestion {
            id: json!(["request_user_input_async", item_id, index]).to_string(),
            header: String::new(), question: q["title"].as_str()?.trim().to_owned(),
            options: q["options"].as_array().map(|options| options.iter().filter_map(Value::as_str)
                .map(|label| PlanOption { label: label.into(), description: String::new() }).collect()).unwrap_or_default(),
            is_secret: false, multi_select: false,
        })
    }).collect::<Option<Vec<_>>>()?;
    if questions.is_empty() || questions.iter().any(|q| q.question.is_empty()) { return None; }
    Some(PlanRequest { connection, request_id: json!(item_id), thread_id: thread.into(), questions, async_question: true })
}

type Key = (u64, String);
fn key(connection: u64, id: &Value) -> Key { (connection, id.to_string()) }

pub(crate) struct Reply {
    pub request_id: Value,
    pub answers: HashMap<String, Vec<String>>,
    pub done: mpsc::SyncSender<Result<(), String>>,
}

#[derive(Default)]
struct State {
    pending: HashMap<Key, PlanRequest>,
    sent: HashSet<Key>,
    connections: HashMap<u64, mpsc::Sender<Reply>>,
    active_turns: HashMap<String, String>,
    async_replies: HashMap<Key, (Key, mpsc::SyncSender<Result<(), String>>)>,
    async_seen: HashSet<Key>,
    native_submissions: HashMap<Key, (String, Value)>,
}

fn pending_key(state: &State, connection: u64, id: &Value) -> Key {
    // Rollout fallback notices do not carry a transport connection ID.
    if connection == 0 {
        if let Some((key, _)) = state.pending.iter().find(|(_, request)| request.async_question && request.request_id == *id) { return key.clone(); }
    }
    key(connection, id)
}

fn resolve_user_message(state: &mut State, connection: u64, thread: &str, item: &Value) {
    if !matches!(item["type"].as_str(), Some("userMessage" | "UserMessage")) { return; }
    let text = item["content"].as_array().map(|parts| parts.iter().filter_map(|part| part["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    let text = text.trim();
    let replies = text.strip_prefix("<send_user_message_question_reply>").and_then(|text| text.strip_suffix("</send_user_message_question_reply>"))
        .and_then(|raw| serde_json::from_str::<Value>(raw.trim()).ok());
    let ids: Option<Vec<String>> = replies.map(|replies| {
        let replies = replies.as_array().cloned().unwrap_or_else(|| vec![replies]);
        replies.iter().filter_map(|reply| reply["questionItemId"].as_str().map(str::to_owned)).collect()
    });
    state.pending.retain(|(c, _), request| {
        if *c != connection || request.thread_id != thread || !request.async_question { return true; }
        if let Some(ids) = &ids {
            request.questions.retain(|q| !ids.contains(&q.id) && !ids.iter().any(|id| request.request_id.as_str() == Some(id.as_str())));
            !request.questions.is_empty()
        } else { false }
    });
}

#[derive(Default)]
pub(crate) struct PlanRelay(Mutex<State>);

impl PlanRelay {
    pub fn attach(&self, connection: u64) -> mpsc::Receiver<Reply> {
        let (tx, rx) = mpsc::channel();
        self.0.lock().unwrap().connections.insert(connection, tx);
        rx
    }
    pub fn detach(&self, connection: u64) {
        let mut state = self.0.lock().unwrap();
        state.connections.remove(&connection);
        state.pending.retain(|(c, _), _| *c != connection);
        state.sent.retain(|(c, _)| *c != connection);
        state.async_seen.retain(|(c, _)| *c != connection);
        state.native_submissions.retain(|(c, _), _| *c != connection);
        state.async_replies.retain(|(c, _), (_, done)| {
            if *c != connection { return true; }
            let _ = done.send(Err("Codex 连接已关闭".into()));
            false
        });
    }
    pub fn pending(&self, connection: u64, id: &Value) -> Option<PlanRequest> {
        let state = self.0.lock().unwrap();
        state.pending.get(&pending_key(&state, connection, id)).cloned()
    }
    // Hide late Plan responses and acknowledgements of our own injected requests.
    pub fn observe(&self, connection: u64, direction: &str, message: &Value) -> bool {
        let mut state = self.0.lock().unwrap();
        if direction == "client" && message.get("method").is_none() {
            let k = key(connection, &message["id"]);
            if state.sent.contains(&k) { return false }
            state.pending.remove(&k);
        } else if direction == "client" && matches!(message["method"].as_str(), Some("turn/start" | "turn/steer")) {
            let thread = message["params"]["threadId"].as_str().unwrap_or_default();
            if let Some(id) = message.get("id").filter(|id| id.is_string() || id.is_number()) {
                if state.pending.iter().any(|((c, _), request)| *c == connection && request.async_question && request.thread_id == thread) {
                    state.native_submissions.insert(key(connection, id), (thread.into(), message["params"]["input"].clone()));
                }
            }
        } else if direction == "server" {
            if message.get("method").is_none() {
                if let Some((pending, done)) = state.async_replies.remove(&key(connection, &message["id"])) {
                    let result = if let Some(error) = message.get("error") {
                        Err(error["message"].as_str().unwrap_or("Codex 未接受回答").to_owned())
                    } else if message.get("result").is_some() {
                        state.pending.remove(&pending);
                        Ok(())
                    } else { Err("Codex 响应不完整".into()) };
                    let _ = done.send(result);
                    return false;
                }
                if let Some((thread, input)) = state.native_submissions.remove(&key(connection, &message["id"])) {
                    if message.get("error").is_none() && message.get("result").is_some() {
                        resolve_user_message(&mut state, connection, &thread, &json!({"type":"userMessage","content":input}));
                    }
                }
            }
            let thread = message["params"]["threadId"].as_str().unwrap_or_default();
            if message["method"] == "turn/started" {
                if let Some(turn) = message.pointer("/params/turn/id").and_then(Value::as_str) { state.active_turns.insert(thread.into(), turn.into()); }
            } else if matches!(message["method"].as_str(), Some("turn/completed" | "thread/closed")) {
                state.active_turns.remove(thread);
            }
            if matches!(message["method"].as_str(), Some("item/started" | "item/completed")) {
                resolve_user_message(&mut state, connection, thread, &message["params"]["item"]);
            }
            if message["method"] == "item/completed" {
                if let Some(request) = async_request(connection, thread, &message["params"]["item"]) {
                    let k = key(connection, &request.request_id);
                    if state.async_seen.insert(k.clone()) { state.pending.insert(k, request); }
                }
            }
            if let Some(request) = request(connection, message) {
                state.sent.remove(&key(connection, &request.request_id));
                state.pending.insert(key(connection, &request.request_id), request);
            } else if message["method"] == "serverRequest/resolved" {
                state.pending.remove(&key(connection, &message["params"]["requestId"]));
            } else if matches!(message["method"].as_str(), Some("turn/completed" | "turn/started" | "thread/closed")) {
                let thread = message["params"]["threadId"].as_str().unwrap_or_default();
                let closed = message["method"] == "thread/closed";
                state.pending.retain(|(c, _), request| *c != connection || request.thread_id != thread || (!closed && request.async_question));
            }
        }
        true
    }
    pub fn reply(&self, connection: u64, id: Value, answers: HashMap<String, Vec<String>>) -> Result<()> {
        let sender = {
            let state = self.0.lock().unwrap();
            let k = pending_key(&state, connection, &id);
            let request = state.pending.get(&k).context("该问题已回答或已结束")?;
            anyhow::ensure!(answers.len() == request.questions.len() && request.questions.iter().all(|q|
                answers.get(&q.id).is_some_and(|values| !values.is_empty() && values.iter().all(|v| !v.trim().is_empty()))), "请回答全部问题");
            state.connections.get(&k.0).context("Codex 连接已关闭")?.clone()
        };
        let (done, received) = mpsc::sync_channel(1);
        sender.send(Reply { request_id: id, answers, done }).context("Codex 连接已关闭")?;
        received.recv_timeout(Duration::from_secs(5)).context("等待 Codex 回复超时，请检查原会话")?.map_err(anyhow::Error::msg)
    }
    /// Async replies are native user messages. Wait for the app-server ACK before closing a notice.
    pub fn async_response(&self, connection: u64, reply: &Reply) -> Result<Option<Value>> {
        let mut state = self.0.lock().unwrap();
        let k = key(connection, &reply.request_id);
        let request = state.pending.get(&k).context("该问题已回答或已结束")?;
        if !request.async_question { return Ok(None); }
        anyhow::ensure!(!state.async_replies.values().any(|(pending, _)| pending == &k), "回答正在发送，请稍候");
        anyhow::ensure!(reply.answers.len() == request.questions.len() && request.questions.iter().all(|q| reply.answers.contains_key(&q.id)), "问题已更新，请重新检查回答");
        let answers: Vec<Value> = request.questions.iter().map(|q| json!({"questionItemId": q.id, "question": q.question, "answer": reply.answers[&q.id].join("\n")})).collect();
        let text = format!("<send_user_message_question_reply>\n{}\n</send_user_message_question_reply>", json!(answers));
        let rpc_id = json!(format!("superhigh-question-{}", uuid::Uuid::new_v4()));
        let mut params = json!({"threadId":request.thread_id,"input":[{"type":"text","text":text,"text_elements":[]}]});
        let method = if let Some(turn) = state.active_turns.get(&request.thread_id) {
            params["expectedTurnId"] = json!(turn);
            "turn/steer"
        } else { "turn/start" };
        state.async_replies.insert(key(connection, &rpc_id), (k, reply.done.clone()));
        Ok(Some(json!({"id":rpc_id,"method":method,"params":params})))
    }
    pub fn fail_async_response(&self, connection: u64, rpc_id: &Value, error: String) {
        if let Some((_, done)) = self.0.lock().unwrap().async_replies.remove(&key(connection, rpc_id)) { let _ = done.send(Err(error)); }
    }
    pub fn take_response(&self, connection: u64, reply: &Reply) -> Result<Value> {
        let mut state = self.0.lock().unwrap();
        let k = key(connection, &reply.request_id);
        anyhow::ensure!(state.pending.remove(&k).is_some(), "该 Plan 问题已结束，请回到原会话查看");
        state.sent.insert(k);
        let answers: serde_json::Map<String, Value> = reply.answers.iter().map(|(id, answers)| (id.clone(), json!({"answers":answers}))).collect();
        Ok(json!({"id": reply.request_id, "result": {"answers": answers}}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn question(id: &str, titles: &[&str]) -> Value {
        json!({"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{
            "type":"agentMessage","id":id,"delivery":"async","questions":titles.iter().map(|title| json!({"title":title,"options":["Yes","No"]})).collect::<Vec<_>>()
        }}})
    }
    fn user(thread: &str, text: &str) -> Value {
        json!({"method":"item/started","params":{"threadId":thread,"item":{"type":"userMessage","content":[{"type":"text","text":text}]}}})
    }
    #[test]
    fn async_answers_resolve_only_their_questions_and_cannot_reappear() {
        let relay = PlanRelay::default();
        let q = question("item-1", &["First?", "Second?"]);
        relay.observe(1, "server", &q);
        relay.observe(2, "server", &q);
        let plan = relay.pending(1, &json!("item-1")).unwrap();
        assert_eq!(plan.questions[0].id, r#"["request_user_input_async","item-1",0]"#);
        let text = format!("<send_user_message_question_reply>{}</send_user_message_question_reply>", json!([{"questionItemId":plan.questions[0].id,"question":"First?","answer":"No"}]));
        relay.observe(1, "server", &user("other", &text));
        assert_eq!(relay.pending(1, &json!("item-1")).unwrap().questions.len(), 2);
        relay.observe(1, "server", &user("thread-1", &text));
        assert_eq!(relay.pending(1, &json!("item-1")).unwrap().questions[0].question, "Second?");
        assert_eq!(relay.pending(2, &json!("item-1")).unwrap().questions.len(), 2);
        relay.observe(1, "server", &user("thread-1", "Continue with my answer"));
        assert!(relay.pending(1, &json!("item-1")).is_none());
        relay.observe(1, "server", &q);
        assert!(relay.pending(1, &json!("item-1")).is_none());
        relay.observe(2, "server", &user("thread-1", &format!("<send_user_message_question_reply>{}</send_user_message_question_reply>", json!({"questionItemId":"item-1","answer":"Yes"}))));
        assert!(relay.pending(2, &json!("item-1")).is_none());
    }
    #[test]
    fn async_reply_waits_for_native_ack_preserves_errors_and_uses_current_turn() {
        let relay = PlanRelay::default();
        relay.observe(7, "server", &question("item-1", &["First?"]));
        relay.observe(7, "server", &json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"active-turn"}}}));
        let plan = relay.pending(0, &json!("item-1")).unwrap();
        let (done, rx) = mpsc::sync_channel(1);
        let reply = Reply { request_id: json!("item-1"), answers: HashMap::from([(plan.questions[0].id.clone(), vec!["No".into()])]), done };
        let message = relay.async_response(7, &reply).unwrap().unwrap();
        assert_eq!(message["method"], "turn/steer");
        assert_eq!(message["params"]["expectedTurnId"], "active-turn");
        assert!(message["params"]["input"][0]["text"].as_str().unwrap().contains("questionItemId"));
        assert!(relay.async_response(7, &reply).is_err());
        assert!(rx.try_recv().is_err());
        assert!(!relay.observe(7, "server", &json!({"id":message["id"],"error":{"message":"turn changed"}})));
        assert_eq!(rx.recv().unwrap(), Err("turn changed".into()));
        assert!(relay.pending(7, &json!("item-1")).is_some());
        relay.observe(7, "server", &json!({"method":"turn/completed","params":{"threadId":"thread-1"}}));
        let message = relay.async_response(7, &reply).unwrap().unwrap();
        assert_eq!(message["method"], "turn/start");
        assert!(!relay.observe(7, "server", &json!({"id":message["id"],"result":{"turn":{"id":"new"}}})));
        assert_eq!(rx.recv().unwrap(), Ok(()));
        assert!(relay.pending(7, &json!("item-1")).is_none());
    }
    #[test]
    fn native_answer_closes_on_acceptance_before_the_agent_consumes_it() {
        let relay = PlanRelay::default();
        relay.observe(3, "server", &question("item-1", &["First?"]));
        let request = json!({"id":5,"method":"turn/steer","params":{"threadId":"thread-1","expectedTurnId":"turn-1","input":[{"type":"text","text":"Continue with the test environment"}]}});
        relay.observe(3, "client", &request);
        assert!(relay.pending(3, &json!("item-1")).is_some());
        assert!(relay.observe(3, "server", &json!({"id":5,"error":{"message":"not accepted"}})));
        assert!(relay.pending(3, &json!("item-1")).is_some());
        relay.observe(3, "client", &request);
        assert!(relay.observe(4, "server", &json!({"id":5,"result":{}})));
        assert!(relay.pending(3, &json!("item-1")).is_some());
        assert!(relay.observe(3, "server", &json!({"id":5,"result":{}})), "native ACK must still reach the TUI");
        assert!(relay.pending(3, &json!("item-1")).is_none());
    }
}
