//! Interactive uninstall only; no Tauri runtime or terminal processes are started here.
use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{ensure, Context};
use rusqlite::{Connection, OpenFlags};

fn registered_projects(database: &Path) -> anyhow::Result<Vec<PathBuf>> {
    if !database.try_exists()? {
        return Ok(Vec::new());
    }
    let connection = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let has_registry: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_data_registry')",
        [], |row| row.get(0),
    )?;
    let sql = if has_registry {
        "SELECT path FROM project_data_registry UNION SELECT path FROM recent_projects ORDER BY path"
    } else {
        "SELECT path FROM recent_projects ORDER BY path"
    };
    let mut statement = connection.prepare(sql)?;
    let paths = statement
        .query_map([], |row| row.get::<_, String>(0))?
        .map(|row| row.map(PathBuf::from))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(paths)
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn cleanup_target(project: &Path) -> anyhow::Result<Option<PathBuf>> {
    ensure!(
        project.is_absolute(),
        "项目路径不是绝对路径：{}",
        project.display()
    );
    ensure!(
        !project
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir)),
        "项目路径含有上级跳转：{}",
        project.display()
    );
    let target = project.join(".superhigh");
    // Reject redirected ancestors as well as a linked .superhigh root. Nested links
    // are removed as links by remove_dir_all, never recursively followed.
    for path in target.ancestors() {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| format!("无法检查 {}", path.display()))
            }
        };
        ensure!(
            !is_link(&metadata),
            "保留链接或重定向目录：{}",
            path.display()
        );
        ensure!(metadata.is_dir(), "路径不是目录：{}", path.display());
    }
    Ok(Some(target))
}

fn remove_project_data(project: &Path) -> anyhow::Result<()> {
    if let Some(target) = cleanup_target(project)? {
        fs::remove_dir_all(&target).with_context(|| format!("无法删除 {}", target.display()))?;
        ensure!(!target.try_exists()?, "目录仍然存在：{}", target.display());
    }
    Ok(())
}

pub fn run(database: &Path) -> anyhow::Result<()> {
    let mut projects = Vec::new();
    let mut errors = Vec::new();
    for project in registered_projects(database)? {
        match cleanup_target(&project) {
            Ok(Some(_)) => projects.push(project),
            Ok(None) => {}
            Err(error) => errors.push(error.to_string()),
        }
    }
    // Small pages keep every exact path readable even with many registered projects.
    let pages = projects.len().div_ceil(6);
    for (index, page) in projects.chunks(6).enumerate() {
        let paths = page
            .iter()
            .map(|p| p.join(".superhigh").display().to_string())
            .collect::<Vec<_>>()
            .join("\n\n");
        let delete = "删除本页项目数据";
        let answer = rfd::MessageDialog::new()
            .set_title(format!("Super High 卸载 — 项目数据 {}/{}", index + 1, pages))
            .set_level(rfd::MessageLevel::Warning)
            .set_description(format!("是否同时永久删除以下目录？其中包含项目配置、扩展页面和粘贴图片。外层项目文件保留。\n\n{paths}\n\n默认保留；关闭此窗口将保留所有尚未处理的项目数据并继续卸载。"))
            .set_buttons(rfd::MessageButtons::OkCancelCustom("保留本页项目数据".into(), delete.into()))
            .show();
        match answer {
            rfd::MessageDialogResult::Custom(value) if value == delete => {
                for project in page {
                    if let Err(error) = remove_project_data(project) {
                        errors.push(format!("{error:#}"));
                    }
                }
            }
            rfd::MessageDialogResult::Custom(_) => {}
            _ => break,
        }
    }
    for page in errors.chunks(6) {
        rfd::MessageDialog::new()
            .set_title("Super High — 部分项目数据未清理")
            .set_level(rfd::MessageLevel::Warning)
            .set_description(page.join("\n\n"))
            .show();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::AppDb, models::RecentProject};

    #[test]
    fn registration_survives_removal_from_recents_and_imports_legacy_history() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("super-high.db");
        let old = Connection::open(&database).unwrap();
        old.execute_batch("CREATE TABLE recent_projects(path TEXT PRIMARY KEY, name TEXT NOT NULL, last_opened_at TEXT NOT NULL);
            INSERT INTO recent_projects VALUES ('D:/legacy', 'legacy', 'now');").unwrap();
        drop(old);
        let db = AppDb::new(temp.path()).unwrap();
        db.remove_recent_project("D:/legacy").unwrap();
        db.upsert_recent_project(&RecentProject {
            path: "D:/new".into(),
            name: "new".into(),
            last_opened_at: "now".into(),
        })
        .unwrap();
        db.remove_recent_project("D:/new").unwrap();
        assert_eq!(
            registered_projects(&database).unwrap(),
            vec![PathBuf::from("D:/legacy"), PathBuf::from("D:/new")]
        );
    }

    #[test]
    fn removes_only_project_data_and_handles_missing_paths() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".superhigh/editor")).unwrap();
        fs::write(temp.path().join(".superhigh/editor/page.html"), "page").unwrap();
        fs::write(temp.path().join("source.txt"), "keep").unwrap();
        remove_project_data(temp.path()).unwrap();
        remove_project_data(temp.path()).unwrap();
        assert!(!temp.path().join(".superhigh").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("source.txt")).unwrap(),
            "keep"
        );
        assert!(cleanup_target(Path::new("relative")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn rejects_redirected_root_and_preserves_nested_link_target() {
        use std::os::windows::fs::symlink_dir;
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let outside = temp.path().join("outside");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep").unwrap();
        symlink_dir(&outside, project.join(".superhigh")).unwrap();
        assert!(remove_project_data(&project).is_err());
        fs::remove_dir(project.join(".superhigh")).unwrap();
        fs::create_dir(project.join(".superhigh")).unwrap();
        symlink_dir(&outside, project.join(".superhigh/link")).unwrap();
        remove_project_data(&project).unwrap();
        assert!(outside.join("keep.txt").is_file());
    }
}
