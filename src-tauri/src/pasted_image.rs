use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use uuid::Uuid;

use crate::fs_ops::normalize_path;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAttachment {
    pub path: String,
    pub name: String,
    pub mime_type: String,
    pub size: usize,
}

pub fn save_attachment_data_url(project_path: &Path, name: &str, data_url: &str) -> anyhow::Result<SavedAttachment> {
    use std::io::Write;
    let rest = data_url.strip_prefix("data:").context("附件必须是 data URL")?;
    let (header, encoded) = rest.split_once(',').context("附件 data URL 格式无效")?;
    let mime = header.strip_suffix(";base64").context("附件必须使用 base64 编码")?;
    if mime.len() > 255 || mime.chars().any(|c| c.is_control() || c == ';') {
        anyhow::bail!("附件 MIME 类型无效");
    }
    if encoded.len() > ((MAX_PASTED_IMAGE_BYTES as usize + 2) / 3) * 4 {
        anyhow::bail!("附件不能超过 32 MiB");
    }
    let bytes = STANDARD.decode(encoded).context("附件 base64 编码无效")?;
    if bytes.len() as u64 > MAX_PASTED_IMAGE_BYTES {
        anyhow::bail!("附件不能超过 32 MiB");
    }
    let root = project_path.canonicalize().context("工作区不存在")?;
    if !root.is_dir() { anyhow::bail!("工作区不是目录"); }
    let mut directory = root.clone();
    for part in [".superhigh", "pasted-images"] {
        directory.push(part);
        if !directory.exists() { fs::create_dir(&directory)?; }
        directory = directory.canonicalize()?;
        if !directory.starts_with(&root) || !directory.is_dir() {
            anyhow::bail!("附件目录超出工作区范围");
        }
    }
    let base = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let safe = sanitize_pasted_image_stem(base);
    let mut name_bytes = 0;
    let safe: String = safe.chars().take_while(|character| {
        name_bytes += character.len_utf8();
        name_bytes <= 160
    }).collect();
    let file_name = format!("attachment-{}-{}", Uuid::new_v4().simple(), safe);
    let path = directory.join(&file_name);
    let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    output.write_all(&bytes).context("保存附件失败")?;
    Ok(SavedAttachment { path: normalize_path(&path), name: file_name,
        mime_type: if mime.is_empty() { "application/octet-stream".into() } else { mime.into() }, size: bytes.len() })
}

const MAX_PASTED_IMAGE_BYTES: u64 = 32 * 1024 * 1024;

pub fn save_pasted_image_data_url(
    project_path: &Path,
    data_url: &str,
    preferred_name: Option<&str>,
) -> anyhow::Result<String> {
    let (mime, encoded) = parse_image_data_url(data_url)?;
    let bytes = STANDARD
        .decode(encoded.trim())
        .context("failed to decode pasted image data URL")?;
    save_pasted_image_bytes(project_path, &bytes, Some(mime), preferred_name)
}

pub fn save_pasted_image_bytes(
    project_path: &Path,
    bytes: &[u8],
    mime_type: Option<&str>,
    preferred_name: Option<&str>,
) -> anyhow::Result<String> {
    if bytes.is_empty() {
        anyhow::bail!("pasted image is empty");
    }
    if bytes.len() as u64 > MAX_PASTED_IMAGE_BYTES {
        anyhow::bail!(
            "pasted image is too large ({} MB limit)",
            MAX_PASTED_IMAGE_BYTES / 1024 / 1024
        );
    }
    let extension = image_extension_from_bytes_and_mime(bytes, mime_type)
        .ok_or_else(|| anyhow::anyhow!("unsupported pasted image type"))?;
    let directory = pasted_images_directory(project_path);
    fs::create_dir_all(&directory)
        .with_context(|| format!("failed to create {}", directory.display()))?;
    let file_name = pasted_image_file_name(preferred_name, extension);
    let output_path = directory.join(file_name);
    fs::write(&output_path, bytes)
        .with_context(|| format!("failed to write {}", output_path.display()))?;
    Ok(normalize_path(&output_path))
}

fn pasted_images_directory(project_path: &Path) -> PathBuf {
    project_path.join(".superhigh").join("pasted-images")
}

fn parse_image_data_url(data_url: &str) -> anyhow::Result<(&str, &str)> {
    let trimmed = data_url.trim();
    let rest = trimmed
        .strip_prefix("data:")
        .ok_or_else(|| anyhow::anyhow!("pasted image must be a data URL"))?;
    let (header, payload) = rest
        .split_once(',')
        .ok_or_else(|| anyhow::anyhow!("invalid image data URL"))?;
    if !header.contains(";base64") {
        anyhow::bail!("pasted image data URL must be base64 encoded");
    }
    let mime = header
        .split(';')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("application/octet-stream");
    if !mime.starts_with("image/") {
        anyhow::bail!("pasted data is not an image");
    }
    Ok((mime, payload))
}

fn image_extension_from_bytes_and_mime(
    bytes: &[u8],
    mime_type: Option<&str>,
) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some("jpg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    match mime_type.map(str::to_ascii_lowercase).as_deref() {
        Some("image/png") => Some("png"),
        Some("image/jpeg") | Some("image/jpg") => Some("jpg"),
        Some("image/gif") => Some("gif"),
        Some("image/webp") => Some("webp"),
        Some("image/bmp") | Some("image/x-ms-bmp") => Some("bmp"),
        _ => None,
    }
}

fn pasted_image_file_name(preferred_name: Option<&str>, extension: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0);
    let suffix = Uuid::new_v4().simple().to_string();
    let short_suffix = &suffix[..8];
    if let Some(raw_name) = preferred_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let file_name = Path::new(raw_name)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("paste");
        let stem = Path::new(file_name)
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("paste");
        let safe_stem = sanitize_pasted_image_stem(stem);
        return format!(
            "paste-{}-{}-{}.{}",
            stamp, short_suffix, safe_stem, extension
        );
    }
    format!("paste-{}-{}.{}", stamp, short_suffix, extension)
}

fn sanitize_pasted_image_stem(raw: &str) -> String {
    let value = raw
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '-'
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed = value.trim_matches(&[' ', '.'][..]).to_string();
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::{save_pasted_image_bytes, save_pasted_image_data_url};
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    const STANDARD_PNG_BYTES: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn attachment_upload_preserves_arbitrary_bytes_and_avoids_overwrites() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![0xA5; 2 * 1024 * 1024];
        let data_url = format!("data:application/octet-stream;base64,{}", STANDARD.encode(&bytes));
        let first = super::save_attachment_data_url(directory.path(), "../../CON:unsafe?.bin", &data_url).unwrap();
        let second = super::save_attachment_data_url(directory.path(), "../../CON:unsafe?.bin", &data_url).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(first.size, bytes.len());
        assert!(!first.name.contains(['/', '\\', ':', '?']));
        assert_eq!(std::fs::read(&first.path).unwrap(), bytes);
        assert!(std::path::Path::new(&first.path).canonicalize().unwrap().starts_with(directory.path().canonicalize().unwrap()));
        let empty = super::save_attachment_data_url(directory.path(), "empty.txt", "data:;base64,").unwrap();
        assert_eq!(empty.size, 0);
        assert_eq!(empty.mime_type, "application/octet-stream");
    }

    #[test]
    fn attachment_rejects_invalid_encoding_and_oversized_content() {
        let directory = tempfile::tempdir().unwrap();
        for url in ["hello", "data:text/plain,hello", "data:text/plain;base64suffix,aA==", "data:text/plain;base64,%%"] {
            assert!(super::save_attachment_data_url(directory.path(), "a.txt", url).is_err());
        }
        let oversized = format!("data:;base64,{}", "A".repeat(((super::MAX_PASTED_IMAGE_BYTES as usize + 2) / 3) * 4 + 4));
        assert!(super::save_attachment_data_url(directory.path(), "a.bin", &oversized).is_err());
        assert!(!directory.path().join(".superhigh").exists());
    }

    #[cfg(unix)]
    #[test]
    fn attachment_rejects_linked_directory_outside_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join(".superhigh")).unwrap();
        assert!(super::save_attachment_data_url(directory.path(), "a.txt", "data:;base64,aA==").is_err());
        assert!(!outside.path().join("pasted-images").exists());
    }

    #[test]
    fn save_pasted_image_bytes_writes_png_under_project_cache() {
        let directory = tempfile::tempdir().unwrap();
        let path = save_pasted_image_bytes(
            directory.path(),
            STANDARD_PNG_BYTES,
            Some("image/png"),
            Some("shot.png"),
        )
        .unwrap();
        assert!(path.contains("/.superhigh/pasted-images/paste-"));
        assert!(path.ends_with(".png"));
        let relative = path.split("/.superhigh/").nth(1).unwrap();
        let file_path = directory.path().join(".superhigh").join(relative);
        let written = std::fs::read(file_path).unwrap();
        assert_eq!(written, STANDARD_PNG_BYTES);
    }

    #[test]
    fn save_pasted_image_data_url_decodes_png() {
        let directory = tempfile::tempdir().unwrap();
        let data_url = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(STANDARD_PNG_BYTES)
        );
        let path = save_pasted_image_data_url(directory.path(), &data_url, None).unwrap();
        assert!(path.ends_with(".png"));
        let relative = path.split("/.superhigh/").nth(1).unwrap();
        let file_path = directory.path().join(".superhigh").join(relative);
        let written = std::fs::read(file_path).unwrap();
        assert_eq!(written, STANDARD_PNG_BYTES);
    }

    #[test]
    fn rejects_non_image_data_url() {
        let directory = tempfile::tempdir().unwrap();
        let error =
            save_pasted_image_data_url(directory.path(), "data:text/plain;base64,aGVsbG8=", None)
                .unwrap_err()
                .to_string();
        assert!(error.contains("not an image"));
    }
}
