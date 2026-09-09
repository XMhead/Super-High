use std::{collections::HashMap, env, io::Write, path::PathBuf};

use anyhow::{bail, Context, Result};

use crate::script_tools::{self, ScriptToolRunResponse};

#[derive(Default)]
struct Options {
    project: Option<PathBuf>,
    json: bool,
    tool_id: Option<String>,
    values: HashMap<String, String>,
}

pub(crate) fn handle_tools(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || matches!(args[0].as_str(), "--help" | "-h" | "help") {
        return write_tools_help(stdout);
    }
    let operation = args.remove(0);
    if !matches!(operation.as_str(), "list" | "run") {
        bail!("unknown tools command `{operation}`. Run `superhigh-cli tools --help`.");
    }
    if args.len() == 1 && matches!(args[0].as_str(), "--help" | "-h") {
        return write_tools_help(stdout);
    }
    let options = parse_options(args, operation == "run")?;
    let project = match options.project {
        Some(project) => project,
        None => env::current_dir().context("failed to resolve current directory")?,
    };
    if operation == "list" {
        let result = script_tools::list_project_script_tools(&project)?;
        if options.json {
            serde_json::to_writer_pretty(&mut *stdout, &result)?;
            writeln!(stdout)?;
        } else {
            for tool in result.tools {
                writeln!(
                    stdout,
                    "{}: {} ({})",
                    tool.id, tool.display_name, tool.source_path
                )?;
                for parameter in tool.parameters {
                    let kind = if parameter.parameter_type.is_empty() {
                        "string"
                    } else {
                        &parameter.parameter_type
                    };
                    if let Some(literal) = parameter.literal {
                        writeln!(stdout, "  {}: fixed {:?}", parameter.id, literal)?;
                    } else {
                        writeln!(
                            stdout,
                            "  --arg {}=<{}>{}",
                            parameter.id,
                            kind,
                            if parameter.required {
                                " (required)"
                            } else {
                                ""
                            }
                        )?;
                    }
                }
            }
        }
        return Ok(());
    }
    let response = script_tools::run_project_script_tool_checked(
        &project,
        options.tool_id.as_deref().expect("run requires tool id"),
        &options.values,
    )?;
    write_run_result(&response, options.json, stdout)
}

fn write_run_result(
    response: &ScriptToolRunResponse,
    json: bool,
    stdout: &mut dyn Write,
) -> Result<()> {
    if json {
        serde_json::to_writer_pretty(&mut *stdout, response)?;
        writeln!(stdout)?;
    } else {
        if !response.stdout.is_empty() {
            writeln!(stdout, "{}", response.stdout)?;
        }
        if !response.stderr.is_empty() {
            writeln!(stdout, "stderr: {}", response.stderr)?;
        }
    }
    if response.exit_code != Some(0) {
        bail!(
            "tool `{}` failed (exit code: {:?})",
            response.tool_id,
            response.exit_code
        );
    }
    Ok(())
}

fn parse_options(args: &[String], run: bool) -> Result<Options> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let current = &args[index];
        if current == "--json" {
            if options.json {
                bail!("--json was provided more than once");
            }
            options.json = true;
        } else if current == "--project" || current.starts_with("--project=") {
            let value = option_value(args, &mut index, "--project")?;
            if value.trim().is_empty() {
                bail!("--project requires a nonempty path");
            }
            if options.project.replace(PathBuf::from(value)).is_some() {
                bail!("--project was provided more than once");
            }
        } else if current == "--arg" || current.starts_with("--arg=") {
            if !run {
                bail!("tools list does not accept --arg");
            }
            let value = option_value(args, &mut index, "--arg")?;
            let (key, value) = value.split_once('=').context("--arg requires key=value")?;
            if key.is_empty() || key.trim() != key {
                bail!("--arg requires a nonempty argument name without surrounding whitespace");
            }
            if options
                .values
                .insert(key.to_string(), value.to_string())
                .is_some()
            {
                bail!("tool argument `{key}` was provided more than once");
            }
        } else if current.starts_with('-') {
            bail!("unknown option `{current}`");
        } else if !run || options.tool_id.replace(current.clone()).is_some() {
            bail!("unexpected argument `{current}`");
        } else if current.trim().is_empty() {
            bail!("tools run requires a nonempty tool id");
        }
        index += 1;
    }
    if run && options.tool_id.is_none() {
        bail!("tools run requires <id>");
    }
    Ok(options)
}

fn option_value<'a>(args: &'a [String], index: &mut usize, name: &str) -> Result<&'a str> {
    if let Some(value) = args[*index].strip_prefix(&format!("{name}=")) {
        return Ok(value);
    }
    *index += 1;
    let value = args
        .get(*index)
        .with_context(|| format!("{name} requires a value"))?;
    if value.starts_with("--") {
        bail!("{name} requires a value");
    }
    Ok(value)
}

pub(crate) fn write_tools_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli tools list [--project <path>] [--json]
  superhigh-cli tools run <id> [--arg key=value ...] [--project <path>] [--json]

Project defaults to the current directory. Use tools list --json to inspect parameters.
Arguments use manifest parameter IDs. Boolean values: true/false, 1/0, yes/no, on/off.
A failed tool returns a nonzero CLI exit status and preserves its output, including JSON."
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
    fn parses_values_with_equals_and_spaces() {
        let result = parse_options(
            &args(&[
                "report",
                "--arg",
                "query=a=b c",
                "--arg=enabled=false",
                "--json",
            ]),
            true,
        )
        .unwrap();
        assert_eq!(result.values["query"], "a=b c");
        assert_eq!(result.values["enabled"], "false");
    }

    #[test]
    fn rejects_ambiguous_or_malformed_options() {
        for values in [
            vec!["report", "--arg", "query=a", "--arg", "query=b"],
            vec!["report", "--arg", "missing-equals"],
            vec!["report", "--arg", "=value"],
            vec!["report", "--project", "--json"],
            vec!["report", "--project=a", "--project=b"],
            vec!["report", "extra"],
            vec!["report", "--unknown"],
            vec![],
        ] {
            assert!(parse_options(&args(&values), true).is_err(), "{values:?}");
        }
        assert!(parse_options(&args(&["--arg", "x=y"]), false).is_err());
    }

    #[test]
    fn failed_tool_preserves_machine_readable_output() {
        let response = ScriptToolRunResponse {
            tool_id: "report".into(),
            title: "Report".into(),
            exit_code: Some(7),
            stdout: "partial result".into(),
            stderr: "failure reason".into(),
        };
        let mut output = Vec::new();
        assert!(write_run_result(&response, true, &mut output).is_err());
        let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value["exitCode"], 7);
        assert_eq!(value["stdout"], "partial result");
        assert_eq!(value["stderr"], "failure reason");
    }
}
