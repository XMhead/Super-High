use std::{env, io::Write, path::PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::fs_ops::{ensure_dragon_core_at, write_dragon_output_data_url_at};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DragonExportResult {
    output_path: String,
}

pub(crate) fn handle_dragon(
    args: &mut Vec<String>,
    stdout: &mut dyn std::io::Write,
) -> anyhow::Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_dragon_help(stdout);
    }

    let subcommand = args.remove(0);
    match subcommand.as_str() {
        "ensure" => dragon_ensure(args, stdout),
        "export-data-url" => dragon_export_data_url(args, stdout),
        _ => bail!("unknown dragon command `{subcommand}`. Run `superhigh-cli dragon --help`."),
    }
}

pub(crate) fn write_dragon_help(stdout: &mut dyn std::io::Write) -> anyhow::Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli dragon ensure [--project <path>] [--json]
  superhigh-cli dragon export-data-url <data-url> [--project <path>] [--output <name>] [--json]
"
    )?;
    Ok(())
}

fn dragon_ensure(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    let project = take_project(args)?;
    ensure_no_unexpected_options(args)?;
    ensure_no_positionals(args)?;

    let info = ensure_dragon_core_at(&project)?;
    if json {
        return write_json(stdout, &info);
    }

    writeln!(stdout, "DragonCore: {}", info.dragon_core_path)?;
    writeln!(stdout, "Config: {}", info.config_path)?;
    writeln!(stdout, "Output: {}", info.output_path)?;
    Ok(())
}

fn dragon_export_data_url(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    let project = take_project(args)?;
    let output = take_option(args, "--output")?;
    ensure_no_unexpected_options(args)?;
    if args.len() != 1 {
        bail!("dragon export-data-url requires <data-url>");
    }
    let data_url = args.remove(0);

    let output_path = write_dragon_output_data_url_at(&project, &data_url, output.as_deref())?;
    if json {
        return write_json(stdout, &DragonExportResult { output_path });
    }

    writeln!(stdout, "Exported {output_path}")?;
    Ok(())
}

fn take_project(args: &mut Vec<String>) -> Result<PathBuf> {
    match take_option(args, "--project")? {
        Some(path) => Ok(PathBuf::from(path)),
        None => env::current_dir().context("failed to resolve current directory"),
    }
}

fn take_option(args: &mut Vec<String>, name: &str) -> Result<Option<String>> {
    let mut value = None;
    let prefix = format!("{name}=");
    let mut index = 0;
    while index < args.len() {
        let current = args[index].clone();
        if current == name {
            if index + 1 >= args.len() {
                bail!("{name} requires a value");
            }
            if value.is_some() {
                bail!("{name} was provided more than once");
            }
            value = Some(args.remove(index + 1));
            args.remove(index);
            continue;
        }
        if let Some(raw) = current.strip_prefix(&prefix) {
            if value.is_some() {
                bail!("{name} was provided more than once");
            }
            value = Some(raw.to_string());
            args.remove(index);
            continue;
        }
        index += 1;
    }
    Ok(value)
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
