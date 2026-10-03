use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;

use crate::{
    fs_ops::normalize_path,
    models::{
        ProjectInstructionFileKind, ProjectInstructionFileStatus, ProjectInstructionFiles,
        ProjectInstructionMigrationResult,
    },
};

pub fn discover_project_instruction_files(
    project_root: &Path,
) -> anyhow::Result<ProjectInstructionFiles> {
    if !project_root.is_dir() {
        anyhow::bail!(
            "project path is not a directory: {}",
            project_root.display()
        );
    }

    let files = [
        ProjectInstructionFileKind::Agents,
        ProjectInstructionFileKind::Claude,
    ]
    .into_iter()
    .map(|kind| project_instruction_file_status(project_root, kind))
    .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(ProjectInstructionFiles {
        project_path: normalize_path(project_root),
        files,
    })
}

pub fn migrate_project_instruction_file(
    project_root: &Path,
    source_kind: ProjectInstructionFileKind,
    target_kind: ProjectInstructionFileKind,
) -> anyhow::Result<ProjectInstructionMigrationResult> {
    if source_kind == target_kind {
        anyhow::bail!("source and target instruction files are the same");
    }
    if !project_root.is_dir() {
        anyhow::bail!(
            "project path is not a directory: {}",
            project_root.display()
        );
    }

    let source_path = project_instruction_file_path(project_root, &source_kind);
    let target_path = project_instruction_file_path(project_root, &target_kind);
    let source_bytes = fs::read(&source_path)
        .with_context(|| format!("failed to read {}", source_path.display()))?;
    let source_size = source_bytes.len() as u64;
    let source_content = rewrite_instruction_content(&source_bytes, &source_kind, &target_kind);

    if target_path.exists() {
        let target_content = fs::read(&target_path)
            .with_context(|| format!("failed to read {}", target_path.display()))?;
        if target_content == source_content {
            return Ok(ProjectInstructionMigrationResult {
                source_kind,
                target_kind,
                source_path: normalize_path(&source_path),
                target_path: normalize_path(&target_path),
                copied: false,
                skipped: true,
                overwritten: false,
                backup_path: None,
                bytes: source_size,
            });
        }

        let backup_path = backup_instruction_file(project_root, &target_path)?;
        fs::write(&target_path, &source_content)
            .with_context(|| format!("failed to write {}", target_path.display()))?;
        return Ok(ProjectInstructionMigrationResult {
            source_kind,
            target_kind,
            source_path: normalize_path(&source_path),
            target_path: normalize_path(&target_path),
            copied: true,
            skipped: false,
            overwritten: true,
            backup_path: Some(normalize_path(&backup_path)),
            bytes: source_size,
        });
    }

    fs::write(&target_path, &source_content)
        .with_context(|| format!("failed to write {}", target_path.display()))?;
    Ok(ProjectInstructionMigrationResult {
        source_kind,
        target_kind,
        source_path: normalize_path(&source_path),
        target_path: normalize_path(&target_path),
        copied: true,
        skipped: false,
        overwritten: false,
        backup_path: None,
        bytes: source_size,
    })
}

fn project_instruction_file_status(
    project_root: &Path,
    kind: ProjectInstructionFileKind,
) -> anyhow::Result<ProjectInstructionFileStatus> {
    let file_name = project_instruction_file_name(&kind).to_string();
    let file_path = project_instruction_file_path(project_root, &kind);
    if !file_path.exists() {
        return Ok(ProjectInstructionFileStatus {
            kind,
            file_name,
            file_path: normalize_path(&file_path),
            exists: false,
            size_bytes: 0,
            line_count: 0,
            modified: None,
        });
    }

    let metadata = fs::metadata(&file_path)
        .with_context(|| format!("failed to read metadata for {}", file_path.display()))?;
    let bytes =
        fs::read(&file_path).with_context(|| format!("failed to read {}", file_path.display()))?;
    let content = String::from_utf8_lossy(&bytes);

    Ok(ProjectInstructionFileStatus {
        kind,
        file_name,
        file_path: normalize_path(&file_path),
        exists: true,
        size_bytes: metadata.len(),
        line_count: content.lines().count(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_secs()),
    })
}

fn backup_instruction_file(project_root: &Path, target_path: &Path) -> anyhow::Result<PathBuf> {
    let file_name = target_path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "instruction.md".to_string());
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut backup_path = project_root.join(format!("{file_name}.superhigh-backup-{timestamp}"));
    let mut index = 1usize;
    while backup_path.exists() {
        backup_path =
            project_root.join(format!("{file_name}.superhigh-backup-{timestamp}-{index}"));
        index += 1;
    }
    fs::copy(target_path, &backup_path).with_context(|| {
        format!(
            "failed to backup {} to {}",
            target_path.display(),
            backup_path.display()
        )
    })?;
    Ok(backup_path)
}

fn project_instruction_file_path(
    project_root: &Path,
    kind: &ProjectInstructionFileKind,
) -> PathBuf {
    project_root.join(project_instruction_file_name(kind))
}

fn project_instruction_file_name(kind: &ProjectInstructionFileKind) -> &'static str {
    match kind {
        ProjectInstructionFileKind::Agents => "AGENTS.md",
        ProjectInstructionFileKind::Claude => "CLAUDE.md",
    }
}

fn rewrite_instruction_content(
    source_bytes: &[u8],
    source_kind: &ProjectInstructionFileKind,
    target_kind: &ProjectInstructionFileKind,
) -> Vec<u8> {
    let (from, to) = match (source_kind, target_kind) {
        (ProjectInstructionFileKind::Agents, ProjectInstructionFileKind::Claude) => {
            (".codex", ".claude")
        }
        (ProjectInstructionFileKind::Claude, ProjectInstructionFileKind::Agents) => {
            (".claude", ".codex")
        }
        _ => return source_bytes.to_vec(),
    };
    let content = String::from_utf8_lossy(source_bytes);
    content
        .replace(&format!("{from}/skills/"), &format!("{to}/skills/"))
        .replace(&format!("{from}\\skills\\"), &format!("{to}\\skills\\"))
        .replace(
            &format!("{from}/skills-backup/"),
            &format!("{to}/skills-backup/"),
        )
        .replace(
            &format!("{from}\\skills-backup\\"),
            &format!("{to}\\skills-backup\\"),
        )
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::{discover_project_instruction_files, migrate_project_instruction_file};
    use crate::models::ProjectInstructionFileKind;

    #[test]
    fn discovers_project_instruction_files() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("AGENTS.md"), "# Rules\n").unwrap();

        let files = discover_project_instruction_files(temp.path()).unwrap();

        assert_eq!(files.files.len(), 2);
        assert!(files.files[0].exists);
        assert!(!files.files[1].exists);
    }

    #[test]
    fn instruction_migration_copies_agents_to_claude() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("AGENTS.md"), "# Rules\n\nKeep the local stack.\n").unwrap();

        let result = migrate_project_instruction_file(
            root,
            ProjectInstructionFileKind::Agents,
            ProjectInstructionFileKind::Claude,
        )
        .unwrap();

        assert!(result.copied);
        assert_eq!(
            fs::read_to_string(root.join("CLAUDE.md")).unwrap(),
            "# Rules\n\nKeep the local stack.\n"
        );
    }

    #[test]
    fn instruction_migration_backs_up_existing_target() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("CLAUDE.md"), "new content\n").unwrap();
        fs::write(root.join("AGENTS.md"), "old content\n").unwrap();

        let result = migrate_project_instruction_file(
            root,
            ProjectInstructionFileKind::Claude,
            ProjectInstructionFileKind::Agents,
        )
        .unwrap();

        assert!(result.overwritten);
        assert_eq!(
            fs::read_to_string(result.backup_path.unwrap()).unwrap(),
            "old content\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "new content\n"
        );
    }
}
