use std::{io::Write, path::Path};

use anyhow::{bail, Context, Result};

use crate::local_control::{
    self, ServiceBridgeError, TerminalBridgeRequest, TerminalBridgeResponse, TERMINAL_DEFAULT_TAIL,
    TERMINAL_MAX_TAIL,
};

pub fn handle_terminal(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty()
        || args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
    {
        return write_help(stdout);
    }
    let (request, json) = parse_options(args)?;
    let response = local_control::send_terminal_request(&request).unwrap_or_else(|error| {
        TerminalBridgeResponse {
            ok: false,
            sessions: None,
            logs: None,
            error: Some(ServiceBridgeError {
                kind: if error.to_string().starts_with("bridge busy:") {
                    "bridge_busy"
                } else {
                    "bridge_unavailable"
                }
                .to_string(),
                message: error.to_string(),
            }),
        }
    });
    if json {
        serde_json::to_writer_pretty(&mut *stdout, &response)?;
        writeln!(stdout)?;
    } else if let Some(sessions) = &response.sessions {
        for session in sessions {
            writeln!(
                stdout,
                "{}\t{}\t{}\t{}\t{}",
                session.id,
                if session.running { "running" } else { "exited" },
                session.provider_kind,
                session.title,
                session.cwd
            )?;
        }
        if sessions.is_empty() {
            writeln!(stdout, "No registered terminal sessions.")?;
        }
    } else if let Some(logs) = &response.logs {
        stdout.write_all(logs.text.as_bytes())?;
    }
    if !response.ok {
        let error = response
            .error
            .context("bridge returned an unsuccessful response without an error")?;
        bail!("{}: {}", error.kind, error.message);
    }
    Ok(())
}

fn parse_options(args: &mut Vec<String>) -> Result<(TerminalBridgeRequest, bool)> {
    let operation = args.remove(0);
    if !matches!(operation.as_str(), "list" | "logs") {
        bail!("unknown terminal command `{operation}`. Run `superhigh-cli terminal --help`.");
    }
    let mut project_path = None;
    let mut session_id = None;
    let mut tail = None;
    let mut json = false;
    while !args.is_empty() {
        let arg = args.remove(0);
        if arg == "--json" {
            json = true;
            continue;
        }
        let (key, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(key, value)| (key, Some(value)));
        if matches!(key, "--project" | "--tail" | "--session") {
            let value = if let Some(value) = inline {
                value.to_string()
            } else {
                anyhow::ensure!(
                    !args.is_empty() && !args[0].starts_with('-'),
                    "{key} requires a value"
                );
                args.remove(0)
            };
            anyhow::ensure!(!value.trim().is_empty(), "{key} requires a value");
            match key {
                "--project" => {
                    anyhow::ensure!(
                        project_path.replace(value).is_none(),
                        "--project was provided more than once"
                    );
                }
                "--session" => {
                    anyhow::ensure!(
                        session_id.replace(value).is_none(),
                        "session ID was provided more than once"
                    );
                }
                _ => {
                    let value = value
                        .parse::<usize>()
                        .context("--tail must be an integer")?;
                    anyhow::ensure!(
                        (1..=TERMINAL_MAX_TAIL).contains(&value),
                        "--tail must be between 1 and {TERMINAL_MAX_TAIL}"
                    );
                    anyhow::ensure!(
                        tail.replace(value).is_none(),
                        "--tail was provided more than once"
                    );
                }
            }
        } else if !arg.starts_with('-') && operation == "logs" {
            anyhow::ensure!(
                session_id.replace(arg).is_none(),
                "session ID was provided more than once"
            );
        } else {
            bail!("unexpected argument `{arg}`");
        }
    }
    if let Some(project) = &project_path {
        anyhow::ensure!(
            Path::new(project).is_absolute(),
            "--project requires an absolute path"
        );
    }
    if operation == "list" {
        anyhow::ensure!(
            session_id.is_none() && tail.is_none(),
            "terminal list does not accept --session or --tail"
        );
    } else {
        anyhow::ensure!(
            session_id
                .as_deref()
                .is_some_and(|id| !id.trim().is_empty()),
            "terminal logs requires a session ID"
        );
    }
    Ok((
        TerminalBridgeRequest {
            operation: format!("terminal.{operation}"),
            project_path,
            session_id,
            tail,
        },
        json,
    ))
}

fn write_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli terminal list [--project <absolute path>] [--json]
  superhigh-cli terminal logs <session-id> [--project <absolute path>] [--tail <lines>] [--json]

Uses the running Super High application's registered terminals. --project filters
by terminal launch directory (the project directory or its descendants).
logs also accepts --session <id>. Default tail: {TERMINAL_DEFAULT_TAIL} lines;
maximum: {TERMINAL_MAX_TAIL} lines and 32 KiB. Output is the existing PTY buffer,
including ANSI sequences; it is not a saved transcript or rendered screen.
JSON reports truncation and byte offsets. Exited sessions may briefly remain;
their buffers disappear when the application removes them."
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }
    #[test]
    fn parses_log_selection_and_limits() {
        let (request, json) =
            parse_options(&mut args(&["logs", "abc", "--tail=12", "--json"])).unwrap();
        assert_eq!(request.operation, "terminal.logs");
        assert_eq!(request.session_id.as_deref(), Some("abc"));
        assert_eq!(request.tail, Some(12));
        assert!(json);
    }
    #[test]
    fn rejects_ambiguous_or_unbounded_requests() {
        for values in [
            vec!["logs"],
            vec!["logs", "a", "--session", "b"],
            vec!["list", "--tail=1"],
            vec!["logs", "a", "--tail=0"],
            vec!["logs", "a", "--tail=2001"],
            vec!["list", "--project=relative"],
        ] {
            assert!(parse_options(&mut args(&values)).is_err(), "{values:?}");
        }
    }
}
