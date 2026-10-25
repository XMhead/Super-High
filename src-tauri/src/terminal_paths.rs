use std::path::{Path, PathBuf};

// CLI tool headers shorten directory names with … or ... . Never guess between matches.
pub(crate) fn resolve(path: &Path) -> Option<PathBuf> {
    let expanded = expand_environment_prefix(path)?;
    let path = expanded.as_path();
    if path.exists() { return Some(path.to_path_buf()); }
    let mut candidates = vec![PathBuf::new()];
    let mut budget = 4096usize;
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        if !name.contains('…') && !name.contains("...") {
            for candidate in &mut candidates { candidate.push(component.as_os_str()); }
            continue;
        }
        let pattern = name.replace('…', "...");
        let mut next = Vec::new();
        for parent in candidates {
            let Ok(entries) = std::fs::read_dir(parent) else { continue };
            for entry in entries {
                budget = budget.checked_sub(1)?;
                let Ok(entry) = entry else { continue };
                if matches_abbreviation(&entry.file_name().to_string_lossy(), &pattern) {
                    next.push(entry.path());
                }
            }
        }
        candidates = next;
    }
    let mut matches = candidates.into_iter().filter(|path| path.exists());
    let only = matches.next()?;
    matches.next().is_none().then_some(only)
}

// Expand a leading environment variable only; terminal text is never executed.
fn expand_environment_prefix(path: &Path) -> Option<PathBuf> {
    static PREFIX: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r"(?i)^(?:\$env:([a-z_][a-z0-9_]*)|\$\{env:([a-z_][a-z0-9_]*)\}|%([a-z_][a-z0-9_]*)%)[\\/]").unwrap()
    });
    let text = path.to_string_lossy();
    let Some(captures) = PREFIX.captures(&text) else { return Some(path.to_path_buf()) };
    let name = captures.get(1).or_else(|| captures.get(2)).or_else(|| captures.get(3))?;
    let root = std::env::var_os(name.as_str()).filter(|value| !value.is_empty())?;
    Some(PathBuf::from(root).join(&text[captures.get(0)?.end()..]))
}

fn matches_abbreviation(name: &str, pattern: &str) -> bool {
    let name = name.to_lowercase();
    let pattern = pattern.to_lowercase();
    let parts: Vec<_> = pattern.split("...").collect();
    if !name.starts_with(parts[0]) { return false }
    let mut rest = &name[parts[0].len()..];
    for (index, part) in parts.iter().enumerate().skip(1) {
        if index == parts.len() - 1 { return rest.ends_with(part); }
        let Some(at) = rest.find(part) else { return false };
        rest = &rest[at + part.len()..];
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expands_environment_paths_without_executing_shell_text() {
        let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let root = PathBuf::from(std::env::var_os(variable).unwrap());
        for prefix in [format!("$env:{variable}"), format!("${{env:{variable}}}"), format!("%{variable}%")] {
            assert_eq!(expand_environment_prefix(Path::new(&format!("{prefix}/global.md"))), Some(root.join("global.md")));
            assert_eq!(resolve(Path::new(&format!("{prefix}/."))), Some(root.join(".")));
        }
        assert_eq!(expand_environment_prefix(Path::new("$env:SUPERHIGH_NONEXISTENT_PATH_TEST/file.md")), None);
        assert_eq!(expand_environment_prefix(Path::new("$(Get-Location)/file.md")), Some(PathBuf::from("$(Get-Location)/file.md")));
    }
    #[test]
    fn resolves_only_unique_existing_targets() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("blockbench-animation");
        std::fs::create_dir(&first).unwrap();
        std::fs::write(first.join("authoring.md"), "").unwrap();
        assert_eq!(resolve(&dir.path().join("blockbench-ani…/authoring.md")), Some(first.join("authoring.md")));
        assert_eq!(resolve(&dir.path().join("blockbench-ani.../authoring.md")), Some(first.join("authoring.md")));
        let other = dir.path().join("blockbench-animator");
        std::fs::create_dir(&other).unwrap();
        std::fs::write(other.join("authoring.md"), "").unwrap();
        assert_eq!(resolve(&dir.path().join("blockbench-ani…/authoring.md")), None);
        assert_eq!(resolve(&dir.path().join("blockbench-ani…/missing.md")), None);
    }
}
