use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use crate::models::TerminalSessionDto;

#[derive(Clone, Serialize, Deserialize)]
pub struct ConsoleSpec {
    pub project_path: PathBuf,
    pub session: TerminalSessionDto,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub owner: ProcessIdentity,
}

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub created: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ConsoleState {
    pub id: String,
    pub port: u16,
    pub process: ProcessIdentity,
}

#[derive(Serialize, Deserialize)]
struct Request {
    id: String,
    operation: String,
    owner: Option<ProcessIdentity>,
    input: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct ConsoleStatus {
    pub running: bool,
    pub process_id: u32,
    pub visible: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct IndependentConsole {
    pub directory: PathBuf,
    pub state: ConsoleState,
}

impl IndependentConsole {
    pub fn request(&self, operation: &str, input: Option<&str>) -> anyhow::Result<ConsoleStatus> {
        anyhow::ensure!(process_matches(self.state.process), "独立控制台已退出");
        let mut stream = TcpStream::connect_timeout(
            &([127, 0, 0, 1], self.state.port).into(), Duration::from_secs(2),
        )?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        serde_json::to_writer(&mut stream, &Request {
            id: self.state.id.clone(), operation: operation.into(),
            owner: matches!(operation, "claim" | "release").then(current_identity).transpose()?,
            input: input.map(str::to_owned),
        })?;
        stream.write_all(b"\n")?;
        let mut response = String::new();
        BufReader::new(stream).take(65536).read_line(&mut response)?;
        let status: ConsoleStatus = serde_json::from_str(&response)?;
        anyhow::ensure!(status.error.is_none(), "{}", status.error.as_deref().unwrap_or_default());
        Ok(status)
    }

    pub fn running(&self) -> bool {
        process_matches(self.state.process)
    }

    pub fn release(&self) {
        let _ = self.request("release", None);
    }
}

pub fn start(data_dir: &Path, spec: &ConsoleSpec) -> anyhow::Result<IndependentConsole> {
    let directory = data_dir.join("service-consoles").join(&spec.session.id);
    fs::create_dir_all(&directory)?;
    fs::write(directory.join("launch.json"), serde_json::to_vec_pretty(spec)?)?;
    let executable = std::env::current_exe()?.with_file_name("superhigh-cli.exe");
    anyhow::ensure!(executable.is_file(), "找不到独立控制台启动程序");
    use sha2::{Digest, Sha256};
    let bytes = fs::read(&executable)?;
    let cache = data_dir.join("cache").join("service-console");
    fs::create_dir_all(&cache)?;
    let helper = cache.join(format!("{:x}.exe", Sha256::digest(&bytes)));
    if !helper.exists() {
        let mut temporary = tempfile::NamedTempFile::new_in(&cache)?;
        temporary.write_all(&bytes)?;
        if let Err(error) = temporary.persist_noclobber(&helper) {
            if !helper.exists() { return Err(error.error.into()); }
        }
    }
    launch_hidden(&helper, &directory)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(state) = fs::read(directory.join("state.json")) {
            let console = IndependentConsole { directory: directory.clone(), state: serde_json::from_slice(&state)? };
            console.request("claim", None)?;
            return Ok(console);
        }
        if let Ok(error) = fs::read_to_string(directory.join("error.txt")) { bail!("{error}"); }
        thread::sleep(Duration::from_millis(50));
    }
    bail!("等待独立控制台启动超时；启动记录：{}", directory.display())
}

pub fn existing(data_dir: &Path, project: &Path) -> Vec<(ConsoleSpec, IndependentConsole)> {
    let Ok(entries) = fs::read_dir(data_dir.join("service-consoles")) else { return Vec::new() };
    entries.flatten().filter_map(|entry| {
        let directory = entry.path();
        let spec: ConsoleSpec = serde_json::from_slice(&fs::read(directory.join("launch.json")).ok()?).ok()?;
        if spec.project_path != project { return None; }
        let state = serde_json::from_slice(&fs::read(directory.join("state.json")).ok()?).ok()?;
        let console = IndependentConsole { directory, state };
        console.running().then_some((spec, console))
    }).collect()
}

pub fn worker_from_env() -> i32 {
    let directory = std::env::args_os().nth(2).map(PathBuf::from).unwrap_or_default();
    match run_worker(&directory) {
        Ok(code) => code,
        Err(error) => {
            show_console(true);
            eprintln!("{error:#}");
            let _ = fs::write(directory.join("error.txt"), format!("{error:#}"));
            1
        }
    }
}

fn run_worker(directory: &Path) -> anyhow::Result<i32> {
    let spec: ConsoleSpec = serde_json::from_slice(&fs::read(directory.join("launch.json"))?)?;
    prepare_console(&spec.session.title);
    let listener = TcpListener::bind("127.0.0.1:0")?;
    listener.set_nonblocking(true)?;
    let mut child = Command::new(&spec.program).args(&spec.args).current_dir(&spec.cwd)
        .stdin(Stdio::inherit()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .with_context(|| format!("无法启动 {}", spec.program))?;
    let log = Arc::new(Mutex::new(OpenOptions::new().create(true).append(true).open(directory.join("output.log"))?));
    let stdout = copy_output(child.stdout.take().context("stdout unavailable")?, log.clone());
    let stderr = copy_output(child.stderr.take().context("stderr unavailable")?, log);
    let state = ConsoleState { id: spec.session.id, port: listener.local_addr()?.port(), process: current_identity()? };
    fs::write(directory.join("state.json"), serde_json::to_vec(&state)?)?;
    let mut owners = vec![spec.owner];
    let mut visible = false;
    let client_config = if spec.session.provider_kind == "minecraft-client" {
        crate::minecraft_client::load_minecraft_client_config(&spec.project_path)?
    } else { None };
    let mut client = ClientLifetime::default();
    loop {
        if let Some(config) = &client_config {
            let game = crate::minecraft_client::client_process_id(config);
            if client.finished(child.id(), &config.process_names, game)? {
                crate::process_tree::kill_std_child_tree(&mut child);
                let _ = child.wait();
            }
        }
        if let Some(code) = child.try_wait()? {
            let _ = stdout.join();
            let _ = stderr.join();
            return Ok(code.code().unwrap_or(1));
        }
        owners.retain(|identity| process_matches(*identity));
        let next_visible = owners.is_empty();
        if visible != next_visible {
            visible = next_visible;
            show_console(visible);
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_millis(500)))?;
                stream.set_write_timeout(Some(Duration::from_millis(500)))?;
                let mut line = String::new();
                let mut terminate = false;
                let result = (|| -> anyhow::Result<()> {
                    BufReader::new(&stream).take(65536).read_line(&mut line)?;
                    let request: Request = serde_json::from_str(&line)?;
                    anyhow::ensure!(request.id == state.id, "控制台标识不匹配");
                    match request.operation.as_str() {
                        "status" => (),
                        "claim" => {
                            let identity = request.owner.context("缺少监测进程")?;
                            anyhow::ensure!(process_matches(identity), "监测进程已退出");
                            if !owners.contains(&identity) { owners.push(identity); }
                            visible = false;
                            show_console(false);
                        }
                        "release" => {
                            owners.retain(|identity| Some(*identity) != request.owner);
                            visible = owners.is_empty();
                            show_console(visible);
                        }
                        "input" => write_console_input(request.input.as_deref().unwrap_or_default())?,
                        "terminate" => terminate = true,
                        _ => bail!("未知控制台操作"),
                    }
                    Ok(())
                })();
                let status = ConsoleStatus { running: !terminate, process_id: child.id(), visible, error: result.err().map(|error| error.to_string()) };
                let _ = serde_json::to_writer(&mut stream, &status);
                let _ = stream.write_all(b"\n");
                if terminate {
                    crate::process_tree::kill_std_child_tree(&mut child);
                    let _ = child.wait();
                    return Ok(0);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(100)),
            Err(error) => return Err(error.into()),
        }
    }
}


#[derive(Default)]
struct ClientLifetime {
    processes: Vec<ProcessIdentity>,
    exited_at: Option<Instant>,
}

impl ClientLifetime {
    fn finished(&mut self, launcher: u32, names: &[String], game: Option<u32>) -> anyhow::Result<bool> {
        if let Some(game) = game {
            for process in descendant_processes(launcher, names)? {
                if process.pid == game && !self.processes.contains(&process) { self.processes.push(process); }
            }
        }
        let running = self.processes.iter().any(|process| process_matches(*process));
        Ok(self.observe(!self.processes.is_empty(), running, Instant::now()))
    }

    fn observe(&mut self, seen: bool, running: bool, now: Instant) -> bool {
        if !seen || running { self.exited_at = None; return false; }
        now.duration_since(*self.exited_at.get_or_insert(now)) >= Duration::from_secs(1)
    }
}

#[cfg(windows)]
pub(crate) fn descendant_processes(launcher: u32, names: &[String]) -> anyhow::Result<Vec<ProcessIdentity>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
    };
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    anyhow::ensure!(snapshot != INVALID_HANDLE_VALUE, "无法读取客户端进程树：{}", std::io::Error::last_os_error());
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) };
    let mut rows = Vec::new();
    while found != 0 {
        let length = entry.szExeFile.iter().position(|value| *value == 0).unwrap_or(entry.szExeFile.len());
        rows.push((entry.th32ProcessID, entry.th32ParentProcessID, String::from_utf16_lossy(&entry.szExeFile[..length])));
        found = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    let error = unsafe { GetLastError() };
    unsafe { CloseHandle(snapshot); }
    anyhow::ensure!(error == ERROR_NO_MORE_FILES, "客户端进程树读取不完整：{}", std::io::Error::from_raw_os_error(error as i32));
    let mut descendants = vec![launcher];
    loop {
        let previous = descendants.len();
        for (pid, parent, _) in &rows {
            if descendants.contains(parent) && !descendants.contains(pid) { descendants.push(*pid); }
        }
        if descendants.len() == previous { break; }
    }
    Ok(rows.into_iter().filter(|(pid, _, name)| *pid != launcher && descendants.contains(pid)
        && names.iter().any(|expected| expected.eq_ignore_ascii_case(name)))
        .filter_map(|(pid, _, _)| identity(pid)).collect())
}

#[cfg(not(windows))]
pub(crate) fn descendant_processes(_: u32, _: &[String]) -> anyhow::Result<Vec<ProcessIdentity>> { Ok(Vec::new()) }

fn copy_output(mut reader: impl Read + Send + 'static, log: Arc<Mutex<File>>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut bytes = [0u8; 8192];
        while let Ok(count) = reader.read(&mut bytes) {
            if count == 0 { break; }
            let mut file = log.lock().unwrap();
            let _ = file.write_all(&bytes[..count]);
            let mut stdout = std::io::stdout().lock();
            let _ = stdout.write_all(&bytes[..count]);
            let _ = stdout.flush();
        }
    })
}

#[cfg(windows)]
pub fn current_identity() -> anyhow::Result<ProcessIdentity> {
    identity(std::process::id()).context("无法识别监测进程")
}

#[cfg(windows)]
pub(crate) fn identity(pid: u32) -> Option<ProcessIdentity> {
    use windows_sys::Win32::{Foundation::{CloseHandle, FILETIME}, System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION}};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() { return None; }
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
        CloseHandle(handle);
        (ok != 0).then_some(ProcessIdentity { pid, created: ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64 })
    }
}

#[cfg(windows)]
pub(crate) fn process_matches(process: ProcessIdentity) -> bool {
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    if identity(process.pid) != Some(process) { return false; }
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, process.pid);
        if handle.is_null() { return false; }
        let running = WaitForSingleObject(handle, 0) == 258;
        CloseHandle(handle);
        running
    }
}

#[cfg(windows)]
fn launch_hidden(executable: &Path, directory: &Path) -> anyhow::Result<()> {
    launch_console(executable, "__service-console", directory).map(|_| ())
}

#[cfg(windows)]
pub(crate) fn launch_console(executable: &Path, mode: &str, directory: &Path) -> anyhow::Result<ProcessIdentity> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW, CREATE_NEW_CONSOLE, STARTF_USESHOWWINDOW}};
    let wide = |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let app = wide(executable.as_os_str());
    let mut command = wide(std::ffi::OsStr::new(&format!("\"{}\" {mode} \"{}\"", executable.display(), directory.display())));
    unsafe {
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = 0;
        let mut process: PROCESS_INFORMATION = std::mem::zeroed();
        anyhow::ensure!(CreateProcessW(app.as_ptr(), command.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 0, CREATE_NEW_CONSOLE, std::ptr::null(), std::ptr::null(), &startup, &mut process) != 0, "{}", std::io::Error::last_os_error());
        CloseHandle(process.hThread);
        let process_identity = identity(process.dwProcessId);
        CloseHandle(process.hProcess);
        return process_identity.context("无法识别独立终端进程");
    }
}

#[cfg(windows)]
fn prepare_console(title: &str) {
    use windows_sys::Win32::System::Console::{SetConsoleCP, SetConsoleOutputCP, SetConsoleTitleW};
    let title = title.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe { SetConsoleCP(65001); SetConsoleOutputCP(65001); SetConsoleTitleW(title.as_ptr()); }
    show_console(false);
}

#[cfg(windows)]
fn show_console(visible: bool) {
    use windows_sys::Win32::{System::Console::GetConsoleWindow, UI::WindowsAndMessaging::{ShowWindow, SW_HIDE, SW_SHOWNOACTIVATE}};
    unsafe { ShowWindow(GetConsoleWindow(), if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }); }
}

#[cfg(windows)]
fn write_console_input(input: &str) -> anyhow::Result<()> {
    use windows_sys::Win32::System::Console::{GetStdHandle, WriteConsoleInputW, INPUT_RECORD, KEY_EVENT, STD_INPUT_HANDLE};
    let records = input.encode_utf16().flat_map(|character| [true, false].map(move |down| {
        let mut record: INPUT_RECORD = unsafe { std::mem::zeroed() };
        record.EventType = KEY_EVENT as u16;
        {
            record.Event.KeyEvent.bKeyDown = down as i32;
            record.Event.KeyEvent.wRepeatCount = 1;
            record.Event.KeyEvent.wVirtualKeyCode = if character == 13 { 13 } else { 0 };
            record.Event.KeyEvent.uChar.UnicodeChar = character;
        }
        record
    })).collect::<Vec<_>>();
    let mut written = 0;
    unsafe {
        anyhow::ensure!(WriteConsoleInputW(GetStdHandle(STD_INPUT_HANDLE), records.as_ptr(), records.len() as u32, &mut written) != 0, "{}", std::io::Error::last_os_error());
    }
    anyhow::ensure!(written as usize == records.len(), "控制台输入不完整");
    Ok(())
}

#[cfg(not(windows))]
pub fn current_identity() -> anyhow::Result<ProcessIdentity> { bail!("独立控制台仅支持 Windows") }
#[cfg(not(windows))]
pub(crate) fn process_matches(_: ProcessIdentity) -> bool { false }
#[cfg(not(windows))]
fn launch_hidden(_: &Path, _: &Path) -> anyhow::Result<()> { bail!("独立控制台仅支持 Windows") }
#[cfg(not(windows))]
pub(crate) fn launch_console(_: &Path, _: &str, _: &Path) -> anyhow::Result<ProcessIdentity> { bail!("独立控制台仅支持 Windows") }
#[cfg(not(windows))]
fn prepare_console(_: &str) {}
#[cfg(not(windows))]
fn show_console(_: bool) {}
#[cfg(not(windows))]
fn write_console_input(_: &str) -> anyhow::Result<()> { bail!("独立控制台仅支持 Windows") }

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn client_exit_waits_for_an_observed_process_and_a_stable_exit() {
        let mut lifetime = ClientLifetime::default();
        let now = Instant::now();
        assert!(!lifetime.observe(false, false, now));
        assert!(!lifetime.observe(true, true, now));
        assert!(!lifetime.observe(true, false, now));
        assert!(!lifetime.observe(true, true, now + Duration::from_millis(500)));
        assert!(!lifetime.observe(true, false, now + Duration::from_secs(1)));
        assert!(lifetime.observe(true, false, now + Duration::from_secs(2)));
    }

    #[test]
    fn auxiliary_processes_without_a_game_window_never_complete_the_client() {
        let mut lifetime = ClientLifetime::default();
        let now = Instant::now();
        assert!(!lifetime.observe(false, false, now));
        assert!(!lifetime.observe(false, false, now + Duration::from_secs(60)));
        assert!(!lifetime.observe(true, true, now + Duration::from_secs(61)));
    }

    #[cfg(windows)]
    #[test]
    fn tracks_only_owned_processes_after_launcher_returns_to_pause() {
        use std::os::windows::process::CommandExt;
        let mut launcher = Command::new("cmd.exe")
            .args(["/d", "/c", "ping.exe -n 3 127.0.0.1 >nul & pause >nul"])
            .creation_flags(0x08000000).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut lifetime = ClientLifetime::default();
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut finished = false;
        let names = vec!["ping.exe".into()];
        while Instant::now() < deadline {
            let game = descendant_processes(launcher.id(), &names).unwrap().first().map(|process| process.pid);
            finished = lifetime.finished(launcher.id(), &names, game).unwrap();
            if finished { break; }
            thread::sleep(Duration::from_millis(100));
        }
        let paused = launcher.try_wait().unwrap().is_none();
        crate::process_tree::kill_std_child_tree(&mut launcher);
        let _ = launcher.wait();
        assert!(finished);
        assert!(paused);
    }
}
