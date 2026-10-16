use std::path::{Path, PathBuf};

// CLI tool headers shorten directory names with … or ... . Never guess between matches.
pub(crate) fn resolve(path: &Path) -> Option<PathBuf> {
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
