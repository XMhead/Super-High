//! Native terminal view for a detached Agent host. It never starts a second Agent.
use std::{fs, path::Path, time::{Duration, Instant}};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use crate::{agent_host::{Client, Record}, service_console::{current_identity, process_matches, ProcessIdentity}};

#[derive(Serialize, Deserialize)]
struct ConsoleState { process: ProcessIdentity, window: usize }

pub(crate) fn attach(data_dir: &Path, client: &Client) -> Result<()> {
    static ATTACH: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = ATTACH.lock().unwrap();
    let directory = data_dir.join("agent-hosts").join(&client.record.session.id);
    claim_console(&directory)?;
    if fs::read(directory.join("console.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<ConsoleState>(&bytes).ok())
        .is_some_and(|state| {
            if !process_matches(state.process) { return false; }
            hide_console(&state);
            true
        }) { return Ok(()); }
    let helper = crate::agent_host::executable(data_dir)?;
    let _ = fs::remove_file(directory.join("console-error.txt"));
    let process = crate::service_console::launch_console(&helper, "__agent-console", &directory)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let result = (|| -> Result<()> {
    loop {
        if fs::read(directory.join("console.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<ConsoleState>(&bytes).ok())
            .is_some_and(|state| process_matches(state.process)) { return Ok(()); }
        if !process_matches(client.record.process) { return Ok(()); }
        if let Ok(error) = fs::read_to_string(directory.join("console-error.txt")) { anyhow::bail!("{error}") }
        anyhow::ensure!(Instant::now() < deadline, "等待 Agent 外部终端启动超时");
        std::thread::sleep(Duration::from_millis(25));
    }
    })();
    if result.is_err() { stop_failed_console(process); }
    result
}

fn claim_console(directory: &Path) -> Result<()> {
    let path = directory.join("console-owner.json");
    // A temporary desktop may reconnect the same hosts. It must not replace a
    // living owner and expose their consoles when the temporary desktop exits.
    if fs::read(&path).ok()
        .and_then(|bytes| serde_json::from_slice::<ProcessIdentity>(&bytes).ok())
        .is_some_and(process_matches) { return Ok(()); }
    use std::io::Write;
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    pending.write_all(&serde_json::to_vec(&current_identity()?)?)?;
    pending.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub(crate) fn release(data_dir: &Path, session_id: &str) -> Result<()> {
    let owner = data_dir.join("agent-hosts").join(session_id).join("console-owner.json");
    let state = fs::read(&owner).ok().and_then(|bytes| serde_json::from_slice::<ProcessIdentity>(&bytes).ok());
    if state == Some(current_identity()?) {
        fs::remove_file(owner)?;
    }
    Ok(())
}

pub(crate) fn maintain_attachment(directory: &Path) -> Result<()> {
    claim_console(directory)?;
    // Old console helpers survive desktop updates. Enforce the embedded view
    // here too instead of depending on the helper's cached visibility logic.
    if let Some(state) = fs::read(directory.join("console.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<ConsoleState>(&bytes).ok())
        .filter(|state| process_matches(state.process)) {
        hide_console(&state);
    }
    Ok(())
}

#[cfg(windows)]
fn hide_console(state: &ConsoleState) {
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
        if IsWindowVisible(state.window as _) != 0 { ShowWindow(state.window as _, SW_HIDE); }
    }
}
#[cfg(not(windows))]
fn hide_console(_: &ConsoleState) {}

#[cfg(windows)]
fn stop_failed_console(process: ProcessIdentity) {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE, PROCESS_SYNCHRONIZE}};
    if !process_matches(process) { return; }
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, process.pid);
        if !handle.is_null() {
            if process_matches(process) { TerminateProcess(handle, 1); WaitForSingleObject(handle, 2000); }
            CloseHandle(handle);
        }
    }
}
#[cfg(not(windows))]
fn stop_failed_console(_: ProcessIdentity) {}

pub fn run_from_env() -> i32 {
    let directory = std::env::args_os().nth(2).map(std::path::PathBuf::from).unwrap_or_default();
    match run(&directory) {
        Ok(()) => 0,
        Err(error) => { let _ = fs::write(directory.join("console-error.txt"), format!("{error:#}")); 1 }
    }
}

#[cfg(windows)]
fn run(directory: &Path) -> Result<()> {
    use std::{io::{Read, Write}, sync::{atomic::{AtomicBool, Ordering}, Arc, OnceLock}, thread};
    use serde_json::{json, Value};
    use windows_sys::Win32::{System::Console::*, UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE}};

    static CONTROL: OnceLock<(Client, std::path::PathBuf)> = OnceLock::new();
    unsafe extern "system" fn close_agent(signal: u32) -> i32 {
        if matches!(signal, CTRL_C_EVENT | CTRL_BREAK_EVENT) {
            if let Some((client, _)) = CONTROL.get() { let _ = client.request::<Value>("input", json!({"input":"\u{3}"})); }
            return 1;
        }
        if matches!(signal, CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT) {
            if let Some((client, directory)) = CONTROL.get() {
                let _ = fs::remove_file(directory.join("console.json"));
                let _ = fs::remove_file(directory.join("console-owner.json"));
                let _ = client.request::<Value>("terminate", Value::Null);
                let _ = fs::remove_dir(directory);
            }
            return 1;
        }
        0
    }

    let record: Record = serde_json::from_slice(&fs::read(directory.join("state.json"))?)?;
    let client = Client { record };
    let _ = CONTROL.set((client.clone(), directory.to_path_buf()));
    let window = unsafe { GetConsoleWindow() };
    anyhow::ensure!(!window.is_null(), "外部终端窗口不可用");
    let title = client.record.session.title.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        ShowWindow(window, SW_HIDE);
        SetConsoleCP(65001);
        SetConsoleOutputCP(65001);
        SetConsoleTitleW(title.as_ptr());
        anyhow::ensure!(SetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS) != 0, "无法启用外部终端输入：{}", std::io::Error::last_os_error());
        anyhow::ensure!(SetConsoleMode(GetStdHandle(STD_OUTPUT_HANDLE), ENABLE_PROCESSED_OUTPUT | ENABLE_WRAP_AT_EOL_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0, "无法启用外部终端渲染：{}", std::io::Error::last_os_error());
        SetConsoleCtrlHandler(Some(close_agent), 1);
    }
    let state = ConsoleState { process: current_identity()?, window: window as usize };
    fs::write(directory.join("console.pending"), serde_json::to_vec(&state)?)?;
    fs::rename(directory.join("console.pending"), directory.join("console.json"))?;

    let visible = Arc::new(AtomicBool::new(false));
    let input_visible = visible.clone();
    let input_client = client.clone();
    thread::spawn(move || {
        let mut bytes = [0; 4096];
        let mut pending = Vec::new();
        let mut input = std::io::stdin().lock();
        while let Ok(size) = input.read(&mut bytes) {
            if size == 0 { break; }
            let text = crate::terminal::decode_terminal_utf8_chunk(&mut pending, &bytes[..size], false);
            if input_visible.load(Ordering::Acquire) && !text.is_empty() {
                let _ = input_client.request::<Value>("input", json!({"input":text}));
            }
        }
    });

    let mut output = std::io::stdout().lock();
    let mut after = None;
    let mut last_size = None;
    let mut connection = None;
    while process_matches(client.record.process) {
        let attached = fs::read(directory.join("console-owner.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<ProcessIdentity>(&bytes).ok())
            .is_some_and(process_matches);
        if attached {
            visible.store(false, Ordering::Release);
            // The window can be shown externally without changing our cached state.
            if unsafe { IsWindowVisible(window) } != 0 { unsafe { ShowWindow(window, SW_HIDE); } }
            after = None;
            last_size = None;
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        let becoming_visible = !visible.swap(true, Ordering::AcqRel);
        if becoming_visible { unsafe { ShowWindow(window, SW_SHOWNOACTIVATE); } }
        let result = (|| -> Result<()> {
            if connection.is_none() { connection = Some(client.connect()?); }
            let channel = connection.as_mut().unwrap();
            let snapshot: crate::models::TerminalBufferSnapshot = channel.request("buffer", json!({"after":after}))?;
            if after.is_none() || after.is_some_and(|offset| offset < snapshot.start_byte) {
                output.write_all(b"\x1b[0m\x1b[2J\x1b[H")?;
            }
            output.write_all(snapshot.buffer.as_bytes())?;
            output.write_all(snapshot.modes.as_bytes())?;
            output.flush()?;
            after = Some(snapshot.end_byte);
            let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
            if unsafe { GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &mut info) } != 0 {
                let size = ((info.srWindow.Right - info.srWindow.Left + 1).max(1) as u16,
                    (info.srWindow.Bottom - info.srWindow.Top + 1).max(1) as u16);
                if last_size != Some(size) {
                    let _: Value = channel.request("resize", json!({"cols":size.0,"rows":size.1,"force":true}))?;
                    last_size = Some(size);
                }
            }
            Ok(())
        })();
        if result.is_err() {
            connection = None;
            thread::sleep(Duration::from_millis(200));
        } else { thread::sleep(Duration::from_millis(32)); }
    }
    let _ = fs::remove_file(directory.join("console.json"));
    let _ = fs::remove_file(directory.join("console-owner.json"));
    let _ = fs::remove_dir(directory);
    Ok(())
}

#[cfg(not(windows))]
fn run(_: &Path) -> Result<()> { anyhow::bail!("Agent 外部终端仅支持 Windows") }

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    struct TestOwner(std::process::Child);
    impl Drop for TestOwner {
        fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
    }

    #[test]
    fn reconnect_preserves_a_live_owner_and_reclaims_an_exited_owner() {
        use std::{os::windows::process::CommandExt, process::Command};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("console-owner.json");
        // A separate process stands in for the original desktop instance.
        let mut owner = TestOwner(Command::new("powershell.exe").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .creation_flags(0x08000000).spawn().unwrap());
        // Use Windows process times, just as the desktop owner record does.
        let identity = crate::service_console::identity(owner.0.id()).unwrap();
        fs::write(&path, serde_json::to_vec(&identity).unwrap()).unwrap();
        let preserved = claim_console(directory.path());
        let observed = fs::read(&path).unwrap();
        owner.0.kill().unwrap();
        owner.0.wait().unwrap();
        preserved.unwrap();
        assert!(serde_json::from_slice::<ProcessIdentity>(&observed).unwrap() == identity);
        maintain_attachment(directory.path()).unwrap();
        assert!(serde_json::from_slice::<ProcessIdentity>(&fs::read(path).unwrap()).unwrap() == current_identity().unwrap());
    }

    #[test]
    fn maintenance_hides_an_externally_shown_window_without_restarting_the_helper() {
        use windows_sys::Win32::UI::WindowsAndMessaging::*;
        let directory = tempfile::tempdir().unwrap();
        let class = "STATIC\0".encode_utf16().collect::<Vec<_>>();
        unsafe {
            let window = CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_POPUP,
                0, 0, 1, 1, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null());
            assert!(!window.is_null());
            let state = ConsoleState { process: current_identity().unwrap(), window: window as usize };
            fs::write(directory.path().join("console.json"), serde_json::to_vec(&state).unwrap()).unwrap();
            ShowWindow(window, SW_SHOWNOACTIVATE);
            assert_ne!(IsWindowVisible(window), 0);
            let result = maintain_attachment(directory.path());
            let visible = IsWindowVisible(window);
            DestroyWindow(window);
            result.unwrap();
            assert_eq!(visible, 0);
            assert!(process_matches(state.process));
        }
    }
}
