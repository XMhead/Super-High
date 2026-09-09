use std::io::Write;

use anyhow::{bail, Result};
use serde::Serialize;

use crate::terminal;

pub(crate) fn handle_env(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_env_help(stdout);
    }

    let subcommand = args.remove(0);
    match subcommand.as_str() {
        "cli" => env_cli(args, stdout),
        _ => bail!("unknown env command `{subcommand}`. Run `superhigh-cli env --help`."),
    }
}

pub(crate) fn write_env_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli env cli [--json]
"
    )?;
    Ok(())
}

fn env_cli(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    ensure_no_positionals(args)?;

    let environments = terminal::detect_cli_environments();
    if json {
        return write_json(stdout, &environments);
    }

    writeln!(stdout, "CLI environments:")?;
    for environment in environments {
        let status = if environment.available {
            "OK"
        } else {
            "MISSING"
        };
        let detail = environment
            .resolved_path
            .as_deref()
            .or(environment.issue.as_deref())
            .unwrap_or("-");
        writeln!(
            stdout,
            "[{}] {} ({}) - {}",
            status, environment.name, environment.command, detail
        )?;
    }
    Ok(())
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    let mut found = false;
    let mut index = 0;
    while index < args.len() {
        if args[index] == name {
            found = true;
            args.remove(index);
            continue;
        }
        index += 1;
    }
    found
}

fn ensure_no_unexpected_options(args: &[String]) -> Result<()> {
    if let Some(option) = args.iter().find(|arg| arg.starts_with('-')) {
        bail!("unknown option `{option}`");
    }
    Ok(())
}

fn ensure_no_positionals(args: &[String]) -> Result<()> {
    if let Some(value) = args.first() {
        bail!("unexpected argument `{value}`");
    }
    Ok(())
}

fn write_json<T: Serialize>(stdout: &mut dyn Write, value: &T) -> Result<()> {
    serde_json::to_writer_pretty(&mut *stdout, value)?;
    writeln!(stdout)?;
    Ok(())
}

fn is_help(value: &str) -> bool {
    matches!(value, "help" | "-h" | "--help")
}
