use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::models::Workspace;

pub const OPEN_EVENT: &str = "editor-window-open";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorWindowPage {
    pub path: String,
    pub title: String,
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorWindowInbox {
    pub workspace: Workspace,
    pub pages: Vec<EditorWindowPage>,
}

#[derive(Default)]
pub struct EditorWindows(Mutex<HashMap<String, EditorWindowInbox>>);

impl EditorWindows {
    pub fn remove(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }
}

#[tauri::command]
pub async fn open_editor_window_command(
    app: tauri::AppHandle,
    workspace: Workspace,
    page: Option<EditorWindowPage>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !std::path::Path::new(&workspace.root_path).is_dir() {
            return Err("编辑器工作区不存在。".to_string());
        }
        let state = app.state::<EditorWindows>();
        let mut windows = state.0.lock().unwrap();
        let key = workspace.root_path.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let existing = windows.iter().find_map(|(label, inbox)| {
            let root = inbox.workspace.root_path.replace('\\', "/").trim_end_matches('/').to_lowercase();
            (root == key).then(|| label.clone())
        });
        if let Some(label) = existing {
            if let Some(page) = page { windows.get_mut(&label).unwrap().pages.push(page); }
            drop(windows);
            // The first open may still be building its native window. Its inbox
            // already exists, so concurrent opens join the same startup queue.
            if let Some(window) = app.get_window(&label) {
                app.emit_to(&label, OPEN_EVENT, ()).map_err(|error| error.to_string())?;
                window.unminimize().map_err(|error| error.to_string())?;
                window.show().map_err(|error| error.to_string())?;
                window.set_focus().map_err(|error| error.to_string())?;
            }
            return Ok(label);
        }
        let label = format!("editor-{}", uuid::Uuid::new_v4());
        windows.insert(label.clone(), EditorWindowInbox { workspace, pages: page.into_iter().collect() });
        drop(windows);
        let mut builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App("index.html?editorWindow=1".into()))
            .title("Super High 编辑器")
            .inner_size(1200.0, 800.0)
            .min_inner_size(480.0, 360.0)
            .decorations(false)
            .resizable(true)
            .maximized(true)
            .on_navigation(crate::guard_main_webview_navigation)
            .on_web_resource_request(crate::allow_editor_runtime_resources);
        #[cfg(windows)]
        if crate::is_webview2_automation_launch() {
            builder = builder.additional_browser_args(&crate::webview2_automation_browser_args())
                .data_directory(crate::webview2_data_dir(&app, "webview2-automation").map_err(|error| error.to_string())?);
        }
        if let Err(error) = builder.build() {
            state.remove(&label);
            return Err(error.to_string());
        }
        Ok(label)
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn take_editor_window_inbox_command(window: tauri::Window, state: tauri::State<'_, EditorWindows>) -> Result<EditorWindowInbox, String> {
    let mut windows = state.0.lock().unwrap();
    let inbox = windows.get_mut(window.label()).ok_or("编辑器窗口上下文已失效。")?;
    Ok(EditorWindowInbox { workspace: inbox.workspace.clone(), pages: std::mem::take(&mut inbox.pages) })
}
