use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::fs_ops::normalize_path;

pub const MONSTER_LIBRARY_DEFAULT_PAGE_SIZE: usize = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonsterLibrarySearchResponse {
    pub library_root_path: String,
    pub monsters: Vec<MythicMonster>,
    pub total_monsters: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MythicMonster {
    pub mob_key: String,
    pub display: Option<String>,
    /// Kept as text because MythicMobs configurations can exceed JavaScript's safe integer range.
    pub health: Option<String>,
    pub attributes: Vec<MythicMonsterAttribute>,
    pub file_path: String,
    pub relative_path: String,
    pub line_number: usize,
    pub yaml_block: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MythicMonsterAttribute {
    pub raw: String,
    pub name_raw: Option<String>,
    pub name: Option<String>,
    pub value_raw: Option<String>,
}

pub fn search_monster_library(
    project_path: &Path,
    query: &str,
    page: usize,
    page_size: usize,
) -> anyhow::Result<MonsterLibrarySearchResponse> {
    let library_root = workspace_monster_library_root(project_path)
        .ok_or_else(|| anyhow::anyhow!("当前工作区没有 MythicMobs 怪物目录"))?;
    let mut monsters = Vec::new();

    for file_path in yaml_files(&library_root) {
        let content = read_lossy(&file_path)?;
        monsters.extend(scan_monster_file(&library_root, &file_path, &content));
    }

    monsters.sort_by(|left, right| {
        left.relative_path
            .cmp(&right.relative_path)
            .then(left.line_number.cmp(&right.line_number))
    });

    let query = query.trim().to_lowercase();
    if !query.is_empty() {
        monsters.retain(|monster| {
            monster.mob_key.to_lowercase().contains(&query)
                || monster
                    .display
                    .as_deref()
                    .is_some_and(|display| display.to_lowercase().contains(&query))
        });
    }

    let total_monsters = monsters.len();
    let page = page.max(1);
    let page_size = page_size.max(1);
    let start = page.saturating_sub(1).saturating_mul(page_size);
    let monsters = monsters.into_iter().skip(start).take(page_size).collect();

    Ok(MonsterLibrarySearchResponse {
        library_root_path: normalize_path(&library_root),
        monsters,
        total_monsters,
        page,
        page_size,
    })
}

pub(crate) fn workspace_monster_library_root(project_path: &Path) -> Option<PathBuf> {
    let mut candidates = vec![
        project_path.join("plugins/MythicMobs/Mobs"),
        project_path.join("MythicMobs/Mobs"),
    ];
    let name = project_path.file_name()?.to_str()?;
    if name.eq_ignore_ascii_case("MythicMobs") {
        candidates.push(project_path.join("Mobs"));
    }
    if name.eq_ignore_ascii_case("Mobs") && project_path.parent()
        .and_then(|parent| parent.file_name()).and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("MythicMobs"))
    {
        candidates.push(project_path.to_path_buf());
    }
    let workspace = project_path.canonicalize().ok()?;
    candidates.into_iter().find(|candidate| candidate.is_dir()
        && candidate.canonicalize().is_ok_and(|path| path.starts_with(&workspace)))
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
    Ok(String::from_utf8_lossy(&fs::read(path)?).to_string())
}

fn scan_monster_file(library_root: &Path, file_path: &Path, content: &str) -> Vec<MythicMonster> {
    let content = content.trim_start_matches('\u{feff}');
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
        .map(|(position, (start_line, mob_key))| {
            let end_line = starts
                .get(position + 1)
                .map(|(line, _)| *line)
                .unwrap_or(lines.len());
            let block = &lines[*start_line..end_line];
            let direct_indent = direct_child_indent(block);
            let display = direct_scalar(block, direct_indent, "Display");
            let health = direct_scalar(block, direct_indent, "Health");
            MythicMonster {
                mob_key: mob_key.clone(),
                display,
                health,
                attributes: direct_attributes(block, direct_indent),
                file_path: normalize_path(file_path),
                relative_path: relative_path.clone(),
                line_number: start_line + 1,
                yaml_block: block.join("\n"),
            }
        })
        .collect()
}

fn top_level_key(line: &str) -> Option<String> {
    if line.starts_with(' ') || line.starts_with('\t') {
        return None;
    }
    let trimmed = line.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with('-')
        || trimmed.starts_with('.')
    {
        return None;
    }
    let (key, _) = trimmed.split_once(':')?;
    let key = key.trim().trim_matches('"').trim_matches('\'');
    (!key.is_empty()).then(|| key.to_string())
}

fn direct_child_indent(block: &[&str]) -> Option<usize> {
    block
        .iter()
        .skip(1)
        .filter_map(|line| {
            let trimmed = line.trim_start();
            (!trimmed.is_empty() && !trimmed.starts_with('#')).then_some(line.len() - trimmed.len())
        })
        .filter(|indent| *indent > 0)
        .min()
}

fn direct_scalar(block: &[&str], direct_indent: Option<usize>, field_name: &str) -> Option<String> {
    let (_, value) = direct_field(block, direct_indent, field_name)?;
    (!value.is_empty()).then_some(clean_yaml_scalar(value))
}

fn direct_attributes(block: &[&str], direct_indent: Option<usize>) -> Vec<MythicMonsterAttribute> {
    let Some((attribute_line, value)) = direct_field(block, direct_indent, "Attribute") else {
        return Vec::new();
    };
    if !value.is_empty() && !matches!(value.trim(), "null" | "~" | "[]") {
        return vec![parse_attribute(clean_yaml_scalar(value))];
    }

    let Some(direct_indent) = direct_indent else {
        return Vec::new();
    };
    let mut attributes = Vec::new();
    for line in block.iter().skip(attribute_line + 1) {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if indent < direct_indent || (indent == direct_indent && !trimmed.starts_with('-')) {
            break;
        }
        if indent == direct_indent && trimmed.starts_with('-') {
            attributes.push(parse_attribute(clean_yaml_scalar(
                trimmed.trim_start_matches('-'),
            )));
        }
    }
    attributes
}

fn direct_field<'a>(
    block: &'a [&str],
    direct_indent: Option<usize>,
    field_name: &str,
) -> Option<(usize, &'a str)> {
    let direct_indent = direct_indent?;
    block.iter().enumerate().skip(1).find_map(|(index, line)| {
        let trimmed = line.trim_start();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with('-')
            || line.len() - trimmed.len() != direct_indent
        {
            return None;
        }
        let (key, value) = trimmed.split_once(':')?;
        key.trim()
            .eq_ignore_ascii_case(field_name)
            .then_some((index, value.trim()))
    })
}

fn clean_yaml_scalar(value: &str) -> String {
    let value = strip_yaml_comment(value).trim();
    if value.len() >= 2 {
        let bytes = value.as_bytes();
        if bytes[0] == b'\'' && bytes[value.len() - 1] == b'\'' {
            return value[1..value.len() - 1].replace("''", "'");
        }
        if bytes[0] == b'"' && bytes[value.len() - 1] == b'"' {
            return value[1..value.len() - 1].replace(r#"\""#, "\"");
        }
    }
    value.to_string()
}

fn strip_yaml_comment(value: &str) -> &str {
    let mut quoted = None;
    let mut previous_was_whitespace = true;
    for (index, character) in value.char_indices() {
        match (quoted, character) {
            (Some('\''), '\'') => quoted = None,
            (Some('"'), '"') => quoted = None,
            (None, '\'' | '"') => quoted = Some(character),
            (None, '#') if previous_was_whitespace => return &value[..index],
            _ => {}
        }
        previous_was_whitespace = character.is_whitespace();
    }
    value
}

fn parse_attribute(raw: String) -> MythicMonsterAttribute {
    let (name_raw, value_raw) = raw
        .split_once(':')
        .map(|(name, value)| {
            (
                Some(name.trim().to_string()),
                Some(value.trim().to_string()),
            )
        })
        .unwrap_or((None, None));
    let name = name_raw
        .as_deref()
        .map(strip_minecraft_color_codes)
        .filter(|name| !name.is_empty());
    MythicMonsterAttribute {
        raw,
        name_raw,
        name,
        value_raw,
    }
}

fn strip_minecraft_color_codes(value: &str) -> String {
    let mut result = String::new();
    let mut skip_next = false;
    for character in value.chars() {
        if skip_next {
            skip_next = false;
        } else if character == '&' || character == '§' {
            skip_next = true;
        } else {
            result.push(character);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::search_monster_library;
    use std::path::Path;

    fn write_file(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn scans_monsters_with_exact_health_and_attributes() {
        let directory = tempfile::tempdir().unwrap();
        let mobs = directory.path().join("plugins/MythicMobs/Mobs/raid");
        let file = mobs.join("bosses.yml");
        write_file(
            &file,
            "\u{feff}ancient_boss:\n  Display: '&c远古首领'\n  Health: 30000000000000000000 # must stay exact\n  Attribute:\n  - '&c攻击力: 12000000000000'\n  - '护甲值 30'\n  Options:\n    FollowRange: 40\n\nplain_mob:\n  Health: 30\n  Attribute: null\n",
        );

        let result = search_monster_library(directory.path(), "首领", 1, 50).unwrap();
        assert_eq!(
            result.library_root_path,
            mobs.parent().unwrap().to_string_lossy().replace('\\', "/")
        );
        assert_eq!(result.total_monsters, 1);
        let monster = &result.monsters[0];
        assert_eq!(monster.mob_key, "ancient_boss");
        assert_eq!(monster.display.as_deref(), Some("&c远古首领"));
        assert_eq!(monster.health.as_deref(), Some("30000000000000000000"));
        assert_eq!(monster.attributes.len(), 2);
        assert_eq!(monster.attributes[0].name_raw.as_deref(), Some("&c攻击力"));
        assert_eq!(monster.attributes[0].name.as_deref(), Some("攻击力"));
        assert_eq!(
            monster.attributes[0].value_raw.as_deref(),
            Some("12000000000000")
        );
        assert_eq!(monster.attributes[1].raw, "护甲值 30");
        assert!(monster.attributes[1].name.is_none());
        assert!(monster.yaml_block.contains("FollowRange: 40"));
    }

    #[test]
    fn returns_all_matching_duplicate_keys_and_paginates() {
        let directory = tempfile::tempdir().unwrap();
        let mobs = directory.path().join("plugins/MythicMobs/Mobs");
        write_file(
            &mobs.join("one.yml"),
            "template:\n  Display: '模板一'\n  Health: 1\n",
        );
        write_file(
            &mobs.join("nested/two.yaml"),
            "template:\n  Display: '模板二'\n  Health: 2\n",
        );

        let result = search_monster_library(directory.path(), "template", 2, 1).unwrap();
        assert_eq!(result.total_monsters, 2);
        assert_eq!(result.page, 2);
        assert_eq!(result.page_size, 1);
        assert_eq!(result.monsters.len(), 1);
        assert_eq!(result.monsters[0].display.as_deref(), Some("模板一"));
    }

    #[test]
    fn unrelated_workspace_does_not_load_parent_or_sibling_monsters() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("plugins/MythicMobs/Mobs")).unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        assert!(super::workspace_monster_library_root(&workspace).is_none());
        assert!(search_monster_library(&workspace, "", 1, 50).is_err());
        for project in [root.path().to_path_buf(), root.path().join("plugins"),
            root.path().join("plugins/MythicMobs"), root.path().join("plugins/MythicMobs/Mobs")] {
            assert!(super::workspace_monster_library_root(&project).is_some());
        }
    }
}
