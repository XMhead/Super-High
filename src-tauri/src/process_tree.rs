pub fn kill_pty_child_tree(child: &mut (dyn portable_pty::Child + Send + Sync)) {
    if matches!(child.try_wait(), Ok(Some(_))) { return; }
    if let Some(process_id) = child.process_id() {
        if kill_process_tree(process_id) {
            return;
        }
    }

    let _ = child.kill();
}

pub fn kill_std_child_tree(child: &mut std::process::Child) {
    // A completed Child can retain a PID that Windows has already reused.
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
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

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE, FILETIME},
        System::{Diagnostics::ToolHelp::*, Threading::*},
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return false; }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut processes = Vec::new();
        let mut found = Process32FirstW(snapshot, &mut entry);
        while found != 0 {
            let length = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if let Some(identity) = crate::service_console::identity(entry.th32ProcessID) {
                processes.push(TreeProcess { pid: identity.pid, parent: entry.th32ParentProcessID,
                    created: identity.created, name: String::from_utf16_lossy(&entry.szExeFile[..length]) });
            }
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        // A restarted desktop is a descendant, but it and everything it owns
        // belong to the user, not to the Agent that happened to launch it.
        let targets = session_tree_targets(&processes, process_id, std::process::id());
        for target in targets {
            let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, target.pid);
            if handle.is_null() { continue; }
            let mut created: FILETIME = std::mem::zeroed();
            let mut exited: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) != 0
                && ((created.dwHighDateTime as u64) << 32 | created.dwLowDateTime as u64) == target.created {
                // Never use /T here: it would cross the protected branches again.
                TerminateProcess(handle, 1);
            }
            CloseHandle(handle);
        }
        // Do not fall back to a recursive killer if a protected root was skipped.
        true
    }
}

#[cfg(any(windows, test))]
struct TreeProcess { pid: u32, parent: u32, created: u64, name: String }

#[cfg(any(windows, test))]
fn session_tree_targets(processes: &[TreeProcess], root: u32, current: u32) -> Vec<&TreeProcess> {
    use std::collections::HashSet;
    let mut protected = HashSet::new();
    let mut ancestor = current;
    while protected.insert(ancestor) {
        let Some(process) = processes.iter().find(|p| p.pid == ancestor) else { break };
        ancestor = process.parent;
    }
    fn visit<'a>(processes: &'a [TreeProcess], pid: u32, protected: &HashSet<u32>,
        seen: &mut HashSet<u32>, targets: &mut Vec<&'a TreeProcess>) {
        if !seen.insert(pid) || protected.contains(&pid) { return; }
        let Some(process) = processes.iter().find(|p| p.pid == pid) else { return };
        let name = process.name.to_ascii_lowercase();
        if name.starts_with("super-high") && (name.ends_with(".exe") || name.contains(".exe.replaced-")) { return; }
        for child in processes.iter().filter(|p| p.parent == pid && p.created >= process.created) {
            visit(processes, child.pid, protected, seen, targets);
        }
        targets.push(process);
    }
    let mut targets = Vec::new();
    visit(processes, root, &protected, &mut HashSet::new(), &mut targets);
    targets
}

#[cfg(not(windows))]
fn kill_process_tree(_process_id: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, parent: u32, name: &str) -> TreeProcess {
        TreeProcess { pid, parent, created: pid as u64, name: name.into() }
    }

    #[test]
    fn restarted_desktop_and_other_session_survive_closing_launcher() {
        let processes = vec![process(1, 0, "host.exe"), process(2, 1, "codex.exe"),
            process(3, 2, "powershell.exe"), process(4, 3, "super-high.exe"),
            process(5, 4, "agent-host.exe"), process(6, 5, "codex.exe"),
            process(7, 2, "node.exe"), process(8, 7, "worker.exe")];
        let targets = session_tree_targets(&processes, 2, 1).iter().map(|p| p.pid).collect::<Vec<_>>();
        assert_eq!(targets, [3, 8, 7, 2]);
    }

    #[test]
    fn protects_replaced_desktop_ancestors_and_reused_parent_pids() {
        let mut processes = vec![process(1, 0, "host.exe"), process(2, 1, "codex.exe"),
            process(3, 2, "super-high.exe.replaced-20261105"), process(4, 3, "codex.exe"),
            process(5, 2, "unrelated.exe")];
        processes[4].created = 1; // Older than its supposed parent: reused PID.
        assert_eq!(session_tree_targets(&processes, 2, 1).iter().map(|p| p.pid).collect::<Vec<_>>(), [2]);
        assert!(session_tree_targets(&processes, 1, 4).is_empty());
    }

    // Run only as a child of the real-process regression below.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn process_fixture() {
        use std::{fs, process::Command, time::Duration};
        let Some(directory) = std::env::var_os("SUPERHIGH_TREE_FIXTURE") else { return };
        let directory = std::path::PathBuf::from(directory);
        let stage = std::env::var("SUPERHIGH_TREE_STAGE").unwrap();
        let executable = std::env::current_exe().unwrap();
        let spawn = |path: &std::path::Path, stage: &str| {
            Command::new(path).args(["--ignored", "--exact", "process_tree::tests::process_fixture"])
                .env("SUPERHIGH_TREE_STAGE", stage).spawn().unwrap()
        };
        let _children = match stage.as_str() {
            "root" => vec![spawn(&directory.join("super-high-fixture.exe"), "desktop"), spawn(&executable, "ordinary")],
            "desktop" => vec![spawn(&executable, "other-session")],
            _ => vec![],
        };
        fs::write(directory.join(stage), std::process::id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(30));
    }

    #[cfg(windows)]
    #[test]
    fn closing_real_process_tree_preserves_restarted_desktop_and_second_task() {
        use std::{fs, process::{Command, Stdio}, time::{Duration, Instant}};
        use crate::service_console::{identity, process_matches, ProcessIdentity};
        struct Cleanup(Vec<ProcessIdentity>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
                for process in self.0.iter().rev() {
                    if !process_matches(*process) { continue; }
                    unsafe {
                        let handle = OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, 0, process.pid);
                        if !handle.is_null() { TerminateProcess(handle, 1); WaitForSingleObject(handle, 3000); CloseHandle(handle); }
                    }
                }
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        fs::copy(&executable, directory.path().join("super-high-fixture.exe")).unwrap();
        let mut root = Command::new(executable)
            .args(["--ignored", "--exact", "process_tree::tests::process_fixture"])
            .env("SUPERHIGH_TREE_FIXTURE", directory.path()).env("SUPERHIGH_TREE_STAGE", "root")
            .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let mut cleanup = Cleanup(vec![identity(root.id()).unwrap()]);
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut records = std::collections::HashMap::new();
        while records.len() < 4 && Instant::now() < deadline {
            for stage in ["root", "ordinary", "desktop", "other-session"] {
                if records.contains_key(stage) { continue; }
                if let Some(process) = fs::read_to_string(directory.path().join(stage)).ok()
                    .and_then(|s| s.parse().ok()).and_then(identity) {
                    cleanup.0.push(process);
                    records.insert(stage, process);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(records.len(), 4, "fixture processes failed to start");
        kill_std_child_tree(&mut root);
        root.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while process_matches(records["ordinary"]) && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
        assert!(!process_matches(records["ordinary"]));
        assert!(process_matches(records["desktop"]));
        assert!(process_matches(records["other-session"]));
        drop(cleanup);
        assert!(records.values().all(|process| !process_matches(*process)));
    }
}
