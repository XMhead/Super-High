//! cc-switch 配置读取（只读，数据源 = ~/.cc-switch/cc-switch.db 的 SQLite）。
//!
//! 渠道检测面板不再维护自建渠道，而是直接加载 cc-switch 的「分组 + 已有供应商」：
//! - claude / codex 供应商：`providers` 表，按 cc-switch 本体的解析逻辑提取
//!   base_url / api_key / api_format / model（与 cc-switch 前端的展示口径一致）。
//! - 项目分组：`profiles` 表（分组 → 各应用槽位绑定的供应商 id）+ `settings` 表
//!   里各应用当前激活的分组 id。
//!
//! 只读打开数据库，绝不写任何 cc-switch 数据。

use std::path::PathBuf;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value as Json;

use crate::models::ChannelApiFormat;

/// cc-switch 供应商（渠道检测面板的卡片数据源）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcProviderInfo {
    /// 所属应用："claude" | "codex" | "gemini" | "grokbuild" | "opencode"。
    pub app: String,
    pub id: String,
    pub name: String,
    pub website_url: String,
    /// 提取出的接口地址（可能为空：官方供应商或配置缺失）。
    pub base_url: String,
    /// 提取出的 API Key（与 cc-switch 前端一致，来自 providers.settings_config）。
    pub api_key: String,
    /// 实际生效的 API 格式（meta.apiFormat / Codex 的 wire_api / 应用默认）。
    pub api_format: ChannelApiFormat,
    /// 鉴权头风格（对齐 cc-switch）："bearer"（Authorization: Bearer）、
    /// "x-api-key"（Claude）或 "x-goog-api-key"（Gemini）。
    pub api_key_auth: String,
    /// 配置里声明的模型（Claude 的 ANTHROPIC_MODEL、Codex TOML 的 model；可能为空）。
    pub model: String,
    /// 配置里声明的静态模型候选（opencode 的 models 键；其余应用为空）。
    pub models: Vec<CcProviderModel>,
    /// cc-switch 的分类（official 无探测目标，卡片会禁用测试按钮）。
    pub category: String,
    /// 是否为 cc-switch 当前激活供应商。
    pub is_current: bool,
}

/// 配置里声明的静态模型候选（来自 opencode 的 models 键等）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcProviderModel {
    pub id: String,
    pub name: String,
}

/// cc-switch 项目分组（profiles 表的一行，只解析供应商槽位）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcProfileInfo {
    pub id: String,
    pub name: String,
    /// 该分组在 Claude Code 槽位绑定的供应商 id（null = 未绑定）。
    pub claude_provider: Option<String>,
    /// 该分组在 Codex 槽位绑定的供应商 id（null = 未绑定）。
    pub codex_provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CcProfilesResponse {
    pub profiles: Vec<CcProfileInfo>,
    /// 各应用当前激活的分组 id（未使用分组时为 null）。
    pub current_claude: Option<String>,
    pub current_codex: Option<String>,
}

/// cc-switch 根目录：$CC_SWITCH_HOME 优先，否则 ~/.cc-switch。
pub fn cc_switch_home() -> Option<PathBuf> {
    std::env::var_os("CC_SWITCH_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|home| PathBuf::from(home).join(".cc-switch"))
        })
}

/// cc-switch 数据库路径；不存在时返回 None。
pub fn cc_switch_db_path() -> Option<PathBuf> {
    cc_switch_home().map(|home| home.join("cc-switch.db"))
}

/// 只读打开 cc-switch 数据库；文件缺失或无法打开时返回 None（面板显示空态提示）。
fn open_readonly() -> Option<Connection> {
    let path = cc_switch_db_path()?;
    if !path.is_file() {
        return None;
    }
    Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// 加载全部 cc-switch 供应商（跳过 official：它们没有可探测的 base_url）。
/// 支持的应用：claude / codex / gemini / grokbuild / opencode。
pub fn list_cc_providers() -> Vec<CcProviderInfo> {
    let Some(conn) = open_readonly() else {
        return Vec::new();
    };
    let mut providers = Vec::new();
    let query =
        "SELECT app_type, id, name, settings_config, website_url, category, meta, is_current
                 FROM providers
                 WHERE app_type IN ('claude','codex','gemini','grokbuild','opencode')";
    let mut stmt = match conn.prepare(query) {
        Ok(stmt) => stmt,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        let settings: String = row.get(3)?;
        let meta: String = row.get(6)?;
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            serde_json::from_str::<Json>(&settings).unwrap_or(Json::Null),
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            serde_json::from_str::<Json>(&meta).unwrap_or(Json::Null),
            row.get::<_, bool>(7)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };

    for row in rows.flatten() {
        let (app, id, name, settings, website_url, category, meta, is_current) = row;
        if !matches!(
            app.as_str(),
            "claude" | "codex" | "gemini" | "grokbuild" | "opencode"
        ) {
            continue;
        }
        // official 供应商没有可供探测的 base_url，且 key 多为 OAuth 托管，跳过。
        if category.as_deref() == Some("official") {
            continue;
        }
        providers.push(CcProviderInfo {
            app: app.clone(),
            id,
            name,
            website_url: website_url.unwrap_or_default().trim().to_string(),
            base_url: extract_base_url(&app, &settings),
            api_key: extract_api_key(&app, &settings),
            api_format: extract_api_format(&app, &settings, &meta),
            api_key_auth: extract_api_key_auth(&app, &settings),
            model: extract_model(&app, &settings),
            models: extract_static_models(&app, &settings),
            category: category.unwrap_or_default(),
            is_current,
        });
    }

    providers.sort_by(|left, right| {
        left.app
            .cmp(&right.app)
            .then_with(|| right.is_current.cmp(&left.is_current))
            .then_with(|| left.name.cmp(&right.name))
    });
    providers
}

// ===== 提取逻辑（与 cc-switch 本体口径一致）=====

fn env_string(settings: &Json, key: &str) -> Option<String> {
    settings
        .get("env")?
        .get(key)?
        .as_str()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn meta_string(meta: &Json, key: &str) -> Option<String> {
    meta.get(key)?.as_str().map(str::to_string)
}

/// claude：env.ANTHROPIC_BASE_URL；codex：settings_config 的 base_url/baseURL
/// 或 config（对象 / TOML 字符串，按 cc-switch CodexAdapter 的优先级）；
/// gemini：env.GOOGLE_GEMINI_BASE_URL；grokbuild：TOML 的
/// `[models] default → [model.<default>] base_url`；opencode：options.baseURL。
fn extract_base_url(app: &str, settings: &Json) -> String {
    match app {
        "claude" => return env_string(settings, "ANTHROPIC_BASE_URL").unwrap_or_default(),
        "gemini" => {
            return env_string(settings, "GOOGLE_GEMINI_BASE_URL").unwrap_or_default();
        }
        "grokbuild" => {
            if let Some(config) = settings.get("config").and_then(Json::as_str) {
                if let Some(parsed) = grok_config(config) {
                    return parsed.base_url.unwrap_or_default();
                }
            }
            return String::new();
        }
        "opencode" => {
            return settings
                .get("options")
                .and_then(|options| options.get("baseURL"))
                .and_then(Json::as_str)
                .map(|url| url.trim_end_matches('/').to_string())
                .unwrap_or_default();
        }
        _ => {}
    }
    for key in ["base_url", "baseURL"] {
        if let Some(url) = settings.get(key).and_then(Json::as_str) {
            let url = url.trim_end_matches('/').to_string();
            if !url.is_empty() {
                return url;
            }
        }
    }
    if let Some(config) = settings.get("config") {
        if let Some(url) = config.get("base_url").and_then(Json::as_str) {
            return url.trim_end_matches('/').to_string();
        }
        if let Some(toml_text) = config.as_str() {
            if let Some(url) = codex_base_url_from_toml(toml_text) {
                return url;
            }
        }
    }
    String::new()
}

/// Grok Build 的 TOML 配置结构：`[models] default` 指向 `[model.<default>]` 里的实际配置
/// （与 cc-switch 的 grok_config::extract_model_config 同构）。
struct GrokConfig {
    /// 真实 API 模型名（`[model.<default>].model`）。
    model: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    /// api_key 缺省时使用的环境变量名（`env_key`）。
    env_key: Option<String>,
    /// 上游协议：responses / chat / anthropic。
    api_backend: Option<String>,
}

fn grok_config(toml_text: &str) -> Option<GrokConfig> {
    let document = toml_text.parse::<toml::Value>().ok()?;
    let root = document.as_table()?;
    let default_model = root
        .get("models")?
        .get("default")?
        .as_str()?
        .trim()
        .to_string();
    let selected = root.get("model")?.get(&default_model)?;
    let str_field = |key: &str| {
        selected
            .get(key)
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    Some(GrokConfig {
        model: str_field("model"),
        base_url: str_field("base_url"),
        api_key: str_field("api_key"),
        env_key: str_field("env_key"),
        api_backend: str_field("api_backend"),
    })
}

/// 解析 Codex 的 TOML 配置字符串并提取 base_url：
/// 1. `[model_providers.<model_provider>].base_url`
/// 2. 顶层 `base_url`
/// 3. 字符串扫描兜底（与 cc-switch CodexAdapter 一致）
fn codex_base_url_from_toml(toml_text: &str) -> Option<String> {
    if let Ok(document) = toml_text.parse::<toml::Value>() {
        let active = document.get("model_provider").and_then(toml::Value::as_str);
        if let Some(active) = active {
            if let Some(url) = document
                .get("model_providers")
                .and_then(|providers| providers.get(active))
                .and_then(|provider| provider.get("base_url"))
                .and_then(toml::Value::as_str)
            {
                let url = url.trim_end_matches('/').to_string();
                if !url.is_empty() {
                    return Some(url);
                }
            }
        }
        if let Some(url) = document
            .get("base_url")
            .and_then(toml::Value::as_str)
            .map(|url| url.trim_end_matches('/').to_string())
        {
            if !url.is_empty() {
                return Some(url);
            }
        }
    }
    for quote in ['"', '\''] {
        if let Some(start) = toml_text.find(&format!("base_url = {quote}")) {
            let rest = &toml_text[start + 12..];
            if let Some(end) = rest.find(quote) {
                let url = rest[..end].trim_end_matches('/').to_string();
                if !url.is_empty() {
                    return Some(url);
                }
            }
        }
    }
    None
}

/// claude：env.ANTHROPIC_AUTH_TOKEN ?? ANTHROPIC_API_KEY；
/// codex：auth.OPENAI_API_KEY（可能为 null / 空串）；
/// gemini：env.GEMINI_API_KEY；grokbuild：TOML 的 api_key ?? env_key 环境变量；
/// opencode：options.apiKey。
fn extract_api_key(app: &str, settings: &Json) -> String {
    match app {
        "claude" => {
            return env_string(settings, "ANTHROPIC_AUTH_TOKEN")
                .or_else(|| env_string(settings, "ANTHROPIC_API_KEY"))
                .unwrap_or_default();
        }
        "gemini" => {
            return env_string(settings, "GEMINI_API_KEY").unwrap_or_default();
        }
        "grokbuild" => {
            if let Some(config) = settings.get("config").and_then(Json::as_str) {
                if let Some(parsed) = grok_config(config) {
                    if let Some(api_key) = parsed.api_key {
                        return api_key;
                    }
                    if let Some(env_key) = parsed.env_key {
                        if let Ok(value) = std::env::var(&env_key) {
                            let value = value.trim().to_string();
                            if !value.is_empty() {
                                return value;
                            }
                        }
                    }
                }
            }
            return String::new();
        }
        "opencode" => {
            return settings
                .get("options")
                .and_then(|options| options.get("apiKey"))
                .and_then(Json::as_str)
                .map(|key| key.trim().to_string())
                .unwrap_or_default();
        }
        _ => {}
    }
    settings
        .get("auth")
        .and_then(|auth| auth.get("OPENAI_API_KEY"))
        .and_then(Json::as_str)
        .map(|key| key.trim().to_string())
        .unwrap_or_default()
}

fn wire_api_to_format(wire_api: &str) -> Option<ChannelApiFormat> {
    match wire_api.trim() {
        "anthropic" => Some(ChannelApiFormat::Anthropic),
        "chat" | "chat_completions" => Some(ChannelApiFormat::OpenaiChat),
        "responses" => Some(ChannelApiFormat::OpenaiResponses),
        _ => None,
    }
}

/// 鉴权头风格（对齐 cc-switch 的 adapter 策略）：
/// claude：ANTHROPIC_AUTH_TOKEN → Bearer，ANTHROPIC_API_KEY → x-api-key；
/// gemini：x-goog-api-key；codex / grokbuild / opencode：Bearer。
fn extract_api_key_auth(app: &str, settings: &Json) -> String {
    match app {
        "claude" => {
            return if env_string(settings, "ANTHROPIC_AUTH_TOKEN").is_some() {
                "bearer".to_string()
            } else {
                "x-api-key".to_string()
            };
        }
        "gemini" => return "x-goog-api-key".to_string(),
        _ => return "bearer".to_string(),
    }
}

/// api_format：meta.apiFormat 优先；codex 再按 TOML wire_api；
/// grokbuild 按 TOML api_backend；最后应用应用原生默认。
fn extract_api_format(app: &str, settings: &Json, meta: &Json) -> ChannelApiFormat {
    if let Some(format) = meta_string(meta, "apiFormat") {
        match format.as_str() {
            "anthropic" => return ChannelApiFormat::Anthropic,
            "openai_chat" => return ChannelApiFormat::OpenaiChat,
            "openai_responses" => return ChannelApiFormat::OpenaiResponses,
            "gemini_native" => return ChannelApiFormat::GeminiNative,
            _ => {}
        }
    }
    match app {
        "gemini" => return ChannelApiFormat::GeminiNative,
        "opencode" => return ChannelApiFormat::OpenaiChat,
        "grokbuild" => {
            if let Some(config) = settings.get("config").and_then(Json::as_str) {
                if let Some(parsed) = grok_config(config) {
                    if let Some(backend) = parsed.api_backend {
                        if let Some(format) = wire_api_to_format(&backend) {
                            return format;
                        }
                    }
                }
            }
            return ChannelApiFormat::OpenaiResponses;
        }
        _ => {}
    }
    if app == "codex" {
        if let Some(config) = settings.get("config") {
            if let Some(format) = config
                .get("wire_api")
                .and_then(Json::as_str)
                .and_then(wire_api_to_format)
            {
                return format;
            }
            if let Some(toml_text) = config.as_str() {
                if let Ok(document) = toml_text.parse::<toml::Value>() {
                    let active = document.get("model_provider").and_then(toml::Value::as_str);
                    let candidate = active.and_then(|active| {
                        document
                            .get("model_providers")
                            .and_then(|providers| providers.get(active))
                            .and_then(|provider| provider.get("wire_api"))
                            .and_then(toml::Value::as_str)
                            .and_then(wire_api_to_format)
                    });
                    if let Some(format) = candidate {
                        return format;
                    }
                    if let Some(format) = document
                        .get("wire_api")
                        .and_then(toml::Value::as_str)
                        .and_then(wire_api_to_format)
                    {
                        return format;
                    }
                }
            }
        }
        return ChannelApiFormat::OpenaiResponses;
    }
    ChannelApiFormat::Anthropic
}

/// 配置里声明的模型：claude 用 env.ANTHROPIC_MODEL（依次回退 OPUS/SONNET/HAIKU），
/// codex 用 TOML 顶层 model，gemini 用 env.GEMINI_MODEL，grokbuild 用
/// `[model.<default>].model`；没声明就留空（测试时走面板默认值）。
fn extract_model(app: &str, settings: &Json) -> String {
    match app {
        "claude" => {
            return [
                "ANTHROPIC_MODEL",
                "ANTHROPIC_DEFAULT_OPUS_MODEL",
                "ANTHROPIC_DEFAULT_SONNET_MODEL",
                "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            ]
            .iter()
            .find_map(|key| env_string(settings, key))
            .unwrap_or_default();
        }
        "gemini" => return env_string(settings, "GEMINI_MODEL").unwrap_or_default(),
        "grokbuild" => {
            if let Some(config) = settings.get("config").and_then(Json::as_str) {
                if let Some(parsed) = grok_config(config) {
                    return parsed.model.unwrap_or_default();
                }
            }
            return String::new();
        }
        _ => {}
    }
    if let Some(config) = settings.get("config") {
        if let Some(model) = config.get("model").and_then(Json::as_str) {
            let model = model.trim();
            if !model.is_empty() {
                return model.to_string();
            }
        }
        if let Some(toml_text) = config.as_str() {
            if let Ok(document) = toml_text.parse::<toml::Value>() {
                if let Some(model) = document
                    .get("model")
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                {
                    return model.to_string();
                }
            }
        }
    }
    String::new()
}

/// 配置里声明的静态模型候选：opencode 的 `models` 键（name 是显示名，缺省用 id）。
fn extract_static_models(app: &str, settings: &Json) -> Vec<CcProviderModel> {
    if app != "opencode" {
        return Vec::new();
    }
    let Some(models) = settings.get("models").and_then(Json::as_object) else {
        return Vec::new();
    };
    let mut result: Vec<CcProviderModel> = models
        .iter()
        .map(|(id, entry)| CcProviderModel {
            id: id.clone(),
            name: entry
                .get("name")
                .and_then(Json::as_str)
                .filter(|name| !name.is_empty())
                .unwrap_or(id)
                .to_string(),
        })
        .collect();
    result.sort_by(|left, right| left.id.cmp(&right.id));
    result
}

/// 加载全部项目分组（profiles 表）+ 各应用当前激活分组（settings 表）。
pub fn list_cc_profiles() -> CcProfilesResponse {
    let mut response = CcProfilesResponse {
        profiles: Vec::new(),
        current_claude: None,
        current_codex: None,
    };
    let Some(conn) = open_readonly() else {
        return response;
    };

    let profiles_query = "SELECT id, name, payload FROM profiles ORDER BY sort_order IS NULL, sort_order, created_at, id";
    if let Ok(mut stmt) = conn.prepare(profiles_query) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        }) {
            for row in rows.flatten() {
                let (id, name, payload) = row;
                let (claude, codex) = providers_from_payload(&payload);
                response.profiles.push(CcProfileInfo {
                    id,
                    name,
                    claude_provider: claude,
                    codex_provider: codex,
                });
            }
        }
    }

    let settings_query = "SELECT key, value FROM settings WHERE key LIKE 'current_profile_id_%'";
    if let Ok(mut stmt) = conn.prepare(settings_query) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                let (key, value) = row;
                match key.as_str() {
                    "current_profile_id_claude" => response.current_claude = Some(value),
                    "current_profile_id_codex" => response.current_codex = Some(value),
                    _ => {}
                }
            }
        }
    }
    response
}

/// 从 profiles.payload 解析各应用槽位绑定的供应商 id。
fn providers_from_payload(payload: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Json>(payload) else {
        return (None, None);
    };
    let providers = value.get("providers");
    let slot = |key: &str| -> Option<String> {
        providers
            .and_then(|providers| providers.get(key))
            .and_then(Json::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
    };
    (slot("claude"), slot("codex"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;

    /// 进程级环境变量锁：与 dsh_profiles / dsh_editor 测试共用，避免并行互相干扰。
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        crate::dsh_profiles::tests::ENV_LOCK.lock().unwrap()
    }

    fn temp_home(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "superhigh_cc_switch_test_{}_{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        dir
    }

    fn with_test_db(dir: &PathBuf, setup: impl FnOnce(&Connection)) -> Vec<CcProviderInfo> {
        let path = dir.join("cc-switch.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (
                id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
                settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
                created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
                meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
                in_failover_queue BOOLEAN NOT NULL DEFAULT 0, PRIMARY KEY (id, app_type)
            );
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL);",
        )
        .unwrap();
        setup(&conn);
        drop(conn);
        let _guard = env_lock();
        std::env::set_var("CC_SWITCH_HOME", dir);
        list_cc_providers()
    }

    #[test]
    fn returns_empty_when_no_home() {
        let _guard = env_lock();
        let previous_cc = std::env::var_os("CC_SWITCH_HOME");
        let previous_user = std::env::var_os("USERPROFILE");
        let previous_home = std::env::var_os("HOME");
        std::env::remove_var("CC_SWITCH_HOME");
        std::env::remove_var("USERPROFILE");
        std::env::remove_var("HOME");
        assert!(list_cc_providers().is_empty());
        assert_eq!(
            list_cc_profiles(),
            CcProfilesResponse {
                profiles: Vec::new(),
                current_claude: None,
                current_codex: None
            }
        );
        match previous_cc {
            Some(v) => std::env::set_var("CC_SWITCH_HOME", v),
            None => std::env::remove_var("CC_SWITCH_HOME"),
        }
        match previous_user {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        match previous_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn extracts_claude_provider_fields() {
        let dir = temp_home("claude");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('p1','claude','kiro','{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-key\",\"ANTHROPIC_BASE_URL\":\"https://api.aizzz.xyz\",\"ANTHROPIC_MODEL\":\"claude-opus-5[1M]\"}}','https://api.aizzz.xyz','custom','{\"apiFormat\":\"anthropic\"}',1)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.app, "claude");
        assert_eq!(p.name, "kiro");
        assert_eq!(p.base_url, "https://api.aizzz.xyz");
        assert_eq!(p.api_key, "sk-key");
        assert_eq!(p.api_format, ChannelApiFormat::Anthropic);
        assert_eq!(p.api_key_auth, "bearer");
        assert_eq!(p.model, "claude-opus-5[1M]");
        assert_eq!(p.website_url, "https://api.aizzz.xyz");
        assert!(p.is_current);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_codex_provider_from_toml_config() {
        let dir = temp_home("codex");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('c1','codex','0.01','{\"auth\":{\"OPENAI_API_KEY\":\"sk-codex\"},\"config\":\"model_provider = \\\"custom\\\"\\nmodel = \\\"gpt-5.6-sol\\\"\\n\\n[model_providers.custom]\\nname = \\\"0.01\\\"\\nbase_url = \\\"https://api.aizzz.xyz/v1\\\"\\nwire_api = \\\"responses\\\"\\n\"}','https://api.aizzz.xyz','custom','{}',1)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.base_url, "https://api.aizzz.xyz/v1");
        assert_eq!(p.api_key, "sk-codex");
        assert_eq!(p.api_format, ChannelApiFormat::OpenaiResponses);
        assert_eq!(p.model, "gpt-5.6-sol");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_wire_api_chat_maps_to_openai_chat() {
        let dir = temp_home("codex-chat");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('c1','codex','chat','{\"auth\":{\"OPENAI_API_KEY\":\"sk\"},\"config\":\"model_provider = \\\"custom\\\"\\n[model_providers.custom]\\nbase_url = \\\"https://deepseek.example/v1\\\"\\nwire_api = \\\"chat\\\"\\n\"}','https://deepseek.example','custom','{}',0)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers[0].api_format, ChannelApiFormat::OpenaiChat);
        assert_eq!(providers[0].base_url, "https://deepseek.example/v1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_meta_api_format_wins_over_wire_api() {
        let dir = temp_home("codex-meta");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('c1','codex','meta','{\"auth\":{\"OPENAI_API_KEY\":\"sk\"},\"config\":\"model_provider = \\\"custom\\\"\\n[model_providers.custom]\\nbase_url = \\\"https://x.example/v1\\\"\\nwire_api = \\\"responses\\\"\\n\"}','https://x.example','custom','{\"apiFormat\":\"openai_chat\"}',0)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers[0].api_format, ChannelApiFormat::OpenaiChat);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_bare_base_url_without_toml() {
        let dir = temp_home("codex-bare");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('c1','codex','bare','{\"base_url\":\"https://bare.example/v1\",\"auth\":{\"OPENAI_API_KEY\":\"sk\"}}','','custom','{}',0)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers[0].base_url, "https://bare.example/v1");
        assert_eq!(providers[0].api_format, ChannelApiFormat::OpenaiResponses);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_official_providers_without_base_url() {
        let dir = temp_home("official");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('o1','claude','Official','{\"env\":{}}','https://claude.ai','official','{}',1)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('t1','claude','Third','{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://t.example\",\"ANTHROPIC_AUTH_TOKEN\":\"sk\"}}','https://t.example','third_party','{}',0)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].name, "Third");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_profiles_and_current_ids() {
        let dir = temp_home("profiles");
        let path = dir.join("cc-switch.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
             CREATE TABLE profiles (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
                sort_order INTEGER, created_at INTEGER, updated_at INTEGER
             );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO profiles (id, name, payload) VALUES
             ('proj-a','项目A','{\"providers\":{\"claude\":\"p1\",\"claudeDesktop\":null,\"codex\":\"c1\"},\"mcp\":{},\"skills\":{},\"prompts\":{}}'),
             ('proj-b','项目B','{\"providers\":{\"claude\":null,\"codex\":\"c2\"}}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('current_profile_id_claude','proj-a'),('current_profile_id_codex','proj-b')",
            [],
        )
        .unwrap();
        drop(conn);

        let _guard = env_lock();
        std::env::set_var("CC_SWITCH_HOME", &dir);
        let response = list_cc_profiles();
        assert_eq!(response.profiles.len(), 2);
        assert_eq!(response.profiles[0].id, "proj-a");
        assert_eq!(response.profiles[0].name, "项目A");
        assert_eq!(response.profiles[0].claude_provider.as_deref(), Some("p1"));
        assert_eq!(response.profiles[0].codex_provider.as_deref(), Some("c1"));
        assert_eq!(response.profiles[1].claude_provider, None);
        assert_eq!(response.profiles[1].codex_provider.as_deref(), Some("c2"));
        assert_eq!(response.current_claude.as_deref(), Some("proj-a"));
        assert_eq!(response.current_codex.as_deref(), Some("proj-b"));
        match std::env::var_os("CC_SWITCH_HOME") {
            Some(v) => std::env::set_var("CC_SWITCH_HOME", v),
            None => std::env::remove_var("CC_SWITCH_HOME"),
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_base_url_string_search_fallback() {
        let dir = temp_home("codex-fallback");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('c1','codex','odd','{\"auth\":{\"OPENAI_API_KEY\":\"sk\"},\"config\":\"model_provider = custom\\n[model_providers.custom]\\nbase_url = \\\"https://odd.example/v1\\\"\\n\"}','','custom','{}',0)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers[0].base_url, "https://odd.example/v1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_gemini_provider_fields() {
        let dir = temp_home("gemini");
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                 VALUES ('g1','gemini','Gemini','{\"env\":{\"GEMINI_API_KEY\":\"sk-gem\",\"GEMINI_MODEL\":\"gemini-3.5-flash\",\"GOOGLE_GEMINI_BASE_URL\":\"https://api.miaocg.cn\"},\"config\":{}}','https://api.miaocg.cn','custom','{}',1)",
                [],
            )
            .unwrap();
        });
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.app, "gemini");
        assert_eq!(p.base_url, "https://api.miaocg.cn");
        assert_eq!(p.api_key, "sk-gem");
        assert_eq!(p.api_format, ChannelApiFormat::GeminiNative);
        assert_eq!(p.api_key_auth, "x-goog-api-key");
        assert_eq!(p.model, "gemini-3.5-flash");
        assert!(p.is_current);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_grok_provider_fields_from_toml() {
        let dir = temp_home("grok");
        let toml = r#"[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "grok-4.6"
base_url = "https://api.aizzz.xyz/v1"
name = "grok"
api_backend = "responses"
api_key = "sk-grok-key"
"#;
        let settings = serde_json::json!({ "config": toml }).to_string();
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                &format!(
                    "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                     VALUES ('gr1','grokbuild','grok','{}','https://api.aizzz.xyz','custom','{{\"apiFormat\":\"openai_responses\"}}',1)",
                    settings.replace('\'', "''")
                ),
                [],
            )
            .unwrap();
        });
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.app, "grokbuild");
        assert_eq!(p.base_url, "https://api.aizzz.xyz/v1");
        assert_eq!(p.api_key, "sk-grok-key");
        assert_eq!(p.api_format, ChannelApiFormat::OpenaiResponses);
        assert_eq!(p.api_key_auth, "bearer");
        assert_eq!(p.model, "grok-4.6");
        assert!(p.is_current);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_opencode_provider_fields_and_static_models() {
        let dir = temp_home("opencode");
        let settings = serde_json::json!({
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "https://opencode.ai/zen/go/v1", "apiKey": "sk-oc" },
            "models": {
                "glm-5.3": { "name": "glm-5.3" },
                "deepseek-v4-pro": { "name": "DeepSeek V4 Pro" }
            }
        })
        .to_string();
        let providers = with_test_db(&dir, |conn| {
            conn.execute(
                &format!(
                    "INSERT INTO providers (id, app_type, name, settings_config, website_url, category, meta, is_current)
                     VALUES ('oc1','opencode','OpenCode Go','{}','https://opencode.ai/go','third_party','{{}}',0)",
                    settings.replace('\'', "''")
                ),
                [],
            )
            .unwrap();
        });
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p.app, "opencode");
        assert_eq!(p.base_url, "https://opencode.ai/zen/go/v1");
        assert_eq!(p.api_key, "sk-oc");
        assert_eq!(p.api_format, ChannelApiFormat::OpenaiChat);
        assert_eq!(p.api_key_auth, "bearer");
        assert_eq!(p.model, "");
        let models: Vec<&str> = p.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(models, vec!["deepseek-v4-pro", "glm-5.3"]);
        assert_eq!(p.models[0].name, "DeepSeek V4 Pro");
        let _ = fs::remove_dir_all(&dir);
    }
}
