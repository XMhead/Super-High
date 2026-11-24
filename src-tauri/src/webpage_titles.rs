use std::{net::IpAddr, time::Duration};

use scraper::{Html, Selector};
use serde::Serialize;
use tokio::task::JoinSet;

const MAX_URLS: usize = 30;
const MAX_HTML_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebpageTitle {
    pub url: String,
    pub title: Option<String>,
}

pub async fn fetch_webpage_titles(urls: Vec<String>) -> Result<Vec<WebpageTitle>, String> {
    if urls.len() > MAX_URLS {
        return Err(format!("一次最多添加 {MAX_URLS} 个网页链接"));
    }

    let client = reqwest::Client::builder()
        .user_agent("Super High")
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !is_allowed_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| error.to_string())?;

    let mut tasks = JoinSet::new();
    for (index, url) in urls.iter().cloned().enumerate() {
        let client = client.clone();
        tasks.spawn(async move {
            let title = fetch_title(&client, &url).await;
            (index, title)
        });
    }

    let mut titles = vec![None; urls.len()];
    while let Some(result) = tasks.join_next().await {
        if let Ok((index, title)) = result {
            titles[index] = title;
        }
    }

    Ok(urls
        .into_iter()
        .zip(titles)
        .map(|(url, title)| WebpageTitle { url, title })
        .collect())
}

async fn fetch_title(client: &reqwest::Client, raw_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw_url).ok()?;
    if !is_allowed_url(&url) {
        return None;
    }

    let mut response = client.get(url).send().await.ok()?.error_for_status().ok()?;
    let mut html = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        let remaining = MAX_HTML_BYTES.saturating_sub(html.len());
        if remaining == 0 {
            break;
        }
        html.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if html.len() == MAX_HTML_BYTES {
            break;
        }
    }

    extract_title(&String::from_utf8_lossy(&html))
}

fn is_allowed_url(url: &reqwest::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return false;
    }

    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return false;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified(),
            IpAddr::V6(ip) => !ip.is_loopback() && !ip.is_unique_local() && !ip.is_unicast_link_local() && !ip.is_unspecified(),
        };
    }
    true
}

fn extract_title(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    for selector in [
        "meta[property='og:title']",
        "meta[name='twitter:title']",
        "title",
    ] {
        let selector = Selector::parse(selector).ok()?;
        let value = document.select(&selector).next().and_then(|element| {
            if element.value().name() == "meta" {
                element.value().attr("content").map(str::to_owned)
            } else {
                Some(element.text().collect::<String>())
            }
        });
        if let Some(title) = value {
            let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
            if !title.is_empty() {
                return Some(title);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::extract_title;

    #[test]
    fn extracts_social_title_and_decodes_entities() {
        assert_eq!(
            extract_title("<html><head><title>Fallback</title><meta content=\"Model &amp; Map\" property=\"og:title\"></head></html>"),
            Some("Model & Map".to_owned()),
        );
    }

    #[test]
    fn collapses_title_whitespace_and_falls_back_to_document_title() {
        assert_eq!(
            extract_title("<title>  Example\n   Page </title>"),
            Some("Example Page".to_owned()),
        );
    }
}
