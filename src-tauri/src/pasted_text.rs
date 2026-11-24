use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use anyhow::Context;

use crate::fs_ops::normalize_path;

/// SuperHigh 输入框导出的长文本统一带此前缀，`@` 引用只列出带前缀的文件。
pub const PASTED_TEXT_PREFIX: &str = "SH粘贴-";
const PASTED_TEXT_EXTENSION: &str = "txt";
const MAX_PASTED_TEXT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PastedTextFile {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: u64,
}

fn agent_tmp_directory(project_path: &Path, create: bool) -> anyhow::Result<Option<PathBuf>> {
    let root = project_path.canonicalize().context("工作区不存在")?;
    if !root.is_dir() {
        anyhow::bail!("工作区不是目录");
    }
    let mut directory = root.clone();
    for part in [".agent", "tmp"] {
        directory.push(part);
        if !directory.exists() {
            if !create {
                return Ok(None);
            }
            fs::create_dir(&directory)?;
        }
        directory = directory.canonicalize()?;
        if !directory.starts_with(&root) || !directory.is_dir() {
            anyhow::bail!(".agent/tmp 超出工作区范围");
        }
    }
    Ok(Some(directory))
}

fn file_entry(path: &Path) -> anyhow::Result<PastedTextFile> {
    let metadata = fs::metadata(path)?;
    Ok(PastedTextFile {
        path: normalize_path(path),
        name: path.file_name().and_then(|n| n.to_str()).unwrap_or_default().into(),
        size: metadata.len(),
        modified_ms: metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0),
    })
}

/// `stamp` 由前端按本地时间生成，例如 `2026年10月21日14时05分33秒`。
pub fn save_pasted_text(project_path: &Path, stamp: &str, content: &str) -> anyhow::Result<PastedTextFile> {
    if stamp.is_empty() || stamp.chars().count() > 32
        || !stamp.chars().all(|c| c.is_ascii_digit() || "年月日时分秒".contains(c))
    {
        anyhow::bail!("粘贴文本时间戳无效");
    }
    if content.len() > MAX_PASTED_TEXT_BYTES {
        anyhow::bail!("粘贴文本不能超过 32 MiB");
    }
    let directory = agent_tmp_directory(project_path, true)?.context("无法创建 .agent/tmp")?;
    for index in 1..1000 {
        let suffix = if index == 1 { String::new() } else { format!("-{index}") };
        let path = directory.join(format!("{PASTED_TEXT_PREFIX}{stamp}{suffix}.{PASTED_TEXT_EXTENSION}"));
        let mut output = match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error).context("保存粘贴文本失败"),
        };
        output.write_all(content.as_bytes()).context("保存粘贴文本失败")?;
        drop(output);
        return file_entry(&path);
    }
    anyhow::bail!("同一秒内粘贴文本过多")
}

/// 列出 `.agent/tmp` 根层由输入框导出的文本，最新在前。
pub fn list_pasted_texts(project_path: &Path) -> anyhow::Result<Vec<PastedTextFile>> {
    let Some(directory) = agent_tmp_directory(project_path, false)? else {
        return Ok(Vec::new());
    };
    let mut files: Vec<PastedTextFile> = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(PASTED_TEXT_PREFIX) && name.ends_with(&format!(".{PASTED_TEXT_EXTENSION}"))
        })
        .filter_map(|entry| file_entry(&entry.path()).ok())
        .collect();
    files.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| b.name.cmp(&a.name)));
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::{list_pasted_texts, save_pasted_text};

    #[test]
    fn saves_marked_text_under_agent_tmp_without_overwriting() {
        let directory = tempfile::tempdir().unwrap();
        let stamp = "2026年10月21日14时05分33秒";
        let first = save_pasted_text(directory.path(), stamp, "第一段").unwrap();
        let second = save_pasted_text(directory.path(), stamp, "第二段").unwrap();
        assert_eq!(first.name, "SH粘贴-2026年10月21日14时05分33秒.txt");
        assert_eq!(second.name, "SH粘贴-2026年10月21日14时05分33秒-2.txt");
        assert!(first.path.contains("/.agent/tmp/"));
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), "第一段");
        std::fs::write(directory.path().join(".agent/tmp/other.txt"), "x").unwrap();
        let names: Vec<_> = list_pasted_texts(directory.path()).unwrap().into_iter().map(|f| f.name).collect();
        assert_eq!(names.len(), 2);
        assert!(names.iter().all(|name| name.starts_with("SH粘贴-")));
    }

    #[test]
    fn rejects_unsafe_stamp_and_lists_nothing_without_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(list_pasted_texts(directory.path()).unwrap().is_empty());
        for stamp in ["", "../x", "2026/10", "a年"] {
            assert!(save_pasted_text(directory.path(), stamp, "x").is_err());
        }
        assert!(!directory.path().join(".agent").exists());
    }
}
