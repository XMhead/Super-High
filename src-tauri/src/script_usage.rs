//! Skill 脚本使用统计：增量扫描 Claude Code / Codex 原生会话记录里的 shell 命令，只统计 Agent Skill
//! 自带的脚本（`<skill>/scripts/**`，skill 目录含 `SKILL.md`），按「本地日期 × 脚本 × 来源」累计次数，
//! 用来判断哪些 skill 脚本已经过时、无人调用。
//!
//! - 内部与外部对话都会写原生 JSONL，无需 Hook；每个文件只读新增的完整行，按调用 ID 去重，
//!   续接会话复制旧消息时不重复计数。
//! - 同一 skill 常经 `.agents/skills`、`.claude/skills` 等软链接/联接暴露到 `.skillshare/skills`，
//!   计数按 skill 物理目录归并；扫描时 skill 目录已不存在的调用无法确认归属，不计入。
//! - 会话记录会被 CLI 定期清理（Claude 默认 30 天），计数持久化在应用数据目录的独立数据库。
//! - 脚本工具面板直接启动的 skill 脚本不经过会话记录，由 `record_direct` 计入。
//! - 普通项目脚本与 `.agent/tmp` 下的临时脚本不计入。
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use walkdir::WalkDir;

use crate::skills::{SkillDirectory, SkillScope};

const SCRIPT_EXTENSIONS: &[&str] = &["ps1", "py", "sh", "bash", "mjs", "cjs", "js", "ts", "bat", "cmd"];
/// skill `scripts/` 下不属于 skill 自身脚本的依赖与构建目录。
const SKIPPED_DIRS: &[&str] = &["node_modules", "__pycache__", "venv", "site-packages", "dist", "build", "target"];
const SCAN_INTERVAL: Duration = Duration::from_secs(20 * 60);
const STARTUP_DELAY: Duration = Duration::from_secs(15);
const DAY_MS: i64 = 86_400_000;

static SCAN_LOCK: Mutex<()> = Mutex::new(());

/// v1 统计所有脚本；v2 只统计 skill 脚本，旧库整体丢弃后从会话记录重建。
const SCHEMA_VERSION: i64 = 2;
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS scanned_files (
  file_key TEXT PRIMARY KEY,
  read_bytes INTEGER NOT NULL,
  cwd TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS seen_calls (call_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS skill_script_usage (
  day TEXT NOT NULL,
  script_key TEXT NOT NULL,
  skill_dir TEXT NOT NULL,
  script TEXT NOT NULL,
  source TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_used_ms INTEGER NOT NULL,
  PRIMARY KEY (day, script_key, source)
);
"#;
/// 某个本地日期下某个 skill 脚本（`<skill>/<skill 内路径>`）的调用次数。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptUsageDailyRow {
    pub date: String,
    pub script: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillScriptUsage {
    pub skill: String,
    /// project / global：当前工作区可见的 skill；other：不在当前可见范围但调用过的 skill。
    pub scope: String,
    /// skill 物理目录（已解析软链接）。
    pub skill_dir: String,
    /// skill 内相对路径，如 `scripts/tool.py`。
    pub script: String,
    pub path: String,
    pub count: i64,
    /// 最近 30 天（含今天）的调用次数。
    pub recent_30d: i64,
    /// 0 表示从未调用。
    pub last_used_ms: i64,
    /// 距上次调用的天数；从未调用为 null。
    pub idle_days: Option<i64>,
    pub exists: bool,
    /// 文件名出现在 SKILL.md 或 references/ 中。
    pub documented: bool,
    /// 同一 skill 内引用了它（文件名或模块名）的其它脚本；仅对未调用的脚本计算。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub referenced_by: Vec<String>,
    /// claude / codex / superhigh 各自的次数。
    pub sources: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ScriptUsageResponse {
    pub workspace: String,
    pub daily: Vec<ScriptUsageDailyRow>,
    pub scripts: Vec<SkillScriptUsage>,
    pub error: Option<String>,
}

/// 一次调用解析出的 skill 脚本。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillScript {
    /// skill 物理目录，规范化正斜杠路径。
    skill_dir: String,
    /// skill 内相对路径，以 `scripts/` 开头。
    script: String,
}

impl SkillScript {
    fn key(&self) -> String {
        format!("{}/{}", self.skill_dir, self.script).to_lowercase()
    }
}

/// 判断脚本路径是否属于某个 skill 的 `scripts/`，并把软链接别名归并到物理目录；结果按候选目录缓存。
#[derive(Default)]
struct SkillResolver {
    dirs: HashMap<String, Option<String>>,
}

impl SkillResolver {
    fn resolve(&mut self, path: &str) -> Option<SkillScript> {
        let parts: Vec<&str> = path.split('/').collect();
        // 从最内层的 scripts 段找起：嵌在别的 skill 里的子 skill 归内层。
        for index in (1..parts.len().saturating_sub(1)).rev() {
            if !parts[index].eq_ignore_ascii_case("scripts") {
                continue;
            }
            if let Some(skill_dir) = self.skill_dir(&parts[..index].join("/")) {
                return Some(SkillScript { skill_dir, script: parts[index..].join("/") });
            }
        }
        None
    }

    fn skill_dir(&mut self, candidate: &str) -> Option<String> {
        self.dirs
            .entry(candidate.to_lowercase())
            .or_insert_with(|| {
                let dir = Path::new(candidate);
                if !dir.join("SKILL.md").is_file() {
                    return None;
                }
                fs::canonicalize(dir).ok().map(|dir| canonical_text(&dir))
            })
            .clone()
    }
}

fn canonical_text(path: &Path) -> String {
    normalize_lexical(&crate::fs_ops::normalize_path(path))
}

/// 应用启动后在后台定期扫描，确保会话记录被 CLI 清理前已计入。
pub fn start_background_scan() {
    let _ = std::thread::Builder::new()
        .name("superhigh-script-usage".to_string())
        .spawn(|| {
            std::thread::sleep(STARTUP_DELAY);
            loop {
                if let Err(error) = scan() {
                    eprintln!("[Super High] Script usage scan failed: {error:#}");
                }
                std::thread::sleep(SCAN_INTERVAL);
            }
        });
}

/// 设置面板：先补扫新增会话记录，再返回当前工作区可见 skill 的脚本统计；失败写入 `error`。
pub fn load(workspace: &str) -> ScriptUsageResponse {
    load_checked(workspace, false).unwrap_or_else(|error| ScriptUsageResponse {
        workspace: normalize_lexical(workspace),
        error: Some(format!("读取脚本使用统计失败：{error:#}")),
        ..ScriptUsageResponse::default()
    })
}

/// `all` 为 true 时额外列出不在当前工作区可见范围、但调用过的 skill 脚本。
pub fn load_checked(workspace: &str, all: bool) -> anyhow::Result<ScriptUsageResponse> {
    let root = normalize_lexical(workspace);
    scan()?;
    let connection = open(&database_path()?)?;
    let inventory = crate::skills::list_skill_directories(Some(Path::new(&root)));
    query_usage(&connection, &root, &inventory, all, now_ms())
}

/// 脚本工具面板直接启动的 skill 脚本不进会话记录，在启动成功后直接计一次。
#[cfg_attr(test, allow(dead_code))]
pub fn record_direct(script: &Path) {
    let path = normalize_lexical(&crate::fs_ops::normalize_path(script));
    if path.is_empty() || is_excluded(&path) {
        return;
    }
    let Some(script) = SkillResolver::default().resolve(&path) else { return };
    let result = database_path()
        .and_then(|db| open(&db))
        .and_then(|connection| record(&connection, &script, "superhigh", now_ms()));
    if let Err(error) = result {
        eprintln!("[Super High] Failed to record script usage: {error:#}");
    }
}

fn scan() -> anyhow::Result<()> {
    let Some(home) = user_home() else { return Ok(()) };
    let _guard = SCAN_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut connection = open(&database_path()?)?;
    scan_home(&mut connection, &home)
}

fn database_path() -> anyhow::Result<PathBuf> {
    Ok(crate::cli_workspace::app_data_path()?.join("script-usage.db"))
}

fn open(path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut connection = Connection::open(path).context("无法打开脚本统计数据库")?;
    connection.busy_timeout(Duration::from_secs(10))?;
    // 应用与 superhigh-cli 可能同时打开：版本检查与重建放在同一写事务里。
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = transaction.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version != SCHEMA_VERSION {
        transaction.execute_batch(
            "DROP TABLE IF EXISTS script_usage; DROP TABLE IF EXISTS skill_script_usage; \
             DROP TABLE IF EXISTS seen_calls; DROP TABLE IF EXISTS scanned_files;",
        )?;
        transaction.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    }
    transaction.execute_batch(SCHEMA)?;
    transaction.commit()?;
    Ok(connection)
}

fn record(connection: &Connection, script: &SkillScript, source: &str, at_ms: i64) -> anyhow::Result<()> {
    // 路径键在 Rust 侧小写：SQLite 的 lower() 只处理 ASCII。
    connection.execute(
        "INSERT INTO skill_script_usage (day, script_key, skill_dir, script, source, count, last_used_ms) \
         VALUES (date(?1 / 1000, 'unixepoch', 'localtime'), ?2, ?3, ?4, ?5, 1, ?1) \
         ON CONFLICT(day, script_key, source) DO UPDATE SET \
           count = count + 1, \
           last_used_ms = max(last_used_ms, excluded.last_used_ms), \
           skill_dir = excluded.skill_dir, \
           script = excluded.script",
        params![at_ms, script.key(), script.skill_dir, script.script, source],
    )?;
    Ok(())
}
fn scan_home(connection: &mut Connection, home: &Path) -> anyhow::Result<()> {
    let mut resolver = SkillResolver::default();
    let roots = [
        ("claude", home.join(".claude").join("projects")),
        ("codex", home.join(".codex").join("sessions")),
        ("codex", home.join(".codex").join("archived_sessions")),
    ];
    for (provider, root) in roots {
        if !root.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root).into_iter().flatten() {
            let path = entry.path();
            if !entry.file_type().is_file() || path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            // Codex 归档会把会话从 sessions 移到 archived_sessions，文件名不变，用文件名作键避免重扫。
            let key = if provider == "codex" {
                format!("codex:{}", path.file_name().unwrap_or_default().to_string_lossy())
            } else {
                format!("claude:{}", crate::fs_ops::normalize_path(path.strip_prefix(&root).unwrap_or(path)))
            };
            if let Err(error) = scan_file(connection, &mut resolver, provider, &key, path, home) {
                eprintln!("[Super High] Skipped session file {}: {error:#}", path.display());
            }
        }
    }
    Ok(())
}

fn scan_file(connection: &mut Connection, resolver: &mut SkillResolver, provider: &str, key: &str, path: &Path, home: &Path) -> anyhow::Result<()> {
    let metadata = fs::metadata(path)?;
    let length = metadata.len();
    let state: Option<(u64, String)> = connection
        .query_row("SELECT read_bytes, cwd FROM scanned_files WHERE file_key = ?1", [key], |row| {
            Ok((row.get::<_, i64>(0)? as u64, row.get(1)?))
        })
        .optional()?;
    let (mut offset, mut cwd) = match state {
        Some((offset, _)) if offset == length => return Ok(()),
        // 文件变短说明被重写，从头再读；调用 ID 去重避免重复计数。
        Some((offset, _)) if offset > length => (0, String::new()),
        Some(state) => state,
        None => (0, String::new()),
    };
    let fallback_ms = metadata.modified().ok().map(system_time_ms).unwrap_or_else(now_ms);
    let mut reader = BufReader::new(File::open(path)?);
    reader.seek(SeekFrom::Start(offset))?;
    let transaction = connection.transaction()?;
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = reader.read_until(b'\n', &mut buffer)?;
        // 只消费完整的行；正在写入的末行留到下次扫描。
        if read == 0 || buffer.last() != Some(&b'\n') {
            break;
        }
        offset += read as u64;
        let Ok(line) = std::str::from_utf8(&buffer) else { continue };
        let calls = if provider == "codex" { codex_calls(line, &mut cwd) } else { claude_calls(line) };
        for call in calls {
            let call_cwd = call.cwd.as_deref().unwrap_or(&cwd);
            // 只计 skill 自带脚本；普通项目脚本在此丢弃。
            let mut seen = HashSet::new();
            let scripts: Vec<SkillScript> = scripts_in_command(&call.command, call_cwd, home)
                .iter()
                .filter_map(|path| resolver.resolve(path))
                .filter(|script| seen.insert(script.key()))
                .collect();
            if scripts.is_empty() {
                continue;
            }
            let call_id = format!("{provider}:{}", call.id);
            if transaction.execute("INSERT OR IGNORE INTO seen_calls (call_id) VALUES (?1)", [&call_id])? == 0 {
                continue;
            }
            let at_ms = call.at_ms.unwrap_or(fallback_ms);
            for script in scripts {
                record(&transaction, &script, provider, at_ms)?;
            }
        }
    }
    transaction.execute(
        "INSERT INTO scanned_files (file_key, read_bytes, cwd) VALUES (?1, ?2, ?3) \
         ON CONFLICT(file_key) DO UPDATE SET read_bytes = excluded.read_bytes, cwd = excluded.cwd",
        params![key, offset as i64, cwd],
    )?;
    transaction.commit()?;
    Ok(())
}

struct ShellCall {
    id: String,
    command: String,
    cwd: Option<String>,
    at_ms: Option<i64>,
}

/// Claude Code：assistant 消息里的 Bash/PowerShell tool_use，以及用户 `!` 手动执行的命令。
fn claude_calls(line: &str) -> Vec<ShellCall> {
    let tool_use = line.contains("\"tool_use\"");
    let bash_input = line.contains("<bash-input>");
    if !tool_use && !bash_input {
        return Vec::new();
    }
    let Ok(record) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    let cwd = record["cwd"].as_str().map(str::to_string);
    let at_ms = record["timestamp"].as_str().and_then(parse_timestamp_ms);
    let mut calls = Vec::new();
    match &record["message"]["content"] {
        Value::Array(items) => {
            for item in items {
                if item["type"] == "tool_use" && matches!(item["name"].as_str(), Some("Bash" | "PowerShell")) {
                    if let (Some(id), Some(command)) = (item["id"].as_str(), item["input"]["command"].as_str()) {
                        calls.push(ShellCall { id: id.into(), command: command.into(), cwd: cwd.clone(), at_ms });
                    }
                }
            }
        }
        Value::String(text) if bash_input && record["type"] == "user" => {
            let command = text.split_once("<bash-input>").and_then(|(_, rest)| rest.split_once("</bash-input>"));
            if let (Some((command, _)), Some(id)) = (command, record["uuid"].as_str()) {
                calls.push(ShellCall { id: id.into(), command: command.into(), cwd, at_ms });
            }
        }
        _ => {}
    }
    calls
}
/// Codex：`exec_command`/`shell` 函数调用与 `local_shell_call`；会话 cwd 来自 session_meta/turn_context。
fn codex_calls(line: &str, cwd: &mut String) -> Vec<ShellCall> {
    let context = line.contains("\"session_meta\"") || line.contains("\"turn_context\"");
    let call = line.contains("\"function_call\"") || line.contains("\"local_shell_call\"");
    if !context && !call {
        return Vec::new();
    }
    let Ok(record) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    // 新版包在 payload 里，旧版 rollout 直接平铺。
    let payload = if record["payload"].is_object() { &record["payload"] } else { &record };
    if matches!(record["type"].as_str(), Some("session_meta" | "turn_context")) {
        if let Some(value) = payload["cwd"].as_str() {
            *cwd = value.to_string();
        }
        return Vec::new();
    }
    let at_ms = record["timestamp"].as_str().and_then(parse_timestamp_ms);
    let id = payload["call_id"].as_str().or_else(|| payload["id"].as_str());
    let (arguments, command) = match payload["type"].as_str() {
        Some("function_call") if matches!(payload["name"].as_str(), Some("exec_command" | "shell" | "shell_command" | "container.exec")) => {
            let arguments = match &payload["arguments"] {
                Value::String(text) => serde_json::from_str::<Value>(text).unwrap_or(Value::Null),
                other => other.clone(),
            };
            let command = command_text(&arguments["cmd"]).or_else(|| command_text(&arguments["command"]));
            (arguments, command)
        }
        Some("local_shell_call") => {
            let action = payload["action"].clone();
            let command = command_text(&action["command"]);
            (action, command)
        }
        _ => return Vec::new(),
    };
    let (Some(id), Some(command)) = (id, command) else { return Vec::new() };
    let call_cwd = ["workdir", "working_directory", "cwd"]
        .iter()
        .find_map(|key| arguments[*key].as_str())
        .map(str::to_string);
    vec![ShellCall { id: id.into(), command, cwd: call_cwd, at_ms }]
}

/// 命令可能是字符串，也可能是 `["bash", "-lc", "<脚本>"]` 形式的参数数组。
fn command_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect();
            (!parts.is_empty()).then(|| join_tokens(&parts))
        }
        _ => None,
    }
}

fn parse_timestamp_ms(value: &str) -> Option<i64> {
    let parsed = time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()?;
    Some((parsed.unix_timestamp_nanos() / 1_000_000) as i64)
}

fn system_time_ms(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or(0)
}

fn now_ms() -> i64 {
    system_time_ms(SystemTime::now())
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}
/// 从一条 shell 命令中找出被执行的脚本绝对路径（已排除 `.agent/tmp`），按出现顺序去重。
fn scripts_in_command(command: &str, cwd: &str, home: &Path) -> Vec<String> {
    let mut found = Vec::new();
    collect_scripts(command, &normalize_lexical(cwd), home, 0, &mut found);
    let mut seen = std::collections::HashSet::new();
    found.retain(|path| !is_excluded(path) && seen.insert(path.to_lowercase()));
    found
}

fn collect_scripts(command: &str, cwd: &str, home: &Path, depth: usize, found: &mut Vec<String>) {
    if depth > 3 {
        return;
    }
    let mut cwd = cwd.to_string();
    let mut variables: HashMap<String, String> = HashMap::new();
    for segment in split_segments(command) {
        let mut tokens = tokenize(&segment);
        if let Some(rest) = remember_assignment(&tokens, &mut variables) {
            tokens = rest;
        }
        expand_variable(&mut tokens, &variables);
        // `cd x && python y.py`：后续片段按切换后的目录解析相对路径。
        if let Some(target) = cd_target(&tokens) {
            if let Some(next) = resolve_path(target, &cwd, home) {
                cwd = next;
            }
            continue;
        }
        match executed(&tokens) {
            Some(Executed::Script(token)) => found.extend(resolve_path(&token, &cwd, home)),
            Some(Executed::Inline(inner)) => collect_scripts(&inner, &cwd, home, depth + 1, found),
            None => {}
        }
    }
}

/// 记住 `CLI="python x.py --json"` 这类保存命令的变量；PowerShell `$r = python x.py` 返回右侧命令。
fn remember_assignment(tokens: &[String], variables: &mut HashMap<String, String>) -> Option<Vec<String>> {
    if let [token] = tokens {
        let (name, value) = token.split_once('=')?;
        if !is_env_assignment(token) || name.starts_with('$') {
            return None;
        }
        variables.insert(name.to_string(), value.to_string());
        return Some(Vec::new());
    }
    let name = tokens.first()?.strip_prefix('$')?;
    if tokens.get(1).map(String::as_str) != Some("=") || name.is_empty() || name.contains(':') {
        return None;
    }
    let rest = tokens[2..].to_vec();
    if let [value] = rest.as_slice() {
        if value.chars().any(char::is_whitespace) {
            variables.insert(name.to_string(), value.clone());
            return Some(Vec::new());
        }
    }
    Some(rest)
}

/// `$CLI project open` / `& $CLI` 展开为变量里保存的命令。
fn expand_variable(tokens: &mut Vec<String>, variables: &HashMap<String, String>) {
    if variables.is_empty() {
        return;
    }
    let Some(index) = tokens.iter().position(|token| !PREFIXES.contains(&token.as_str()) && !is_env_assignment(token)) else { return };
    let name = tokens[index].trim_start_matches('$').trim_start_matches('{').trim_end_matches('}');
    if !tokens[index].starts_with('$') {
        return;
    }
    if let Some(value) = variables.get(name) {
        let expanded = tokenize(value);
        tokens.splice(index..=index, expanded);
    }
}

enum Executed {
    Script(String),
    /// `bash -c`、`pwsh -Command`、`cmd /c` 携带的内层命令。
    Inline(String),
}

const SHELLS: &[&str] = &["bash", "sh", "zsh", "dash", "pwsh", "powershell", "cmd"];
const INTERPRETERS: &[&str] = &["py", "node", "bun", "deno", "tsx", "ts-node", "uv", "pipenv", "poetry", "ruby", "perl"];
const PREFIXES: &[&str] = &["&", ".", "source", "call", "start", "exec", "time", "nohup", "sudo", "env", "command", "then", "do", "else"];
/// 后面跟取值的解释器选项；取值本身像脚本时不跳过（如 `bash -x run.sh`）。
const VALUE_FLAGS: &[&str] = &["-x", "-w", "-executionpolicy", "-ep", "-workingdirectory", "-wd", "-r", "--require", "--import", "--loader", "--with", "--python", "--project"];

fn is_runner(name: &str) -> bool {
    SHELLS.contains(&name) || INTERPRETERS.contains(&name) || name.starts_with("python")
}

/// 找出一个简单命令实际执行的脚本：直接执行（`./x.sh`、`& "x.ps1"`）或作为解释器的首个脚本参数。
fn executed(tokens: &[String]) -> Option<Executed> {
    let mut runner: Option<String> = None;
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        index += 1;
        if token.is_empty() {
            continue;
        }
        let name = command_name(token);
        let Some(current) = runner.clone() else {
            if PREFIXES.contains(&name.as_str()) || is_env_assignment(token) {
                continue;
            }
            if is_runner(&name) {
                runner = Some(name);
                continue;
            }
            // PowerShell `& $python x.py`：变量里的解释器。
            if token.starts_with('$') && !token.contains('=') {
                runner = Some(String::new());
                continue;
            }
            return is_script_token(token).then(|| Executed::Script(token.to_string()));
        };
        if let Some(shell_code) = inline_flag(&current, token) {
            // python -c / node -e / python -m 执行的是内联代码或模块，不是脚本文件。
            if !shell_code {
                return None;
            }
            let rest = &tokens[index..];
            let text = if rest.len() == 1 { rest[0].clone() } else { join_tokens(rest) };
            return (!text.trim().is_empty()).then_some(Executed::Inline(text));
        }
        if is_script_token(token) {
            return Some(Executed::Script(token.to_string()));
        }
        if is_flag(&current, token) {
            let takes_value = VALUE_FLAGS.contains(&token.to_ascii_lowercase().as_str());
            if takes_value && tokens.get(index).is_some_and(|next| !is_script_token(next)) {
                index += 1;
            }
            continue;
        }
        if matches!(token, "run" | "--") {
            continue;
        }
        // `poetry run python x.py`、`uv run python x.py`：子命令后再出现解释器。
        if is_runner(&name) {
            runner = Some(name);
            continue;
        }
        return None;
    }
    None
}

/// Some(true)：其后是 shell 代码；Some(false)：其后是内联代码或模块；None：普通参数。
fn inline_flag(runner: &str, token: &str) -> Option<bool> {
    let flag = token.to_ascii_lowercase();
    match runner {
        "cmd" => matches!(flag.as_str(), "/c" | "/k").then_some(true),
        "pwsh" | "powershell" => matches!(flag.as_str(), "-c" | "-command" | "-commandwithargs" | "-cwa").then_some(true),
        "bash" | "sh" | "zsh" | "dash" => (flag.starts_with('-') && !flag.starts_with("--") && flag.contains('c')).then_some(true),
        _ => matches!(flag.as_str(), "-c" | "-e" | "--eval" | "-p" | "--print" | "-m").then_some(false),
    }
}

fn is_flag(runner: &str, token: &str) -> bool {
    token.starts_with('-') || (runner == "cmd" && token.starts_with('/') && token.len() <= 3)
}

fn command_name(token: &str) -> String {
    let name = token.rsplit(|ch| ch == '/' || ch == '\\').next().unwrap_or(token).to_ascii_lowercase();
    name.strip_suffix(".exe").map(str::to_string).unwrap_or(name)
}

fn is_env_assignment(token: &str) -> bool {
    if token.to_ascii_lowercase().starts_with("$env:") {
        return token.contains('=');
    }
    token
        .split_once('=')
        .is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_'))
}

fn is_script_token(token: &str) -> bool {
    if token.len() < 4 || token.starts_with('-') || token.contains("://") || token.chars().any(|ch| "*?$`<>|\n".contains(ch)) {
        return false;
    }
    token
        .rsplit_once('.')
        .is_some_and(|(_, extension)| SCRIPT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
}

fn cd_target(tokens: &[String]) -> Option<&str> {
    let name = command_name(tokens.first()?);
    if !matches!(name.as_str(), "cd" | "chdir" | "pushd" | "set-location" | "sl" | "push-location") {
        return None;
    }
    // 跳过 `-LiteralPath`、`cd -` 与 cmd 的 `/d`。
    tokens[1..]
        .iter()
        .map(String::as_str)
        .find(|token| !token.is_empty() && !token.starts_with('-') && !(token.starts_with('/') && token.len() == 2))
}
/// 按 `&&`、`||`、`;`、`|` 与换行切成简单命令；引号内、注释、heredoc 与 PowerShell here-string 正文不参与识别。
fn split_segments(command: &str) -> Vec<String> {
    let lines: Vec<&str> = command.lines().collect();
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut index = 0;
    // here-string 结束行 `'@ | python -` 的剩余部分继续解析。
    let mut pending: Option<String> = None;
    while index < lines.len() || pending.is_some() {
        let line = match pending.take() {
            Some(rest) => rest,
            None => {
                index += 1;
                lines[index - 1].to_string()
            }
        };
        let chars: Vec<char> = line.chars().collect();
        let mut heredoc: Option<String> = None;
        let mut here_string: Option<char> = None;
        let mut position = 0;
        while position < chars.len() {
            let ch = chars[position];
            position += 1;
            if let Some(open) = quote {
                if open == '"' && (ch == '\\' || ch == '`') && chars.get(position) == Some(&'"') {
                    current.push(ch);
                    current.push('"');
                    position += 1;
                    continue;
                }
                if ch == open {
                    quote = None;
                }
                current.push(ch);
                continue;
            }
            match ch {
                '\'' | '"' if current.ends_with('@') && chars[position..].iter().all(|next| next.is_whitespace()) => {
                    current.pop();
                    here_string = Some(ch);
                    break;
                }
                '\'' | '"' => {
                    quote = Some(ch);
                    current.push(ch);
                }
                '#' if current.is_empty() || current.ends_with(char::is_whitespace) => break,
                ';' => flush(&mut current, &mut segments),
                '&' | '|' if chars.get(position) == Some(&ch) => {
                    position += 1;
                    flush(&mut current, &mut segments);
                }
                '|' => flush(&mut current, &mut segments),
                '<' if chars.get(position) == Some(&'<') && chars.get(position + 1) == Some(&'<') => {
                    current.push_str("<<<");
                    position += 2;
                }
                '<' if chars.get(position) == Some(&'<') => match heredoc_delimiter(&chars[position + 1..]) {
                    Some((delimiter, consumed)) => {
                        heredoc = Some(delimiter);
                        position += 1 + consumed;
                    }
                    None => current.push(ch),
                },
                _ => current.push(ch),
            }
        }
        if let Some(open) = here_string {
            let close = format!("{open}@");
            match lines[index..].iter().position(|line| line.trim_start().starts_with(&close)) {
                Some(offset) => {
                    let line = lines[index + offset].trim_start();
                    pending = Some(line[close.len()..].to_string());
                    index += offset + 1;
                }
                None => index = lines.len(),
            }
            continue;
        }
        if quote.is_some() {
            current.push('\n');
            continue;
        }
        // bash `\` 与 PowerShell 反引号续行。
        if current.ends_with('\\') || current.ends_with('`') {
            current.pop();
            current.push(' ');
        } else {
            flush(&mut current, &mut segments);
        }
        if let Some(delimiter) = heredoc {
            match lines[index..].iter().position(|line| line.trim() == delimiter) {
                Some(offset) => index += offset + 1,
                None => index = lines.len(),
            }
        }
    }
    flush(&mut current, &mut segments);
    segments
}

fn flush(current: &mut String, segments: &mut Vec<String>) {
    let segment = current.trim().trim_matches(|ch| matches!(ch, '(' | ')' | '{' | '}')).trim().to_string();
    if !segment.is_empty() {
        segments.push(segment);
    }
    current.clear();
}

/// 解析 `<<EOF`、`<<-'EOF'`、`<< "EOF"` 的结束标记，返回标记与消耗的字符数。
fn heredoc_delimiter(chars: &[char]) -> Option<(String, usize)> {
    let mut position = 0;
    if chars.first() == Some(&'-') {
        position += 1;
    }
    while chars.get(position).is_some_and(|ch| ch.is_whitespace()) {
        position += 1;
    }
    let quote = chars.get(position).copied().filter(|ch| *ch == '\'' || *ch == '"');
    if quote.is_some() {
        position += 1;
    }
    let start = position;
    while chars.get(position).is_some_and(|ch| ch.is_alphanumeric() || *ch == '_') {
        position += 1;
    }
    if position == start {
        return None;
    }
    let delimiter: String = chars[start..position].iter().collect();
    if quote.is_some() && chars.get(position).copied() == quote {
        position += 1;
    }
    Some((delimiter, position))
}

fn tokenize(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut chars = segment.chars().peekable();
    while let Some(ch) = chars.next() {
        match quote {
            Some('"') if (ch == '\\' || ch == '`') && chars.peek() == Some(&'"') => {
                chars.next();
                current.push('"');
            }
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
                started = true;
            }
            None if ch.is_whitespace() => {
                if started {
                    tokens.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            None => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        tokens.push(current);
    }
    tokens
}

fn join_tokens(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| match token {
            _ if !token.is_empty() && !token.chars().any(char::is_whitespace) => token.clone(),
            _ if token.contains('"') => format!("'{token}'"),
            _ => format!("\"{token}\""),
        })
        .collect::<Vec<_>>()
        .join(" ")
}
/// 把命令里的路径参数解析为绝对路径；含变量、通配符或命令替换的参数无法静态确定，直接放弃。
fn resolve_path(token: &str, cwd: &str, home: &Path) -> Option<String> {
    let token = token.trim();
    if token.is_empty() || token.contains("://") || token.chars().any(|ch| "$%*?`<>|".contains(ch)) {
        return None;
    }
    let mut path = token.replace('\\', "/");
    // Git Bash 的 `/d/foo` 即 `D:/foo`。
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && (bytes.len() == 2 || bytes[2] == b'/') {
        path = format!("{}:/{}", (bytes[1] as char).to_ascii_uppercase(), path.get(3..).unwrap_or(""));
    }
    if path == "~" || path.starts_with("~/") {
        let home = crate::fs_ops::normalize_path(home);
        path = format!("{home}/{}", path.get(2..).unwrap_or(""));
    }
    let absolute = path.starts_with('/') || path.as_bytes().get(1) == Some(&b':');
    if !absolute {
        if cwd.is_empty() {
            return None;
        }
        path = format!("{cwd}/{path}");
    }
    let normalized = normalize_lexical(&path);
    (!normalized.is_empty()).then_some(normalized)
}

/// 统一分隔符并消去 `.`、`..`，盘符大写；不访问文件系统。
fn normalize_lexical(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let path = path.strip_prefix("//?/").unwrap_or(&path);
    if path.is_empty() {
        return String::new();
    }
    let (prefix, rest) = match path.as_bytes() {
        [drive, b':', ..] if drive.is_ascii_alphabetic() => (format!("{}:/", (*drive as char).to_ascii_uppercase()), &path[2..]),
        [b'/', ..] => ("/".to_string(), path),
        _ => (String::new(), path),
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("{prefix}{}", parts.join("/"))
}

fn is_excluded(path: &str) -> bool {
    path.to_lowercase().contains("/.agent/tmp/")
}

/// 汇总 skill 脚本调用：当前工作区可见 skill 的全部脚本（含从未调用的），加上落在工作区内的其它 skill；
/// `all` 为 true 时列出所有调用过的 skill 脚本。
fn query_usage(connection: &Connection, root: &str, inventory: &[SkillDirectory], all: bool, now: i64) -> anyhow::Result<ScriptUsageResponse> {
    if root.is_empty() {
        anyhow::bail!("未打开项目");
    }
    let workspace_prefix = format!("{}/", root.trim_end_matches('/').to_lowercase());
    let skills: HashMap<String, (&SkillDirectory, String)> = inventory
        .iter()
        .map(|skill| {
            let dir = canonical_text(&skill.dir);
            (dir.to_lowercase(), (skill, dir))
        })
        .collect();
    let cutoff: String = connection.query_row("SELECT date(?1 / 1000, 'unixepoch', 'localtime', '-29 days')", [now], |row| row.get(0))?;
    let mut statement = connection.prepare(
        "SELECT day, script_key, skill_dir, script, source, count, last_used_ms FROM skill_script_usage ORDER BY last_used_ms",
    )?;
    let mut rows = statement.query([])?;
    let mut entries: HashMap<String, SkillScriptUsage> = HashMap::new();
    let mut daily: HashMap<(String, String), i64> = HashMap::new();
    while let Some(row) = rows.next()? {
        let (day, key, skill_dir, script): (String, String, String, String) = (row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?);
        let (source, count, last_used_ms): (String, i64, i64) = (row.get(4)?, row.get(5)?, row.get(6)?);
        let known = skills.get(&skill_dir.to_lowercase()).map(|(skill, _)| *skill);
        if known.is_none() && !all && !key.starts_with(&workspace_prefix) {
            continue;
        }
        let entry = entries.entry(key.clone()).or_insert_with(|| new_entry(known, &skill_dir, &script));
        // 按时间升序遍历，同一脚本的大小写写法以最近一次为准。
        entry.path = format!("{skill_dir}/{script}");
        entry.script = script;
        entry.count += count;
        if day >= cutoff {
            entry.recent_30d += count;
        }
        entry.last_used_ms = entry.last_used_ms.max(last_used_ms);
        *entry.sources.entry(source).or_insert(0) += count;
        *daily.entry((day, key)).or_insert(0) += count;
    }
    // 从未调用的脚本同样列出，才能看出哪些已经无人使用。
    for (skill, dir) in skills.values() {
        for script in skill_scripts(Path::new(dir)) {
            entries.entry(format!("{dir}/{script}").to_lowercase()).or_insert_with(|| new_entry(Some(*skill), dir, &script));
        }
    }
    annotate_entries(&mut entries, now);
    let mut daily: Vec<ScriptUsageDailyRow> = daily
        .into_iter()
        .filter_map(|((date, key), count)| {
            entries.get(&key).map(|entry| ScriptUsageDailyRow { date, script: format!("{}/{}", entry.skill, entry.script), count })
        })
        .collect();
    daily.sort_by(|left, right| left.date.cmp(&right.date).then_with(|| left.script.cmp(&right.script)));
    let mut scripts: Vec<SkillScriptUsage> = entries.into_values().collect();
    scripts.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then(right.last_used_ms.cmp(&left.last_used_ms))
            .then_with(|| left.skill.cmp(&right.skill))
            .then_with(|| left.script.cmp(&right.script))
    });
    Ok(ScriptUsageResponse { workspace: root.to_string(), daily, scripts, error: None })
}

fn new_entry(skill: Option<&SkillDirectory>, skill_dir: &str, script: &str) -> SkillScriptUsage {
    let (name, scope) = match skill {
        Some(skill) => (skill.name.clone(), match skill.scope {
            SkillScope::Project => "project",
            SkillScope::Global => "global",
        }),
        None => (skill_dir.rsplit('/').next().unwrap_or(skill_dir).to_string(), "other"),
    };
    SkillScriptUsage {
        skill: name,
        scope: scope.to_string(),
        skill_dir: skill_dir.to_string(),
        script: script.to_string(),
        path: format!("{skill_dir}/{script}"),
        count: 0,
        recent_30d: 0,
        last_used_ms: 0,
        idle_days: None,
        exists: false,
        documented: false,
        referenced_by: Vec::new(),
        sources: BTreeMap::new(),
    }
}

/// 补充存在性、闲置天数、文档提及，以及未调用脚本被同 skill 其它脚本引用的情况（辅助模块不会被直接执行）。
fn annotate_entries(entries: &mut HashMap<String, SkillScriptUsage>, now: i64) {
    let mut by_skill: HashMap<String, Vec<String>> = HashMap::new();
    for (key, entry) in entries.iter() {
        by_skill.entry(entry.skill_dir.clone()).or_default().push(key.clone());
    }
    for (skill_dir, keys) in by_skill {
        let docs = skill_doc_text(Path::new(&skill_dir));
        // 只在有未调用脚本时读取同 skill 脚本内容。
        let needs_sources = keys.iter().any(|key| entries[key].count == 0);
        let sources: Vec<(String, String)> = if needs_sources {
            keys.iter()
                .filter_map(|key| {
                    let entry = &entries[key];
                    fs::read_to_string(&entry.path).ok().map(|text| (entry.script.clone(), text.to_lowercase()))
                })
                .collect()
        } else {
            Vec::new()
        };
        for key in &keys {
            let entry = entries.get_mut(key).expect("grouped key");
            entry.exists = Path::new(&entry.path).is_file();
            if entry.last_used_ms > 0 {
                entry.idle_days = Some((now - entry.last_used_ms).max(0) / DAY_MS);
            }
            let file_name = entry.script.rsplit('/').next().unwrap_or(&entry.script).to_lowercase();
            entry.documented = docs.contains(&file_name);
            if entry.count == 0 {
                let stem = file_name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(&file_name);
                entry.referenced_by = sources
                    .iter()
                    .filter(|(script, text)| !script.eq_ignore_ascii_case(&entry.script) && (text.contains(&file_name) || mentions_word(text, stem)))
                    .map(|(script, _)| script.clone())
                    .collect();
            }
        }
    }
}

/// skill `scripts/` 下全部脚本的 skill 内相对路径；跳过依赖目录、隐藏目录与嵌套的子 skill。
fn skill_scripts(skill_dir: &Path) -> Vec<String> {
    let root = skill_dir.join("scripts");
    if !root.is_dir() {
        return Vec::new();
    }
    let mut scripts: Vec<String> = WalkDir::new(&root)
        .max_depth(6)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                return true;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_str()) && !entry.path().join("SKILL.md").is_file()
        })
        .flatten()
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| SCRIPT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        })
        .filter_map(|entry| entry.path().strip_prefix(skill_dir).ok().map(|relative| crate::fs_ops::normalize_path(relative)))
        .collect();
    scripts.sort();
    scripts
}

/// SKILL.md 与 references/ 下 Markdown 的小写全文，用来判断脚本是否仍被文档提及。
fn skill_doc_text(skill_dir: &Path) -> String {
    let mut text = fs::read_to_string(skill_dir.join("SKILL.md")).unwrap_or_default();
    for entry in WalkDir::new(skill_dir.join("references")).max_depth(3).into_iter().flatten() {
        let is_markdown = entry.path().extension().is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
        if entry.file_type().is_file() && is_markdown && entry.metadata().is_ok_and(|metadata| metadata.len() < 2_000_000) {
            text.push('\n');
            text.push_str(&fs::read_to_string(entry.path()).unwrap_or_default());
        }
    }
    text.to_lowercase()
}

/// `stem` 作为完整标识符出现（`import model_lib`、`from model_lib`），避免 `lib` 命中 `library`。
fn mentions_word(text: &str, stem: &str) -> bool {
    if stem.len() < 3 {
        return false;
    }
    let is_word = |ch: char| ch.is_alphanumeric() || ch == '_' || ch == '-';
    text.match_indices(stem).any(|(start, _)| {
        let before = text[..start].chars().next_back();
        let after = text[start + stem.len()..].chars().next();
        !before.is_some_and(is_word) && !after.is_some_and(is_word)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    const HOME: &str = "C:/Users/me";

    fn scripts(command: &str, cwd: &str) -> Vec<String> {
        scripts_in_command(command, cwd, Path::new(HOME))
    }

    #[test]
    fn finds_direct_and_interpreted_scripts() {
        let cwd = r"D:\ws\plugins";
        assert_eq!(scripts("cd tools && python -X utf8 build.py --fast", cwd), ["D:/ws/plugins/tools/build.py"]);
        assert_eq!(scripts(r#"powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\integrate.ps1 -Restart"#, cwd), ["D:/ws/plugins/scripts/integrate.ps1"]);
        assert_eq!(scripts(r#"& "D:\ws\plugins\My Tools\run.ps1" -Name x; Write-Host done"#, cwd), ["D:/ws/plugins/My Tools/run.ps1"]);
        assert_eq!(scripts("git status | node scripts/report.mjs", cwd), ["D:/ws/plugins/scripts/report.mjs"]);
        assert_eq!(scripts(r#"bash -lc "cd /d/ws/other && ./deploy.sh""#, cwd), ["D:/ws/other/deploy.sh"]);
        assert_eq!(scripts(r#"cmd /c "D:\ws\plugins\start.bat" arg"#, cwd), ["D:/ws/plugins/start.bat"]);
        assert_eq!(scripts("PYTHONIOENCODING=utf-8 py -3 ~/bin/tool.py", cwd), ["C:/Users/me/bin/tool.py"]);
        assert_eq!(scripts("python \\\n  scripts/long.py --a", cwd), ["D:/ws/plugins/scripts/long.py"]);
        assert_eq!(scripts(". .\\scripts\\env.ps1", cwd), ["D:/ws/plugins/scripts/env.ps1"]);
        assert_eq!(scripts("uv run python a.py && uv run python a.py", cwd), ["D:/ws/plugins/a.py"]);
        let saved = "S=\".agent/tmp/x/state\"\nCLI=\"python harness/runner.py --json --state-dir $S\"\n$CLI project open \"$M\" 2>&1";
        assert_eq!(scripts(saved, cwd), ["D:/ws/plugins/harness/runner.py"]);
        assert_eq!(scripts("$out = python tools/report.py --json | ConvertFrom-Json", cwd), ["D:/ws/plugins/tools/report.py"]);
    }

    #[test]
    fn ignores_inline_code_reads_heredocs_and_temp_scripts() {
        let cwd = "D:/ws";
        for command in [
            r#"python -c "import x; print('a.py')""#,
            "cat scripts/a.py | head",
            "Get-Content -Raw scripts/a.ps1",
            "python -m pytest tests/test_a.py",
            "git diff -- scripts/a.py",
            "python - <<'EOF'\nimport subprocess\nsubprocess.run(['python', 'x.py'])\nEOF",
            "@'\npython inner.py\n'@ | python -",
            "python .agent/tmp/probe.py",
            r#"python "$(cygpath -w /tmp)/probe.py""#,
            "echo done # python commented.py",
        ] {
            assert!(scripts(command, cwd).is_empty(), "{command}");
        }
        // heredoc 之后的命令照常识别。
        assert_eq!(scripts("cat <<EOF > notes.txt\nrun me.py\nEOF\n./after.sh", cwd), ["D:/ws/after.sh"]);
    }

    fn write_lines(path: &Path, lines: &[String], trailing_newline: bool) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        let text = lines.join("\n");
        write!(file, "{text}{}", if trailing_newline { "\n" } else { "" }).unwrap();
    }

    fn claude_line(id: &str, cwd: &str, command: &str) -> String {
        json!({"type":"assistant","cwd":cwd,"timestamp":"2026-10-19T08:00:00.000Z",
            "message":{"content":[{"type":"tool_use","id":id,"name":"Bash","input":{"command":command}}]}}).to_string()
    }

    fn write_file(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// 工作区含一个 skill（tool.py 被文档提及并导入 helper，unused.py 无人使用）和一个普通脚本。
    fn skill_workspace(root: &Path) -> (String, SkillDirectory) {
        let skill = root.join(".skillshare/skills/demo");
        write_file(&skill.join("SKILL.md"), "---\nname: demo\ndescription: d\n---\nRun `python scripts/tool.py`.\n");
        write_file(&skill.join("scripts/tool.py"), "from lib import helper\n");
        write_file(&skill.join("scripts/lib/helper.py"), "X = 1\n");
        write_file(&skill.join("scripts/unused.py"), "print(1)\n");
        write_file(&skill.join("scripts/node_modules/dep/index.js"), "");
        write_file(&root.join("tools/plain.py"), "print(1)\n");
        let dir = fs::canonicalize(&skill).unwrap();
        (crate::fs_ops::normalize_path(root), SkillDirectory { name: "demo".into(), scope: SkillScope::Project, dir })
    }

    #[test]
    fn resolves_only_skill_scripts() {
        let temp = tempfile::tempdir().unwrap();
        let (ws, _) = skill_workspace(temp.path());
        let mut resolver = SkillResolver::default();
        let tool = resolver.resolve(&normalize_lexical(&format!("{ws}/.skillshare/skills/demo/scripts/tool.py"))).unwrap();
        assert_eq!(tool.script, "scripts/tool.py");
        // 经 `..` 的别名写法归并到同一物理目录；skill 内被删的脚本仍归属该 skill。
        let alias = resolver.resolve(&normalize_lexical(&format!("{ws}/.skillshare/skills/x/../demo/scripts/gone.py"))).unwrap();
        assert_eq!(alias.skill_dir, tool.skill_dir);
        for path in ["tools/plain.py", ".skillshare/skills/demo/SKILL.md", ".skillshare/skills/demo/assets/x.py", "scripts/integrate.ps1"] {
            assert!(resolver.resolve(&format!("{ws}/{path}")).is_none(), "{path}");
        }
        assert!(mentions_word("from lib import helper\n", "helper"));
        assert!(!mentions_word("library_helpers", "helper"));
    }

    #[test]
    fn scans_incrementally_and_dedupes_resumed_calls() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let (ws, skill) = skill_workspace(&temp.path().join("ws"));
        let skill_cwd = format!("{ws}/.skillshare/skills/demo");
        let mut connection = open(&home.join("usage.db")).unwrap();
        let claude = home.join(".claude/projects/ws/a.jsonl");
        let first = claude_line("t1", &ws, "python .skillshare/skills/demo/scripts/tool.py && python tools/plain.py && python .agent/tmp/x.py");
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"python scripts/tool.py"}]}}).to_string();
        write_lines(&claude, &[first.clone(), result], true);
        // 正在写入的末行不完整，本轮不计。
        write_lines(&claude, &[claude_line("t2", &skill_cwd, "python scripts/tool.py --x")], false);
        let codex = home.join(".codex/sessions/2026/10/19/rollout-x.jsonl");
        let exec = json!({"cmd":"python scripts/tool.py"}).to_string();
        write_lines(&codex, &[
            json!({"type":"session_meta","payload":{"cwd":skill_cwd}}).to_string(),
            json!({"type":"response_item","timestamp":"2026-10-19T09:00:00Z","payload":{"type":"function_call","name":"exec_command","call_id":"c1","arguments":exec}}).to_string(),
        ], true);

        let now = parse_timestamp_ms("2026-10-20T12:00:00Z").unwrap();
        let query = |connection: &Connection| query_usage(connection, &ws, std::slice::from_ref(&skill), false, now).unwrap();
        let counts = |connection: &Connection| {
            let mut map: Vec<(String, i64)> = query(connection).scripts.into_iter().map(|entry| (entry.script, entry.count)).collect();
            map.sort();
            map
        };
        scan_home(&mut connection, &home).unwrap();
        let expected = |tool: i64| vec![("scripts/lib/helper.py".to_string(), 0), ("scripts/tool.py".to_string(), tool), ("scripts/unused.py".to_string(), 0)];
        assert_eq!(counts(&connection), expected(2));

        // 末行写完，另有续接会话复制了 t1。
        write_lines(&claude, &[String::new()], true);
        write_lines(&home.join(".claude/projects/ws/resumed.jsonl"), &[first], true);
        scan_home(&mut connection, &home).unwrap();
        scan_home(&mut connection, &home).unwrap();
        assert_eq!(counts(&connection), expected(3));

        let response = query(&connection);
        let find = |script: &str| response.scripts.iter().find(|entry| entry.script == script).unwrap();
        let tool = find("scripts/tool.py");
        assert_eq!((tool.skill.as_str(), tool.scope.as_str()), ("demo", "project"));
        assert_eq!(tool.sources, BTreeMap::from([("claude".to_string(), 2), ("codex".to_string(), 1)]));
        assert_eq!((tool.recent_30d, tool.idle_days, tool.documented, tool.exists), (3, Some(1), true, true));
        assert_eq!(find("scripts/lib/helper.py").referenced_by, ["scripts/tool.py"]);
        let unused = find("scripts/unused.py");
        assert_eq!((unused.idle_days, unused.documented, unused.referenced_by.is_empty()), (None, false, true));
        assert_eq!(response.daily.iter().map(|row| (row.script.as_str(), row.count)).collect::<Vec<_>>(), [("demo/scripts/tool.py", 3)]);
        // 其它工作区看不到这个项目 skill；--all 时仍列出调用过的脚本。
        let other = query_usage(&connection, "D:/other", &[], false, now).unwrap();
        assert!(other.scripts.is_empty());
        let all = query_usage(&connection, "D:/other", &[], true, now).unwrap();
        assert_eq!(all.scripts.iter().map(|entry| (entry.scope.as_str(), entry.count)).collect::<Vec<_>>(), [("other", 3)]);
    }

    #[test]
    fn rebuilds_database_from_older_schema() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("usage.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch("CREATE TABLE script_usage (x); CREATE TABLE seen_calls (call_id TEXT PRIMARY KEY); INSERT INTO seen_calls VALUES ('a');").unwrap();
        drop(old);
        let connection = open(&path).unwrap();
        let seen: i64 = connection.query_row("SELECT count(*) FROM seen_calls", [], |row| row.get(0)).unwrap();
        let legacy: i64 = connection.query_row("SELECT count(*) FROM sqlite_master WHERE name = 'script_usage'", [], |row| row.get(0)).unwrap();
        assert_eq!((seen, legacy), (0, 0));
    }

    #[test]
    fn parses_manual_bash_input_and_timestamps() {
        let line = json!({"type":"user","uuid":"u1","cwd":"D:\\ws","message":{"content":"<bash-input>python tools/x.py</bash-input>"}}).to_string();
        let calls = claude_calls(&line);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].command, "python tools/x.py");
        assert_eq!(parse_timestamp_ms("1970-01-01T00:00:01.500Z"), Some(1500));
        assert_eq!(normalize_lexical(r"\\?\d:\ws\.\a\..\b.py"), "D:/ws/b.py");
    }
}
