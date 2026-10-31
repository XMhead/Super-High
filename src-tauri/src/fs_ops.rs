use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use anyhow::Context;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use encoding_rs::{Encoding, UTF_8};
use serde::Serialize;

use crate::models::{
    DirectoryListing, FileEntry, FileEntryType, FileOperationResult,
    ProjectFileMatch, ProjectSearchOptions, ProjectSearchResult, TextSearchMatch,
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
// 【模型文件,属于正常范围】
const MAX_MODEL_FILE_BYTES: u64 = 256 * 1024 * 1024;
const TEXT_PROBE_BYTES: u64 = 8192;
const MAX_SEARCH_TEXT_FILE_BYTES: u64 = MAX_TEXT_FILE_BYTES;
const MAX_IMAGE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_OFFICE_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MEDIA_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VIDEO_PREVIEW_BYTES: u64 = 10 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFileContent {
    pub content: String,
    pub encoding: String,
}

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
    entries.sort_by_cached_key(|entry| (
        !matches!(entry.entry_type, FileEntryType::Directory), entry.name.to_lowercase(),
    ));
    Ok(DirectoryListing {
        path: normalize_path(path),
        entries,
    })
}

pub fn read_text_file(path: &Path) -> anyhow::Result<String> {
    if has_binary_control_prefix(path)? {
        anyhow::bail!("此文件不是可编辑的文本，检测到二进制内容，请使用系统应用打开或定位文件");
    }
    Ok(read_text_file_with_encoding(path, Some("utf-8"))?.content)
}

pub fn read_text_file_with_encoding(path: &Path, requested_encoding: Option<&str>) -> anyhow::Result<TextFileContent> {
    let metadata =
        fs::metadata(path).with_context(|| format!("无法读取文件信息：{}", path.display()))?;
    if !metadata.is_file() {
        anyhow::bail!("文本预览需要普通文件：{}", path.display());
    }
    if requested_encoding.is_none() && has_binary_control_prefix(path)? {
        anyhow::bail!("此文件不是可编辑的文本，检测到二进制内容，请使用系统应用打开或定位文件");
    }
    let max_bytes = if path.extension().and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("bbmodel")) {
        MAX_MODEL_FILE_BYTES
    } else {
        MAX_TEXT_FILE_BYTES
    };
    if metadata.len() > max_bytes {
        anyhow::bail!(
            "文本文件超过内置编辑器的 {} MB 上限，请使用外部编辑器打开或定位文件",
            max_bytes / 1024 / 1024
        );
    }
    let file = fs::File::open(path)
        .with_context(|| format!("无法打开文件：{}", path.display()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1).read_to_end(&mut bytes)
        .with_context(|| format!("无法读取文件：{}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        anyhow::bail!(
            "文本文件超过内置编辑器的 {} MB 上限，请使用外部编辑器打开或定位文件",
            max_bytes / 1024 / 1024
        );
    }
    if requested_encoding.is_none() && bytes.iter().any(|byte| is_binary_control(*byte))
        && !bytes.starts_with(&[0xFF, 0xFE])
        && !bytes.starts_with(&[0xFE, 0xFF]) {
        anyhow::bail!("此文件含有二进制内容，请使用系统应用打开或定位文件");
    }
    let (encoding, bom_len) = if let Some(label) = requested_encoding {
        let normalized = label.trim().to_ascii_lowercase();
        let (encoding_label, _) = normalized.strip_suffix("-bom")
            .map(|value| (value, true)).unwrap_or((normalized.as_str(), false));
        let encoding = encoding_from_label(encoding_label)?;
        let bom_len = detect_bom(&bytes).filter(|(bom_encoding, _)| std::ptr::eq(*bom_encoding, encoding)).map(|(_, len)| len).unwrap_or(0);
        (encoding, bom_len)
    } else if let Some((encoding, bom_len)) = detect_bom(&bytes) {
        (encoding, bom_len)
    } else if let Ok(text) = std::str::from_utf8(&bytes) {
        return Ok(TextFileContent { content: text.to_owned(), encoding: "utf-8".to_string() });
    } else {
        let non_ascii_count = bytes.iter().filter(|byte| !byte.is_ascii()).count();
        if non_ascii_count < 2 {
            anyhow::bail!("无法自动识别此文件的编码，请在编码菜单中手动选择");
        }
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(&bytes, true);
        (prefer_cjk_legacy_encoding(&bytes, detector.guess(None, true)), 0)
    };
    let (content, had_errors) = encoding.decode_without_bom_handling(&bytes[bom_len..]);
    if had_errors {
        if requested_encoding.is_none() {
            if let Some(mixed) = decode_mixed_text(&bytes[bom_len..], encoding) {
                return Ok(mixed);
            }
        }
        anyhow::bail!("无法使用 {} 解码此文件，请尝试其他编码", encoding.name());
    }
    if content.chars().any(|character| character == '\0') {
        anyhow::bail!("此文件含有二进制内容，请使用系统应用打开或定位文件");
    }
    let encoding_name = match (encoding.name(), bom_len) {
        ("UTF-8", 3) => "utf-8-bom".to_string(),
        ("UTF-16LE", 2) => "utf-16le-bom".to_string(),
        ("UTF-16BE", 2) => "utf-16be-bom".to_string(),
        _ => encoding.name().to_ascii_lowercase(),
    };
    Ok(TextFileContent { content: content.into_owned(), encoding: encoding_name })
}

pub fn write_text_file_with_encoding(path: &Path, content: &str, label: &str) -> anyhow::Result<()> {
    let normalized = label.to_ascii_lowercase();
    if normalized.starts_with("mixed:") {
        anyhow::bail!("检测到混合编码文件，请在编码菜单中选择“按编码保存”并转换为单一编码后再保存");
    }
    let (bom, encoding_label) = match normalized.as_str() {
        "utf-8-bom" | "utf8-bom" => (Some(&[0xEF, 0xBB, 0xBF][..]), "utf-8"),
        "utf-16le-bom" => (Some(&[0xFF, 0xFE][..]), "utf-16le"),
        "utf-16be-bom" => (Some(&[0xFE, 0xFF][..]), "utf-16be"),
        other => (None, other),
    };
    let encoding = encoding_from_label(encoding_label)?;
    let (encoded, had_errors) = match encoding.name() {
        "UTF-16LE" => (content.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>(), false),
        "UTF-16BE" => (content.encode_utf16().flat_map(u16::to_be_bytes).collect::<Vec<_>>(), false),
        _ => {
            let (encoded, _, had_errors) = encoding.encode(content);
            (encoded.into_owned(), had_errors)
        }
    };
    if had_errors {
        anyhow::bail!("内容无法用 {} 表示，请选择 UTF-8 或其他编码", encoding.name());
    }
    let mut bytes = Vec::with_capacity(encoded.len() + bom.map_or(0, <[u8]>::len));
    if let Some(bom) = bom { bytes.extend_from_slice(bom); }
    bytes.extend_from_slice(&encoded);
    write_bytes_atomically(path, &bytes)
}

fn encoding_from_label(label: &str) -> anyhow::Result<&'static Encoding> {
    match label.trim().to_ascii_lowercase().as_str() {
        "utf-16le" => Ok(encoding_rs::UTF_16LE),
        "utf-16be" => Ok(encoding_rs::UTF_16BE),
        _ => Encoding::for_label(label.trim().as_bytes())
            .ok_or_else(|| anyhow::anyhow!("不支持的文本编码：{label}")),
    }
}

fn prefer_cjk_legacy_encoding(bytes: &[u8], detected: &'static Encoding) -> &'static Encoding {
    let mut selected = detected;
    let mut selected_score = cjk_character_count(detected, bytes);
    for candidate in [encoding_rs::GBK, encoding_rs::GB18030, encoding_rs::BIG5, encoding_rs::SHIFT_JIS, encoding_rs::EUC_KR] {
        let score = cjk_character_count(candidate, bytes);
        if score > selected_score {
            selected = candidate;
            selected_score = score;
        }
    }
    if selected_score >= 2 { selected } else { detected }
}

fn cjk_character_count(encoding: &'static Encoding, bytes: &[u8]) -> usize {
    bytes.split_inclusive(|byte| *byte == b'\n').map(|line| {
        let (text, had_errors) = encoding.decode_without_bom_handling(line);
        if had_errors { return 0; }
        text.chars().filter(|character| matches!(*character as u32, 0x2E80..=0x2FFF | 0x3040..=0x30FF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xAC00..=0xD7AF)).count()
    }).sum()
}

fn decode_mixed_text(bytes: &[u8], legacy_encoding: &'static Encoding) -> Option<TextFileContent> {
    let mut content = String::with_capacity(bytes.len());
    let mut has_utf8_text = false;
    let mut has_legacy_text = false;
    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if let Ok(text) = std::str::from_utf8(line) {
            if line.iter().any(|byte| !byte.is_ascii()) { has_utf8_text = true; }
            content.push_str(text);
            continue;
        }
        let (text, had_errors) = legacy_encoding.decode_without_bom_handling(line);
        if had_errors { return None; }
        has_legacy_text |= line.iter().any(|byte| !byte.is_ascii());
        content.push_str(&text);
    }
    if !has_utf8_text || !has_legacy_text { return None; }
    Some(TextFileContent {
        content,
        encoding: format!("mixed:utf-8+{}", legacy_encoding.name().to_ascii_lowercase()),
    })
}

fn detect_bom(bytes: &[u8]) -> Option<(&'static Encoding, usize)> {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { Some((UTF_8, 3)) }
    else if bytes.starts_with(&[0xFF, 0xFE]) { Some((encoding_rs::UTF_16LE, 2)) }
    else if bytes.starts_with(&[0xFE, 0xFF]) { Some((encoding_rs::UTF_16BE, 2)) }
    else { None }
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
    if !matches!(extension.to_ascii_lowercase().as_str(), "doc" | "docx" | "xls" | "xlsx" | "pdf" | "ppt" | "pptx") {
        anyhow::bail!("文档预览仅支持 .doc、.docx、.xls、.xlsx、.pdf、.ppt 和 .pptx 文件");
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

pub fn save_download_data_url(path: &Path, data_url: &str) -> anyhow::Result<String> {
    if !path.is_absolute() {
        anyhow::bail!("download save path must be absolute");
    }
    let (header, encoded) = data_url.split_once(',').context("invalid download data URL")?;
    if !header.starts_with("data:") || !header.ends_with(";base64") {
        anyhow::bail!("download must be a base64 data URL");
    }
    let bytes = STANDARD.decode(encoded).context("invalid download base64 data")?;
    fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
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
    write_bytes_atomically(path, content.as_bytes())
}

fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("failed to create temporary file for {}", path.display()))?;
    temporary
        .write_all(bytes)
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

/// Sends a path to the native recycle bin without permanently deleting it.
pub fn recycle_path(path: &Path) -> anyhow::Result<()> {
    if !path.exists() {
        anyhow::bail!("path does not exist: {}", path.display());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::{
            SHFileOperationW, SHFILEOPSTRUCTW, FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION,
            FOF_SILENT,
        };
        let normalized = normalize_path(path).replace('/', "\\");
        let mut from: Vec<u16> = normalized.encode_utf16().collect();
        from.extend([0, 0]);
        let mut operation: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
        operation.wFunc = FO_DELETE;
        operation.pFrom = from.as_ptr();
        operation.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT) as u16;
        let result = unsafe { SHFileOperationW(&mut operation) };
        if result != 0 {
            anyhow::bail!("failed to move {} to the recycle bin (0x{result:08X})", path.display());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        anyhow::bail!("moving files to the recycle bin is only supported on Windows")
    }
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

pub fn read_files_from_clipboard() -> anyhow::Result<Vec<String>> {
    #[cfg(windows)]
    {
        use std::{os::windows::ffi::OsStringExt, ptr};
        use windows_sys::Win32::{
            System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard},
            UI::Shell::DragQueryFileW,
        };

        const CF_HDROP: u32 = 15;
        if unsafe { IsClipboardFormatAvailable(CF_HDROP) } == 0 {
            return Ok(Vec::new());
        }
        if unsafe { OpenClipboard(ptr::null_mut()) } == 0 {
            anyhow::bail!("无法打开系统剪贴板");
        }
        let result = (|| {
            let handle = unsafe { GetClipboardData(CF_HDROP) };
            if handle.is_null() {
                return Ok(Vec::new());
            }
            let count = unsafe { DragQueryFileW(handle, u32::MAX, ptr::null_mut(), 0) };
            let mut paths = Vec::with_capacity(count as usize);
            for index in 0..count {
                let length = unsafe { DragQueryFileW(handle, index, ptr::null_mut(), 0) };
                if length == 0 {
                    continue;
                }
                let mut buffer = vec![0u16; length as usize + 1];
                let written = unsafe { DragQueryFileW(handle, index, buffer.as_mut_ptr(), buffer.len() as u32) };
                if written == 0 {
                    continue;
                }
                paths.push(std::ffi::OsString::from_wide(&buffer[..written as usize]).to_string_lossy().into_owned());
            }
            Ok(paths)
        })();
        unsafe { CloseClipboard(); }
        result
    }
    #[cfg(not(windows))]
    {
        anyhow::bail!("reading files from the system clipboard is only supported on Windows")
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

struct IndexedSearchFile {
    result: ProjectFileMatch,
    key: PathBuf,
    name: String,
    relative: String,
}

struct FileSearchIndex {
    files: Arc<Mutex<SearchFileEntries>>,
    pending_paths: std::collections::BTreeSet<PathBuf>,
    pending_modified: std::collections::BTreeSet<PathBuf>,
    checked_at: Instant,
    built_at: Instant,
    refreshing: bool,
}

#[derive(Default)]
struct SearchFileEntries {
    by_path: std::collections::BTreeMap<PathBuf, Arc<IndexedSearchFile>>,
    snapshot: Option<Arc<Vec<Arc<IndexedSearchFile>>>>,
}

impl SearchFileEntries {
    fn snapshot(&mut self) -> Arc<Vec<Arc<IndexedSearchFile>>> {
        Arc::clone(self.snapshot.get_or_insert_with(|| Arc::new(self.by_path.values().cloned().collect())))
    }
}

const SEARCH_INDEX_CHECK_INTERVAL: Duration = Duration::from_secs(1);
const SEARCH_INDEX_REBUILD_INTERVAL: Duration = Duration::from_secs(300);

// Watchers may report Windows extended prefixes, separators or casing differently
// from the workspace root. Keys share one lexical form; display paths stay intact.
fn search_path_key(path: &Path) -> PathBuf {
    let value = normalize_path(path);
    #[cfg(windows)]
    let value = value.to_lowercase();
    PathBuf::from(value)
}

fn changed_search_path(path: &Path, changes: &std::collections::BTreeSet<PathBuf>) -> bool {
    path.ancestors().any(|ancestor| changes.contains(ancestor))
}

fn search_branch_intersects(path: &Path, changes: &std::collections::BTreeSet<PathBuf>) -> bool {
    changed_search_path(path, changes) || changes.range(path.to_path_buf()..).next().is_some_and(|changed| changed.starts_with(path))
}

fn search_indexes() -> &'static Mutex<HashMap<PathBuf, FileSearchIndex>> {
    static INDEXES: OnceLock<Mutex<HashMap<PathBuf, FileSearchIndex>>> = OnceLock::new();
    INDEXES.get_or_init(|| Mutex::new(HashMap::new()))
}

// One build per root at a time, so concurrent cold searches wait for a single walk.
fn search_index_build_gate(root: &Path) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut gates = GATES.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(gates.entry(search_path_key(root)).or_default())
}

// Keep typing searches in memory. Only the first search of a root waits for the walk;
// later searches return the current index at once and refresh it in the background
// Native watcher changes refresh only affected branches; a low-frequency full
// rebuild recovers dropped events and changes to inherited ignore configuration.
fn indexed_search_entries(root: &Path) -> Arc<Mutex<SearchFileEntries>> {
    {
        let mut indexes = search_indexes().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(index) = indexes.get_mut(&search_path_key(root)) {
            if !index.refreshing && index.checked_at.elapsed() >= SEARCH_INDEX_CHECK_INTERVAL
                && (!index.pending_paths.is_empty() || !index.pending_modified.is_empty() || index.built_at.elapsed() >= SEARCH_INDEX_REBUILD_INTERVAL) {
                index.refreshing = true;
                index.checked_at = Instant::now();
                let rebuild = index.built_at.elapsed() >= SEARCH_INDEX_REBUILD_INTERVAL;
                let paths = std::mem::take(&mut index.pending_paths);
                let modified = std::mem::take(&mut index.pending_modified);
                let root = root.to_path_buf();
                std::thread::spawn(move || {
                    refresh_search_index_changes(&root, &paths, &modified, rebuild);
                    update_search_index_paths(&root, &[]);
                });
            }
            return Arc::clone(&index.files);
        }
    }
    let gate = search_index_build_gate(root);
    let _guard = gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = search_indexes().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&search_path_key(root)) {
        return Arc::clone(&index.files);
    }
    build_search_index(root)
}

#[cfg(test)]
fn indexed_search_files(root: &Path) -> Arc<Vec<Arc<IndexedSearchFile>>> {
    indexed_search_entries(root).lock().unwrap_or_else(|p| p.into_inner()).snapshot()
}

// A known watcher change must be applied before answering even a single query.
// Wait only on the blocking search worker, checking cancellation while the
// debounced refresh owns the root's build gate.
fn search_index_snapshot(root: &Path, cancelled: &std::sync::atomic::AtomicBool) -> anyhow::Result<Arc<Vec<Arc<IndexedSearchFile>>>> {
    loop {
        check_search_cancelled(cancelled)?;
        let _ = indexed_search_entries(root);
        let ready = {
            let indexes = search_indexes().lock().unwrap_or_else(|p| p.into_inner());
            indexes.get(&search_path_key(root))
                .filter(|index| !index.refreshing && index.pending_paths.is_empty() && index.pending_modified.is_empty())
                .map(|index| Arc::clone(&index.files))
        };
        if let Some(files) = ready {
            return Ok(files.lock().unwrap_or_else(|p| p.into_inner()).snapshot());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Builds the search index for `root` ahead of the first search.
pub fn prewarm_search_index(root: &Path) {
    let _ = indexed_search_entries(root);
}

fn search_ignore_configuration(path: &Path) -> bool {
    matches!(path.file_name().and_then(|name| name.to_str()), Some(".ignore" | ".gitignore" | ".git"))
        || path.ends_with(Path::new(".git/info/exclude"))
}

fn searchable_event_path(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else { return false; };
    search_ignore_configuration(path) || relative.ancestors().all(should_visit)
}

pub fn update_search_index_paths(root: &Path, paths: &[PathBuf]) {
    queue_search_index_paths(root, paths, false);
}

pub fn update_search_index_event(root: &Path, event: &notify::Event) {
    if event.need_rescan() {
        update_search_index_paths(root, &[root.to_path_buf()]);
        return;
    }
    let modified = matches!(event.kind, notify::EventKind::Modify(
        notify::event::ModifyKind::Any | notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Metadata(_)
    ));
    if !matches!(event.kind, notify::EventKind::Access(_)) {
        queue_search_index_paths(root, &event.paths, modified);
    }
}

fn queue_search_index_paths(root: &Path, paths: &[PathBuf], modified: bool) {
    let root_key = search_path_key(root);
    let schedule = {
        let mut indexes = search_indexes().lock().unwrap_or_else(|p| p.into_inner());
        let Some(index) = indexes.get_mut(&search_path_key(root)) else { return; };
        let files = index.files.lock().unwrap_or_else(|p| p.into_inner());
        for path in paths.iter().map(|path| search_path_key(path)).filter(|path| searchable_event_path(&root_key, path)) {
            if !modified || search_ignore_configuration(&path) {
                index.pending_modified.remove(&path);
                index.pending_paths.insert(path);
            } else if files.by_path.contains_key(&path) && !index.pending_paths.contains(&path) {
                index.pending_modified.insert(path);
            }
        }
        drop(files);
        if index.pending_paths.len() > 1024 { index.pending_paths.clear(); index.pending_paths.insert(search_path_key(root)); }
        index.checked_at = Instant::now() - SEARCH_INDEX_CHECK_INTERVAL;
        if !index.refreshing && (!index.pending_paths.is_empty() || !index.pending_modified.is_empty()) { index.refreshing = true; true } else { false }
    };
    if schedule {
        let root = root.to_path_buf();
        std::thread::spawn(move || {
            // Coalesce native bursts before scanning branches; never block the watcher callback.
            std::thread::sleep(Duration::from_millis(200));
            let (paths, modified) = {
                let mut indexes = search_indexes().lock().unwrap_or_else(|p| p.into_inner());
                let Some(index) = indexes.get_mut(&search_path_key(&root)) else { return; };
                (std::mem::take(&mut index.pending_paths), std::mem::take(&mut index.pending_modified))
            };
            refresh_search_index_changes(&root, &paths, &modified, false);
            // Events arriving during a scan belong to the following refresh.
            update_search_index_paths(&root, &[]);
        });
    }
}

#[cfg(test)]
fn refresh_search_index(root: &Path, paths: &std::collections::BTreeSet<PathBuf>, rebuild: bool) {
    refresh_search_index_changes(root, paths, &Default::default(), rebuild);
}

fn refresh_search_index_changes(root: &Path, paths: &std::collections::BTreeSet<PathBuf>, modified: &std::collections::BTreeSet<PathBuf>, rebuild: bool) {
    let gate = search_index_build_gate(root);
    let _guard = gate.lock().unwrap_or_else(|p| p.into_inner());
    if rebuild || paths.contains(&search_path_key(root)) || paths.iter().any(|path| search_ignore_configuration(path)) {
        build_search_index(root);
        return;
    }
    if !paths.is_empty() || !modified.is_empty() {
        let previous = search_indexes().lock().unwrap_or_else(|p| p.into_inner()).get(&search_path_key(root)).map(|index| Arc::clone(&index.files));
        if let Some(previous) = previous {
            refresh_search_files(root, &previous, paths, modified);
        }
    }
    if let Some(index) = search_indexes().lock().unwrap_or_else(|p| p.into_inner()).get_mut(&search_path_key(root)) { index.refreshing = false; }
}

fn refresh_search_files(root: &Path, entries: &Mutex<SearchFileEntries>, paths: &std::collections::BTreeSet<PathBuf>, modified: &std::collections::BTreeSet<PathBuf>) {
    let mut files = Vec::new();
    let updates: Vec<_> = {
        let entries = entries.lock().unwrap_or_else(|p| p.into_inner());
        modified.iter().filter(|path| !changed_search_path(path, paths))
            .filter_map(|path| entries.by_path.get(path).cloned()).collect()
    };
    let updates: Vec<_> = updates.into_iter().map(|file| {
        let updated = std::fs::metadata(&file.result.path).ok().filter(|metadata| metadata.is_file()).map(|metadata| {
            let mut result = file.result.clone();
            result.modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_secs());
            Arc::new(IndexedSearchFile { key: file.key.clone(), name: file.name.clone(), relative: file.relative.clone(), result })
        });
        (file.key.clone(), updated)
    }).collect();
    if !paths.is_empty() {
        let branches = paths.clone();
        let mut walker = ignore::WalkBuilder::new(root);
        walker.hidden(false).parents(false).filter_entry(move |entry| {
            (entry.depth() == 0 || should_visit(entry.path())) && search_branch_intersects(&search_path_key(entry.path()), &branches)
        });
        for entry in walker.build().filter_map(Result::ok) {
            let path = entry.path();
            if entry.file_type().is_some_and(|kind| kind.is_file()) && changed_search_path(&search_path_key(path), paths) {
                let relative = normalize_path(path.strip_prefix(root).unwrap_or(path));
                let name = entry.file_name().to_string_lossy().into_owned();
                files.push(Arc::new(IndexedSearchFile { key: search_path_key(path), name: name.to_lowercase(), relative: relative.to_lowercase(), result: ProjectFileMatch {
                    path: normalize_path(path), relative_path: relative, name,
                    modified: entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|t| t.as_secs()),
                }}));
            }
        }
    }
    let mut entries = entries.lock().unwrap_or_else(|p| p.into_inner());
    let mut changed = false;
    for path in paths {
        let removed: Vec<_> = entries.by_path.range(path.clone()..).take_while(|(key, _)| key.starts_with(path)).map(|(key, _)| key.clone()).collect();
        for key in removed { entries.by_path.remove(&key); changed = true; }
    }
    for file in files { entries.by_path.insert(file.key.clone(), file); changed = true; }
    for (path, file) in updates {
        if let Some(file) = file { entries.by_path.insert(path, file); } else { entries.by_path.remove(&path); }
        changed = true;
    }
    if changed { entries.snapshot = None; }
}

enum SearchWalkItem {
    File(Arc<IndexedSearchFile>),
}

// Parallel walk that honors .ignore/.gitignore plus the built-in IGNORED_DIRS.
// Hidden entries stay searchable so project config such as .vscode is still found.
fn build_search_index(root: &Path) -> Arc<Mutex<SearchFileEntries>> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(256);
    let collector = std::thread::spawn(move || receiver.into_iter().map(|item| match item { SearchWalkItem::File(file) => file }).collect::<Vec<_>>());
    ignore::WalkBuilder::new(root)
        .hidden(false)
        .parents(false)
        .filter_entry(|entry| entry.depth() == 0 || should_visit(entry.path()))
        .build_parallel()
        .run(|| {
            let sender = sender.clone();
            Box::new(move |entry| {
                let Ok(entry) = entry else { return ignore::WalkState::Continue };
                let path = entry.path();
                let item = match entry.file_type() {
                    Some(kind) if kind.is_dir() => return ignore::WalkState::Continue,
                    Some(kind) if kind.is_file() => {
                        let relative = normalize_path(path.strip_prefix(root).unwrap_or(path));
                        let name = entry.file_name().to_string_lossy().into_owned();
                        SearchWalkItem::File(Arc::new(IndexedSearchFile {
                            key: search_path_key(path),
                            name: name.to_lowercase(), relative: relative.to_lowercase(),
                            result: ProjectFileMatch { path: normalize_path(path), relative_path: relative, name,
                                modified: entry.metadata().ok().and_then(|metadata| metadata.modified().ok())
                                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_secs()) },
                        }))
                    }
                    _ => return ignore::WalkState::Continue,
                };
                let _ = sender.send(item);
                ignore::WalkState::Continue
            })
        });
    drop(sender);
    let files = collector.join().expect("search index collector panicked");
    let files = Arc::new(Mutex::new(SearchFileEntries {
        by_path: files.into_iter().map(|file| (file.key.clone(), file)).collect(), snapshot: None,
    }));
    let mut indexes = search_indexes().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Bound memory when switching between many projects.
    if indexes.len() >= 8 && !indexes.contains_key(&search_path_key(root)) {
        if let Some(oldest) = indexes.iter().min_by_key(|(_, index)| index.checked_at)
            .map(|(path, _)| path.clone()) {
            indexes.remove(&oldest);
        }
    }
    let (pending_paths, pending_modified) = indexes.remove(&search_path_key(root)).map(|index| (index.pending_paths, index.pending_modified)).unwrap_or_default();
    indexes.insert(search_path_key(root), FileSearchIndex {
        files: Arc::clone(&files), pending_paths, pending_modified,
        checked_at: Instant::now(), built_at: Instant::now(), refreshing: false,
    });
    files
}

struct FileSearchQuery<'a> {
    text: &'a str,
    tokens: Vec<&'a str>,
    abbreviation: Vec<char>,
    allow_path: bool,
}

impl<'a> FileSearchQuery<'a> {
    fn new(text: &'a str, name_only: bool) -> Self {
        let tokens: Vec<_> = text.split_whitespace().collect();
        let allow_path = !name_only || text.contains('/') || tokens.len() > 1;
        let mut abbreviation: Vec<_> = text.chars().collect();
        if abbreviation.len() < 3 || abbreviation.iter().any(|character| character.is_whitespace()) {
            abbreviation.clear();
        }
        Self { text, tokens, abbreviation, allow_path }
    }

    fn score(&self, file: &IndexedSearchFile) -> Option<usize> {
        let query = self.text;
        if file.name == query { return Some(0); }
        if file.name.rsplit_once('.').map(|(stem, _)| stem == query).unwrap_or(false) {
            return Some(1);
        }
        if file.name.starts_with(query) { return Some(2); }
        if file.name.contains(query) { return Some(3); }
        if self.allow_path && file.relative.contains(query) { return Some(4); }
        let haystack = if self.allow_path { &file.relative } else { &file.name };
        if self.tokens.len() > 1 && self.tokens.iter().all(|token| haystack.contains(token)) { return Some(5); }
        // Ordered abbreviation matching (e.g. PEP -> ProjectEditorPanel.vue).
        // Short queries stay literal to avoid flooding results with unrelated files.
        if !self.abbreviation.is_empty() {
            let mut chars = haystack.chars();
            if self.abbreviation.iter().all(|needle| chars.by_ref().any(|value| value == *needle)) {
                return Some(6);
            }
        }
        None
    }
}

#[cfg(test)]
fn file_search_score(file: &IndexedSearchFile, query: &str, name_only: bool) -> Option<usize> {
    FileSearchQuery::new(query, name_only).score(file)
}

pub fn begin_project_search(consumer: Option<&str>) -> Arc<std::sync::atomic::AtomicBool> {
    static QUERIES: OnceLock<Mutex<HashMap<String, std::sync::Weak<std::sync::atomic::AtomicBool>>>> = OnceLock::new();
    let token = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some(consumer) = consumer {
        let mut queries = QUERIES.get_or_init(Default::default).lock().unwrap_or_else(|p| p.into_inner());
        queries.retain(|_, token| token.strong_count() > 0);
        if let Some(previous) = queries.insert(consumer.to_owned(), Arc::downgrade(&token)).and_then(|token| token.upgrade()) {
            previous.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    token
}

fn check_search_cancelled(token: &std::sync::atomic::AtomicBool) -> anyhow::Result<()> {
    anyhow::ensure!(!token.load(std::sync::atomic::Ordering::Relaxed), "search cancelled");
    Ok(())
}

pub fn search_project_files(query: &str, roots: &[String], options: ProjectSearchOptions) -> anyhow::Result<ProjectSearchResult> {
    search_project_files_cancellable(query, roots, options, &std::sync::atomic::AtomicBool::new(false))
}

pub fn search_project_files_cancellable(
    query: &str,
    roots: &[String],
    options: ProjectSearchOptions,
    cancelled: &std::sync::atomic::AtomicBool,
) -> anyhow::Result<ProjectSearchResult> {
    search_project_files_streaming(query, roots, options, cancelled, None)
}

// Only standalone dot-prefixed terms are filters; filenames and paths remain literal queries.
fn split_search_extensions(query: &str) -> (String, Vec<String>) {
    let mut terms = Vec::new();
    let mut extensions = Vec::new();
    for term in query.split_whitespace() {
        let extension = term.strip_prefix('.').filter(|value| !value.is_empty()
            && value.split('.').all(|part| !part.is_empty()
                && part.chars().all(|ch| !ch.is_control() && !matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))));
        if extension.is_some() {
            let suffix = term.to_lowercase();
            if !extensions.contains(&suffix) { extensions.push(suffix); }
        } else {
            terms.push(term);
        }
    }
    let text = if extensions.is_empty() { query.trim().to_owned() } else { terms.join(" ") };
    (text, extensions)
}

fn search_extension_matches(extensions: &[String], name: &str) -> bool {
    extensions.is_empty() || {
        let name = name.to_lowercase();
        extensions.iter().any(|suffix| name.ends_with(suffix))
    }
}

pub fn search_project_files_streaming(
    query: &str, roots: &[String], options: ProjectSearchOptions,
    cancelled: &std::sync::atomic::AtomicBool,
    on_batch: Option<&(dyn Fn(Vec<TextSearchMatch>) + Sync)>,
) -> anyhow::Result<ProjectSearchResult> {
    // Dedicated find dialogs preserve literal whitespace/regex semantics.
    let (search_query, extensions) = if options.content_regex || options.preserve_whitespace {
        (query.to_owned(), Vec::new())
    } else {
        split_search_extensions(query)
    };
    let normalized_query = search_query.trim().to_lowercase();
    // Content search is deliberately line based. Rust regex rejects lookaround and backreferences.
    let content_query = search_query.as_str();
    let content_pattern = if options.content_regex { content_query.to_owned() } else { regex::escape(content_query) };
    if options.include_text {
        anyhow::ensure!(!query.contains(['\n', '\r']) && (!options.content_regex || !search_has_newline_escape(query)), "文件搜索仅支持单行表达式；跨行搜索请使用当前文件查找");
    }
    let content_regex = regex::RegexBuilder::new(&content_pattern)
        .case_insensitive(!options.case_sensitive).multi_line(false).build()?;
    let filters = search_include_filters(&options.include_filter)?;
    if query.is_empty() || (!options.preserve_whitespace && normalized_query.is_empty() && extensions.is_empty()) {
        return Ok(ProjectSearchResult {
            files: Vec::new(),
            text_matches: Vec::new(),
        });
    }

    check_search_cancelled(cancelled)?;
    let limit = options.limit.clamp(1, 500);
    let mut files = Vec::new();
    let mut text_matches = Vec::new();

    let file_query = normalized_query.replace('\\', "/");
    let file_matcher = FileSearchQuery::new(&file_query, options.file_name_only);
    let compare = |(left_score, left): &(usize, &ProjectFileMatch), (right_score, right): &(usize, &ProjectFileMatch)| {
        let order = match options.sort_mode.as_str() {
            "newest" => right.modified.cmp(&left.modified),
            "oldest" => match (left.modified, right.modified) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                _ => std::cmp::Ordering::Equal,
            },
            "mostOpened" => options.open_counts.get(&right.path.to_lowercase()).unwrap_or(&0)
                .cmp(options.open_counts.get(&left.path.to_lowercase()).unwrap_or(&0)),
            _ => std::cmp::Ordering::Equal,
        };
        order.then_with(|| left_score.cmp(right_score))
            .then_with(|| left.relative_path.len().cmp(&right.relative_path.len()))
            .then_with(|| left.path.cmp(&right.path))
    };
    let mut ranked = Vec::with_capacity(limit);
    let mut selected_paths = std::collections::HashSet::new();
    let mut snapshots = Vec::with_capacity(roots.len());
    for root in roots {
        check_search_cancelled(cancelled)?;
        snapshots.push(search_index_snapshot(Path::new(root), cancelled)?);
    }
    for index in snapshots.iter().filter(|_| options.include_files) {
        for file in index.iter() {
            check_search_cancelled(cancelled)?;
            if !extensions.is_empty() && !extensions.iter().any(|suffix| file.name.ends_with(suffix)) { continue; }
            if let Some(score) = file_matcher.score(file) {
                let candidate = (score, &file.result);
                let mut eligible = true;
                if selected_paths.contains(file.result.path.as_str()) {
                    let existing = ranked.iter().position(|(_, existing): &(usize, &ProjectFileMatch)| existing.path == file.result.path).expect("selected search path");
                    if compare(&ranked[existing], &candidate) != std::cmp::Ordering::Greater { eligible = false; }
                    else { ranked.remove(existing); }
                }
                let position = ranked.binary_search_by(|entry| compare(entry, &candidate)).unwrap_or_else(|position| position);
                if eligible && position < limit {
                    selected_paths.insert(file.result.path.as_str());
                    ranked.insert(position, candidate);
                    if ranked.len() > limit {
                        if let Some((_, removed)) = ranked.pop() { selected_paths.remove(removed.path.as_str()); }
                    }
                }
            }
        }
    }
    if options.include_text && !content_query.is_empty() {
        let mut buffer_paths = std::collections::HashSet::new();
        let mut buffer_candidates = Vec::new();
        for buffer in &options.buffers {
            check_search_cancelled(cancelled)?;
            let key = search_path_key(Path::new(&buffer.path));
            let Some(root) = roots.iter().map(|root| search_path_key(Path::new(root)))
                .find(|root| key.starts_with(root)) else { continue; };
            if !buffer_paths.insert(key) { continue; }
            let path = normalize_path(Path::new(&buffer.path));
            let relative: PathBuf = Path::new(&path).components().skip(root.components().count()).collect();
            buffer_candidates.push((ProjectFileMatch {
                name: Path::new(&path).file_name().unwrap_or_default().to_string_lossy().into_owned(),
                path, relative_path: normalize_path(&relative), modified: None,
            }, buffer.content.as_str()));
        }
        let mut scanned = std::collections::HashSet::new();
        // Open text snapshots take precedence, including unsaved files absent from the index.
        // Pull candidates lazily: a limit or cancellation never walks the rest of a million-file index.
        let mut candidates = buffer_candidates.iter().map(|(file, text)| (file, Some(*text)))
            .chain(snapshots.iter().flat_map(|index| index.iter())
                .filter(|file| !buffer_paths.contains(&file.key)).map(|file| (&file.result, None)))
            .take_while(|_| !cancelled.load(std::sync::atomic::Ordering::Relaxed))
            .filter(|(file, _)| search_extension_matches(&extensions, &file.name))
            .filter(|(file, _)| scanned.insert(file.path.as_str()))
            .filter(|(file, _)| search_filter_matches(&filters, &file.relative_path));
        // Reuse four workers; only one four-file batch is in flight, preserving index order.
        let (jobs, receiver) = std::sync::mpsc::sync_channel::<(usize, &ProjectFileMatch, Option<&str>)>(4);
        let receiver = std::sync::Mutex::new(receiver);
        let (completed, results) = std::sync::mpsc::sync_channel(4);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let receiver = &receiver;
                let completed = completed.clone();
                let pattern = &content_regex;
                let options = &options;
                scope.spawn(move || loop {
                    let job = receiver.lock().unwrap().recv();
                    let Ok((index, file, buffer)) = job else { break; };
                    let mut rows = Vec::new();
                    if !cancelled.load(std::sync::atomic::Ordering::Relaxed) {
                        let full_lines = options.full_content_lines && on_batch.is_none();
                        if let Some(text) = buffer {
                            collect_reader_matches(std::io::Cursor::new(text.as_bytes()), &file.path,
                                &file.relative_path, pattern, &mut rows, limit, full_lines, options.whole_word, cancelled);
                        } else {
                            let path = Path::new(&file.path);
                            if is_probably_text(path) && is_searchable_text(path) {
                                collect_text_matches(path, &file.path, &file.relative_path,
                                    pattern, &mut rows, limit, full_lines, options.whole_word, cancelled);
                            }
                        }
                    }
                    if completed.send((index, rows)).is_err() { break; }
                });
            }
            drop(completed);
            loop {
                if cancelled.load(std::sync::atomic::Ordering::Relaxed) { break; }
                let mut count = 0;
                for _ in 0..4 {
                    let Some((file, buffer)) = candidates.next() else { break; };
                    jobs.send((count, file, buffer)).expect("content search workers");
                    count += 1;
                }
                if count == 0 { break; }
                let mut batches: Vec<_> = (0..count).map(|_| results.recv().expect("content search result")).collect();
                batches.sort_by_key(|(index, _)| *index);
                for (_, rows) in batches {
                    let rows: Vec<_> = rows.into_iter().take(limit - text_matches.len()).collect();
                    if let Some(send) = on_batch {
                        // Previews are bounded to 2 KiB; at most 16 rows per IPC message.
                        for chunk in rows.chunks(16) { if !chunk.is_empty() { send(chunk.to_vec()); } }
                    }
                    text_matches.extend(rows);
                }
                if text_matches.len() >= limit { break; }
            }
            drop(jobs);
        });
    }
    check_search_cancelled(cancelled)?;
    let mut seen = std::collections::HashSet::new();
    files.extend(ranked.into_iter().map(|(_, file)| file.clone())
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
    // Derived workspace data and run logs must never become input to its own search index.
    if (name.eq_ignore_ascii_case("cache") || name.eq_ignore_ascii_case("log"))
        && path.parent().and_then(Path::file_name)
            .is_some_and(|parent| parent.eq_ignore_ascii_case(".superhigh"))
    {
        return false;
    }
    !IGNORED_DIRS
        .iter()
        .any(|ignored| ignored.eq_ignore_ascii_case(&name))
}

fn is_searchable_text(path: &Path) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.len() <= MAX_SEARCH_TEXT_FILE_BYTES)
        .unwrap_or(false)
}

fn search_has_newline_escape(query: &str) -> bool {
    let mut chars = query.chars();
    while let Some(character) = chars.next() {
        if character == '\\' && matches!(chars.next(), Some('n' | 'r')) { return true; }
    }
    false
}

fn search_include_filters(filter: &str) -> anyhow::Result<Vec<(bool, regex::Regex)>> {
    if matches!(filter.trim(), "" | "*" | "*.*") { return Ok(Vec::new()); }
    filter.split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .filter(|pattern| !pattern.is_empty())
        .map(|pattern| {
            let pattern = pattern.replace('\\', "/");
            let source = regex::escape(&pattern).replace("\\*", ".*").replace("\\?", ".");
            Ok((pattern.contains('/'), regex::RegexBuilder::new(&format!("^{source}$")).case_insensitive(true).build()?))
        }).collect()
}

fn search_filter_matches(filters: &[(bool, regex::Regex)], relative: &str) -> bool {
    filters.is_empty() || filters.iter().any(|(path, pattern)| {
        pattern.is_match(if *path { relative } else { relative.rsplit('/').next().unwrap_or(relative) })
    })
}

fn collect_text_matches(
    path: &Path,
    full_path: &str,
    relative_path: &str,
    pattern: &regex::Regex,
    text_matches: &mut Vec<TextSearchMatch>,
    max_matches: usize,
    full_content_lines: bool,
    whole_word: bool,
    cancelled: &std::sync::atomic::AtomicBool,
) {
    let Ok(file) = fs::File::open(path) else {
        return;
    };
    collect_reader_matches(BufReader::new(file), full_path, relative_path, pattern, text_matches,
        max_matches, full_content_lines, whole_word, cancelled);
}

fn collect_reader_matches(
    mut reader: impl BufRead,
    full_path: &str, relative_path: &str, pattern: &regex::Regex,
    text_matches: &mut Vec<TextSearchMatch>, max_matches: usize,
    full_content_lines: bool, whole_word: bool,
    cancelled: &std::sync::atomic::AtomicBool,
) {
    let mut index = 0;
    loop {
        if text_matches.len() >= max_matches || cancelled.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let mut bytes = Vec::new();
        loop {
            if cancelled.load(std::sync::atomic::Ordering::Relaxed) { return; }
            let Ok(buffer) = reader.fill_buf() else { return; };
            if buffer.is_empty() { break; }
            let length = buffer.iter().position(|byte| *byte == b'\n').map(|position| position + 1).unwrap_or(buffer.len());
            let newline = buffer[length - 1] == b'\n';
            bytes.extend_from_slice(&buffer[..length]);
            reader.consume(length);
            if newline { break; }
        }
        if bytes.is_empty() { break; }
        let Ok(line) = String::from_utf8(bytes) else { return; };
        let line = line.trim_end_matches(['\r', '\n']);
        if let Some(found) = pattern.find_iter(line).find(|found| !whole_word || {
            // Match the current-file JavaScript \w boundaries: ASCII letters, digits and underscore.
            let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
            !line[..found.start()].chars().next_back().is_some_and(word)
                && !line[found.end()..].chars().next().is_some_and(word)
        }) {
            let column = found.start();
            text_matches.push(TextSearchMatch {
                path: full_path.to_string(),
                relative_path: relative_path.to_string(),
                line_number: index + 1,
                column: line[..column].encode_utf16().count() + 1,
                preview: if full_content_lines { line.trim().to_owned() } else {
                    line.chars().skip(line[..column].chars().count().saturating_sub(100)).take(500).collect::<String>().trim().to_owned()
                },
            });
        }
        index += 1;
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

fn has_binary_control_prefix(path: &Path) -> anyhow::Result<bool> {
    let file = fs::File::open(path)
        .with_context(|| format!("无法打开文件：{}", path.display()))?;
    let mut sample = Vec::with_capacity(TEXT_PROBE_BYTES as usize);
    file.take(TEXT_PROBE_BYTES).read_to_end(&mut sample)
        .with_context(|| format!("无法读取文件：{}", path.display()))?;
    let is_utf16 = sample.starts_with(&[0xFF, 0xFE]) || sample.starts_with(&[0xFE, 0xFF]);
    Ok(!is_utf16 && sample.iter().any(|byte| is_binary_control(*byte)))
}

fn is_binary_control(byte: u8) -> bool {
    matches!(byte, 0..=8 | 14..=26 | 28..=31 | 127)
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

pub(crate) fn media_mime_type(path: &Path) -> Option<&'static str> {
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
        "glb" => Some("model/gltf-binary"),
        "gltf" => Some("model/gltf+json"),
        "bin" => Some("application/octet-stream"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
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
    fn text_read_reports_io_errors_instead_of_binary_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("missing.json");
        for result in [super::read_text_file(&path),
            super::read_text_file_with_encoding(&path, None).map(|file| file.content)] {
            let error = result.unwrap_err();
            assert!(!error.to_string().contains("二进制"));
            assert_eq!(error.downcast_ref::<std::io::Error>().unwrap().kind(), std::io::ErrorKind::NotFound);
        }
    }

    #[cfg(windows)]
    #[test]
    fn text_read_reports_exclusive_writer_lock_instead_of_binary_content() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("data.json");
        std::fs::write(&path, "{\"valid\":true}").unwrap();
        let writer = std::fs::OpenOptions::new().write(true).share_mode(0).open(&path).unwrap();
        for result in [super::read_text_file(&path),
            super::read_text_file_with_encoding(&path, None).map(|file| file.content)] {
            let error = result.unwrap_err();
            assert!(!error.to_string().contains("二进制"));
            assert_eq!(error.downcast_ref::<std::io::Error>().unwrap().raw_os_error(), Some(32));
        }
        drop(writer);
        assert_eq!(super::read_text_file(&path).unwrap(), "{\"valid\":true}");
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
    fn text_read_allows_models_through_256_mb_and_preserves_other_limits() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("model.BBMODEL");
        let mut file = std::fs::File::create(&path).unwrap();
        let block = vec![b' '; 1024 * 1024];
        for _ in 0..256 { file.write_all(&block).unwrap(); }
        drop(file);
        assert_eq!(super::read_text_file(&path).unwrap().len() as u64, super::MAX_MODEL_FILE_BYTES);
        std::fs::OpenOptions::new().write(true).open(&path).unwrap()
            .set_len(super::MAX_MODEL_FILE_BYTES + 1).unwrap();
        assert!(super::read_text_file(&path).unwrap_err().to_string().contains("256 MB"));
        let text = directory.path().join("model.json");
        std::fs::rename(&path, &text).unwrap();
        assert!(super::read_text_file(&text).unwrap_err().to_string().contains("10 MB"));
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
        for name in ["document.DOCX", "sheet.xls", "sheet.XLS", "sheet.xlsx", "document.pdf", "slides.ppt", "slides.PPTX"] {
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
        let unsupported = directory.path().join("document.pages");
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
    fn editor_text_reads_and_round_trips_gbk_and_utf16_bom() {
        let directory = tempfile::tempdir().unwrap();
        let gbk_path = directory.path().join("legacy.log");
        let source = "[Super High] Starting application...\r\n\x1b[31m拒绝访问。\x1b[0m\r\n[Super High] Build ✓ complete\r\n";
        let (prefix, _, prefix_errors) = encoding_rs::GBK.encode("[Super High] Starting application...\r\n\x1b[31m拒绝访问。\x1b[0m\r\n");
        let (suffix, _, suffix_errors) = encoding_rs::UTF_8.encode("[Super High] Build ✓ complete\r\n");
        assert!(!prefix_errors && !suffix_errors);
        let mut mixed_bytes = prefix.into_owned();
        mixed_bytes.extend_from_slice(&suffix);
        std::fs::write(&gbk_path, &mixed_bytes).unwrap();
        let gbk = super::read_text_file_with_encoding(&gbk_path, None).unwrap();
        assert_eq!(gbk.content, source);
        assert_eq!(gbk.encoding, "mixed:utf-8+gbk");
        assert!(super::write_text_file_with_encoding(&gbk_path, &gbk.content, &gbk.encoding).unwrap_err().to_string().contains("转换为单一编码"));
        super::write_text_file_with_encoding(&gbk_path, &gbk.content, "utf-8").unwrap();
        assert_eq!(super::read_text_file_with_encoding(&gbk_path, None).unwrap().content, source);

        let utf16_path = directory.path().join("bom.txt");
        super::write_text_file_with_encoding(&utf16_path, "Unicode 中文\n", "utf-16le-bom").unwrap();
        let utf16 = super::read_text_file_with_encoding(&utf16_path, None).unwrap();
        assert_eq!(utf16.content, "Unicode 中文\n");
        assert_eq!(utf16.encoding, "utf-16le-bom");
        super::write_text_file_with_encoding(&utf16_path, &utf16.content, &utf16.encoding).unwrap();
        assert!(std::fs::read(&utf16_path).unwrap().starts_with(&[0xFF, 0xFE]));
    }

    #[test]
    fn encoded_save_rejects_unrepresentable_text_without_replacing_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.txt");
        std::fs::write(&path, b"original").unwrap();
        let error = super::write_text_file_with_encoding(&path, "emoji 😀", "gbk").unwrap_err();
        assert!(error.to_string().contains("无法用 GBK 表示"));
        assert_eq!(std::fs::read(path).unwrap(), b"original");
    }

    #[test]
    fn save_download_preserves_binary_bytes_and_rejects_invalid_data_before_writing() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("download.bin");
        let bytes = [0, 255, 128, 13, 10];
        super::save_download_data_url(&path, &format!("data:application/octet-stream;base64,{}", STANDARD.encode(bytes))).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(super::save_download_data_url(&path, "data:text/plain;base64,invalid!").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert!(super::save_download_data_url(std::path::Path::new("relative.bin"), "data:text/plain;base64,e30=").is_err());
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
            normalize_path(std::path::Path::new(r"\\?\D:\Demo Files\src\App.vue")),
            "D:/Demo Files/src/App.vue"
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
    fn search_extension_queries_filter_before_name_ranking_and_text_io() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["角色.YAML", "角色.yml", "角色.json", "角色.yaml.bak", "角色.txt"] {
            std::fs::write(directory.path().join(name), "needle .yaml").unwrap();
        }
        let roots = [directory.path().to_string_lossy().into_owned()];
        let only_types = search_project_files(".yaml .YML", &roots, Default::default()).unwrap();
        assert_eq!(only_types.files.len(), 2);
        assert!(only_types.text_matches.is_empty());
        let named = search_project_files("角色 .yaml .yml", &roots, Default::default()).unwrap();
        assert_eq!(named.files.len(), 2);
        assert!(named.files.iter().all(|file| file.name == "角色.YAML" || file.name == "角色.yml"));
        let json = search_project_files(".JSON needle", &roots, ProjectSearchOptions {
            include_filter: "*.json".into(), limit: 1, ..Default::default()
        }).unwrap();
        assert_eq!(json.text_matches.len(), 1);
        assert!(json.text_matches[0].path.ends_with("角色.json"));
        let buffer = search_project_files("needle .YML", &roots, ProjectSearchOptions {
            buffers: vec![crate::models::ProjectSearchBuffer {
                path: directory.path().join("unsaved.YmL").to_string_lossy().into_owned(),
                content: "needle unsaved".into(),
            }], limit: 1, ..Default::default()
        }).unwrap();
        assert_eq!(buffer.text_matches.len(), 1);
        assert!(buffer.text_matches[0].path.ends_with("unsaved.YmL"));
        assert_eq!(super::split_search_extensions("file.json").0, "file.json");
        assert!(super::split_search_extensions(". ../dir .json/config").1.is_empty());
        assert_eq!(super::split_search_extensions(".tar.gz .env").1, vec![".tar.gz", ".env"]);
        for options in [ProjectSearchOptions { preserve_whitespace: true, ..Default::default() },
            ProjectSearchOptions { content_regex: true, ..Default::default() }] {
            assert_eq!(search_project_files(".yaml", &roots, options).unwrap().text_matches.len(), 5);
        }
        let custom_root = tempfile::tempdir().unwrap();
        std::fs::write(custom_root.path().join("custom.Foo@BAR"), "body").unwrap();
        std::fs::write(custom_root.path().join("other.json"), "body").unwrap();
        let custom = search_project_files(".foo@bar .JSON", &[custom_root.path().to_string_lossy().into_owned()], Default::default()).unwrap();
        assert_eq!(custom.files.len(), 2);
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
    fn content_search_filters_before_limit_and_supports_regex_alternation() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("first.txt"), "alpha\n".repeat(600)).unwrap();
        std::fs::write(directory.path().join("wanted.rs"), "alphabet\nBETA\n😀 beta\n").unwrap();
        let roots = [directory.path().to_string_lossy().into_owned()];
        let result = search_project_files("alpha|beta", &roots, ProjectSearchOptions {
            content_regex: true, include_filter: "*.rs".into(), whole_word: true, limit: 2,
            ..Default::default()
        }).unwrap();
        assert_eq!(result.text_matches.len(), 2);
        assert_eq!(result.text_matches[0].line_number, 2);
        assert_eq!(result.text_matches[1].column, 4);
        let chars = search_project_files("[ab]", &roots, ProjectSearchOptions {
            content_regex: true, include_filter: "*.rs".into(), case_sensitive: true,
            ..Default::default()
        }).unwrap();
        assert_eq!(chars.text_matches.len(), 2);
        for unsupported in ["(?=alpha)", "(alpha)\\1", "alpha\\nbeta"] {
            assert!(search_project_files(unsupported, &roots, ProjectSearchOptions {
                content_regex: true, ..Default::default()
            }).is_err());
        }
    }

    #[test]
    fn content_search_preserves_legacy_trim_and_supports_exact_whitespace() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("body.txt"), "needle\n needle \n\\n\n").unwrap();
        let roots = [directory.path().to_string_lossy().into_owned()];
        assert_eq!(search_project_files(" needle ", &roots, Default::default()).unwrap().text_matches.len(), 2);
        let exact = search_project_files(" needle ", &roots, ProjectSearchOptions {
            preserve_whitespace: true, include_filter: "*.rs *".into(), ..Default::default()
        }).unwrap();
        assert_eq!(exact.text_matches.len(), 1);
        assert_eq!(exact.text_matches[0].line_number, 2);
        assert_eq!(search_project_files("\\n", &roots, Default::default()).unwrap().text_matches.len(), 1);
    }

    #[test]
    fn content_search_buffers_override_disk_and_include_unsaved_paths_before_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("saved.txt");
        std::fs::write(&path, "needle stale disk").unwrap();
        let new_path = directory.path().join("not-saved.txt");
        let outside = tempfile::tempdir().unwrap();
        let roots = [directory.path().to_string_lossy().into_owned()];
        let options = || ProjectSearchOptions {
            include_files: false, include_filter: "*.txt".into(),
            buffers: vec![
                crate::models::ProjectSearchBuffer { path: path.to_string_lossy().into_owned(), content: "edited without match".into() },
                crate::models::ProjectSearchBuffer { path: new_path.to_string_lossy().into_owned(), content: "😀 needle new buffer".into() },
                crate::models::ProjectSearchBuffer { path: outside.path().join("outside.txt").to_string_lossy().into_owned(), content: "needle outside scope".into() },
                crate::models::ProjectSearchBuffer { path: directory.path().join("filtered.rs").to_string_lossy().into_owned(), content: "needle wrong glob".into() },
            ], ..Default::default()
        };
        let result = search_project_files("needle", &roots, options()).unwrap();
        assert!(result.files.is_empty());
        assert_eq!(result.text_matches.len(), 1);
        assert_eq!(result.text_matches[0].path, super::normalize_path(&new_path));
        assert_eq!(result.text_matches[0].column, 4);
        let mut limited = options();
        limited.limit = 1;
        limited.buffers[0].content = "needle edited buffer".into();
        let result = search_project_files("needle", &roots, limited).unwrap();
        assert_eq!(result.text_matches.len(), 1);
        assert_eq!(result.text_matches[0].preview, "needle edited buffer");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "needle stale disk");
        assert!(!new_path.exists());
    }

    #[test]
    fn content_search_whole_word_matches_existing_javascript_ascii_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("body.txt"), "中文\n中文文本\na中文\n中文_\n").unwrap();
        let result = search_project_files("中文", &[directory.path().to_string_lossy().into_owned()], ProjectSearchOptions {
            whole_word: true, include_files: false, ..Default::default()
        }).unwrap();
        // Chinese neighbours are non-word characters in the existing JS whole-word mode.
        assert_eq!(result.text_matches.iter().map(|row| row.line_number).collect::<Vec<_>>(), vec![1, 2]);
        assert!(result.files.is_empty());
    }

    #[test]
    fn content_search_streams_ordered_bounded_rows_and_observes_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("body.txt"), format!("needle{}\n", "x".repeat(20_000)).repeat(40)).unwrap();
        let roots = [directory.path().to_string_lossy().into_owned()];
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let batches = std::sync::Mutex::new(Vec::new());
        let send = |rows: Vec<crate::models::TextSearchMatch>| {
            assert!(rows.len() <= 16);
            assert!(rows.iter().all(|row| row.preview.len() <= 2000));
            batches.lock().unwrap().extend(rows);
        };
        let result = super::search_project_files_streaming("needle", &roots, Default::default(), &cancelled, Some(&send)).unwrap();
        assert_eq!(result.text_matches.len(), 40);
        assert_eq!(batches.lock().unwrap().iter().map(|row| row.line_number).collect::<Vec<_>>(), (1..=40).collect::<Vec<_>>());
        let cancel = |_rows| { cancelled.store(true, std::sync::atomic::Ordering::Relaxed); };
        assert!(super::search_project_files_streaming("needle", &roots, Default::default(), &cancelled, Some(&cancel)).is_err());
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
                limit: 80, ..ProjectSearchOptions::default()
            },
        )
        .unwrap();

        assert_eq!(result.files.len(), 1);
        assert!(result.files[0].relative_path.ends_with("needle-name.txt"));
        assert!(result.text_matches.is_empty());
    }

    #[test]
    fn file_search_sorts_all_candidates_before_limit() {
        let directory = tempfile::tempdir().unwrap();
        for (name, seconds) in [("file-old.txt", 100), ("file-new.txt", 200)] {
            let path = directory.path().join(name);
            std::fs::write(&path, "content").unwrap();
            std::fs::File::options().write(true).open(path).unwrap().set_times(
                std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds))
            ).unwrap();
        }
        let roots = vec![directory.path().to_string_lossy().to_string()];
        for (mode, expected) in [("newest", "file-new.txt"), ("oldest", "file-old.txt"), ("mostOpened", "file-old.txt")] {
            let counts = [(super::normalize_path(&directory.path().join("file-old.txt")).to_lowercase(), 5)].into_iter().collect();
            let result = search_project_files("file", &roots, ProjectSearchOptions {
                include_text: false, file_name_only: true, limit: 1, sort_mode: mode.into(), open_counts: counts, ..Default::default()
            }).unwrap();
            assert_eq!(result.files[0].name, expected);
            assert!(result.files[0].modified.is_some());
        }
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
                limit: 80, ..ProjectSearchOptions::default()
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
            ProjectSearchOptions { include_text: false, file_name_only: true, limit: 80, ..ProjectSearchOptions::default()}).unwrap();
        assert_eq!(result.files.len(), 2);
        assert!(result.files.iter().all(|file| !file.relative_path.contains("staging")));
    }

    #[test]
    fn file_search_excludes_workspace_cache_but_keeps_other_cache_directories() {
        let directory = tempfile::tempdir().unwrap();
        for folder in [".superhigh/cache/nested", ".superhigh/log/agents-updater", ".superhigh/editor", "src/cache", "child/.superhigh/cache"] {
            std::fs::create_dir_all(directory.path().join(folder)).unwrap();
            std::fs::write(directory.path().join(folder).join("needle.json"), "needle").unwrap();
        }
        let result = search_project_files("needle", &[directory.path().to_string_lossy().to_string()],
            ProjectSearchOptions { include_text: true, file_name_only: true, limit: 80, ..ProjectSearchOptions::default() }).unwrap();
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.text_matches.len(), 2);
        assert!(result.files.iter().all(|file| !file.relative_path.contains(".superhigh/cache") && !file.relative_path.contains(".superhigh/log")));
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
            include_text: false, file_name_only: true, limit: 1, ..ProjectSearchOptions::default()
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
        super::update_search_index_paths(directory.path(), &[directory.path().join("new-file.txt")]);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // The first search after the check interval returns the current index and refreshes in the background.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while search("new-file").files.first().map(|file| file.name.as_str()) != Some("new-file.txt") {
            assert!(std::time::Instant::now() < deadline, "background refresh did not pick up new-file.txt");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[test]
    fn top_k_matches_full_sort_for_all_modes_and_overlapping_roots() {
        let directory = tempfile::tempdir().unwrap();
        let nested = directory.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let mut counts = std::collections::HashMap::new();
        for i in 0..700 {
            let path = nested.join(format!("file-{i:04}.txt"));
            std::fs::write(&path, "").unwrap();
            std::fs::File::options().write(true).open(&path).unwrap().set_times(
                std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs((i % 17 + 100) as u64))).unwrap();
            counts.insert(super::normalize_path(&path).to_lowercase(), (i % 13) as u64);
        }
        let roots = vec![directory.path().to_string_lossy().into_owned(), nested.to_string_lossy().into_owned()];
        for mode in ["name", "newest", "oldest", "mostOpened"] {
            let options = ProjectSearchOptions { include_text: false, limit: 17, sort_mode: mode.into(), open_counts: counts.clone(), ..Default::default() };
            let mut all: Vec<_> = roots.iter().flat_map(|root| super::indexed_search_files(std::path::Path::new(root)).as_ref().clone()).collect();
            all.sort_by(|left, right| {
                let order = match mode {
                    "newest" => right.result.modified.cmp(&left.result.modified),
                    "oldest" => left.result.modified.cmp(&right.result.modified),
                    "mostOpened" => counts.get(&right.result.path.to_lowercase()).cmp(&counts.get(&left.result.path.to_lowercase())),
                    _ => std::cmp::Ordering::Equal,
                };
                order.then_with(|| super::file_search_score(left, "file", false).cmp(&super::file_search_score(right, "file", false)))
                    .then_with(|| left.result.relative_path.len().cmp(&right.result.relative_path.len()))
                    .then_with(|| left.result.path.cmp(&right.result.path))
            });
            let mut seen = std::collections::HashSet::new();
            let expected: Vec<_> = all.into_iter().filter(|file| seen.insert(file.result.path.clone())).take(17).map(|file| file.result.path.clone()).collect();
            let actual = search_project_files("file", &roots, options).unwrap();
            assert_eq!(actual.files.into_iter().map(|file| file.path).collect::<Vec<_>>(), expected, "{mode}");
        }
    }

    #[test]
    fn search_cancellation_is_scoped_and_stops_text_io() {
        let first = super::begin_project_search(Some("cancel-test-a"));
        let other = super::begin_project_search(Some("cancel-test-b"));
        let _latest = super::begin_project_search(Some("cancel-test-a"));
        assert!(super::check_search_cancelled(&first).is_err());
        assert!(super::check_search_cancelled(&other).is_ok());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("body.txt");
        std::fs::write(&path, "needle").unwrap();
        let mut matches = Vec::new();
        super::collect_text_matches(&path, "body.txt", "body.txt", &regex::Regex::new("needle").unwrap(), &mut matches, 20, false, false, &first);
        assert!(matches.is_empty());
        assert!(super::search_project_files_cancellable("needle", &[], Default::default(), &first).is_err());
    }

    #[test]
    fn content_search_matches_after_preview_cutoff() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("body.txt"), format!("{}needle{}", "x".repeat(9000), "y".repeat(9000))).unwrap();
        let result = search_project_files("needle", &[directory.path().to_string_lossy().into_owned()], Default::default()).unwrap();
        assert_eq!(result.text_matches.len(), 1);
        assert!(result.text_matches[0].preview.contains("needle"));
        assert!(result.text_matches[0].preview.chars().count() <= 500);
        assert_eq!(result.text_matches[0].column, 9001);
    }

    #[test]
    fn full_content_lines_preserve_far_context_for_js_validation() {
        let directory = tempfile::tempdir().unwrap();
        let line = format!("BEGIN needle {} END", "x".repeat(9000));
        std::fs::write(directory.path().join("body.txt"), &line).unwrap();
        let result = search_project_files("needle", &[directory.path().to_string_lossy().into_owned()], ProjectSearchOptions {
            full_content_lines: true, ..Default::default()
        }).unwrap();
        assert_eq!(result.text_matches[0].preview, line);
    }

    #[test]
    fn incremental_refresh_reuses_unchanged_file_allocations() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let changed = root.join("changed.txt");
        std::fs::write(&changed, "old").unwrap();
        std::fs::write(root.join("keep.txt"), "untouched").unwrap();
        let before = super::indexed_search_files(root);
        let entries = super::indexed_search_entries(root);
        std::fs::write(&changed, "new").unwrap();
        super::search_indexes().lock().unwrap().remove(&super::search_path_key(root));
        let paths = [super::search_path_key(&changed)].into_iter().collect();
        super::refresh_search_files(root, &entries, &paths, &Default::default());
        let after = entries.lock().unwrap().snapshot();
        let find = |snapshot: &std::sync::Arc<Vec<std::sync::Arc<super::IndexedSearchFile>>>, name: &str| {
            snapshot.iter().find(|file| file.name == name).unwrap().clone()
        };
        assert!(std::sync::Arc::ptr_eq(&find(&before, "keep.txt"), &find(&after, "keep.txt")));
        assert!(!std::sync::Arc::ptr_eq(&find(&before, "changed.txt"), &find(&after, "changed.txt")));
    }

    #[test]
    fn content_events_skip_ignored_files_and_only_update_indexed_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let keep = root.join("keep.txt");
        let ignored = root.join("ignored.log");
        std::fs::write(root.join(".ignore"), "*.log\n").unwrap();
        std::fs::write(&keep, "body").unwrap();
        std::fs::write(&ignored, "log").unwrap();
        let entries = super::indexed_search_entries(root);
        let before = entries.lock().unwrap().snapshot();
        for _ in 0..40 {
            super::update_search_index_event(root, &notify::Event::new(notify::EventKind::Modify(notify::event::ModifyKind::Any)).add_path(ignored.clone()));
        }
        assert!(std::sync::Arc::ptr_eq(&before, &entries.lock().unwrap().snapshot()));
        {
            let indexes = super::search_indexes().lock().unwrap();
            let index = indexes.get(&super::search_path_key(root)).unwrap();
            assert!(!index.refreshing);
            assert!(index.pending_paths.is_empty() && index.pending_modified.is_empty());
        }
        std::fs::File::options().write(true).open(&keep).unwrap().set_times(
            std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(123))).unwrap();
        super::refresh_search_files(root, &entries, &Default::default(), &[super::search_path_key(&keep)].into_iter().collect());
        assert!(entries.lock().unwrap().snapshot.is_none());
        assert_eq!(entries.lock().unwrap().by_path[&super::search_path_key(&keep)].result.modified, Some(123));
        assert_ne!(before.iter().find(|file| file.name == "keep.txt").unwrap().result.modified, Some(123));
    }

    #[test]
    fn incremental_paths_preserve_nested_ignore_and_same_prefix_siblings() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for name in ["folder", "folder-other"] { std::fs::create_dir(root.join(name)).unwrap(); }
        std::fs::write(root.join(".ignore"), "*.log\n").unwrap();
        std::fs::write(root.join("folder/.ignore"), "!allowed.log\n").unwrap();
        std::fs::write(root.join("folder/old.txt"), "").unwrap();
        std::fs::write(root.join("folder-other/keep.txt"), "").unwrap();
        let entries = super::indexed_search_entries(root);
        std::fs::write(root.join("folder/allowed.log"), "").unwrap();
        std::fs::write(root.join("folder/ignored.log"), "").unwrap();
        let paths = [super::search_path_key(&root.join("folder"))].into_iter().collect();
        super::refresh_search_files(root, &entries, &paths, &Default::default());
        let snapshot = entries.lock().unwrap().snapshot();
        assert!(snapshot.iter().any(|file| file.name == "allowed.log"));
        assert!(!snapshot.iter().any(|file| file.name == "ignored.log"));
        assert!(snapshot.iter().any(|file| file.name == "keep.txt"));
        std::fs::remove_dir_all(root.join("folder")).unwrap();
        super::refresh_search_files(root, &entries, &paths, &Default::default());
        assert!(entries.lock().unwrap().snapshot().iter().any(|file| file.name == "keep.txt"));
        assert!(!entries.lock().unwrap().snapshot().iter().any(|file| file.name == "allowed.log"));
    }

    #[test]
    fn search_events_skip_ignored_ancestors_but_keep_config_and_unexpanded_paths() {
        let root = super::search_path_key(std::path::Path::new("root"));
        for relative in ["node_modules/package/index.js", "target/debug/build.log", ".superhigh/cache/index.json", ".superhigh/log/run.txt"] {
            assert!(!super::searchable_event_path(&root, &root.join(relative)), "{relative}");
        }
        for relative in ["src/unexpanded/child.txt", ".vscode/settings.json", ".superhigh/editor/layout.json", ".ignore", "nested/.gitignore", ".git/info/exclude"] {
            assert!(super::searchable_event_path(&root, &root.join(relative)), "{relative}");
        }
        assert!(!super::searchable_event_path(&root, std::path::Path::new("other/file.txt")));
    }

    #[test]
    fn changed_prefix_lookup_uses_component_ancestors() {
        let root = std::path::Path::new("root");
        let changes = [root.join("folder"), root.join("single.txt")].into_iter().collect();
        assert!(super::changed_search_path(&root.join("folder/child.txt"), &changes));
        assert!(super::changed_search_path(&root.join("single.txt"), &changes));
        assert!(!super::changed_search_path(&root.join("folder-other/child.txt"), &changes));
        assert!(super::search_branch_intersects(root, &changes));
        assert!(!super::search_branch_intersects(&root.join("unrelated"), &changes));
    }

    #[cfg(windows)]
    #[test]
    fn watcher_keys_accept_extended_prefix_and_different_windows_case() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        super::prewarm_search_index(root);
        let path = root.join("needle.txt");
        std::fs::write(&path, "").unwrap();
        let alternate_root = std::path::PathBuf::from(super::normalize_path(root).to_uppercase());
        let alternate_path = std::path::PathBuf::from(format!("\\\\?\\{}", super::normalize_path(&path).replace('/', "\\").to_uppercase()));
        super::update_search_index_paths(&alternate_root, &[alternate_path]);
        let result = search_project_files("needle", &[root.to_string_lossy().into_owned()], Default::default()).unwrap();
        assert_eq!(result.files.len(), 1);
    }

    #[test]
    fn watcher_event_is_visible_to_the_immediate_single_query() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        super::prewarm_search_index(root);
        let path = root.join("needle.txt");
        std::fs::write(&path, "").unwrap();
        super::update_search_index_paths(root, &[path.clone()]);
        let roots = [root.to_string_lossy().into_owned()];
        let query = || search_project_files("needle", &roots, ProjectSearchOptions { include_text: false, ..Default::default() }).unwrap();
        assert_eq!(query().files.len(), 1);
        let renamed = root.join("needle-renamed.txt");
        std::fs::rename(&path, &renamed).unwrap();
        super::update_search_index_paths(root, &[path, renamed.clone()]);
        assert_eq!(query().files[0].name, "needle-renamed.txt");
        std::fs::remove_file(&renamed).unwrap();
        super::update_search_index_paths(root, &[renamed]);
        assert!(query().files.is_empty());
    }

    #[test]
    fn watcher_updates_create_delete_directory_rename_and_ignore() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        super::prewarm_search_index(root);
        let old = root.join("old");
        let new = root.join("new");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("needle.txt"), "body").unwrap();
        let refresh = |paths: Vec<std::path::PathBuf>| {
            super::update_search_index_paths(root, &paths);
            let pending = {
                let mut indexes = super::search_indexes().lock().unwrap();
                std::mem::take(&mut indexes.get_mut(&super::search_path_key(root)).unwrap().pending_paths)
            };
            super::refresh_search_index(root, &pending, false);
        };
        refresh(vec![old.clone()]);
        assert_eq!(super::indexed_search_files(root).len(), 1);
        std::fs::rename(&old, &new).unwrap();
        refresh(vec![old, new.clone()]);
        assert_eq!(super::indexed_search_files(root)[0].result.relative_path, "new/needle.txt");
        let ignore = root.join(".ignore");
        std::fs::write(&ignore, "new/\n").unwrap();
        refresh(vec![ignore.clone()]);
        assert!(!super::indexed_search_files(root).iter().any(|file| file.name == "needle.txt"));
        std::fs::write(&ignore, "").unwrap();
        refresh(vec![ignore]);
        assert!(super::indexed_search_files(root).iter().any(|file| file.name == "needle.txt"));
        std::fs::remove_file(new.join("needle.txt")).unwrap();
        refresh(vec![new.join("needle.txt")]);
        assert!(!super::indexed_search_files(root).iter().any(|file| file.name == "needle.txt"));
        // Recovery walk catches a dropped watcher event.
        std::fs::write(new.join("lost.txt"), "").unwrap();
        super::refresh_search_index(root, &Default::default(), true);
        assert!(super::indexed_search_files(root).iter().any(|file| file.name == "lost.txt"));
    }

    #[test]
    fn file_search_honors_ignore_file() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(directory.path().join("反编译")).unwrap();
        std::fs::write(directory.path().join(".ignore"), "/反编译/\n**/*.jar\n").unwrap();
        std::fs::write(directory.path().join("反编译").join("完整配置.yml"), "a: 1").unwrap();
        std::fs::write(directory.path().join("完整配置.yml"), "a: 1").unwrap();
        std::fs::write(directory.path().join("完整配置.jar"), "").unwrap();
        let result = search_project_files("完整配置", &[directory.path().to_string_lossy().to_string()],
            ProjectSearchOptions { include_text: false, file_name_only: true, limit: 80, ..ProjectSearchOptions::default()}).unwrap();
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].relative_path, "完整配置.yml");
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
