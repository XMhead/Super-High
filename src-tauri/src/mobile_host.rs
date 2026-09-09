use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    net::{IpAddr, TcpListener, TcpStream, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::Context;

use crate::{
    db::AppDb,
    fs_ops::{
        list_directory, normalize_path, read_image_as_data_url, read_text_file,
        search_project_files,
    },
    models::{MobileHostApiStatus, MobileHostConfig, MobileHostStatus, ProjectSearchOptions},
};

const BIND_ADDRESS: &str = "0.0.0.0";
const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;

pub type SharedMobileHostManager = Arc<MobileHostManager>;

#[derive(Default)]
pub struct MobileHostManager {
    runtime: Mutex<Option<MobileHostRuntime>>,
}

struct MobileHostRuntime {
    stop: Arc<AtomicBool>,
    bind: String,
    port: u16,
    token: String,
}

impl MobileHostManager {
    pub fn start(
        &self,
        db: Arc<AppDb>,
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

        thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let context = MobileHostContext {
                            db: Arc::clone(&db),
                            token: token.clone(),
                        };
                        thread::spawn(move || handle_connection(stream, context));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(80));
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
    let mut ips = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if let IpAddr::V4(ip) = addr.ip() {
                    if !ip.is_loopback() {
                        ips.push(ip.to_string());
                    }
                }
            }
        }
    }
    ips.push("127.0.0.1".to_string());
    ips.sort();
    ips.dedup();
    ips.into_iter()
        .map(|ip| format!("http://{ip}:{port}"))
        .collect()
}

struct MobileHostContext {
    db: Arc<AppDb>,
    token: String,
}

struct HttpRequest {
    method: String,
    raw_path: String,
    token: String,
}

fn handle_connection(mut stream: TcpStream, context: MobileHostContext) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(20)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(20)));

    let request = match read_request(&mut stream) {
        Ok(Some(request)) => request,
        Ok(None) => return,
        Err(status) => {
            write_json_error(&mut stream, status, "请求头过大");
            return;
        }
    };

    if request.method == "OPTIONS" {
        write_response(&mut stream, 204, "text/plain; charset=utf-8", &[]);
        return;
    }

    if request.token != context.token {
        write_json_error(&mut stream, 401, "手机端令牌不正确");
        return;
    }

    route_request(&mut stream, &context, request);
}

fn read_request(stream: &mut TcpStream) -> Result<Option<HttpRequest>, u16> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|_| 400u16)?);
    let mut head_bytes = 0usize;
    let request_line = match read_limited_line(&mut reader, MAX_REQUEST_HEAD_BYTES)? {
        Some(line) => line,
        None => return Ok(None),
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
    loop {
        let remaining = MAX_REQUEST_HEAD_BYTES.saturating_sub(head_bytes);
        let Some(line) = read_limited_line(&mut reader, remaining)? else {
            break;
        };
        head_bytes = head_bytes.saturating_add(line.as_bytes().len());
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("authorization: bearer ") {
            token = trimmed[22..].trim().to_string();
        }
    }

    Ok(Some(HttpRequest {
        method: method.to_ascii_uppercase(),
        raw_path: raw_path.to_string(),
        token,
    }))
}

fn read_limited_line<R: BufRead>(reader: &mut R, max_bytes: usize) -> Result<Option<String>, u16> {
    let mut bytes = Vec::new();
    loop {
        let (consume, found_newline) = {
            let available = reader.fill_buf().map_err(|_| 400u16)?;
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
        ("GET", "/api/mobile/status") => handle_status(stream, context),
        ("GET", "/api/mobile/recent-projects") => handle_recent_projects(stream, context),
        ("GET", "/api/mobile/dirs") => handle_list_directory(stream, context, &params),
        ("GET", "/api/mobile/files/text") => handle_read_text(stream, context, &params),
        ("GET", "/api/mobile/files/image") => handle_read_image(stream, context, &params),
        ("GET", "/api/mobile/search") => handle_search(stream, context, &params),
        _ => write_json_error(stream, 404, "手机端接口不存在"),
    }
}

fn handle_status(stream: &mut TcpStream, context: &MobileHostContext) {
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
    let Ok(target) = path.canonicalize() else {
        return false;
    };
    let Ok(projects) = context.db.list_recent_projects() else {
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
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        _ => "Unknown",
    };
    let header = format!(
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\nConnection: close\r\n\r\n",
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
    fn decodes_utf8_query_values() {
        assert_eq!(url_decode("D%3A%5C%E9%A1%B9%E7%9B%AE"), r"D:\项目");
    }

    #[test]
    fn query_params_parse_windows_paths() {
        let params = query_params("/api/mobile/dirs?path=D%3A%5CWork%5Capp&q=test");

        assert_eq!(params.get("path").unwrap(), r"D:\Work\app");
        assert_eq!(params.get("q").unwrap(), "test");
    }
}
