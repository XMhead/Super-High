use std::path::Path;
use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub created: u64,
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

#[cfg(not(windows))]
pub fn current_identity() -> anyhow::Result<ProcessIdentity> { anyhow::bail!("Windows only") }
#[cfg(not(windows))]
pub(crate) fn process_matches(_: ProcessIdentity) -> bool { false }
#[cfg(not(windows))]
pub(crate) fn launch_console(_: &Path, _: &str, _: &Path) -> anyhow::Result<ProcessIdentity> { anyhow::bail!("Windows only") }
