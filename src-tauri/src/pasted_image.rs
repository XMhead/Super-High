use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use uuid::Uuid;

use crate::fs_ops::normalize_path;

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
