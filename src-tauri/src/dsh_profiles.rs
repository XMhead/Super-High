//! Read-only views over the DSH configuration owned by `dsh_config`.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_yaml::Value;

use crate::dsh_config::{self, DshConfigModel, DshConfigProvider};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshProfileInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub model_source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshProviderInfo {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api: String,
    pub has_api_key: bool,
    pub models: Vec<DshProviderModel>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DshProviderModel {
    pub id: String,
    pub name: String,
}

/// DSH 配置根目录：`$DSH_HOME` 优先，否则 `~/.dsh`。
pub fn dsh_home() -> Option<PathBuf> {
    dsh_config::dsh_home()
}

pub fn list_dsh_providers() -> Vec<DshProviderInfo> {
    if let Ok(Some(config)) = dsh_config::load_existing() {
        return config
            .providers
            .iter()
            .map(|(id, provider)| provider_info(id, provider))
            .collect();
    }
    legacy_provider_infos()
}

pub fn list_dsh_default() -> Option<(String, String)> {
    if let Ok(Some(config)) = dsh_config::load_existing() {
        if let (Some(provider), Some(model)) = (config.active_provider, config.active_model) {
            return Some((provider, model));
        }
    }
    let home = dsh_home()?;
    parse_settings_default(&home.join("settings.yaml"))
}

/// 仅用于渠道检测的 Key 读取。新配置直接来自 config.toml；旧配置仅在迁移
/// 尚未完成时回退读取，绝不注册或修改系统环境变量。
pub fn api_key_for_provider(provider_id: &str) -> Option<String> {
    if let Ok(Some(config)) = dsh_config::load_existing() {
        return dsh_config::api_key(&config, provider_id);
    }
    legacy_api_key_for_provider(provider_id)
}

fn provider_info(id: &str, provider: &DshConfigProvider) -> DshProviderInfo {
    DshProviderInfo {
        id: id.to_string(),
        name: provider
            .display_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| id.to_string()),
        base_url: provider.base_url.clone(),
        api: provider.api.clone(),
        has_api_key: provider
            .api_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty()),
        models: provider.models.iter().map(model_info).collect(),
    }
}

fn model_info(model: &DshConfigModel) -> DshProviderModel {
    DshProviderModel {
        id: model.id.clone(),
        name: model.name.clone().unwrap_or_default(),
    }
}

/// 扫描 dsh 全部分组（profiles/*）及其默认模型。profile 自带路由优先，
/// 没有自带路由的分组跟随 config.toml 当前路由。
pub fn list_dsh_profiles() -> Vec<DshProfileInfo> {
    let Some(home) = dsh_home() else {
        return Vec::new();
    };
    let profiles_dir = home.join("profiles");
    let mut dirs: Vec<PathBuf> = fs::read_dir(&profiles_dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    dirs.sort();

    let fallback = list_dsh_default();
    let mut profiles = Vec::new();
    for dir in dirs {
        let Some(id) = dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        if id.starts_with('.') || id.eq_ignore_ascii_case("node_modules") {
            continue;
        }
        let patch_route = parse_profile_route(&dir.join("cordis.patch.yml"));
        let route = patch_route.clone().or_else(|| fallback.clone());
        let Some((provider, model)) = route else {
            continue;
        };
        profiles.push(DshProfileInfo {
            id: id.clone(),
            name: id,
            provider,
            model,
            model_source: if patch_route.is_some() {
                "profile-patch".to_string()
            } else {
                "config".to_string()
            },
        });
    }

    if profiles.is_empty() {
        if let Some((provider, model)) = fallback {
            profiles.push(DshProfileInfo {
                id: "default".to_string(),
                name: "default".to_string(),
                provider,
                model,
                model_source: "config".to_string(),
            });
        }
    }
    profiles
}

fn parse_profile_route(path: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(path).ok()?;
    let mut provider = None;
    let mut model = None;
    let mut in_dsh_tui = false;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("- id:") {
            in_dsh_tui = scalar(Some(trimmed.strip_prefix("- id:")?)) == Some("dsh-tui".to_string());
            provider = None;
            model = None;
            continue;
        }
        if !in_dsh_tui {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("provider:") {
            provider = scalar(Some(value));
        } else if let Some(value) = trimmed.strip_prefix("model:") {
            model = scalar(Some(value));
        }
    }
    provider.zip(model)
}

fn parse_settings_default(path: &Path) -> Option<(String, String)> {
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_yaml::from_str(&text).ok()?;
    let route = value.get("agent-default-model")?.as_mapping()?;
    Some((
        route.get("provider")?.as_str()?.trim().to_string(),
        route.get("model")?.as_str()?.trim().to_string(),
    ))
}

fn legacy_provider_infos() -> Vec<DshProviderInfo> {
    let Some(home) = dsh_home() else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(home.join("settings.yaml")) else {
        return Vec::new();
    };
    let Ok(value) = serde_yaml::from_str::<Value>(&text) else {
        return Vec::new();
    };
    let Some(providers) = value
        .get("llm-pi-ai")
        .and_then(|value| value.get("providers"))
        .and_then(Value::as_mapping)
    else {
        return Vec::new();
    };
    let credentials = read_legacy_credentials(&home.join(".credentials.yaml"));
    providers
        .iter()
        .filter_map(|(id, value)| {
            let id = id.as_str()?;
            let map = value.as_mapping()?;
            let models = map
                .get("models")
                .and_then(Value::as_sequence)
                .into_iter()
                .flat_map(|items| items.iter())
                .filter_map(|item| {
                    let map = item.as_mapping()?;
                    Some(DshProviderModel {
                        id: map.get("id")?.as_str()?.to_string(),
                        name: map
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect::<Vec<_>>();
            Some(DshProviderInfo {
                id: id.to_string(),
                name: map
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                base_url: map
                    .get("baseURL")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                api: map
                    .get("api")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                has_api_key: map
                    .get("apiKeyEnv")
                    .and_then(Value::as_str)
                    .and_then(|name| credentials.get(name))
                    .is_some_and(|key| !key.trim().is_empty()),
                models,
            })
        })
        .collect()
}

fn legacy_api_key_for_provider(provider_id: &str) -> Option<String> {
    let home = dsh_home()?;
    let settings: Value =
        serde_yaml::from_str(&fs::read_to_string(home.join("settings.yaml")).ok()?).ok()?;
    let provider = settings
        .get("llm-pi-ai")?
        .get("providers")?
        .get(provider_id)?;
    let env_name = provider.get("apiKeyEnv")?.as_str()?;
    read_legacy_credentials(&home.join(".credentials.yaml"))
        .get(env_name)
        .cloned()
}

fn read_legacy_credentials(path: &Path) -> std::collections::BTreeMap<String, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Default::default();
    };
    let Ok(value) = serde_yaml::from_str::<Value>(&text) else {
        return Default::default();
    };
    let section = value
        .get("refs")
        .and_then(Value::as_mapping)
        .or_else(|| value.as_mapping());
    section
        .into_iter()
        .flat_map(|mapping| mapping.iter())
        .filter_map(|(key, value)| Some((key.as_str()?.to_string(), value.as_str()?.to_string())))
        .collect()
}

fn scalar(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.split('#').next().unwrap_or(value).trim())
        .map(|value| value.trim_matches(['"', '\'']).to_string())
}

#[cfg(test)]
pub mod tests {
    use once_cell::sync::Lazy;
    use std::sync::Mutex;

    /// All tests which alter DSH_HOME/USERPROFILE/HOME share this lock.
    pub static ENV_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    #[test]
    fn shared_environment_lock_is_available() {
        let _guard = ENV_LOCK.lock().unwrap();
    }
}
