use std::{collections::BTreeMap, io::Write, path::Path};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Map, Value};

/// 六级标题使用红、黄、绿、青、蓝、紫六种不透明亮色；须与 src/lib/markdownHeadingColors.ts 保持一致。
pub(crate) const DEFAULT_HEADING_COLORS: [(&str, &str); 6] = [
    ("h1", "#FF9B9BFF"),
    ("h2", "#FFD580FF"),
    ("h3", "#A7E89BFF"),
    ("h4", "#8DE2E8FF"),
    ("h5", "#A8BEFFFF"),
    ("h6", "#D8B2FFFF"),
];

const SETTINGS_KEY: &str = "markdownHeadingColors";

pub(crate) fn handle_appearance(args: &mut Vec<String>, stdout: &mut dyn Write) -> Result<()> {
    if args.is_empty() || args.iter().any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help")) {
        return write_help(stdout);
    }
    let group = args.remove(0);
    if group != "headings" {
        bail!("unknown appearance command `{group}`. Run `superhigh-cli appearance --help`.");
    }
    let json_output = take_flag(args, "--json");
    let action = if args.first().is_some_and(|arg| !arg.starts_with('-')) { args.remove(0) } else { "get".into() };
    let path = crate::cli_workspace::database_path()?;
    match action.as_str() {
        "get" => {
            anyhow::ensure!(args.is_empty(), "unexpected argument `{}`", args[0]);
            let colors = read_colors(&path)?;
            write_result(stdout, json_output, &colors, None)
        }
        "set" => {
            let updates = parse_set(args)?;
            anyhow::ensure!(!updates.is_empty(), "set requires at least one of --h1 .. --h6");
            let colors = write_colors(&path, |colors| { colors.extend(updates); })?;
            write_result(stdout, json_output, &colors, Some(notify_app()))
        }
        "reset" => {
            let levels = parse_reset(args)?;
            let colors = write_colors(&path, |colors| {
                for (level, color) in DEFAULT_HEADING_COLORS {
                    if levels.iter().any(|item| item == level) { colors.insert(level.into(), color.into()); }
                }
            })?;
            write_result(stdout, json_output, &colors, Some(notify_app()))
        }
        _ => bail!("unknown headings action `{action}`; use get, set or reset"),
    }
}

/// 接受 #RGB、#RGBA、#RRGGBB、#RRGGBBAA、rgb()/rgba()（alpha 0~1 或百分比），返回 #RRGGBBAA。
pub(crate) fn normalize_color(input: &str) -> Result<String> {
    let value = input.trim();
    if let Some(hex) = value.strip_prefix('#') {
        anyhow::ensure!(hex.chars().all(|c| c.is_ascii_hexdigit()) && matches!(hex.len(), 3 | 4 | 6 | 8), "invalid color `{input}`");
        let full = if hex.len() <= 4 { hex.chars().flat_map(|c| [c, c]).collect() } else { hex.to_string() };
        let full = if full.len() == 6 { format!("{full}FF") } else { full };
        return Ok(format!("#{}", full.to_ascii_uppercase()));
    }
    let lower = value.to_ascii_lowercase();
    let inner = lower.strip_prefix("rgba(").or_else(|| lower.strip_prefix("rgb("))
        .and_then(|rest| rest.strip_suffix(')'))
        .with_context(|| format!("invalid color `{input}`; use #RRGGBBAA or rgba(r, g, b, a)"))?;
    let parts: Vec<&str> = inner.split([',', '/', ' ']).map(str::trim).filter(|part| !part.is_empty()).collect();
    anyhow::ensure!(matches!(parts.len(), 3 | 4), "invalid color `{input}`");
    let mut channels = String::new();
    for part in &parts[..3] {
        let channel: f64 = part.parse().with_context(|| format!("invalid color channel `{part}`"))?;
        anyhow::ensure!((0.0..=255.0).contains(&channel), "color channel out of range: {part}");
        channels.push_str(&format!("{:02X}", channel.round() as u8));
    }
    let alpha = match parts.get(3) {
        Some(part) => match part.strip_suffix('%') {
            Some(percent) => percent.parse::<f64>()? / 100.0,
            None => part.parse::<f64>()?,
        },
        None => 1.0,
    };
    anyhow::ensure!((0.0..=1.0).contains(&alpha), "alpha must be between 0 and 1: {}", parts[3]);
    Ok(format!("#{channels}{:02X}", (alpha * 255.0).round() as u8))
}

fn parse_set(args: &mut Vec<String>) -> Result<BTreeMap<String, String>> {
    let mut updates = BTreeMap::new();
    while !args.is_empty() {
        let arg = args.remove(0);
        let (name, inline) = arg.split_once('=').map_or((arg.as_str(), None), |(a, b)| (a, Some(b.to_string())));
        let level = name.strip_prefix("--").filter(|level| DEFAULT_HEADING_COLORS.iter().any(|(key, _)| key == level))
            .with_context(|| format!("unexpected argument `{arg}`; use --h1 .. --h6"))?;
        let value = match inline { Some(value) => value, None => {
            anyhow::ensure!(!args.is_empty(), "{name} requires a color");
            args.remove(0)
        }};
        anyhow::ensure!(updates.insert(level.to_string(), normalize_color(&value)?).is_none(), "duplicate option: {name}");
    }
    Ok(updates)
}

fn parse_reset(args: &mut Vec<String>) -> Result<Vec<String>> {
    if args.is_empty() || args.iter().any(|arg| arg == "all") {
        return Ok(DEFAULT_HEADING_COLORS.iter().map(|(level, _)| level.to_string()).collect());
    }
    args.drain(..).map(|arg| {
        let level = arg.to_ascii_lowercase();
        anyhow::ensure!(DEFAULT_HEADING_COLORS.iter().any(|(key, _)| *key == level), "unknown heading level `{arg}`; use h1 .. h6 or all");
        Ok(level)
    }).collect()
}

fn merged(stored: Option<&Value>) -> BTreeMap<String, String> {
    DEFAULT_HEADING_COLORS.iter().map(|(level, default)| {
        let color = stored.and_then(|value| value.get(*level)).and_then(Value::as_str)
            .and_then(|value| normalize_color(value).ok()).unwrap_or_else(|| default.to_string());
        (level.to_string(), color)
    }).collect()
}

fn read_settings(connection: &Connection) -> Result<Value> {
    let raw: Option<String> = connection.query_row("SELECT json FROM app_settings WHERE id = 1", [], |row| row.get(0)).optional()?;
    Ok(raw.map(|raw| serde_json::from_str(&raw)).transpose().context("stored settings are not valid JSON")?.unwrap_or_else(|| json!({})))
}

fn read_colors(path: &Path) -> Result<BTreeMap<String, String>> {
    if !path.exists() { return Ok(merged(None)); }
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    connection.busy_timeout(std::time::Duration::from_secs(3))?;
    Ok(merged(read_settings(&connection)?.get(SETTINGS_KEY)))
}

/// 只替换 markdownHeadingColors 字段，保留其他设置及未知字段。
fn write_colors(path: &Path, update: impl FnOnce(&mut BTreeMap<String, String>)) -> Result<BTreeMap<String, String>> {
    anyhow::ensure!(path.exists(), "SuperHigh settings not found at {}; start SuperHigh once first", path.display());
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection.busy_timeout(std::time::Duration::from_secs(3))?;
    let mut settings = read_settings(&connection)?;
    let object = settings.as_object_mut().context("settings must be a JSON object")?;
    let mut colors = merged(object.get(SETTINGS_KEY));
    update(&mut colors);
    object.insert(SETTINGS_KEY.into(), Value::Object(colors.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<Map<_, _>>()));
    connection.execute(
        "INSERT INTO app_settings (id, json) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
        params![serde_json::to_string(&settings)?],
    )?;
    Ok(colors)
}

/// 通知运行中的桌面应用重新读取设置；应用未运行时下次启动生效。
fn notify_app() -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::block_on(crate::local_control::send_request_async::<_, Value>(&json!({"operation": "appearance.reload"})))
            .is_ok_and(|response| response["ok"] == true)
    }
    #[cfg(not(windows))]
    { false }
}

fn rgba(color: &str) -> String {
    let byte = |index: usize| u8::from_str_radix(&color[index..index + 2], 16).unwrap_or(0);
    format!("rgba({}, {}, {}, {})", byte(1), byte(3), byte(5), (f64::from(byte(7)) / 255.0 * 100.0).round() / 100.0)
}

fn write_result(stdout: &mut dyn Write, json_output: bool, colors: &BTreeMap<String, String>, applied: Option<bool>) -> Result<()> {
    let is_default = |level: &str, color: &str| DEFAULT_HEADING_COLORS.iter().any(|(key, value)| *key == level && *value == color);
    if json_output {
        let mut result = json!({
            "colors": colors,
            "customized": colors.iter().filter(|(level, color)| !is_default(level, color)).map(|(level, _)| level).collect::<Vec<_>>(),
        });
        if let Some(applied) = applied { result["appliedToRunningApp"] = json!(applied); }
        serde_json::to_writer_pretty(&mut *stdout, &result)?;
        writeln!(stdout)?;
        return Ok(());
    }
    for (level, color) in colors {
        writeln!(stdout, "{level}\t{color}\t{}\t{}", rgba(color), if is_default(level, color) { "default" } else { "custom" })?;
    }
    if let Some(applied) = applied {
        writeln!(stdout, "{}", if applied { "Applied to the running app." } else { "Saved; the app is not running and will apply it on next start." })?;
    }
    Ok(())
}

fn take_flag(args: &mut Vec<String>, name: &str) -> bool {
    let before = args.len();
    args.retain(|arg| arg != name);
    args.len() != before
}

fn write_help(stdout: &mut dyn Write) -> Result<()> {
    writeln!(stdout, "Usage:
  superhigh-cli appearance headings [get] [--json]
  superhigh-cli appearance headings set [--h1 <color>] ... [--h6 <color>] [--json]
  superhigh-cli appearance headings reset [h1 ... h6 | all] [--json]

Markdown heading colors shared by all themes. Colors accept #RGB, #RRGGBB, #RRGGBBAA,
rgb(r, g, b) or rgba(r, g, b, a) with alpha 0..1 or a percentage; stored as #RRGGBBAA.
Defaults (bright red, yellow, green, cyan, blue, purple): h1 #FF9B9BFF, h2 #FFD580FF, h3 #A7E89BFF, h4 #8DE2E8FF, h5 #A8BEFFFF, h6 #D8B2FFFF.
set/reset write SuperHigh settings directly and refresh the running desktop app;
without a running app the change applies on next start. reset without levels resets all.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_hex_and_rgba_colors() {
        assert_eq!(normalize_color("#abc").unwrap(), "#AABBCCFF");
        assert_eq!(normalize_color("#11223380").unwrap(), "#11223380");
        assert_eq!(normalize_color("rgba(229, 83, 75, 0.5)").unwrap(), "#E5534B80");
        assert_eq!(normalize_color("rgb(0 0 0 / 50%)").unwrap(), "#00000080");
        for bad in ["red", "#12345", "rgba(256,0,0,1)", "rgba(0,0,0,2)"] { assert!(normalize_color(bad).is_err(), "{bad}"); }
    }

    #[test]
    fn writes_only_heading_colors_and_keeps_other_settings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("super-high.db");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch(r#"CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
            INSERT INTO app_settings (id, json) VALUES (1, '{"themeId":"dark","futureSetting":{"keep":true}}');"#).unwrap();
        drop(connection);
        let colors = write_colors(&path, |colors| { colors.insert("h2".into(), "#00000080".into()); }).unwrap();
        assert_eq!(colors["h2"], "#00000080");
        assert_eq!(colors["h1"], DEFAULT_HEADING_COLORS[0].1);
        let settings = read_settings(&Connection::open(&path).unwrap()).unwrap();
        assert_eq!(settings["themeId"], "dark");
        assert_eq!(settings["futureSetting"]["keep"], true);
        let parsed: crate::models::AppSettings = serde_json::from_value(settings).unwrap();
        assert_eq!(parsed.markdown_heading_colors.h2, "#00000080");
        assert_eq!(read_colors(&path).unwrap(), colors);
    }

    #[test]
    fn parses_set_and_reset_arguments() {
        let mut args = vec!["--h1".into(), "#fff".into(), "--h6=rgba(0,0,0,0.25)".into()];
        let updates = parse_set(&mut args).unwrap();
        assert_eq!(updates["h1"], "#FFFFFFFF");
        assert_eq!(updates["h6"], "#00000040");
        assert!(parse_set(&mut vec!["--h7".into(), "#fff".into()]).is_err());
        assert_eq!(parse_reset(&mut vec![]).unwrap().len(), 6);
        assert_eq!(parse_reset(&mut vec!["H2".into()]).unwrap(), vec!["h2"]);
        assert!(parse_reset(&mut vec!["h9".into()]).is_err());
    }
}
