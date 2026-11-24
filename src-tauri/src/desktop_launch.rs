//! Launch the installed desktop outside the requesting Agent's process/job tree.
#[cfg(windows)]
fn launch(executable: &std::path::Path, cwd: &std::path::Path, arguments: &str) -> anyhow::Result<u32> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*, UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId}};
    let wide = |value: &std::ffi::OsStr| value.encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    let app = wide(executable.as_os_str());
    let cwd = wide(cwd.as_os_str());
    let mut command = wide(std::ffi::OsStr::new(&format!("\"{}\" {arguments}", executable.display())));
    unsafe {
        let mut shell_pid = 0;
        GetWindowThreadProcessId(GetShellWindow(), &mut shell_pid);
        anyhow::ensure!(shell_pid != 0, "找不到桌面 Shell，无法独立启动 Super High");
        let parent = OpenProcess(PROCESS_CREATE_PROCESS, 0, shell_pid);
        anyhow::ensure!(!parent.is_null(), "无法访问桌面 Shell：{}", std::io::Error::last_os_error());
        let result = (|| {
            let mut size = 0;
            InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
            let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let attributes = buffer.as_mut_ptr().cast();
            anyhow::ensure!(InitializeProcThreadAttributeList(attributes, 1, 0, &mut size) != 0, "{}", std::io::Error::last_os_error());
            let result = (|| {
                anyhow::ensure!(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                    std::ptr::from_ref(&parent).cast(), std::mem::size_of_val(&parent), ptr::null_mut(), ptr::null()) != 0,
                    "{}", std::io::Error::last_os_error());
                let mut startup: STARTUPINFOEXW = std::mem::zeroed();
                startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
                startup.lpAttributeList = attributes;
                let mut process: PROCESS_INFORMATION = std::mem::zeroed();
                // The explicit shell parent supplies the job association. Do not
                // inherit the Agent tool's handles, console or cleanup job.
                anyhow::ensure!(CreateProcessW(app.as_ptr(), command.as_mut_ptr(), ptr::null(), ptr::null(), 0,
                    EXTENDED_STARTUPINFO_PRESENT | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                    ptr::null(), cwd.as_ptr(), &startup.StartupInfo, &mut process) != 0,
                    "独立启动失败：{}", std::io::Error::last_os_error());
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
                Ok(process.dwProcessId)
            })();
            DeleteProcThreadAttributeList(attributes);
            result
        })();
        CloseHandle(parent);
        result
    }
}

pub fn run_from_env() -> i32 {
    let result = (|| -> anyhow::Result<()> {
        #[cfg(windows)] {
            let args = std::env::args_os().skip(2).collect::<Vec<_>>();
            anyhow::ensure!(args.len() == 2 || (args.len() == 3 && args[2] == "--webview2-automation"),
                "Usage: superhigh-cli __launch-desktop <exe> <cwd> [--webview2-automation]");
            let executable = std::path::Path::new(&args[0]);
            anyhow::ensure!(executable.is_absolute() && executable.is_file(), "桌面程序路径无效");
            let pid = launch(executable, std::path::Path::new(&args[1]), if args.len() == 3 { "--webview2-automation" } else { "" })?;
            println!("{pid}");
            Ok(())
        }
        #[cfg(not(windows))]
        anyhow::bail!("独立桌面启动仅支持 Windows")
    })();
    match result { Ok(()) => 0, Err(error) => { eprintln!("{error:#}"); 1 } }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    #[ignore]
    fn fixture_process() { std::thread::sleep(std::time::Duration::from_secs(15)); }

    #[test]
    fn desktop_is_parented_to_shell_instead_of_requesting_agent() {
        use windows_sys::Win32::{Foundation::CloseHandle, System::{Diagnostics::ToolHelp::*, Threading::*}, UI::WindowsAndMessaging::*};
        let executable = std::env::current_exe().unwrap();
        let pid = launch(&executable, executable.parent().unwrap(), "--ignored --exact desktop_launch::tests::fixture_process").unwrap();
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, pid);
            assert!(!handle.is_null());
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = Process32FirstW(snapshot, &mut entry);
            let mut parent = None;
            while found != 0 {
                if entry.th32ProcessID == pid { parent = Some(entry.th32ParentProcessID); break; }
                found = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            TerminateProcess(handle, 1);
            WaitForSingleObject(handle, 3000);
            CloseHandle(handle);
            let mut shell_pid = 0;
            GetWindowThreadProcessId(GetShellWindow(), &mut shell_pid);
            assert_eq!(parent, Some(shell_pid));
            assert_ne!(parent, Some(std::process::id()));
        }
    }
}
