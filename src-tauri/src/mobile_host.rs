use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;
use tauri::{Emitter, Manager};

use crate::{
    cli_conversations,
    db::AppDb,
    fs_ops::{
        list_directory, normalize_path, read_image_as_data_url, read_text_file,
        search_project_files,
    },
    models::{MobileHostApiStatus, MobileHostConfig, MobileHostStatus, ProjectSearchOptions},
    terminal::{detect_cli_environments, SharedTerminalManager},
};

const BIND_ADDRESS: &str = "0.0.0.0";
const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES: usize = 48 * 1024 * 1024;

pub type SharedMobileHostManager = Arc<MobileHostManager>;

#[derive(Default)]
pub struct MobileHostManager {
    runtime: Mutex<Option<MobileHostRuntime>>,
    active_project: Arc<Mutex<Option<String>>>,
}

struct MobileHostRuntime {
    stop: Arc<AtomicBool>,
    bind: String,
    port: u16,
    token: String,
}

impl MobileHostManager {
    pub fn set_active_project(&self, path: Option<String>) -> anyhow::Result<()> {
        *self.active_project.lock().map_err(|_| anyhow::anyhow!("当前工作区状态不可用"))? = path;
        Ok(())
    }

    pub fn start(
        &self,
        db: Arc<AppDb>,
        app: tauri::AppHandle,
        terminal: SharedTerminalManager,
        config: MobileHostConfig,
    ) -> anyhow::Result<MobileHostStatus> {
        let config = normalized_config(config);
        self.stop();

        let listener = TcpListener::bind((BIND_ADDRESS, config.port))
            .with_context(|| format!("failed to bind mobile host on port {}", config.port))?;
        listener
            .set_nonblocking(true)
            .context("failed to set mobile host listener nonblocking")?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let token = config.token.clone();
        let active_project = Arc::clone(&self.active_project);

        thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let context = MobileHostContext {
                            db: Arc::clone(&db),
                            token: token.clone(),
                            app: app.clone(),
                            terminal: Arc::clone(&terminal),
                            active_project: Arc::clone(&active_project),
                        };
                        thread::spawn(move || handle_connection(stream, context));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => {
                        eprintln!("[Super High] Mobile Host connection error: {error}");
                        thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        });

        let runtime = MobileHostRuntime {
            stop,
            bind: BIND_ADDRESS.to_string(),
            port,
            token: config.token,
        };
        let status = runtime_status(&runtime, true);
        *self.runtime.lock().unwrap() = Some(runtime);
        Ok(status)
    }

    pub fn stop(&self) {
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            runtime.stop.store(true, Ordering::Relaxed);
        }
    }

    pub fn status(&self, config: &MobileHostConfig) -> MobileHostStatus {
        if let Some(runtime) = self.runtime.lock().unwrap().as_ref() {
            return runtime_status(runtime, true);
        }
        let config = normalized_config(config.clone());
        MobileHostStatus {
            running: false,
            bind: BIND_ADDRESS.to_string(),
            port: config.port,
            token: config.token,
            urls: urls_for_port(config.port),
        }
    }
}

fn runtime_status(runtime: &MobileHostRuntime, running: bool) -> MobileHostStatus {
    MobileHostStatus {
        running,
        bind: runtime.bind.clone(),
        port: runtime.port,
        token: runtime.token.clone(),
        urls: urls_for_port(runtime.port),
    }
}

fn normalized_config(mut config: MobileHostConfig) -> MobileHostConfig {
    if config.port == 0 {
        config.port = 10320;
    }
    config
}

fn urls_for_port(port: u16) -> Vec<String> {
    let mut ips = lan_ipv4_addresses();
    ips.dedup();
    ips.push(Ipv4Addr::LOCALHOST);
    ips.into_iter()
        .map(|ip| format!("http://{ip}:{port}"))
        .collect()
}

fn usable_lan_ipv4(ip: Ipv4Addr) -> bool {
    // Only advertise private LAN addresses, never loopback, APIPA or TUN benchmark ranges.
    ip.is_private()
}

#[cfg(windows)]
fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    use windows_sys::Win32::{
        Foundation::ERROR_BUFFER_OVERFLOW,
        NetworkManagement::{
            IpHelper::{
                GetAdaptersAddresses, GetIfEntry2, GAA_FLAG_INCLUDE_GATEWAYS,
                IP_ADAPTER_ADDRESSES_LH, MIB_IF_ROW2,
            },
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{IpDadStatePreferred, AF_INET, SOCKADDR_IN},
    };

    let mut size = 16 * 1024u32;
    for _ in 0..3 {
        // The Windows linked structures require aligned storage which must stay alive
        // while walking adapter and unicast pointers returned inside this allocation.
        let mut storage = vec![0u64; (size as usize + 7) / 8];
        let first = storage.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        let result = unsafe {
            GetAdaptersAddresses(
                AF_INET as u32,
                GAA_FLAG_INCLUDE_GATEWAYS,
                std::ptr::null(),
                first,
                &mut size,
            )
        };
        if result == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if result != 0 {
            return Vec::new();
        }
        let mut addresses = Vec::new();
        let mut current = first;
        unsafe {
            while let Some(adapter) = current.as_ref() {
                current = adapter.Next;
                if adapter.OperStatus != IfOperStatusUp || !matches!(adapter.IfType, 6 | 71) {
                    continue;
                }
                let mut row: MIB_IF_ROW2 = std::mem::zeroed();
                row.InterfaceLuid = adapter.Luid;
                // HardwareInterface is bit 0. Reject virtual Ethernet/TUN adapters.
                if GetIfEntry2(&mut row) != 0 || row.InterfaceAndOperStatusFlags._bitfield & 1 == 0
                {
                    continue;
                }
                let mut unicast = adapter.FirstUnicastAddress;
                while let Some(address) = unicast.as_ref() {
                    unicast = address.Next;
                    if address.DadState != IpDadStatePreferred
                        || address.Address.iSockaddrLength
                            < std::mem::size_of::<SOCKADDR_IN>() as i32
                    {
                        continue;
                    }
                    let Some(socket) = address.Address.lpSockaddr.cast::<SOCKADDR_IN>().as_ref()
                    else {
                        continue;
                    };
                    if socket.sin_family != AF_INET {
                        continue;
                    }
                    let ip = Ipv4Addr::from(socket.sin_addr.S_un.S_addr.to_ne_bytes());
                    if usable_lan_ipv4(ip) {
                        addresses.push((
                            adapter.FirstGatewayAddress.is_null(),
                            adapter.Ipv4Metric,
                            ip,
                        ));
                    }
                }
            }
        }
        addresses.sort_unstable();
        return addresses.into_iter().map(|(_, _, ip)| ip).collect();
    }
    Vec::new()
}

#[cfg(not(windows))]
fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    use std::net::{IpAddr, UdpSocket};
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
        return Vec::new();
    };
    if socket.connect("8.8.8.8:80").is_ok() {
        if let Ok(address) = socket.local_addr() {
            if let IpAddr::V4(ip) = address.ip() {
                if usable_lan_ipv4(ip) {
                    return vec![ip];
                }
            }
        }
    }
    Vec::new()
}

struct MobileHostContext {
    db: Arc<AppDb>,
    app: tauri::AppHandle,
    terminal: SharedTerminalManager,
    token: String,
    active_project: Arc<Mutex<Option<String>>>,
}

struct HttpRequest {
    method: String,
    raw_path: String,
    token: String,
    body: Vec<u8>,
}

fn handle_connection(mut stream: TcpStream, context: MobileHostContext) {
    if configure_connection(&stream).is_err() {
        return;
    }

    let request = match read_request(&mut stream) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(status) => {
            write_json_error(
                &mut stream,
                status,
                match status {
                    413 => "请求体过大",
                    431 => "请求头过大",
                    408 => "HTTP 请求读取超时",
                    _ => "HTTP 请求无效",
                },
            );
            return;
        }
    };

    if request.method == "OPTIONS" {
        write_response(&mut stream, 204, "text/plain; charset=utf-8", &[]);
        return;
    }

    if handle_public_request(&mut stream, &request) {
        return;
    }

    if context.token.is_empty() || request.token != context.token {
        write_json_error(&mut stream, 401, "手机端令牌不正确");
        return;
    }

    route_request(&mut stream, &context, request);
}

fn is_mobile_page_request(raw_path: &str) -> bool {
    let path = raw_path.split('?').next().unwrap_or(raw_path);
    path == "/mobile" || path.starts_with("/mobile/")
}

fn mobile_page_directory() -> Option<PathBuf> {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-mobile");
    let executable = std::env::current_exe().ok()?;
    let executable_dir = executable.parent()?;
    // Repository builds read the watched output directly, even if an older copy
    // was previously bundled beside the executable. Installed apps use resources.
    let repository_target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
    if executable.starts_with(repository_target) && repository.is_dir() {
        return Some(repository);
    }
    let installed = executable_dir.join("dist-mobile");
    if installed.is_dir() {
        Some(installed)
    } else if repository.is_dir() {
        Some(repository)
    } else {
        None
    }
}

fn mobile_relative_path(raw_path: &str) -> Option<PathBuf> {
    let path = raw_path.split('?').next()?;
    let relative = path.strip_prefix("/mobile/")?;
    if relative.is_empty() {
        return Some(PathBuf::from("index.mobile.html"));
    }
    let mut decoded = Vec::new();
    let mut bytes = relative.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = (bytes.next()? as char).to_digit(16)?;
            let low = (bytes.next()? as char).to_digit(16)?;
            decoded.push((high * 16 + low) as u8);
        } else {
            decoded.push(byte);
        }
    }
    let decoded = String::from_utf8(decoded).ok()?;
    if decoded.chars().any(|ch| {
        ch.is_control()
            || matches!(
                ch,
                '\\' | ':' | '%' | '?' | '#' | '*' | '"' | '<' | '>' | '|'
            )
    }) {
        return None;
    }
    if decoded
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(['.', ' ']))
    {
        return None;
    }
    Some(PathBuf::from(decoded))
}

fn mobile_content_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "html" => Some("text/html; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "wasm" => Some("application/wasm"),
        _ => None,
    }
}

fn read_mobile_asset(root: &Path, relative: &Path) -> Result<(Vec<u8>, &'static str), u16> {
    let content_type = mobile_content_type(relative).ok_or(404u16)?;
    let root = root.canonicalize().map_err(|_| 404u16)?;
    let target = root.join(relative).canonicalize().map_err(|_| 404u16)?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err(404);
    }
    let body = std::fs::read(target).map_err(|_| 404u16)?;
    Ok((body, content_type))
}

fn handle_public_request(stream: &mut TcpStream, request: &HttpRequest) -> bool {
    if !is_mobile_page_request(&request.raw_path) {
        return false;
    }
    if request.method != "GET" {
        write_json_error(stream, 405, "手机页面只支持 GET 请求");
        return true;
    }
    if request.raw_path.split('?').next() == Some("/mobile") {
        let _ = stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /mobile/\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return true;
    }
    let Some(relative) = mobile_relative_path(&request.raw_path) else {
        write_json_error(stream, 404, "手机页面路径无效");
        return true;
    };
    let Some(root) = mobile_page_directory() else {
        write_response(
            stream,
            503,
            "text/plain; charset=utf-8",
            "手机页面尚未准备好。请更新电脑端 Super High；开发时请先运行 npm run mobile:build。"
                .as_bytes(),
        );
        return true;
    };
    match read_mobile_asset(&root, &relative) {
        Ok((body, content_type)) => write_response(stream, 200, content_type, &body),
        Err(status) => write_response(
            stream,
            status,
            "text/plain; charset=utf-8",
            "手机页面文件不存在，请刷新页面或更新电脑端手机页面。".as_bytes(),
        ),
    }
    true
}

fn configure_connection(stream: &TcpStream) -> std::io::Result<()> {
    // Windows accepted sockets inherit the listener's nonblocking mode. Each
    // connection has its own worker and must wait for HTTP packets to arrive.
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(Duration::from_secs(20)))
}

fn read_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, u16> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|_| 400u16)?);
    let mut head_bytes = 0usize;
    let request_line = match read_limited_line(&mut reader, MAX_REQUEST_HEAD_BYTES, true) {
        Ok(Some(line)) => line,
        // Browsers open speculative sockets before sending a request. Do not
        // leave a synthetic 400 response on an idle connection they may reuse.
        Ok(None) => return Ok(None),
        Err(status) => return Err(status),
    };
    head_bytes = head_bytes.saturating_add(request_line.as_bytes().len());
    let mut parts = request_line.split_whitespace();
    let Some(method) = parts.next() else {
        return Ok(None);
    };
    let Some(raw_path) = parts.next() else {
        return Ok(None);
    };

    let mut token = String::new();
    let mut content_length = None;
    loop {
        let remaining = MAX_REQUEST_HEAD_BYTES.saturating_sub(head_bytes);
        let Some(line) = read_limited_line(&mut reader, remaining, false)? else {
            break;
        };
        head_bytes = head_bytes.saturating_add(line.as_bytes().len());
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("transfer-encoding:") {
            return Err(400);
        }
        if let Some((name, value)) = trimmed.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                if content_length.is_some() {
                    return Err(400);
                }
                let length = value.trim().parse::<usize>().map_err(|_| 400u16)?;
                let limit = if method.eq_ignore_ascii_case("POST") && decoded_path(raw_path) == "/api/mobile/attachments" {
                    MAX_ATTACHMENT_BODY_BYTES
                } else { MAX_REQUEST_BODY_BYTES };
                if length > limit {
                    return Err(413);
                }
                content_length = Some(length);
            }
        }
        if lower.starts_with("authorization: bearer ") {
            token = trimmed[22..].trim().to_string();
        }
    }

    let mut body = vec![0; content_length.unwrap_or(0)];
    reader.read_exact(&mut body).map_err(request_read_error)?;
    Ok(Some(HttpRequest {
        method: method.to_ascii_uppercase(),
        raw_path: raw_path.to_string(),
        token,
        body,
    }))
}

fn request_read_error(error: std::io::Error) -> u16 {
    match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => 408,
        _ => 400,
    }
}

fn read_limited_line<R: BufRead>(reader: &mut R, max_bytes: usize, allow_idle_timeout: bool) -> Result<Option<String>, u16> {
    let mut bytes = Vec::new();
    loop {
        let (consume, found_newline) = {
            let available = match reader.fill_buf() {
                Ok(available) => available,
                Err(error) => {
                    let status = request_read_error(error);
                    if allow_idle_timeout && bytes.is_empty() && status == 408 {
                        return Ok(None);
                    }
                    return Err(status);
                }
            };
            if available.is_empty() {
                break;
            }
            let take = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|position| position + 1)
                .unwrap_or(available.len());
            if bytes.len().saturating_add(take) > max_bytes {
                return Err(431);
            }
            bytes.extend_from_slice(&available[..take]);
            (take, available[take - 1] == b'\n')
        };
        reader.consume(consume);
        if found_newline {
            break;
        }
    }

    if bytes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

fn route_request(stream: &mut TcpStream, context: &MobileHostContext, request: HttpRequest) {
    let path = decoded_path(&request.raw_path);
    let params = query_params(&request.raw_path);
    match (request.method.as_str(), path.as_str()) {
        ("GET", "/api/mobile/update")
        | ("POST", "/api/mobile/update/check")
        | ("POST", "/api/mobile/update/download")
        | ("POST", "/api/mobile/update/install") => handle_update(stream, context, &path),
        ("GET", "/api/mobile/providers") => write_json(stream, 200, &detect_cli_environments()),
        ("GET", "/api/mobile/terminals") => handle_terminals(stream, context),
        ("GET", "/api/mobile/terminals/buffer") => handle_terminal_buffer(stream, context, &params),
        ("POST", "/api/mobile/terminals") | ("POST", "/api/mobile/terminals/resume") => {
            handle_terminal_create(stream, context, &request.body, path.ends_with("/resume"))
        }
        ("POST", "/api/mobile/terminals/input")
        | ("POST", "/api/mobile/terminals/resize")
        | ("POST", "/api/mobile/terminals/close") => {
            handle_terminal_action(stream, context, &request.body, &path)
        }
        ("GET", "/api/mobile/conversations") | ("GET", "/api/mobile/conversation") => {
            handle_conversations(stream, context, &params, path.ends_with("/conversation"))
        }
        ("GET", "/api/mobile/status") => handle_status(stream, context),
        ("POST", "/api/mobile/preferences") => handle_preferences(stream, context, &request.body),
        ("POST", "/api/mobile/attachments") => handle_attachment(stream, context, &request.body),
        ("GET", "/api/mobile/recent-projects") => handle_recent_projects(stream, context),
        ("GET", "/api/mobile/dirs") => handle_list_directory(stream, context, &params),
        ("GET", "/api/mobile/files/text") => handle_read_text(stream, context, &params),
        ("GET", "/api/mobile/files/image") => handle_read_image(stream, context, &params),
        ("GET", "/api/mobile/search") => handle_search(stream, context, &params),
        _ => write_json_error(stream, 404, "手机端接口不存在"),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCreateRequest {
    cwd: String,
    provider_kind: String,
    initial_prompt: Option<String>,
    native_session_id: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalActionRequest {
    session_id: String,
    input: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

fn parse_body<T: serde::de::DeserializeOwned>(stream: &mut TcpStream, body: &[u8]) -> Option<T> {
    match serde_json::from_slice(body) {
        Ok(value) => Some(value),
        Err(_) => {
            write_json_error(stream, 400, "JSON 请求体无效");
            None
        }
    }
}

fn handle_terminals(stream: &mut TcpStream, context: &MobileHostContext) {
    match context.terminal.inspect_sessions(None) {
        Ok(sessions) => {
            let sessions: Vec<_> = sessions
                .into_iter()
                .filter(|s| path_allowed(context, Path::new(&s.cwd)))
                .collect();
            write_json(stream, 200, &sessions);
        }
        Err(error) => write_json_error(stream, 500, &error.to_string()),
    }
}

fn terminal_allowed(context: &MobileHostContext, id: &str) -> bool {
    context
        .terminal
        .inspect_sessions(None)
        .map(|sessions| {
            sessions
                .iter()
                .any(|s| s.id == id && path_allowed(context, Path::new(&s.cwd)))
        })
        .unwrap_or(false)
}

fn handle_terminal_create(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    body: &[u8],
    resume: bool,
) {
    let Some(request) = parse_body::<TerminalCreateRequest>(stream, body) else {
        return;
    };
    let cwd = Path::new(&request.cwd);
    if !cwd.is_dir() || !path_allowed(context, cwd) {
        write_json_error(stream, 403, "该目录不在历史工作区中");
        return;
    }
    let result = if resume {
        let Some(id) = request.native_session_id.as_deref() else {
            write_json_error(stream, 400, "缺少 nativeSessionId");
            return;
        };
        let allowed = cli_conversations::list_workspace_conversations(cwd)
            .map(|items| {
                items.iter().any(|item| {
                    item.provider_kind == request.provider_kind
                        && item.native_session_id.as_deref() == Some(id)
                        && item.resume_supported
                })
            })
            .unwrap_or(false);
        if !allowed {
            write_json_error(stream, 403, "该对话不属于指定工作区或不能恢复");
            return;
        }
        context.terminal.resume_session_for_workspace(
            &context.app,
            None,
            &request.provider_kind,
            cwd,
            id,
        )
    } else {
        context.terminal.create_session_for_workspace(
            &context.app,
            None,
            &request.provider_kind,
            cwd,
            HashMap::new(),
            request.initial_prompt,
        )
    };
    match result {
        Ok(session) => {
            let _ = context.app.emit("mobile-terminal-created", &session);
            write_json(stream, 200, &session)
        }
        Err(error) => write_json_error(stream, 400, &error.to_string()),
    }
}

fn handle_terminal_action(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    body: &[u8],
    path: &str,
) {
    let Some(request) = parse_body::<TerminalActionRequest>(stream, body) else {
        return;
    };
    if !terminal_allowed(context, &request.session_id) {
        write_json_error(stream, 404, "会话不存在或不在授权工作区中");
        return;
    }
    let result = if path.ends_with("/input") {
        match request.input {
            Some(input) => context.terminal.write_input(&request.session_id, &input),
            None => Err(anyhow::anyhow!("缺少 input")),
        }
    } else if path.ends_with("/resize") {
        match (request.cols, request.rows) {
            (Some(cols @ 2..=500), Some(rows @ 2..=300)) => {
                context
                    .terminal
                    .resize_session(&request.session_id, cols, rows)
            }
            _ => Err(anyhow::anyhow!("终端尺寸无效")),
        }
    } else {
        context.terminal.close_session(&request.session_id)
    };
    match result {
        Ok(()) => write_json(stream, 200, &serde_json::json!({"ok": true})),
        Err(error) => write_json_error(stream, 400, &error.to_string()),
    }
}

fn buffer_since(
    snapshot: crate::models::TerminalBufferSnapshot,
    after: Option<u64>,
    running: bool,
) -> serde_json::Value {
    let offset = after
        .filter(|after| *after >= snapshot.start_byte && *after <= snapshot.end_byte)
        .map(|after| (after - snapshot.start_byte) as usize)
        .filter(|offset| snapshot.buffer.is_char_boundary(*offset));
    let reset = after.is_some() && offset.is_none();
    let offset = offset.unwrap_or(0);
    serde_json::json!({"buffer": &snapshot.buffer[offset..], "startByte": snapshot.start_byte + offset as u64, "endByte": snapshot.end_byte, "running": running, "reset": reset, "cols": snapshot.cols, "rows": snapshot.rows})
}

fn wait_for_terminal_buffer(
    after: Option<u64>,
    known_size: Option<(u16, u16)>,
    wait: Duration,
    mut read: impl FnMut() -> anyhow::Result<(crate::models::TerminalBufferSnapshot, bool)>,
) -> anyhow::Result<(crate::models::TerminalBufferSnapshot, bool)> {
    let deadline = Instant::now() + wait.min(Duration::from_millis(1500));
    let mut known_size = known_size;
    loop {
        let (snapshot, running) = read()?;
        let size = (snapshot.cols, snapshot.rows);
        let previous_size = *known_size.get_or_insert(size);
        if after != Some(snapshot.end_byte)
            || !running
            || size != previous_size
            || Instant::now() >= deadline
        {
            return Ok((snapshot, running));
        }
        // No terminal/session lock is retained while waiting. Bound idle CPU work
        // and wake promptly for output, a desktop resize, or process exit.
        thread::sleep(
            Duration::from_millis(16).min(deadline.saturating_duration_since(Instant::now())),
        );
    }
}

fn handle_terminal_buffer(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    params: &HashMap<String, String>,
) {
    let id = params.get("sessionId").map(String::as_str).unwrap_or("");
    if !terminal_allowed(context, id) {
        write_json_error(stream, 404, "会话不存在或不在授权工作区中");
        return;
    }
    let after = params.get("after").and_then(|v| v.parse().ok());
    let wait_ms = params
        .get("waitMs")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
        .min(1500);
    let known_size = params
        .get("cols")
        .and_then(|v| v.parse().ok())
        .zip(params.get("rows").and_then(|v| v.parse().ok()));
    let result = wait_for_terminal_buffer(after, known_size, Duration::from_millis(wait_ms), || {
        let snapshot = context.terminal.terminal_buffer_since(id, after)?;
        let running = context
            .terminal
            .live_session_ids()
            .iter()
            .any(|live| live == id);
        Ok((snapshot, running))
    });
    match result {
        Ok((snapshot, running)) => {
            write_json(
                stream,
                200,
                &buffer_since(snapshot, after, running),
            );
        }
        Err(error) => write_json_error(stream, 404, &error.to_string()),
    }
}

fn handle_conversations(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    params: &HashMap<String, String>,
    detail: bool,
) {
    let Some(root) = required_path_param(stream, params, "root") else {
        return;
    };
    if !path_allowed(context, &root) {
        write_json_error(stream, 403, "该工作区不在历史记录中");
        return;
    }
    if detail {
        let source = params.get("sourcePath").map(String::as_str).unwrap_or("");
        let listed = cli_conversations::list_workspace_conversations(&root)
            .map(|items| items.iter().any(|item| item.source_path == source))
            .unwrap_or(false);
        if !listed {
            write_json_error(stream, 403, "该对话不属于指定工作区");
            return;
        }
        match cli_conversations::read_workspace_conversation(&root, source) {
            Ok(value) => write_json(stream, 200, &value),
            Err(error) => write_json_error(stream, 400, &error.to_string()),
        }
    } else {
        match cli_conversations::list_workspace_conversations(&root) {
            Ok(value) => write_json(stream, 200, &value),
            Err(error) => write_json_error(stream, 400, &error.to_string()),
        }
    }
}

fn handle_update(stream: &mut TcpStream, context: &MobileHostContext, path: &str) {
    let app = &context.app;
    let result = tauri::async_runtime::block_on(async {
        match path {
            "/api/mobile/update/check" => crate::app_updater::check_app_update_command(app.clone(), app.state()).await,
            "/api/mobile/update/download" => crate::app_updater::download_app_update_command(app.state()).await,
            "/api/mobile/update/install" => crate::app_updater::install_app_update_command(app.state(), app.state()).await,
            _ => crate::app_updater::get_app_update_status_command(app.state(), app.state()),
        }
    });
    match result {
        Ok(status) => write_json(stream, 200, &status),
        Err(error) => write_json_error(stream, 500, &error),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreferencesRequest {
    theme_id: Option<String>,
    hidden_cli_provider_ids: Option<Vec<String>>,
}

fn handle_preferences(stream: &mut TcpStream, context: &MobileHostContext, body: &[u8]) {
    let Some(request) = parse_body::<PreferencesRequest>(stream, body) else { return; };
    match context.db.patch_mobile_preferences(request.theme_id, request.hidden_cli_provider_ids) {
        Ok(settings) => {
            let _ = context.app.emit("mobile-preferences-updated", ());
            write_json(stream, 200, &serde_json::json!({"themeId": settings.theme_id, "hiddenCliProviderIds": settings.hidden_cli_provider_ids}));
        }
        Err(error) => write_json_error(stream, 500, &format!("保存偏好失败：{error}")),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentRequest { root: String, name: String, data_url: String }

fn handle_attachment(stream: &mut TcpStream, context: &MobileHostContext, body: &[u8]) {
    let Some(request) = parse_body::<AttachmentRequest>(stream, body) else { return; };
    let root = Path::new(&request.root);
    if !root.is_dir() || !path_allowed(context, root) {
        write_json_error(stream, 403, "该工作区不在历史记录中");
        return;
    }
    match crate::pasted_image::save_attachment_data_url(root, &request.name, &request.data_url) {
        Ok(attachment) => write_json(stream, 200, &attachment),
        Err(error) => write_json_error(stream, 400, &format!("上传附件失败：{error}")),
    }
}

fn handle_status(stream: &mut TcpStream, context: &MobileHostContext) {
    let settings = match context.db.load_settings() {
        Ok(settings) => settings,
        Err(error) => { write_json_error(stream, 500, &format!("读取偏好失败：{error}")); return; }
    };
    let recent_project_count = context
        .db
        .list_recent_projects()
        .map(|items| items.len())
        .unwrap_or_default();
    let status = MobileHostApiStatus {
        status: "ok".to_string(),
        app_name: "Super High".to_string(),
        server_time: now_seconds(),
        recent_project_count,
        active_project_path: context.active_project.lock().ok().and_then(|path| path.clone()),
        version: env!("CARGO_PKG_VERSION").to_string(),
        theme_id: settings.theme_id,
        hidden_cli_provider_ids: settings.hidden_cli_provider_ids,
    };
    write_json(stream, 200, &status);
}

fn handle_recent_projects(stream: &mut TcpStream, context: &MobileHostContext) {
    match context.db.list_recent_projects() {
        Ok(projects) => write_json(stream, 200, &projects),
        Err(error) => write_json_error(stream, 500, &format!("读取历史工作区失败：{error}")),
    }
}

fn handle_list_directory(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    params: &HashMap<String, String>,
) {
    let Some(path) = required_path_param(stream, params, "path") else {
        return;
    };
    if !path_allowed(context, &path) {
        write_json_error(stream, 403, "该路径不在历史工作区中");
        return;
    }
    match list_directory(&path) {
        Ok(listing) => write_json(stream, 200, &listing),
        Err(error) => write_json_error(stream, 404, &format!("读取目录失败：{error}")),
    }
}

fn handle_read_text(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    params: &HashMap<String, String>,
) {
    let Some(path) = required_path_param(stream, params, "path") else {
        return;
    };
    if !path_allowed(context, &path) {
        write_json_error(stream, 403, "该路径不在历史工作区中");
        return;
    }
    match read_text_file(&path) {
        Ok(content) => write_response(stream, 200, "text/plain; charset=utf-8", content.as_bytes()),
        Err(error) => write_json_error(stream, 415, &format!("读取文件失败：{error}")),
    }
}

fn handle_read_image(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    params: &HashMap<String, String>,
) {
    let Some(path) = required_path_param(stream, params, "path") else {
        return;
    };
    if !path_allowed(context, &path) {
        write_json_error(stream, 403, "该路径不在历史工作区中");
        return;
    }
    match read_image_as_data_url(&path) {
        Ok(data_url) => write_response(
            stream,
            200,
            "text/plain; charset=utf-8",
            data_url.as_bytes(),
        ),
        Err(error) => write_json_error(stream, 415, &format!("读取图片失败：{error}")),
    }
}

fn handle_search(
    stream: &mut TcpStream,
    context: &MobileHostContext,
    params: &HashMap<String, String>,
) {
    let Some(root) = required_path_param(stream, params, "root") else {
        return;
    };
    if !path_allowed(context, &root) {
        write_json_error(stream, 403, "该工作区不在历史记录中");
        return;
    }
    let query = params.get("q").map(String::as_str).unwrap_or("").trim();
    if query.is_empty() {
        write_json_error(stream, 400, "缺少搜索词");
        return;
    }
    match search_project_files(
        query,
        &[normalize_path(&root)],
        ProjectSearchOptions {
            include_text: true,
            file_name_only: false,
            limit: 80,
        },
    ) {
        Ok(result) => write_json(stream, 200, &result),
        Err(error) => write_json_error(stream, 500, &format!("搜索失败：{error}")),
    }
}

fn required_path_param(
    stream: &mut TcpStream,
    params: &HashMap<String, String>,
    name: &str,
) -> Option<PathBuf> {
    let value = params.get(name).map(String::as_str).unwrap_or("").trim();
    if value.is_empty() {
        write_json_error(stream, 400, &format!("缺少 {name} 参数"));
        return None;
    }
    Some(PathBuf::from(value))
}

fn path_allowed(context: &MobileHostContext, path: &Path) -> bool {
    path_allowed_by_db(&context.db, path)
}

fn path_allowed_by_db(db: &AppDb, path: &Path) -> bool {
    let Ok(target) = path.canonicalize() else {
        return false;
    };
    let Ok(projects) = db.list_recent_projects() else {
        return false;
    };
    projects.iter().any(|project| {
        let root = PathBuf::from(&project.path);
        root.canonicalize()
            .map(|root| target.starts_with(root))
            .unwrap_or(false)
    })
}

fn decoded_path(raw_path: &str) -> String {
    url_decode(
        raw_path
            .split('?')
            .next()
            .unwrap_or(raw_path)
            .trim_end_matches('/'),
    )
}

fn query_params(raw_path: &str) -> HashMap<String, String> {
    let mut params = HashMap::new();
    let Some(query) = raw_path.split_once('?').map(|(_, query)| query) else {
        return params;
    };
    for part in query.split('&') {
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        params.insert(url_decode(key), url_decode(value));
    }
    params
}

fn url_decode(input: &str) -> String {
    let mut bytes = Vec::new();
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch == '%' {
            let hex = chars.by_ref().take(2).collect::<String>();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                bytes.push(byte);
            }
        } else if ch == '+' {
            bytes.push(b' ');
        } else {
            let mut buffer = [0; 4];
            bytes.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_json<T: serde::Serialize>(stream: &mut TcpStream, status: u16, value: &T) {
    match serde_json::to_vec(value) {
        Ok(body) => write_response(stream, status, "application/json; charset=utf-8", &body),
        Err(error) => write_json_error(stream, 500, &format!("序列化响应失败：{error}")),
    }
}

fn write_json_error(stream: &mut TcpStream, status: u16, message: &str) {
    let body = serde_json::json!({ "error": message }).to_string();
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        body.as_bytes(),
    );
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::{query_params, url_decode};

    #[test]
    fn static_paths_reject_traversal_and_windows_aliases() {
        for path in [
            "/mobile/../secret.json",
            "/mobile/%2e%2e/secret.json",
            "/mobile/assets/%2e%2e/secret.json",
            "/mobile/%252e%252e/secret.json",
            "/mobile/%5csecret.json",
            "/mobile/C:/secret.json",
            "/mobile/a.js:secret",
            "/mobile/assets//a.js",
            "/mobile/assets./a.js",
            "/mobile/a%00.js",
            "/mobile/%zz.js",
            "/mobile/%ff.js",
            "/mobile/.env",
        ] {
            assert!(super::mobile_relative_path(path).is_none(), "{path}");
        }
        assert_eq!(
            super::mobile_relative_path("/mobile/?v=2").unwrap(),
            std::path::Path::new("index.mobile.html")
        );
        assert_eq!(
            super::mobile_relative_path("/mobile/assets/app.js?v=2").unwrap(),
            std::path::Path::new("assets/app.js")
        );
        assert_eq!(
            super::mobile_relative_path("/mobile/index.mobile.html").unwrap(),
            std::path::Path::new("index.mobile.html")
        );
    }

    #[test]
    fn static_assets_read_fresh_bytes_and_stay_inside_page_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("dist-mobile");
        std::fs::create_dir(&root).unwrap();
        let index = root.join("index.mobile.html");
        std::fs::write(&index, "first").unwrap();
        let relative = std::path::Path::new("index.mobile.html");
        assert_eq!(
            super::read_mobile_asset(&root, relative).unwrap().0,
            b"first"
        );
        std::fs::write(&index, "updated").unwrap();
        let (body, mime) = super::read_mobile_asset(&root, relative).unwrap();
        assert_eq!(body, b"updated");
        assert_eq!(mime, "text/html; charset=utf-8");
        std::fs::write(temporary.path().join("secret.json"), "secret").unwrap();
        for path in ["../secret.json", ".", "missing.js"] {
            assert_eq!(
                super::read_mobile_asset(&root, std::path::Path::new(path)).err(),
                Some(404)
            );
        }
    }

    #[test]
    fn public_route_never_claims_authenticated_api_paths() {
        use std::net::{TcpListener, TcpStream};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        for raw_path in [
            "/api/mobile/status",
            "/api/mobile/terminals",
            "/api/mobile/files/text?path=test",
            "/mobile-api",
            "/%6dobile/",
            "/",
        ] {
            let request = super::HttpRequest {
                method: "GET".into(),
                raw_path: raw_path.into(),
                token: String::new(),
                body: Vec::new(),
            };
            assert!(
                !super::handle_public_request(&mut server, &request),
                "{raw_path}"
            );
        }
        assert!(super::is_mobile_page_request("/mobile/?v=1"));
        assert!(super::is_mobile_page_request("/mobile"));
    }

    #[test]
    fn rejects_virtual_reserved_and_non_lan_addresses() {
        for address in [
            "198.18.0.1",
            "198.19.255.254",
            "127.0.0.1",
            "169.254.1.2",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "100.64.0.1",
            "8.8.8.8",
        ] {
            assert!(
                !super::usable_lan_ipv4(address.parse().unwrap()),
                "{address}"
            );
        }
        for octets in [[192, 168, 0, 1], [10, 0, 0, 1], [172, 16, 0, 1], [172, 31, 255, 254]] {
            let address = std::net::Ipv4Addr::from(octets);
            assert!(
                super::usable_lan_ipv4(address),
                "{address}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_windows_host_urls_without_virtual_addresses() {
        let urls = super::urls_for_port(10320);
        eprintln!("Mobile Host URLs: {urls:?}");
        assert_eq!(urls.last().unwrap(), "http://127.0.0.1:10320");
        for ip in super::lan_ipv4_addresses() {
            assert!(super::usable_lan_ipv4(ip));
        }
    }

    fn parse_request(bytes: &[u8]) -> Result<Option<super::HttpRequest>, u16> {
        use std::{
            io::Write,
            net::{TcpListener, TcpStream},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let bytes = bytes.to_vec();
        let writer = std::thread::spawn(move || {
            let _ = client.write_all(&bytes);
            let _ = client.shutdown(std::net::Shutdown::Write);
        });
        let (mut server, _) = listener.accept().unwrap();
        let result = super::read_request(&mut server);
        drop(server);
        writer.join().unwrap();
        result
    }

    #[test]
    fn accepted_nonblocking_socket_waits_for_fragmented_request() {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        // Also exercise this Windows inheritance behavior on other platforms.
        server.set_nonblocking(true).unwrap();
        super::configure_connection(&server).unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            client.write_all(b"POST /api/mobile/terminals/input HTTP/1.1\r\nContent-Length: 2\r\n\r\n").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(30));
            client.write_all(b"{}").unwrap();
        });
        let request = super::read_request(&mut server).unwrap().unwrap();
        assert_eq!(request.body, b"{}");
        writer.join().unwrap();
    }

    #[test]
    fn idle_browser_preconnection_closes_without_a_bad_request_response() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let _client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server.set_read_timeout(Some(std::time::Duration::from_millis(30))).unwrap();
        assert!(matches!(super::read_request(&mut server), Ok(None)));
    }

    #[test]
    fn incomplete_request_timeout_is_not_malformed_http() {
        use std::io::Write;
        for bytes in [b"GET /api/mobile/status HTTP/1.1\r\n".as_slice(), b"GET /api/mobile/stat".as_slice()] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            client.write_all(bytes).unwrap();
            let (mut server, _) = listener.accept().unwrap();
            server.set_read_timeout(Some(std::time::Duration::from_millis(30))).unwrap();
            assert_eq!(super::read_request(&mut server).err(), Some(408));
        }
    }

    #[test]
    fn parses_authenticated_post_body_without_losing_buffered_bytes() {
        let request = parse_request(b"POST /api/mobile/terminals/input HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Length: 2\r\n\r\n{}").unwrap().unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.token, "secret");
        assert_eq!(request.body, b"{}");
    }

    #[test]
    fn attachment_paths_require_known_workspace_and_reject_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("known");
        let outside = directory.path().join("known-other");
        std::fs::create_dir_all(root.join("child")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let db = crate::db::AppDb::new(directory.path()).unwrap();
        assert!(!super::path_allowed_by_db(&db, &root));
        db.upsert_recent_project(&crate::models::RecentProject { path: root.to_string_lossy().into_owned(), name: "known".into(), last_opened_at: "now".into() }).unwrap();
        assert!(super::path_allowed_by_db(&db, &root));
        assert!(super::path_allowed_by_db(&db, &root.join("child")));
        assert!(!super::path_allowed_by_db(&db, &outside));
        assert!(!super::path_allowed_by_db(&db, &root.join("..").join("known-other")));
        assert!(!super::path_allowed_by_db(&db, &root.join("missing")));
    }

    #[test]
    fn attachment_request_accepts_large_body_only_on_upload_endpoint() {
        use base64::Engine as _;
        // Valid uncompressed 768 x 768, 24-bit BMP exercises a real image above 1 MiB.
        let mut image = vec![0xA5; 54 + 768 * 768 * 3];
        image[..54].fill(0);
        image[..2].copy_from_slice(b"BM");
        let file_size = image.len() as u32;
        image[2..6].copy_from_slice(&file_size.to_le_bytes());
        image[10..14].copy_from_slice(&54u32.to_le_bytes());
        image[14..18].copy_from_slice(&40u32.to_le_bytes());
        image[18..22].copy_from_slice(&768u32.to_le_bytes());
        image[22..26].copy_from_slice(&768u32.to_le_bytes());
        image[26..28].copy_from_slice(&1u16.to_le_bytes());
        image[28..30].copy_from_slice(&24u16.to_le_bytes());
        let directory = tempfile::tempdir().unwrap();
        let body = serde_json::to_vec(&serde_json::json!({"root": directory.path(), "name": "photo.bmp", "dataUrl": format!("data:image/bmp;base64,{}", base64::engine::general_purpose::STANDARD.encode(&image))})).unwrap();
        let mut request = format!("POST /api/mobile/attachments HTTP/1.1\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        request.extend_from_slice(&body);
        let parsed = parse_request(&request).unwrap().unwrap();
        assert_eq!(parsed.body, body);
        let attachment: super::AttachmentRequest = serde_json::from_slice(&parsed.body).unwrap();
        let saved = crate::pasted_image::save_attachment_data_url(std::path::Path::new(&attachment.root), &attachment.name, &attachment.data_url).unwrap();
        assert_eq!(std::fs::read(saved.path).unwrap(), image);
        for (method, endpoint, length) in [("GET", "/api/mobile/attachments", 1048577), ("POST", "/api/mobile/preferences", 1048577), ("POST", "/api/mobile/attachments", 50331649)] {
            let request = format!("{method} {endpoint} HTTP/1.1\r\nContent-Length: {length}\r\n\r\n");
            assert_eq!(parse_request(request.as_bytes()).err(), Some(413));
        }
    }

    #[test]
    fn rejects_oversized_ambiguous_and_truncated_request_bodies() {
        for (bytes, status) in [
            (
                &b"POST / HTTP/1.1\r\nContent-Length: 1048577\r\n\r\n"[..],
                413,
            ),
            (
                &b"POST / HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 2\r\n\r\n{}"[..],
                400,
            ),
            (
                &b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n"[..],
                400,
            ),
            (&b"POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\n{}"[..], 400),
        ] {
            assert_eq!(parse_request(bytes).err(), Some(status));
        }
    }

    #[test]
    fn polling_preserves_utf8_and_resets_evicted_or_invalid_cursors() {
        let snapshot = crate::models::TerminalBufferSnapshot {
            buffer: "你好!".into(),
            start_byte: 10,
            end_byte: 17,
            cols: 120,
            rows: 32,
        };
        let tail = super::buffer_since(snapshot.clone(), Some(13), true);
        assert_eq!(tail["buffer"], "好!");
        assert_eq!(tail["startByte"], 13);
        assert_eq!(tail["reset"], false);
        assert_eq!(tail["cols"], 120);
        assert_eq!(tail["rows"], 32);
        for cursor in [9, 11, 18] {
            let reset = super::buffer_since(snapshot.clone(), Some(cursor), true);
            assert_eq!(reset["buffer"], "你好!");
            assert_eq!(reset["reset"], true);
        }
        assert_eq!(super::buffer_since(snapshot, Some(17), false)["buffer"], "");
    }

    #[test]
    fn mobile_terminal_wait_returns_on_output_resize_exit_and_timeout() {
        use crate::models::TerminalBufferSnapshot;
        use std::time::{Duration, Instant};
        for reason in ["output", "resize", "exit", "timeout"] {
            let mut reads = 0;
            let started = Instant::now();
            let (snapshot, running) = super::wait_for_terminal_buffer(
                Some(5), Some((120, 32)), Duration::from_millis(45), || {
                    reads += 1;
                    let changed = reads >= 2;
                    Ok((TerminalBufferSnapshot {
                        buffer: if changed && reason == "output" { "!".into() } else { String::new() },
                        start_byte: 5,
                        end_byte: if changed && reason == "output" { 6 } else { 5 },
                        cols: if changed && reason == "resize" { 173 } else { 120 },
                        rows: 32,
                    }, !(changed && reason == "exit")))
                },
            ).unwrap();
            assert!(reads >= 2);
            match reason {
                "output" => assert_eq!(snapshot.buffer, "!"),
                "resize" => assert_eq!(snapshot.cols, 173),
                "exit" => assert!(!running),
                _ => assert!(started.elapsed() >= Duration::from_millis(45)),
            }
        }
    }

    #[test]
    fn decodes_utf8_query_values() {
        assert_eq!(url_decode("D%3A%5C%E9%A1%B9%E7%9B%AE"), r"D:\项目");
    }

    #[test]
    fn query_params_parse_windows_paths() {
        let params = query_params("/api/mobile/dirs?path=D%3A%5CDemo+Files&q=test");

        assert_eq!(params.get("path").unwrap(), r"D:\Demo Files");
        assert_eq!(params.get("q").unwrap(), "test");
    }
}
