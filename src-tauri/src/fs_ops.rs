use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
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
    "target-script-tools-staging",
    "dist",
    "build",
    "logs",
    "coverage",
    ".vite",
    ".turbo",
    ".next",
    "out",
    "skills-backup",
];
const MAX_TEXT_FILE_BYTES: u64 = 10 * 1024 * 1024;
const TEXT_PROBE_BYTES: u64 = 8192;
const MAX_SEARCH_TEXT_FILE_BYTES: u64 = MAX_TEXT_FILE_BYTES;
const MAX_IMAGE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OFFICE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MEDIA_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VIDEO_PREVIEW_BYTES: u64 = 10 * 1024 * 1024 * 1024;

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
        fs::metadata(path).with_context(|| format!("无法读取文件信息：{}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("文本预览需要普通文件：{}", path.display());
    }
    if !is_probably_text(path) {
        anyhow::bail!("此文件不是可编辑的 UTF-8 文本，请使用系统应用打开或定位文件");
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        anyhow::bail!(
            "文本文件超过内置编辑器的 {} MB 上限，请使用外部编辑器打开或定位文件",
            MAX_TEXT_FILE_BYTES / 1024 / 1024
        );
    }
    let file = fs::File::open(path)
        .with_context(|| format!("无法打开文件：{}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_TEXT_FILE_BYTES + 1).read_to_end(&mut bytes)
        .with_context(|| format!("无法读取文件：{}", path.display()))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        anyhow::bail!("文本文件超过内置编辑器的 10 MB 上限，请使用外部编辑器打开或定位文件");
    }
    if bytes.iter().any(|byte| is_binary_control(*byte)) {
        anyhow::bail!("此文件含有二进制内容，请使用系统应用打开或定位文件");
    }
    String::from_utf8(bytes)
        .context("此文件不是有效的 UTF-8 文本，请使用支持其编码的外部编辑器打开")
}

pub fn open_file_with_app(path: &Path, owner: isize) -> anyhow::Result<()> {
    if !path.is_absolute() {
        anyhow::bail!("打开方式需要绝对文件路径：{}", path.display());
    }
    if !path.is_file() {
        anyhow::bail!("文件不存在或不是普通文件：{}", path.display());
    }
    let path = fs::canonicalize(path).context("无法解析文件路径")?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::Shell::{SHOpenWithDialog, OAIF_EXEC, OPENASINFO},
        };
        let path = normalize_path(&path).replace('/', "\\");
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let info = OPENASINFO {
            pcszFile: wide.as_ptr(),
            pcszClass: std::ptr::null(),
            oaifInFlags: OAIF_EXEC,
        };
        // Called on the window's UI thread, whose message loop and COM apartment stay alive.
        let initialized = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        if initialized < 0 {
            anyhow::bail!("无法初始化系统打开方式：0x{:08X}", initialized as u32);
        }
        let result = unsafe { SHOpenWithDialog(owner as _, &info) };
        unsafe { CoUninitialize() };
        if result != 0 && result as u32 != 0x800704C7 {
            anyhow::bail!("无法显示系统打开方式：0x{:08X}", result as u32);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (path, owner);
        anyhow::bail!("系统打开方式仅支持 Windows")
    }
}

pub fn read_office_file_base64(path: &Path) -> anyhow::Result<String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !matches!(extension.to_ascii_lowercase().as_str(), "doc" | "docx" | "xlsx" | "pdf") {
        anyhow::bail!("文档预览仅支持 .doc、.docx、.xlsx 和 .pdf 文件");
    }
    let metadata = fs::metadata(path)
        .with_context(|| format!("无法读取 Office 文件信息：{}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("Office 预览需要普通文件：{}", path.display());
    }
    if metadata.len() > MAX_OFFICE_FILE_BYTES {
        anyhow::bail!("Office 文件过大，预览上限为 32 MB");
    }
    let file = fs::File::open(path)
        .with_context(|| format!("无法打开 Office 文件：{}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_OFFICE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .with_context(|| format!("无法读取 Office 文件：{}", path.display()))?;
    if bytes.len() as u64 > MAX_OFFICE_FILE_BYTES {
        anyhow::bail!("Office 文件过大，预览上限为 32 MB");
    }
    if extension.eq_ignore_ascii_case("doc") && !bytes.starts_with(b"PK\x03\x04") {
        return convert_legacy_word_for_preview(&bytes);
    }
    Ok(STANDARD.encode(bytes))
}

fn convert_legacy_word_for_preview(bytes: &[u8]) -> anyhow::Result<String> {
    let converter = find_libreoffice_converter().ok_or_else(|| anyhow::anyhow!(
        "预览旧版 .doc 需要本机 LibreOffice。请安装 LibreOffice 后重新打开文件；原文件不会被修改。"
    ))?;
    let temporary = tempfile::Builder::new()
        .prefix("superhigh-doc-preview-")
        .tempdir()
        .context("无法创建 DOC 预览临时目录")?;
    let source = temporary.path().join("document.doc");
    fs::write(&source, bytes).context("无法创建 DOC 预览副本")?;
    let profile = temporary.path().join("profile");
    fs::create_dir(&profile).context("无法创建文档转换配置目录")?;
    // A private profile isolates conversion from any interactive LibreOffice session.
    // Disable macros and external link updates before loading the temporary copy.
    fs::create_dir(profile.join("user"))?;
    fs::write(profile.join("user/registrymodifications.xcu"), r#"<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
</oor:items>"#)?;
    let profile_url = tauri::Url::from_directory_path(&profile)
        .map_err(|_| anyhow::anyhow!("无法解析文档转换配置路径"))?;
    let mut command = Command::new(converter);
    command.args([
        &format!("-env:UserInstallation={profile_url}"),
        "--headless", "--nologo", "--nodefault", "--norestore",
        "--convert-to", "docx:Office Open XML Text", "--outdir",
    ]).arg(temporary.path()).arg(&source)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().context("无法启动 LibreOffice 文档转换")?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().context("无法读取文档转换状态")? {
            if !status.success() {
                anyhow::bail!("DOC 转换失败，请确认文档未损坏且没有密码保护");
            }
            break;
        }
        if started.elapsed() > Duration::from_secs(90) {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = Command::new("taskkill.exe")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output();
            }
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("DOC 转换超时，请确认文档未损坏且没有密码保护");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let converted = temporary.path().join("document.docx");
    if !converted.is_file() {
        anyhow::bail!("DOC 无法转换为预览文档，请确认文档未损坏且没有密码保护");
    }
    // DOCX retains text and embedded images rather than rasterizing the page.
    read_office_file_base64(&converted)
}

fn find_libreoffice_converter() -> Option<PathBuf> {
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            let executable = PathBuf::from(root).join("LibreOffice/program/soffice.com");
            if executable.is_file() {
                return Some(executable);
            }
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|path| path.join(if cfg!(windows) { "soffice.com" } else { "soffice" }))
            .find(|path| path.is_file())
    })
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

pub fn validate_video_for_preview(path: &Path) -> anyhow::Result<String> {
    let metadata =
        fs::metadata(path).with_context(|| format!("failed to inspect file {}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("{} is not a file", path.display());
    }
    let mime = media_mime_type(path)
        .filter(|mime| mime.starts_with("video/") || mime.starts_with("audio/"))
        .ok_or_else(|| anyhow::anyhow!("内置预览不支持此媒体类型，请使用系统应用打开"))?;
    if metadata.len() > MAX_VIDEO_PREVIEW_BYTES {
        anyhow::bail!(
            "媒体文件超过内置预览的 {} GB 上限，请使用系统应用打开",
            MAX_VIDEO_PREVIEW_BYTES / 1024 / 1024 / 1024
        );
    }
    debug_assert!(mime.starts_with("video/") || mime.starts_with("audio/"));
    Ok(normalize_path(path))
}

pub fn save_image_data_url(path: &Path, data_url: &str) -> anyhow::Result<String> {
    if !path.is_absolute() {
        anyhow::bail!("image save path must be absolute: {}", path.display());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let (format, encoded) = parse_save_image_data_url(data_url)?;
    let extension_matches = match format {
        "png" => extension == "png",
        "jpeg" => matches!(extension.as_str(), "jpg" | "jpeg"),
        _ => false,
    };
    if !extension_matches {
        anyhow::bail!("image data URL format does not match target extension");
    }

    let bytes = STANDARD
        .decode(encoded.trim())
        .context("failed to decode image data URL")?;
    let signature_matches = match format {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpeg" => bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF,
        _ => false,
    };
    if !signature_matches {
        anyhow::bail!("decoded image data does not match its declared format");
    }

    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(normalize_path(path))
}

fn parse_save_image_data_url(data_url: &str) -> anyhow::Result<(&'static str, &str)> {
    let rest = data_url
        .trim()
        .strip_prefix("data:")
        .ok_or_else(|| anyhow::anyhow!("image save data must be a data URL"))?;
    let (header, encoded) = rest
        .split_once(',')
        .ok_or_else(|| anyhow::anyhow!("invalid image save data URL"))?;
    match header.to_ascii_lowercase().as_str() {
        "image/png;base64" => Ok(("png", encoded)),
        "image/jpeg;base64" => Ok(("jpeg", encoded)),
        _ => anyhow::bail!("image save data URL must be PNG or JPEG base64 data"),
    }
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

#[derive(Clone)]
struct IndexedSearchFile {
    result: ProjectFileMatch,
    name: String,
    relative: String,
}

struct FileSearchIndex {
    files: Arc<Vec<IndexedSearchFile>>,
    directories: Vec<(PathBuf, Option<SystemTime>)>,
    checked_at: Instant,
    built_at: Instant,
}

// Keep typing searches in memory; directory timestamps catch external creates,
// renames and deletes, with a periodic rebuild for filesystems with coarse timestamps.
fn indexed_search_files(root: &Path) -> Arc<Vec<IndexedSearchFile>> {
    static INDEXES: OnceLock<Mutex<HashMap<PathBuf, FileSearchIndex>>> = OnceLock::new();
    let mut indexes = INDEXES.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = indexes.get_mut(root) {
        if index.built_at.elapsed() < Duration::from_secs(30) {
            if index.checked_at.elapsed() < Duration::from_secs(1) {
                return Arc::clone(&index.files);
            }
            index.checked_at = Instant::now();
            if index.directories.iter().all(|(path, modified)| {
                fs::metadata(path).and_then(|metadata| metadata.modified()).ok() == *modified
            }) {
                return Arc::clone(&index.files);
            }
        }
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter()
        .filter_entry(|entry| entry.depth() == 0 || should_visit(entry.path()))
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if entry.file_type().is_dir() {
            directories.push((path.to_path_buf(), fs::metadata(path)
                .and_then(|metadata| metadata.modified()).ok()));
        } else if entry.file_type().is_file() {
            let relative = normalize_path(path.strip_prefix(root).unwrap_or(path));
            let name = entry.file_name().to_string_lossy().into_owned();
            files.push(IndexedSearchFile {
                name: name.to_lowercase(), relative: relative.to_lowercase(),
                result: ProjectFileMatch { path: normalize_path(path), relative_path: relative, name },
            });
        }
    }
    let files = Arc::new(files);
    // Bound memory when switching between many projects.
    if indexes.len() >= 8 && !indexes.contains_key(root) {
        if let Some(oldest) = indexes.iter().min_by_key(|(_, index)| index.checked_at)
            .map(|(path, _)| path.clone()) {
            indexes.remove(&oldest);
        }
    }
    indexes.insert(root.to_path_buf(), FileSearchIndex {
        files: Arc::clone(&files), directories, checked_at: Instant::now(), built_at: Instant::now(),
    });
    files
}

fn file_search_score(file: &IndexedSearchFile, query: &str, name_only: bool) -> Option<usize> {
    if file.name == query { return Some(0); }
    if file.name.rsplit_once('.').map(|(stem, _)| stem == query).unwrap_or(false) {
        return Some(1);
    }
    if file.name.starts_with(query) { return Some(2); }
    if file.name.contains(query) { return Some(3); }
    let allow_path = !name_only || query.contains('/') || query.split_whitespace().count() > 1;
    if allow_path && file.relative.contains(query) { return Some(4); }
    let haystack = if allow_path { &file.relative } else { &file.name };
    let tokens: Vec<_> = query.split_whitespace().collect();
    if tokens.len() > 1 && tokens.iter().all(|token| haystack.contains(token)) { return Some(5); }
    // Ordered abbreviation matching (e.g. PEP -> ProjectEditorPanel.vue).
    // Short queries stay literal to avoid flooding results with unrelated files.
    if query.chars().count() >= 3 && !query.contains(char::is_whitespace) {
        let mut chars = haystack.chars();
        if query.chars().all(|needle| chars.by_ref().any(|value| value == needle)) {
            return Some(6);
        }
    }
    None
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

    let file_query = normalized_query.replace('\\', "/");
    let mut ranked = Vec::new();
    for root in roots {
        let index = indexed_search_files(Path::new(root));
        for file in index.iter() {
            if let Some(score) = file_search_score(file, &file_query, options.file_name_only) {
                ranked.push((score, file.result.clone()));
            }
            let path = Path::new(&file.result.path);
            if options.include_text && text_matches.len() < limit
                && is_probably_text(path) && is_searchable_text(path) {
                collect_text_matches(path, &file.result.path, &file.result.relative_path,
                    &normalized_query, &mut text_matches, limit);
            }
        }
    }
    ranked.sort_by(|(left_score, left), (right_score, right)| {
        left_score.cmp(right_score)
            .then_with(|| left.relative_path.len().cmp(&right.relative_path.len()))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut seen = std::collections::HashSet::new();
    files.extend(ranked.into_iter().map(|(_, file)| file)
        .filter(|file| seen.insert(file.path.clone())).take(limit));

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
    if matches!(
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
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
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
            | "bmp" | "avif" | "tif" | "tiff"
            | "mp4" | "m4v" | "mov" | "webm" | "mkv" | "avi" | "wmv"
            | "mpg" | "mpeg" | "ogv" | "flv"
            | "mp3" | "wav" | "flac" | "ogg" | "oga" | "m4a" | "aac" | "wma" | "opus"
    ) {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut sample = Vec::with_capacity(TEXT_PROBE_BYTES as usize);
    if file.take(TEXT_PROBE_BYTES).read_to_end(&mut sample).is_err()
        || sample.iter().any(|byte| is_binary_control(*byte)) {
        return false;
    }
    match std::str::from_utf8(&sample) {
        Ok(_) => true,
        // The bounded sample can end in the middle of a valid UTF-8 character.
        Err(error) => error.error_len().is_none() && sample.len() == TEXT_PROBE_BYTES as usize,
    }
}

fn is_binary_control(byte: u8) -> bool {
    matches!(byte, 0..=8 | 14..=31 | 127)
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
        "mp4" | "m4v" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogg" | "ogv" => Some("video/ogg"),
        "mov" => Some("video/quicktime"),
        "mkv" => Some("video/x-matroska"),
        "avi" => Some("video/x-msvideo"),
        "wmv" => Some("video/x-ms-wmv"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "flac" => Some("audio/flac"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "oga" | "opus" => Some("audio/ogg"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        copy_paths_to_directory, find_super_high_root_from,
        move_paths_to_directory, normalize_path, read_office_file_base64, save_image_data_url, search_project_files,
        write_text_file, MAX_SEARCH_TEXT_FILE_BYTES,
    };
    use crate::models::ProjectSearchOptions;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nminimal";
    const JPEG_BYTES: &[u8] = b"\xff\xd8\xffminimal";

    #[test]
    fn open_with_rejects_invalid_paths_before_showing_dialog() {
        let directory = tempfile::tempdir().unwrap();
        assert!(super::open_file_with_app(std::path::Path::new("relative.txt"), 0)
            .unwrap_err().to_string().contains("绝对文件路径"));
        for path in [directory.path().to_path_buf(), directory.path().join("missing.txt")] {
            assert!(super::open_file_with_app(&path, 0)
                .unwrap_err().to_string().contains("不是普通文件"));
        }
    }

    #[test]
    fn text_read_rejects_binary_before_size_limit_and_checks_unknown_extensions() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["movie.mp4", "unknown.custom", "pretend.txt"] {
            let path = directory.path().join(name);
            std::fs::write(&path, b"\0\0\0\x18ftypmp42").unwrap();
            std::fs::OpenOptions::new().write(true).open(&path).unwrap()
                .set_len(super::MAX_TEXT_FILE_BYTES + 1).unwrap();
            let error = super::read_text_file(&path).unwrap_err().to_string();
            assert!(error.contains("不是可编辑"), "{name}: {error}");
            assert!(!error.contains("10 MB"));
        }
        let text = directory.path().join("unknown.other");
        std::fs::write(&text, "中文\nplain text\t").unwrap();
        assert_eq!(super::read_text_file(&text).unwrap(), "中文\nplain text\t");
    }

    #[test]
    fn text_read_preserves_utf8_boundaries_and_rejects_late_invalid_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text.txt");
        let content = format!("{}中文", "a".repeat(super::TEXT_PROBE_BYTES as usize - 1));
        std::fs::write(&path, &content).unwrap();
        assert_eq!(super::read_text_file(&path).unwrap(), content);
        for suffix in [0xff, 0] {
            let mut bytes = vec![b'a'; super::TEXT_PROBE_BYTES as usize];
            bytes.push(suffix);
            std::fs::write(&path, bytes).unwrap();
            assert!(super::read_text_file(&path).is_err());
        }
        std::fs::write(&path, vec![b'a'; (super::MAX_TEXT_FILE_BYTES + 1) as usize]).unwrap();
        assert!(super::read_text_file(&path).unwrap_err().to_string().contains("10 MB"));
    }

    #[test]
    fn media_preview_accepts_large_audio_and_video_without_text_loading() {
        let directory = tempfile::tempdir().unwrap();
        for extension in ["mp4", "mkv", "avi", "m4v", "wmv", "mp3", "wav", "flac", "m4a", "aac", "oga", "opus"] {
            let path = directory.path().join(format!("media.{extension}"));
            std::fs::File::create(&path).unwrap().set_len(super::MAX_TEXT_FILE_BYTES + 1).unwrap();
            assert_eq!(super::validate_video_for_preview(&path).unwrap(), super::normalize_path(&path));
            assert!(super::read_text_file(&path).is_err());
        }
    }

    fn image_data_url(mime: &str, bytes: &[u8]) -> String {
        format!("data:{mime};base64,{}", STANDARD.encode(bytes))
    }

    #[test]
    fn office_base64_preserves_binary_bytes_and_excludes_text_reading() {
        let directory = tempfile::tempdir().unwrap();
        let bytes: Vec<u8> = (0..=255).collect();
        for name in ["document.DOCX", "sheet.xlsx", "document.pdf"] {
            let path = directory.path().join(name);
            std::fs::write(&path, &bytes).unwrap();
            let encoded = read_office_file_base64(&path).unwrap();
            assert_eq!(STANDARD.decode(encoded).unwrap(), bytes);
            assert!(super::read_text_file(&path).is_err());
        }
    }

    #[test]
    fn office_base64_rejects_unsupported_and_oversized_files() {
        let directory = tempfile::tempdir().unwrap();
        let unsupported = directory.path().join("document.ppt");
        std::fs::write(&unsupported, b"document").unwrap();
        assert!(read_office_file_base64(&unsupported).unwrap_err().to_string().contains("仅支持"));

        let oversized = directory.path().join("large.xlsx");
        std::fs::File::create(&oversized).unwrap()
            .set_len(super::MAX_OFFICE_FILE_BYTES + 1).unwrap();
        assert!(read_office_file_base64(&oversized).unwrap_err().to_string().contains("32 MB"));
        let folder = directory.path().join("folder.docx");
        std::fs::create_dir(&folder).unwrap();
        assert!(read_office_file_base64(&folder).unwrap_err().to_string().contains("普通文件"));
    }

    #[test]
    fn office_base64_reads_docx_with_legacy_doc_extension_without_conversion() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("document.DOC");
        let bytes = b"PK\x03\x04document";
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(STANDARD.decode(read_office_file_base64(&path).unwrap()).unwrap(), bytes);
    }

    #[test]
    fn save_image_data_url_writes_png_and_jpeg() {
        let directory = tempfile::tempdir().unwrap();
        let png_path = directory.path().join("pixel.png");
        let jpeg_path = directory.path().join("pixel.jpeg");

        let png = save_image_data_url(&png_path, &image_data_url("image/png", PNG_BYTES)).unwrap();
        let jpeg =
            save_image_data_url(&jpeg_path, &image_data_url("image/jpeg", JPEG_BYTES)).unwrap();

        assert!(png.ends_with("pixel.png"));
        assert!(jpeg.ends_with("pixel.jpeg"));
        assert_eq!(std::fs::read(png_path).unwrap(), PNG_BYTES);
        assert_eq!(std::fs::read(jpeg_path).unwrap(), JPEG_BYTES);
    }

    #[test]
    fn save_image_data_url_rejects_invalid_targets_and_data() {
        let directory = tempfile::tempdir().unwrap();
        let png_data = image_data_url("image/png", PNG_BYTES);

        let mismatch = save_image_data_url(&directory.path().join("pixel.jpg"), &png_data)
            .unwrap_err()
            .to_string();
        assert!(mismatch.contains("does not match"));

        let invalid_base64 = save_image_data_url(
            &directory.path().join("pixel.png"),
            "data:image/png;base64,not-base64!",
        )
        .unwrap_err()
        .to_string();
        assert!(invalid_base64.contains("decode"));

        let invalid_signature = save_image_data_url(
            &directory.path().join("pixel.png"),
            &image_data_url("image/png", JPEG_BYTES),
        )
        .unwrap_err()
        .to_string();
        assert!(invalid_signature.contains("does not match"));

        let relative = save_image_data_url(std::path::Path::new("pixel.png"), &png_data)
            .unwrap_err()
            .to_string();
        assert!(relative.contains("must be absolute"));
    }

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
    fn file_search_includes_project_config_and_skips_build_staging() {
        let directory = tempfile::tempdir().unwrap();
        for folder in [".superhigh/editor", ".vscode", "target-script-tools-staging"] {
            std::fs::create_dir_all(directory.path().join(folder)).unwrap();
            std::fs::write(directory.path().join(folder).join("settings.json"), "{}").unwrap();
        }
        let result = search_project_files("settings", &[directory.path().to_string_lossy().to_string()],
            ProjectSearchOptions { include_text: false, file_name_only: true, limit: 80 }).unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.files.iter().all(|file| !file.relative_path.contains("staging")));
    }

    #[test]
    fn file_search_ranks_exact_before_limit_and_supports_paths_tokens_abbreviations() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("src/components")).unwrap();
        for name in ["ProjectEditorPanel.vue", "ProjectEditorPanelExtra.vue", "Other.vue"] {
            std::fs::write(directory.path().join("src/components").join(name), "body").unwrap();
        }
        let roots = vec![directory.path().to_string_lossy().to_string()];
        let search = |query| search_project_files(query, &roots, ProjectSearchOptions {
            include_text: false, file_name_only: true, limit: 1,
        }).unwrap();
        assert_eq!(search("ProjectEditorPanel").files[0].name, "ProjectEditorPanel.vue");
        for (query, expected_name) in [
            ("src/components/Other", "Other.vue"),
            ("components Other", "Other.vue"),
            ("PEP", "ProjectEditorPanel.vue"),
        ] {
            let result = search(query);
            assert_eq!(result.files.len(), 1, "{query}");
            assert_eq!(result.files[0].name, expected_name, "{query}");
        }
        let index = super::indexed_search_files(directory.path());
        assert!(std::sync::Arc::ptr_eq(&index, &super::indexed_search_files(directory.path())));
        std::fs::write(directory.path().join("new-file.txt"), "body").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        assert_eq!(search("new-file").files[0].name, "new-file.txt");
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
