use std::{env, io::Write, path::PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::script_usage::{self, ScriptUsageDailyRow, SkillScriptUsage};

#[derive(Default)]
struct Options {
    project: Option<PathBuf>,
    skill: Option<String>,
    unused: bool,
    idle_days: Option<i64>,
    all: bool,
    daily: bool,
    limit: Option<usize>,
    json: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    skills: usize,
    scripts: usize,
    used: usize,
    never_used: usize,
    calls: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageOutput {
    workspace: String,
    /// 只统计 skill 目录（含 SKILL.md）下 `scripts/` 内的脚本。
    summary: UsageSummary,
    /// 已应用 --skill/--unused/--idle-days/--limit 筛选。
    scripts: Vec<SkillScriptUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    daily: Option<Vec<ScriptUsageDailyRow>>,
}

pub(crate) fn handle_skills(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || matches!(args[0].as_str(), "--help" | "-h" | "help") {
        return write_skills_help(stdout);
    }
    let operation = args.remove(0);
    if operation != "usage" {
        bail!("unknown skills command `{operation}`. Run `superhigh-cli skills --help`.");
    }
    if args.first().is_some_and(|value| matches!(value.as_str(), "--help" | "-h")) {
        return write_skills_help(stdout);
    }
    let options = parse_options(args)?;
    let project = match &options.project {
        Some(project) => project.clone(),
        None => env::current_dir().context("failed to resolve current directory")?,
    };
    if !project.is_dir() {
        bail!("project path does not exist: {}", project.display());
    }
    let project = std::fs::canonicalize(&project).unwrap_or(project);
    let response = script_usage::load_checked(&crate::fs_ops::normalize_path(&project), options.all)?;
    let summary = summarize(&response.scripts);
    let scripts = filter_scripts(response.scripts, &options);
    let daily = options.daily.then(|| {
        let keep: std::collections::HashSet<String> = scripts.iter().map(|entry| format!("{}/{}", entry.skill, entry.script)).collect();
        response.daily.into_iter().filter(|row| keep.contains(&row.script)).collect()
    });
    let output = UsageOutput { workspace: response.workspace, summary, scripts, daily };
    if options.json {
        serde_json::to_writer_pretty(&mut *stdout, &output)?;
        writeln!(stdout)?;
        return Ok(());
    }
    let summary = &output.summary;
    writeln!(
        stdout,
        "{} skills, {} scripts: {} used, {} never used, {} calls",
        summary.skills, summary.scripts, summary.used, summary.never_used, summary.calls
    )?;
    for entry in &output.scripts {
        let last = entry.idle_days.map(|days| format!("{days}d ago")).unwrap_or_else(|| "never".to_string());
        let mut flags = Vec::new();
        if !entry.exists {
            flags.push("missing".to_string());
        }
        if !entry.documented {
            flags.push("undocumented".to_string());
        }
        if !entry.referenced_by.is_empty() {
            flags.push(format!("used by {}", entry.referenced_by.join(",")));
        }
        let flags = if flags.is_empty() { String::new() } else { format!("  [{}]", flags.join("; ")) };
        writeln!(stdout, "{:>6}  {:>10}  {}/{}{}", entry.count, last, entry.skill, entry.script, flags)?;
    }
    Ok(())
}

fn summarize(scripts: &[SkillScriptUsage]) -> UsageSummary {
    let skills: std::collections::HashSet<&str> = scripts.iter().map(|entry| entry.skill_dir.as_str()).collect();
    let used = scripts.iter().filter(|entry| entry.count > 0).count();
    UsageSummary {
        skills: skills.len(),
        scripts: scripts.len(),
        used,
        never_used: scripts.len() - used,
        calls: scripts.iter().map(|entry| entry.count).sum(),
    }
}

fn filter_scripts(scripts: Vec<SkillScriptUsage>, options: &Options) -> Vec<SkillScriptUsage> {
    let mut scripts: Vec<SkillScriptUsage> = scripts
        .into_iter()
        .filter(|entry| {
            options.skill.as_ref().is_none_or(|skill| {
                entry.skill.eq_ignore_ascii_case(skill) || entry.skill_dir.rsplit('/').next().is_some_and(|name| name.eq_ignore_ascii_case(skill))
            })
        })
        .filter(|entry| !options.unused || entry.count == 0)
        // 从未调用的脚本也算闲置。
        .filter(|entry| options.idle_days.is_none_or(|days| entry.idle_days.is_none_or(|idle| idle >= days)))
        .collect();
    if let Some(limit) = options.limit {
        scripts.truncate(limit);
    }
    scripts
}

fn parse_options(args: &[String]) -> Result<Options> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let current = args[index].as_str();
        match current {
            "--json" => options.json = true,
            "--unused" => options.unused = true,
            "--all" => options.all = true,
            "--daily" => options.daily = true,
            _ if current == "--project" || current.starts_with("--project=") => {
                let value = option_value(args, &mut index, "--project")?;
                if options.project.replace(PathBuf::from(value)).is_some() {
                    bail!("--project was provided more than once");
                }
            }
            _ if current == "--skill" || current.starts_with("--skill=") => {
                let value = option_value(args, &mut index, "--skill")?;
                if value.trim().is_empty() || options.skill.replace(value.trim().to_string()).is_some() {
                    bail!("--skill requires one nonempty skill name");
                }
            }
            _ if current == "--idle-days" || current.starts_with("--idle-days=") => {
                let value = option_value(args, &mut index, "--idle-days")?;
                let days = value.parse::<i64>().ok().filter(|days| *days >= 0).with_context(|| format!("invalid --idle-days value `{value}`"))?;
                options.idle_days = Some(days);
            }
            _ if current == "--limit" || current.starts_with("--limit=") => {
                let value = option_value(args, &mut index, "--limit")?;
                options.limit = Some(value.parse::<usize>().with_context(|| format!("invalid --limit value `{value}`"))?);
            }
            _ if current.starts_with('-') => bail!("unknown option `{current}`"),
            _ => bail!("unexpected argument `{current}`"),
        }
        index += 1;
    }
    Ok(options)
}

fn option_value<'a>(args: &'a [String], index: &mut usize, name: &str) -> Result<&'a str> {
    if let Some(value) = args[*index].strip_prefix(&format!("{name}=")) {
        return Ok(value);
    }
    *index += 1;
    let value = args.get(*index).with_context(|| format!("{name} requires a value"))?;
    if value.starts_with("--") {
        bail!("{name} requires a value");
    }
    Ok(value)
}

pub(crate) fn write_skills_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(
        stdout,
        "Usage:
  superhigh-cli skills usage [--project <path>] [--skill <name>] [--unused] [--idle-days <n>]
                             [--all] [--daily] [--limit <n>] [--json]

Counts calls of Agent Skill scripts: files under <skill>/scripts/ where <skill> contains SKILL.md.
Ordinary project scripts and .agent/tmp are not counted. Calls come from Claude Code and Codex
session logs (inside and outside SuperHigh) and SuperHigh script tool runs; symlinked skill
aliases (.agents/.claude/.codex/skills -> .skillshare/skills) count as one physical script.

Lists every script of the project and global skills visible from --project (default: current
directory), including scripts never called. Sorted by call count, then last use.
  --skill <name>    Only this skill (frontmatter name or directory name).
  --unused          Only scripts never called.
  --idle-days <n>   Only scripts not called for at least n days (never called included).
  --all             Also list called scripts of skills outside the current project.
  --daily           Include per-day counts for the listed scripts.
JSON fields per script: skill, scope, skillDir, script, path, count, recent30d, lastUsedMs,
idleDays (null = never), exists, documented (named in SKILL.md or references/), referencedBy
(other scripts of the same skill naming it, for never-called scripts), sources."
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn entry(skill: &str, script: &str, count: i64, idle_days: Option<i64>) -> SkillScriptUsage {
        SkillScriptUsage {
            skill: skill.into(),
            scope: "project".into(),
            skill_dir: format!("D:/ws/.skillshare/skills/{skill}"),
            script: script.into(),
            path: format!("D:/ws/.skillshare/skills/{skill}/{script}"),
            count,
            recent_30d: 0,
            last_used_ms: 0,
            idle_days,
            exists: true,
            documented: true,
            referenced_by: Vec::new(),
            sources: BTreeMap::new(),
        }
    }

    #[test]
    fn filters_by_skill_unused_and_idle_days() {
        let scripts = || vec![entry("a", "scripts/x.py", 5, Some(1)), entry("a", "scripts/old.py", 2, Some(40)), entry("b", "scripts/y.py", 0, None)];
        let run = |values: &[&str]| -> Vec<String> {
            filter_scripts(scripts(), &parse_options(&args(values)).unwrap()).into_iter().map(|entry| format!("{}/{}", entry.skill, entry.script)).collect()
        };
        assert_eq!(run(&["--skill", "A"]), ["a/scripts/x.py", "a/scripts/old.py"]);
        assert_eq!(run(&["--unused"]), ["b/scripts/y.py"]);
        assert_eq!(run(&["--idle-days=30"]), ["a/scripts/old.py", "b/scripts/y.py"]);
        assert_eq!(run(&["--limit", "1"]), ["a/scripts/x.py"]);
        let summary = summarize(&scripts());
        assert_eq!((summary.skills, summary.scripts, summary.used, summary.never_used, summary.calls), (2, 3, 2, 1, 7));
    }

    #[test]
    fn rejects_malformed_options() {
        for values in [vec!["--idle-days", "-1"], vec!["--skill"], vec!["--skill=a", "--skill=b"], vec!["extra"], vec!["--unknown"], vec!["--limit", "x"]] {
            assert!(parse_options(&args(&values)).is_err(), "{values:?}");
        }
    }
}
