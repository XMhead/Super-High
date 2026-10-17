#![allow(dead_code)]
#[path = "../src-tauri/src/agent_changes.rs"]
mod agent_changes;
#[path = "../src-tauri/src/command_changes.rs"]
mod command_changes;
#[path = "../src-tauri/src/command_scope.rs"]
mod command_scope;

use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

fn safe_path(root: &Path, path: &Path) -> Result<()> {
    ensure!(path.starts_with(root) && path != root, "临时路径越出工作区");
    for ancestor in path.ancestors().take_while(|p| p.starts_with(root)) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                ensure!(!metadata.file_type().is_symlink(), "临时路径经过链接");
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    ensure!(
                        metadata.file_attributes() & 0x400 == 0,
                        "临时路径经过 reparse point"
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn command(shell: &Path, script: &str) -> Result<String> {
    Ok(shlex::try_join([
        shell.to_str().context("PowerShell 路径不是UTF-8")?,
        "-Command",
        script,
    ])?)
}
fn original_command(path: &Path) -> Result<String> {
    ensure!(
        fs::metadata(path)?.len() <= 128 * 1024,
        "原生命令文件超过128KiB"
    );
    let raw = fs::read_to_string(path)?;
    ensure!(raw.len() <= 128 * 1024, "原生命令文件超过128KiB");
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return Ok(raw);
    };
    let command = if value.is_object() {
        [
            "/command",
            "/item/command",
            "/params/item/command",
            "/payload/item/command",
        ]
        .into_iter()
        .find_map(|pointer| value.pointer(pointer))
        .context("事件没有原生命令")?
    } else {
        &value
    };
    if let Some(text) = command.as_str() {
        return Ok(text.to_owned());
    }
    let argv = command
        .as_array()
        .context("原生命令必须是文本或argv数组")?
        .iter()
        .map(|arg| arg.as_str().context("argv参数不是字符串"))
        .collect::<Result<Vec<_>>>()?;
    ensure!(!argv.is_empty(), "原生argv为空");
    Ok(shlex::try_join(argv)?)
}
fn execute(shell: &Path, script: &str, root: &Path) -> Result<()> {
    let mut cmd = Command::new(shell);
    cmd.args(["-Command", script])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    ensure!(cmd.status()?.success(), "实际 PowerShell 命令执行失败");
    Ok(())
}
fn view(
    tracker: &mut command_changes::CommandChanges,
    turn: &str,
) -> Result<agent_changes::AgentTurnChanges> {
    let changes = tracker.refresh("preflight-native", turn, &[])?;
    Ok(agent_changes::overwrite_workspace_contents(
        "preflight",
        "preflight-native",
        turn,
        &changes,
    ))
}
fn probe(
    root: &Path,
    shell: &Path,
    directory: &Path,
    original: Option<&Path>,
    stage: &mut &str,
) -> Result<Value> {
    *stage = "command_scope";
    let original_scope = if let Some(path) = original {
        let raw = original_command(path)?;
        let scope = command_scope::parse_powershell_scope(&raw, root)
            .context("原版命令无法证明完整写入范围；保留完整监测分支")?;
        Some(json!({"files":scope.files.len(),"prefixes":scope.prefixes.len()}))
    } else {
        None
    };
    let relative_dir = directory
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");
    let file = format!("{relative_dir}/probe.txt");
    let quoted_dir = relative_dir.replace('\'', "''");
    let quoted_file = file.replace('\'', "''");
    let script = format!("New-Item -ItemType Directory -Force -Path '{quoted_dir}' | Out-Null\nSet-Content -LiteralPath '{quoted_file}' -Encoding UTF8 -Value '第一行验收'\nAdd-Content -LiteralPath '{quoted_file}' -Encoding UTF8 -Value '第二行跳转验收'\nGet-Content -LiteralPath '{quoted_file}' -Encoding UTF8");
    let raw = command(shell, &script)?;
    command_scope::parse_powershell_scope(&raw, root)
        .context("默认 PowerShell 命令范围未证明；核对真实宿主及 PROFILE")?;
    let mut tracker = command_changes::CommandChanges::new(root);
    *stage = "baseline";
    let started = Instant::now();
    tracker.prepare()?;
    let baseline_ms = started.elapsed().as_millis();
    agent_changes::register_session("preflight", "codex", root, Some("preflight-native"));
    agent_changes::begin_turn("preflight", "preflight-native", "1");
    tracker.begin("preflight-native", "1")?;
    tracker.note_command(&raw, None)?;
    *stage = "write";
    execute(shell, &script, root)?;
    let started = Instant::now();
    let written = view(&mut tracker, "1")?;
    let refresh_ms = started.elapsed().as_millis();
    ensure!(
        written.available
            && written.files.len() == 1
            && written.files[0].path == file
            && written.additions == 2
            && written.deletions == 0,
        "实际写入净差不为目标文件+2/-0"
    );
    let diff = agent_changes::get_file_diff("preflight", "1", &file)?;
    ensure!(
        diff.available
            && diff
                .rows
                .iter()
                .any(|row| row.new_line == Some(2) && row.text == "第二行跳转验收"),
        "真实差异没有第2行"
    );
    *stage = "restore";
    let remove = format!("Remove-Item -LiteralPath '{quoted_file}'");
    tracker.note_command(&command(shell, &remove)?, None)?;
    execute(shell, &remove, root)?;
    let restored = view(&mut tracker, "1")?;
    ensure!(
        restored.available
            && restored.files.is_empty()
            && restored.additions == 0
            && restored.deletions == 0,
        "同轮删除没有归零"
    );
    tracker.finish("preflight-native", "1");
    agent_changes::complete_turn("preflight", "preflight-native", "1");
    *stage = "next_baseline";
    let started = Instant::now();
    tracker.prepare()?;
    let next_baseline_ms = started.elapsed().as_millis();
    tracker.begin("preflight-native", "2")?;
    agent_changes::begin_turn("preflight", "preflight-native", "2");
    let next_script =
        format!("Set-Content -LiteralPath '{quoted_file}' -Encoding UTF8 -Value '下一轮验收'");
    tracker.note_command(&command(shell, &next_script)?, None)?;
    *stage = "next_turn";
    execute(shell, &next_script, root)?;
    let next = view(&mut tracker, "2")?;
    ensure!(
        next.available
            && next.files.len() == 1
            && next.files[0].path == file
            && next.additions == 1
            && next.deletions == 0,
        "下一轮重新创建未正确计入"
    );
    Ok(
        json!({"available":true,"stage":"complete","scope":"proven","originalCommand":original_scope,"baselineMs":baseline_ms,"refreshMs":refresh_ms,"nextBaselineMs":next_baseline_ms,"files":written.files.len(),"additions":written.additions,"deletions":written.deletions,"diffLine":2,"restoredToZero":true,"nextTurnAdditions":next.additions}),
    )
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let mut stage = "setup";
    let mut cleanup = None;
    let result = (|| -> Result<Value> {
        ensure!((3..=4).contains(&args.len()), "缺少工作区、宿主或本轮ID");
        let root = PathBuf::from(&args[0]);
        let shell = PathBuf::from(&args[1]);
        let run_id = args[2].to_str().context("本轮ID不是UTF-8")?;
        ensure!(
            run_id.len() == 36 && run_id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'),
            "本轮ID无效"
        );
        let directory = root.join(".agent/tmp/agent-changes-preflight").join(run_id);
        safe_path(&root, &directory)?;
        ensure!(!directory.exists(), "本轮临时目录已经存在");
        fs::create_dir_all(&directory)?;
        cleanup = Some((root.clone(), directory.clone()));
        probe(
            &root,
            &shell,
            &directory,
            args.get(3).map(Path::new),
            &mut stage,
        )
    })();
    let cleanup_result = (|| -> Result<()> {
        if let Some((root, directory)) = cleanup {
            safe_path(&root, &directory)?;
            let file = directory.join("probe.txt");
            if file.exists() {
                safe_path(&root, &file)?;
                fs::remove_file(file)?;
            }
            fs::remove_dir(directory)?;
        }
        Ok(())
    })();
    let output = match (result, cleanup_result) {
        (Ok(mut value), Ok(())) => {
            value["cleaned"] = json!(true);
            value
        }
        (Err(error), Ok(())) => {
            json!({"available":false,"stage":stage,"reason":format!("{error:#}"),"cleaned":true})
        }
        (_, Err(error)) => {
            json!({"available":false,"stage":"cleanup","reason":format!("{error:#}"),"cleaned":false})
        }
    };
    println!("{output}");
    if output["available"] != true {
        std::process::exit(1);
    }
}
