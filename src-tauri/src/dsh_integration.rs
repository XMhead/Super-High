use std::{fs, path::{Component, Path, PathBuf}};
use tauri::{Manager, Runtime};

#[derive(Default)]
pub struct WebviewState {
    pub requested_urls: tokio::sync::Mutex<std::collections::HashMap<String, tauri::Url>>,
}

pub fn webview_label(owner: &str) -> String {
    format!("dsh-web-{owner}")
}

pub fn apply_theme<R: Runtime>(webview: &tauri::Webview<R>, theme: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(theme).map_err(|e| e.to_string())?;
    webview.eval(format!("window.__superhighDshSetTheme?.({json})")).map_err(|e| e.to_string())
}

fn valid_module(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    let valid = |part: &str| !part.is_empty() && part != "." && part != ".." && part.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'@'));
    (parts.len() == 1 && !name.starts_with('@') && valid(parts[0])) || (parts.len() == 2 && parts[0].starts_with('@') && parts[0].len() > 1 && valid(parts[0]) && valid(parts[1]) && !parts[1].starts_with('@'))
}

fn module_directory(name: &str) -> Result<PathBuf, String> {
    if !valid_module(name) { return Err("无效的插件名称".into()); }
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("DSH_HOME").map(PathBuf::from).or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".dsh"))) {
        roots.push(home.join("profiles").join("web").join("node_modules"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("npm/node_modules/@deepseek-ai/dsh/node_modules"));
    }
    roots.into_iter().map(|root| root.join(name)).find(|path| path.join("package.json").is_file())
        .and_then(|path| fs::canonicalize(path).ok()).ok_or_else(|| "未找到此插件的安装目录".into())
}

fn entry_file(directory: &Path) -> Result<PathBuf, String> {
    let manifest: serde_json::Value = serde_json::from_slice(&fs::read(directory.join("package.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let export = &manifest["exports"]["."];
    let relative = manifest["main"].as_str().or_else(|| export.as_str()).or_else(|| export["default"].as_str()).or_else(|| export["import"].as_str()).unwrap_or("index.js");
    let path = Path::new(relative);
    if path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir | Component::RootDir | Component::Prefix(_))) { return Err("插件入口路径无效".into()); }
    let resolved = fs::canonicalize(directory.join(path)).map_err(|_| "插件入口文件不存在".to_string())?;
    if !resolved.starts_with(directory) || !resolved.is_file() { return Err("插件入口文件不在插件目录中".into()); }
    Ok(resolved)
}

pub fn on_navigation<R: Runtime>(app: &tauri::AppHandle<R>, owner: &str, url: &tauri::Url) -> bool {
    if url.host_str() != Some("superhigh-dsh.local") { return true; }
    let fields: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if url.path() == "/shortcut" && owner.starts_with("editor-") {
        use tauri::Emitter;
        if let Some(key @ ("F1" | "F4")) = fields.get("key").map(String::as_str) {
            if key == "F4" {
                if let Some(parent) = app.get_webview(owner) { let _ = parent.set_focus(); }
            }
            let _ = app.emit_to(tauri::EventTarget::webview_window(owner), "editor-window-shortcut", key);
        }
        return false;
    }
    if url.path() != "/action" { return false; }
    let module = fields.get("module").cloned().unwrap_or_default();
    let action = fields.get("action").cloned().unwrap_or_default();
    let request = fields.get("request").cloned().unwrap_or_default();
    let app = app.clone();
    let label = webview_label(owner);
    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let directory = module_directory(&module)?;
            if action == "directory" {
                #[cfg(windows)]
                {
                    let full = directory.to_string_lossy();
                    let normal = if let Some(unc) = full.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") } else { full.strip_prefix(r"\\?\").unwrap_or(&full).to_string() };
                    std::process::Command::new("explorer.exe").arg(normal).spawn().map_err(|e| e.to_string())?;
                }
                #[cfg(not(windows))]
                return Err("当前系统不支持打开资源管理器".into());
                return Ok(serde_json::json!({"directory": directory.to_string_lossy()}));
            }
            if action != "preview" { return Err("未知操作".into()); }
            let file = entry_file(&directory)?;
            if fs::metadata(&file).map_err(|e| e.to_string())?.len() > 2_000_000 { return Err("入口文件超过 2 MB，无法展开预览".into()); }
            let source = fs::read_to_string(&file).map_err(|e| format!("无法读取源码：{e}"))?;
            Ok(serde_json::json!({"path": file.to_string_lossy(), "source": source}))
        })();
        let payload = match result { Ok(value) => serde_json::json!({"request":request,"result":value}), Err(error) => serde_json::json!({"request":request,"error":error}) };
        if let Some(webview) = app.get_webview(&label) { let _ = webview.eval(format!("window.__superhighDshResult?.({payload})")); }
    });
    false
}

#[cfg(test)]
mod tests {
    use super::valid_module;
    #[test]
    fn package_names_do_not_accept_paths() {
        assert!(valid_module("@deepseek-ai/dsh-agent-instructions"));
        assert!(valid_module("plugin-name"));
        for name in ["../secret", "@scope/../x", "@scope", "a/b", "@a/x/y", "C:/bad"] { assert!(!valid_module(name), "{name}"); }
    }
}
