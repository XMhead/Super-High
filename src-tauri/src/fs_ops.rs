use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::Context;
use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::models::{
    DirectoryListing, FileEntry, FileEntryType, FileOperationResult, ProjectFileMatch,
    ProjectSearchOptions, ProjectSearchResult, TextSearchMatch,
};

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "logs",
    ".superhigh",
    "coverage",
    ".vite",
    ".turbo",
    ".next",
    "out",
    "skills-backup",
];
const MAX_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SEARCH_TEXT_FILE_BYTES: u64 = MAX_TEXT_FILE_BYTES;
const MAX_IMAGE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MEDIA_FILE_BYTES: u64 = 128 * 1024 * 1024;

pub fn list_directory(path: &Path) -> anyhow::Result<DirectoryListing> {
    let mut entries = Vec::new();
    for item in fs::read_dir(path)
        .with_context(|| format!("failed to read directory {}", path.display()))?
    {
        let item = item?;
        let metadata = item.metadata()?;
        let item_path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        let entry_type = if metadata.is_dir() {
            FileEntryType::Directory
        } else {
            FileEntryType::File
        };
        entries.push(FileEntry {
            name,
            path: normalize_path(&item_path),
            entry_type,
            extension: item_path
                .extension()
                .map(|value| format!(".{}", value.to_string_lossy())),
            size: metadata.is_file().then_some(metadata.len()),
            modified: metadata.modified().ok().and_then(|value| {
                value
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|duration| duration.as_millis() as u64)
            }),
            is_hidden: item_path
                .file_name()
                .map(|value| value.to_string_lossy().starts_with('.'))
                .unwrap_or(false),
        });
    }
    entries.sort_by(|left, right| match (&left.entry_type, &right.entry_type) {
        (FileEntryType::Directory, FileEntryType::File) => std::cmp::Ordering::Less,
        (FileEntryType::File, FileEntryType::Directory) => std::cmp::Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });
    Ok(DirectoryListing {
        path: normalize_path(path),
        entries,
    })
}

pub fn read_text_file(path: &Path) -> anyhow::Result<String> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to inspect file {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("{} is not a file", path.display());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        anyhow::bail!(
            "file is too large for the built-in text editor ({} MB limit)",
            MAX_TEXT_FILE_BYTES / 1024 / 1024
        );
    }
    if !is_probably_text(path) {
        anyhow::bail!("file type is not supported by the built-in text editor");
    }
    let bytes =
        fs::read(path).with_context(|| format!("failed to read file {}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

pub fn read_image_as_data_url(path: &Path) -> anyhow::Result<String> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to inspect file {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("{} is not a file", path.display());
    }
    if metadata.len() > MAX_IMAGE_FILE_BYTES {
        anyhow::bail!(
            "image is too large for the built-in preview ({} MB limit)",
            MAX_IMAGE_FILE_BYTES / 1024 / 1024
        );
    }
    let mime = image_mime_type(path)
        .ok_or_else(|| anyhow::anyhow!("image type is not supported by the built-in preview"))?;
    let bytes =
        fs::read(path).with_context(|| format!("failed to read file {}", path.display()))?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

pub fn read_media_as_data_url(path: &Path) -> anyhow::Result<String> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to inspect file {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("{} is not a file", path.display());
    }
    if metadata.len() > MAX_MEDIA_FILE_BYTES {
        anyhow::bail!(
            "media file is too large for preview ({} MB limit)",
            MAX_MEDIA_FILE_BYTES / 1024 / 1024
        );
    }
    let mime = media_mime_type(path)
        .ok_or_else(|| anyhow::anyhow!("media type is not supported by the built-in preview"))?;
    let bytes =
        fs::read(path).with_context(|| format!("failed to read file {}", path.display()))?;
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

pub fn resolve_super_high_root() -> anyhow::Result<PathBuf> {
    let cwd = std::env::current_dir().context("failed to resolve current directory")?;
    if let Some(root) = find_super_high_root_from(&cwd) {
        return Ok(root);
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(root) = find_super_high_root_from(parent) {
                return Ok(root);
            }
        }
    }

    Ok(cwd)
}

pub fn write_text_file(path: &Path, content: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("failed to create temporary file for {}", path.display()))?;
    temporary
        .write_all(content.as_bytes())
        .with_context(|| format!("failed to write temporary file for {}", path.display()))?;
    temporary
        .as_file()
        .sync_all()
        .with_context(|| format!("failed to flush temporary file for {}", path.display()))?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("failed to replace file {}", path.display()))?;
    Ok(())
}

pub fn create_empty_file(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        anyhow::bail!("path already exists: {}", path.display());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("failed to create file {}", path.display()))?;
    Ok(())
}

pub fn create_directory(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        anyhow::bail!("path already exists: {}", path.display());
    }
    fs::create_dir_all(path)
        .with_context(|| format!("failed to create directory {}", path.display()))?;
    Ok(())
}

pub fn rename_path(path: &Path, new_path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        anyhow::bail!("path does not exist: {}", path.display());
    }
    if new_path.exists() {
        anyhow::bail!("target already exists: {}", new_path.display());
    }
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(path, new_path).with_context(|| {
        format!(
            "failed to rename {} to {}",
            path.display(),
            new_path.display()
        )
    })?;
    Ok(())
}

pub fn delete_path(path: &Path) -> anyhow::Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to inspect path {}", path.display()))?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
            .with_context(|| format!("failed to delete directory {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("failed to delete file {}", path.display()))?;
    }
    Ok(())
}

pub fn copy_paths_to_directory(
    paths: &[String],
    target_directory: &Path,
) -> anyhow::Result<Vec<FileOperationResult>> {
    if !target_directory.is_dir() {
        anyhow::bail!("target is not a directory: {}", target_directory.display());
    }
    Ok(paths
        .iter()
        .map(|path| copy_one_path_to_directory(Path::new(path), target_directory))
        .collect())
}

pub fn move_paths_to_directory(
    paths: &[String],
    target_directory: &Path,
) -> anyhow::Result<Vec<FileOperationResult>> {
    if !target_directory.is_dir() {
        anyhow::bail!("target is not a directory: {}", target_directory.display());
    }
    Ok(paths
        .iter()
        .map(|path| move_one_path_to_directory(Path::new(path), target_directory))
        .collect())
}

fn copy_one_path_to_directory(source: &Path, target_directory: &Path) -> FileOperationResult {
    let source_path = normalize_path(source);
    let result = (|| -> anyhow::Result<PathBuf> {
        if !source.exists() {
            anyhow::bail!("source does not exist: {}", source.display());
        }
        if source.is_dir() && path_is_same_or_descendant(target_directory, source) {
            anyhow::bail!("cannot copy a directory into itself or one of its children");
        }
        let file_name = source
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("source has no file name: {}", source.display()))?;
        let target = unique_destination(target_directory, file_name);
        if source.is_dir() {
            copy_directory_recursive(source, &target)?;
        } else if source.is_file() {
            fs::copy(source, &target).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source.display(),
                    target.display()
                )
            })?;
        } else {
            anyhow::bail!(
                "source is not a regular file or directory: {}",
                source.display()
            );
        }
        Ok(target)
    })();
    file_operation_result(source_path, result)
}

fn move_one_path_to_directory(source: &Path, target_directory: &Path) -> FileOperationResult {
    let source_path = normalize_path(source);
    let result = (|| -> anyhow::Result<PathBuf> {
        if !source.exists() {
            anyhow::bail!("source does not exist: {}", source.display());
        }
        if source.is_dir() && path_is_same_or_descendant(target_directory, source) {
            anyhow::bail!("cannot move a directory into itself or one of its children");
        }
        let file_name = source
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("source has no file name: {}", source.display()))?;
        let target = unique_destination(target_directory, file_name);
        if let Err(rename_error) = fs::rename(source, &target) {
            if source.is_dir() {
                copy_directory_recursive(source, &target)?;
                fs::remove_dir_all(source).with_context(|| {
                    format!(
                        "failed to remove original directory after copy fallback: {}",
                        source.display()
                    )
                })?;
            } else if source.is_file() {
                fs::copy(source, &target).with_context(|| {
                    format!(
                        "failed to copy {} to {}",
                        source.display(),
                        target.display()
                    )
                })?;
                fs::remove_file(source).with_context(|| {
                    format!(
                        "failed to remove original file after copy fallback: {}",
                        source.display()
                    )
                })?;
            } else {
                return Err(rename_error).with_context(|| {
                    format!(
                        "failed to move {} to {}",
                        source.display(),
                        target.display()
                    )
                });
            }
        }
        Ok(target)
    })();
    file_operation_result(source_path, result)
}

fn file_operation_result(
    source_path: String,
    result: anyhow::Result<PathBuf>,
) -> FileOperationResult {
    match result {
        Ok(target) => FileOperationResult {
            source_path,
            target_path: Some(normalize_path(&target)),
            ok: true,
            error: None,
        },
        Err(error) => FileOperationResult {
            source_path,
            target_path: None,
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

fn unique_destination(target_directory: &Path, file_name: &std::ffi::OsStr) -> PathBuf {
    let original_name = file_name.to_string_lossy();
    let first = target_directory.join(file_name);
    if !first.exists() {
        return first;
    }
    let stem = Path::new(original_name.as_ref())
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("copy");
    let extension = Path::new(original_name.as_ref())
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for index in 1.. {
        let candidate = target_directory.join(format!("{stem}_copy{index}{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unique destination loop should return")
}

fn copy_directory_recursive(source: &Path, target: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(target)
        .with_context(|| format!("failed to create directory {}", target.display()))?;
    for entry in fs::read_dir(source)
        .with_context(|| format!("failed to read directory {}", source.display()))?
    {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn path_is_same_or_descendant(path: &Path, parent: &Path) -> bool {
    let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let normalized_parent = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    normalized_path == normalized_parent || normalized_path.starts_with(normalized_parent)
}

pub fn copy_files_to_clipboard(paths: &[String]) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        let resolved = existing_paths(paths)?;
        if resolved.is_empty() {
            anyhow::bail!("no existing files were selected");
        }
        let add_lines = resolved
            .iter()
            .map(|path| format!("[void]$files.Add({})", powershell_single_quoted(path)))
            .collect::<Vec<_>>()
            .join("\n");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms\n$files = New-Object System.Collections.Specialized.StringCollection\n{add_lines}\n[System.Windows.Forms.Clipboard]::SetFileDropList($files)"
        );
        run_powershell_sta(&script).context("failed to copy files to Windows clipboard")?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = paths;
        anyhow::bail!("copying files to the system clipboard is only supported on Windows")
    }
}

pub fn replace_image_from_clipboard(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        if !path.is_file() {
            anyhow::bail!("target is not a file: {}", path.display());
        }
        if !clipboard_replace_image_extension_supported(path) {
            anyhow::bail!("only png, jpg, jpeg, bmp, and gif files can be replaced");
        }
        let target = normalize_path(path);
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms\nAdd-Type -AssemblyName System.Drawing\n$target = {}\n$img = [System.Windows.Forms.Clipboard]::GetImage()\nif ($null -eq $img) {{ throw '剪贴板中没有可用图片' }}\n$format = switch ([System.IO.Path]::GetExtension($target).ToLowerInvariant()) {{\n  '.png' {{ [System.Drawing.Imaging.ImageFormat]::Png }}\n  '.jpg' {{ [System.Drawing.Imaging.ImageFormat]::Jpeg }}\n  '.jpeg' {{ [System.Drawing.Imaging.ImageFormat]::Jpeg }}\n  '.bmp' {{ [System.Drawing.Imaging.ImageFormat]::Bmp }}\n  '.gif' {{ [System.Drawing.Imaging.ImageFormat]::Gif }}\n  default {{ throw '不支持的图片格式' }}\n}}\n$img.Save($target, $format)",
            powershell_single_quoted(&target)
        );
        run_powershell_sta(&script).context("failed to replace image from Windows clipboard")?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        anyhow::bail!("replacing images from the system clipboard is only supported on Windows")
    }
}

#[cfg(windows)]
fn existing_paths(paths: &[String]) -> anyhow::Result<Vec<String>> {
    let mut resolved = Vec::new();
    for path in paths {
        let candidate = PathBuf::from(path);
        if !candidate.exists() {
            continue;
        }
        resolved.push(
            candidate
                .canonicalize()
                .unwrap_or(candidate)
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(resolved)
}

#[cfg(windows)]
fn run_powershell_sta(script: &str) -> anyhow::Result<()> {
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Sta", "-NonInteractive", "-Command", script])
        .output()
        .context("failed to launch powershell.exe")?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    anyhow::bail!("{}", if stderr.is_empty() { stdout } else { stderr })
}

#[cfg(windows)]
fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(windows)]
fn clipboard_replace_image_extension_supported(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "bmp" | "gif")
}

pub fn search_project_files(
    query: &str,
    roots: &[String],
    options: ProjectSearchOptions,
) -> anyhow::Result<ProjectSearchResult> {
    let normalized_query = query.trim().to_lowercase();
    if normalized_query.is_empty() {
        return Ok(ProjectSearchResult {
            files: Vec::new(),
            text_matches: Vec::new(),
        });
    }

    let limit = options.limit.clamp(1, 500);
    let mut files = Vec::new();
    let mut text_matches = Vec::new();

    for root in roots {
        let root_path = PathBuf::from(root);
        if !root_path.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&root_path)
            .into_iter()
            .filter_entry(|entry| should_visit(entry.path()))
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(&root_path)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let full_path = normalize_path(path);
            let name = path
                .file_name()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_default();
            let haystack = if options.file_name_only {
                name.to_lowercase()
            } else {
                format!("{} {}", name.to_lowercase(), relative.to_lowercase())
            };
            if haystack.contains(&normalized_query) && files.len() < limit {
                files.push(ProjectFileMatch {
                    path: full_path.clone(),
                    relative_path: relative.clone(),
                    name: name.clone(),
                });
            }

            if !options.include_text
                || text_matches.len() >= limit
                || !is_probably_text(path)
                || !is_searchable_text(path)
            {
                continue;
            }
            collect_text_matches(
                path,
                &full_path,
                &relative,
                &normalized_query,
                &mut text_matches,
                limit,
            );
        }
    }

    Ok(ProjectSearchResult {
        files,
        text_matches,
    })
}

pub fn normalize_path(path: &Path) -> String {
    let mut value = path.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = value.strip_prefix("//?/UNC/") {
        value = format!("//{stripped}");
    } else if let Some(stripped) = value.strip_prefix("//?/") {
        value = stripped.to_string();
    } else {
        let bytes = value.as_bytes();
        if bytes.len() >= 3
            && bytes[0] == b'/'
            && bytes[1].is_ascii_alphabetic()
            && bytes[2] == b':'
        {
            value.remove(0);
        }
    }
    value
}

fn find_super_high_root_from(path: &Path) -> Option<PathBuf> {
    for candidate in path.ancestors() {
        if is_super_high_root(candidate) {
            return Some(candidate.to_path_buf());
        }
    }
    None
}

fn is_super_high_root(path: &Path) -> bool {
    path.join("package.json").is_file() && path.join("src-tauri").is_dir()
}

fn should_visit(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    !IGNORED_DIRS
        .iter()
        .any(|ignored| ignored.eq_ignore_ascii_case(&name))
}

fn is_searchable_text(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() <= MAX_SEARCH_TEXT_FILE_BYTES)
        .unwrap_or(false)
}

fn collect_text_matches(
    path: &Path,
    full_path: &str,
    relative_path: &str,
    normalized_query: &str,
    text_matches: &mut Vec<TextSearchMatch>,
    max_matches: usize,
) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    let reader = BufReader::new(file);

    for (index, line) in reader.lines().enumerate() {
        if text_matches.len() >= max_matches {
            break;
        }
        let Ok(line) = line else {
            break;
        };
        let lower = line.to_lowercase();
        if let Some(column) = lower.find(normalized_query) {
            text_matches.push(TextSearchMatch {
                path: full_path.to_string(),
                relative_path: relative_path.to_string(),
                line_number: index + 1,
                column: column + 1,
                preview: line.trim().to_string(),
            });
        }
    }
}

fn is_probably_text(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    !matches!(
        extension.as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "dll"
            | "exe"
            | "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
            | "pdf"
            | "jar"
            | "class"
            | "dat"
            | "db"
            | "sqlite"
            | "mca"
            | "mcr"
            | "nbt"
            | "so"
            | "dylib"
            | "pyd"
            | "bin"
    )
}

fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

fn media_mime_type(path: &Path) -> Option<&'static str> {
    if let Some(mime) = image_mime_type(path) {
        return Some(mime);
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    match extension.as_str() {
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogg" | "ogv" => Some("video/ogg"),
        "mov" => Some("video/quicktime"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        copy_paths_to_directory, find_super_high_root_from, move_paths_to_directory,
        normalize_path, search_project_files, write_text_file, MAX_SEARCH_TEXT_FILE_BYTES,
    };
    use crate::models::ProjectSearchOptions;

    #[test]
    fn normalize_path_removes_windows_extended_drive_prefix() {
        assert_eq!(
            normalize_path(std::path::Path::new(r"\\?\D:\Work\app\src\App.vue")),
            "D:/Work/app/src/App.vue"
        );
    }

    #[test]
    fn finds_super_high_root_from_nested_path() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(directory.path().join("src-tauri/target/release")).unwrap();

        let root =
            find_super_high_root_from(&directory.path().join("src-tauri/target/release")).unwrap();

        assert_eq!(root, directory.path());
    }

    #[test]
    fn search_skips_oversized_text_content_but_keeps_file_name_match() {
        let directory = tempfile::tempdir().unwrap();
        let large_file_path = directory.path().join("needle-large-log.txt");
        let oversized_content = vec![b'x'; (MAX_SEARCH_TEXT_FILE_BYTES + 1) as usize];
        std::fs::write(&large_file_path, oversized_content).unwrap();

        let result = search_project_files(
            "needle",
            &[directory.path().to_string_lossy().to_string()],
            ProjectSearchOptions::default(),
        )
        .unwrap();

        assert_eq!(result.files.len(), 1);
        assert!(result.files[0]
            .relative_path
            .ends_with("needle-large-log.txt"));
        assert!(result.text_matches.is_empty());
    }

    #[test]
    fn file_name_search_can_skip_text_content() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("plain.txt"), "needle only in body").unwrap();
        std::fs::write(directory.path().join("needle-name.txt"), "body").unwrap();

        let result = search_project_files(
            "needle",
            &[directory.path().to_string_lossy().to_string()],
            ProjectSearchOptions {
                include_text: false,
                file_name_only: false,
                limit: 80,
            },
        )
        .unwrap();

        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].relative_path.ends_with("needle-name.txt"));
        assert!(result.text_matches.is_empty());
    }

    #[test]
    fn file_name_only_search_ignores_parent_directories() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("needle-parent");
        std::fs::create_dir_all(&parent).unwrap();
        std::fs::write(parent.join("plain.txt"), "body").unwrap();
        std::fs::write(directory.path().join("needle-name.txt"), "body").unwrap();

        let result = search_project_files(
            "needle",
            &[directory.path().to_string_lossy().to_string()],
            ProjectSearchOptions {
                include_text: false,
                file_name_only: true,
                limit: 80,
            },
        )
        .unwrap();

        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].relative_path.ends_with("needle-name.txt"));
    }

    #[test]
    fn copy_directory_rejects_target_inside_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let child = source.join("child");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(source.join("file.txt"), "content").unwrap();

        let results = copy_paths_to_directory(&[source.to_string_lossy().to_string()], &child)
            .expect("batch operation should report per-path failures");

        assert_eq!(results.len(), 1);
        assert!(!results[0].ok);
        assert!(results[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("cannot copy a directory into itself"));
        assert!(!child.join("source").exists());
    }

    #[test]
    fn move_directory_rejects_target_inside_source() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source");
        let child = source.join("child");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(source.join("file.txt"), "content").unwrap();

        let results = move_paths_to_directory(&[source.to_string_lossy().to_string()], &child)
            .expect("batch operation should report per-path failures");

        assert_eq!(results.len(), 1);
        assert!(!results[0].ok);
        assert!(results[0]
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("cannot move a directory into itself"));
        assert!(source.exists());
        assert!(!child.join("source").exists());
    }

    #[test]
    fn write_text_file_atomically_replaces_existing_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("terminal-state.json");
        std::fs::write(&path, "old state").unwrap();

        write_text_file(&path, "new state").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new state");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
