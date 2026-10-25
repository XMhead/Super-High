use std::{fs, path::Path, io::{Read, Seek, SeekFrom}};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) fn prepare_kimi_completion(builder: &mut portable_pty::CommandBuilder, session_id: &str) -> anyhow::Result<()> {
    let result = prepare_kimi_completion_inner(builder, session_id);
    if result.is_err() { cleanup_kimi_completion(session_id); cleanup_gemini_completion(session_id); }
    result
}

fn prepare_kimi_completion_inner(builder: &mut portable_pty::CommandBuilder, session_id: &str) -> anyhow::Result<()> {
    let original = builder.get_env("KIMI_CODE_HOME").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("KIMI_CODE_HOME").map(std::path::PathBuf::from))
        .or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|p| std::path::PathBuf::from(p).join(".kimi-code")))
        .ok_or_else(|| anyhow::anyhow!("无法定位 Kimi 配置目录"))?;
    fs::create_dir_all(&original)?;
    let original = fs::canonicalize(original)?;
    // Fresh installations must keep their history in the real home too.
    for name in ["sessions", "logs", "skills", "telemetry", "updates", "user-history", "bin"] {
        fs::create_dir_all(original.join(name))?;
    }
    let completion = gemini_completion_path(session_id);
    let directory = completion.parent().unwrap();
    let mirror = directory.join("kimi-home");
    fs::create_dir_all(&mirror)?;
    let mut links = Vec::new();
    for entry in fs::read_dir(&original)? {
        let entry = entry?;
        if entry.file_name() == "tui.toml" { continue; }
        let original_hash = if entry.path().is_file() { Some(file_hash(&entry.path())?) } else { None };
        let target = mirror.join(entry.file_name());
        #[cfg(windows)]
        create_kimi_windows_link(&entry.path(), &target)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(entry.path(), &target)?;
        links.push(serde_json::json!({"name":entry.file_name().to_string_lossy(), "directory":entry.path().is_dir(),
            "hash": original_hash}));
        fs::write(directory.join("kimi-links.json"), serde_json::to_vec(&serde_json::json!({"root":original,"links":links}))?)?;
    }
    let original_tui = original.join("tui.toml");
    let mut tui: toml::Value = if original_tui.is_file() {
        toml::from_str(&fs::read_to_string(original_tui)?)?
    } else { toml::Value::Table(Default::default()) };
    let table = tui.as_table_mut().ok_or_else(|| anyhow::anyhow!("Kimi TUI 配置必须是 TOML 表"))?;
    let notifications = table.entry("notifications").or_insert_with(|| toml::Value::Table(Default::default()));
    let notifications = notifications.as_table_mut().ok_or_else(|| anyhow::anyhow!("Kimi notifications 必须是 TOML 表"))?;
    notifications.insert("enabled".into(), toml::Value::Boolean(true));
    notifications.insert("notification_condition".into(), toml::Value::String("always".into()));
    fs::write(mirror.join("tui.toml"), toml::to_string(&tui)?)?;
    builder.env("KIMI_CODE_HOME", mirror);
    builder.env("TERM_PROGRAM", "WezTerm");
    Ok(())
}

fn file_hash(path: &Path) -> anyhow::Result<String> { Ok(format!("{:x}", Sha256::digest(fs::read(path)?))) }

#[cfg(windows)]
fn create_kimi_windows_link(source: &Path, target: &Path) -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;
    if source.is_dir() {
        if std::os::windows::fs::symlink_dir(source, target).is_ok() { return Ok(()); }
        let result = std::process::Command::new("cmd.exe").args(["/d", "/c", "mklink", "/J"])
            .arg(target).arg(source).creation_flags(0x08000000).output()?;
        if !result.status.success() { anyhow::bail!("无法创建 Kimi 会话目录链接：{}", String::from_utf8_lossy(&result.stderr)); }
    } else if std::os::windows::fs::symlink_file(source, target).is_err() {
        fs::hard_link(source, target)?;
    }
    Ok(())
}

pub(crate) fn observe_kimi_output(session_id: &str, bytes: &[u8], state: &mut GeminiOutputState) {
    state.bytes.extend_from_slice(bytes);
    loop {
        let Some(start) = state.bytes.windows(4).position(|part| part == b"\x1b]9;") else {
            if state.bytes.len() > 3 { state.bytes.drain(..state.bytes.len() - 3); }
            break;
        };
        if start > 0 { state.bytes.drain(..start); }
        let Some(end) = state.bytes.iter().position(|byte| *byte == 7) else {
            if state.bytes.len() > 4096 { state.bytes.clear(); }
            break;
        };
        let payload = String::from_utf8_lossy(&state.bytes[4..end]).into_owned();
        state.bytes.drain(..end + 1);
        if !payload.starts_with("Kimi Code task complete") { continue; }
        let record = serde_json::json!({"type":"kimi.turn_complete", "id":uuid::Uuid::new_v4().to_string(),
            "timestamp":crate::cli_completion::unix_millis(std::time::SystemTime::now())});
        let _ = fs::write(gemini_completion_path(session_id), format!("{record}\n"));
    }
}

pub(crate) fn cleanup_kimi_completion(session_id: &str) {
    if uuid::Uuid::parse_str(session_id).is_err() { return; }
    let completion = gemini_completion_path(session_id);
    let directory = completion.parent().unwrap();
    let root = std::env::temp_dir().join("super-high/cli-completion");
    if directory.parent() != Some(root.as_path()) { return; }
    let mirror = directory.join("kimi-home");
    if let Ok(raw) = fs::read_to_string(directory.join("kimi-links.json")) {
        if let Ok(manifest) = serde_json::from_str::<Value>(&raw) {
            let original = manifest["root"].as_str().map(std::path::PathBuf::from);
            for entry in manifest["links"].as_array().into_iter().flatten() {
                let Some(name) = entry["name"].as_str() else { continue };
                if Path::new(name).components().count() != 1 { continue; }
                let link = mirror.join(name);
                if entry["directory"] == true { let _ = fs::remove_dir(link); }
                else {
                    // Persist only an atomic replacement of an original file, without overwriting concurrent changes.
                    if fs::symlink_metadata(&link).is_ok_and(|metadata| !metadata.file_type().is_symlink()) {
                        if let (Some(root), Some(baseline)) = (&original, entry["hash"].as_str()) {
                            let target = root.join(name);
                            if let (Ok(current), Ok(replacement)) = (file_hash(&target), file_hash(&link)) {
                                if current != replacement && current == baseline { let _ = fs::copy(&link, &target); }
                                else if current != replacement { continue; }
                            }
                        }
                    }
                    let _ = fs::remove_file(link);
                }
            }
            if let Some(root) = original {
                for name in ["config.toml", "device_id", "migrations-effort.json", "session_index.jsonl", "workspaces.json"] {
                    let source = mirror.join(name);
                    let target = root.join(name);
                    if source.is_file() && !target.exists() && fs::copy(&source, target).is_ok() {
                        let _ = fs::remove_file(source);
                    }
                }
            }
        }
    }
    let _ = fs::remove_file(mirror.join("tui.toml"));
    let _ = fs::remove_dir(mirror);
    let _ = fs::remove_file(directory.join("kimi-links.json"));
}

pub(crate) fn gemini_completion_path(session_id: &str) -> std::path::PathBuf {
    std::env::temp_dir().join("super-high/cli-completion").join(session_id).join("completion.jsonl")
}

/// Inject a session-scoped native hook without changing any user settings file.
pub(crate) fn prepare_gemini_completion(builder: &mut portable_pty::CommandBuilder, session_id: &str) -> anyhow::Result<()> {
    let result = prepare_gemini_completion_inner(builder, session_id);
    if result.is_err() { cleanup_gemini_completion(session_id); }
    result
}

fn prepare_gemini_completion_inner(builder: &mut portable_pty::CommandBuilder, session_id: &str) -> anyhow::Result<()> {
    let completion = gemini_completion_path(session_id);
    let directory = completion.parent().expect("completion directory");
    fs::create_dir_all(directory)?;
    let helper = directory.join("after-agent.cjs");
    fs::write(&helper, r#"const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (event.hook_event_name === 'AfterAgent') {
      const time = Date.parse(event.timestamp);
      if (Number.isFinite(time)) fs.appendFileSync(process.env.SUPERHIGH_GEMINI_PENDING,
        JSON.stringify({type:'gemini.after_agent', id:require('node:crypto').randomUUID(), timestamp:time}) + '\n');
    }
  } catch {}
  process.stdout.write('{}');
});
"#)?;
    let original = builder.get_env("GEMINI_CLI_SYSTEM_SETTINGS_PATH")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_CLI_SYSTEM_SETTINGS_PATH").map(std::path::PathBuf::from))
        .unwrap_or_else(|| std::path::PathBuf::from(if cfg!(windows) {
            "C:/ProgramData/gemini-cli/settings.json"
        } else if cfg!(target_os = "macos") {
            "/Library/Application Support/GeminiCli/settings.json"
        } else { "/etc/gemini-cli/settings.json" }));
    let mut settings: Value = if original.is_file() {
        parse_gemini_settings(&fs::read_to_string(&original)?)?
    } else { serde_json::json!({}) };
    if !settings.is_object() { anyhow::bail!("Gemini 系统设置必须是 JSON 对象") }
    // Keep previously disabled user hooks disabled while enabling our session hook.
    let home = builder.get_env("GEMINI_CLI_HOME").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_CLI_HOME").map(std::path::PathBuf::from))
        .or_else(|| std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from))
        .map(|path| path.join(".gemini"));
    let mut configurations = Vec::new();
    let defaults = builder.get_env("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").map(std::path::PathBuf::from))
        .or_else(|| original.parent().map(|parent| parent.join("system-defaults.json")));
    if let Some(defaults) = defaults { read_gemini_settings(&defaults, &mut configurations)?; }
    if let Some(home) = &home { read_gemini_settings(&home.join("settings.json"), &mut configurations)?; }
    if let Some(cwd) = builder.get_cwd() {
        let mut ancestors = Path::new(cwd).ancestors().collect::<Vec<_>>();
        ancestors.reverse();
        for directory in ancestors { read_gemini_settings(&directory.join(".gemini/settings.json"), &mut configurations)?; }
    }
    configurations.push(settings.clone());
    let enabled = configurations.iter().filter_map(|value| value.pointer("/hooksConfig/enabled").and_then(Value::as_bool)).last().unwrap_or(true);
    if !enabled {
        if let Some(home) = &home {
            if let Ok(extensions) = fs::read_dir(home.join("extensions")) {
                for extension in extensions.flatten() { read_gemini_settings(&extension.path().join("gemini-extension.json"), &mut configurations)?; }
            }
        }
        let mut disabled = settings.pointer("/hooksConfig/disabled").and_then(Value::as_array).cloned().unwrap_or_default();
        for value in &configurations {
            if let Some(events) = value["hooks"].as_object() {
                for definitions in events.values().filter_map(Value::as_array) {
                    for definition in definitions {
                        for hook in definition["hooks"].as_array().into_iter().flatten() {
                            if let Some(name) = hook["name"].as_str().filter(|name| !name.is_empty()).or_else(|| hook["command"].as_str()).or(Some("unknown-hook")) {
                                let name = Value::String(name.into());
                                if !disabled.contains(&name) { disabled.push(name); }
                            }
                        }
                    }
                }
            }
        }
        settings["hooksConfig"]["disabled"] = Value::Array(disabled);
    }
    if !settings["hooks"].is_object() { settings["hooks"] = serde_json::json!({}); }
    if !settings["hooks"]["AfterAgent"].is_array() { settings["hooks"]["AfterAgent"] = serde_json::json!([]); }
    settings["hooks"]["AfterAgent"].as_array_mut().unwrap().push(serde_json::json!({
        "hooks": [{"name":"super-high-turn-completion", "type":"command",
            "command": format!("node \"{}\"", helper.to_string_lossy())}]
    }));
    settings["hooksConfig"]["enabled"] = Value::Bool(true);
    settings["ui"]["dynamicWindowTitle"] = Value::Bool(true);
    settings["ui"]["hideWindowTitle"] = Value::Bool(false);
    let settings_path = directory.join("settings.json");
    fs::write(&settings_path, serde_json::to_vec(&settings)?)?;
    // Preserve system-defaults lookup when replacing the system settings path.
    if builder.get_env("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").is_none()
        && std::env::var_os("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").is_none() {
        if let Some(parent) = original.parent() {
            builder.env("GEMINI_CLI_SYSTEM_DEFAULTS_PATH", parent.join("system-defaults.json"));
        }
    }
    builder.env("GEMINI_CLI_SYSTEM_SETTINGS_PATH", settings_path);
    builder.env("SUPERHIGH_GEMINI_PENDING", directory.join("pending.jsonl"));
    Ok(())
}

fn read_gemini_settings(path: &Path, configurations: &mut Vec<Value>) -> anyhow::Result<()> {
    if path.is_file() { configurations.push(parse_gemini_settings(&fs::read_to_string(path)?)?); }
    Ok(())
}

fn parse_gemini_settings(raw: &str) -> anyhow::Result<Value> {
    let mut output = raw.as_bytes().to_vec();
    let bytes = raw.as_bytes();
    let (mut index, mut quoted, mut escaped) = (0, false, false);
    while index < bytes.len() {
        if quoted {
            if escaped { escaped = false; }
            else if bytes[index] == b'\\' { escaped = true; }
            else if bytes[index] == b'"' { quoted = false; }
            index += 1;
            continue;
        }
        if bytes[index] == b'"' { quoted = true; index += 1; continue; }
        if bytes[index..].starts_with(b"//") {
            while index < bytes.len() && !matches!(bytes[index], b'\r' | b'\n') { output[index] = b' '; index += 1; }
        } else if bytes[index..].starts_with(b"/*") {
            output[index] = b' '; output[index + 1] = b' '; index += 2;
            while index < bytes.len() && !bytes[index..].starts_with(b"*/") {
                if !matches!(bytes[index], b'\r' | b'\n') { output[index] = b' '; }
                index += 1;
            }
            if index + 1 < bytes.len() { output[index] = b' '; output[index + 1] = b' '; index += 2; }
        } else { index += 1; }
    }
    Ok(serde_json::from_slice(&output)?)
}

#[derive(Default)]
pub(crate) struct GeminiOutputState {
    bytes: Vec<u8>,
    completed_token: Option<String>,
}

/// Native Ready title confirms that AfterAgent hooks have finished, including continuations.
pub(crate) fn observe_gemini_output(session_id: &str, bytes: &[u8], state: &mut GeminiOutputState) {
    state.bytes.extend_from_slice(bytes);
    loop {
        let Some(start) = state.bytes.windows(4).position(|part| part == b"\x1b]0;" || part == b"\x1b]2;") else {
            if state.bytes.len() > 3 { state.bytes.drain(..state.bytes.len() - 3); }
            break;
        };
        if start > 0 { state.bytes.drain(..start); }
        let Some(end) = state.bytes.iter().position(|byte| *byte == 7)
            .or_else(|| state.bytes.windows(2).position(|part| part == b"\x1b\\")) else {
            if state.bytes.len() > 4096 { state.bytes.clear(); }
            break;
        };
        let title = String::from_utf8_lossy(&state.bytes[4..end]).into_owned();
        let terminator_size = if state.bytes[end] == 7 { 1 } else { 2 };
        state.bytes.drain(..end + terminator_size);
        if !title.starts_with("◇  Ready (") { continue; }
        let completion = gemini_completion_path(session_id);
        let Some(parent) = completion.parent() else { continue };
        let Ok(Some((token, timestamp))) = latest_completion("gemini", &parent.join("pending.jsonl").to_string_lossy()) else { continue };
        if state.completed_token.as_deref() == Some(&token) { continue; }
        let record = serde_json::json!({"type":"gemini.after_agent", "id":token, "timestamp":timestamp});
        if fs::write(completion, format!("{record}\n")).is_ok() { state.completed_token = Some(token); }
    }
}

pub(crate) fn cleanup_gemini_completion(session_id: &str) {
    if uuid::Uuid::parse_str(session_id).is_err() { return; }
    if let Some(directory) = gemini_completion_path(session_id).parent() {
        let root = std::env::temp_dir().join("super-high/cli-completion");
        if directory.parent() != Some(root.as_path()) { return; }
        for name in ["after-agent.cjs", "settings.json", "pending.jsonl", "completion.jsonl"] {
            let _ = fs::remove_file(directory.join(name));
        }
        let _ = fs::remove_dir(directory);
    }
}

pub(crate) fn watch_path(provider: &str, source: &str) -> std::path::PathBuf {
    let source = Path::new(source);
    match provider {
        "kimi" => Some(source.to_path_buf()),
        "grok" => source.parent().map(|p| p.join("updates.jsonl")),
        _ => Some(source.to_path_buf()),
    }.unwrap_or_else(|| source.to_path_buf())
}

/// Only durable provider completion records count; output text and inactivity do not.
pub(crate) fn latest_completion(provider: &str, source: &str) -> anyhow::Result<Option<(String, i64)>> {
    if !matches!(provider, "kimi" | "grok" | "codebuddy" | "gemini") { return Ok(None) }
    let path = watch_path(provider, source);
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let offset = file.metadata()?.len().saturating_sub(256 * 1024);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.lines().enumerate().filter(|(index, _)| offset == 0 || *index > 0)
        .filter_map(|(_, line)| serde_json::from_str::<Value>(line).ok())
        .filter_map(|record| record_completion(provider, &record))
        .max_by_key(|(_, time)| *time))
}

fn record_completion(provider: &str, record: &Value) -> Option<(String, i64)> {
    match provider {
        "grok" if record.pointer("/params/update/sessionUpdate")?.as_str()? == "turn_completed" => {
            let id = record.pointer("/params/update/prompt_id")?.as_str()?;
            let time = record.pointer("/params/_meta/agentTimestampMs")?.as_i64()?;
            Some((id.to_owned(), time))
        }
        "kimi" if record["type"] == "kimi.turn_complete" => {
            Some((record["id"].as_str()?.to_owned(), record["timestamp"].as_i64()?))
        }
        "codebuddy" if record["type"] == "turn-metrics"
            && record["source"] != "background-task" => {
            Some((record["id"].as_str()?.to_owned(), record["timestamp"].as_i64()?))
        }
        "gemini" if record["type"] == "gemini.after_agent" => {
            Some((record["id"].as_str()?.to_owned(), record["timestamp"].as_i64()?))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn gemini_jsonc_preserves_urls_quotes_and_comment_like_strings() {
        let value = parse_gemini_settings(r#"{
          // native settings accept comments
          "url":"https://example.com/a/*b*/", /* outside comment */
          "quote":"escaped \" // still string",
          "hooksConfig":{"enabled":false}
        }"#).unwrap();
        assert_eq!(value["url"], "https://example.com/a/*b*/");
        assert_eq!(value["quote"], "escaped \" // still string");
        assert_eq!(value["hooksConfig"]["enabled"], false);
    }

    #[test]
    fn kimi_native_notification_rejects_approval_and_handles_split_osc() {
        let id = uuid::Uuid::new_v4().to_string();
        let completion = gemini_completion_path(&id);
        fs::create_dir_all(completion.parent().unwrap()).unwrap();
        let mut state = GeminiOutputState::default();
        observe_kimi_output(&id, b"\x07\x1b]9;Kimi Code approval required\x07", &mut state);
        assert!(!completion.exists());
        observe_kimi_output(&id, b"\x1b]9;Kimi Code task ", &mut state);
        assert!(!completion.exists());
        observe_kimi_output(&id, b"complete: Done\x07", &mut state);
        assert!(latest_completion("kimi", &completion.to_string_lossy()).unwrap().is_some());
        cleanup_gemini_completion(&id);
    }

    #[test]
    fn kimi_session_mirror_keeps_history_at_original_home() {
        let original = tempfile::tempdir().unwrap();
        fs::write(original.path().join("tui.toml"), "theme='light'\n[notifications]\nenabled=false\nnotification_condition='unfocused'\n").unwrap();
        fs::write(original.path().join("config.toml"), "original-config").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut builder = portable_pty::CommandBuilder::new("kimi");
        builder.env("KIMI_CODE_HOME", original.path());
        prepare_kimi_completion(&mut builder, &id).unwrap();
        let mirror = std::path::PathBuf::from(builder.get_env("KIMI_CODE_HOME").unwrap());
        fs::write(mirror.join("sessions/probe"), "history").unwrap();
        assert_eq!(fs::read_to_string(original.path().join("sessions/probe")).unwrap(), "history");
        assert_eq!(fs::read_to_string(mirror.join("config.toml")).unwrap(), "original-config");
        let tui: toml::Value = toml::from_str(&fs::read_to_string(mirror.join("tui.toml")).unwrap()).unwrap();
        assert_eq!(tui["theme"].as_str(), Some("light"));
        assert_eq!(tui["notifications"]["enabled"].as_bool(), Some(true));
        cleanup_kimi_completion(&id);
        cleanup_gemini_completion(&id);
        assert!(original.path().join("sessions/probe").exists());
        assert!(original.path().join("config.toml").exists());
    }

    #[test]
    fn gemini_waits_for_native_ready_after_hooks_and_handles_split_osc() {
        let id = uuid::Uuid::new_v4().to_string();
        let completion = gemini_completion_path(&id);
        let directory = completion.parent().unwrap();
        fs::create_dir_all(directory).unwrap();
        let pending = json!({"type":"gemini.after_agent","id":"turn-1","timestamp":1234});
        fs::write(directory.join("pending.jsonl"), format!("{pending}\n")).unwrap();
        let mut state = GeminiOutputState::default();
        observe_gemini_output(&id, b"\x1b]0;", &mut state);
        observe_gemini_output(&id, "✦  Working… (test)\x07".as_bytes(), &mut state);
        assert!(!completion.exists());
        observe_gemini_output(&id, "\x1b]0;✋  Action Required (test)\x07".as_bytes(), &mut state);
        assert!(!completion.exists());
        observe_gemini_output(&id, "\x1b]0;◇  Ready (test)\x1b".as_bytes(), &mut state);
        assert!(!completion.exists());
        observe_gemini_output(&id, b"\\", &mut state);
        assert_eq!(latest_completion("gemini", &completion.to_string_lossy()).unwrap(), Some(("turn-1".into(),1234)));
        cleanup_gemini_completion(&id);
        assert!(!directory.exists());
    }

    #[test]
    fn accepts_provider_turn_records_and_rejects_tool_steps() {
        assert_eq!(record_completion("grok", &json!({"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"turn-1"},"_meta":{"agentTimestampMs":1234}}})), Some(("turn-1".into(),1234)));
        assert_eq!(record_completion("kimi", &json!({"type":"kimi.turn_complete","id":"turn-1","timestamp":1234})), Some(("turn-1".into(),1234)));
        assert!(record_completion("kimi", &json!({"type":"context.append_loop_event","event":{"type":"step.end","finishReason":"end_turn","uuid":"step-1"},"time":1234})).is_none());
        assert!(record_completion("kimi", &json!({"type":"context.append_loop_event","event":{"type":"step.end","finishReason":"tool_use","uuid":"step-1"},"time":1234})).is_none());
        assert!(record_completion("codebuddy", &json!({"type":"message","role":"assistant","status":"completed","id":"message-1","timestamp":1234})).is_none());
        assert!(record_completion("codebuddy", &json!({"type":"turn-metrics","source":"background-task","id":"task-1","timestamp":1234})).is_none());
        assert_eq!(record_completion("codebuddy", &json!({"type":"turn-metrics","id":"turn-1","timestamp":1234})), Some(("turn-1".into(),1234)));
    }
}
