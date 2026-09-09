use std::{fs, io::Write, path::Path};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{
    models::{RemoteConnectionConfig, RemoteDriveStatus},
    remote_server::{
        default_remote_connection_config, map_remote_drive, remote_drive_status, unmap_remote_drive,
    },
};

pub(crate) fn handle_remote(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_remote_help(stdout);
    }

    let subcommand = args.remove(0);
    match subcommand.as_str() {
        "status" => remote_status(args, stdout),
        "map" => remote_map(args, stdout),
        "unmap" => remote_unmap(args, stdout),
        _ => bail!("unknown remote command `{subcommand}`. Run `superhigh-cli remote --help`."),
    }
}

pub(crate) fn write_remote_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli remote status [--config-file <json>] [--json]
  superhigh-cli remote map [--config-file <json>] [--json]
  superhigh-cli remote unmap <drive-letter> [--json]
"
    )?;
    Ok(())
}

fn remote_status(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    let config = take_config(args)?;
    ensure_no_unexpected_options(args)?;
    ensure_no_positionals(args)?;

    let status = remote_drive_status(&config);
    if json {
        return write_json(stdout, &status);
    }

    write_status_summary(stdout, &status)
}

fn remote_map(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    let config = take_config(args)?;
    ensure_no_unexpected_options(args)?;
    ensure_no_positionals(args)?;

    let result = map_remote_drive(&config);
    if json {
        return write_json(stdout, &result);
    }

    if result.success {
        writeln!(
            stdout,
            "✓ 已映射 {} → {}",
            result.drive_letter, result.unc_path
        )?;
    } else {
        writeln!(
            stdout,
            "✗ 映射失败 {} → {}: {}",
            result.drive_letter,
            result.unc_path,
            result.error.as_deref().unwrap_or("未知错误")
        )?;
    }
    Ok(())
}

fn remote_unmap(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let json = take_flag(args, "--json");
    ensure_no_unexpected_options(args)?;
    if args.len() != 1 {
        bail!("remote unmap requires <drive-letter>");
    }

    let letter = args.remove(0);
    let result = unmap_remote_drive(&letter);
    if json {
        return write_json(stdout, &result);
    }

    if result.success {
        writeln!(stdout, "✓ 已断开 {}", result.drive_letter)?;
    } else {
        writeln!(
            stdout,
            "✗ 断开失败 {}: {}",
            result.drive_letter,
            result.error.as_deref().unwrap_or("未知错误")
        )?;
    }
    Ok(())
}

fn write_status_summary(stdout: &mut dyn Write, status: &RemoteDriveStatus) -> Result<()> {
    let ok_count = status.checks.iter().filter(|c| c.ok).count();
    writeln!(
        stdout,
        "Tailscale: {}",
        if status.tailscale_available {
            "可用"
        } else {
            "未检测到"
        }
    )?;
    writeln!(
        stdout,
        "映射状态: {}",
        if status.drive_mapped {
            format!("{} → {} ✓", status.local_path, status.unc_path)
        } else {
            "未映射".to_string()
        }
    )?;
    writeln!(stdout, "工作区根目录: {}", status.workspace_root)?;
    writeln!(stdout, "检查: {}/{} ok", ok_count, status.checks.len())?;
    for check in &status.checks {
        let marker = if check.ok { "✓" } else { "✗" };
        writeln!(stdout, "[{}] {} — {}", marker, check.label, check.detail)?;
    }
    Ok(())
}

fn take_config(args: &mut Vec<String>) -> Result<RemoteConnectionConfig> {
    match take_option(args, "--config-file")? {
        Some(path) => read_config_file(&path),
        None => Ok(default_remote_connection_config()),
    }
}

fn read_config_file(path: &str) -> Result<RemoteConnectionConfig> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("failed to read config file {}", display_path(path)))?;
    serde_json::from_str(&content).with_context(|| {
        format!(
            "failed to parse RemoteConnectionConfig from {}",
            display_path(path)
        )
    })
}

fn display_path(path: &str) -> String {
    Path::new(path).to_string_lossy().replace('\\', "/")
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
