//! Read-only views of native Codex child threads. Never submit turns or answer requests.
use std::{collections::{HashMap, HashSet}, net::{SocketAddr, TcpStream}, sync::Mutex, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::{Message, WebSocket};

const MAX_ITEMS: usize = 200;
const MAX_TEXT: usize = 64 * 1024;

#[derive(Clone, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStep {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub output: String,
    pub status: String,
    pub truncated: bool,
}

#[derive(Clone, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAgent {
    pub id: String,
    pub parent_id: String,
    pub parent_turn_id: String,
    pub name: String,
    pub role: String,
    pub model: String,
    pub task: String,
    pub task_encrypted: bool,
    pub status: String,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub steps: Vec<AgentStep>,
    pub answer: String,
    pub error: String,
    pub history_error: String,
    #[serde(skip)]
    pub call_id: String,
}

#[derive(Default)]
struct State {
    agents: HashMap<String, ChatAgent>,
    models: HashMap<String, String>,
    usages: HashMap<String, Value>,
    model_catalog: Option<Value>,
    config_requests: HashMap<(u64, String), (String, Value)>,
    config_model: String,
    config_effort: String,
    // Select one transport per thread so multiple clients do not duplicate deltas.
    connections: HashMap<String, u64>,
    hydrated: HashSet<String>,
    refreshed: HashMap<String, Instant>,
    errors: HashMap<String, String>,
    calls: HashMap<String, Value>,
}

pub struct CodexAgents {
    upstream: SocketAddr,
    state: Mutex<State>,
}

fn now() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64 }
fn text(value: &Value, key: &str) -> String { value[key].as_str().unwrap_or_default().to_owned() }
fn limited(value: &str) -> String {
    let mut end = value.len().min(MAX_TEXT);
    while !value.is_char_boundary(end) { end -= 1; }
    value[..end].to_owned()
}
fn append(target: &mut String, value: &str) {
    target.push_str(value);
    if target.len() > MAX_TEXT {
        let mut start = target.len() - MAX_TEXT;
        while !target.is_char_boundary(start) { start += 1; }
        target.drain(..start);
    }
}
fn node<'a>(state: &'a mut State, id: &str) -> &'a mut ChatAgent {
    state.agents.entry(id.into()).or_insert_with(|| ChatAgent { id: id.into(), status: "unknown".into(), ..Default::default() })
}
fn status(value: &Value) -> &str {
    match value.as_str().or_else(|| value["type"].as_str()).unwrap_or_default() {
        "active" | "inProgress" | "running" => "running",
        "idle" => "idle",
        "completed" => "completed",
        "failed" | "errored" | "systemError" => "failed",
        "interrupted" => "interrupted",
        "shutdown" | "closed" => "closed",
        _ => "unknown",
    }
}

impl CodexAgents {
    pub fn new(upstream: SocketAddr) -> Self { Self { upstream, state: Mutex::new(State::default()) } }

    pub fn model(&self, root: Option<&str>) -> String {
        let state = self.state.lock().unwrap();
        root.and_then(|id| state.models.get(id)).cloned().unwrap_or_else(|| {
            if state.config_model.is_empty() { String::new() }
            else { format!("{} {}", state.config_model, state.config_effort).trim().into() }
        })
    }

    pub fn controls(&self, root: Option<&str>) -> anyhow::Result<(String, Option<Value>, Value)> {
        let cached = self.state.lock().unwrap().model_catalog.clone();
        let catalog = if let Some(cached) = cached { cached } else {
            let mut reader = Reader::connect(self.upstream)?;
            let result = collect_model_pages(|cursor| reader.request("model/list", json!({"limit":100,"includeHidden":false,"cursor":cursor})))?;
            self.state.lock().unwrap().model_catalog = Some(result.clone());
            result
        };
        let state = self.state.lock().unwrap();
        let model = root.and_then(|id| state.models.get(id)).cloned().unwrap_or_else(|| format!("{} {}", state.config_model, state.config_effort).trim().into());
        Ok((model, root.and_then(|id| state.usages.get(id)).cloned(), catalog))
    }

    pub fn restore_links(&self, root: &str, links: &[Value]) {
        let mut state = self.state.lock().unwrap();
        for link in links {
            let id = text(link, "id");
            if id.is_empty() { continue; }
            let agent = node(&mut state, &id);
            if agent.parent_id.is_empty() { agent.parent_id = root.into(); }
            if agent.parent_turn_id.is_empty() { agent.parent_turn_id = text(link, "turnId"); }
            if agent.call_id.is_empty() { agent.call_id = text(link, "callId"); }
        }
    }

    pub fn observe(&self, envelope: &Value) {
        let connection = envelope["connection"].as_u64().unwrap_or_default();
        let mut state = self.state.lock().unwrap();
        if envelope["direction"] == "closed" {
            state.connections.retain(|_, owner| *owner != connection);
            state.config_requests.retain(|(owner, _), _| *owner != connection);
            return;
        }
        let message = &envelope["message"];
        let method = message["method"].as_str().unwrap_or_default();
        if envelope["direction"] == "client" && matches!(method, "config/read" | "config/value/write" | "config/batchWrite") {
            if let Some(id) = message.get("id") { state.config_requests.insert((connection, id.to_string()), (method.into(), message["params"].clone())); }
        }
        if envelope["direction"] != "server" { return; }
        if let Some(id) = message.get("id") {
            let result = &message["result"];
            if let Some((method, params)) = state.config_requests.remove(&(connection, id.to_string())) {
                if method == "config/read" {
                    if let Some(model) = result["config"]["model"].as_str().filter(|model| !model.is_empty()) {
                        state.config_model = model.into();
                        state.config_effort = text(&result["config"], "model_reasoning_effort");
                    }
                } else if message.get("result").is_some() && message.get("error").is_none() {
                    let edits = params["edits"].as_array().cloned().unwrap_or_else(|| vec![params]);
                    for edit in edits {
                        match edit["keyPath"].as_str() {
                            Some("model") if edit["value"].is_string() => state.config_model = text(&edit, "value"),
                            Some("model_reasoning_effort") => state.config_effort = text(&edit, "value"),
                            _ => continue,
                        }
                        // The TUI applies /model locally before the next turn updates native logs.
                        state.models.clear();
                    }
                }
            }
            if let (Some(thread), Some(model)) = (result["thread"]["id"].as_str(), result["model"].as_str().filter(|model| !model.is_empty())) {
                let effort = result["reasoningEffort"].as_str().unwrap_or_default();
                state.models.insert(thread.into(), format!("{model} {effort}").trim().into());
            }
        }
        let params = &message["params"];
        let Some(id) = params["threadId"].as_str() else { return; };
        if *state.connections.entry(id.into()).or_insert(connection) != connection { return; }
        let method = message["method"].as_str().unwrap_or_default();
        match method {
            "thread/tokenUsage/updated" => { state.usages.insert(id.into(), params["tokenUsage"].clone()); }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                discover(&mut state, id, &text(params, "turnId"), item);
                apply_item(node(&mut state, id), item, method == "item/completed", false);
            }
            "turn/started" => {
                let agent = node(&mut state, id);
                agent.status = "running".into();
                agent.started_at.get_or_insert_with(now);
                agent.completed_at = None;
            }
            "turn/completed" => {
                let agent = node(&mut state, id);
                agent.status = status(&params["turn"]["status"]).into();
                agent.completed_at = Some(now());
                agent.error = text(&params["turn"]["error"], "message");
            }
            "thread/status/changed" => {
                let agent = node(&mut state, id);
                let next = status(&params["status"]);
                // Idle is a runtime state; preserve the observed turn's terminal result.
                if next != "idle" || !matches!(agent.status.as_str(), "completed" | "failed" | "interrupted") {
                    agent.status = next.into();
                }
            }
            "thread/closed" => { node(&mut state, id).status = "closed".into(); }
            "item/agentMessage/delta" | "item/commandExecution/outputDelta" | "item/reasoning/summaryTextDelta" => {
                let agent = node(&mut state, id);
                let item_id = text(params, "itemId");
                let kind = if method.contains("commandExecution") { "tool" } else if method.contains("reasoning") { "think" } else { "text" };
                let step = item_step(agent, &item_id);
                step.kind = kind.into();
                step.truncated |= if kind == "tool" { step.output.len() } else { step.detail.len() } + text(params, "delta").len() > MAX_TEXT;
                if kind == "tool" { append(&mut step.output, &text(params, "delta")); }
                else { append(&mut step.detail, &text(params, "delta")); }
            }
            _ => {}
        }
    }

    /// Metadata/history requests use a separate connection, outside the TUI proxy.
    /// No resume, turn mutation, or server-request response is allowed here.
    pub fn read(&self, root: &str, calls: &HashMap<String, Value>) -> (Vec<ChatAgent>, Option<String>) {
        let refresh = {
            let mut state = self.state.lock().unwrap();
            if state.refreshed.get(root).is_some_and(|at| at.elapsed() < Duration::from_secs(10)) { false }
            else { state.refreshed.insert(root.into(), Instant::now()); true }
        };
        if refresh {
            let result = self.hydrate(root);
            let mut state = self.state.lock().unwrap();
            match result {
                Ok(()) => { state.errors.remove(root); }
                Err(error) => { state.errors.insert(root.into(), error.to_string()); }
            }
        }
        let state = self.state.lock().unwrap();
        let mut agents: Vec<_> = state.agents.values().filter(|agent| descendant(&state, &agent.id, root)).cloned().collect();
        for agent in &mut agents {
            if let Some(call) = calls.get(&agent.call_id).or_else(|| state.calls.get(&agent.call_id)) {
                agent.task_encrypted = call["encrypted"] == true;
                if agent.task_encrypted { agent.task.clear(); }
                else if let Some(task) = call["message"].as_str() { agent.task = task.into(); }
                if agent.role.is_empty() { agent.role = text(call, "agent_type"); }
                if let Some(name) = call["task_name"].as_str() { agent.name = name.into(); }
                if agent.model.is_empty() { agent.model = text(call, "model"); }
                if agent.parent_turn_id.is_empty() { agent.parent_turn_id = text(call, "turnId"); }
            }
            if agent.name.is_empty() { agent.name = format!("子 Agent {}", agent.id.chars().take(8).collect::<String>()); }
            // Nested agents stay with the originating main-thread turn.
            let mut parent = agent.parent_id.as_str();
            for _ in 0..64 {
                if parent == root { break; }
                let Some(ancestor) = state.agents.get(parent) else { break; };
                if !ancestor.parent_turn_id.is_empty() { agent.parent_turn_id = ancestor.parent_turn_id.clone(); }
                parent = &ancestor.parent_id;
            }
        }
        agents.sort_by(|a, b| a.started_at.cmp(&b.started_at).then(a.id.cmp(&b.id)));
        (agents, state.errors.get(root).cloned())
    }

    fn hydrate(&self, root: &str) -> anyhow::Result<()> {
        let mut client = Reader::connect(self.upstream)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut cursor = Value::Null;
        for _ in 0..10 {
            let result = client.request("thread/list", json!({"ancestorThreadId":root,"sourceKinds":["subAgentThreadSpawn"],"limit":100,"cursor":cursor}))?;
            for thread in result["data"].as_array().into_iter().flatten() {
                let id = text(thread, "id");
                if id.is_empty() || id == root { continue; }
                let needs_history = {
                    let mut state = self.state.lock().unwrap();
                    metadata(node(&mut state, &id), thread);
                    !state.hydrated.contains(&id)
                };
                if needs_history && Instant::now() < deadline {
                    let history = client.request("thread/read", json!({"threadId":id,"includeTurns":true}));
                    let native = history.as_ref().ok().and_then(|result| result["thread"]["path"].as_str())
                        .and_then(|path| crate::cli_chat::read_chat("codex", path).ok());
                    let mut state = self.state.lock().unwrap();
                    if let Some(native) = native {
                        state.calls.extend(native.agent_calls);
                        for link in native.agent_links {
                            let child = text(&link, "id");
                            if child.is_empty() { continue; }
                            let agent = node(&mut state, &child);
                            if agent.parent_id.is_empty() { agent.parent_id = id.clone(); }
                            if agent.parent_turn_id.is_empty() { agent.parent_turn_id = text(&link, "turnId"); }
                            if agent.call_id.is_empty() { agent.call_id = text(&link, "callId"); }
                        }
                    }
                    let agent = node(&mut state, &id);
                    match history {
                        Ok(result) => { merge_history(agent, &result["thread"]); state.hydrated.insert(id); }
                        Err(error) => { agent.history_error = format!("历史记录暂不可用：{error}"); }
                    }
                }
            }
            cursor = result["nextCursor"].clone();
            if cursor.is_null() || Instant::now() >= deadline { break; }
        }
        Ok(())
    }
}

fn descendant(state: &State, id: &str, root: &str) -> bool {
    if id == root { return false; }
    let mut current = id;
    for _ in 0..64 {
        let Some(agent) = state.agents.get(current) else { return false; };
        if agent.parent_id == root { return true; }
        if agent.parent_id.is_empty() || agent.parent_id == current { return false; }
        current = &agent.parent_id;
    }
    false
}

fn metadata(agent: &mut ChatAgent, thread: &Value) {
    if let Some(parent) = thread["parentThreadId"].as_str() { agent.parent_id = parent.into(); }
    for (target, key) in [(&mut agent.name, "agentNickname"), (&mut agent.role, "agentRole")] {
        if target.is_empty() { *target = text(thread, key); }
    }
    if agent.task.is_empty() { agent.task = text(thread, "preview"); }
    if agent.model.is_empty() { agent.model = text(thread, "model"); }
    if agent.started_at.is_none() { agent.started_at = thread["createdAt"].as_i64().map(|at| at * 1000); }
    if agent.status == "unknown" { agent.status = status(&thread["status"]).into(); }
}

fn discover(state: &mut State, parent: &str, turn: &str, item: &Value) {
    let kind = item["type"].as_str().unwrap_or_default();
    if kind == "subAgentActivity" {
        let id = text(item, "agentThreadId");
        if id.is_empty() { return; }
        let agent = node(state, &id);
        if item["kind"] == "started" {
            agent.parent_id = parent.into();
            agent.parent_turn_id = turn.into();
            agent.call_id = text(item, "id");
        }
        if agent.name.is_empty() { agent.name = text(item, "agentPath"); }
        if agent.model.is_empty() { agent.model = text(item, "model"); }
        match item["kind"].as_str() {
            Some("completed") => { agent.status = "completed".into(); agent.completed_at = Some(now()); }
            Some("interrupted") => { agent.status = "interrupted".into(); agent.completed_at = Some(now()); }
            _ if agent.status == "unknown" => { agent.status = "running".into(); }
            _ => {}
        }
        agent.started_at.get_or_insert_with(now);
    } else if kind == "collabAgentToolCall" {
        for id in item["receiverThreadIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            let agent = node(state, id);
            // send/wait can target a sibling; only spawn establishes parenthood.
            if item["tool"] == "spawnAgent" {
                agent.parent_id = parent.into();
                agent.parent_turn_id = turn.into();
                agent.call_id = text(item, "id");
                agent.started_at.get_or_insert_with(now);
            }
            if agent.task.is_empty() { agent.task = text(item, "prompt"); }
            if agent.model.is_empty() { agent.model = text(item, "model"); }
            let known = &item["agentsStates"][id];
            let next = status(&known["status"]);
            if next != "unknown" { agent.status = next.into(); }
        }
    }
}

fn item_step<'a>(agent: &'a mut ChatAgent, id: &str) -> &'a mut AgentStep {
    let index = agent.steps.iter().position(|step| step.id == id).unwrap_or_else(|| {
        if agent.steps.len() >= MAX_ITEMS { agent.steps.remove(0); }
        agent.steps.push(AgentStep { id: id.into(), status: "running".into(), ..Default::default() });
        agent.steps.len() - 1
    });
    &mut agent.steps[index]
}

fn apply_item(agent: &mut ChatAgent, item: &Value, completed: bool, history: bool) {
    let id = text(item, "id");
    if id.is_empty() { return; }
    let kind = item["type"].as_str().unwrap_or_default();
    if kind == "userMessage" {
        if agent.task.is_empty() { agent.task = item["content"].as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"); }
        return;
    }
    if matches!(kind, "subAgentActivity" | "collabAgentToolCall") { return; }
    let exists = agent.steps.iter().any(|step| step.id == id);
    // A disk snapshot must not overwrite text already received from the live stream.
    if history && exists { return; }
    let (step_kind, title, detail, output) = match kind {
        "agentMessage" => ("text", "说明".to_owned(), text(item, "text"), String::new()),
        "reasoning" => ("think", "思考摘要".into(), item["summary"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"), String::new()),
        "commandExecution" => ("tool", "运行命令".into(), text(item, "command"), text(item, "aggregatedOutput")),
        "fileChange" => ("tool", "修改文件".into(), item["changes"].as_array().into_iter().flatten().filter_map(|c| c["path"].as_str()).collect::<Vec<_>>().join("\n"), item["changes"].as_array().into_iter().flatten().filter_map(|c| c["diff"].as_str()).collect::<Vec<_>>().join("\n")),
        "mcpToolCall" => ("tool", format!("{}.{}", text(item, "server"), text(item, "tool")), item["arguments"].to_string(), item.get("result").filter(|v| !v.is_null()).map(Value::to_string).unwrap_or_default()),
        "webSearch" => ("tool", "搜索网页".into(), text(item, "query"), String::new()),
        _ => ("tool", kind.to_owned(), text(item, "prompt"), String::new()),
    };
    let final_answer = kind == "agentMessage" && item["phase"] == "final_answer";
    if final_answer { agent.answer = limited(&detail); }
    let step = item_step(agent, &id);
    step.kind = step_kind.into();
    step.title = title;
    if !detail.is_empty() { step.detail = limited(&detail); }
    if !output.is_empty() { step.output = limited(&output); }
    step.truncated |= detail.len() > MAX_TEXT || output.len() > MAX_TEXT;
    step.status = if completed { "completed" } else { "running" }.into();
    if item["status"] == "failed" || item["status"] == "declined" { step.status = "failed".into(); }
    if kind == "commandExecution" && item["exitCode"].as_i64().is_some_and(|code| code != 0) { step.status = "failed".into(); }
    if final_answer { step.title = "最终回答".into(); }
}

fn merge_history(agent: &mut ChatAgent, thread: &Value) {
    metadata(agent, thread);
    agent.history_error.clear();
    let had_live = !agent.steps.is_empty();
    let live_steps = std::mem::take(&mut agent.steps);
    for turn in thread["turns"].as_array().into_iter().flatten() {
        for item in turn["items"].as_array().into_iter().flatten() { apply_item(agent, item, turn["status"] != "inProgress", true); }
        if !had_live {
            agent.status = status(&turn["status"]).into();
            agent.started_at = turn["startedAt"].as_i64().map(|at| at * 1000).or(agent.started_at);
            agent.completed_at = turn["completedAt"].as_i64().map(|at| at * 1000);
            agent.error = text(&turn["error"], "message");
        }
    }
    let mut seen = HashSet::new();
    for step in &mut agent.steps {
        seen.insert(step.id.clone());
        if let Some(live) = live_steps.iter().find(|live| live.id == step.id) { *step = live.clone(); }
    }
    for step in live_steps { if !seen.contains(&step.id) { agent.steps.push(step); } }
    let excess = agent.steps.len().saturating_sub(MAX_ITEMS);
    agent.steps.drain(..excess);
}

fn collect_model_pages(mut request: impl FnMut(Option<&str>) -> anyhow::Result<Value>) -> anyhow::Result<Value> {
    let mut data = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    for _ in 0..20 {
        let page = request(cursor.as_deref())?;
        let entries = page["data"].as_array().ok_or_else(|| anyhow::anyhow!("model/list 缺少数据"))?;
        data.extend(entries.iter().cloned());
        let Some(next) = page["nextCursor"].as_str().filter(|s| !s.is_empty()) else { return Ok(json!({"data":data})); };
        anyhow::ensure!(seen.insert(next.to_owned()), "model/list 游标重复");
        cursor = Some(next.to_owned());
    }
    anyhow::bail!("model/list 超过 20 页，目录不完整")
}

struct Reader { socket: WebSocket<TcpStream>, next_id: u64 }
impl Reader {
    fn connect(upstream: SocketAddr) -> anyhow::Result<Self> {
        let stream = TcpStream::connect_timeout(&upstream, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let (socket, _) = tungstenite::client::client_with_config(
            format!("ws://{upstream}"), stream,
            Some(crate::codex_protocol_bridge::websocket_config()),
        )?;
        let mut client = Self { socket, next_id: 0 };
        client.request("initialize", json!({"clientInfo":{"name":"superhigh_agent_view","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}}))?;
        client.socket.send(Message::Text(json!({"method":"initialized","params":{}}).to_string().into()))?;
        Ok(client)
    }
    fn request(&mut self, method: &str, params: Value) -> anyhow::Result<Value> {
        anyhow::ensure!(matches!(method, "initialize" | "thread/list" | "thread/read" | "model/list"), "unsupported observer request");
        self.next_id += 1;
        let id = self.next_id;
        self.socket.send(Message::Text(json!({"id":id,"method":method,"params":params}).to_string().into()))?;
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            if let Message::Text(raw) = self.socket.read()? {
                let message: Value = serde_json::from_str(&raw)?;
                if message["id"].as_u64() != Some(id) || message.get("method").is_some() { continue; }
                if let Some(error) = message.get("error") { anyhow::bail!("{}", text(error, "message")); }
                return Ok(message["result"].clone());
            }
        }
        anyhow::bail!("子 Agent 记录查询超时")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(view: &CodexAgents, connection: u64, method: &str, params: Value) {
        view.observe(&json!({"connection":connection,"direction":"server","message":{"method":method,"params":params}}));
    }
    fn view() -> CodexAgents { CodexAgents::new("127.0.0.1:1".parse().unwrap()) }
    #[test]
    fn model_pages_follow_cursor_and_reject_incomplete() {
        let mut calls = 0;
        let result = collect_model_pages(|cursor| { calls += 1; Ok(if cursor.is_none() { json!({"data":[1],"nextCursor":"next"}) } else { json!({"data":[2],"nextCursor":null}) }) }).unwrap();
        assert_eq!(result["data"], json!([1,2]));
        assert_eq!(calls, 2);
        assert!(collect_model_pages(|_| Ok(json!({"data":[],"nextCursor":"repeat"}))).is_err());
    }
    #[test]
    fn model_uses_live_configuration_before_a_turn_and_keeps_threads_separate() {
        let view = view();
        view.observe(&json!({"connection":1,"direction":"client","message":{"id":1,"method":"config/read"}}));
        view.observe(&json!({"connection":2,"direction":"server","message":{"id":1,"result":{"config":{"model":"wrong"}}}}));
        assert_eq!(view.model(None), "");
        view.observe(&json!({"connection":1,"direction":"server","message":{"id":1,"result":{"config":{"model":"gpt-6.1-sol","model_reasoning_effort":"high"}}}}));
        assert_eq!(view.model(None), "gpt-6.1-sol high");
        view.observe(&json!({"connection":1,"direction":"server","message":{"id":2,"result":{"thread":{"id":"root"},"model":"gpt-6-astra","reasoningEffort":"medium"}}}));
        view.observe(&json!({"connection":1,"direction":"server","message":{"id":3,"result":{"thread":{"id":"title"},"model":"gpt-6-luna","reasoningEffort":"low"}}}));
        assert_eq!(view.model(Some("root")), "gpt-6-astra medium");
        view.observe(&json!({"connection":1,"direction":"client","message":{"id":4,"method":"config/batchWrite","params":{"edits":[{"keyPath":"model","value":"gpt-6.1-sol"},{"keyPath":"model_reasoning_effort","value":"medium"}]}}}));
        view.observe(&json!({"connection":1,"direction":"server","message":{"id":4,"result":{}}}));
        assert_eq!(view.model(Some("root")), "gpt-6.1-sol medium");
        view.observe(&json!({"connection":1,"direction":"client","message":{"id":5,"method":"config/value/write","params":{"keyPath":"model_reasoning_effort","value":"low"}}}));
        view.observe(&json!({"connection":1,"direction":"server","message":{"id":5,"error":{"message":"write failed"}}}));
        assert_eq!(view.model(Some("root")), "gpt-6.1-sol medium");
    }
    fn spawn(view: &CodexAgents, parent: &str, child: &str, call: &str) {
        observe(view, 1, "item/completed", json!({"threadId":parent,"turnId":"main-turn","item":{"type":"subAgentActivity","kind":"started","id":call,"agentThreadId":child,"agentPath":format!("/root/{child}"),"model":"gpt-6.1-sol"}}));
    }

    #[test]
    fn child_output_is_deduplicated_and_completed_item_repairs_missing_deltas() {
        let view = view();
        spawn(&view, "root", "child", "spawn");
        observe(&view, 1, "item/started", json!({"threadId":"child","item":{"type":"commandExecution","id":"cmd","command":"echo hello"}}));
        for connection in [1, 2] {
            observe(&view, connection, "item/commandExecution/outputDelta", json!({"threadId":"child","itemId":"cmd","delta":"hello"}));
        }
        assert_eq!(view.state.lock().unwrap().agents["child"].steps[0].output, "hello");
        observe(&view, 1, "item/completed", json!({"threadId":"child","item":{"type":"commandExecution","id":"cmd","command":"echo hello","aggregatedOutput":"hello world","exitCode":0}}));
        observe(&view, 1, "turn/completed", json!({"threadId":"child","turn":{"status":"completed"}}));
        observe(&view, 1, "thread/status/changed", json!({"threadId":"child","status":{"type":"idle"}}));
        let state = view.state.lock().unwrap();
        assert_eq!(state.agents["child"].steps.len(), 1);
        assert_eq!(state.agents["child"].steps[0].output, "hello world");
        assert_eq!(state.agents["child"].status, "completed");
        assert!(descendant(&state, "child", "root"));
        assert!(!descendant(&state, "child", "other-root"));
    }

    #[test]
    fn nested_agent_stays_in_its_tree_when_sibling_sends_input() {
        let view = view();
        spawn(&view, "root", "a", "a-call");
        spawn(&view, "a", "b", "b-call");
        observe(&view, 1, "item/completed", json!({"threadId":"sibling","turnId":"other-turn","item":{"type":"subAgentActivity","kind":"interacted","id":"send","agentThreadId":"b","agentPath":"/root/a/b"}}));
        let mut state = view.state.lock().unwrap();
        state.refreshed.insert("root".into(), Instant::now());
        drop(state);
        let (agents, error) = view.read("root", &HashMap::new());
        assert!(error.is_none());
        assert_eq!(agents.len(), 2);
        let child = agents.iter().find(|a| a.id == "b").unwrap();
        assert_eq!(child.parent_id, "a");
        assert_eq!(child.parent_turn_id, "main-turn");
    }

    #[test]
    fn restored_history_does_not_replace_in_progress_live_text() {
        let mut agent = ChatAgent::default();
        apply_item(&mut agent, &json!({"id":"live","type":"agentMessage","text":"new text"}), false, false);
        merge_history(&mut agent, &json!({"id":"child","parentThreadId":"root","turns":[{"status":"inProgress","items":[{"id":"old","type":"commandExecution","command":"ls","aggregatedOutput":"file"},{"id":"live","type":"agentMessage","text":"old text"}]}]}));
        assert_eq!(agent.steps.iter().find(|s| s.id == "live").unwrap().detail, "new text");
        assert_eq!(agent.steps.iter().find(|s| s.id == "old").unwrap().output, "file");
        assert_eq!(agent.parent_id, "root");
    }

    #[test]
    fn disconnect_allows_new_connection_and_failed_tools_keep_their_output() {
        let view = view();
        spawn(&view, "root", "child", "call");
        observe(&view, 1, "turn/started", json!({"threadId":"child"}));
        view.observe(&json!({"connection":1,"direction":"closed"}));
        observe(&view, 2, "item/completed", json!({"threadId":"child","item":{"id":"bad","type":"commandExecution","command":"bad","aggregatedOutput":"error","exitCode":1}}));
        let state = view.state.lock().unwrap();
        assert_eq!(state.agents["child"].steps[0].status, "failed");
        assert_eq!(state.agents["child"].steps[0].output, "error");
    }
}
