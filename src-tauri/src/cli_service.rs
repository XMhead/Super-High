use std::{io::Write, path::Path};

use anyhow::{bail, Result};

use crate::local_control::{self, ServiceBridgeError, ServiceBridgeRequest, ServiceBridgeResponse};

#[derive(Default)]
struct ServiceOptions {
    project_path: Option<String>,
    service_id: Option<String>,
    json: bool,
}

pub fn handle_service(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_help(stdout);
    }
    let operation = args.remove(0);
    if !matches!(operation.as_str(), "status" | "start" | "stop" | "restart") {
        bail!("unknown service command `{operation}`. Run `superhigh-cli service --help`.");
    }
    let options = parse_options(args)?;
    let project_path = options
        .project_path
        .ok_or_else(|| anyhow::anyhow!("service {operation} requires --project <absolute path>"))?;
    if !Path::new(&project_path).is_absolute() {
        bail!("service {operation} requires an absolute --project path");
    }
    let request = ServiceBridgeRequest {
        operation,
        project_path,
        service_id: options.service_id,
    };
    let response = match local_control::send_request(&request) {
        Ok(response) => response,
        Err(error) => ServiceBridgeResponse {
            ok: false,
            receipt: None,
            error: Some(ServiceBridgeError {
                kind: connection_error_kind(&error.to_string()).to_string(),
                message: error.to_string(),
            }),
        },
    };
    if options.json {
        serde_json::to_writer_pretty(&mut *stdout, &response)?;
        writeln!(stdout)?;
    } else if let Some(receipt) = &response.receipt {
        writeln!(stdout, "{}", receipt.summary)?;
        for service in &receipt.services {
            let message = service
                .message
                .as_deref()
                .map(|value| format!(": {value}"))
                .unwrap_or_default();
            writeln!(
                stdout,
                "{}: {}{}",
                service.service_id, service.status, message
            )?;
        }
    }
    if !response.ok {
        let error = response
            .error
            .as_ref()
            .expect("failed response has an error");
        bail!("{}: {}", error.kind, error.message);
    }
    Ok(())
}

fn parse_options(args: &mut Vec<String>) -> Result<ServiceOptions> {
    let mut options = ServiceOptions::default();
    let index = 0;
    while index < args.len() {
        let current = args[index].clone();
        if current == "--json" {
            options.json = true;
            args.remove(index);
            continue;
        }
        if current == "--project" || current == "--service" {
            if index + 1 >= args.len() {
                bail!("{current} requires a value");
            }
            let value = args.remove(index + 1);
            args.remove(index);
            let target = if current == "--project" {
                &mut options.project_path
            } else {
                &mut options.service_id
            };
            if target.replace(value).is_some() {
                bail!("{current} was provided more than once");
            }
            continue;
        }
        if let Some(value) = current.strip_prefix("--project=") {
            if options.project_path.replace(value.to_string()).is_some() {
                bail!("--project was provided more than once");
            }
            args.remove(index);
            continue;
        }
        if let Some(value) = current.strip_prefix("--service=") {
            if options.service_id.replace(value.to_string()).is_some() {
                bail!("--service was provided more than once");
            }
            args.remove(index);
            continue;
        }
        if current.starts_with('-') {
            bail!("unknown option `{current}`");
        }
        bail!("unexpected argument `{current}`");
    }
    Ok(options)
}

fn connection_error_kind(message: &str) -> &'static str {
    if message.starts_with("bridge busy:") {
        "bridge_busy"
    } else {
        "bridge_unavailable"
    }
}

fn is_help(value: &str) -> bool {
    matches!(value, "help" | "-h" | "--help")
}

fn write_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli service status --project <absolute path> [--service <id>] [--json]
  superhigh-cli service start --project <absolute path> [--service <id>] [--json]
  superhigh-cli service stop --project <absolute path> --service client [--json]
  superhigh-cli service restart --project <absolute path> [--service <id>] [--json]

Uses the running Super High application's managed local terminal. The bridge is
available after a newer Super High has been started; this CLI never starts a
project script or PTY by itself.
"
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{connection_error_kind, parse_options};

    #[test]
    fn parses_service_options_in_any_order() {
        let mut args = vec![
            "--json".to_string(),
            "--service=server".to_string(),
            "--project".to_string(),
            "D:/server/plugins".to_string(),
        ];
        let options = parse_options(&mut args).unwrap();
        assert!(options.json);
        assert_eq!(options.service_id.as_deref(), Some("server"));
        assert_eq!(options.project_path.as_deref(), Some("D:/server/plugins"));
    }

    #[test]
    fn classifies_busy_bridge_errors() {
        assert_eq!(connection_error_kind("bridge busy: retry"), "bridge_busy");
        assert_eq!(
            connection_error_kind("bridge unavailable: start app"),
            "bridge_unavailable"
        );
    }
}
