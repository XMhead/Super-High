//! DSH provider editor backed by `~/.dsh/config.toml`.
//!
//! The native dsh profile still consumes `settings.yaml` and (in the pinned
//! dsh-tui profile) requires an `apiKeyEnv` field. This module treats that
//! file as a generated compatibility view.  User edits go to config.toml;
//! `apiKeyEnv` values are internal names and their values are supplied only
//! to the DSH child process by the terminal launcher.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_yaml::{Mapping, Value};

use crate::{
    dsh_config::{self, DshConfigFile, DshConfigModel, DshConfigProvider},
    dsh_profiles::{self, DshProfileInfo, DshProviderInfo},
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshProviderInput {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Accepted for old frontends, deliberately ignored.  Keys now live in
    /// config.toml and never use a user-selected environment variable name.
    #[serde(default)]
    #[allow(dead_code)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub api: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub models: Vec<DshModelInput>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshModelInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub input: Option<Vec<String>>,
    #[serde(default)]
    #[allow(dead_code)]
    pub reasoning_efforts: Option<Value>,
}

/// Migrate (if necessary), write the native compatibility settings and return
/// the process-only key environment for a new DSH child.
pub fn prepare_runtime() -> Result<Vec<(String, String)>, String> {
    let _lock = dsh_config::edit_lock();
    let config = dsh_config::load_or_migrate()?;
    sync_native_files(&config)?;
    Ok(dsh_config::runtime_environment(&config))
}

/// The command surface uses this before listing so a first open transparently
/// migrates old settings/.credentials files to config.toml.
pub fn ensure_runtime() -> Result<(), String> {
    let _lock = dsh_config::edit_lock();
    let config = dsh_config::load_or_migrate()?;
    sync_native_files(&config)?;
    Ok(())
}

pub fn add_dsh_provider(input: DshProviderInput) -> Result<Vec<DshProviderInfo>, String> {
    let _lock = dsh_config::edit_lock();
    let mut config = dsh_config::load_or_migrate()?;
    let provider = normalize_provider_input(input, None)?;
    if config.providers.contains_key(&provider.0) {
        return Err(format!("dsh 供应商 {} 已存在", provider.0));
    }
    let (id, provider) = provider;
    config.providers.insert(id.clone(), provider);
    choose_active_route(&mut config, &id);
    dsh_config::write_config(&config)?;
    sync_native_files(&config)?;
    Ok(dsh_profiles::list_dsh_providers())
}

pub fn update_dsh_provider(
    original_id: &str,
    input: DshProviderInput,
) -> Result<Vec<DshProviderInfo>, String> {
    let _lock = dsh_config::edit_lock();
    dsh_config::validate_provider_id(original_id)?;
    let mut config = dsh_config::load_or_migrate()?;
    let previous = config
        .providers
        .get(original_id)
        .cloned()
        .ok_or_else(|| format!("dsh 供应商 {original_id} 不存在"))?;
    let (id, mut provider) = normalize_provider_input(input, Some(&previous))?;
    if id != original_id && config.providers.contains_key(&id) {
        return Err(format!("dsh 供应商 {id} 已存在"));
    }
    if provider.api_key.is_none() {
        provider.api_key = previous.api_key;
    }
    config.providers.remove(original_id);
    config.providers.insert(id.clone(), provider);
    if config.active_provider.as_deref() == Some(original_id) {
        config.active_provider = Some(id);
    }
    dsh_config::write_config(&config)?;
    sync_native_files(&config)?;
    Ok(dsh_profiles::list_dsh_providers())
}

pub fn delete_dsh_provider(provider_id: &str) -> Result<Vec<DshProviderInfo>, String> {
    let _lock = dsh_config::edit_lock();
    dsh_config::validate_provider_id(provider_id)?;
    let mut config = dsh_config::load_or_migrate()?;
    if !config.providers.contains_key(provider_id) {
        return Err(format!("dsh 供应商 {provider_id} 不存在"));
    }
    if config.active_provider.as_deref() == Some(provider_id) {
        return Err("该供应商是当前 DSH 路由，请先切换到其它供应商再删除".to_string());
    }
    if let Some(profile) = dsh_profiles::list_dsh_profiles()
        .into_iter()
        .find(|profile| profile.provider == provider_id)
    {
        return Err(format!(
            "分组 {} 仍使用该供应商，请先切换该分组路由再删除",
            profile.name
        ));
    }
    config.providers.remove(provider_id);
    if config.providers.is_empty() {
        config.active_provider = None;
        config.active_model = None;
    } else if config.active_provider.is_none() {
        choose_first_route(&mut config);
    }
    dsh_config::write_config(&config)?;
    sync_native_files(&config)?;
    Ok(dsh_profiles::list_dsh_providers())
}

pub fn set_dsh_default_model(provider_id: &str, model_id: &str) -> Result<(), String> {
    let _lock = dsh_config::edit_lock();
    dsh_config::validate_provider_id(provider_id)?;
    let model_id = model_id.trim();
    if model_id.is_empty() || model_id.contains(['\r', '\n']) {
        return Err("模型 id 无效".to_string());
    }
    let mut config = dsh_config::load_or_migrate()?;
    let provider = config
        .providers
        .get_mut(provider_id)
        .ok_or_else(|| format!("dsh 供应商 {provider_id} 不存在"))?;
    if !provider.models.iter().any(|model| model.id == model_id) {
        provider.models.push(DshConfigModel {
            id: model_id.to_string(),
            name: None,
            context_window: None,
            max_tokens: None,
            input: None,
        });
    }
    config.active_provider = Some(provider_id.to_string());
    config.active_model = Some(model_id.to_string());
    dsh_config::write_config(&config)?;
    sync_native_files(&config)
}

pub fn delete_dsh_profile(profile_id: &str) -> Result<Vec<DshProfileInfo>, String> {
    let _lock = dsh_config::edit_lock();
    validate_profile_id(profile_id)?;
    if matches!(profile_id, "dsh-tui" | "default") {
        return Err(format!("{profile_id} 是 SuperHigh 的保留分组，不能删除"));
    }
    let home = dsh_home()?;
    let path = home.join("profiles").join(profile_id);
    if !path.is_dir() {
        return Err(format!("分组 {profile_id} 不存在"));
    }
    fs::remove_dir_all(&path)
        .map_err(|error| format!("无法删除分组 {profile_id}（{}）：{error}", path.display()))?;
    Ok(dsh_profiles::list_dsh_profiles())
}

fn normalize_provider_input(
    input: DshProviderInput,
    previous: Option<&DshConfigProvider>,
) -> Result<(String, DshConfigProvider), String> {
    let id = input.id.trim().to_string();
    dsh_config::validate_provider_id(&id)?;
    let display_name = clean_optional(input.display_name, "显示名")?;
    let api = clean_optional(input.api, "API 格式")?
        .or_else(|| previous.map(|provider| provider.api.clone()))
        .unwrap_or_else(|| "openai-responses".to_string());
    let base_url = clean_optional(input.base_url, "接口地址")?
        .or_else(|| previous.map(|provider| provider.base_url.clone()))
        .unwrap_or_default();
    if base_url.is_empty() {
        return Err("接口地址（base_url）不能为空".to_string());
    }
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for model in input.models {
        let model_id = model.id.trim().to_string();
        if model_id.is_empty() || !seen.insert(model_id.clone()) {
            return Err("模型 id 不能为空且不能重复".to_string());
        }
        if model_id.contains(['\r', '\n']) {
            return Err("模型 id 不能包含换行".to_string());
        }
        models.push(DshConfigModel {
            id: model_id,
            name: clean_optional(model.name, "模型名")?,
            context_window: model.context_window,
            max_tokens: model.max_tokens,
            input: model.input,
        });
    }
    if models.is_empty() {
        if let Some(previous) = previous {
            models = previous.models.clone();
        }
    }
    if models.is_empty() {
        return Err("至少添加一个模型".to_string());
    }
    let api_key = clean_optional(input.api_key, "API Key")?;
    Ok((
        id,
        DshConfigProvider {
            display_name,
            api,
            base_url,
            api_key,
            models,
        },
    ))
}

fn clean_optional(value: Option<String>, label: &str) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    if value.contains(['\r', '\n']) {
        return Err(format!("{label}不能包含换行"));
    }
    Ok(Some(value))
}

fn choose_active_route(config: &mut DshConfigFile, provider_id: &str) {
    if config.active_provider.is_none() {
        config.active_provider = Some(provider_id.to_string());
        config.active_model = config
            .providers
            .get(provider_id)
            .and_then(|provider| provider.models.first())
            .map(|model| model.id.clone());
    }
}

fn choose_first_route(config: &mut DshConfigFile) {
    if let Some((id, provider)) = config.providers.iter().next() {
        config.active_provider = Some(id.clone());
        config.active_model = provider.models.first().map(|model| model.id.clone());
    }
}

fn dsh_home() -> Result<PathBuf, String> {
    dsh_config::dsh_home().ok_or_else(|| "找不到 dsh 配置目录（$DSH_HOME 或 ~/.dsh）".to_string())
}

fn validate_profile_id(value: &str) -> Result<(), String> {
    if value.is_empty() || value == "." || value == ".." || value.contains(['/', '\\']) {
        return Err("无效的分组 id".to_string());
    }
    Ok(())
}

// ---- Native settings bridge -------------------------------------------------

fn sync_native_files(config: &DshConfigFile) -> Result<(), String> {
    let home = dsh_home()?;
    let settings_path = home.join("settings.yaml");
    let original = match fs::read_to_string(&settings_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => minimal_settings(config),
        Err(error) => return Err(format!("无法读取 {}: {error}", settings_path.display())),
    };
    let updated = sync_provider_blocks(&original, config).map_err(|error| {
        format!(
            "无法同步 {}，已保留原文件: {error}",
            settings_path.display()
        )
    })?;
    let updated = sync_default_route(&updated, config)?;
    write_text_if_changed(&settings_path, &updated)?;
    sync_dsh_tui_patch(&home, config)?;
    Ok(())
}

fn minimal_settings(config: &DshConfigFile) -> String {
    let (provider, model) =
        active_route(config).unwrap_or_else(|| ("".to_string(), "".to_string()));
    let mut root = Mapping::new();
    let mut provider_map = Mapping::new();
    for (id, item) in &config.providers {
        provider_map.insert(Value::String(id.clone()), provider_value(None, id, item));
    }
    let mut llm = Mapping::new();
    llm.insert(
        Value::String("providers".to_string()),
        Value::Mapping(provider_map),
    );
    root.insert(Value::String("llm-pi-ai".to_string()), Value::Mapping(llm));
    let mut route = Mapping::new();
    route.insert(
        Value::String("provider".to_string()),
        Value::String(provider),
    );
    route.insert(Value::String("model".to_string()), Value::String(model));
    root.insert(
        Value::String("agent-default-model".to_string()),
        Value::Mapping(route),
    );
    serde_yaml::to_string(&Value::Mapping(root))
        .unwrap_or_else(|_| "llm-pi-ai:\n  providers: {}\n".to_string())
}

fn sync_provider_blocks(text: &str, config: &DshConfigFile) -> Result<String, String> {
    let mut result = text.to_string();
    // The compatibility file must not expose routes which were deleted from
    // config.toml; otherwise dsh's model picker would keep stale providers.
    let mut lines = split_lines(&result);
    for id in provider_ids(&lines) {
        if !config.providers.contains_key(&id) {
            remove_provider_block(&mut lines, &id);
        }
    }
    result = lines.concat();

    for (id, provider) in &config.providers {
        let parsed = serde_yaml::from_str::<Value>(&result).unwrap_or(Value::Null);
        let existing = parsed
            .get("llm-pi-ai")
            .and_then(|value| value.get("providers"))
            .and_then(Value::as_mapping)
            .and_then(|mapping| mapping.get(Value::String(id.clone())));
        let value = provider_value(existing, id, provider);
        result = replace_or_insert_provider(&result, id, &value)?;
    }
    Ok(result)
}

fn provider_ids(lines: &[String]) -> Vec<String> {
    let Some((start, end, parent_indent)) = mapping_block(lines, &["llm-pi-ai", "providers"])
    else {
        return Vec::new();
    };
    let Some(child_indent) = lines
        .iter()
        .skip(start + 1)
        .take(end.saturating_sub(start + 1))
        .filter_map(|line| parse_mapping_line(line))
        .find(|entry| entry.indent > parent_indent)
        .map(|entry| entry.indent)
    else {
        return Vec::new();
    };
    lines
        .iter()
        .skip(start + 1)
        .take(end.saturating_sub(start + 1))
        .filter_map(|line| parse_mapping_line(line))
        .filter(|entry| entry.indent == child_indent)
        .map(|entry| entry.key)
        .collect()
}

fn remove_provider_block(lines: &mut Vec<String>, id: &str) {
    if let Some((start, end, _)) = provider_bounds(lines, id) {
        lines.drain(start..end);
    }
}

fn provider_value(existing: Option<&Value>, id: &str, provider: &DshConfigProvider) -> Value {
    let mut mapping = existing
        .and_then(Value::as_mapping)
        .cloned()
        .unwrap_or_default();
    set_string(
        &mut mapping,
        "displayName",
        provider.display_name.as_deref(),
    );
    let api_key_env = provider
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .map(|_| dsh_config::internal_env_name(id));
    set_string(&mut mapping, "apiKeyEnv", api_key_env.as_deref());
    set_string(&mut mapping, "api", Some(&provider.api));
    set_string(&mut mapping, "baseURL", Some(&provider.base_url));

    let old_models = mapping
        .get(Value::String("models".to_string()))
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let models = provider
        .models
        .iter()
        .map(|model| {
            let old = old_models.iter().find(|entry| {
                entry
                    .as_mapping()
                    .and_then(|map| map.get(Value::String("id".to_string())))
                    .and_then(Value::as_str)
                    == Some(model.id.as_str())
            });
            let mut item = old.and_then(Value::as_mapping).cloned().unwrap_or_default();
            set_string(&mut item, "id", Some(&model.id));
            set_string(&mut item, "name", model.name.as_deref());
            set_unsigned(&mut item, "contextWindow", model.context_window);
            set_unsigned(&mut item, "maxTokens", model.max_tokens);
            if let Some(input) = &model.input {
                item.insert(
                    Value::String("input".to_string()),
                    Value::Sequence(input.iter().cloned().map(Value::String).collect()),
                );
            }
            Value::Mapping(item)
        })
        .collect::<Vec<_>>();
    mapping.insert(Value::String("models".to_string()), Value::Sequence(models));
    Value::Mapping(mapping)
}

fn set_string(mapping: &mut Mapping, key: &str, value: Option<&str>) {
    let key_value = Value::String(key.to_string());
    match value.filter(|value| !value.trim().is_empty()) {
        Some(value) => {
            mapping.insert(key_value, Value::String(value.to_string()));
        }
        None => {
            mapping.remove(&key_value);
        }
    }
}

fn set_unsigned(mapping: &mut Mapping, key: &str, value: Option<u64>) {
    let key_value = Value::String(key.to_string());
    match value {
        Some(value) => {
            mapping.insert(key_value, Value::Number(value.into()));
        }
        None => {
            mapping.remove(&key_value);
        }
    }
}

fn replace_or_insert_provider(text: &str, id: &str, value: &Value) -> Result<String, String> {
    let mut lines = split_lines(text);
    if let Some((start, end, indent)) = provider_bounds(&lines, id) {
        let rendered = render_provider(id, value, indent, preferred_newline(text))?;
        lines.splice(start..end, split_lines(&rendered));
        return Ok(lines.concat());
    }
    let Some((_, end, parent_indent)) = mapping_block(&lines, &["llm-pi-ai", "providers"]) else {
        return Err("settings.yaml 里找不到 llm-pi-ai.providers".to_string());
    };
    let child_indent = lines
        .iter()
        .skip(end.saturating_sub(1000))
        .take(1000)
        .filter_map(|line| parse_mapping_line(line))
        .find(|entry| entry.indent > parent_indent)
        .map(|entry| entry.indent)
        .unwrap_or(parent_indent + 2);
    let rendered = render_provider(id, value, child_indent, preferred_newline(text))?;
    lines.splice(end..end, split_lines(&rendered));
    Ok(lines.concat())
}

fn sync_default_route(text: &str, config: &DshConfigFile) -> Result<String, String> {
    let Some((provider, model)) = active_route(config) else {
        return Ok(text.to_string());
    };
    let mut lines = split_lines(text);
    let provider_index = find_scalar_path(&lines, &["agent-default-model", "provider"]);
    let model_index = find_scalar_path(&lines, &["agent-default-model", "model"]);
    if let (Some(provider_index), Some(model_index)) = (provider_index, model_index) {
        lines[provider_index] = replace_scalar(&lines[provider_index], &provider)?;
        lines[model_index] = replace_scalar(&lines[model_index], &model)?;
        return Ok(lines.concat());
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    if !lines.is_empty() {
        lines.push(preferred_newline(text).to_string());
    }
    lines.push(format!("agent-default-model:{}", preferred_newline(text)));
    lines.push(format!(
        "  provider: {}{}",
        provider,
        preferred_newline(text)
    ));
    lines.push(format!("  model: {}{}", model, preferred_newline(text)));
    Ok(lines.concat())
}

fn sync_dsh_tui_patch(home: &Path, config: &DshConfigFile) -> Result<(), String> {
    let Some((provider, model)) = active_route(config) else {
        return Ok(());
    };
    let path = home
        .join("profiles")
        .join("dsh-tui")
        .join("cordis.patch.yml");
    let original = fs::read_to_string(&path).unwrap_or_default();
    let newline = preferred_newline(&original);
    let mut lines = split_lines(&original);
    if let Some((start, end, indent)) = patch_entry_bounds(&lines, "dsh-tui") {
        let mut provider_line = None;
        let mut model_line = None;
        for index in start + 1..end {
            let parsed = parse_mapping_line(&lines[index]);
            if parsed.as_ref().is_some_and(|entry| entry.key == "provider") {
                provider_line = Some(index);
            }
            if parsed.as_ref().is_some_and(|entry| entry.key == "model") {
                model_line = Some(index);
            }
        }
        if let Some(index) = provider_line {
            lines[index] = replace_scalar(&lines[index], &provider)?;
        }
        if let Some(index) = model_line {
            lines[index] = replace_scalar(&lines[index], &model)?;
        }
        if provider_line.is_none() || model_line.is_none() {
            let insert_at = end;
            let config_indent = " ".repeat(indent + 4);
            let mut additions = Vec::new();
            if provider_line.is_none() {
                additions.push(format!("{config_indent}provider: {provider}{newline}"));
            }
            if model_line.is_none() {
                additions.push(format!("{config_indent}model: {model}{newline}"));
            }
            lines.splice(insert_at..insert_at, additions);
        }
    } else {
        while lines.last().is_some_and(|line| line.trim().is_empty()) {
            lines.pop();
        }
        if !lines.is_empty() {
            lines.push(newline.to_string());
        }
        lines.push(format!("- id: dsh-tui{newline}"));
        lines.push(format!("  config:{newline}"));
        lines.push(format!("    provider: {provider}{newline}"));
        lines.push(format!("    model: {model}{newline}"));
        lines.push(format!("    effort: max{newline}"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_text_if_changed(&path, &lines.concat())
}

fn active_route(config: &DshConfigFile) -> Option<(String, String)> {
    let provider = config.active_provider.as_ref()?;
    let model = config.active_model.clone().or_else(|| {
        config
            .providers
            .get(provider)?
            .models
            .first()
            .map(|model| model.id.clone())
    })?;
    Some((provider.clone(), model))
}

fn write_text_if_changed(path: &Path, text: &str) -> Result<(), String> {
    if fs::read_to_string(path).ok().as_deref() == Some(text) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, text).map_err(|error| format!("无法写入 {}: {error}", path.display()))
}

// ---- Small text-level YAML helpers -----------------------------------------

#[derive(Clone)]
struct MappingLine {
    indent: usize,
    key: String,
    is_block: bool,
}

fn split_lines(text: &str) -> Vec<String> {
    text.split_inclusive('\n').map(ToOwned::to_owned).collect()
}

fn preferred_newline(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn parse_mapping_line(line: &str) -> Option<MappingLine> {
    let content = line.trim_end_matches(['\r', '\n']);
    let trimmed = content.trim_start_matches(' ');
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    let indent = content.len() - trimmed.len();
    let colon = trimmed.find(':')?;
    let key = trimmed[..colon]
        .trim()
        .trim_matches(['"', '\''])
        .to_string();
    if key.is_empty() {
        return None;
    }
    let rest = trimmed[colon + 1..].trim();
    Some(MappingLine {
        indent,
        key,
        is_block: rest.is_empty() || rest.starts_with('#'),
    })
}

fn mapping_block(lines: &[String], path: &[&str]) -> Option<(usize, usize, usize)> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(parsed) = parse_mapping_line(line) else {
            continue;
        };
        while stack
            .last()
            .is_some_and(|(indent, _)| *indent >= parsed.indent)
        {
            stack.pop();
        }
        if stack.len() + 1 == path.len()
            && stack
                .iter()
                .zip(path.iter())
                .all(|((_, key), expected)| key == expected)
            && parsed.key == path[path.len() - 1]
            && parsed.is_block
        {
            let end = lines
                .iter()
                .enumerate()
                .skip(index + 1)
                .find(|(_, candidate)| {
                    parse_mapping_line(candidate).is_some_and(|next| next.indent <= parsed.indent)
                })
                .map(|(next, _)| next)
                .unwrap_or(lines.len());
            return Some((index, end, parsed.indent));
        }
        if parsed.is_block {
            stack.push((parsed.indent, parsed.key));
        }
    }
    None
}

fn provider_bounds(lines: &[String], id: &str) -> Option<(usize, usize, usize)> {
    let (start, end, parent_indent) = mapping_block(lines, &["llm-pi-ai", "providers"])?;
    let child_indent = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .take(end.saturating_sub(start + 1))
        .filter_map(|(_, line)| parse_mapping_line(line))
        .find(|entry| entry.indent > parent_indent)
        .map(|entry| entry.indent)?;
    for index in start + 1..end {
        let Some(parsed) = parse_mapping_line(&lines[index]) else {
            continue;
        };
        if parsed.indent != child_indent || parsed.key != id {
            continue;
        }
        let block_end = lines
            .iter()
            .enumerate()
            .skip(index + 1)
            .take(end.saturating_sub(index + 1))
            .find(|(_, line)| {
                parse_mapping_line(line).is_some_and(|next| next.indent <= child_indent)
            })
            .map(|(next, _)| next)
            .unwrap_or(end);
        return Some((index, block_end, child_indent));
    }
    None
}

fn render_provider(
    id: &str,
    value: &Value,
    indent: usize,
    newline: &str,
) -> Result<String, String> {
    if !value.is_mapping() {
        return Err("无效的 dsh 供应商配置".to_string());
    }
    let mut block = Mapping::new();
    block.insert(Value::String(id.to_string()), value.clone());
    let rendered =
        serde_yaml::to_string(&Value::Mapping(block)).map_err(|error| error.to_string())?;
    let rendered = rendered.strip_prefix("---\n").unwrap_or(&rendered);
    let mut output = String::new();
    for line in rendered.lines() {
        if line == "..." || line.trim().is_empty() {
            continue;
        }
        output.push_str(&" ".repeat(indent));
        output.push_str(line);
        output.push_str(newline);
    }
    Ok(output)
}

fn find_scalar_path(lines: &[String], path: &[&str]) -> Option<usize> {
    let mut stack: Vec<(usize, String)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(parsed) = parse_mapping_line(line) else {
            continue;
        };
        while stack
            .last()
            .is_some_and(|(indent, _)| *indent >= parsed.indent)
        {
            stack.pop();
        }
        if stack.len() + 1 == path.len()
            && stack
                .iter()
                .zip(path.iter())
                .all(|((_, key), expected)| key == expected)
            && parsed.key == path[path.len() - 1]
            && !parsed.is_block
        {
            return Some(index);
        }
        if parsed.is_block {
            stack.push((parsed.indent, parsed.key));
        }
    }
    None
}

fn replace_scalar(line: &str, value: &str) -> Result<String, String> {
    if value.contains(['\r', '\n']) {
        return Err("YAML 标量不能包含换行".to_string());
    }
    let ending = if line.ends_with("\r\n") {
        "\r\n"
    } else if line.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let content = line.trim_end_matches(['\r', '\n']);
    let colon = content
        .find(':')
        .ok_or_else(|| "无效的 YAML 字段".to_string())?;
    Ok(format!("{}: {}{}", &content[..colon], value, ending))
}

fn patch_entry_bounds(lines: &[String], id: &str) -> Option<(usize, usize, usize)> {
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        let Some(value) = trimmed.strip_prefix("- id:") else {
            continue;
        };
        if value
            .split('#')
            .next()
            .unwrap_or(value)
            .trim()
            .trim_matches(['"', '\''])
            != id
        {
            continue;
        }
        let indent = line.len() - trimmed.len();
        let end = lines
            .iter()
            .enumerate()
            .skip(index + 1)
            .find(|(_, candidate)| {
                let candidate_trimmed = candidate.trim_start();
                candidate_trimmed.starts_with("- id:")
                    && candidate.len() - candidate_trimmed.len() <= indent
            })
            .map(|(next, _)| next)
            .unwrap_or(lines.len());
        return Some((index, end, indent));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    fn env_lock() -> MutexGuard<'static, ()> {
        crate::dsh_profiles::tests::ENV_LOCK.lock().unwrap()
    }

    fn model(id: &str) -> DshModelInput {
        DshModelInput {
            id: id.to_string(),
            name: None,
            context_window: None,
            max_tokens: None,
            input: None,
            reasoning_efforts: None,
        }
    }

    #[test]
    fn provider_edit_writes_toml_and_internal_runtime_route() {
        let _guard = env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        fs::create_dir_all(dir.path().join("profiles/dsh-tui")).unwrap();
        fs::write(
            dir.path().join("settings.yaml"),
            "# Preserve this comment\n\nunrelated:\n  keep: yes\n\nllm-pi-ai:\n  # Keep this provider-list comment\n  providers:\n    legacy:\n      displayName: Legacy\n      apiKeyEnv: LEGACY_KEY\n      api: openai-responses\n      baseURL: https://legacy.example/v1\n      models:\n        - id: legacy-1\n\nagent-default-model:\n  # Keep this route comment\n  provider: legacy\n  model: legacy-1\n\nother-setting:\n  enabled: true\n",
        )
        .unwrap();
        fs::write(
            dir.path().join(".credentials.yaml"),
            "refs:\n  LEGACY_KEY: legacy-secret\n",
        )
        .unwrap();
        add_dsh_provider(DshProviderInput {
            id: "grok".to_string(),
            display_name: Some("Grok".to_string()),
            api_key_env: Some("SHOULD_BE_IGNORED".to_string()),
            api: Some("openai-responses".to_string()),
            base_url: Some("https://example.test/v1".to_string()),
            models: vec![model("grok-1")],
            api_key: Some("secret".to_string()),
        })
        .unwrap();
        set_dsh_default_model("grok", "grok-1").unwrap();
        let config = fs::read_to_string(dir.path().join("config.toml")).unwrap();
        let settings = fs::read_to_string(dir.path().join("settings.yaml")).unwrap();
        assert!(config.contains("api_key = \"secret\""));
        assert!(!config.contains("SHOULD_BE_IGNORED"));
        assert!(!config.contains("api_key_env"));
        assert!(settings.contains("apiKeyEnv: SUPERHIGH_DSH_KEY_GROK"));
        assert!(!settings.contains("SHOULD_BE_IGNORED"));
        assert!(!settings.contains("LEGACY_KEY"));
        assert!(settings.contains("# Preserve this comment"));
        assert!(settings.contains("# Keep this provider-list comment"));
        assert!(settings.contains("# Keep this route comment"));
        assert!(settings.contains("other-setting:\n  enabled: true"));
        let parsed: Value = serde_yaml::from_str(&settings).unwrap();
        let route = parsed.get("agent-default-model").unwrap();
        assert_eq!(route.get("provider").and_then(Value::as_str), Some("grok"));
        assert_eq!(route.get("model").and_then(Value::as_str), Some("grok-1"));
        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn official_openai_codex_runtime_keeps_oauth_only_provider() {
        let _guard = env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        fs::create_dir_all(dir.path().join("profiles/dsh-tui")).unwrap();
        fs::write(
            dir.path().join("config.toml"),
            "version = 1\nactive_provider = \"openai-codex\"\nactive_model = \"gpt-5.6-terra\"\n\n[providers.openai-codex]\ndisplay_name = \"OpenAI Codex (Official Login)\"\n\n[[providers.openai-codex.models]]\nid = \"gpt-5.6-terra\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("settings.yaml"),
            "llm-pi-ai:\n  providers:\n    openai-codex:\n      displayName: OpenAI Codex (Official Login)\n      apiKeyEnv: STALE_KEY\n      transport: sse\nagent-default-model:\n  provider: openai-codex\n  model: gpt-5.6-terra\n",
        )
        .unwrap();

        assert!(prepare_runtime().unwrap().is_empty());

        let settings = fs::read_to_string(dir.path().join("settings.yaml")).unwrap();
        assert!(settings.contains("transport: sse"));
        assert!(!settings.contains("apiKeyEnv"));
        assert!(!settings.contains("baseURL"));
        assert!(!settings.contains("api:"));
        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn setting_a_fetched_model_adds_it_to_the_provider_configuration() {
        let _guard = env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        let mut config = dsh_config::empty_config();
        config.providers.insert(
            "yaoheqi".to_string(),
            DshConfigProvider {
                display_name: Some("Yaoheqi".to_string()),
                api: "openai-responses".to_string(),
                base_url: "https://example.test/v1".to_string(),
                api_key: Some("secret".to_string()),
                models: vec![DshConfigModel {
                    id: "gpt-5.6-terra".to_string(),
                    name: None,
                    context_window: None,
                    max_tokens: None,
                    input: None,
                }],
            },
        );
        config.active_provider = Some("yaoheqi".to_string());
        config.active_model = Some("gpt-5.6-terra".to_string());
        dsh_config::write_config(&config).unwrap();

        set_dsh_default_model("yaoheqi", "gpt-5.6-sol").unwrap();

        let saved = dsh_config::load_existing().unwrap().unwrap();
        assert_eq!(saved.active_model.as_deref(), Some("gpt-5.6-sol"));
        assert!(saved.providers["yaoheqi"]
            .models
            .iter()
            .any(|model| model.id == "gpt-5.6-sol"));
        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }

    #[test]
    fn invalid_existing_settings_is_not_replaced_by_minimal_config() {
        let _guard = env_lock();
        let dir = tempfile::tempdir().unwrap();
        let previous = std::env::var_os("DSH_HOME");
        std::env::set_var("DSH_HOME", dir.path());
        let mut config = dsh_config::empty_config();
        config.providers.insert(
            "grok".to_string(),
            DshConfigProvider {
                display_name: Some("Grok".to_string()),
                api: "openai-responses".to_string(),
                base_url: "https://example.test/v1".to_string(),
                api_key: Some("secret".to_string()),
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
        dsh_config::write_config(&config).unwrap();
        let invalid = "llm-pi-ai: [\n";
        fs::write(dir.path().join("settings.yaml"), invalid).unwrap();

        let error = ensure_runtime().unwrap_err();
        assert!(error.contains("已保留原文件"));
        assert_eq!(
            fs::read_to_string(dir.path().join("settings.yaml")).unwrap(),
            invalid
        );

        match previous {
            Some(value) => std::env::set_var("DSH_HOME", value),
            None => std::env::remove_var("DSH_HOME"),
        }
    }
}
