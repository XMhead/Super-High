use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

use anyhow::Context;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::fs_ops::{normalize_path, read_image_as_data_url};

pub const ITEM_LIBRARY_DEFAULT_PAGE_SIZE: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemLibrarySource {
    Ni,
    Mm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLibrarySearchResponse {
    pub source: String,
    pub library_root_path: String,
    pub items: Vec<ItemLibraryItem>,
    #[serde(default)]
    pub total_items: usize,
    #[serde(default)]
    pub page: usize,
    #[serde(default)]
    pub page_size: usize,
    #[serde(default)]
    pub ignored_path_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignore_config_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLibraryKeyResponse {
    pub source: String,
    pub library_root_path: String,
    pub item_keys: Vec<String>,
}

#[derive(Debug, Clone)]
struct ItemLibraryIndexEntry {
    source: String,
    item_key: String,
    display_name: Option<String>,
    material_or_id: Option<String>,
    file_path: PathBuf,
    relative_path: String,
    line_number: usize,
    start_line: usize,
    end_line: usize,
    library_root_path: String,
}

#[derive(Debug, Clone)]
struct ItemLibraryIndex {
    fingerprint: String,
    entries: Vec<ItemLibraryIndexEntry>,
    ignored_path_count: usize,
    ignore_config_path: Option<String>,
}

static ITEM_LIBRARY_INDEXES: Lazy<Mutex<HashMap<String, ItemLibraryIndex>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLibraryItem {
    pub source: String,
    pub item_key: String,
    pub display_name: Option<String>,
    pub material_or_id: Option<String>,
    pub file_path: String,
    pub relative_path: String,
    pub line_number: usize,
    pub yaml_block: String,
    pub library_root_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dragon_core_icon: Option<DragonCoreItemIcon>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dragon_core_effect: Option<DragonCoreItemEffect>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dragon_core_font_images: Vec<DragonCoreFontImage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragonCoreItemIcon {
    pub data_url: String,
    pub texture: String,
    pub image_path: String,
    pub config_path: String,
    pub relative_config_path: String,
    pub line_number: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragonCoreItemEffect {
    pub data_url: String,
    pub texture: String,
    pub image_path: String,
    pub config_path: String,
    pub relative_config_path: String,
    pub line_number: usize,
    pub match_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragonCoreFontImage {
    pub character: String,
    pub data_url: String,
    pub path: String,
    pub image_path: String,
    pub config_path: String,
    pub relative_config_path: String,
    pub line_number: usize,
    pub width: f64,
    pub height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_offset: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_width: Option<f64>,
}

impl ItemLibrarySource {
    fn as_str(self) -> &'static str {
        match self {
            ItemLibrarySource::Ni => "ni",
            ItemLibrarySource::Mm => "mm",
        }
    }

    fn library_root(self, plugins_root: &Path) -> PathBuf {
        match self {
            ItemLibrarySource::Ni => plugins_root.join("NeigeItems").join("Items"),
            ItemLibrarySource::Mm => plugins_root.join("MythicMobs").join("Items"),
        }
    }

    pub(crate) fn workspace_library_root(self, workspace: &Path) -> Option<PathBuf> {
        let plugin_name = match self {
            ItemLibrarySource::Ni => "NeigeItems",
            ItemLibrarySource::Mm => "MythicMobs",
        };
        let mut candidates = vec![
            self.library_root(workspace),
            self.library_root(&workspace.join("plugins")),
        ];
        if workspace.file_name().and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(plugin_name))
        {
            candidates.push(workspace.join("Items"));
        }
        let workspace = workspace.canonicalize().ok()?;
        candidates.into_iter().find(|candidate| {
            candidate.is_dir()
                && candidate.canonicalize().is_ok_and(|path| path.starts_with(&workspace))
        })
    }

    fn display_fields(self) -> &'static [&'static str] {
        match self {
            ItemLibrarySource::Ni => &["name"],
            ItemLibrarySource::Mm => &["Display"],
        }
    }

    fn material_fields(self) -> &'static [&'static str] {
        match self {
            ItemLibrarySource::Ni => &["material"],
            ItemLibrarySource::Mm => &["Id"],
        }
    }
}

pub fn search_item_library_page_with_icons(
    project_path: &Path,
    source: ItemLibrarySource,
    query: &str,
    expanded_query: Option<&str>,
    dragon_core_client_root: Option<&Path>,
    page: usize,
    page_size: usize,
    force_refresh: bool,
) -> anyhow::Result<ItemLibrarySearchResponse> {
    search_item_library_with_icons_page(
        project_path,
        source,
        query,
        expanded_query,
        dragon_core_client_root,
        page,
        page_size,
        force_refresh,
    )
}

pub fn item_library_keys(
    project_path: &Path,
    source: ItemLibrarySource,
) -> anyhow::Result<ItemLibraryKeyResponse> {
    let (library_root, ignore) =
        resolve_item_library_root(project_path, source)?;
    let index = item_library_index(&library_root, project_path, source, ignore, false)?;
    let mut item_keys = index
        .entries
        .iter()
        .map(|entry| entry.item_key.clone())
        .collect::<Vec<_>>();
    item_keys.sort_by_cached_key(|key| normalize_search_text(key));
    Ok(ItemLibraryKeyResponse {
        source: source.as_str().to_string(),
        library_root_path: normalize_path(&library_root),
        item_keys,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLibraryTextEntry {
    pub source: String,
    pub item_key: String,
    pub display_name: Option<String>,
    pub material_or_id: Option<String>,
    pub file_path: String,
    pub relative_path: String,
    pub line_number: usize,
}

/// Project-local index query without loading YAML blocks or image metadata.
pub fn query_item_library_text(
    project_path: &Path,
    source: ItemLibrarySource,
    query: &str,
    offset: usize,
    limit: usize,
) -> anyhow::Result<(usize, Vec<ItemLibraryTextEntry>)> {
    let root = source.workspace_library_root(project_path).ok_or_else(|| {
        anyhow::anyhow!("未找到物品库目录：{}", normalize_path(&source.library_root(project_path)))
    })?;
    let ignore = read_item_library_ignore(project_path, source);
    let index = item_library_index(&root, project_path, source, ignore, false)?;
    let needles = search_needles(query, None);
    let matches = index
        .entries
        .iter()
        .filter(|entry| {
            needles.is_empty()
                || needles.iter().any(|needle| {
                    searchable_text(&entry.item_key, entry.display_name.as_deref()).contains(needle)
                })
        })
        .collect::<Vec<_>>();
    let total = matches.len();
    let entries = matches
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|entry| ItemLibraryTextEntry {
            source: entry.source.clone(),
            item_key: entry.item_key.clone(),
            display_name: entry.display_name.clone(),
            material_or_id: entry.material_or_id.clone(),
            file_path: normalize_path(&entry.file_path),
            relative_path: entry.relative_path.clone(),
            line_number: entry.line_number,
        })
        .collect();
    Ok((total, entries))
}

#[cfg(test)]
pub fn search_item_library(
    project_path: &Path,
    source: ItemLibrarySource,
    query: &str,
    expanded_query: Option<&str>,
) -> anyhow::Result<ItemLibrarySearchResponse> {
    search_item_library_with_icons_page(
        project_path,
        source,
        query,
        expanded_query,
        None,
        1,
        usize::MAX,
        true,
    )
}

pub fn search_item_library_with_icons_page(
    project_path: &Path,
    source: ItemLibrarySource,
    query: &str,
    expanded_query: Option<&str>,
    dragon_core_client_root: Option<&Path>,
    page: usize,
    page_size: usize,
    force_refresh: bool,
) -> anyhow::Result<ItemLibrarySearchResponse> {
    let (library_root, ignore) =
        resolve_item_library_root(project_path, source)?;
    let index = item_library_index(&library_root, project_path, source, ignore, force_refresh)?;
    let needles = search_needles(query, expanded_query);
    let matching_entries = index
        .entries
        .iter()
        .filter(|entry| {
            needles.is_empty()
                || needles.iter().any(|needle| {
                    searchable_text(&entry.item_key, entry.display_name.as_deref()).contains(needle)
                })
        })
        .collect::<Vec<_>>();
    let total_items = matching_entries.len();
    let page_size = page_size.clamp(1, ITEM_LIBRARY_DEFAULT_PAGE_SIZE);
    let page = page.max(1);
    let start = page
        .saturating_sub(1)
        .saturating_mul(page_size)
        .min(total_items);
    let end = start.saturating_add(page_size).min(total_items);
    let mut file_contents = HashMap::new();
    let mut items = matching_entries[start..end]
        .iter()
        .map(|entry| item_from_index_entry(entry, &mut file_contents))
        .collect::<anyhow::Result<Vec<_>>>()?;
    apply_dragon_core_metadata(
        &mut items,
        project_path,
        dragon_core_client_root,
        force_refresh,
    );
    Ok(ItemLibrarySearchResponse {
        source: source.as_str().to_string(),
        library_root_path: normalize_path(&library_root),
        items,
        total_items,
        page,
        page_size,
        ignored_path_count: index.ignored_path_count,
        ignore_config_path: index.ignore_config_path,
    })
}

#[cfg(test)]
pub fn search_item_library_with_icons(
    project_path: &Path,
    source: ItemLibrarySource,
    query: &str,
    expanded_query: Option<&str>,
    dragon_core_client_root: Option<&Path>,
) -> anyhow::Result<ItemLibrarySearchResponse> {
    search_item_library_with_icons_page(
        project_path,
        source,
        query,
        expanded_query,
        dragon_core_client_root,
        1,
        ITEM_LIBRARY_DEFAULT_PAGE_SIZE,
        true,
    )
}

fn resolve_item_library_root(
    project_path: &Path,
    source: ItemLibrarySource,
) -> anyhow::Result<(PathBuf, ItemLibraryIgnore)> {
    let library_root = source.workspace_library_root(project_path).ok_or_else(|| {
        anyhow::anyhow!(
            "未找到物品库目录：{}（仅检查当前工作区）",
            normalize_path(&source.library_root(project_path))
        )
    })?;
    Ok((
        library_root,
        load_item_library_ignore(project_path, source),
    ))
}

fn item_library_index(
    library_root: &Path,
    project_path: &Path,
    source: ItemLibrarySource,
    ignore: ItemLibraryIgnore,
    force_refresh: bool,
) -> anyhow::Result<ItemLibraryIndex> {
    let cache_key = format!(
        "{}|{}|{}",
        normalize_path(library_root).to_ascii_lowercase(),
        source.as_str(),
        normalize_path(project_path).to_ascii_lowercase(),
    );
    if !force_refresh {
        if let Some(index) = ITEM_LIBRARY_INDEXES
            .lock()
            .expect("item library index lock poisoned")
            .get(&cache_key)
            .cloned()
        {
            return Ok(index);
        }
    }
    let snapshot = item_library_snapshot(library_root, &ignore)?;
    if let Some(index) = ITEM_LIBRARY_INDEXES
        .lock()
        .expect("item library index lock poisoned")
        .get(&cache_key)
        .filter(|index| index.fingerprint == snapshot.fingerprint)
        .cloned()
    {
        return Ok(index);
    }

    let mut entries = Vec::new();
    let mut ignored_path_count = 0usize;
    for file_path in snapshot.files {
        let relative_path = file_path
            .strip_prefix(library_root)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .replace('\\', "/");
        if ignore.should_ignore(&relative_path) {
            ignored_path_count += 1;
            continue;
        }
        let content = read_lossy(&file_path)
            .with_context(|| format!("failed to read item library file {}", file_path.display()))?;
        entries.extend(scan_item_file_index(
            source,
            library_root,
            &file_path,
            &content,
        ));
    }
    entries.sort_by(|left, right| {
        left.file_path
            .cmp(&right.file_path)
            .then(left.line_number.cmp(&right.line_number))
    });
    let index = ItemLibraryIndex {
        fingerprint: snapshot.fingerprint,
        entries,
        ignored_path_count,
        ignore_config_path: ignore.config_path,
    };
    ITEM_LIBRARY_INDEXES
        .lock()
        .expect("item library index lock poisoned")
        .insert(cache_key, index.clone());
    Ok(index)
}

struct ItemLibrarySnapshot {
    files: Vec<PathBuf>,
    fingerprint: String,
}

fn item_library_snapshot(
    library_root: &Path,
    ignore: &ItemLibraryIgnore,
) -> anyhow::Result<ItemLibrarySnapshot> {
    let files = yaml_files(library_root);
    let mut fingerprint = String::new();
    for file_path in &files {
        let metadata = fs::metadata(file_path)?;
        let modified = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        fingerprint.push_str(&normalize_path(file_path));
        fingerprint.push(':');
        fingerprint.push_str(&metadata.len().to_string());
        fingerprint.push(':');
        fingerprint.push_str(&modified.to_string());
        fingerprint.push('\n');
    }
    fingerprint.push_str(&ignore.rules.join("\n"));
    Ok(ItemLibrarySnapshot { files, fingerprint })
}

fn scan_item_file_index(
    source: ItemLibrarySource,
    library_root: &Path,
    file_path: &Path,
    content: &str,
) -> Vec<ItemLibraryIndexEntry> {
    let lines = content.lines().collect::<Vec<_>>();
    let starts = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| top_level_key(line).map(|key| (index, key)))
        .collect::<Vec<_>>();
    let relative_path = file_path
        .strip_prefix(library_root)
        .unwrap_or(file_path)
        .to_string_lossy()
        .replace('\\', "/");
    starts
        .iter()
        .enumerate()
        .map(|(position, (start_line, item_key))| {
            let end_line = starts
                .get(position + 1)
                .map(|(line, _)| *line)
                .unwrap_or(lines.len());
            let block_lines = trim_trailing_empty_lines(&lines[*start_line..end_line]);
            ItemLibraryIndexEntry {
                source: source.as_str().to_string(),
                item_key: item_key.clone(),
                display_name: yaml_scalar_field(block_lines, source.display_fields()),
                material_or_id: yaml_scalar_field(block_lines, source.material_fields()),
                file_path: file_path.to_path_buf(),
                relative_path: relative_path.clone(),
                line_number: start_line + 1,
                start_line: *start_line,
                end_line,
                library_root_path: normalize_path(library_root),
            }
        })
        .collect()
}

fn item_from_index_entry(
    entry: &ItemLibraryIndexEntry,
    file_contents: &mut HashMap<PathBuf, String>,
) -> anyhow::Result<ItemLibraryItem> {
    if !file_contents.contains_key(&entry.file_path) {
        file_contents.insert(
            entry.file_path.clone(),
            read_lossy(&entry.file_path).with_context(|| {
                format!(
                    "failed to read item library file {}",
                    entry.file_path.display()
                )
            })?,
        );
    }
    let content = file_contents
        .get(&entry.file_path)
        .expect("item library file content was inserted");
    let lines = content.lines().collect::<Vec<_>>();
    let block_lines =
        trim_trailing_empty_lines(&lines[entry.start_line..entry.end_line.min(lines.len())]);
    Ok(ItemLibraryItem {
        source: entry.source.clone(),
        item_key: entry.item_key.clone(),
        display_name: entry.display_name.clone(),
        material_or_id: entry.material_or_id.clone(),
        file_path: normalize_path(&entry.file_path),
        relative_path: entry.relative_path.clone(),
        line_number: entry.line_number,
        yaml_block: block_lines.join("\n"),
        library_root_path: entry.library_root_path.clone(),
        dragon_core_icon: None,
        dragon_core_effect: None,
        dragon_core_font_images: Vec::new(),
    })
}

const ITEM_LIBRARY_IGNORE_FILE: &str = "item-library-ignore.yml";

#[derive(Debug, Clone, Default)]
struct ItemLibraryIgnore {
    rules: Vec<String>,
    config_path: Option<String>,
}

impl ItemLibraryIgnore {
    fn should_ignore(&self, relative_path: &str) -> bool {
        let relative = normalize_relative_item_path(relative_path);
        if relative.is_empty() {
            return false;
        }
        self.rules
            .iter()
            .any(|rule| relative_path_matches_ignore_rule(&relative, rule))
    }
}

fn load_item_library_ignore(
    project_path: &Path,
    source: ItemLibrarySource,
) -> ItemLibraryIgnore {
    ensure_workspace_item_library_config(project_path);
    read_item_library_ignore(project_path, source)
}

/// Only initialize item-library files when this workspace contains a real Items directory.
pub fn ensure_workspace_item_library_config(project_path: &Path) {
    use std::io::Write;

    let Some(source) = [ItemLibrarySource::Ni, ItemLibrarySource::Mm]
        .into_iter()
        .find(|source| source.workspace_library_root(project_path).is_some())
    else {
        return;
    };
    let config_dir = project_path.join(".superhigh");
    if fs::create_dir_all(&config_dir).is_err() {
        return;
    }
    let config = format!("{{\n  \"version\": 1,\n  \"mainSource\": \"{}\"\n}}\n", source.as_str());
    for (name, content) in [
        ("item-library.json", config.as_str()),
        (ITEM_LIBRARY_IGNORE_FILE, "shared: []\nni: []\nmm: []\n"),
    ] {
        if let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(config_dir.join(name))
        {
            let _ = file.write_all(content.as_bytes());
        }
    }
}

fn read_item_library_ignore(
    project_path: &Path,
    source: ItemLibrarySource,
) -> ItemLibraryIgnore {
    let config_path = project_path.join(".superhigh").join(ITEM_LIBRARY_IGNORE_FILE);
    if !config_path.is_file() {
        return ItemLibraryIgnore::default();
    }
    let Ok(raw) = read_lossy(&config_path) else {
        return ItemLibraryIgnore::default();
    };
    let parsed = parse_item_library_ignore_yaml(&raw);
    let mut rules = parsed.shared;
    match source {
        ItemLibrarySource::Ni => rules.extend(parsed.ni),
        ItemLibrarySource::Mm => rules.extend(parsed.mm),
    }
    let mut unique = HashSet::new();
    let rules = rules
        .into_iter()
        .map(|rule| normalize_relative_item_path(&rule))
        .filter(|rule| !rule.is_empty())
        .filter(|rule| unique.insert(rule.clone()))
        .collect::<Vec<_>>();
    ItemLibraryIgnore {
        rules,
        config_path: Some(normalize_path(&config_path)),
    }
}

#[derive(Debug, Clone, Default)]
struct ParsedItemLibraryIgnore {
    shared: Vec<String>,
    ni: Vec<String>,
    mm: Vec<String>,
}

fn parse_item_library_ignore_yaml(raw: &str) -> ParsedItemLibraryIgnore {
    let mut parsed = ParsedItemLibraryIgnore::default();
    let mut section: Option<&str> = None;
    for raw_line in raw.lines() {
        let without_comment = strip_yaml_line_comment(raw_line);
        let line = without_comment.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(key) = top_level_yaml_mapping_key(line) {
            section = match key.as_str() {
                "shared" | "paths" | "all" => Some("shared"),
                "ni" | "neigeitems" | "neige" => Some("ni"),
                "mm" | "mythicmobs" | "mythic" => Some("mm"),
                _ => None,
            };
            if let Some(inline) = inline_yaml_list_items(line) {
                push_ignore_rules(&mut parsed, section, inline);
            }
            continue;
        }
        if let Some(item) = yaml_list_item(line) {
            push_ignore_rules(&mut parsed, section, vec![item]);
        }
    }
    parsed
}

fn push_ignore_rules(
    parsed: &mut ParsedItemLibraryIgnore,
    section: Option<&str>,
    items: Vec<String>,
) {
    let target = match section {
        Some("ni") => &mut parsed.ni,
        Some("mm") => &mut parsed.mm,
        Some("shared") | None => &mut parsed.shared,
        _ => &mut parsed.shared,
    };
    target.extend(items.into_iter().filter(|item| !item.trim().is_empty()));
}

fn strip_yaml_line_comment(line: &str) -> String {
    let mut result = String::with_capacity(line.len());
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            result.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_double => {
                result.push(ch);
                escaped = true;
            }
            '\'' if !in_double => {
                in_single = !in_single;
                result.push(ch);
            }
            '"' if !in_single => {
                in_double = !in_double;
                result.push(ch);
            }
            '#' if !in_single && !in_double => break,
            _ => result.push(ch),
        }
    }
    result
}

fn top_level_yaml_mapping_key(line: &str) -> Option<String> {
    if line.starts_with('-') || line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let Some((key, _rest)) = line.split_once(':') else {
        return None;
    };
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    Some(key.to_ascii_lowercase())
}

fn inline_yaml_list_items(line: &str) -> Option<Vec<String>> {
    let Some((_, rest)) = line.split_once(':') else {
        return None;
    };
    let rest = rest.trim();
    if rest.is_empty() || rest == "[]" {
        return Some(Vec::new());
    }
    if !(rest.starts_with('[') && rest.ends_with(']')) {
        return None;
    }
    let inner = &rest[1..rest.len() - 1];
    if inner.trim().is_empty() {
        return Some(Vec::new());
    }
    Some(
        inner
            .split(',')
            .map(|part| clean_yaml_scalar(part.trim()))
            .filter(|part| !part.is_empty())
            .collect(),
    )
}

fn yaml_list_item(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let rest = trimmed.strip_prefix('-')?.trim_start();
    if rest.is_empty() {
        return None;
    }
    Some(clean_yaml_scalar(rest))
}

fn normalize_relative_item_path(path: &str) -> String {
    let mut value = path.trim().replace('\\', "/");
    while value.starts_with("./") {
        value = value[2..].to_string();
    }
    while value.starts_with('/') {
        value = value[1..].to_string();
    }
    while value.contains("//") {
        value = value.replace("//", "/");
    }
    value
}

fn relative_path_matches_ignore_rule(relative_path: &str, rule: &str) -> bool {
    let relative = normalize_relative_item_path(relative_path);
    let rule = normalize_relative_item_path(rule);
    if relative.is_empty() || rule.is_empty() {
        return false;
    }
    if rule.contains('*') || rule.contains('?') {
        return wildcard_path_matches(&relative, &rule);
    }
    if relative.eq_ignore_ascii_case(&rule) {
        return true;
    }
    let directory_prefix = rule.trim_end_matches('/').to_string();
    if directory_prefix.is_empty() {
        return false;
    }
    let prefix = format!("{directory_prefix}/");
    relative.len() > prefix.len() && relative[..prefix.len()].eq_ignore_ascii_case(&prefix)
}

fn wildcard_path_matches(relative_path: &str, pattern: &str) -> bool {
    let relative = normalize_relative_item_path(relative_path).to_ascii_lowercase();
    let pattern = normalize_relative_item_path(pattern).to_ascii_lowercase();
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        match chars[index] {
            '*' if index + 1 < chars.len() && chars[index + 1] == '*' => {
                regex.push_str(".*");
                index += 2;
                if index < chars.len() && chars[index] == '/' {
                    index += 1;
                }
            }
            '*' => {
                regex.push_str("[^/]*");
                index += 1;
            }
            '?' => {
                regex.push_str("[^/]");
                index += 1;
            }
            ch if ".+()[]{}^$|\\".contains(ch) => {
                regex.push('\\');
                regex.push(ch);
                index += 1;
            }
            ch => {
                regex.push(ch);
                index += 1;
            }
        }
    }
    regex.push('$');
    regex::Regex::new(&regex)
        .map(|compiled| compiled.is_match(&relative))
        .unwrap_or(false)
}

fn yaml_files(root: &Path) -> Vec<PathBuf> {
    let mut files = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            matches!(
                path.extension()
                    .map(|extension| extension.to_string_lossy().to_ascii_lowercase()),
                Some(extension) if extension == "yml" || extension == "yaml"
            )
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn read_lossy(path: &Path) -> anyhow::Result<String> {
    let bytes = fs::read(path)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

fn trim_trailing_empty_lines<'a>(lines: &'a [&str]) -> &'a [&'a str] {
    let mut end = lines.len();
    while end > 0 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    &lines[..end]
}

fn top_level_key(line: &str) -> Option<String> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    let (key, _) = trimmed.split_once(':')?;
    let key = key.trim().trim_matches('"').trim_matches('\'');
    if key.is_empty() || key.chars().any(char::is_whitespace) {
        return None;
    }
    Some(key.to_string())
}

fn top_level_yaml_key(line: &str) -> Option<String> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    let (key, _) = trimmed.split_once(':')?;
    let key = key.trim().trim_matches('"').trim_matches('\'');
    if key.is_empty() {
        return None;
    }
    Some(key.to_string())
}

fn yaml_scalar_field(lines: &[&str], field_names: &[&str]) -> Option<String> {
    for line in lines.iter().skip(1) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
            continue;
        }
        let (key, value) = trimmed.split_once(':')?;
        if !field_names
            .iter()
            .any(|field_name| key.trim().eq_ignore_ascii_case(field_name))
        {
            continue;
        }
        let value = clean_yaml_scalar(value);
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

fn clean_yaml_scalar(value: &str) -> String {
    let mut value = value.trim();
    if let Some(before_comment) = value.split_once(" #").map(|(before, _)| before.trim_end()) {
        value = before_comment;
    }
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
        {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

fn yaml_f64_field(lines: &[&str], field_names: &[&str]) -> Option<f64> {
    yaml_scalar_field(lines, field_names).and_then(|value| value.parse::<f64>().ok())
}

fn yaml_bool_field(lines: &[&str], field_names: &[&str]) -> Option<bool> {
    yaml_scalar_field(lines, field_names).and_then(|value| {
        match value.to_ascii_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        }
    })
}

fn search_needles(query: &str, expanded_query: Option<&str>) -> Vec<String> {
    let mut seen = HashSet::new();
    [Some(query), expanded_query]
        .into_iter()
        .flatten()
        .map(normalize_search_text)
        .filter(|value| !value.is_empty())
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn searchable_text(key: &str, display_name: Option<&str>) -> String {
    normalize_search_text(&format!("{}\n{}", key, display_name.unwrap_or_default()))
}

fn normalize_search_text(value: &str) -> String {
    strip_minecraft_color_codes(value).to_lowercase()
}

fn strip_minecraft_color_codes(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if (character == '&' || character == '§') && is_color_sequence(&mut chars) {
            continue;
        }
        output.push(character);
    }
    output
}

#[derive(Debug, Clone)]
struct DragonCoreIconEntry {
    key: String,
    match_text: String,
    texture: String,
    config_path: PathBuf,
    relative_config_path: String,
    line_number: usize,
    image_path: PathBuf,
}

#[derive(Debug, Clone)]
struct DragonCoreEffectEntry {
    key: String,
    match_text: String,
    texture: String,
    config_path: PathBuf,
    relative_config_path: String,
    line_number: usize,
    image_path: PathBuf,
}

#[derive(Debug, Clone)]
struct DragonCoreFontEntry {
    character: String,
    path: String,
    config_path: PathBuf,
    relative_config_path: String,
    line_number: usize,
    image_path: PathBuf,
    width: f64,
    height: f64,
    y_offset: Option<f64>,
    color: Option<bool>,
    font_width: Option<f64>,
}

struct DragonCoreIconIndex {
    entries: Vec<DragonCoreIconEntry>,
    effect_entries: Vec<DragonCoreEffectEntry>,
    font_entries: HashMap<String, DragonCoreFontEntry>,
    data_url_cache: HashMap<String, String>,
}

static DRAGON_CORE_ICON_INDEXES: Lazy<Mutex<HashMap<String, DragonCoreIconIndex>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn apply_dragon_core_metadata(
    items: &mut [ItemLibraryItem],
    project_path: &Path,
    client_root: Option<&Path>,
    force_refresh: bool,
) {
    let Some(client_root) = client_root else {
        return;
    };
    let cache_key = format!(
        "{}|{}",
        normalize_path(project_path).to_ascii_lowercase(),
        normalize_path(client_root).to_ascii_lowercase(),
    );
    let mut indexes = DRAGON_CORE_ICON_INDEXES
        .lock()
        .expect("DragonCore icon index lock poisoned");
    if force_refresh {
        indexes.remove(&cache_key);
    }
    if !indexes.contains_key(&cache_key) {
        let Some(index) =
            DragonCoreIconIndex::load(project_path, Some(client_root))
        else {
            return;
        };
        indexes.insert(cache_key.clone(), index);
    }
    let Some(icon_index) = indexes.get_mut(&cache_key) else {
        return;
    };
    for item in items {
        let nbt_icon = item_nbt_icon_value(&item.yaml_block);
        item.dragon_core_icon = icon_index.icon_for_item(
            &item.item_key,
            item.display_name.as_deref(),
            nbt_icon.as_deref(),
        );
        item.dragon_core_effect = icon_index.effect_for_item(&item.yaml_block);
        item.dragon_core_font_images = icon_index.font_images_for_text(&format!(
            "{}\n{}",
            item.display_name.as_deref().unwrap_or_default(),
            item.yaml_block
        ));
    }
}

impl DragonCoreIconIndex {
    fn load(
        project_path: &Path,
        client_root: Option<&Path>,
    ) -> Option<Self> {
        let client_root = client_root?;
        if !client_root.is_dir() {
            return None;
        }
        let mut entries = Vec::new();
        if let Some(icon_sources) =
            dragon_core_item_icon_sources(project_path)
        {
            for (icon_root, file_paths) in icon_sources {
                for file_path in file_paths {
                    let Ok(content) = read_lossy(&file_path) else {
                        continue;
                    };
                    entries.extend(scan_dragon_core_icon_file(
                        &icon_root,
                        &file_path,
                        &content,
                        client_root,
                    ));
                }
            }
        }
        let mut effect_entries = Vec::new();
        if let Some((effect_root, effect_files)) =
            dragon_core_item_effect_files(project_path)
        {
            for file_path in effect_files {
                let Ok(content) = read_lossy(&file_path) else {
                    continue;
                };
                effect_entries.extend(scan_dragon_core_effect_file(
                    &effect_root,
                    &file_path,
                    &content,
                    client_root,
                ));
            }
        }
        let mut font_entries = HashMap::new();
        if let Some(font_sources) =
            dragon_core_font_config_sources(project_path)
        {
            for (font_root, file_paths) in font_sources {
                for file_path in file_paths {
                    let Ok(content) = read_lossy(&file_path) else {
                        continue;
                    };
                    for entry in scan_dragon_core_font_config_file(
                        &font_root,
                        &file_path,
                        &content,
                        client_root,
                    ) {
                        font_entries.entry(entry.character.clone()).or_insert(entry);
                    }
                }
            }
        }
        if entries.is_empty() && effect_entries.is_empty() && font_entries.is_empty() {
            None
        } else {
            Some(Self {
                entries,
                effect_entries,
                font_entries,
                data_url_cache: HashMap::new(),
            })
        }
    }

    fn icon_for_item(
        &mut self,
        item_key: &str,
        display_name: Option<&str>,
        nbt_icon: Option<&str>,
    ) -> Option<DragonCoreItemIcon> {
        let candidates = [
            nbt_icon.unwrap_or_default(),
            display_name.unwrap_or_default(),
            item_key,
        ]
        .into_iter()
        .map(normalize_search_text)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
        let entry = self
            .entries
            .iter()
            .filter_map(|entry| icon_match_score(entry, &candidates).map(|score| (score, entry)))
            .max_by(|(left_score, left), (right_score, right)| {
                left_score
                    .cmp(right_score)
                    .then(left.match_text.len().cmp(&right.match_text.len()))
            })
            .map(|(_, entry)| entry.clone())?;
        let image_key = normalize_path(&entry.image_path);
        let data_url = self.cached_data_url(&entry.image_path)?;
        Some(DragonCoreItemIcon {
            data_url,
            texture: entry.texture,
            image_path: image_key,
            config_path: normalize_path(&entry.config_path),
            relative_config_path: entry.relative_config_path,
            line_number: entry.line_number,
        })
    }

    fn effect_for_item(&mut self, yaml_block: &str) -> Option<DragonCoreItemEffect> {
        let entry = self
            .effect_entries
            .iter()
            .filter_map(|entry| effect_match_score(entry, yaml_block).map(|score| (score, entry)))
            .max_by(|(left_score, left), (right_score, right)| {
                left_score
                    .cmp(right_score)
                    .then(left.match_text.len().cmp(&right.match_text.len()))
                    .then(left.key.len().cmp(&right.key.len()))
            })
            .map(|(_, entry)| entry.clone())?;
        let image_key = normalize_path(&entry.image_path);
        let data_url = self.cached_data_url(&entry.image_path)?;
        Some(DragonCoreItemEffect {
            data_url,
            texture: entry.texture,
            image_path: image_key,
            config_path: normalize_path(&entry.config_path),
            relative_config_path: entry.relative_config_path,
            line_number: entry.line_number,
            match_text: entry.match_text,
        })
    }

    fn font_images_for_text(&mut self, text: &str) -> Vec<DragonCoreFontImage> {
        let mut seen = HashSet::new();
        let mut images = Vec::new();
        for character in text.chars() {
            let character = character.to_string();
            if let Some(entry) = self.font_entries.get(&character).cloned() {
                self.push_font_image_entry(&mut seen, &mut images, entry);
            }
        }
        images
    }

    fn push_font_image_entry(
        &mut self,
        seen: &mut HashSet<String>,
        images: &mut Vec<DragonCoreFontImage>,
        entry: DragonCoreFontEntry,
    ) {
        if !seen.insert(entry.character.clone()) {
            return;
        }
        let Some(data_url) = self.cached_data_url(&entry.image_path) else {
            return;
        };
        images.push(DragonCoreFontImage {
            character: entry.character,
            data_url,
            path: entry.path,
            image_path: normalize_path(&entry.image_path),
            config_path: normalize_path(&entry.config_path),
            relative_config_path: entry.relative_config_path,
            line_number: entry.line_number,
            width: entry.width,
            height: entry.height,
            y_offset: entry.y_offset,
            color: entry.color,
            font_width: entry.font_width,
        });
    }

    fn cached_data_url(&mut self, image_path: &Path) -> Option<String> {
        let image_key = normalize_path(image_path);
        if let Some(cached) = self.data_url_cache.get(&image_key) {
            return Some(cached.clone());
        }
        let loaded = read_image_as_data_url(image_path).ok()?;
        self.data_url_cache.insert(image_key, loaded.clone());
        Some(loaded)
    }
}

pub(crate) fn dragon_core_roots(project_path: &Path) -> Vec<PathBuf> {
    let mut roots = vec![project_path.join("DragonCore"), project_path.join("plugins/DragonCore")];
    if project_path.file_name().and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("DragonCore"))
    {
        roots.push(project_path.to_path_buf());
    }
    let Ok(workspace) = project_path.canonicalize() else { return Vec::new(); };
    roots.retain(|root| root.is_dir() && root.canonicalize().is_ok_and(|path| path.starts_with(&workspace)));
    roots
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMinecraftCapabilities {
    pub item_sources: Vec<ItemLibrarySource>,
    pub monster_library: bool,
    pub dragon_core: bool,
}

pub fn project_minecraft_capabilities(project_path: &Path) -> ProjectMinecraftCapabilities {
    ProjectMinecraftCapabilities {
        item_sources: [ItemLibrarySource::Ni, ItemLibrarySource::Mm].into_iter()
            .filter(|source| source.workspace_library_root(project_path).is_some()).collect(),
        monster_library: crate::monster_library::workspace_monster_library_root(project_path).is_some(),
        dragon_core: dragon_core_item_icon_sources(project_path).is_some()
            || dragon_core_item_effect_files(project_path).is_some()
            || dragon_core_font_config_sources(project_path).is_some()
            || dragon_core_roots(project_path).iter()
                .any(|root| case_insensitive_child_dir(root, "gui").is_some()),
    }
}

fn dragon_core_item_icon_sources(
    project_path: &Path,
) -> Option<Vec<(PathBuf, Vec<PathBuf>)>> {
    for dragon_core_root in dragon_core_roots(project_path) {
        let mut sources = Vec::new();
        let icon_files = case_insensitive_child_files(&dragon_core_root, &["itemicon.yml", "itemicon.yaml"]);
        if !icon_files.is_empty() {
            sources.push((dragon_core_root.clone(), icon_files));
        }

        if let Some(icon_root) = case_insensitive_child_dir(&dragon_core_root, "itemicon") {
            sources.push((icon_root.clone(), yaml_files(&icon_root)));
        }

        if !sources.is_empty() {
            return Some(sources);
        }
    }
    None
}

fn dragon_core_item_effect_files(
    project_path: &Path,
) -> Option<(PathBuf, Vec<PathBuf>)> {
    for dragon_core_root in dragon_core_roots(project_path) {
        let effect_files = case_insensitive_child_files(&dragon_core_root, &["itemeffect.yml", "itemeffect.yaml"]);
        if !effect_files.is_empty() {
            return Some((dragon_core_root, effect_files));
        }
        if let Some(effect_root) = case_insensitive_child_dir(&dragon_core_root, "itemeffect") {
            return Some((effect_root.clone(), yaml_files(&effect_root)));
        }
    }
    None
}

fn dragon_core_font_config_sources(
    project_path: &Path,
) -> Option<Vec<(PathBuf, Vec<PathBuf>)>> {
    for dragon_core_root in dragon_core_roots(project_path) {
        let mut sources = Vec::new();
        let direct_files =
            case_insensitive_child_files(&dragon_core_root, &["fontconfig.yml", "fontconfig.yaml"]);
        if !direct_files.is_empty() {
            sources.push((dragon_core_root.clone(), direct_files));
        }

        if let Some(font_root) = case_insensitive_child_dir(&dragon_core_root, "fontconfig") {
            sources.push((font_root.clone(), yaml_files(&font_root)));
        }

        if !sources.is_empty() {
            return Some(sources);
        }
    }
    None
}

fn case_insensitive_child_files(root: &Path, names: &[&str]) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut files = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|file_name| {
                    names
                        .iter()
                        .any(|name| file_name.eq_ignore_ascii_case(name))
                })
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

fn case_insensitive_child_dir(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.is_dir()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|file_name| file_name.eq_ignore_ascii_case(name))
        })
}

fn scan_dragon_core_icon_file(
    icon_root: &Path,
    file_path: &Path,
    content: &str,
    client_root: &Path,
) -> Vec<DragonCoreIconEntry> {
    let lines = content.lines().collect::<Vec<_>>();
    let mut starts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(key) = top_level_yaml_key(line) {
            starts.push((index, key));
        }
    }

    let mut entries = Vec::new();
    for (position, (start_index, key)) in starts.iter().enumerate() {
        let end_index = starts
            .get(position + 1)
            .map(|(index, _)| *index)
            .unwrap_or(lines.len());
        let block_lines = trim_trailing_empty_lines(&lines[*start_index..end_index]);
        let Some(texture) = yaml_scalar_field(block_lines, &["texture"]) else {
            continue;
        };
        let match_text = yaml_scalar_field(block_lines, &["match"]).unwrap_or_else(|| key.clone());
        if match_text.trim().is_empty() {
            continue;
        }
        let Some(image_path) = resolve_dragon_core_texture_path(client_root, &texture) else {
            continue;
        };
        let relative_config_path = file_path
            .strip_prefix(icon_root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(DragonCoreIconEntry {
            key: key.clone(),
            match_text,
            texture: texture.replace('\\', "/"),
            config_path: file_path.to_path_buf(),
            relative_config_path,
            line_number: start_index + 1,
            image_path,
        });
    }
    entries
}

fn scan_dragon_core_effect_file(
    effect_root: &Path,
    file_path: &Path,
    content: &str,
    client_root: &Path,
) -> Vec<DragonCoreEffectEntry> {
    let lines = content.lines().collect::<Vec<_>>();
    let mut starts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(key) = top_level_yaml_key(line) {
            starts.push((index, key));
        }
    }

    let mut entries = Vec::new();
    for (position, (start_index, key)) in starts.iter().enumerate() {
        let end_index = starts
            .get(position + 1)
            .map(|(index, _)| *index)
            .unwrap_or(lines.len());
        let block_lines = trim_trailing_empty_lines(&lines[*start_index..end_index]);
        let Some(texture) = yaml_scalar_field(block_lines, &["texture"]) else {
            continue;
        };
        let Some(match_text) = yaml_scalar_field(block_lines, &["match"]) else {
            continue;
        };
        let match_text = clean_dragon_core_match_text(&match_text);
        if match_text.is_empty() {
            continue;
        }
        let Some(image_path) = resolve_dragon_core_texture_path(client_root, &texture) else {
            continue;
        };
        let relative_config_path = file_path
            .strip_prefix(effect_root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(DragonCoreEffectEntry {
            key: key.clone(),
            match_text,
            texture: texture.replace('\\', "/"),
            config_path: file_path.to_path_buf(),
            relative_config_path,
            line_number: start_index + 1,
            image_path,
        });
    }
    entries
}

fn scan_dragon_core_font_config_file(
    font_root: &Path,
    file_path: &Path,
    content: &str,
    client_root: &Path,
) -> Vec<DragonCoreFontEntry> {
    let lines = content.lines().collect::<Vec<_>>();
    let mut starts = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(key) = top_level_yaml_key(line) {
            starts.push((index, key));
        }
    }

    let mut entries = Vec::new();
    for (position, (start_index, key)) in starts.iter().enumerate() {
        let character = key.chars().next().map(|value| value.to_string());
        let Some(character) = character else {
            continue;
        };
        let end_index = starts
            .get(position + 1)
            .map(|(index, _)| *index)
            .unwrap_or(lines.len());
        let block_lines = trim_trailing_empty_lines(&lines[*start_index..end_index]);
        let Some(path) = yaml_scalar_field(block_lines, &["path", "texture"]) else {
            continue;
        };
        let Some(image_path) = resolve_dragon_core_texture_path(client_root, &path) else {
            continue;
        };
        let relative_config_path = file_path
            .strip_prefix(font_root)
            .unwrap_or(file_path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(DragonCoreFontEntry {
            character,
            path: path.replace('\\', "/"),
            config_path: file_path.to_path_buf(),
            relative_config_path,
            line_number: start_index + 1,
            image_path,
            width: yaml_f64_field(block_lines, &["width"]).unwrap_or(12.0),
            height: yaml_f64_field(block_lines, &["height"]).unwrap_or(12.0),
            y_offset: yaml_f64_field(block_lines, &["yOffset", "yoffset"]),
            color: yaml_bool_field(block_lines, &["color"]),
            font_width: yaml_f64_field(block_lines, &["fontWidth", "fontwidth"]),
        });
    }
    entries
}

fn icon_match_score(entry: &DragonCoreIconEntry, candidates: &[String]) -> Option<usize> {
    let mut icon_values = vec![normalize_search_text(&entry.match_text)];
    if let Some(icon_value) = dragon_core_icon_match_value(&entry.match_text) {
        icon_values.push(normalize_search_text(&icon_value));
    }
    icon_values.push(normalize_search_text(&entry.key));
    let mut best = 0;
    for candidate in candidates {
        for icon_value in &icon_values {
            if candidate.is_empty() || icon_value.is_empty() {
                continue;
            }
            let score = if candidate == icon_value {
                10_000 + icon_value.chars().count()
            } else if candidate.contains(icon_value) {
                5_000 + icon_value.chars().count()
            } else if icon_value.contains(candidate) {
                3_000 + candidate.chars().count()
            } else {
                0
            };
            best = best.max(score);
        }
    }
    (best > 0).then_some(best)
}

fn item_nbt_icon_value(yaml_block: &str) -> Option<String> {
    let mut in_nbt = false;
    let mut nbt_indent = 0usize;
    for line in yaml_block.lines().skip(1) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if in_nbt && indent <= nbt_indent {
            in_nbt = false;
        }
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().trim_matches('"').trim_matches('\'');
        if in_nbt && key.eq_ignore_ascii_case("icon") {
            let value = clean_yaml_scalar(value);
            if !value.is_empty() {
                return Some(value);
            }
        }
        if key.eq_ignore_ascii_case("nbt") {
            let value = clean_yaml_scalar(value);
            if let Some(icon_value) = dragon_core_icon_match_value(&value) {
                return Some(icon_value);
            }
            in_nbt = true;
            nbt_indent = indent;
        }
    }
    None
}

fn dragon_core_icon_match_value(match_text: &str) -> Option<String> {
    let lower = match_text.to_lowercase();
    let index = lower.find("icon")?;
    let after_key = &match_text[index + "icon".len()..];
    let separator_index = after_key.find([':', '='])?;
    clean_match_expression_value(&after_key[separator_index + 1..])
}

fn effect_match_score(entry: &DragonCoreEffectEntry, yaml_block: &str) -> Option<usize> {
    if let Some(match_quality) = dragon_core_item_quality_match_value(&entry.match_text) {
        let match_quality = normalize_search_text(&match_quality);
        if item_quality_values(yaml_block)
            .into_iter()
            .map(|value| normalize_search_text(&value))
            .any(|value| value == match_quality)
        {
            return Some(9_000 + match_quality.chars().count());
        }
    }

    let normalized_match = normalize_search_text(&entry.match_text);
    if normalized_match.is_empty() {
        return None;
    }
    let normalized_block = normalize_search_text(yaml_block);
    if yaml_block.contains(&entry.match_text) {
        return Some(10_000 + entry.match_text.chars().count());
    }
    if normalized_block.contains(&normalized_match) {
        return Some(8_000 + normalized_match.chars().count());
    }
    None
}

fn clean_dragon_core_match_text(value: &str) -> String {
    let mut value = value.trim().to_string();
    loop {
        let trimmed = value.trim();
        if trimmed.len() < 2 {
            return trimmed.to_string();
        }
        let mut chars = trimmed.chars();
        let first = chars.next().unwrap_or_default();
        let last = trimmed.chars().next_back().unwrap_or_default();
        if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
            value = trimmed[1..trimmed.len() - 1].to_string();
            continue;
        }
        if (last == '"' || last == '\'') && !trimmed[..trimmed.len() - 1].contains(last) {
            value = trimmed[..trimmed.len() - 1].to_string();
            continue;
        }
        return trimmed.to_string();
    }
}

fn dragon_core_item_quality_match_value(match_text: &str) -> Option<String> {
    let lower = match_text.to_lowercase();
    let index = lower.find("item_quality")?;
    let after_key = &match_text[index + "item_quality".len()..];
    let separator_index = after_key.find([':', '='])?;
    clean_match_expression_value(&after_key[separator_index + 1..])
}

fn item_quality_values(yaml_block: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut lower_offset = 0;
    let lower = yaml_block.to_lowercase();
    while let Some(relative_index) = lower[lower_offset..].find("item_quality") {
        let index = lower_offset + relative_index;
        let after_key = &yaml_block[index + "item_quality".len()..];
        if let Some(separator_index) = after_key.find([':', '=']) {
            if let Some(value) = clean_match_expression_value(&after_key[separator_index + 1..]) {
                values.push(value);
            }
        }
        lower_offset = index + "item_quality".len();
    }
    values
}

fn clean_match_expression_value(raw: &str) -> Option<String> {
    let raw = raw.trim_start();
    let mut chars = raw.chars();
    let first = chars.next()?;
    let value = if first == '"' || first == '\'' {
        chars
            .take_while(|character| *character != first)
            .collect::<String>()
    } else {
        raw.chars()
            .take_while(|character| {
                !character.is_whitespace()
                    && !matches!(character, ',' | '}' | ']' | ')' | '\'' | '"')
            })
            .collect::<String>()
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn resolve_dragon_core_texture_path(client_root: &Path, texture: &str) -> Option<PathBuf> {
    let texture = texture.replace('\\', "/");
    let texture = texture.trim().trim_start_matches('/');
    if texture.is_empty() {
        return None;
    }

    let direct = PathBuf::from(texture);
    if direct.is_absolute() && supported_image_file(&direct) {
        return Some(direct);
    }

    let mut bases = Vec::new();
    for root in dragon_core_resource_root_candidates(client_root) {
        bases.push(root.clone());
        bases.push(root.join("icon"));
        bases.push(root.join("gui").join("icon"));
        bases.push(root.join("assets"));
        bases.push(root.join("assets").join("icon"));
        bases.push(root.join("assets").join("gui").join("icon"));
    }
    let bases = bases
        .into_iter()
        .filter(|path| path.is_dir() || path.parent().is_some_and(Path::is_dir))
        .collect::<Vec<_>>();
    for variant in texture_path_variants(texture) {
        for base in &bases {
            let candidate = base.join(&variant);
            if supported_image_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn dragon_core_resource_root_candidates(client_root: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    push_unique_path(&mut roots, client_root.to_path_buf());
    if let Some(dragon_core_root) = nearest_ancestor_named(client_root, "DragonCore") {
        push_unique_path(&mut roots, dragon_core_root);
    }
    push_unique_path(&mut roots, client_root.join("DragonCore"));
    push_unique_path(
        &mut roots,
        client_root.join("resourcepacks").join("DragonCore"),
    );
    push_unique_path(
        &mut roots,
        client_root.join("resourcepack").join("DragonCore"),
    );
    push_unique_path(&mut roots, client_root.join("resources").join("DragonCore"));
    push_unique_path(
        &mut roots,
        client_root
            .join(".minecraft")
            .join("resourcepacks")
            .join("DragonCore"),
    );
    roots
}

fn nearest_ancestor_named(path: &Path, name: &str) -> Option<PathBuf> {
    path.ancestors().find_map(|ancestor| {
        ancestor
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|file_name| file_name.eq_ignore_ascii_case(name))
            .map(|_| ancestor.to_path_buf())
    })
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    let key = normalize_path(&path).to_ascii_lowercase();
    if paths
        .iter()
        .any(|existing| normalize_path(existing).to_ascii_lowercase() == key)
    {
        return;
    }
    paths.push(path);
}

fn texture_path_variants(texture: &str) -> Vec<PathBuf> {
    let path = PathBuf::from(texture);
    if path.extension().is_some() {
        return vec![path];
    }
    ["png", "gif", "jpg", "jpeg", "webp"]
        .into_iter()
        .map(|extension| PathBuf::from(format!("{texture}.{extension}")))
        .collect()
}

fn supported_image_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "webp")
    )
}

fn is_color_sequence(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) -> bool {
    let Some(next) = chars.peek().copied() else {
        return false;
    };
    if next == '#' {
        let mut clone = chars.clone();
        clone.next();
        let hex = clone.by_ref().take(6).collect::<String>();
        if hex.len() == 6 && hex.chars().all(|character| character.is_ascii_hexdigit()) {
            for _ in 0..7 {
                chars.next();
            }
            return true;
        }
    }
    if matches!(
        next.to_ascii_lowercase(),
        '0'..='9' | 'a'..='f' | 'k'..='o' | 'r' | 'x'
    ) {
        chars.next();
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{
        parse_item_library_ignore_yaml, relative_path_matches_ignore_rule,
        search_item_library, search_item_library_with_icons,
        search_item_library_with_icons_page, ItemLibrarySource,
    };
    use std::path::Path;

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn write_png(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(
            path,
            [
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
                1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 252,
                255, 31, 0, 3, 2, 2, 0, 239, 191, 167, 219, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66,
                96, 130,
            ],
        )
        .unwrap();
    }

    #[test]
    fn capabilities_follow_real_workspace_directories() {
        let server = tempfile::tempdir().unwrap();
        let empty = super::project_minecraft_capabilities(server.path());
        assert!(empty.item_sources.is_empty());
        assert!(!empty.monster_library && !empty.dragon_core);
        for relative in ["plugins/NeigeItems/Items", "plugins/MythicMobs/Items", "plugins/MythicMobs/Mobs", "plugins/DragonCore"] {
            std::fs::create_dir_all(server.path().join(relative)).unwrap();
        }
        assert!(!super::project_minecraft_capabilities(server.path()).dragon_core);
        write_file(&server.path().join("plugins/DragonCore/ItemIcon.yml"), "{}");
        for workspace in [server.path().to_path_buf(), server.path().join("plugins")] {
            let found = super::project_minecraft_capabilities(&workspace);
            assert_eq!(found.item_sources, vec![ItemLibrarySource::Ni, ItemLibrarySource::Mm]);
            assert!(found.monster_library && found.dragon_core);
        }
        let sibling = server.path().join("unrelated");
        std::fs::create_dir(&sibling).unwrap();
        let absent = super::project_minecraft_capabilities(&sibling);
        assert!(absent.item_sources.is_empty());
        assert!(!absent.monster_library && !absent.dragon_core);
    }

    #[test]
    fn dragon_core_sources_are_local_and_support_files_and_directories() {
        let server = tempfile::tempdir().unwrap();
        let dragon = server.path().join("plugins/DragonCore");
        write_file(&dragon.join("Itemicon.yaml"), "{}");
        write_file(&dragon.join("Itemicon/extra.yml"), "{}");
        write_file(&dragon.join("ItemEffect.yaml"), "{}");
        write_file(&dragon.join("FontConfig/font.yml"), "{}");
        for workspace in [server.path().to_path_buf(), server.path().join("plugins"), dragon] {
            assert_eq!(super::dragon_core_item_icon_sources(&workspace).unwrap().len(), 2);
            assert!(super::dragon_core_item_effect_files(&workspace).is_some());
            assert!(super::dragon_core_font_config_sources(&workspace).is_some());
        }
        let unrelated = server.path().join("unrelated");
        std::fs::create_dir(&unrelated).unwrap();
        assert!(super::dragon_core_item_icon_sources(&unrelated).is_none());
        assert!(super::dragon_core_item_effect_files(&unrelated).is_none());
        assert!(super::dragon_core_font_config_sources(&unrelated).is_none());
    }

    #[test]
    fn ni_scan_extracts_top_level_items_with_line_numbers_and_blocks() {
        let directory = tempfile::tempdir().unwrap();
        let file_path = directory
            .path()
            .join("NeigeItems")
            .join("Items")
            .join("mist.yml");
        write_file(
            &file_path,
            "goblin_sword:\n  name: '&a哥布林短剑'\n  material: IRON_SWORD\n  lore:\n    - '&7雾隐之森'\n\nwolf_pelt:\n  name: '&f狼皮'\n  material: LEATHER\n",
        );

        let result = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
        )
        .unwrap();

        assert_eq!(result.items.len(), 2);
        assert_eq!(
            result.library_root_path,
            file_path
                .parent()
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/")
        );
        assert_eq!(result.items[0].source, "ni");
        assert_eq!(result.items[0].item_key, "goblin_sword");
        assert_eq!(
            result.items[0].display_name.as_deref(),
            Some("&a哥布林短剑")
        );
        assert_eq!(
            result.items[0].material_or_id.as_deref(),
            Some("IRON_SWORD")
        );
        assert_eq!(result.items[0].line_number, 1);
        assert!(result.items[0].yaml_block.contains("goblin_sword:"));
        assert!(!result.items[0].yaml_block.contains("wolf_pelt:"));
        assert!(result.items[0].relative_path.ends_with("mist.yml"));
        assert!(result.items[0]
            .file_path
            .ends_with("NeigeItems/Items/mist.yml"));
    }

    #[test]
    fn mm_scan_extracts_display_id_and_full_block() {
        let directory = tempfile::tempdir().unwrap();
        let file_path = directory
            .path()
            .join("MythicMobs")
            .join("Items")
            .join("keys.yml");
        write_file(
            &file_path,
            "sakura_key:\n  Id: TRIPWIRE_HOOK\n  Display: '&d樱骸钥匙'\n  Lore:\n  - '&7樱骸古域'\n\nrift_token:\n  Id: NETHER_STAR\n  Display: '&b裂隙信标'\n",
        );

        let result = search_item_library(
            directory.path(),
            ItemLibrarySource::Mm,
            "",
            None,
        )
        .unwrap();

        assert_eq!(result.items.len(), 2);
        assert_eq!(result.items[0].source, "mm");
        assert_eq!(result.items[0].item_key, "sakura_key");
        assert_eq!(result.items[0].display_name.as_deref(), Some("&d樱骸钥匙"));
        assert_eq!(
            result.items[0].material_or_id.as_deref(),
            Some("TRIPWIRE_HOOK")
        );
        assert_eq!(result.items[0].line_number, 1);
        assert!(result.items[0].yaml_block.contains("Lore:"));
        assert!(!result.items[0].yaml_block.contains("rift_token:"));
    }

    #[test]
    fn search_uses_only_the_workspace_library() {
        let workspace = tempfile::tempdir().unwrap();
        let other_server = tempfile::tempdir().unwrap();
        write_file(
            &workspace.path().join("NeigeItems/Items/workspace.yml"),
            "workspace_item:\n  name: '工作区物品'\n  material: STONE\n",
        );
        write_file(
            &other_server.path().join("NeigeItems/Items/other.yml"),
            "other_item:\n  name: '其他服务端物品'\n  material: DIRT\n",
        );

        let result = search_item_library(
            workspace.path(),
            ItemLibrarySource::Ni,
            "",
            None,
        )
        .unwrap();

        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].item_key, "workspace_item");
        assert!(result.library_root_path.ends_with("NeigeItems/Items"));
    }

    #[test]
    fn search_does_not_load_external_library_or_initialize_workspace_config() {
        let workspace = tempfile::tempdir().unwrap();
        let other_server = tempfile::tempdir().unwrap();
        write_file(
            &other_server.path().join("MythicMobs/Items/other.yml"),
            "other_token:\n  Id: PAPER\n  Display: '其他服务端令牌'\n",
        );

        let result = search_item_library(
            workspace.path(),
            ItemLibrarySource::Mm,
            "",
            None,
        );

        assert!(result.is_err());
        assert!(!workspace.path().join(".superhigh/item-library-ignore.yml").exists());
    }

    #[test]
    fn workspace_item_library_initialization_requires_real_local_items_directory() {
        for plugin in ["NeigeItems", "MythicMobs"] {
            for prefix in ["", "plugins"] {
                let workspace = tempfile::tempdir().unwrap();
                let plugin_root = workspace.path().join(prefix).join(plugin);
                std::fs::create_dir_all(&plugin_root).unwrap();
                super::ensure_workspace_item_library_config(workspace.path());
                assert!(!workspace.path().join(".superhigh").exists());
                write_file(&plugin_root.join("Items"), "not a directory");
                super::ensure_workspace_item_library_config(workspace.path());
                assert!(!workspace.path().join(".superhigh").exists());
                std::fs::remove_file(plugin_root.join("Items")).unwrap();
                std::fs::create_dir(plugin_root.join("Items")).unwrap();
                super::ensure_workspace_item_library_config(workspace.path());
                assert!(workspace.path().join(".superhigh/item-library-ignore.yml").is_file());
                let config: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(workspace.path().join(".superhigh/item-library.json")).unwrap(),
                ).unwrap();
                assert_eq!(config["version"], 1);
                assert_eq!(config["mainSource"], if plugin == "NeigeItems" { "ni" } else { "mm" });
                super::ensure_workspace_item_library_config(&plugin_root);
                assert!(plugin_root.join(".superhigh/item-library-ignore.yml").is_file());
            }
        }
    }

    #[test]
    fn workspace_item_library_defaults_to_ni_and_preserves_existing_configs() {
        let workspace = tempfile::tempdir().unwrap();
        for plugin in ["NeigeItems", "MythicMobs"] {
            std::fs::create_dir_all(workspace.path().join(plugin).join("Items")).unwrap();
        }
        super::ensure_workspace_item_library_config(workspace.path());
        let config_path = workspace.path().join(".superhigh/item-library.json");
        let ignore_path = workspace.path().join(".superhigh/item-library-ignore.yml");
        let config: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(config["mainSource"], "ni");
        write_file(&config_path, "{\"version\":1,\"mainSource\":\"mm\"}");
        write_file(&ignore_path, "shared: [custom]\n");
        super::ensure_workspace_item_library_config(workspace.path());
        assert_eq!(std::fs::read_to_string(config_path).unwrap(), "{\"version\":1,\"mainSource\":\"mm\"}");
        assert_eq!(std::fs::read_to_string(ignore_path).unwrap(), "shared: [custom]\n");
    }

    #[test]
    fn workspace_item_library_does_not_search_parent_or_sibling_directories() {
        let root = tempfile::tempdir().unwrap();
        for plugin in ["NeigeItems", "MythicMobs"] {
            std::fs::create_dir_all(root.path().join(plugin).join("Items")).unwrap();
        }
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        super::ensure_workspace_item_library_config(&workspace);
        assert!(!workspace.join(".superhigh").exists());
        for source in [ItemLibrarySource::Ni, ItemLibrarySource::Mm] {
            assert!(search_item_library(&workspace, source, "", None).is_err());
        }
    }

    #[test]
    fn search_supports_server_and_plugin_workspaces_for_both_sources() {
        for (plugin, source, yaml) in [
            ("NeigeItems", ItemLibrarySource::Ni, "example:\n  name: Example\n  material: STONE\n"),
            ("MythicMobs", ItemLibrarySource::Mm, "example:\n  Display: Example\n  Id: STONE\n"),
        ] {
            let workspace = tempfile::tempdir().unwrap();
            let plugin_root = workspace.path().join("plugins").join(plugin);
            write_file(&plugin_root.join("Items/example.yml"), yaml);
            for project in [workspace.path(), plugin_root.as_path()] {
                let result = search_item_library(project, source, "", None).unwrap();
                assert_eq!(result.items.len(), 1);
                assert_eq!(result.items[0].item_key, "example");
            }
        }
    }

    #[test]
    fn search_reports_clear_error_when_no_library_exists() {
        let workspace = tempfile::tempdir().unwrap();

        let error = search_item_library(
            workspace.path(),
            ItemLibrarySource::Ni,
            "",
            None,
        )
        .unwrap_err();

        assert!(error.to_string().contains("未找到物品库目录"));
        assert!(error.to_string().contains("NeigeItems/Items"));
    }

    #[test]
    fn search_matches_only_key_and_display_without_color_codes() {
        let directory = tempfile::tempdir().unwrap();
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "goblin_helmet:\n  name: '&a哥布林头盔'\n  material: IRON_HELMET\n  lore:\n    - '&7来自雾隐之森'\n  options:\n    required-map: 1c\n\nplain_boots:\n  name: '旅人靴'\n  material: LEATHER_BOOTS\n",
        );

        let key = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "goblin_helmet",
            None,
        )
        .unwrap();
        let display = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "哥布林",
            None,
        )
        .unwrap();
        let lore = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "雾隐",
            None,
        )
        .unwrap();
        let material = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "IRON_HELMET",
            None,
        )
        .unwrap();
        let expanded = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "1c头盔",
            Some("哥布林头盔"),
        )
        .unwrap();

        assert_eq!(key.items[0].item_key, "goblin_helmet");
        assert_eq!(display.items[0].item_key, "goblin_helmet");
        assert!(lore.items.is_empty());
        assert!(material.items.is_empty());
        assert_eq!(expanded.items[0].item_key, "goblin_helmet");
    }

    #[test]
    fn search_rereads_item_file_after_external_disk_change() {
        let directory = tempfile::tempdir().unwrap();
        let file_path = directory.path().join("NeigeItems/Items/items.yml");
        write_file(
            &file_path,
            "goblin_helmet:\n  name: '&a旧头盔'\n  material: IRON_HELMET\n",
        );

        let old_result = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "头盔",
            None,
        )
        .unwrap();

        write_file(
            &file_path,
            "goblin_helmet:\n  name: '&b新头盔'\n  material: DIAMOND_HELMET\n\nwolf_pelt:\n  name: '狼皮'\n  material: LEATHER\n",
        );

        let new_result = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "新头盔",
            None,
        )
        .unwrap();

        assert_eq!(
            old_result.items[0].display_name.as_deref(),
            Some("&a旧头盔")
        );
        assert_eq!(new_result.items.len(), 1);
        assert_eq!(new_result.items[0].item_key, "goblin_helmet");
        assert_eq!(
            new_result.items[0].display_name.as_deref(),
            Some("&b新头盔")
        );
        assert!(new_result.items[0].yaml_block.contains("DIAMOND_HELMET"));
    }

    #[test]
    fn search_initializes_an_empty_project_item_library_ignore_file() {
        let directory = tempfile::tempdir().unwrap();
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "goblin_helmet:\n  name: '哥布林头盔'\n",
        );

        search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(directory.path().join(".superhigh/item-library-ignore.yml"))
                .unwrap(),
            "shared: []\nni: []\nmm: []\n"
        );
    }

    #[test]
    fn search_reads_only_the_requested_page_of_full_item_blocks() {
        let directory = tempfile::tempdir().unwrap();
        let items = (1..=10)
            .map(|index| {
                format!("item_{index}:\n  name: '物品 {index}'\n  lore:\n    - '只在详情中读取'")
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        write_file(&directory.path().join("NeigeItems/Items/items.yml"), &items);

        let result = search_item_library_with_icons_page(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
            None,
            2,
            9,
            true,
        )
        .unwrap();

        assert_eq!(result.total_items, 10);
        assert_eq!(result.page, 2);
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].item_key, "item_10");
        assert!(result.items[0].yaml_block.contains("只在详情中读取"));
    }

    #[test]
    fn attaches_dragon_core_item_icon_when_display_matches_config_and_texture_exists() {
        let directory = tempfile::tempdir().unwrap();
        let client = directory.path().join("client");
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "goblin_blade:\n  name: '&a哥布林太刀'\n  material: IRON_SWORD\n",
        );
        write_file(
            &directory.path().join("DragonCore/ItemIcon/装备.yml"),
            "哥布林太刀:\n  texture: zhuangbei/gblwq1.png\n  type: 263\n  match: \"哥布林太刀\"\n",
        );
        write_png(&client.join("resourcepacks/DragonCore/zhuangbei/gblwq1.png"));

        let result = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
            Some(client.as_path()),
        )
        .unwrap();

        let icon = result.items[0].dragon_core_icon.as_ref().unwrap();
        assert_eq!(icon.texture, "zhuangbei/gblwq1.png");
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        assert!(icon
            .image_path
            .ends_with("resourcepacks/DragonCore/zhuangbei/gblwq1.png"));
        assert!(icon.config_path.ends_with("DragonCore/ItemIcon/装备.yml"));
        assert_eq!(icon.line_number, 1);
    }

    #[test]
    fn attaches_dragon_core_item_icon_from_ni_nbt_icon_and_itemicon_yml() {
        let directory = tempfile::tempdir().unwrap();
        let client = directory.path().join("client");
        let dragon_core_root = client.join("resourcepacks/DragonCore");
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "一本轻甲头部:\n  name: '§#c9c7c4无图标显示名'\n  material: COAL\n  nbt:\n    icon: 雾霭兜帽\n    kfcsuit: 一本轻甲\n",
        );
        write_file(
            &directory.path().join("DragonCore/ItemIcon.yml"),
            "雾霭兜帽:\n  type: 263\n  match: icon:\"雾霭兜帽\"\n  texture: \"zhuangbei/yiben/1c_qing_head.png\"\n",
        );
        write_png(&dragon_core_root.join("icon/zhuangbei/yiben/1c_qing_head.png"));

        let result = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "一本轻甲头部",
            None,
            Some(dragon_core_root.as_path()),
        )
        .unwrap();

        let icon = result.items[0].dragon_core_icon.as_ref().unwrap();
        assert_eq!(icon.texture, "zhuangbei/yiben/1c_qing_head.png");
        assert!(icon
            .image_path
            .ends_with("DragonCore/icon/zhuangbei/yiben/1c_qing_head.png"));
        assert!(icon.config_path.ends_with("DragonCore/ItemIcon.yml"));
        assert_eq!(icon.line_number, 1);
    }

    #[test]
    fn attaches_dragon_core_item_icon_from_dragon_core_icon_folders() {
        let directory = tempfile::tempdir().unwrap();
        let client = directory.path().join("client");
        let dragon_core_root = client.join("resourcepacks/DragonCore");
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "mist_belt:\n  name: '隐蕴束腰'\n  material: COAL\nquest_badge:\n  name: '任务徽印'\n  material: COAL\n",
        );
        write_file(
            &directory.path().join("DragonCore/ItemIcon/装备.yml"),
            "隐蕴束腰:\n  texture: zhuangbei/yinwen2.png\n  type: 263\n  match: \"隐蕴束腰\"\n任务徽印:\n  texture: renwu/token.png\n  type: 263\n  match: \"任务徽印\"\n",
        );
        write_png(&dragon_core_root.join("icon/zhuangbei/yinwen2.png"));
        write_png(&dragon_core_root.join("gui/icon/renwu/token.png"));

        let result = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
            Some(dragon_core_root.as_path()),
        )
        .unwrap();

        let icons = result
            .items
            .iter()
            .map(|item| {
                (
                    item.item_key.as_str(),
                    item.dragon_core_icon
                        .as_ref()
                        .map(|icon| icon.image_path.as_str()),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(icons.len(), 2);
        assert!(icons.iter().any(|(key, path)| *key == "mist_belt"
            && path.is_some_and(|path| path.ends_with("DragonCore/icon/zhuangbei/yinwen2.png"))));
        assert!(icons.iter().any(|(key, path)| *key == "quest_badge"
            && path.is_some_and(|path| path.ends_with("DragonCore/gui/icon/renwu/token.png"))));
    }

    #[test]
    fn attaches_dragon_core_item_effect_from_quality_lore() {
        let directory = tempfile::tempdir().unwrap();
        let client = directory.path().join("client");
        let dragon_core_root = client.join("resourcepacks/DragonCore");
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "fallen_oath_legs:\n  name: '§#8f28b5堕光之誓跨护'\n  material: COAL\n  lore:\n  - 类型=§f腿部-重甲\n  - 品质=§#8f28b5非凡\n",
        );
        write_file(
            &directory.path().join("DragonCore/ItemEffect.yml"),
            "非凡背景:\n  match: 品质=§#8f28b5非凡\"\n  mode: 0\n  texture: gui/beibao/itemtip/pinzhi4.png\n  width: 19.7\n  height: 19.7\n",
        );
        write_png(&dragon_core_root.join("gui/beibao/itemtip/pinzhi4.png"));

        let result = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "堕光之誓跨护",
            None,
            Some(dragon_core_root.as_path()),
        )
        .unwrap();

        let effect = result.items[0].dragon_core_effect.as_ref().unwrap();
        assert_eq!(effect.texture, "gui/beibao/itemtip/pinzhi4.png");
        assert_eq!(effect.match_text, "品质=§#8f28b5非凡");
        assert!(effect.data_url.starts_with("data:image/png;base64,"));
        assert!(effect
            .image_path
            .ends_with("DragonCore/gui/beibao/itemtip/pinzhi4.png"));
        assert!(effect.config_path.ends_with("DragonCore/ItemEffect.yml"));
        assert_eq!(effect.line_number, 1);
    }

    #[test]
    fn attaches_dragon_core_font_images_from_fontconfig_yml_and_folder() {
        let directory = tempfile::tempdir().unwrap();
        let dragon_core_root = directory.path().join("client/resourcepacks/DragonCore");
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "tide_title:\n  name: '菲尔圣咏 §例 &矣 靐'\n  material: PAPER\n",
        );
        write_file(
            &directory.path().join("DragonCore/fontconfig.yml"),
            "例:\n  path: title/示例.gif\n  width: 38\n  height: 9\n  yOffset: 0\n  color: true\n  fontWidth: 2\n",
        );
        write_file(
            &directory.path().join("DragonCore/FontConfig/VIP.yml"),
            "尔:\n  path: title/VIP称号/VIP2.gif\n  width: 26\n  height: 9\n  color: true\n矣:\n  path: title/VIP称号/VIP3.gif\n  width: 26\n  height: 9\n  color: true\n",
        );
        write_file(
            &directory.path().join("DragonCore/FontConfig/属性.yml"),
            "靐:\n  path: sx/生命.png\n  width: 14\n  height: 14\n  yOffset: -3\n  color: false\n",
        );
        write_png(&dragon_core_root.join("title/示例.gif"));
        write_png(&dragon_core_root.join("title/VIP称号/VIP2.gif"));
        write_png(&dragon_core_root.join("title/VIP称号/VIP3.gif"));
        write_png(&dragon_core_root.join("sx/生命.png"));

        let result = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "菲尔",
            None,
            Some(dragon_core_root.as_path()),
        )
        .unwrap();

        let images = &result.items[0].dragon_core_font_images;
        assert_eq!(images.len(), 4);
        assert!(images.iter().any(|image| image.character == "例"
            && image.path == "title/示例.gif"
            && image.image_path.ends_with("DragonCore/title/示例.gif")
            && image.relative_config_path == "fontconfig.yml"
            && image.line_number == 1
            && image.width == 38.0
            && image.height == 9.0
            && image.color == Some(true)
            && image.font_width == Some(2.0)));
        assert!(images.iter().any(|image| image.character == "矣"
            && image.path == "title/VIP称号/VIP3.gif"
            && image.color == Some(true)));
        assert!(images.iter().any(|image| image.character == "尔"
            && image.path == "title/VIP称号/VIP2.gif"
            && image.color == Some(true)));
        assert!(images.iter().any(|image| image.character == "靐"
            && image.path == "sx/生命.png"
            && image
                .config_path
                .ends_with("DragonCore/FontConfig/属性.yml")));
    }

    #[test]
    fn attaches_dragon_core_font_images_to_mm_display() {
        let directory = tempfile::tempdir().unwrap();
        let dragon_core_root = directory.path().join("client/resourcepacks/DragonCore");
        write_file(
            &directory.path().join("MythicMobs/Items/items.yml"),
            "plain_badge:\n  Id: PAPER\n  Display: '示例徽记'\n\nexample_badge:\n  Id: PAPER\n  Display: '§例徽记'\n",
        );
        write_file(
            &directory.path().join("DragonCore/FontConfig.yml"),
            "例:\n  path: title/示例.gif\n  width: 38\n  height: 9\n  color: true\n",
        );
        write_png(&dragon_core_root.join("title/示例.gif"));

        let result = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Mm,
            "徽记",
            None,
            Some(dragon_core_root.as_path()),
        )
        .unwrap();

        let plain_badge = result
            .items
            .iter()
            .find(|item| item.item_key == "plain_badge")
            .unwrap();
        let example_badge = result
            .items
            .iter()
            .find(|item| item.item_key == "example_badge")
            .unwrap();

        assert_eq!(plain_badge.dragon_core_font_images.len(), 1);
        assert_eq!(plain_badge.dragon_core_font_images[0].character, "例");
        assert_eq!(example_badge.dragon_core_font_images.len(), 1);
        assert_eq!(example_badge.dragon_core_font_images[0].character, "例");
    }

    #[test]
    fn omits_dragon_core_item_icon_when_no_client_root_or_no_config_matches() {
        let directory = tempfile::tempdir().unwrap();
        write_file(
            &directory.path().join("NeigeItems/Items/items.yml"),
            "plain_boots:\n  name: '旅人靴'\n  material: LEATHER_BOOTS\n",
        );
        write_file(
            &directory.path().join("DragonCore/ItemIcon/装备.yml"),
            "哥布林太刀:\n  texture: zhuangbei/gblwq1.png\n  type: 263\n  match: \"哥布林太刀\"\n",
        );

        let without_client_root = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
            None,
        )
        .unwrap();

        let no_match = search_item_library_with_icons(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
            Some(directory.path()),
        )
        .unwrap();

        assert!(without_client_root.items[0].dragon_core_icon.is_none());
        assert!(no_match.items[0].dragon_core_icon.is_none());
    }

    #[test]
    fn parse_item_library_ignore_yaml_supports_shared_ni_mm_sections() {
        let parsed = parse_item_library_ignore_yaml(
            r#"
# 注释
shared:
  - 废弃/
  - "测试/草稿.yml"
paths:
  - common.yml
ni:
  - 旧版/
  - backup/*.yml
mm: [Deprecated/, temp/**]
"#,
        );
        assert_eq!(parsed.shared, vec!["废弃/", "测试/草稿.yml", "common.yml"]);
        assert_eq!(parsed.ni, vec!["旧版/", "backup/*.yml"]);
        assert_eq!(parsed.mm, vec!["Deprecated/", "temp/**"]);
    }

    #[test]
    fn ignore_rules_match_prefix_exact_and_wildcards() {
        assert!(relative_path_matches_ignore_rule("废弃/a.yml", "废弃/"));
        assert!(relative_path_matches_ignore_rule("废弃/a.yml", "废弃"));
        assert!(relative_path_matches_ignore_rule(
            "测试/草稿.yml",
            "测试/草稿.yml"
        ));
        assert!(!relative_path_matches_ignore_rule("正式/a.yml", "废弃/"));
        assert!(relative_path_matches_ignore_rule(
            "backup/old.yml",
            "backup/*.yml"
        ));
        assert!(relative_path_matches_ignore_rule(
            "temp/nested/a.yml",
            "temp/**"
        ));
        assert!(!relative_path_matches_ignore_rule(
            "backup/dir/old.yml",
            "backup/*.yml"
        ));
    }

    #[test]
    fn search_skips_files_from_project_item_library_ignore_config() {
        let directory = tempfile::tempdir().unwrap();
        write_file(
            &directory.path().join("NeigeItems/Items/keep.yml"),
            "keep_item:\n  name: '保留物品'\n  material: STONE\n",
        );
        write_file(
            &directory.path().join("NeigeItems/Items/废弃/trash.yml"),
            "trash_item:\n  name: '废弃物品'\n  material: DIRT\n",
        );
        write_file(
            &directory
                .path()
                .join("NeigeItems/Items/only_ni_blocked.yml"),
            "ni_blocked:\n  name: '仅NI屏蔽'\n  material: WOOD\n",
        );
        write_file(
            &directory.path().join("MythicMobs/Items/mm_keep.yml"),
            "mm_keep:\n  Display: 'MM保留'\n  Id: STONE\n",
        );
        write_file(
            &directory
                .path()
                .join("MythicMobs/Items/only_ni_blocked.yml"),
            "mm_same_name:\n  Display: 'MM同名'\n  Id: DIRT\n",
        );
        write_file(
            &directory.path().join(".superhigh/item-library-ignore.yml"),
            "shared:\n  - 废弃/\nni:\n  - only_ni_blocked.yml\nmm:\n  - missing-on-mm.yml\n",
        );

        let ni = search_item_library(
            directory.path(),
            ItemLibrarySource::Ni,
            "",
            None,
        )
        .unwrap();
        let mm = search_item_library(
            directory.path(),
            ItemLibrarySource::Mm,
            "",
            None,
        )
        .unwrap();

        assert_eq!(ni.items.len(), 1);
        assert_eq!(ni.items[0].item_key, "keep_item");
        assert_eq!(ni.ignored_path_count, 2);
        assert!(ni
            .ignore_config_path
            .as_deref()
            .unwrap()
            .replace('\\', "/")
            .ends_with(".superhigh/item-library-ignore.yml"));

        assert_eq!(mm.items.len(), 2);
        assert!(mm.items.iter().any(|item| item.item_key == "mm_keep"));
        assert!(mm.items.iter().any(|item| item.item_key == "mm_same_name"));
        assert_eq!(mm.ignored_path_count, 0);
    }
}
