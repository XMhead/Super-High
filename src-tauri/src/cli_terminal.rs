use std::io::Write;

use anyhow::{bail, Context, Result};

use crate::local_control::{
    self, ServiceBridgeError, TerminalBridgeRequest, TerminalBridgeResponse, TERMINAL_DEFAULT_TAIL,
    TERMINAL_MAX_TAIL,
};

pub fn handle_terminal(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty()
        || matches!(args[0].as_str(), "--help" | "-h" | "help")
        || (args.len() == 2 && matches!(args[1].as_str(), "--help" | "-h"))
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
    } else if response.ok {
        writeln!(stdout, "OK")?;
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
    anyhow::ensure!(
        matches!(
            operation.as_str(),
            "list" | "logs" | "create" | "write" | "key" | "resize" | "close"
        ),
        "unknown terminal command `{operation}`. Run `superhigh-cli terminal --help`."
    );
    let mut request = TerminalBridgeRequest {
        operation: format!("terminal.{operation}"),
        project_path: None,
        session_id: None,
        tail: None,
        provider_kind: None,
        input: None,
        key: None,
        cols: None,
        rows: None,
        enter: None,
    };
    let mut json = false;
    while !args.is_empty() {
        let arg = args.remove(0);
        if arg == "--json" {
            json = true;
            continue;
        }
        if arg == "--enter" {
            anyhow::ensure!(
                request.enter.replace(true).is_none(),
                "--enter was provided more than once"
            );
            continue;
        }
        let (key, inline) = arg
            .split_once('=')
            .map_or((arg.as_str(), None), |(key, value)| (key, Some(value)));
        if matches!(
            key,
            "--project"
                | "--session"
                | "--tail"
                | "--provider"
                | "--input"
                | "--key"
                | "--cols"
                | "--rows"
        ) {
            let value = if let Some(value) = inline {
                value.to_string()
            } else {
                anyhow::ensure!(!args.is_empty(), "{key} requires a value");
                args.remove(0)
            };
            if key != "--input" {
                anyhow::ensure!(!value.trim().is_empty(), "{key} requires a value");
            }
            let duplicate = match key {
                "--project" => request.project_path.replace(value).is_some(),
                "--session" => request.session_id.replace(value).is_some(),
                "--provider" => request.provider_kind.replace(value).is_some(),
                "--input" => request.input.replace(value).is_some(),
                "--key" => request.key.replace(value).is_some(),
                "--tail" => request
                    .tail
                    .replace(value.parse().context("--tail must be an integer")?)
                    .is_some(),
                "--cols" => request
                    .cols
                    .replace(
                        value
                            .parse()
                            .context("--cols must be an integer between 1 and 65535")?,
                    )
                    .is_some(),
                _ => request
                    .rows
                    .replace(
                        value
                            .parse()
                            .context("--rows must be an integer between 1 and 65535")?,
                    )
                    .is_some(),
            };
            anyhow::ensure!(!duplicate, "{key} was provided more than once");
        } else if !arg.starts_with('-') && !matches!(operation.as_str(), "list" | "create") {
            anyhow::ensure!(
                request.session_id.replace(arg).is_none(),
                "session ID was provided more than once"
            );
        } else {
            bail!("unexpected argument `{arg}`");
        }
    }
    local_control::validate_terminal_request(&request)?;
    Ok((request, json))
}

fn write_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli terminal list [--project <absolute path>] [--json]
  superhigh-cli terminal logs <session-id> [--tail <lines>] [--json]
  superhigh-cli terminal create --project <absolute path> [--provider <kind>] [--json]
  superhigh-cli terminal write <session-id> --input <text> [--enter] [--json]
  superhigh-cli terminal key <session-id> --key <key> [--json]
  superhigh-cli terminal resize <session-id> --cols <columns> --rows <rows> [--json]
  superhigh-cli terminal close <session-id> [--json]

Requires the running Super High application. create defaults to provider local
(PowerShell); other providers use the same launch path as the desktop application.
write sends literal text, without interpreting escapes; --enter appends Enter.
Keys: ctrl+c, enter, escape, tab, backspace, ctrl+d. Ctrl+C sends a PTY control
character; close terminates the specified session and its child processes.
Session commands also accept --session <id> and --project <absolute path> to
restrict selection to terminals launched in that directory or its descendants.
logs reads the existing PTY buffer, including ANSI sequences. Default tail:
{TERMINAL_DEFAULT_TAIL} lines; maximum: {TERMINAL_MAX_TAIL} lines and 32 KiB.
JSON reports truncation and byte offsets. Exited buffers are eventually removed.
CLI-created sessions are registered in TerminalManager; use list/logs to inspect them."
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
    #[test]
    fn parses_literal_input_and_controls() {
        let (request, _) =
            parse_options(&mut args(&["write", "abc", "--input", "--help", "--enter"])).unwrap();
        assert_eq!(request.input.as_deref(), Some("--help"));
        assert_eq!(request.enter, Some(true));
        let (request, _) = parse_options(&mut args(&["key", "abc", "--key=ctrl+c"])).unwrap();
        assert_eq!(request.key.as_deref(), Some("ctrl+c"));
        for values in [
            vec!["close"],
            vec!["write", "abc"],
            vec!["key", "abc", "--key=nope"],
            vec!["resize", "abc", "--cols=0", "--rows=24"],
            vec!["close", "abc", "--enter"],
        ] {
            assert!(parse_options(&mut args(&values)).is_err(), "{values:?}");
        }
    }
}
