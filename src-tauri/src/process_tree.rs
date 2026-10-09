#[cfg(windows)]
use std::process::{Command, Stdio};

pub fn kill_pty_child_tree(child: &mut (dyn portable_pty::Child + Send + Sync)) {
    if let Some(process_id) = child.process_id() {
        if kill_process_tree(process_id) {
            return;
        }
    }

    let _ = child.kill();
}

pub fn kill_std_child_tree(child: &mut std::process::Child) {
    if kill_process_tree(child.id()) {
        return;
    }

    let _ = child.kill();
}

#[cfg(windows)]
fn kill_process_tree(process_id: u32) -> bool {
    if process_id == 0 || process_id == std::process::id() {
        return false;
    }

    Command::new("taskkill.exe")
        .args(["/PID", &process_id.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn kill_process_tree(_process_id: u32) -> bool {
    false
}
