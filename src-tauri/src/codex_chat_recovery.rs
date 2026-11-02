//! Compatibility for a live legacy host whose recorded identity has no log.
use std::{collections::HashMap, net::{Ipv4Addr, SocketAddr}, path::Path, sync::{Mutex, OnceLock}, time::{Duration, Instant}};
use crate::service_console::ProcessIdentity;

type Source = (String, String);
struct Cached { process: ProcessIdentity, native: Option<String>, checked: Instant, source: Option<Source> }
static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();

pub(crate) fn recover(id: &str, process: ProcessIdentity, native: Option<&str>, cwd: &Path) -> Option<Source> {
    if !crate::service_console::process_matches(process) { return None; }
    let cache = CACHE.get_or_init(Default::default);
    if let Some(cached) = cache.lock().unwrap().get(id) {
        if cached.process == process && cached.native.as_deref() == native
            && (cached.source.is_some() || cached.checked.elapsed() < Duration::from_secs(5)) { return cached.source.clone(); }
    }
    let mut source = None;
    for endpoint in server_endpoints(process).unwrap_or_default() {
        if let Ok(Some(candidate)) = crate::codex_agents::foreground_thread(endpoint, cwd) {
            // Multiple servers/foreground threads are ambiguous; never guess by age or title.
            if source.is_some() { source = None; break; }
            source = Some(candidate);
        }
    }
    if !crate::service_console::process_matches(process) { return None; }
    let mut cache = cache.lock().unwrap();
    if cache.len() >= 32 { cache.retain(|_, item| crate::service_console::process_matches(item.process)); }
    cache.insert(id.into(), Cached { process, native: native.map(str::to_owned), checked: Instant::now(), source: source.clone() });
    source
}

#[cfg(windows)]
fn server_endpoints(process: ProcessIdentity) -> anyhow::Result<Vec<SocketAddr>> {
    use windows_sys::Win32::{Foundation::ERROR_INSUFFICIENT_BUFFER, NetworkManagement::IpHelper::{GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER}, Networking::WinSock::AF_INET};
    let children = crate::service_console::descendant_processes(process.pid, &["codex.exe".into(), "node.exe".into()])?;
    let mut bytes = 0;
    let status = unsafe { GetExtendedTcpTable(std::ptr::null_mut(), &mut bytes, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_LISTENER, 0) };
    anyhow::ensure!(status == ERROR_INSUFFICIENT_BUFFER, "无法读取 Codex 监听端口：{status}");
    // u32 storage keeps the table and its rows aligned.
    let mut table = vec![0u32; (bytes as usize + 3) / 4];
    let status = unsafe { GetExtendedTcpTable(table.as_mut_ptr().cast(), &mut bytes, 0, AF_INET as u32, TCP_TABLE_OWNER_PID_LISTENER, 0) };
    anyhow::ensure!(status == 0, "无法读取 Codex 监听端口：{status}");
    let count = table[0] as usize;
    anyhow::ensure!(4 + count * std::mem::size_of::<MIB_TCPROW_OWNER_PID>() <= bytes as usize, "Codex 端口表不完整");
    let rows = unsafe { std::slice::from_raw_parts(table.as_ptr().add(1).cast::<MIB_TCPROW_OWNER_PID>(), count) };
    Ok(rows.iter().filter(|row| children.iter().any(|child| child.pid == row.dwOwningPid && crate::service_console::process_matches(*child)))
        .filter_map(|row| {
            let address = Ipv4Addr::from(row.dwLocalAddr.to_ne_bytes());
            address.is_loopback().then(|| SocketAddr::from((address, u16::from_be(row.dwLocalPort as u16))))
        }).collect())
}

#[cfg(not(windows))]
fn server_endpoints(_: ProcessIdentity) -> anyhow::Result<Vec<SocketAddr>> { Ok(Vec::new()) }
