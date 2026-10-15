//! Claude AskUserQuestion / ExitPlanMode prompts reach the notice through a PermissionRequest hook.
//! The hook races the native dialog: whichever answers first applies, the other is discarded.
use crate::codex_plan::{PlanOption, PlanQuestion, PlanRequest};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const EXIT_PLAN_ID: &str = "__exit_plan__";
const APPROVE: &str = "批准并执行";
const REVISE: &str = "继续修改计划";
const MATCHER: &str = "^(AskUserQuestion|ExitPlanMode)$";
const REQUEST: &str = ".request.json";
const REPLY: &str = ".reply.json";

/// Adds the session-scoped plan hooks next to the change-capture hooks.
pub(crate) fn install_hooks(hooks: &mut serde_json::Map<String, Value>, executable: &str, queue: &str) {
    let ask = format!("\"{executable}\" claude-plan-hook --queue \"{queue}\"");
    let resolve = format!("\"{executable}\" claude-plan-hook --resolve --queue \"{queue}\"");
    // A day-long timeout keeps the notice answerable; the native dialog stays usable meanwhile.
    hooks.insert("PermissionRequest".into(), json!([{"matcher":MATCHER,"hooks":[{"type":"command","command":ask,"timeout":86400}]}]));
    for event in ["PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop"] {
        let mut entry = json!({"hooks":[{"type":"command","command":resolve,"timeout":10}]});
        if event.starts_with("PostToolUse") { entry["matcher"] = json!(MATCHER); }
        let list = hooks.entry(event).or_insert_with(|| json!([]));
        if let Some(list) = list.as_array_mut() { list.push(entry); }
    }
}

fn plans_dir(queue: &Path) -> PathBuf { queue.join("plans") }

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub(crate) fn plan_request(event: &Value) -> Option<PlanRequest> {
    let input = &event["tool_input"];
    let questions = match event["tool_name"].as_str()? {
        "AskUserQuestion" => input["questions"].as_array()?.iter().filter_map(|q| {
            let question = q["question"].as_str()?.to_owned();
            Some(PlanQuestion {
                id: question.clone(),
                header: q["header"].as_str().unwrap_or_default().into(),
                question,
                options: q["options"].as_array().into_iter().flatten().filter_map(|o| Some(PlanOption {
                    label: o["label"].as_str()?.into(),
                    description: o["description"].as_str().unwrap_or_default().into(),
                })).collect(),
                is_secret: false,
                multi_select: q["multiSelect"].as_bool().unwrap_or_default(),
            })
        }).collect::<Vec<_>>(),
        "ExitPlanMode" => vec![PlanQuestion {
            id: EXIT_PLAN_ID.into(),
            header: "计划审批".into(),
            question: input["plan"].as_str().filter(|plan| !plan.trim().is_empty())
                .unwrap_or("（未读取到计划内容，请回到原会话查看）").into(),
            options: vec![
                PlanOption { label: APPROVE.into(), description: "退出 Plan 模式并按计划执行".into() },
                PlanOption { label: REVISE.into(), description: "在补充说明写修改意见，Claude 继续完善计划".into() },
            ],
            is_secret: false,
            multi_select: false,
        }],
        _ => return None,
    };
    if questions.is_empty() { return None }
    Some(PlanRequest { connection: 0, request_id: Value::Null, thread_id: event["session_id"].as_str().unwrap_or_default().into(), questions })
}

/// Builds the PermissionRequest decision; both tools need updatedInput to accept an answer.
pub(crate) fn decision(event: &Value, answers: &HashMap<String, Vec<String>>) -> Value {
    let input = &event["tool_input"];
    let output = if event["tool_name"] == "ExitPlanMode" {
        let values = answers.get(EXIT_PLAN_ID).cloned().unwrap_or_default();
        if values.iter().any(|v| v == APPROVE) {
            json!({"behavior":"allow","updatedInput":input})
        } else {
            let notes: Vec<_> = values.into_iter().filter(|v| v != REVISE && !v.trim().is_empty()).collect();
            let message = if notes.is_empty() { "用户要求继续修改计划".into() } else { notes.join("\n") };
            json!({"behavior":"deny","message":message})
        }
    } else {
        let mut updated = input.clone();
        let selected: serde_json::Map<String, Value> = answers.iter()
            .map(|(question, values)| (question.clone(), json!(values.join(", ")))).collect();
        updated["answers"] = Value::Object(selected);
        json!({"behavior":"allow","updatedInput":updated})
    };
    json!({"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":output}})
}

fn atomic_json(path: &Path, value: &Value) -> Result<()> {
    let temp = path.with_extension("pending");
    let mut file = fs::File::create(&temp)?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    Ok(())
}

/// Invoked by superhigh-cli. Prints a decision only when the notice answered first.
pub fn run_hook(args: &[String]) -> i32 {
    let _ = (|| -> Result<()> {
        let queue = args.windows(2).find(|pair| pair[0] == "--queue").map(|p| PathBuf::from(&p[1])).context("missing hook queue")?;
        let plans = plans_dir(&queue);
        anyhow::ensure!(plans.is_dir(), "plan relay has ended");
        let mut input = Vec::new();
        std::io::stdin().take(8 * 1024 * 1024).read_to_end(&mut input)?;
        if args.iter().any(|arg| arg == "--resolve") {
            // The tool ran or the turn moved on: the native dialog has already been answered.
            for entry in fs::read_dir(&plans)?.flatten() {
                if entry.file_name().to_string_lossy().ends_with(REQUEST) { let _ = fs::remove_file(entry.path()); }
            }
            return Ok(());
        }
        let event: Value = serde_json::from_slice(&input)?;
        let mut request = plan_request(&event).context("unsupported plan tool")?;
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let name = format!("{nanos:030}-{}", uuid::Uuid::new_v4());
        request.request_id = json!(name);
        let request_path = plans.join(format!("{name}{REQUEST}"));
        let reply_path = plans.join(format!("{name}{REPLY}"));
        atomic_json(&request_path, &json!({"request":request,"event":event}))?;
        loop {
            if let Ok(bytes) = fs::read(&reply_path) {
                let answers: HashMap<String, Vec<String>> = serde_json::from_slice(&bytes)?;
                let _ = fs::remove_file(&request_path);
                print!("{}", decision(&event, &answers));
                let _ = std::io::stdout().flush();
                let _ = fs::remove_file(&reply_path);
                return Ok(());
            }
            if !request_path.is_file() { return Ok(()); }
            thread::sleep(Duration::from_millis(100));
        }
    })();
    0
}

pub(crate) fn prepare_dir(queue: &Path) -> Result<()> { Ok(fs::create_dir_all(plans_dir(queue))?) }

pub(crate) fn pending(queue: &Path, id: &Value) -> Option<PlanRequest> {
    let name = id.as_str().filter(|name| valid_name(name))?;
    let raw = fs::read(plans_dir(queue).join(format!("{name}{REQUEST}"))).ok()?;
    serde_json::from_value(serde_json::from_slice::<Value>(&raw).ok()?["request"].take()).ok()
}

pub(crate) fn reply(queue: &Path, id: &Value, answers: HashMap<String, Vec<String>>) -> Result<()> {
    let request = pending(queue, id).context("该 Plan 问题已结束，请回到原会话查看")?;
    anyhow::ensure!(request.questions.iter().all(|q| answers.get(&q.id).is_some_and(|values|
        !values.is_empty() && values.iter().all(|v| !v.trim().is_empty()))), "请回答全部问题");
    let name = id.as_str().unwrap_or_default();
    let request_path = plans_dir(queue).join(format!("{name}{REQUEST}"));
    let reply_path = plans_dir(queue).join(format!("{name}{REPLY}"));
    atomic_json(&reply_path, &serde_json::to_value(&answers)?)?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while request_path.is_file() {
        if Instant::now() >= deadline {
            let _ = fs::remove_file(&reply_path);
            anyhow::bail!("等待 Claude 回复超时，请检查原会话");
        }
        thread::sleep(Duration::from_millis(50));
    }
    // A remaining reply means the terminal answered first and the hook was discarded.
    thread::sleep(Duration::from_millis(200));
    if fs::remove_file(&reply_path).is_ok() { anyhow::bail!("该 Plan 问题已在终端回答"); }
    Ok(())
}

/// Announces each new hook request once.
pub(crate) fn watch(queue: PathBuf, stopping: Arc<AtomicBool>, on_plan: Arc<dyn Fn(PlanRequest) + Send + Sync>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut seen = HashSet::new();
        while !stopping.load(Ordering::Acquire) {
            let mut names: Vec<String> = fs::read_dir(plans_dir(&queue)).into_iter().flatten().flatten()
                .filter_map(|entry| entry.file_name().to_string_lossy().strip_suffix(REQUEST).map(str::to_owned))
                .collect();
            names.sort();
            seen.retain(|name: &String| names.contains(name));
            for name in names {
                if seen.contains(&name) { continue }
                if let Some(request) = pending(&queue, &json!(name)) {
                    seen.insert(name);
                    on_plan(request);
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_ask_user_question_and_exit_plan_mode() {
        let ask = json!({"session_id":"s1","tool_name":"AskUserQuestion","tool_input":{"questions":[
            {"question":"Pick a color?","header":"Color","multiSelect":true,"options":[{"label":"Red","description":"r"},{"label":"Blue","description":"b"}]}]}});
        let request = plan_request(&ask).unwrap();
        assert_eq!(request.thread_id, "s1");
        assert!(request.questions[0].multi_select);
        let answers = HashMap::from([("Pick a color?".to_owned(), vec!["Red".to_owned(), "Blue".to_owned()])]);
        let output = decision(&ask, &answers);
        assert_eq!(output["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(output["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["Pick a color?"], "Red, Blue");
        assert_eq!(output["hookSpecificOutput"]["decision"]["updatedInput"]["questions"][0]["header"], "Color");

        let exit = json!({"session_id":"s1","tool_name":"ExitPlanMode","tool_input":{"plan":"# Plan","planFilePath":"p.md"}});
        assert_eq!(plan_request(&exit).unwrap().questions[0].question, "# Plan");
        let approve = decision(&exit, &HashMap::from([(EXIT_PLAN_ID.to_owned(), vec![APPROVE.to_owned()])]));
        assert_eq!(approve["hookSpecificOutput"]["decision"]["updatedInput"]["planFilePath"], "p.md");
        let revise = decision(&exit, &HashMap::from([(EXIT_PLAN_ID.to_owned(), vec![REVISE.to_owned(), "补测试".to_owned()])]));
        assert_eq!(revise["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(revise["hookSpecificOutput"]["decision"]["message"], "补测试");
    }

    #[test]
    fn install_keeps_existing_event_entries() {
        let mut hooks = serde_json::Map::new();
        hooks.insert("PostToolUse".into(), json!([{"matcher":"^(Edit|Write|Bash)$","hooks":[]}]));
        install_hooks(&mut hooks, "cli.exe", "queue");
        assert_eq!(hooks["PostToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(hooks["PermissionRequest"][0]["matcher"], MATCHER);
        assert!(hooks["Stop"][0].get("matcher").is_none());
    }
}
