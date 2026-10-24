use serde_json::Value;
use std::{collections::HashSet, sync::{Arc, Mutex}};

#[derive(Default)]
struct SessionIdentity {
    pending: HashSet<(u64, String)>,
}

impl SessionIdentity {
    fn observe(&mut self, envelope: &Value) -> Option<String> {
        let connection = envelope["connection"].as_u64().unwrap_or_default();
        let message = &envelope["message"];
        let id = message.get("id")?;
        let key = (connection, id.to_string());
        if envelope["direction"] == "client" {
            if matches!(message["method"].as_str(), Some("thread/start" | "thread/resume" | "thread/fork"))
                && message["params"]["threadSource"] != "thread_title"
            {
                self.pending.insert(key);
            }
            return None;
        }
        if envelope["direction"] != "server" || !self.pending.remove(&key) {
            return None;
        }
        let thread = &message["result"]["thread"];
        if thread["threadSource"] == "thread_title" || thread["parentThreadId"].as_str().is_some() {
            return None;
        }
        thread["id"].as_str().filter(|id| !id.is_empty()).map(str::to_owned)
    }
}

pub(crate) fn observer(on_session: Arc<dyn Fn(String) + Send + Sync>) -> Arc<dyn Fn(Value) + Send + Sync> {
    let identity = Mutex::new(SessionIdentity::default());
    Arc::new(move |envelope| {
        let native = identity.lock().unwrap().observe(&envelope);
        if let Some(native) = native {
            on_session(native);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binds_only_matching_foreground_requests() {
        let mut identity = SessionIdentity::default();
        assert_eq!(identity.observe(&json!({"connection":1,"direction":"client","message":{"id":7,"method":"thread/start","params":{}}})), None);
        assert_eq!(identity.observe(&json!({"connection":2,"direction":"server","message":{"id":7,"result":{"thread":{"id":"other"}}}})), None);
        assert_eq!(identity.observe(&json!({"connection":1,"direction":"server","message":{"id":7,"result":{"thread":{"id":"main"}}}})), Some("main".into()));
        identity.observe(&json!({"direction":"client","message":{"id":8,"method":"thread/start","params":{"threadSource":"thread_title"}}}));
        assert_eq!(identity.observe(&json!({"direction":"server","message":{"id":8,"result":{"thread":{"id":"title"}}}})), None);
        identity.observe(&json!({"direction":"client","message":{"id":9,"method":"thread/fork","params":{}}}));
        assert_eq!(identity.observe(&json!({"direction":"server","message":{"id":9,"result":{"thread":{"id":"child","parentThreadId":"main"}}}})), None);
    }

    #[test]
    fn binds_resumed_sessions_without_observing_turn_changes() {
        let mut identity = SessionIdentity::default();
        identity.observe(&json!({"direction":"client","message":{"id":"resume","method":"thread/resume","params":{}}}));
        assert_eq!(identity.observe(&json!({"direction":"server","message":{"id":"resume","result":{"thread":{"id":"resumed"}}}})), Some("resumed".into()));
        assert_eq!(identity.observe(&json!({"direction":"server","message":{"method":"turn/diff/updated","params":{"threadId":"unrelated","diff":"content"}}})), None);
    }
}
