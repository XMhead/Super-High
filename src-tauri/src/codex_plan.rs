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
    Some(PlanRequest { connection, request_id, thread_id: params["threadId"].as_str()?.into(), questions })
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
    }
    pub fn pending(&self, connection: u64, id: &Value) -> Option<PlanRequest> {
        self.0.lock().unwrap().pending.get(&key(connection, id)).cloned()
    }
    // Return false only for a late duplicate response from the TUI.
    pub fn observe(&self, connection: u64, direction: &str, message: &Value) -> bool {
        let mut state = self.0.lock().unwrap();
        if direction == "client" && message.get("method").is_none() {
            let k = key(connection, &message["id"]);
            if state.sent.contains(&k) { return false }
            state.pending.remove(&k);
        } else if direction == "server" {
            if let Some(request) = request(connection, message) {
                state.sent.remove(&key(connection, &request.request_id));
                state.pending.insert(key(connection, &request.request_id), request);
            } else if message["method"] == "serverRequest/resolved" {
                state.pending.remove(&key(connection, &message["params"]["requestId"]));
            } else if matches!(message["method"].as_str(), Some("turn/completed" | "turn/started" | "thread/closed")) {
                let thread = message["params"]["threadId"].as_str().unwrap_or_default();
                state.pending.retain(|(c, _), request| *c != connection || request.thread_id != thread);
            }
        }
        true
    }
    pub fn reply(&self, connection: u64, id: Value, answers: HashMap<String, Vec<String>>) -> Result<()> {
        let sender = {
            let state = self.0.lock().unwrap();
            let request = state.pending.get(&key(connection, &id)).context("该 Plan 问题已结束，请回到原会话查看")?;
            anyhow::ensure!(answers.len() == request.questions.len() && request.questions.iter().all(|q|
                answers.get(&q.id).is_some_and(|values| !values.is_empty() && values.iter().all(|v| !v.trim().is_empty()))), "请回答全部问题");
            state.connections.get(&connection).context("Codex 连接已关闭")?.clone()
        };
        let (done, received) = mpsc::sync_channel(1);
        sender.send(Reply { request_id: id, answers, done }).context("Codex 连接已关闭")?;
        received.recv_timeout(Duration::from_secs(5)).context("等待 Codex 回复超时，请检查原会话")?.map_err(anyhow::Error::msg)
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
