//! CLI flags map to the same tool contracts exposed through MCP.
use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::io::{Read, Write};

pub(crate) fn handle_agent(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.len() < 2
        || args
            .iter()
            .take(2)
            .any(|s| matches!(s.as_str(), "help" | "--help" | "-h"))
    {
        return help(stdout);
    }
    let operation = format!("{}_{}", args[0], args[1]);
    if args
        .get(2)
        .is_some_and(|s| matches!(s.as_str(), "help" | "--help" | "-h"))
    {
        return help(stdout);
    }
    let arguments = parse(&operation, &args[2..])?;
    let response = crate::agent_control::call(&operation, arguments)?;
    // Always machine-readable, including failures. --json is accepted for consistency.
    serde_json::to_writer_pretty(&mut *stdout, &response)?;
    writeln!(stdout)?;
    if response["ok"] != true {
        bail!(
            "{}",
            response["error"]["message"]
                .as_str()
                .unwrap_or("agent operation failed")
        )
    }
    Ok(())
}

fn parse(operation: &str, args: &[String]) -> Result<Value> {
    let mut values = Map::new();
    let mut iter = args.iter();
    let mut prompt_file = None;
    while let Some(arg) = iter.next() {
        let key = match arg.as_str() {
            "--json" => continue,
            "--include-logs" => {
                anyhow::ensure!(
                    values.insert("includeLogs".into(), json!(true)).is_none(),
                    "duplicate --include-logs"
                );
                continue;
            }
            "--project" => "project",
            "--provider" => "provider",
            "--session" => "sessionId",
            "--task" => "taskId",
            "--prompt" => "prompt",
            "--request-id" => "requestId",
            "--timeout-ms" => "timeoutMs",
            "--offset" => "offset",
            "--prompt-file" => {
                anyhow::ensure!(prompt_file.is_none(), "duplicate --prompt-file");
                prompt_file = Some(
                    iter.next()
                        .context("--prompt-file requires a path or - for stdin")?
                        .clone(),
                );
                continue;
            }
            _ => bail!("unknown agent argument: {arg}"),
        };
        let raw = iter
            .next()
            .with_context(|| format!("{arg} requires a value"))?;
        let value = if matches!(key, "timeoutMs" | "offset") {
            json!(raw
                .parse::<u64>()
                .with_context(|| format!("{arg} requires a nonnegative integer"))?)
        } else {
            json!(raw)
        };
        anyhow::ensure!(
            values.insert(key.into(), value).is_none(),
            "duplicate {arg}"
        );
    }
    if let Some(path) = prompt_file {
        anyhow::ensure!(
            !values.contains_key("prompt"),
            "use --prompt OR --prompt-file"
        );
        let mut text = String::new();
        if path == "-" {
            std::io::stdin().take(65537).read_to_string(&mut text)?;
        } else {
            std::fs::File::open(&path)
                .with_context(|| format!("read {path}"))?
                .take(65537)
                .read_to_string(&mut text)?;
        }
        anyhow::ensure!(text.len() <= 65536, "prompt exceeds 65536 UTF-8 bytes");
        values.insert("prompt".into(), json!(text));
    }
    let arguments = Value::Object(values);
    crate::cli_mcp::validate_arguments(operation, &arguments)?;
    Ok(arguments)
}

fn help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(stdout, "Usage:
  superhigh-cli agent sessions list [--project <absolute path>] [--json]
  superhigh-cli agent sessions create --project <absolute path> --provider <codex|claude>
  superhigh-cli agent sessions get|close --session <session-id>
  superhigh-cli agent tasks submit --project <absolute path> --provider <codex|claude> --prompt <text>
  superhigh-cli agent tasks submit --session <session-id> --prompt-file <path|-> [--request-id <key>]
  superhigh-cli agent tasks list [--session <session-id>]
  superhigh-cli agent tasks get --task <task-id> [--offset <answer-byte-offset>] [--include-logs]
  superhigh-cli agent tasks wait --task <task-id> [--timeout-ms <0..30000>] [--include-logs]
  superhigh-cli agent tasks cancel --task <task-id>

All responses are JSON; --json is optional. Requires the running SuperHigh desktop.
Task IDs survive CLI/MCP disconnects, but not desktop restarts. Up to 256 retained tasks.
submitted means delivered, running means accepted, completed requires native evidence.
Use a unique --request-id to retry safely. Never blindly resubmit after a timeout.
Long answers have answerNextOffset. A wait timeout leaves the task running.
SUPERHIGH_SESSION_ID identifies internal callers and prevents self/ancestor delegation.
Sessions may need initial login, workspace trust or permission approval in the desktop.
See sessions get / --include-logs; this API never automatically approves those prompts.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn unicode_and_literal_flags_are_not_shell_interpreted() {
        let value = parse(
            "tasks_submit",
            &args(&[
                "--session",
                "session",
                "--prompt",
                "--help 中文\n$(literal)",
                "--json",
            ]),
        )
        .unwrap();
        assert_eq!(value["prompt"], "--help 中文\n$(literal)");
        assert!(parse("tasks_get", &args(&["--task", "t", "--task", "other"])).is_err());
        assert!(parse("tasks_get", &args(&["--task", "t", "--timeout-ms", "20"])).is_err());
    }
}
