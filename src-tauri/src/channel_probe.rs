use std::time::{Duration, Instant};

use anyhow::Context;
use serde_json::Value;

use crate::models::{
    ChannelApiFormat, ChannelConfig, ChannelProbeResult, ChannelProviderKind, EndpointLatencyResult,
    FetchedModel,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REPLY_CHARS: usize = 500;

fn default_model(config: &ChannelConfig) -> String {
    let configured = config.model.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }
    match config.provider {
        ChannelProviderKind::Claude => "claude-opus-5".to_string(),
        ChannelProviderKind::Codex => "gpt-5.5".to_string(),
    }
}

/// 渠道实际生效的 API 格式：显式配置优先；未配置时按渠道类型取原生默认
/// （Claude → Anthropic Messages；Codex → OpenAI Responses）。
fn effective_api_format(config: &ChannelConfig) -> ChannelApiFormat {
    config.api_format.unwrap_or_else(|| match config.provider {
        ChannelProviderKind::Claude => ChannelApiFormat::Anthropic,
        ChannelProviderKind::Codex => ChannelApiFormat::OpenaiResponses,
    })
}

fn build_endpoint(config: &ChannelConfig) -> String {
    let base = config.base_url.trim().trim_end_matches('/');
    match effective_api_format(config) {
        ChannelApiFormat::Anthropic => {
            if base.ends_with("/v1/messages") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            }
        }
        ChannelApiFormat::OpenaiResponses => {
            if base.ends_with("/v1/responses") || base.ends_with("/responses") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{base}/responses")
            } else {
                format!("{base}/v1/responses")
            }
        }
        ChannelApiFormat::OpenaiChat => {
            if base.ends_with("/chat/completions") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{base}/chat/completions")
            } else {
                format!("{base}/v1/chat/completions")
            }
        }
    }
}

fn request_body(model: &str, format: ChannelApiFormat) -> serde_json::Value {
    match format {
        ChannelApiFormat::Anthropic | ChannelApiFormat::OpenaiChat => serde_json::json!({
            "model": model,
            "max_tokens": 32,
            "messages": [{ "role": "user", "content": "你是谁？请用一句话回答。" }],
        }),
        ChannelApiFormat::OpenaiResponses => serde_json::json!({
            "model": model,
            "max_output_tokens": 32,
            "input": "你是谁？请用一句话回答。",
        }),
    }
}

fn truncate(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() > MAX_REPLY_CHARS {
        let mut result: String = trimmed.chars().take(MAX_REPLY_CHARS).collect();
        result.push('…');
        result
    } else {
        trimmed.to_string()
    }
}

/// 从响应 JSON 里尽量提取一段可读文本（回复或错误消息）。
fn extract_text(body: &str, format: ChannelApiFormat, prefer_error: bool) -> String {
    let parsed: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if parsed.is_object() {
        if let Some(message) = parsed["error"]["message"].as_str() {
            if !message.trim().is_empty() {
                return truncate(message);
            }
        }
    }
    if !prefer_error {
        let candidate = match format {
            ChannelApiFormat::Anthropic => parsed["content"][0]["text"].as_str(),
            ChannelApiFormat::OpenaiChat => parsed["choices"][0]["message"]["content"].as_str(),
            ChannelApiFormat::OpenaiResponses => parsed["output"][0]["content"][0]["text"].as_str(),
        };
        if let Some(text) = candidate {
            if !text.trim().is_empty() {
                return truncate(text);
            }
        }
    }
    if !body.trim().is_empty() {
        return truncate(body);
    }
    String::new()
}

/// 测试一个渠道：向对应 API 发送“你是谁”请求并测量延迟。
/// 任何可预期的失败都会以 `ok=false` 的结果返回，只有无法构造请求时才返回 Err。
pub async fn probe_channel(config: &ChannelConfig) -> anyhow::Result<ChannelProbeResult> {
    let endpoint = build_endpoint(config);
    let base = config.base_url.trim();

    let result = if base.is_empty() {
        ChannelProbeResult {
            ok: false,
            latency_ms: 0,
            endpoint,
            reply: String::new(),
            error: "接口地址不能为空".to_string(),
            status: 0,
        }
    } else if config.api_key.trim().is_empty() {
        ChannelProbeResult {
            ok: false,
            latency_ms: 0,
            endpoint,
            reply: String::new(),
            error: "API Key 不能为空".to_string(),
            status: 0,
        }
    } else {
        let client = reqwest::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .build()
            .context("failed to build http client")?;
        let started = Instant::now();
        let model = default_model(config);
        let format = effective_api_format(config);
        let request = client.post(&endpoint).json(&request_body(&model, format));
        let response = match format {
            ChannelApiFormat::Anthropic => request
                .header("x-api-key", config.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .send()
                .await,
            ChannelApiFormat::OpenaiResponses | ChannelApiFormat::OpenaiChat => request
                .bearer_auth(config.api_key.trim())
                .send()
                .await,
        };

        match response {
            Ok(response) => {
                let status = response.status();
                let latency_ms = started.elapsed().as_millis() as u64;
                let body = response.text().await.unwrap_or_default();
                let ok = status.is_success();
                if ok {
                    ChannelProbeResult {
                        ok: true,
                        latency_ms,
                        endpoint,
                        reply: extract_text(&body, format, false),
                        error: String::new(),
                        status: status.as_u16(),
                    }
                } else {
                    let detail = extract_text(&body, format, true);
                    let error = if detail.is_empty() {
                        format!("HTTP {}", status.as_u16())
                    } else {
                        format!("HTTP {} · {}", status.as_u16(), detail)
                    };
                    ChannelProbeResult {
                        ok: false,
                        latency_ms,
                        endpoint,
                        reply: String::new(),
                        error,
                        status: status.as_u16(),
                    }
                }
            }
            Err(error) => {
                let latency_ms = started.elapsed().as_millis() as u64;
                ChannelProbeResult {
                    ok: false,
                    latency_ms,
                    endpoint,
                    reply: String::new(),
                    error: error.to_string(),
                    status: 0,
                }
            }
        }
    };

    Ok(result)
}

const LATENCY_TIMEOUT: Duration = Duration::from_secs(8);
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const ERROR_BODY_MAX_CHARS: usize = 512;

/// 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
/// 命中时，模型列表候选会追加「剥离后缀再拼 /v1/models / /models」的版本。
const KNOWN_COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/step_plan",
    "/coding",
    "/claude",
];

fn truncate_body(body: String) -> String {
    if body.chars().count() <= ERROR_BODY_MAX_CHARS {
        body
    } else {
        let mut s: String = body.chars().take(ERROR_BODY_MAX_CHARS).collect();
        s.push('…');
        s
    }
}

/// 纯网站/接口延迟检测：对「官网链接」和「接口地址」各做一次 HTTP GET，
/// 只测网络可达性与响应耗时，不启动 CLI、不发送任何业务消息。
/// 参照 cc-switch：先热身一次，第二次请求开始计时；任何 HTTP 响应都算可达，
/// 只有 DNS / 连接 / TLS / 超时才算失败。
pub async fn probe_website_latency(config: &ChannelConfig) -> Vec<EndpointLatencyResult> {
    let mut targets: Vec<(String, String)> = Vec::new();
    let website = config.website_url.trim();
    let api = config.base_url.trim();
    if !website.is_empty() {
        targets.push(("官网链接".to_string(), website.to_string()));
    }
    if !api.is_empty() {
        targets.push(("接口地址".to_string(), api.to_string()));
    }

    let mut results = Vec::with_capacity(targets.len());
    if targets.is_empty() {
        return results;
    }

    let client = match reqwest::Client::builder().build() {
        Ok(client) => client,
        Err(error) => {
            return targets
                .into_iter()
                .map(|(label, url)| EndpointLatencyResult {
                    url,
                    label,
                    latency_ms: None,
                    status: None,
                    error: Some(format!("无法创建 HTTP 客户端: {error}")),
                })
                .collect();
        }
    };

    for (label, url) in targets {
        // 第一次请求热身，忽略结果（复用连接、绕过首包惩罚）。
        let _ = client.get(&url).timeout(LATENCY_TIMEOUT).send().await;
        // 第二次请求开始计时。
        let started = Instant::now();
        match client.get(&url).timeout(LATENCY_TIMEOUT).send().await {
            Ok(response) => results.push(EndpointLatencyResult {
                url,
                label,
                latency_ms: Some(started.elapsed().as_millis() as u64),
                status: Some(response.status().as_u16()),
                error: None,
            }),
            Err(error) => {
                let error_message = if error.is_timeout() {
                    "请求超时".to_string()
                } else if error.is_connect() {
                    "连接失败".to_string()
                } else {
                    error.to_string()
                };
                results.push(EndpointLatencyResult {
                    url,
                    label,
                    latency_ms: None,
                    status: None,
                    error: Some(error_message),
                });
            }
        }
    }

    results
}

/// 判断 baseURL 是否以 OpenAI 风格的版本段 `/v{N}` 结尾（`N` 为一个或多个数字）。
fn ends_with_version_segment(url: &str) -> bool {
    let last = url.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// 若 baseURL 以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `None`。
fn strip_compat_suffix(base_url: &str) -> Option<&str> {
    for suffix in KNOWN_COMPAT_SUFFIXES {
        if base_url.ends_with(*suffix) {
            return Some(&base_url[..base_url.len() - suffix.len()]);
        }
    }
    None
}

/// 构造「模型列表端点」的候选 URL 列表（参照 cc-switch 的 model_fetch 逻辑）：
/// 1. baseURL 拼 `/v1/models`；若已以版本段 `/v{N}` 结尾，改拼 `/models`
/// 2. 版本段非 `/v1` 时追加 `/v1/models` 作为兜底次候选
/// 3. 命中 Anthropic 兼容子路径时剥离后缀再拼 `/v1/models`、`/models`
/// 结果已去重且保持首次出现顺序。
pub fn build_models_url_candidates(base_url: &str) -> Vec<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut candidates: Vec<String> = Vec::new();
    let mut push = |url: String| {
        if !candidates.iter().any(|u| u == &url) {
            candidates.push(url);
        }
    };

    if ends_with_version_segment(trimmed) {
        push(format!("{trimmed}/models"));
        if !trimmed.ends_with("/v1") {
            push(format!("{trimmed}/v1/models"));
        }
    } else {
        push(format!("{trimmed}/v1/models"));
    }

    if let Some(stripped) = strip_compat_suffix(trimmed) {
        let root = stripped.trim_end_matches('/');
        if !root.is_empty() && root.contains("://") {
            push(format!("{root}/v1/models"));
            push(format!("{root}/models"));
        }
    }

    candidates
}

/// 通过 OpenAI 兼容的 GET /v1/models 接口获取渠道可用模型列表。
/// 参照 cc-switch：按候选地址顺序尝试，任一成功即返回；404/405 继续尝试下一个。
pub async fn fetch_channel_models(config: &ChannelConfig) -> anyhow::Result<Vec<FetchedModel>> {
    if config.api_key.trim().is_empty() {
        return Err(anyhow::anyhow!("API Key 不能为空"));
    }

    let candidates = build_models_url_candidates(&config.base_url);
    if candidates.is_empty() {
        return Err(anyhow::anyhow!("接口地址不能为空"));
    }

    let client = reqwest::Client::builder().build().context("failed to build http client")?;
    let api_key = config.api_key.trim().to_string();
    let mut last_err: Option<String> = None;

    for url in &candidates {
        let mut request = client
            .get(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .timeout(MODELS_TIMEOUT);
        // Claude 网关额外带 x-api-key，兼容只认这个头的网关。
        if config.provider == ChannelProviderKind::Claude {
            request = request.header("x-api-key", &api_key);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => return Err(anyhow::anyhow!("请求失败: {error}")),
        };

        let status = response.status();
        if status.is_success() {
            let value: serde_json::Value = response
                .json()
                .await
                .context("响应不是有效的 JSON")?;
            let mut models: Vec<FetchedModel> = value
                .get("data")
                .and_then(|data| data.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let id = item.get("id")?.as_str()?.to_string();
                            let owned_by = item
                                .get("owned_by")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                            Some(FetchedModel { id, owned_by })
                        })
                        .collect()
                })
                .unwrap_or_default();
            models.sort_by(|a, b| a.id.cmp(&b.id));
            return Ok(models);
        }

        let body = truncate_body(response.text().await.unwrap_or_default());
        if status == reqwest::StatusCode::NOT_FOUND
            || status == reqwest::StatusCode::METHOD_NOT_ALLOWED
        {
            last_err = Some(format!("HTTP {status}: {body}"));
            continue;
        }
        return Err(anyhow::anyhow!("HTTP {status}: {body}"));
    }

    Err(anyhow::anyhow!(
        "所有候选端点都不可用: {}",
        last_err.unwrap_or_else(|| "没有候选地址".to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ChannelConfig;

    fn config(provider: ChannelProviderKind, base_url: &str) -> ChannelConfig {
        ChannelConfig {
            id: "c1".to_string(),
            name: "test".to_string(),
            provider,
            website_url: String::new(),
            base_url: base_url.to_string(),
            api_key: "sk-test".to_string(),
            model: String::new(),
            api_format: None,
        }
    }

    #[test]
    fn claude_default_endpoint_appends_v1_messages() {
        let channel = config(ChannelProviderKind::Claude, "https://claudenb.com");
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/messages");
    }

    #[test]
    fn claude_v1_base_appends_messages() {
        let channel = config(ChannelProviderKind::Claude, "https://claudenb.com/v1/");
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/messages");
    }

    #[test]
    fn codex_default_endpoint_appends_v1_responses() {
        let channel = config(ChannelProviderKind::Codex, "https://claudenb.com/v1");
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/responses");
    }

    #[test]
    fn codex_chat_format_appends_v1_chat_completions() {
        let mut channel = config(ChannelProviderKind::Codex, "https://claudenb.com/v1");
        channel.api_format = Some(ChannelApiFormat::OpenaiChat);
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/chat/completions");
    }

    #[test]
    fn chat_full_endpoint_is_kept() {
        let mut channel = config(ChannelProviderKind::Codex, "https://claudenb.com/v1/chat/completions");
        channel.api_format = Some(ChannelApiFormat::OpenaiChat);
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/chat/completions");
    }

    #[test]
    fn codex_bare_base_appends_full_path() {
        let channel = config(ChannelProviderKind::Codex, "https://claudenb.com");
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/responses");
    }

    #[test]
    fn responses_full_endpoint_is_kept() {
        let mut channel = config(ChannelProviderKind::Codex, "https://claudenb.com/v1/responses");
        channel.api_format = Some(ChannelApiFormat::OpenaiResponses);
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/responses");
    }

    #[test]
    fn explicit_responses_format_overrides_claude_native() {
        let mut channel = config(ChannelProviderKind::Claude, "https://claudenb.com");
        channel.api_format = Some(ChannelApiFormat::OpenaiResponses);
        assert_eq!(build_endpoint(&channel), "https://claudenb.com/v1/responses");
    }

    #[test]
    fn default_format_follows_provider() {
        let claude = config(ChannelProviderKind::Claude, "https://claudenb.com");
        let codex = config(ChannelProviderKind::Codex, "https://claudenb.com/v1");
        assert_eq!(effective_api_format(&claude), ChannelApiFormat::Anthropic);
        assert_eq!(effective_api_format(&codex), ChannelApiFormat::OpenaiResponses);
    }

    #[test]
    fn default_model_falls_back_per_provider() {
        let claude = config(ChannelProviderKind::Claude, "https://claudenb.com");
        let codex = config(ChannelProviderKind::Codex, "https://claudenb.com/v1");
        assert_eq!(default_model(&claude), "claude-opus-5");
        assert_eq!(default_model(&codex), "gpt-5.5");
    }

    #[test]
    fn configured_model_wins() {
        let mut channel = config(ChannelProviderKind::Claude, "https://claudenb.com");
        channel.model = "custom-model".to_string();
        assert_eq!(default_model(&channel), "custom-model");
    }

    #[test]
    fn extract_text_reads_claude_reply() {
        let body = r#"{"content":[{"type":"text","text":"我是 Claude。"}]}"#;
        assert_eq!(extract_text(body, ChannelApiFormat::Anthropic, false), "我是 Claude。");
    }

    #[test]
    fn extract_text_reads_chat_reply() {
        let body = r#"{"choices":[{"message":{"content":"我是 Codex。"}}]}"#;
        assert_eq!(extract_text(body, ChannelApiFormat::OpenaiChat, false), "我是 Codex。");
    }

    #[test]
    fn extract_text_reads_responses_reply() {
        let body = r#"{"output":[{"content":[{"type":"output_text","text":"我是 Codex。"}]}]}"#;
        assert_eq!(extract_text(body, ChannelApiFormat::OpenaiResponses, false), "我是 Codex。");
    }

    #[test]
    fn extract_text_prefers_error_message() {
        let body = r#"{"error":{"message":"invalid api key"}}"#;
        assert_eq!(extract_text(body, ChannelApiFormat::Anthropic, true), "invalid api key");
    }

    #[test]
    fn request_body_uses_messages_for_anthropic_and_chat() {
        let anthropic = request_body("claude-opus-5", ChannelApiFormat::Anthropic);
        assert!(anthropic["messages"][0]["content"].as_str().is_some());
        assert!(anthropic.get("input").is_none());
        let chat = request_body("gpt-5.5", ChannelApiFormat::OpenaiChat);
        assert!(chat["messages"][0]["content"].as_str().is_some());
        assert_eq!(chat["max_tokens"], 32);
    }

    #[test]
    fn channel_config_deserializes_api_format_camel_case() {
        let json = r#"{
            "id": "c1",
            "name": "test",
            "provider": "codex",
            "websiteUrl": "https://claudenb.com",
            "baseUrl": "https://claudenb.com/v1",
            "apiKey": "sk-test",
            "model": "",
            "apiFormat": "openai_responses"
        }"#;
        let channel: ChannelConfig = serde_json::from_str(json).unwrap();
        assert_eq!(channel.api_format, Some(ChannelApiFormat::OpenaiResponses));
    }

    #[test]
    fn channel_config_missing_api_format_defaults_to_none() {
        let json = r#"{
            "id": "c1",
            "name": "test",
            "provider": "claude",
            "websiteUrl": "https://claudenb.com",
            "baseUrl": "https://claudenb.com/v1",
            "apiKey": "sk-test",
            "model": ""
        }"#;
        let channel: ChannelConfig = serde_json::from_str(json).unwrap();
        assert_eq!(channel.api_format, None);
    }

    #[test]
    fn request_body_uses_input_for_responses() {
        let body = request_body("gpt-5.5", ChannelApiFormat::OpenaiResponses);
        assert_eq!(body["input"], "你是谁？请用一句话回答。");
        assert_eq!(body["max_output_tokens"], 32);
        assert!(body.get("messages").is_none());
    }

    #[test]
    fn models_candidates_plain_root() {
        assert_eq!(
            build_models_url_candidates("https://api.siliconflow.cn"),
            vec!["https://api.siliconflow.cn/v1/models"]
        );
    }

    #[test]
    fn models_candidates_v1_suffix_uses_models() {
        assert_eq!(
            build_models_url_candidates("https://claudenb.com/v1"),
            vec!["https://claudenb.com/v1/models"]
        );
    }

    #[test]
    fn models_candidates_strip_anthropic_suffix() {
        assert_eq!(
            build_models_url_candidates("https://api.deepseek.com/anthropic"),
            vec![
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/v1/models",
                "https://api.deepseek.com/models",
            ]
        );
    }

    #[test]
    fn models_candidates_trailing_slash() {
        assert_eq!(
            build_models_url_candidates("https://claudenb.com/"),
            vec!["https://claudenb.com/v1/models"]
        );
    }

    #[test]
    fn models_candidates_empty_returns_empty() {
        assert!(build_models_url_candidates("   ").is_empty());
    }

    #[test]
    fn models_candidates_deduplicate() {
        let candidates = build_models_url_candidates("https://host.example.com");
        assert_eq!(candidates.len(), 1);
    }

    #[test]
    fn latency_probe_reports_both_urls() {
        let channel = ChannelConfig {
            id: "c1".to_string(),
            name: "test".to_string(),
            provider: ChannelProviderKind::Claude,
            website_url: "https://claudenb.com".to_string(),
            base_url: "https://claudenb.com/v1".to_string(),
            api_key: "sk-test".to_string(),
            model: String::new(),
            api_format: None,
        };
        let results = tauri::async_runtime::block_on(probe_website_latency(&channel));
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].label, "官网链接");
        assert_eq!(results[1].label, "接口地址");
    }

    #[test]
    fn latency_probe_skips_empty_urls() {
        let channel = ChannelConfig {
            id: "c1".to_string(),
            name: "test".to_string(),
            provider: ChannelProviderKind::Codex,
            website_url: String::new(),
            base_url: "  ".to_string(),
            api_key: "sk-test".to_string(),
            model: String::new(),
            api_format: None,
        };
        let results = tauri::async_runtime::block_on(probe_website_latency(&channel));
        assert!(results.is_empty());
    }
}
