use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use regex::Regex;

use crate::{fs_ops::normalize_path, models::VitePressDocsInfo, process_tree::kill_std_child_tree};

const PORT_START: u16 = 5173;
const PORT_END: u16 = 5199;
const HOST: &str = "127.0.0.1";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(25);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct VitePressManager {
    servers: Mutex<HashMap<String, ManagedVitePressServer>>,
}

pub type SharedVitePressManager = Arc<VitePressManager>;

struct ManagedVitePressServer {
    child: Child,
    project_path: PathBuf,
    docs_root: PathBuf,
    port: u16,
}

impl VitePressManager {
    pub fn detect(&self, project_path: &Path) -> Result<VitePressDocsInfo> {
        let project_path = normalize_project_path(project_path)?;
        let docs_root =
            find_docs_root(&project_path).ok_or_else(|| anyhow!("未找到 VitePress 文档目录"))?;
        let key = docs_key(&docs_root);
        if let Some(info) = self.managed_info_if_running(&key) {
            return Ok(info);
        }

        let detected_port = detect_running_port(&docs_root, None);
        let port = detected_port
            .or_else(|| infer_configured_ports(&docs_root).into_iter().next())
            .unwrap_or(PORT_START);
        Ok(VitePressDocsInfo {
            project_path: normalize_path(&project_path),
            docs_root: normalize_path(&docs_root),
            url: detected_port.map(url_for_port).unwrap_or_default(),
            port,
            running: detected_port.is_some(),
            started_by_super_high: false,
        })
    }

    pub fn ensure(&self, project_path: &Path) -> Result<VitePressDocsInfo> {
        let project_path = normalize_project_path(project_path)?;
        let docs_root =
            find_docs_root(&project_path).ok_or_else(|| anyhow!("未找到 VitePress 文档目录"))?;
        let key = docs_key(&docs_root);

        if let Some(info) = self.managed_info_if_running(&key) {
            return Ok(info);
        }

        if let Some(port) = detect_running_port(&docs_root, None) {
            return Ok(VitePressDocsInfo {
                project_path: normalize_path(&project_path),
                docs_root: normalize_path(&docs_root),
                url: url_for_port(port),
                port,
                running: true,
                started_by_super_high: false,
            });
        }

        let port = pick_start_port(&docs_root)?;
        let log_path = log_path_for_docs_root(&docs_root);
        let log = open_log_file(&log_path)?;
        let log_err = log
            .try_clone()
            .context("failed to clone VitePress log handle")?;

        let (npm_cwd, npm_args) = resolve_npm_run(&docs_root);

        let mut command = Command::new(npm_command());
        command
            .current_dir(&npm_cwd)
            .args(&npm_args)
            .arg("--")
            .arg("--host")
            .arg(HOST)
            .arg("--port")
            .arg(port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("无法启动 VitePress：{}", normalize_path(&docs_root)))?;

        if matches!(
            wait_for_startup(&mut child, port),
            StartupWaitResult::Started
        ) {
            let mut servers = self
                .servers
                .lock()
                .map_err(|_| anyhow!("VitePress 进程状态锁已损坏"))?;
            servers.insert(
                key.clone(),
                ManagedVitePressServer {
                    child,
                    project_path: project_path.clone(),
                    docs_root: docs_root.clone(),
                    port,
                },
            );

            return Ok(VitePressDocsInfo {
                project_path: normalize_path(&project_path),
                docs_root: normalize_path(&docs_root),
                url: url_for_port(port),
                port,
                running: true,
                started_by_super_high: true,
            });
        }

        if !matches!(child.try_wait(), Ok(Some(_))) {
            kill_std_child_tree(&mut child);
        }
        let _ = child.wait();
        let details = read_log_tail(&log_path)
            .ok()
            .filter(|tail| !tail.trim().is_empty())
            .unwrap_or_else(|| format!("{}:{} 在等待时间内没有响应", HOST, port));
        Err(anyhow!("VitePress 启动失败：{}", details.trim()))
    }

    #[allow(dead_code)]
    pub fn stop(&self, project_path: &Path) -> Result<VitePressDocsInfo> {
        let project_path = normalize_project_path(project_path)?;
        let docs_root =
            find_docs_root(&project_path).ok_or_else(|| anyhow!("未找到 VitePress 文档目录"))?;
        let key = docs_key(&docs_root);
        let stopped = self.stop_managed_server(&key)?;
        let port = stopped
            .as_ref()
            .map(|server| server.port)
            .or_else(|| infer_configured_ports(&docs_root).into_iter().next())
            .unwrap_or(PORT_START);

        Ok(VitePressDocsInfo {
            project_path: normalize_path(&project_path),
            docs_root: normalize_path(&docs_root),
            url: String::new(),
            port,
            running: false,
            started_by_super_high: stopped.is_some(),
        })
    }

    pub fn stop_all(&self) -> Result<()> {
        let servers_to_stop = {
            let mut servers = self
                .servers
                .lock()
                .map_err(|_| anyhow!("VitePress 进程状态锁已损坏"))?;
            servers
                .drain()
                .map(|(_, server)| server)
                .collect::<Vec<_>>()
        };

        for mut server in servers_to_stop {
            if !matches!(server.child.try_wait(), Ok(Some(_))) {
                kill_std_child_tree(&mut server.child);
            }
            let _ = server.child.wait();
        }

        Ok(())
    }

    fn managed_info_if_running(&self, key: &str) -> Option<VitePressDocsInfo> {
        let mut servers = self.servers.lock().ok()?;
        let server = servers.get_mut(key)?;
        if matches!(server.child.try_wait(), Ok(Some(_)) | Err(_)) {
            if let Some(mut server) = servers.remove(key) {
                let _ = server.child.wait();
            }
            return None;
        }
        if !is_http_port_live(server.port) {
            if let Some(mut server) = servers.remove(key) {
                kill_std_child_tree(&mut server.child);
                let _ = server.child.wait();
            }
            return None;
        }
        Some(VitePressDocsInfo {
            project_path: normalize_path(&server.project_path),
            docs_root: normalize_path(&server.docs_root),
            url: url_for_port(server.port),
            port: server.port,
            running: true,
            started_by_super_high: true,
        })
    }

    fn stop_managed_server(&self, key: &str) -> Result<Option<ManagedVitePressServer>> {
        let mut servers = self
            .servers
            .lock()
            .map_err(|_| anyhow!("VitePress 进程状态锁已损坏"))?;
        let Some(mut server) = servers.remove(key) else {
            return Ok(None);
        };
        if !matches!(server.child.try_wait(), Ok(Some(_))) {
            kill_std_child_tree(&mut server.child);
        }
        let _ = server.child.wait();
        Ok(Some(server))
    }
}

impl Drop for VitePressManager {
    fn drop(&mut self) {
        if let Ok(mut servers) = self.servers.lock() {
            for server in servers.values_mut() {
                kill_std_child_tree(&mut server.child);
                let _ = server.child.wait();
            }
            servers.clear();
        }
    }
}

fn normalize_project_path(project_path: &Path) -> Result<PathBuf> {
    if !project_path.exists() {
        return Err(anyhow!(
            "项目路径不存在：{}",
            normalize_path(&project_path.to_path_buf())
        ));
    }
    Ok(project_path
        .canonicalize()
        .unwrap_or_else(|_| project_path.to_path_buf()))
}

fn find_docs_root(project_path: &Path) -> Option<PathBuf> {
    let ordered_candidates = [
        project_path.join("plugins").join("vitepress-docs"),
        project_path.join("vitepress-docs"),
        project_path.join("plugins").join("docs"),
        project_path.join("docs"),
    ];

    // Last candidate ("docs") without a vitepress marker is too generic — require
    // an explicit .vitepress config so we don't latch onto a random docs folder.
    let strict_cut = ordered_candidates.len() - 1;

    for (index, candidate) in ordered_candidates.iter().enumerate() {
        if !candidate.is_dir() {
            continue;
        }
        if index >= strict_cut {
            if has_vitepress_config(candidate) {
                return Some(normalize_existing_path(candidate));
            }
            continue;
        }
        if has_vitepress_config(candidate)
            || candidate.join("package.json").is_file()
            || package_json_mentions_vitepress(candidate)
        {
            return Some(normalize_existing_path(candidate));
        }
    }

    None
}

fn normalize_existing_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn has_vitepress_config(docs_root: &Path) -> bool {
    let config_dir = docs_root.join(".vitepress");
    [
        "config.ts",
        "config.mts",
        "config.js",
        "config.mjs",
        "config.cjs",
        "config.cts",
    ]
    .iter()
    .any(|name| config_dir.join(name).is_file())
}

fn package_json_mentions_vitepress(docs_root: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(docs_root.join("package.json")) else {
        return false;
    };
    raw.to_lowercase().contains("vitepress")
}

fn detect_running_port(docs_root: &Path, preferred_port: Option<u16>) -> Option<u16> {
    let ports = ordered_ports(docs_root, preferred_port);
    ports.into_iter().find(|port| is_vitepress_port_live(*port))
}

fn pick_start_port(docs_root: &Path) -> Result<u16> {
    if let Some(port) = infer_configured_ports(docs_root).into_iter().next() {
        if is_tcp_port_open(port) {
            return Err(anyhow!(
                "VitePress 配置端口 {} 已被占用，且未检测到可复用的 HTTP 预览服务",
                port
            ));
        }
        return Ok(port);
    }

    let ports = ordered_ports(docs_root, None);
    ports
        .into_iter()
        .find(|port| !is_tcp_port_open(*port))
        .ok_or_else(|| anyhow!("没有可用端口：{}-{}", PORT_START, PORT_END))
}

fn ordered_ports(docs_root: &Path, preferred_port: Option<u16>) -> Vec<u16> {
    let mut ports = Vec::new();
    let mut seen = HashSet::new();

    if let Some(port) = preferred_port {
        push_port(&mut ports, &mut seen, port);
    }
    for port in infer_configured_ports(docs_root) {
        push_port(&mut ports, &mut seen, port);
    }
    for port in PORT_START..=PORT_END {
        push_port(&mut ports, &mut seen, port);
    }
    ports
}

fn push_port(ports: &mut Vec<u16>, seen: &mut HashSet<u16>, port: u16) {
    if (1..=u16::MAX).contains(&port) && seen.insert(port) {
        ports.push(port);
    }
}

fn infer_configured_ports(docs_root: &Path) -> Vec<u16> {
    let mut ports = Vec::new();
    let mut seen = HashSet::new();
    for source in port_hint_sources(docs_root) {
        for port in extract_ports(&source) {
            push_port(&mut ports, &mut seen, port);
        }
    }
    ports
}

fn port_hint_sources(docs_root: &Path) -> Vec<String> {
    let mut sources = Vec::new();
    // Read package.json from docs_root and (when different) its parent.
    if let Ok(raw) = fs::read_to_string(docs_root.join("package.json")) {
        sources.push(package_script_text(&raw));
    }
    if let Some(parent) = docs_root.parent() {
        if parent != docs_root {
            if let Ok(raw) = fs::read_to_string(parent.join("package.json")) {
                sources.push(package_script_text(&raw));
            }
        }
    }
    for config_dir in [docs_root.join(".vitepress"), docs_root.join("docs").join(".vitepress")] {
        for name in [
            "config.ts",
            "config.mts",
            "config.js",
            "config.mjs",
            "config.cjs",
            "config.cts",
        ] {
            if let Ok(raw) = fs::read_to_string(config_dir.join(name)) {
                sources.push(raw);
            }
        }
    }
    sources
}

fn package_script_text(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    let Some(scripts) = value.get("scripts").and_then(|value| value.as_object()) else {
        return raw.to_string();
    };
    scripts
        .values()
        .filter_map(|value| value.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_ports(source: &str) -> Vec<u16> {
    let pattern = Regex::new(
        r#"(?ix)
        (?:--port(?:=|\s+)|\bport\s*[:=]\s*|127\.0\.0\.1:|localhost:)
        (?P<port>\d{2,5})
        "#,
    )
    .expect("valid port regex");
    pattern
        .captures_iter(source)
        .filter_map(|captures| captures.name("port")?.as_str().parse::<u16>().ok())
        .filter(|port| *port > 0)
        .collect()
}

fn is_tcp_port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(80)).is_ok()
}

fn is_http_port_live(port: u16) -> bool {
    http_probe(port)
        .map(|response| is_http_ok_response(&response) || has_vitepress_signature(&response))
        .unwrap_or(false)
}

fn is_vitepress_port_live(port: u16) -> bool {
    http_probe(port)
        .map(|response| has_vitepress_signature(&response))
        .unwrap_or(false)
}

fn is_http_ok_response(response: &str) -> bool {
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn has_vitepress_signature(response: &str) -> bool {
    response.contains("/@vite/client")
        || response.contains("__VP_")
        || response.contains("vitepress/dist/client")
        || response.contains(r#"name="generator" content="VitePress"#)
        || response.contains(r#"name='generator' content='VitePress"#)
}

fn http_probe(port: u16) -> Option<String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(120)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(120)));
    stream
        .write_all(b"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes);
    if bytes.is_empty() {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).to_string())
}

#[derive(Debug, Eq, PartialEq)]
enum StartupWaitResult {
    Started,
    ChildExited,
    TimedOut,
}

fn wait_for_startup(child: &mut Child, port: u16) -> StartupWaitResult {
    let started = std::time::Instant::now();
    while started.elapsed() < STARTUP_TIMEOUT {
        if is_http_port_live(port) {
            return StartupWaitResult::Started;
        }
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return StartupWaitResult::ChildExited;
        }
        thread::sleep(STARTUP_POLL_INTERVAL);
    }
    StartupWaitResult::TimedOut
}

fn url_for_port(port: u16) -> String {
    format!("http://{}:{}/", HOST, port)
}

fn docs_key(docs_root: &Path) -> String {
    normalize_path(&normalize_existing_path(docs_root)).to_lowercase()
}

fn log_path_for_docs_root(docs_root: &Path) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let name = normalize_path(&normalize_existing_path(docs_root))
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() {
                char
            } else {
                '-'
            }
        })
        .collect::<String>();
    std::env::temp_dir().join(format!("super-high-vitepress-{}-{}.log", name, millis))
}

fn open_log_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| {
            format!(
                "无法写入 VitePress 日志：{}",
                normalize_path(&path.to_path_buf())
            )
        })
}

fn read_log_tail(path: &Path) -> Result<String> {
    let raw = fs::read_to_string(path)?;
    let max_chars = 1200;
    let char_count = raw.chars().count();
    if char_count <= max_chars {
        return Ok(raw);
    }
    Ok(raw.chars().skip(char_count - max_chars).collect())
}

fn package_json_script_to_run(package_json: &Path) -> Option<&'static str> {
    let raw = fs::read_to_string(package_json).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let scripts = value.get("scripts")?.as_object()?;
    if scripts.contains_key("dev") {
        return Some("dev");
    }
    if scripts.contains_key("docs:dev") {
        return Some("docs:dev");
    }
    None
}

/// Determine the npm working directory and arguments to start VitePress dev.
///
/// Normally the `.vitepress/` config and `package.json` live in the same
/// directory. But some projects (e.g. `plugins/docs/.vitepress/` with
/// `plugins/package.json`) keep the npm project one level above the docs root.
/// In that case we run `npm exec vitepress dev <docs_dir>` from the parent.
fn resolve_npm_run(docs_root: &Path) -> (PathBuf, Vec<String>) {
    // Case 1: docs_root has its own package.json — classic VitePress project.
    let package_json = docs_root.join("package.json");
    if package_json.is_file() {
        let script = package_json_script_to_run(&package_json).unwrap_or("dev");
        return (docs_root.to_path_buf(), vec!["run".into(), script.into()]);
    }
    // Case 2: parent has a package.json that mentions vitepress.
    if let Some(parent) = docs_root.parent() {
        if parent.join("package.json").is_file() && package_json_mentions_vitepress(parent) {
            let docs_rel = docs_root
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(".")
                .to_string();
            // npm exec runs the vitepress binary from parent's node_modules,
            // dev is the subcommand, and docs_rel tells vitepress where its
            // .vitepress config lives.
            return (
                parent.to_path_buf(),
                vec!["exec".into(), "vitepress".into(), "dev".into(), docs_rel],
            );
        }
    }
    // Fallback: just try the original behaviour; npm will report the error.
    (docs_root.to_path_buf(), vec!["run".into(), "dev".into()])
}

#[cfg(windows)]
fn npm_command() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn npm_command() -> &'static str {
    "npm"
}

#[cfg(test)]
mod tests {
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use super::{
        docs_key, extract_ports, find_docs_root, has_vitepress_signature, infer_configured_ports,
        is_http_port_live, resolve_npm_run, wait_for_startup, ManagedVitePressServer, StartupWaitResult,
        VitePressManager,
    };

    #[test]
    fn extracts_ports_from_scripts_and_config() {
        let source = r#"
          vitepress dev docs --host 127.0.0.1 --port 5188
          export default { vite: { server: { port: 5190 } } }
          http://localhost:5195/
        "#;

        assert_eq!(extract_ports(source), vec![5188, 5190, 5195]);
    }

    #[test]
    fn infers_port_from_nested_docs_vitepress_config() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("docs").join(".vitepress").join("config.ts");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            config,
            "export default { vite: { server: { port: 5175, strictPort: true } } }",
        )
        .unwrap();

        assert_eq!(infer_configured_ports(temp.path()), vec![5175]);
    }

    #[test]
    fn finds_docs_root_in_fixed_order() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path();
        let plugin = project.join("plugins").join("vitepress-docs");
        let docs = project.join("docs").join(".vitepress");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(
            plugin.join("package.json"),
            r#"{"dependencies":{"vitepress":"latest"}}"#,
        )
        .unwrap();
        std::fs::write(docs.join("config.ts"), "export default {}").unwrap();

        assert_eq!(
            find_docs_root(project).unwrap(),
            plugin.canonicalize().unwrap()
        );
    }

    #[test]
    fn resolves_docs_dev_script_when_docs_root_has_no_dev_script() {
        let temp = tempfile::tempdir().unwrap();
        let docs_root = temp.path().join("docs");
        std::fs::create_dir_all(&docs_root).unwrap();
        std::fs::write(
            docs_root.join("package.json"),
            r#"{"scripts":{"docs:dev":"vitepress dev"}}"#,
        )
        .unwrap();

        let (cwd, args) = resolve_npm_run(&docs_root);

        assert_eq!(cwd, docs_root);
        assert_eq!(args, vec!["run".to_string(), "docs:dev".to_string()]);
    }

    #[test]
    fn resolves_dev_script_before_docs_dev_script() {
        let temp = tempfile::tempdir().unwrap();
        let docs_root = temp.path().join("docs");
        std::fs::create_dir_all(&docs_root).unwrap();
        std::fs::write(
            docs_root.join("package.json"),
            r#"{"scripts":{"docs:dev":"vitepress dev docs","dev":"vitepress dev"}}"#,
        )
        .unwrap();

        let (cwd, args) = resolve_npm_run(&docs_root);

        assert_eq!(cwd, docs_root);
        assert_eq!(args, vec!["run".to_string(), "dev".to_string()]);
    }

    #[test]
    fn resolves_parent_vitepress_exec_when_docs_root_has_no_package_json() {
        let temp = tempfile::tempdir().unwrap();
        let parent = temp.path().join("project");
        let docs_root = parent.join("docs");
        std::fs::create_dir_all(&docs_root).unwrap();
        std::fs::write(
            parent.join("package.json"),
            r#"{"devDependencies":{"vitepress":"latest"}}"#,
        )
        .unwrap();

        let (cwd, args) = resolve_npm_run(&docs_root);

        assert_eq!(cwd, parent);
        assert_eq!(
            args,
            vec![
                "exec".to_string(),
                "vitepress".to_string(),
                "dev".to_string(),
                "docs".to_string()
            ]
        );
    }

    #[test]
    fn startup_wait_returns_when_child_exits_early() {
        let mut child = immediate_exit_child();
        let started = std::time::Instant::now();

        let result = wait_for_startup(&mut child, 1);

        assert_eq!(result, StartupWaitResult::ChildExited);
        assert!(started.elapsed() < Duration::from_secs(5));
        let _ = child.wait();
    }

    #[test]
    fn ordinary_http_ok_response_is_not_vitepress() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>plain app</html>";

        assert!(!has_vitepress_signature(response));
    }

    #[test]
    fn vitepress_response_markers_are_detected() {
        let response = r#"HTTP/1.1 200 OK
        <script type="module" src="/@vite/client"></script>
        <script>window.__VP_HASH_MAP__ = JSON.parse("{}")</script>"#;

        assert!(has_vitepress_signature(response));
    }

    #[cfg(windows)]
    #[test]
    fn inactive_managed_port_cleans_server_map() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let docs_root = project.join("docs");
        std::fs::create_dir_all(&docs_root).unwrap();
        let key = docs_key(&docs_root);
        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let manager = VitePressManager::default();

        manager.servers.lock().unwrap().insert(
            key.clone(),
            ManagedVitePressServer {
                child,
                project_path: project,
                docs_root,
                port: 1,
            },
        );

        assert!(!is_http_port_live(1));
        assert!(manager.managed_info_if_running(&key).is_none());
        assert!(manager.servers.lock().unwrap().is_empty());
    }

    #[cfg(windows)]
    fn immediate_exit_child() -> std::process::Child {
        Command::new("cmd.exe")
            .args(["/C", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[cfg(not(windows))]
    fn immediate_exit_child() -> std::process::Child {
        Command::new("sh")
            .args(["-c", "exit 7"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }
}
