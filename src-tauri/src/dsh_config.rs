//! Single-source DSH provider configuration.
//!
//! SuperHigh owns `~/.dsh/config.toml`.  The file contains provider URL,
//! model metadata and the API key directly, which makes switching a provider
//! one file operation.  dsh rc.6 still requires an `apiKeyEnv` field, so the
//! editor creates an internal reference in the compatibility `settings.yaml`
//! and the terminal launcher supplies that value only to the child process.
//! No Windows user or machine environment variable is ever written.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_yaml::Value as YamlValue;
use std::sync::{Mutex, MutexGuard};

pub const CONFIG_FILE_NAME: &str = "config.toml";
pub const CONFIG_VERSION: u32 = 1;
pub const OPENAI_CODEX_PROVIDER: &str = "openai-codex";
const INTERNAL_ENV_PREFIX: &str = "SUPERHIGH_DSH_KEY_";

static CONFIG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

/// Serialize config and generated compatibility-file edits within the app.
/// The frontend loads several DSH views concurrently, so without one lock two
/// commands could read the same TOML snapshot and overwrite each other's
/// route or provider update.
pub fn edit_lock() -> MutexGuard<'static, ()> {
    CONFIG_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DshConfigFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_model: Option<String>,
    #[serde(default)]
    pub providers: BTreeMap<String, DshConfigProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DshConfigProvider {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub api: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub models: Vec<DshConfigModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DshConfigModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Vec<String>>,
}

fn default_version() -> u32 {
    CONFIG_VERSION
}

pub fn dsh_home() -> Option<PathBuf> {
    std::env::var_os("DSH_HOME").map(PathBuf::from).or_else(|| {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(|home| PathBuf::from(home).join(".dsh"))
    })
}

pub fn config_path() -> Option<PathBuf> {
    dsh_home().map(|home| home.join(CONFIG_FILE_NAME))
}

pub fn internal_env_name(provider_id: &str) -> String {
    let mut result = String::from(INTERNAL_ENV_PREFIX);
    let mut last_separator = false;
    for ch in provider_id.chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch.to_ascii_uppercase());
            last_separator = false;
        } else if !last_separator {
            result.push('_');
            last_separator = true;
        }
    }
    while result.ends_with('_') {
        result.pop();
    }
    if result == INTERNAL_ENV_PREFIX {
        result.push_str("DEFAULT");
    }
    result
}

pub fn load_existing() -> Result<Option<DshConfigFile>, String> {
    let Some(path) = config_path() else {
        return Ok(None);
    };
    match fs::read_to_string(&path) {
        Ok(text) => parse_config(&text, &path).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取 {}: {error}", path.display())),
    }
}

pub fn load_or_migrate() -> Result<DshConfigFile, String> {
    if let Some(mut config) = load_existing()? {
        if repair_missing_active_model(&mut config) {
            write_config(&config)?;
        } else {
            validate_config(&config)?;
        }
        return Ok(config);
    }

    let has_legacy_settings = dsh_home()
        .map(|home| home.join("settings.yaml").exists())
        .unwrap_or(false);
    let config = if has_legacy_settings {
        migrate_legacy()?
    } else {
        empty_config()
    };
    validate_config(&config)?;
    write_config(&config)?;
    Ok(config)
}

/// DSH can retain an active route after a provider's model list changes. Keep
/// the authoritative config internally consistent before generating its native
/// bridge, rather than making the next launch fail.
fn repair_missing_active_model(config: &mut DshConfigFile) -> bool {
    let Some(provider_id) = config.active_provider.as_deref() else {
        return false;
    };
    let Some(model_id) = config.active_model.as_deref() else {
        return false;
    };
    if model_id.trim().is_empty() || model_id.contains(['\r', '\n']) {
        return false;
    }
    let Some(provider) = config.providers.get_mut(provider_id) else {
        return false;
    };
    if provider.models.iter().any(|model| model.id == model_id) {
        return false;
    }
    provider.models.push(DshConfigModel {
        id: model_id.to_string(),
        name: None,
        context_window: None,
        max_tokens: None,
        input: None,
    });
    true
}

pub fn empty_config() -> DshConfigFile {
    DshConfigFile {
        version: CONFIG_VERSION,
        active_provider: None,
        active_model: None,
        providers: BTreeMap::new(),
    }
}

pub fn write_config(config: &DshConfigFile) -> Result<(), String> {
    validate_config(config)?;
    let path =
        config_path().ok_or_else(|| "找不到 dsh 配置目录（$DSH_HOME 或 ~/.dsh）".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 {}: {error}", parent.display()))?;
    }
    let mut text =
        toml::to_string_pretty(config).map_err(|error| format!("无法生成 config.toml: {error}"))?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    let temporary = path.with_extension("toml.tmp");
    fs::write(&temporary, text)
        .map_err(|error| format!("无法写入 {}: {error}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法替换 {}: {error}", path.display()));
    }
    Ok(())
}

pub fn runtime_environment(config: &DshConfigFile) -> Vec<(String, String)> {
    config
        .providers
        .iter()
        .filter_map(|(id, provider)| {
            provider
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(|key| (internal_env_name(id), key.to_string()))
        })
        .collect()
}

pub fn api_key(config: &DshConfigFile, provider_id: &str) -> Option<String> {
    config
        .providers
        .get(provider_id)
        .and_then(|provider| provider.api_key.clone())
        .filter(|value| !value.trim().is_empty())
}

pub fn validate_provider_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    {
        return Err("供应商 id 只允许字母、数字、点、横线与下划线".to_string());
    }
    Ok(())
}

pub fn validate_config(config: &DshConfigFile) -> Result<(), String> {
    if config.version != CONFIG_VERSION {
        return Err(format!(
            "{} 版本 {} 不受支持（当前版本为 {}）",
            CONFIG_FILE_NAME, config.version, CONFIG_VERSION
        ));
    }
    let mut internal_names = std::collections::HashSet::new();
    for (id, provider) in &config.providers {
        validate_provider_id(id)?;
        if !internal_names.insert(internal_env_name(id)) {
            return Err(format!("供应商 id {id} 与另一个供应商产生相同的内部凭据键"));
        }
        if id != OPENAI_CODEX_PROVIDER {
            if provider.api.trim().is_empty() {
                return Err(format!("供应商 {id} 缺少 api"));
            }
            if provider.base_url.trim().is_empty() {
                return Err(format!("供应商 {id} 缺少 base_url"));
            }
        }
        if provider
            .api_key
            .as_deref()
            .is_some_and(|key| key.contains(['\r', '\n']))
        {
            return Err(format!("供应商 {id} 的 API Key 不能包含换行"));
        }
        if provider.models.is_empty() {
            return Err(format!("供应商 {id} 至少需要一个模型"));
        }
        let mut ids = std::collections::HashSet::new();
        for model in &provider.models {
            if model.id.trim().is_empty() || !ids.insert(model.id.trim()) {
                return Err(format!("供应商 {id} 的模型 id 无效或重复"));
            }
        }
    }
    if let Some(provider) = config.active_provider.as_deref() {
        let Some(route) = config.providers.get(provider) else {
            return Err(format!("当前供应商 {provider} 不存在"));
        };
        if let Some(model) = config.active_model.as_deref() {
            if !route.models.iter().any(|item| item.id == model) {
                return Err(format!("当前模型 {model} 不属于供应商 {provider}"));
            }
        }
    } else if config.active_model.is_some() {
        return Err("设置了 active_model 但没有 active_provider".to_string());
    }
    Ok(())
}

fn parse_config(text: &str, path: &Path) -> Result<DshConfigFile, String> {
    let mut config: DshConfigFile =
        toml::from_str(text).map_err(|error| format!("无法解析 {}: {error}", path.display()))?;
    if config.version == 0 {
        config.version = CONFIG_VERSION;
    }
    Ok(config)
}

fn migrate_legacy() -> Result<DshConfigFile, String> {
    let home = dsh_home().ok_or_else(|| "找不到 dsh 配置目录".to_string())?;
    let settings_path = home.join("settings.yaml");
    let settings_text = fs::read_to_string(&settings_path)
        .map_err(|error| format!("无法读取旧 dsh 配置 {}: {error}", settings_path.display()))?;
    let settings: YamlValue = serde_yaml::from_str(&settings_text)
        .map_err(|error| format!("无法解析旧 dsh 配置 {}: {error}", settings_path.display()))?;
    let credentials = read_legacy_credentials(&home.join(".credentials.yaml"));
    let mut config = empty_config();

    let providers = yaml_path(&settings, &["llm-pi-ai", "providers"])
        .and_then(YamlValue::as_mapping)
        .ok_or_else(|| "旧 settings.yaml 里找不到 llm-pi-ai.providers".to_string())?;
    for (id_value, provider_value) in providers {
        let Some(id) = id_value.as_str() else {
            continue;
        };
        let Some(mapping) = provider_value.as_mapping() else {
            continue;
        };
        let models = yaml_models(mapping);
        if models.is_empty() {
            continue;
        }
        let api_key_env = yaml_string(mapping, "apiKeyEnv");
        let api_key = api_key_env
            .as_deref()
            .and_then(|name| credentials.get(name).cloned());
        config.providers.insert(
            id.to_string(),
            DshConfigProvider {
                display_name: yaml_string(mapping, "displayName"),
                api: yaml_string(mapping, "api").unwrap_or_else(|| "openai-responses".to_string()),
                base_url: yaml_string(mapping, "baseURL").unwrap_or_default(),
                api_key,
                models,
            },
        );
    }

    if let Some(route) =
        yaml_path(&settings, &["agent-default-model"]).and_then(YamlValue::as_mapping)
    {
        config.active_provider = yaml_string(route, "provider");
        config.active_model = yaml_string(route, "model");
    }
    if config.active_provider.is_none() {
        if let Some((provider, model)) = first_route(&config) {
            config.active_provider = Some(provider);
            config.active_model = Some(model);
        }
    }
    Ok(config)
}

fn read_legacy_credentials(path: &Path) -> BTreeMap<String, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_yaml::from_str::<YamlValue>(&text) else {
        return BTreeMap::new();
    };
    let section = value
        .get("refs")
        .and_then(YamlValue::as_mapping)
        .or_else(|| value.as_mapping());
    section
        .into_iter()
        .flat_map(|mapping| mapping.iter())
        .filter_map(|(key, value)| Some((key.as_str()?.to_string(), value.as_str()?.to_string())))
        .collect()
}

fn yaml_path<'a>(value: &'a YamlValue, path: &[&str]) -> Option<&'a YamlValue> {
    let mut current = value;
    for key in path {
        current = current
            .as_mapping()?
            .get(YamlValue::String((*key).to_string()))?;
    }
    Some(current)
}

fn yaml_string(mapping: &serde_yaml::Mapping, key: &str) -> Option<String> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn yaml_models(mapping: &serde_yaml::Mapping) -> Vec<DshConfigModel> {
    mapping
        .get(YamlValue::String("models".to_string()))
        .and_then(YamlValue::as_sequence)
        .into_iter()
        .flat_map(|items| items.iter())
        .filter_map(|item| {
            let map = item.as_mapping()?;
            let id = yaml_string(map, "id")?;
            Some(DshConfigModel {
                id,
                name: yaml_string(map, "name"),
                context_window: yaml_u64(map, "contextWindow"),
                max_tokens: yaml_u64(map, "maxTokens"),
                input: map
                    .get(YamlValue::String("input".to_string()))
                    .and_then(YamlValue::as_sequence)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(YamlValue::as_str)
                            .map(ToOwned::to_owned)
                            .collect::<Vec<_>>()
                    }),
            })
        })
        .collect()
}

fn yaml_u64(mapping: &serde_yaml::Mapping, key: &str) -> Option<u64> {
    mapping
        .get(YamlValue::String(key.to_string()))
        .and_then(YamlValue::as_u64)
}

fn first_route(config: &DshConfigFile) -> Option<(String, String)> {
    config.providers.iter().find_map(|(id, provider)| {
        provider
            .models
            .first()
            .map(|model| (id.clone(), model.id.clone()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    fn shared_env_lock() -> MutexGuard<'static, ()> {
        crate::dsh_profiles::tests::ENV_LOCK.lock().unwrap()
    }

    fn config_with_grok_key(api_key: &str) -> DshConfigFile {
        let mut config = empty_config();
        config.providers.insert(
            "grok".to_string(),
            DshConfigProvider {
                display_name: Some("Grok".to_string()),
                api: "openai-responses".to_string(),
                base_url: "https://example.test/v1".to_string(),
                api_key: Some(api_key.to_string()),
                models: vec![DshConfigModel {
                    id: "grok-1".to_string(),
                    name: None,
                    context_window: None,
                    max_tokens: None,
                    input: None,
                }],
            },
        );
        config.active_provider = Some("grok".to_string());
        config.active_model = Some("grok-1".to_string());
        config
    }

    #[test]
    fn internal_env_names_are_process_only_and_stable() {
        assert_eq!(internal_env_name("grok"), "SUPERHIGH_DSH_KEY_GROK");
        assert_eq!(
            internal_env_name("open-code.v2"),
            "SUPERHIGH_DSH_KEY_OPEN_CODE_V2"
        );
    }

    #[test]
    fn official_openai_codex_route_uses_oauth_without_api_fields() {
        let config: DshConfigFile = toml::from_str(
            "version = 1\nactive_provider = \"openai-codex\"\nactive_model = \"gpt-5.6-terra\"\n\n[providers.openai-codex]\n\n[[providers.openai-codex.models]]\nid = \"gpt-5.6-terra\"\n",
        )
        .unwrap();

        validate_config(&config).unwrap();
        assert!(runtime_environment(&config).is_empty());
    }

    #[test]
    fn non_oauth_provider_still_requires_api_fields() {
        let mut config = config_with_grok_key("secret");
        config.providers.get_mut("grok").unwrap().api.clear();

        assert_eq!(
            validate_config(&config).unwrap_err(),
            "供应商 grok 缺少 api"
        );
    }

    #[test]
    fn config_round_trips_direct_key_without_env_reference() {
        let _guard = shared_env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        let config = config_with_grok_key("secret");
        write_config(&config).unwrap();
        let text = fs::read_to_string(config_path().unwrap()).unwrap();
        assert!(text.contains("api_key = \"secret\""));
        assert!(!text.contains("apiKeyEnv"));
        assert_eq!(
            runtime_environment(&load_existing().unwrap().unwrap())[0].1,
            "secret"
        );
        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn load_or_migrate_repairs_an_active_model_missing_from_its_provider() {
        let _guard = shared_env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        fs::write(
            dir.path().join("config.toml"),
            "version = 1\nactive_provider = \"yaoheqi\"\nactive_model = \"gpt-5.6-sol\"\n\n[providers.yaoheqi]\napi = \"openai-responses\"\nbase_url = \"https://example.test/v1\"\n\n[[providers.yaoheqi.models]]\nid = \"gpt-5.6-terra\"\n",
        )
        .unwrap();

        let config = load_or_migrate().unwrap();

        assert!(config.providers["yaoheqi"]
            .models
            .iter()
            .any(|model| model.id == "gpt-5.6-sol"));
        assert!(fs::read_to_string(dir.path().join("config.toml"))
            .unwrap()
            .contains("id = \"gpt-5.6-sol\""));
        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn write_config_replaces_existing_toml() {
        let _guard = shared_env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        let mut config = config_with_grok_key("first-secret");
        write_config(&config).unwrap();
        config.providers.get_mut("grok").unwrap().api_key = Some("second-secret".to_string());
        write_config(&config).unwrap();

        let text = fs::read_to_string(config_path().unwrap()).unwrap();
        assert!(text.contains("api_key = \"second-secret\""));
        assert!(!text.contains("first-secret"));

        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn invalid_legacy_settings_does_not_create_an_empty_config() {
        let _guard = shared_env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        let invalid = "llm-pi-ai: [\n";
        fs::write(dir.path().join("settings.yaml"), invalid).unwrap();

        assert!(load_or_migrate().is_err());
        assert!(!config_path().unwrap().exists());
        assert_eq!(
            fs::read_to_string(dir.path().join("settings.yaml")).unwrap(),
            invalid
        );

        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn migrates_legacy_settings_and_credentials_once() {
        let _guard = shared_env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        fs::write(
            dir.path().join("settings.yaml"),
            "llm-pi-ai:\n  providers:\n    old-grok:\n      displayName: Old Grok\n      apiKeyEnv: GROK_API_KEY\n      api: openai-responses\n      baseURL: https://old.example/v1\n      models:\n        - id: old-1\nagent-default-model:\n  provider: old-grok\n  model: old-1\n",
        )
        .unwrap();
        fs::write(
            dir.path().join(".credentials.yaml"),
            "version: 1\nrefs:\n  GROK_API_KEY: migrated-secret\n",
        )
        .unwrap();

        let config = load_or_migrate().unwrap();
        assert_eq!(config.active_provider.as_deref(), Some("old-grok"));
        assert_eq!(
            api_key(&config, "old-grok").as_deref(),
            Some("migrated-secret")
        );
        assert!(config_path().unwrap().is_file());
        assert_eq!(
            runtime_environment(&config)[0].0,
            "SUPERHIGH_DSH_KEY_OLD_GROK"
        );

        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }
}
