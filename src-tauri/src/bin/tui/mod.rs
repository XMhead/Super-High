use std::{
    io::{self, IsTerminal, Read, Write},
    process::{Command, Stdio},
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::Duration,
};

use crossterm::{
    cursor::{Hide, MoveTo, Show},
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute, queue,
    style::{Color, Print, ResetColor, SetForegroundColor},
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use unicode_width::UnicodeWidthChar;

const GROUPS: &[&str] = &[
    "agent",
    "appearance",
    "automation",
    "env",
    "files",
    "memo",
    "memory",
    "search",
    "service",
    "skills",
    "terminal",
    "tools",
    "workspace",
    "mcp",
];
const OUTPUT_LIMIT: usize = 1024 * 1024;

struct TerminalGuard;
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(io::stdout(), Show, LeaveAlternateScreen, ResetColor);
    }
}

struct Job {
    cancel: Sender<()>,
    result: Receiver<String>,
    thread: thread::JoinHandle<()>,
}

pub fn run_from_env() -> i32 {
    let args: Vec<_> = std::env::args().skip(2).collect();
    if args == ["--help"] || args == ["-h"] {
        println!("Usage: superhigh-cli tui\nInteractive command browser; requires a terminal.");
        return 0;
    }
    if !args.is_empty() {
        eprintln!("error: tui accepts no arguments; use superhigh-cli tui --help");
        return 1;
    }
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        eprintln!("error: tui requires an interactive terminal");
        return 1;
    }
    match run() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("error: {error}");
            1
        }
    }
}

fn run() -> io::Result<()> {
    terminal::enable_raw_mode()?;
    let _guard = TerminalGuard;
    execute!(io::stdout(), EnterAlternateScreen, Hide)?;
    let mut selected = 0usize;
    let mut editing = false;
    let mut input = String::new();
    let mut position = 0usize; // byte offset at a character boundary
    let mut output = String::from("选择命令组并按 Enter 查看帮助。\nTab 切换到输入框；Enter 执行命令。\n路径和含空格的参数请使用双引号。");
    let mut scroll = 0usize;
    let mut job: Option<Job> = None;
    let mut dirty = true;
    loop {
        if let Some(active) = &job {
            let result = match active.result.try_recv() {
                Ok(result) => Some(result),
                Err(mpsc::TryRecvError::Disconnected) => Some("命令执行线程意外退出。".into()),
                Err(mpsc::TryRecvError::Empty) => None,
            };
            if let Some(result) = result {
                output = result;
                scroll = 0;
                dirty = true;
                if let Some(done) = job.take() {
                    let _ = done.thread.join();
                }
            }
        }
        if dirty {
            let (width, height) = terminal::size()?;
            let sidebar = if width >= 55 { 17 } else { 0 };
            let content_width = (width as usize).saturating_sub(sidebar + 1);
            let max_scroll = wrap_output(&output, content_width)
                .len()
                .saturating_sub(height.saturating_sub(6) as usize);
            scroll = scroll.min(max_scroll);
            draw(
                selected,
                editing,
                &input,
                position,
                &output,
                scroll,
                job.is_some(),
            )?;
            dirty = false;
        }
        if !event::poll(Duration::from_millis(100))? {
            continue;
        }
        let event = event::read()?;
        if matches!(event, Event::Resize(..)) {
            dirty = true;
        }
        let Event::Key(key) = event else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        dirty = true;
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            if let Some(active) = &job {
                let _ = active.cancel.send(());
                output = "正在取消 CLI 命令…".into();
            } else {
                break;
            }
            continue;
        }
        match key.code {
            KeyCode::Tab => editing = !editing,
            KeyCode::PageUp => scroll = scroll.saturating_sub(10),
            KeyCode::PageDown => scroll = scroll.saturating_add(10),
            KeyCode::F(1) if job.is_none() => {
                output = format!("正在读取 {} 的帮助…", GROUPS[selected]);
                scroll = 0;
                job = Some(start_job(vec![GROUPS[selected].into(), "--help".into()]));
            }
            KeyCode::Esc if editing => editing = false,
            KeyCode::Esc if job.is_none() => break,
            KeyCode::Char('q') if !editing && job.is_none() => break,
            KeyCode::Up if !editing => selected = selected.saturating_sub(1),
            KeyCode::Down if !editing => selected = (selected + 1).min(GROUPS.len() - 1),
            KeyCode::Enter if !editing && job.is_none() => {
                input = format!("{} ", GROUPS[selected]);
                position = input.len();
                editing = true;
                output = format!("正在读取 {} 的帮助…", GROUPS[selected]);
                scroll = 0;
                job = Some(start_job(vec![GROUPS[selected].into(), "--help".into()]));
            }
            KeyCode::Enter if editing && job.is_none() => match parse_command(&input) {
                Ok(args) if !args.is_empty() => match validate_command(&args) {
                    Ok(()) => {
                        output = "正在执行… Ctrl+C 可取消。".into();
                        scroll = 0;
                        job = Some(start_job(args));
                    }
                    Err(error) => output = error.into(),
                },
                Ok(_) => output = "请输入 CLI 命令。".into(),
                Err(error) => output = error.into(),
            },
            KeyCode::Left if editing => {
                position = input[..position]
                    .char_indices()
                    .last()
                    .map_or(0, |(i, _)| i)
            }
            KeyCode::Right if editing => {
                if let Some(ch) = input[position..].chars().next() {
                    position += ch.len_utf8();
                }
            }
            KeyCode::Home if editing => position = 0,
            KeyCode::End if editing => position = input.len(),
            KeyCode::Backspace if editing && position > 0 => {
                let previous = input[..position].char_indices().last().unwrap().0;
                input.replace_range(previous..position, "");
                position = previous;
            }
            KeyCode::Delete if editing && position < input.len() => {
                let end = position + input[position..].chars().next().unwrap().len_utf8();
                input.replace_range(position..end, "");
            }
            KeyCode::Char(ch)
                if editing
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
                    && !ch.is_control() =>
            {
                input.insert(position, ch);
                position += ch.len_utf8();
            }
            _ => {}
        }
    }
    if let Some(active) = job {
        let _ = active.cancel.send(());
        let _ = active.thread.join();
    }
    Ok(())
}

fn validate_command(args: &[String]) -> Result<(), &'static str> {
    if args[0] == "tui" || (args[0] == "mcp" && args.get(1).is_some_and(|a| a == "serve")) {
        return Err("此交互命令请直接在终端运行。");
    }
    if args.iter().any(|arg| arg == "-") {
        return Err("TUI 不提供标准输入；请使用文件路径或直接在终端运行。");
    }
    Ok(())
}

// Quotes group arguments. Backslashes stay literal, including Windows paths.
fn parse_command(input: &str) -> Result<Vec<String>, &'static str> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut started = false;
    for ch in input.chars() {
        if let Some(delimiter) = quote {
            if ch == delimiter {
                quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            started = true;
        } else if ch.is_whitespace() {
            if started {
                args.push(std::mem::take(&mut current));
                started = false;
            }
        } else {
            current.push(ch);
            started = true;
        }
    }
    if quote.is_some() {
        return Err("引号未闭合。");
    }
    if started {
        args.push(current);
    }
    Ok(args)
}

fn read_output(mut reader: impl Read) -> Vec<u8> {
    let mut saved = Vec::new();
    let mut buffer = [0u8; 8192];
    while let Ok(count) = reader.read(&mut buffer) {
        if count == 0 {
            break;
        }
        let remaining = OUTPUT_LIMIT.saturating_sub(saved.len());
        saved.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    saved
}

fn start_job(args: Vec<String>) -> Job {
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let (result_tx, result_rx) = mpsc::channel();
    let thread = thread::spawn(move || {
        let result = (|| -> io::Result<String> {
            let mut child = Command::new(std::env::current_exe()?)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()?;
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            let (out_tx, out_rx) = mpsc::channel();
            let (err_tx, err_rx) = mpsc::channel();
            thread::spawn(move || {
                let _ = out_tx.send(read_output(stdout));
            });
            thread::spawn(move || {
                let _ = err_tx.send(read_output(stderr));
            });
            let mut cancelled = false;
            let mut out = None;
            let mut err = None;
            let mut status = None;
            loop {
                if cancel_rx.try_recv().is_ok() {
                    cancelled = true;
                    if status.is_none() {
                        let _ = child.kill();
                        status = Some(child.wait()?);
                    }
                    break;
                }
                if status.is_none() {
                    status = child.try_wait()?;
                }
                if out.is_none() {
                    out = out_rx.try_recv().ok();
                }
                if err.is_none() {
                    err = err_rx.try_recv().ok();
                }
                if status.is_some() && out.is_some() && err.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            // A descendant can inherit a pipe after the CLI exits; cancellation must
            // remain responsive while those readers wait for the inherited handle.
            let out = out.unwrap_or_default();
            let err = err.unwrap_or_default();
            let mut result = format!(
                "$ superhigh-cli {}\n{}\n",
                args.join(" "),
                if cancelled {
                    "已取消".to_string()
                } else {
                    format!("退出状态: {}", status.unwrap())
                }
            );
            if !out.is_empty() {
                result.push_str(&format!("\n标准输出:\n{}", String::from_utf8_lossy(&out)));
            }
            if !err.is_empty() {
                result.push_str(&format!("\n标准错误:\n{}", String::from_utf8_lossy(&err)));
            }
            if out.len() == OUTPUT_LIMIT || err.len() == OUTPUT_LIMIT {
                result.push_str("\n输出已截断（每个流最多 1 MiB）。\n");
            }
            Ok(result)
        })()
        .unwrap_or_else(|error| format!("启动或运行命令失败: {error}"));
        let _ = result_tx.send(result);
    });
    Job {
        cancel: cancel_tx,
        result: result_rx,
        thread,
    }
}

fn clipped(text: &str, width: usize) -> String {
    let mut result = String::new();
    let mut used = 0;
    for ch in text.chars() {
        let ch = if ch.is_control() { ' ' } else { ch };
        let w = UnicodeWidthChar::width(ch).unwrap_or(0);
        if used + w > width {
            break;
        }
        result.push(ch);
        used += w;
    }
    result
}

fn wrap_output(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    for source in text.lines() {
        let mut line = String::new();
        let mut used = 0;
        for ch in source.chars() {
            let ch = if ch.is_control() { ' ' } else { ch };
            let w = UnicodeWidthChar::width(ch).unwrap_or(0);
            if used + w > width && !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                used = 0;
            }
            line.push(ch);
            used += w;
        }
        lines.push(line);
    }
    lines
}

fn draw(
    selected: usize,
    editing: bool,
    input: &str,
    position: usize,
    output: &str,
    scroll: usize,
    running: bool,
) -> io::Result<()> {
    let (width, height) = terminal::size()?;
    let mut stdout = io::stdout();
    queue!(stdout, Hide, MoveTo(0, 0), Clear(ClearType::All))?;
    let line = |stdout: &mut io::Stdout, y: u16, text: &str, color: Color| -> io::Result<()> {
        if y < height {
            queue!(
                stdout,
                MoveTo(0, y),
                SetForegroundColor(color),
                Print(clipped(text, width.saturating_sub(1) as usize)),
                ResetColor
            )?;
        }
        Ok(())
    };
    line(&mut stdout, 0, "Super High CLI   ·   终端界面", Color::Cyan)?;
    line(
        &mut stdout,
        1,
        "↑↓ 选择  Enter 帮助/执行  Tab 切换  F1 帮助  PgUp/PgDn 滚动  Ctrl+C 取消/退出",
        Color::DarkGrey,
    )?;
    let available = height.saturating_sub(6) as usize;
    let list_start = selected.saturating_sub(available.saturating_sub(1));
    let sidebar_width = if width >= 55 { 17usize } else { 0 };
    if sidebar_width == 0 {
        line(
            &mut stdout,
            2,
            &format!("命令组: {}", GROUPS[selected]),
            Color::Cyan,
        )?;
    }
    if sidebar_width > 0 {
        for (row, group) in GROUPS.iter().skip(list_start).take(available).enumerate() {
            let marker = if row + list_start == selected {
                ">"
            } else {
                " "
            };
            line(
                &mut stdout,
                row as u16 + 3,
                &format!("{marker} {group}"),
                if row + list_start == selected && !editing {
                    Color::Cyan
                } else {
                    Color::Grey
                },
            )?;
        }
    }
    let content_width = (width as usize).saturating_sub(sidebar_width + 1);
    let lines = wrap_output(output, content_width);
    let start = scroll.min(lines.len().saturating_sub(available));
    let end = (start + available).min(lines.len());
    for (row, text) in lines[start..end].iter().enumerate() {
        if (row as u16 + 3) < height {
            queue!(
                stdout,
                MoveTo(sidebar_width as u16, row as u16 + 3),
                Print(clipped(text, content_width))
            )?;
        }
    }
    if height >= 3 {
        let prompt_y = height - 2;
        let prefix = if running {
            "运行中 > "
        } else if editing {
            "命令 > "
        } else {
            "命令   "
        };
        let room = (width as usize).saturating_sub(12);
        // Keep the cursor visible on long inputs.
        let before = &input[..position];
        let visible_before = before
            .chars()
            .rev()
            .scan(0usize, |used, ch| {
                *used += UnicodeWidthChar::width(ch).unwrap_or(0);
                (*used <= room).then_some(ch)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>();
        let visible = format!("{}{}", visible_before, &input[position..]);
        line(
            &mut stdout,
            prompt_y,
            &format!("{prefix}{visible}"),
            Color::Yellow,
        )?;
        line(
            &mut stdout,
            height - 1,
            "Q/Esc 返回或退出  ·  不支持标准输入和 shell 管道",
            Color::DarkGrey,
        )?;
        if editing {
            let x = prefix
                .chars()
                .chain(visible_before.chars())
                .map(|ch| UnicodeWidthChar::width(ch).unwrap_or(0))
                .sum::<usize>();
            queue!(
                stdout,
                MoveTo(x.min(width.saturating_sub(1) as usize) as u16, prompt_y),
                Show
            )?;
        }
    }
    stdout.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_windows_paths_and_quoted_arguments() {
        assert_eq!(
            parse_command(r#"files read "D:\My Project\a.txt" --json"#).unwrap(),
            vec!["files", "read", r"D:\My Project\a.txt", "--json"]
        );
        assert_eq!(parse_command("search ''").unwrap(), vec!["search", ""]);
        assert!(parse_command("search \"unfinished").is_err());
    }
    #[test]
    fn blocks_interactive_children() {
        assert!(validate_command(&["mcp".into(), "serve".into()]).is_err());
        assert!(validate_command(&[
            "memo".into(),
            "append".into(),
            "--content-file".into(),
            "-".into()
        ])
        .is_err());
        assert!(validate_command(&["terminal".into(), "list".into()]).is_ok());
    }
}
