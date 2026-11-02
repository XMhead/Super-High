use serde::Serialize;

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageViewerRegistration {
    supported: bool,
    enabled: bool,
    legacy_registered: bool,
    default_selected: bool,
}

fn registration(enabled: Option<bool>) -> Result<ImageViewerRegistration, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                include_str!("image_viewer_registration.ps1"),
            ])
            .env("SUPERHIGH_VIEWER_EXE", exe)
            .env(
                "SUPERHIGH_VIEWER_ACTION",
                enabled
                    .map(|v| if v { "enable" } else { "disable" })
                    .unwrap_or("read"),
            )
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(ImageViewerRegistration {
            supported: false,
            enabled: false,
            legacy_registered: false,
            default_selected: false,
        })
    }
}

#[tauri::command]
pub async fn get_image_viewer_registration_command() -> Result<ImageViewerRegistration, String> {
    tauri::async_runtime::spawn_blocking(|| registration(None))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_image_viewer_registration_command(
    enabled: bool,
) -> Result<ImageViewerRegistration, String> {
    tauri::async_runtime::spawn_blocking(move || registration(Some(enabled)))
        .await
        .map_err(|e| e.to_string())?
}
