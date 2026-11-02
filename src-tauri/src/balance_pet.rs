use serde::Serialize;
use serde_json::Value as Json;
use std::{fs, path::PathBuf, time::Duration};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexBalanceResult {
    pub ok: bool,
    pub provider_name: String,
    pub base_url: String,
    pub balance: Option<f64>,
    pub currency: String,
    pub queried_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexOfficialUsageWindow {
    pub used_percent: f64,
    pub limit_window_seconds: Option<i64>,
    pub reset_after_seconds: Option<i64>,
    pub reset_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexOfficialUsageResult {
    pub ok: bool,
    pub plan_type: String,
    pub primary_window: Option<CodexOfficialUsageWindow>,
    pub secondary_window: Option<CodexOfficialUsageWindow>,
    pub limit_reached: bool,
    pub reset_credits_available: Option<i64>,
    pub fetched_at: Option<i64>,
    pub http_status: Option<u16>,
    pub error: Option<String>,
}

struct CodexProviderConfig {
    provider_name: String,
    base_url: String,
    api_key: String,
}

struct CodexOfficialAuth {
    access_token: String,
    account_id: String,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn codex_home_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CODEX_HOME") {
        let path = PathBuf::from(path);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }
    home_dir()
        .map(|path| path.join(".codex"))
        .ok_or_else(|| "找不到 Codex 配置目录".to_string())
}

fn parse_provider_config(text: &str) -> Result<(String, String), String> {
    let config = toml::from_str::<toml::Value>(text)
        .map_err(|_| ".codex/config.toml 格式无法解析".to_string())?;
    let active = config
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let provider = active.and_then(|id| {
        config
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get(id))
    });
    let base_url = provider
        .and_then(|value| value.get("base_url"))
        .and_then(toml::Value::as_str)
        .or_else(|| config.get("base_url").and_then(toml::Value::as_str))
        .map(str::trim)
        .map(|value| value.trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "当前 .codex/config.toml 没有可用的 base_url".to_string())?;
    let provider_name = provider
        .and_then(|value| value.get("name"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or(active)
        .unwrap_or("Codex")
        .to_string();
    Ok((provider_name, base_url))
}

fn api_key_from_auth(text: &str) -> Result<String, String> {
    let auth = serde_json::from_str::<Json>(text)
        .map_err(|_| ".codex/auth.json 格式无法解析".to_string())?;
    auth.get("OPENAI_API_KEY")
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "当前 .codex 未配置 OPENAI_API_KEY".to_string())
}

fn official_auth_from_json(text: &str) -> Result<CodexOfficialAuth, String> {
    let auth = serde_json::from_str::<Json>(text)
        .map_err(|_| ".codex/auth.json 格式无法解析".to_string())?;
    if auth.get("auth_mode").and_then(Json::as_str) != Some("chatgpt") {
        return Err("Codex 当前未使用 ChatGPT 登录，请先运行 codex login".to_string());
    }
    let tokens = auth
        .get("tokens")
        .and_then(Json::as_object)
        .ok_or_else(|| "Codex 登录信息不完整，请重新运行 codex login".to_string())?;
    let read = |key: &str| {
        tokens
            .get(key)
            .and_then(Json::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    Ok(CodexOfficialAuth {
        access_token: read("access_token")
            .ok_or_else(|| "Codex 登录已过期，请重新运行 codex login".to_string())?,
        account_id: read("account_id")
            .ok_or_else(|| "Codex 登录信息缺少账号，请重新运行 codex login".to_string())?,
    })
}

fn current_provider_config() -> Result<CodexProviderConfig, String> {
    let home = home_dir().ok_or_else(|| "找不到用户目录".to_string())?;
    let codex_dir = home.join(".codex");
    let config_text = fs::read_to_string(codex_dir.join("config.toml"))
        .map_err(|_| "未找到 .codex/config.toml".to_string())?;
    let auth_text = fs::read_to_string(codex_dir.join("auth.json"))
        .map_err(|_| "未找到 .codex/auth.json".to_string())?;
    let (provider_name, base_url) = parse_provider_config(&config_text)?;
    Ok(CodexProviderConfig {
        provider_name,
        base_url,
        api_key: api_key_from_auth(&auth_text)?,
    })
}

fn number_field(value: &Json, key: &str) -> Option<f64> {
    value.get(key).and_then(|field| {
        field
            .as_f64()
            .or_else(|| field.as_str().and_then(|text| text.parse::<f64>().ok()))
    })
}

fn integer_field(value: &Json, key: &str) -> Option<i64> {
    value.get(key).and_then(|field| {
        field
            .as_i64()
            .or_else(|| field.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| field.as_str().and_then(|text| text.parse::<i64>().ok()))
    })
}

fn parse_usage_window(value: Option<&Json>) -> Option<CodexOfficialUsageWindow> {
    let value = value?;
    Some(CodexOfficialUsageWindow {
        used_percent: number_field(value, "used_percent")?.clamp(0.0, 100.0),
        limit_window_seconds: integer_field(value, "limit_window_seconds"),
        reset_after_seconds: integer_field(value, "reset_after_seconds"),
        reset_at: integer_field(value, "reset_at"),
    })
}

fn parse_official_usage(body: &Json) -> Result<CodexOfficialUsageResult, String> {
    let rate_limit = body
        .get("rate_limit")
        .ok_or_else(|| "官方额度响应缺少 rate_limit".to_string())?;
    let primary_window = parse_usage_window(rate_limit.get("primary_window"));
    let secondary_window = parse_usage_window(rate_limit.get("secondary_window"));
    if primary_window.is_none() && secondary_window.is_none() {
        return Err("官方额度响应缺少可用窗口".to_string());
    }
    Ok(CodexOfficialUsageResult {
        ok: true,
        plan_type: body
            .get("plan_type")
            .and_then(Json::as_str)
            .unwrap_or_default()
            .to_string(),
        primary_window,
        secondary_window,
        limit_reached: rate_limit
            .get("limit_reached")
            .and_then(Json::as_bool)
            .unwrap_or(false),
        reset_credits_available: body
            .get("rate_limit_reset_credits")
            .and_then(|value| integer_field(value, "available_count")),
        fetched_at: Some(now_millis()),
        http_status: None,
        error: None,
    })
}

fn failure(error: impl Into<String>) -> CodexBalanceResult {
    CodexBalanceResult {
        ok: false,
        provider_name: String::new(),
        base_url: String::new(),
        balance: None,
        currency: String::new(),
        queried_at: None,
        error: Some(error.into()),
    }
}

fn official_failure(
    error: impl Into<String>,
    http_status: Option<u16>,
) -> CodexOfficialUsageResult {
    CodexOfficialUsageResult {
        ok: false,
        plan_type: String::new(),
        primary_window: None,
        secondary_window: None,
        limit_reached: false,
        reset_credits_available: None,
        fetched_at: None,
        http_status,
        error: Some(error.into()),
    }
}

/// Mirrors the cc-switch usage script for the active Codex provider:
/// `GET {{baseUrl}}/user/balance` with its current Bearer API key.
pub async fn query_codex_balance() -> CodexBalanceResult {
    let config = match current_provider_config() {
        Ok(config) => config,
        Err(error) => return failure(error),
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return failure(error.to_string()),
    };
    let response = match client
        .get(format!("{}/user/balance", config.base_url))
        .bearer_auth(&config.api_key)
        .header("User-Agent", "cc-switch/1.0")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return failure(format!("余额请求失败: {error}")),
    };
    let status = response.status();
    let body = match response.json::<Json>().await {
        Ok(body) => body,
        Err(error) => return failure(format!("余额响应无法解析: {error}")),
    };
    if !status.is_success() {
        return failure(format!("余额接口返回 HTTP {}", status.as_u16()));
    }
    let Some(balance) = number_field(&body, "balance") else {
        return failure("余额响应缺少 balance".to_string());
    };
    let currency = body
        .get("currency")
        .and_then(Json::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("USD")
        .to_string();
    CodexBalanceResult {
        ok: true,
        provider_name: config.provider_name,
        base_url: config.base_url,
        balance: Some(balance),
        currency,
        queried_at: Some(now_millis()),
        error: None,
    }
}

/// Reads the current Codex ChatGPT OAuth session and queries the same usage
/// service used by the official Codex client. Tokens never leave the Rust side.
pub async fn query_codex_official_usage() -> CodexOfficialUsageResult {
    let codex_home = match codex_home_dir() {
        Ok(path) => path,
        Err(error) => return official_failure(error, None),
    };
    let auth_text = match fs::read_to_string(codex_home.join("auth.json")) {
        Ok(text) => text,
        Err(_) => return official_failure("未找到 Codex 登录信息，请先运行 codex login", None),
    };
    let auth = match official_auth_from_json(&auth_text) {
        Ok(auth) => auth,
        Err(error) => return official_failure(error, None),
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return official_failure(error.to_string(), None),
    };
    let response = match client
        .get(CODEX_USAGE_URL)
        .bearer_auth(&auth.access_token)
        .header("ChatGPT-Account-Id", &auth.account_id)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return official_failure(format!("官方额度请求失败: {error}"), None),
    };
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 | 403 => "Codex 登录已过期，请重新运行 codex login".to_string(),
            429 => "Codex 官方额度查询过于频繁，稍后自动重试".to_string(),
            code => format!("Codex 官方额度接口返回 HTTP {code}"),
        };
        return official_failure(message, Some(status.as_u16()));
    }
    let body = match response.json::<Json>().await {
        Ok(body) => body,
        Err(error) => return official_failure(format!("官方额度响应无法解析: {error}"), None),
    };
    match parse_official_usage(&body) {
        Ok(result) => result,
        Err(error) => official_failure(error, Some(status.as_u16())),
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::{
        api_key_from_auth, number_field, official_auth_from_json, parse_official_usage,
        parse_provider_config, CodexOfficialUsageWindow,
    };
    use serde_json::json;

    #[test]
    fn parses_the_active_codex_provider_from_toml() {
        let (name, base_url) = parse_provider_config(
            r#"
model_provider = "custom"

[model_providers.custom]
name = "0.01"
base_url = "https://api.example.test/v1/"
"#,
        )
        .expect("provider config");

        assert_eq!(name, "0.01");
        assert_eq!(base_url, "https://api.example.test/v1");
    }

    #[test]
    fn reads_api_key_mode_without_using_oauth_tokens() {
        assert_eq!(
            api_key_from_auth(r#"{"OPENAI_API_KEY":"key-from-codex"}"#).as_deref(),
            Ok("key-from-codex")
        );
        assert!(api_key_from_auth(r#"{"auth_mode":"chatgpt","tokens":{}}"#).is_err());
    }

    #[test]
    fn accepts_numeric_and_string_balance_values() {
        assert_eq!(
            number_field(&json!({ "balance": 26.28873 }), "balance"),
            Some(26.28873)
        );
        assert_eq!(
            number_field(&json!({ "balance": "26.50" }), "balance"),
            Some(26.5)
        );
    }

    #[test]
    fn reads_chatgpt_oauth_without_exposing_other_auth_fields() {
        let auth = official_auth_from_json(
            r#"{"auth_mode":"chatgpt","tokens":{"access_token":"access-secret","account_id":"account-secret","refresh_token":"unused"}}"#,
        )
        .expect("official auth");

        assert_eq!(auth.access_token, "access-secret");
        assert_eq!(auth.account_id, "account-secret");
        assert!(official_auth_from_json(r#"{"auth_mode":"apikey"}"#).is_err());
    }

    #[test]
    fn parses_official_usage_windows_and_reset_credits() {
        let result = parse_official_usage(&json!({
            "plan_type": "pro",
            "rate_limit": {
                "limit_reached": false,
                "primary_window": {
                    "used_percent": 26.5,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 900,
                    "reset_at": 1_777_777_777
                },
                "secondary_window": {
                    "used_percent": "72",
                    "limit_window_seconds": 604800,
                    "reset_at": "1888888888"
                }
            },
            "rate_limit_reset_credits": { "available_count": 2 }
        }))
        .expect("official usage");

        assert_eq!(result.plan_type, "pro");
        assert_eq!(result.reset_credits_available, Some(2));
        assert_eq!(
            result.primary_window,
            Some(CodexOfficialUsageWindow {
                used_percent: 26.5,
                limit_window_seconds: Some(18000),
                reset_after_seconds: Some(900),
                reset_at: Some(1_777_777_777),
            })
        );
        assert_eq!(result.secondary_window.unwrap().used_percent, 72.0);
    }

    #[test]
    fn accepts_a_single_official_usage_window_and_rejects_empty_limits() {
        assert!(parse_official_usage(&json!({
            "rate_limit": { "primary_window": { "used_percent": 150 } }
        }))
        .is_ok_and(|result| result.primary_window.unwrap().used_percent == 100.0));
        assert!(parse_official_usage(&json!({ "rate_limit": {} })).is_err());
    }
}
