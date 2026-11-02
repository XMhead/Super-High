use crate::automation::{self, Task};
use anyhow::{bail, Context, Result};
use std::{
    fs,
    io::{Read, Write},
};
pub fn handle_automation(args: &mut Vec<String>, out: &mut dyn Write) -> Result<()> {
    if args.is_empty() || matches!(args[0].as_str(), "help" | "--help" | "-h") {
        writeln!(out,"Usage: superhigh-cli automation list [--project PATH] [--json]\n       superhigh-cli automation save --file FILE|- [--project PATH] [--json]\n       superhigh-cli automation delete --scope global|project --id ID [--project PATH] [--json]\nTasks run only while Super High is open; missed occurrences are skipped. Commands use powershell.exe -NoProfile -NonInteractive -Command on Windows (sh -c elsewhere); project tasks use the workspace as working directory and set SUPERHIGH_WORKSPACE, global tasks use the app data directory; timeout 300 seconds. JSON task schedule uses {{\"kind\":\"once\",\"at\":\"YYYY-MM-DDTHH:mm\"}} or {{\"kind\":\"daily\",\"time\":\"HH:mm\"}} in local time; action is {{\"kind\":\"command\",\"command\":\"...\"}}, {{\"kind\":\"shutdown\"}}, or {{\"kind\":\"restart\"}}.")?;
        return Ok(());
    }
    let op = args.remove(0);
    let mut project = None;
    let mut file = None;
    let mut scope = None;
    let mut id = None;
    let mut json = false;
    let mut i = 0;
    while i < args.len() {
        let flag = &args[i];
        if flag == "--json" {
            json = true;
            i += 1;
            continue;
        }
        if !matches!(flag.as_str(), "--project" | "--file" | "--scope" | "--id") {
            bail!("unknown option: {flag}");
        }
        i += 1;
        let value = args
            .get(i)
            .with_context(|| format!("{flag} requires a value"))?
            .clone();
        match flag.as_str() {
            "--project" => project = Some(value),
            "--file" => file = Some(value),
            "--scope" => scope = Some(value),
            "--id" => id = Some(value),
            _ => unreachable!(),
        }
        i += 1;
    }
    let data = crate::cli_workspace::app_data_path()?;
    let result = match op.as_str() {
        "list" => serde_json::to_value(automation::list(&data, project.as_deref())?)?,
        "save" => {
            let file = file.context("save requires --file")?;
            let input = if file == "-" {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s)?;
                s
            } else {
                fs::read_to_string(file)?
            };
            let task: Task = serde_json::from_str(&input).context("invalid task JSON")?;
            serde_json::to_value(automation::save(&data, task, project.as_deref())?)?
        }
        "delete" => {
            automation::delete(
                &data,
                scope.as_deref().context("delete requires --scope")?,
                id.as_deref().context("delete requires --id")?,
                project.as_deref(),
            )?;
            serde_json::json!({"deleted":true})
        }
        _ => bail!("unknown automation command: {op}"),
    };
    let _ = json;
    serde_json::to_writer_pretty(&mut *out, &result)?;
    writeln!(out)?;
    Ok(())
}
