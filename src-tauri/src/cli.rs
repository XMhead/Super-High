use std::{
    collections::BTreeMap,
    env,
    io::{self, Write},
    path::PathBuf,
};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::{fs_ops, models::ProjectSearchOptions, workflow_memory};

#[derive(Default)]
struct CommonOptions {
    project: Option<PathBuf>,
    json: bool,
}

impl CommonOptions {
    fn project_path(&self) -> Result<PathBuf> {
        let path = match &self.project {
            Some(path) => path.clone(),
            None => env::current_dir().context("failed to resolve current directory")?,
        };
        if !path.exists() {
            bail!("project path does not exist: {}", path.display());
        }
        Ok(path)
    }
}

pub fn run_from_env() -> i32 {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut stdout = io::stdout();
    let mut stderr = io::stderr();
    run_with_io(&args, &mut stdout, &mut stderr)
}

pub(crate) fn run_with_io(args: &[String], stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    match dispatch(args, stdout) {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(stderr, "error: {error}");
            1
        }
    }
}

fn dispatch(args: &[String], stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_main_help(stdout);
    }

    let mut args = args.to_vec();
    let command = args.remove(0);
    match command.as_str() {
        "env" => crate::cli_env::handle_env(&mut args, stdout),
        "files" => crate::cli_files::handle_files(&mut args, stdout),
        "memory" => handle_memory(&mut args, stdout),
        "remote" => crate::cli_remote::handle_remote(&mut args, stdout),
        "search" => handle_search(&mut args, stdout),
        _ => bail!("unknown command `{command}`. Run `superhigh-cli --help`."),
    }
}

fn handle_memory(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_memory_help(stdout);
    }

    let subcommand = args.remove(0);
    match subcommand.as_str() {
        "graph" => memory_graph(args, stdout),
        _ => bail!("unknown memory command `{subcommand}`. Run `superhigh-cli memory --help`."),
    }
}

fn memory_graph(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    let options = consume_common_options(args)?;
    ensure_no_unexpected_options(args)?;
    ensure_no_positionals(args)?;

    let project = options.project_path()?;
    let graph = workflow_memory::scan_workflow_memory_graph(&project)?;
    if options.json {
        return write_json(stdout, &graph);
    }

    let mut node_counts = BTreeMap::<String, usize>::new();
    let mut edge_counts = BTreeMap::<String, usize>::new();
    for node in &graph.nodes {
        *node_counts.entry(node.kind.clone()).or_default() += 1;
    }
    for edge in &graph.edges {
        *edge_counts.entry(edge.kind.clone()).or_default() += 1;
    }

    writeln!(
        stdout,
        "Workflow memory graph: {} nodes, {} edges",
        graph.nodes.len(),
        graph.edges.len()
    )?;
    writeln!(stdout, "Project: {}", graph.project_path)?;
    writeln!(stdout, "Node kinds: {}", count_summary(&node_counts))?;
    writeln!(stdout, "Edge kinds: {}", count_summary(&edge_counts))?;
    for warning in &graph.warnings {
        writeln!(stdout, "warning: {warning}")?;
    }
    Ok(())
}

fn handle_search(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || is_help(&args[0]) {
        return write_search_help(stdout);
    }

    let options = consume_common_options(args)?;
    let include_text = !take_flag(args, "--no-text");
    let limit = match take_option(args, "--limit")? {
        Some(value) => value
            .parse::<usize>()
            .with_context(|| format!("invalid --limit value `{value}`"))?,
        None => ProjectSearchOptions::default().limit,
    };
    ensure_no_unexpected_options(args)?;
    if args.is_empty() {
        bail!("search requires a query");
    }
    let query = args.join(" ");

    let project = options.project_path()?;
    let roots = vec![fs_ops::normalize_path(&project)];
    let result = fs_ops::search_project_files(
        &query,
        &roots,
        ProjectSearchOptions {
            include_text,
            file_name_only: false,
            limit,
        },
    )?;

    if options.json {
        return write_json(stdout, &result);
    }

    writeln!(
        stdout,
        "Found {} file matches and {} text matches.",
        result.files.len(),
        result.text_matches.len()
    )?;
    for file in result.files.iter().take(20) {
        writeln!(stdout, "file: {}", file.relative_path)?;
    }
    for item in result.text_matches.iter().take(20) {
        writeln!(
            stdout,
            "text: {}:{}:{} {}",
            item.relative_path, item.line_number, item.column, item.preview
        )?;
    }
    Ok(())
}

fn consume_common_options(args: &mut Vec<String>) -> Result<CommonOptions> {
    let mut options = CommonOptions::default();
    let mut index = 0;
    while index < args.len() {
        let current = args[index].clone();
        if current == "--json" {
            options.json = true;
            args.remove(index);
            continue;
        }
        if current == "--project" {
            if index + 1 >= args.len() {
                bail!("--project requires a path");
            }
            options.project = Some(PathBuf::from(args.remove(index + 1)));
            args.remove(index);
            continue;
        }
        if let Some(value) = current.strip_prefix("--project=") {
            options.project = Some(PathBuf::from(value));
            args.remove(index);
            continue;
        }
        index += 1;
    }
    Ok(options)
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

fn count_summary(counts: &BTreeMap<String, usize>) -> String {
    if counts.is_empty() {
        return "-".to_string();
    }
    counts
        .iter()
        .map(|(kind, count)| format!("{kind}={count}"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn write_json<T: Serialize>(stdout: &mut dyn Write, value: &T) -> Result<()> {
    serde_json::to_writer_pretty(&mut *stdout, value)?;
    writeln!(stdout)?;
    Ok(())
}

fn is_help(value: &str) -> bool {
    matches!(value, "help" | "-h" | "--help")
}

fn write_main_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Super High CLI

Usage:
  superhigh-cli env cli [--json]
  superhigh-cli files ls <path> [--json]
  superhigh-cli memory graph [--project <path>] [--json]
  superhigh-cli remote status [--json]
  superhigh-cli search <query> [--project <path>] [--limit <n>] [--no-text] [--json]

Global options:
  --project <path>  Project/workspace path. Defaults to the current directory.
  --json            Print machine-readable JSON.
"
    )?;
    Ok(())
}

fn write_search_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli search <query> [--project <path>] [--limit <n>] [--no-text] [--json]
"
    )?;
    Ok(())
}

fn write_memory_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli memory graph [--project <path>] [--json]

Builds a read-only internal AI workflow graph from project instructions,
project skills, docs nodes, and referenced files.
"
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use serde_json::Value;
    use tempfile::tempdir;

    fn run(args: &[&str]) -> (i32, String, String) {
        let args = args
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let code = run_with_io(&args, &mut stdout, &mut stderr);
        (
            code,
            String::from_utf8(stdout).unwrap(),
            String::from_utf8(stderr).unwrap(),
        )
    }

    #[test]
    fn searches_project_files() {
        let directory = tempdir().unwrap();
        fs::write(directory.path().join("needle-note.md"), "hello").unwrap();
        fs::write(directory.path().join("body.md"), "needle in body").unwrap();
        let project = directory.path().to_string_lossy().to_string();

        let (code, stdout, stderr) = run(&[
            "search",
            "needle",
            "--project",
            &project,
            "--limit",
            "10",
            "--json",
        ]);

        assert_eq!(code, 0, "{stderr}");
        let result: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(result["files"].as_array().unwrap().len(), 1);
        assert_eq!(result["textMatches"].as_array().unwrap().len(), 1);
    }
}
