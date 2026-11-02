//! Minimal MCP tools server over newline-delimited stdio. stdout is protocol-only.
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL: &str = "2025-11-25";
const MAX_MESSAGE: usize = 256 * 1024;

fn string(description: &str) -> Value {
    json!({"type":"string", "minLength":1, "description":description})
}
fn schema(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object", "properties": properties, "required":required, "additionalProperties":false})
}

pub(crate) fn tools() -> Vec<Value> {
    let session =
        || string("SuperHigh terminal session ID, not the provider's native conversation ID.");
    let task = || string("SuperHigh task ID returned by tasks_submit.");
    let project = || string("Existing absolute workspace directory on this computer.");
    let provider = || json!({"type":"string", "enum":["codex","claude"], "description":"CLI provider installed on this computer."});
    let output = json!({"type":"object", "required":["ok"], "properties":{
        "ok":{"type":"boolean"}, "result":{"type":"object"}, "error":{"type":"object"}}, "additionalProperties":false});
    [
        ("sessions_list", "List SuperHigh's Codex/Claude sessions and active task IDs. Includes your caller session when known.", schema(json!({"project":project()}), &[]), true, false),
        ("sessions_create", "Create a visible, desktop-owned Codex or Claude Code session. Use tasks_submit to give it work.", schema(json!({"project":project(),"provider":provider()}), &["project","provider"]), false, false),
        ("sessions_get", "Inspect a session's current native turn and bounded raw terminal logs, including startup or approval prompts.", schema(json!({"sessionId":session()}), &["sessionId"]), true, false),
        ("sessions_close", "Close an idle session created through agent control. Refuses active tasks and sessions created elsewhere.", schema(json!({"sessionId":session()}), &["sessionId"]), false, true),
        ("tasks_submit", "Delegate a task to an idle existing sessionId OR create a new session with project+provider. Returns immediately after delivery; submitted is not accepted/completed. Reuse requestId when retrying the same submission.",
            schema(json!({"sessionId":session(),"project":project(),"provider":provider(),
                "prompt":{"type":"string","minLength":1,"maxLength":65536,"description":"Task instructions. Delivered via a workspace task file."},
                "requestId":{"type":"string","minLength":1,"maxLength":128,"description":"Optional unique retry key, scoped to the caller session and current desktop lifetime."}}), &["prompt"]), false, false),
        ("tasks_list", "Recover task IDs and inspect retained task states. Desktop lifetime only; up to 256 tasks, oldest finished records evicted first.", schema(json!({"sessionId":session()}), &[]), true, false),
        ("tasks_get", "Read a task's proven status, native turn ID, answer, recent tool activity and changes. Page long answers with answerNextOffset. includeLogs helps diagnose unaccepted tasks or permission prompts.",
            schema(json!({"taskId":task(), "offset":{"type":"integer","minimum":0,"description":"UTF-8 byte offset into the answer; use answerNextOffset."},
                "includeLogs":{"type":"boolean","default":false}}), &["taskId"]), true, false),
        ("tasks_wait", "Wait up to 30 seconds for task completion. waitTimedOut leaves the task running. Repeat as needed; disconnecting does not cancel work.",
            schema(json!({"taskId":task(), "timeoutMs":{"type":"integer","minimum":0,"maximum":30000,"default":10000},
                "offset":{"type":"integer","minimum":0},"includeLogs":{"type":"boolean","default":false}}), &["taskId"]), true, false),
        ("tasks_cancel", "Request interruption of this task's confirmed current native turn. cancelling is not confirmation; query/wait afterwards. Refuses unaccepted tasks or a different current turn.", schema(json!({"taskId":task()}), &["taskId"]), false, true),
    ].into_iter().map(|(name, description, input, read_only, destructive)| json!({
        "name":name,"description":description,"inputSchema":input,"outputSchema":output,
        "annotations":{"readOnlyHint":read_only,"destructiveHint":destructive,"idempotentHint":read_only,"openWorldHint":!read_only}
    })).collect()
}

pub(crate) fn validate_arguments(name: &str, arguments: &Value) -> Result<()> {
    let catalog = tools();
    let tool = catalog
        .iter()
        .find(|tool| tool["name"] == name)
        .ok_or_else(|| anyhow::anyhow!("unknown tool: {name}"))?;
    let args = arguments
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("arguments must be an object"))?;
    let input = &tool["inputSchema"];
    for key in input["required"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
    {
        anyhow::ensure!(args.contains_key(key), "missing required argument: {key}");
    }
    for (key, value) in args {
        let prop = &input["properties"][key];
        anyhow::ensure!(!prop.is_null(), "unknown argument: {key}");
        match prop["type"].as_str().unwrap_or_default() {
            "string" => {
                let value = value
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("{key} must be a string"))?;
                anyhow::ensure!(!value.trim().is_empty(), "{key} must not be empty");
                if let Some(max) = prop["maxLength"].as_u64() {
                    anyhow::ensure!(value.chars().count() <= max as usize, "{key} is too long");
                }
                if let Some(choices) = prop["enum"].as_array() {
                    anyhow::ensure!(
                        choices.iter().any(|choice| choice == value),
                        "unsupported {key}"
                    );
                }
            }
            "integer" => {
                let number = value
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("{key} must be a nonnegative integer"))?;
                if let Some(max) = prop["maximum"].as_u64() {
                    anyhow::ensure!(number <= max, "{key} exceeds {max}");
                }
            }
            "boolean" => anyhow::ensure!(value.is_boolean(), "{key} must be boolean"),
            _ => bail!("unsupported argument type"),
        }
    }
    if name == "tasks_submit" {
        let existing = args.contains_key("sessionId");
        anyhow::ensure!(
            if existing {
                !args.contains_key("project") && !args.contains_key("provider")
            } else {
                args.contains_key("project") && args.contains_key("provider")
            },
            "use sessionId OR both project and provider"
        );
    }
    Ok(())
}

pub(crate) fn handle_mcp(args: &[String], stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty()
        || args
            .iter()
            .any(|s| matches!(s.as_str(), "help" | "--help" | "-h"))
    {
        writeln!(stdout, "Usage: superhigh-cli mcp serve\nRuns a stdio MCP server connected to the running SuperHigh desktop.\nConfigure your MCP client with command=superhigh-cli, args=[mcp, serve].")?;
        return Ok(());
    }
    anyhow::ensure!(args == ["serve"], "Usage: superhigh-cli mcp serve");
    serve(std::io::stdin().lock(), stdout)
}

fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message.into()}})
}

#[derive(Default)]
struct ProtocolState {
    initialized: bool,
    ready: bool,
}
impl ProtocolState {
    fn handle(
        &mut self,
        message: Value,
        call: &impl Fn(&str, Value) -> Result<Value>,
    ) -> Option<Value> {
        let id = message.get("id").cloned();
        let method = message.get("method").and_then(Value::as_str);
        if !message.is_object()
            || message["jsonrpc"] != "2.0"
            || method.is_none()
            || id
                .as_ref()
                .is_some_and(|id| !(id.is_string() || id.is_i64() || id.is_u64()))
        {
            return Some(error(Value::Null, -32600, "Invalid JSON-RPC request"));
        }
        let method = method.unwrap();
        if id.is_none() {
            if method == "notifications/initialized" && self.initialized {
                self.ready = true;
            }
            // Cancellation ends a client's wait, never a desktop-owned task. tasks_cancel is explicit.
            return None;
        }
        let id = id.unwrap();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        if !params.is_object() {
            return Some(error(id, -32602, "params must be an object"));
        }
        let result = match method {
            "initialize" => {
                if self.initialized {
                    return Some(error(id, -32600, "Already initialized"));
                }
                let Some(version) = params["protocolVersion"].as_str() else {
                    return Some(error(id, -32602, "protocolVersion is required"));
                };
                if !params["capabilities"].is_object()
                    || !params["clientInfo"]["name"].is_string()
                    || !params["clientInfo"]["version"].is_string()
                {
                    return Some(error(
                        id,
                        -32602,
                        "clientInfo and capabilities are required",
                    ));
                }
                self.initialized = true;
                let version = if matches!(version, "2025-06-18" | "2025-11-25") {
                    version
                } else {
                    PROTOCOL
                };
                json!({"protocolVersion":version,"capabilities":{"tools":{}},
                    "serverInfo":{"name":"superhigh","version":env!("CARGO_PKG_VERSION")},
                    "instructions":"Control SuperHigh-owned Codex/Claude Code sessions on this computer. Prefer tasks_submit with project+provider for new work, or list sessions to continue an idle conversation. Poll tasks_get/tasks_wait by taskId. submitted means delivered, running means a native turn accepted it, completed requires native completion. Inspect sessions_get/includeLogs for startup or approval prompts; never treat PTY silence as completion or auto-approve prompts. Reuse requestId after uncertain submission failures. Tasks survive MCP disconnects, not desktop restarts. Do not delegate to yourself or ancestors."})
            }
            "ping" => json!({}),
            _ if !self.ready => {
                return Some(error(
                    id,
                    -32000,
                    "Complete initialize and notifications/initialized first",
                ))
            }
            "tools/list" => json!({"tools":tools()}),
            "tools/call" => {
                let Some(name) = params["name"].as_str() else {
                    return Some(error(id, -32602, "tool name is required"));
                };
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if let Err(failure) = validate_arguments(name, &arguments) {
                    return Some(error(id, -32602, failure.to_string()));
                }
                let response = call(name, arguments).unwrap_or_else(|failure|
                    json!({"ok":false,"error":{"code":"bridge_unavailable","message":failure.to_string()}}));
                json!({"content":[{"type":"text","text":response.to_string()}],
                    "structuredContent":response,"isError":response["ok"] != true})
            }
            _ => return Some(error(id, -32601, "Method not found")),
        };
        Some(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
}

fn serve(mut input: impl BufRead, output: &mut dyn Write) -> Result<()> {
    let mut state = ProtocolState::default();
    loop {
        let mut line = Vec::new();
        // Bound memory before decoding, including clients that omit a newline.
        let count = std::io::Read::take(&mut input, (MAX_MESSAGE + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        anyhow::ensure!(line.len() <= MAX_MESSAGE, "MCP message exceeds 256 KiB");
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let response = match serde_json::from_slice::<Value>(&line) {
            Ok(message) => state.handle(message, &crate::agent_control::call),
            Err(_) => Some(error(Value::Null, -32700, "Parse error")),
        };
        if let Some(response) = response {
            serde_json::to_writer(&mut *output, &response)?;
            writeln!(output)?;
            output.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn init(state: &mut ProtocolState) {
        let call = |_: &str, _: Value| -> Result<Value> { panic!("no tool call expected") };
        let response = state.handle(json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}), &call).unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert!(state
            .handle(
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                &call
            )
            .is_none());
    }
    #[test]
    fn agent_mcp_lifecycle_tool_discovery_and_structured_errors() {
        let call =
            |_: &str, _: Value| Ok(json!({"ok":false,"error":{"code":"busy","message":"busy"}}));
        let mut state = ProtocolState::default();
        let list = json!({"jsonrpc":"2.0","id":1,"method":"tools/list"});
        assert!(state
            .handle(list.clone(), &call)
            .unwrap()
            .get("error")
            .is_some());
        init(&mut state);
        assert_eq!(
            state.handle(list, &call).unwrap()["result"]["tools"]
                .as_array()
                .unwrap()
                .len(),
            9
        );
        let response = state.handle(json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"tasks_submit","arguments":{"sessionId":"s","prompt":"中文"}}}), &call).unwrap();
        assert_eq!(response["result"]["isError"], true);
        assert_eq!(
            response["result"]["structuredContent"]["error"]["code"],
            "busy"
        );
    }
    #[test]
    fn agent_mcp_invalid_arguments_never_reach_the_desktop() {
        assert!(validate_arguments(
            "tasks_submit",
            &json!({"sessionId":"s","provider":"codex","prompt":"x"})
        )
        .is_err());
        assert!(validate_arguments("tasks_submit", &json!({"prompt":"x"})).is_err());
        assert!(
            validate_arguments("tasks_wait", &json!({"taskId":"t","timeoutMs":30001})).is_err()
        );
        assert!(validate_arguments("tasks_cancel", &json!({"taskId":"t","all":true})).is_err());
        assert!(validate_arguments(
            "sessions_create",
            &json!({"project":"project","provider":"local"})
        )
        .is_err());
    }
    #[test]
    fn agent_mcp_stdio_is_newline_json_only_and_bad_json_is_recoverable() {
        let mut out = Vec::new();
        serve(
            &b"oops\n{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"ping\"}\n"[..],
            &mut out,
        )
        .unwrap();
        let messages = String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["error"]["code"], -32700);
        assert_eq!(messages[1]["id"], 4);
        assert!(messages[1].get("result").is_some());
    }
}
