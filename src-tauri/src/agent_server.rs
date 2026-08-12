//! Lightweight HTTP file server for remote file access.
//! Zero external dependencies — uses only `std::net::TcpListener`.
//! Compiled as `superhigh-agent.exe`, runs on the remote Windows server.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_TEXT_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_REQUEST_HEAD_BYTES: usize = 64 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 10 * 1024 * 1024;
const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "logs",
    ".superhigh",
    "coverage",
    ".vite",
    ".turbo",
    ".next",
    "out",
    "skills-backup",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

pub struct AgentConfig {
    pub port: u16,
    pub token: String,
    pub root: PathBuf,
    pub bind: String,
}

pub fn run_agent(config: AgentConfig) {
    let root = config
        .root
        .canonicalize()
        .unwrap_or_else(|_| config.root.clone());
    let addr = format!("{}:{}", config.bind, config.port);
    let listener = TcpListener::bind(&addr).unwrap_or_else(|e| {
        eprintln!("无法绑定 {addr}: {e}");
        std::process::exit(1);
    });

    println!("╔══════════════════════════════════════════╗");
    println!("║   Super High Remote Agent               ║");
    println!("╠══════════════════════════════════════════╣");
    println!("║  Root : {:<33} ║", root.display().to_string());
    println!("║  Port : {:<33} ║", config.port);
    println!("║  Bind : {:<33} ║", config.bind);
    println!("╚══════════════════════════════════════════╝");
    println!("  本机连接: http://<Tailscale IP>:{}", config.port);
    println!("  Ctrl+C 停止");
    println!();

    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let config = AgentConfig {
                    port: config.port,
                    token: config.token.clone(),
                    root: root.clone(),
                    bind: config.bind.clone(),
                };
                thread::spawn(move || handle_connection(stream, &config));
            }
            Err(e) => eprintln!("连接错误: {e}"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum LimitedReadError {
    TooLarge,
    Io,
}

fn read_limited_line<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<String>, LimitedReadError> {
    let mut bytes = Vec::new();
    loop {
        let (consume, found_newline) = {
            let available = reader.fill_buf().map_err(|_| LimitedReadError::Io)?;
            if available.is_empty() {
                break;
            }
            let take = available
                .iter()
                .position(|b| *b == b'\n')
                .map(|pos| pos + 1)
                .unwrap_or(available.len());
            if bytes.len().saturating_add(take) > max_bytes {
                return Err(LimitedReadError::TooLarge);
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

fn handle_connection(mut stream: TcpStream, config: &AgentConfig) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(30)));

    let mut reader = BufReader::new(stream.try_clone().unwrap_or_else(|_| {
        // If clone fails, just use a dummy. This is a best-effort internal tool.
        panic!("stream clone failed")
    }));

    let request_line = match read_limited_line(&mut reader, MAX_REQUEST_HEAD_BYTES) {
        Ok(Some(line)) => line,
        Ok(None) | Err(LimitedReadError::Io) => return,
        Err(LimitedReadError::TooLarge) => {
            write_err(&mut stream, 431, "请求头过大");
            return;
        }
    };
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0].to_uppercase();
    let raw_path = parts[1];

    // Read headers
    let mut head_bytes = request_line.as_bytes().len();
    let mut auth_token = String::new();
    let mut content_length: usize = 0;
    let mut invalid_content_length = false;
    let mut body_too_large = false;
    loop {
        let remaining = MAX_REQUEST_HEAD_BYTES.saturating_sub(head_bytes);
        let line = match read_limited_line(&mut reader, remaining) {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(LimitedReadError::Io) => return,
            Err(LimitedReadError::TooLarge) => {
                write_err(&mut stream, 431, "请求头过大");
                return;
            }
        };
        head_bytes = head_bytes.saturating_add(line.as_bytes().len());
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        let lower = trimmed.to_lowercase();
        if lower.starts_with("authorization: bearer ") {
            auth_token = trimmed[22..].trim().to_string();
        }
        if lower.starts_with("content-length:") {
            let value = trimmed[15..].trim();
            match value.parse::<u64>() {
                Ok(len) if len <= MAX_REQUEST_BODY_BYTES as u64 => content_length = len as usize,
                Ok(_) => body_too_large = true,
                Err(_) => {
                    if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit()) {
                        body_too_large = true;
                    } else {
                        invalid_content_length = true;
                    }
                }
            }
        }
    }

    if invalid_content_length {
        write_err(&mut stream, 400, "无效的 Content-Length");
        return;
    }
    if body_too_large {
        write_err(
            &mut stream,
            413,
            &format!("请求体过大（>{}MB）", MAX_REQUEST_BODY_BYTES / 1024 / 1024),
        );
        return;
    }

    // Auth check (except OPTIONS)
    if method != "OPTIONS" && auth_token != config.token {
        write_response(
            &mut stream,
            401,
            "application/json",
            br#"{"error":"Missing or invalid token"}"#,
        );
        return;
    }

    // Read body
    let mut body = Vec::new();
    if content_length > 0 {
        if body.try_reserve_exact(content_length).is_err() {
            write_err(&mut stream, 413, "请求体过大");
            return;
        }
        body.resize(content_length, 0);
        if reader.read_exact(&mut body).is_err() {
            return;
        }
    }

    // Route
    match (method.as_str(), parse_path(raw_path).as_str()) {
        ("OPTIONS", _) => {
            write_response(&mut stream, 204, "text/plain",
                &format!("Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, PUT, DELETE, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\n").into_bytes());
        }
        ("GET", p) if p == "/api/status" => handle_status(&mut stream, config),
        ("GET", p) if p.starts_with("/api/dirs/") => {
            handle_list_dir(&mut stream, config, &p["/api/dirs/".len()..])
        }
        ("GET", p) if p.starts_with("/api/files/") => {
            handle_read_file(&mut stream, config, &p["/api/files/".len()..])
        }
        ("GET", p) if p.starts_with("/api/search") => handle_search(&mut stream, config, raw_path),
        ("PUT", p) if p.starts_with("/api/files/") => {
            handle_write_file(&mut stream, config, &p["/api/files/".len()..], &body)
        }
        ("DELETE", p) if p.starts_with("/api/files/") => {
            handle_delete(&mut stream, config, &p["/api/files/".len()..])
        }
        ("POST", p) if p.starts_with("/api/dirs/") => {
            handle_create_dir(&mut stream, config, &p["/api/dirs/".len()..])
        }
        ("POST", p) if p == "/api/rename" => handle_rename(&mut stream, config, &body),
        _ => write_response(
            &mut stream,
            404,
            "application/json",
            br#"{"error":"Not Found"}"#,
        ),
    }
}

// ── Path helpers ────────────────────────────────────────────

fn parse_path(raw: &str) -> String {
    // Remove query string
    let path = raw.split('?').next().unwrap_or(raw);
    // URL decode
    url_decode(path.trim_end_matches('/'))
}

fn url_decode(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

fn safe_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim_start_matches('/').trim();
    if rel.is_empty() {
        return Some(root.to_path_buf());
    }
    let candidate = root.join(rel);
    // Canonicalize to prevent directory traversal
    let canonical = candidate.canonicalize().ok()?;
    let root_canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if canonical.starts_with(&root_canonical) {
        Some(canonical)
    } else {
        None
    }
}

fn rel_path(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| abs.to_string_lossy().replace('\\', "/"))
}

fn should_visit(path: &Path) -> bool {
    path.file_name()
        .map(|n| {
            let name = n.to_string_lossy();
            !IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(&name)) && !name.starts_with('.')
        })
        .unwrap_or(false)
}

fn is_text_file(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => !matches!(
            ext.to_lowercase().as_str(),
            "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "ico"
                | "dll"
                | "exe"
                | "zip"
                | "7z"
                | "rar"
                | "tar"
                | "gz"
                | "pdf"
                | "jar"
                | "class"
                | "dat"
                | "db"
                | "sqlite"
                | "mca"
                | "mcr"
                | "nbt"
                | "so"
                | "dylib"
                | "pyd"
                | "bin"
                | "mp3"
                | "mp4"
                | "avi"
                | "mkv"
                | "ttf"
                | "woff"
                | "woff2"
        ),
        None => true,
    }
}

// ── Handlers ────────────────────────────────────────────────

fn handle_status(stream: &mut TcpStream, config: &AgentConfig) {
    let json = format!(
        r#"{{"status":"ok","root":"{}","serverTime":{}}}"#,
        config.root.display().to_string().replace('\\', "/"),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    );
    write_ok(stream, &json);
}

fn handle_list_dir(stream: &mut TcpStream, config: &AgentConfig, rel: &str) {
    let dir = match safe_path(&config.root, rel) {
        Some(d) if d.is_dir() => d,
        Some(_) => {
            write_err(stream, 400, "不是目录");
            return;
        }
        None => {
            write_err(stream, 404, "目录不存在");
            return;
        }
    };

    let mut entries = Vec::new();
    if let Ok(iter) = fs::read_dir(&dir) {
        let mut items: Vec<_> = iter.filter_map(|e| e.ok()).collect();
        items.sort_by(|a, b| {
            let a_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
            let b_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
            b_dir.cmp(&a_dir).then_with(|| {
                a.file_name()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(&b.file_name().to_string_lossy().to_lowercase())
            })
        });
        for item in items {
            let path = item.path();
            if !should_visit(&path) {
                continue;
            }
            let ft = item.file_type().ok();
            let is_dir = ft.map(|t| t.is_dir()).unwrap_or(false);
            let meta = item.metadata().ok();
            entries.push(format!(
                r#"{{"name":"{}","path":"{}","type":"{}","extension":{},"size":{},"modified":{},"isHidden":{}}}"#,
                json_escape(&item.file_name().to_string_lossy()),
                json_escape(&rel_path(&config.root, &path)),
                if is_dir { "directory" } else { "file" },
                if is_dir { "null".to_string() } else { format!(r#""{}""#, path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default()) },
                meta.as_ref().and_then(|m| if is_dir { None } else { Some(m.len()) }).map(|s| s.to_string()).unwrap_or_else(|| "null".to_string()),
                meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| (d.as_millis() as u64).to_string()).unwrap_or_else(|| "null".to_string()),
                path.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false),
            ));
        }
    }

    let json = format!(
        r#"{{"path":"{}","entries":[{}]}}"#,
        json_escape(&rel_path(&config.root, &dir)),
        entries.join(",")
    );
    write_ok(stream, &json);
}

fn handle_read_file(stream: &mut TcpStream, config: &AgentConfig, rel: &str) {
    let file = match safe_path(&config.root, rel) {
        Some(f) if f.is_file() => f,
        Some(_) => {
            write_err(stream, 400, "不是文件");
            return;
        }
        None => {
            write_err(stream, 404, "文件不存在");
            return;
        }
    };

    let meta = match fs::metadata(&file) {
        Ok(m) => m,
        Err(_) => {
            write_err(stream, 404, "无法读取文件信息");
            return;
        }
    };
    if meta.len() > MAX_TEXT_FILE_BYTES {
        write_err(
            stream,
            413,
            &format!("文件过大（>{}MB）", MAX_TEXT_FILE_BYTES / 1024 / 1024),
        );
        return;
    }
    if !is_text_file(&file) {
        write_err(stream, 415, "不是文本文件");
        return;
    }

    match fs::read_to_string(&file) {
        Ok(content) => {
            write_response(stream, 200, "text/plain; charset=utf-8", content.as_bytes());
        }
        Err(_) => {
            // Try reading as raw bytes
            match fs::read(&file) {
                Ok(bytes) => write_response(stream, 200, "application/octet-stream", &bytes),
                Err(_) => write_err(stream, 403, "权限不足"),
            }
        }
    }
}

fn handle_write_file(stream: &mut TcpStream, config: &AgentConfig, rel: &str, body: &[u8]) {
    let file = match safe_path(&config.root, rel) {
        Some(f) => f,
        None => {
            // For new files, construct path manually
            let rel = rel.trim_start_matches('/').trim();
            if rel.is_empty() {
                write_err(stream, 400, "路径为空");
                return;
            }
            config.root.join(rel)
        }
    };

    if let Some(parent) = file.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            write_err(stream, 500, &format!("无法创建父目录: {e}"));
            return;
        }
    }

    match fs::write(&file, body) {
        Ok(_) => {
            let json = format!(
                r#"{{"ok":true,"path":"{}","bytes":{}}}"#,
                json_escape(&rel_path(&config.root, &file)),
                body.len()
            );
            write_ok(stream, &json);
        }
        Err(e) => write_err(stream, 403, &format!("写入失败: {e}")),
    }
}

fn handle_delete(stream: &mut TcpStream, config: &AgentConfig, rel: &str) {
    let target = match safe_path(&config.root, rel) {
        Some(t) => t,
        None => {
            write_err(stream, 404, "路径不存在");
            return;
        }
    };

    let result = if target.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };

    match result {
        Ok(_) => {
            let json = format!(
                r#"{{"ok":true,"deleted":"{}"}}"#,
                json_escape(&rel_path(&config.root, &target))
            );
            write_ok(stream, &json);
        }
        Err(e) => write_err(stream, 403, &format!("删除失败: {e}")),
    }
}

fn handle_create_dir(stream: &mut TcpStream, config: &AgentConfig, rel: &str) {
    let dir = match safe_path(&config.root, rel) {
        Some(d) => d,
        None => {
            let rel = rel.trim_start_matches('/').trim();
            if rel.is_empty() {
                write_err(stream, 400, "路径为空");
                return;
            }
            config.root.join(rel)
        }
    };

    match fs::create_dir_all(&dir) {
        Ok(_) => {
            let json = format!(
                r#"{{"ok":true,"created":"{}"}}"#,
                json_escape(&rel_path(&config.root, &dir))
            );
            write_ok(stream, &json);
        }
        Err(e) => write_err(stream, 403, &format!("创建失败: {e}")),
    }
}

fn handle_rename(stream: &mut TcpStream, config: &AgentConfig, body: &[u8]) {
    let data: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => {
            write_err(stream, 400, "无效的 JSON");
            return;
        }
    };
    let from_rel = data["from"].as_str().unwrap_or("");
    let to_rel = data["to"].as_str().unwrap_or("");
    if from_rel.is_empty() || to_rel.is_empty() {
        write_err(stream, 400, "缺少 from/to 参数");
        return;
    }

    let src = match safe_path(&config.root, from_rel) {
        Some(s) => s,
        None => {
            write_err(stream, 404, "源路径不存在");
            return;
        }
    };
    let dst = match safe_path(&config.root, to_rel) {
        Some(d) => d,
        None => {
            let rel = to_rel.trim_start_matches('/').trim();
            config.root.join(rel)
        }
    };

    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }

    match fs::rename(&src, &dst) {
        Ok(_) => {
            let json = format!(
                r#"{{"ok":true,"from":"{}","to":"{}"}}"#,
                json_escape(&rel_path(&config.root, &src)),
                json_escape(&rel_path(&config.root, &dst))
            );
            write_ok(stream, &json);
        }
        Err(e) => write_err(stream, 403, &format!("重命名失败: {e}")),
    }
}

fn handle_search(stream: &mut TcpStream, config: &AgentConfig, raw_path: &str) {
    // Parse ?q=... from raw_path
    let query_str = raw_path.split('?').nth(1).unwrap_or("");
    let mut query = String::new();
    for part in query_str.split('&') {
        if let Some(v) = part.strip_prefix("q=") {
            query = url_decode(v).to_lowercase();
        }
    }
    if query.is_empty() {
        write_err(stream, 400, "缺少查询参数 ?q=");
        return;
    }

    let mut files = Vec::new();
    let mut text_matches = Vec::new();
    let limit = 80;
    let root = config.root.clone();

    let _ = search_dir(&root, &root, &query, limit, &mut files, &mut text_matches);

    let json = format!(
        r#"{{"files":[{}],"textMatches":[{}]}}"#,
        files.join(","),
        text_matches.join(",")
    );
    write_ok(stream, &json);
}

// ── Walk helper ─────────────────────────────────────────────

fn search_dir(
    dir: &Path,
    root: &Path,
    query: &str,
    limit: usize,
    files: &mut Vec<String>,
    text_matches: &mut Vec<String>,
) -> Result<(), std::io::Error> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        if files.len() >= limit && text_matches.len() >= limit {
            return Ok(());
        }
        let entry = entry?;
        let path = entry.path();
        if !should_visit(&path) {
            continue;
        }
        if path.is_dir() {
            search_dir(&path, root, query, limit, files, text_matches)?;
        } else {
            search_file(&path, root, query, limit, files, text_matches);
        }
    }
    Ok(())
}

fn search_file(
    path: &Path,
    root: &Path,
    query: &str,
    limit: usize,
    files: &mut Vec<String>,
    text_matches: &mut Vec<String>,
) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let rel = rel_path(root, path);

    if name.to_lowercase().contains(query) && files.len() < limit {
        files.push(format!(
            r#"{{"path":"{}","relativePath":"{}","name":"{}"}}"#,
            json_escape(&path.to_string_lossy().replace('\\', "/")),
            json_escape(&rel),
            json_escape(&name)
        ));
    }

    if text_matches.len() < limit && is_text_file(path) {
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() <= MAX_TEXT_FILE_BYTES {
                if let Ok(content) = fs::read_to_string(path) {
                    for (i, line) in content.lines().enumerate() {
                        if text_matches.len() >= limit {
                            break;
                        }
                        if let Some(col) = line.to_lowercase().find(query) {
                            let preview = line.trim();
                            let preview = if preview.len() > 200 {
                                &preview[..200]
                            } else {
                                preview
                            };
                            text_matches.push(format!(
                                r#"{{"path":"{}","relativePath":"{}","lineNumber":{},"column":{},"preview":"{}"}}"#,
                                json_escape(&path.to_string_lossy().replace('\\', "/")),
                                json_escape(&rel),
                                i + 1,
                                col + 1,
                                json_escape(preview)
                            ));
                        }
                    }
                }
            }
        }
    }
}

// ── HTTP helpers ────────────────────────────────────────────

fn write_ok(stream: &mut TcpStream, json: &str) {
    write_response(
        stream,
        200,
        "application/json; charset=utf-8",
        json.as_bytes(),
    );
}

fn write_err(stream: &mut TcpStream, status: u16, msg: &str) {
    let json = format!(r#"{{"error":"{}"}}"#, json_escape(msg));
    write_response(
        stream,
        status,
        "application/json; charset=utf-8",
        json.as_bytes(),
    );
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let status_text = match status {
        200 => "OK",
        201 => "Created",
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
        "HTTP/1.1 {status} {status_text}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read, Write};
    use std::net::Shutdown;

    fn agent_server_response(root: &Path, request: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let config = AgentConfig {
            port: addr.port(),
            token: "secret".to_string(),
            root: root.to_path_buf(),
            bind: "127.0.0.1".to_string(),
        };
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            handle_connection(stream, &config);
        });

        let mut client = TcpStream::connect(addr).unwrap();
        client.write_all(request.as_bytes()).unwrap();
        let _ = client.shutdown(Shutdown::Write);
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        handle.join().unwrap();
        response
    }

    #[test]
    fn agent_server_rejects_oversized_header_block() {
        let temp = tempfile::tempdir().unwrap();
        let request = format!(
            "GET /api/status HTTP/1.1\r\nX-Fill: {}\r\n\r\n",
            "a".repeat(MAX_REQUEST_HEAD_BYTES)
        );

        let response = agent_server_response(temp.path(), &request);

        assert!(response.starts_with("HTTP/1.1 431"));
        assert!(response.contains(r#""error":"请求头过大""#));
    }

    #[test]
    fn agent_server_rejects_body_larger_than_limit() {
        let temp = tempfile::tempdir().unwrap();
        let request = format!(
            "PUT /api/files/test.txt HTTP/1.1\r\nAuthorization: Bearer secret\r\nContent-Length: {}\r\n\r\n",
            MAX_REQUEST_BODY_BYTES + 1
        );

        let response = agent_server_response(temp.path(), &request);

        assert!(response.starts_with("HTTP/1.1 413"));
        assert!(response.contains(r#""error":"请求体过大"#));
    }

    #[test]
    fn agent_server_limited_line_rejects_over_limit() {
        let data = "x".repeat(32);
        let mut reader = BufReader::new(Cursor::new(data));

        let result = read_limited_line(&mut reader, 16);

        assert_eq!(result, Err(LimitedReadError::TooLarge));
    }

    #[test]
    fn agent_server_search_caps_results_while_walking() {
        let temp = tempfile::tempdir().unwrap();
        for i in 0..100 {
            std::fs::write(temp.path().join(format!("needle-{i}.txt")), "needle\n").unwrap();
        }

        let mut files = Vec::new();
        let mut text_matches = Vec::new();
        search_dir(
            temp.path(),
            temp.path(),
            "needle",
            80,
            &mut files,
            &mut text_matches,
        )
        .unwrap();

        assert_eq!(files.len(), 80);
        assert_eq!(text_matches.len(), 80);
    }
}
