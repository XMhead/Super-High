use std::{
    collections::HashMap,
    convert::Infallible,
    io,
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime},
};

use futures_util::StreamExt;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{
    body::{Bytes, Frame, Incoming},
    header::{self, HeaderValue},
    server::conn::http1,
    service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use percent_encoding::percent_decode_str;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

const PREVIEW_PORT: u16 = 43895;
const BRIDGE_PATH: &str = "/.superhigh-html-preview/bridge.js";
const REVISION_PATH: &str = "/.superhigh-html-preview/revision";
const BRIDGE: &str = include_str!("../../public/html-preview-site.js");
const LONG_PRESS: &str = include_str!("../../src/lib/htmlPreviewLongPressBridge.js");
const FRAME_ANCESTORS: &str =
    "frame-ancestors 'self' http://tauri.localhost https://tauri.localhost tauri: http://localhost:1420 http://127.0.0.1:1420";

type Body = UnsyncBoxBody<Bytes, io::Error>;
type FileStamp = Option<(SystemTime, u64)>;

#[derive(Default)]
pub struct HtmlPreviews(Mutex<Option<Server>>);

struct Server {
    port: u16,
    sites: Arc<Mutex<HashMap<String, Arc<Site>>>>,
}

struct Site {
    root: PathBuf,
    authority: String,
    drafts: Mutex<HashMap<String, (PathBuf, String)>>,
    changes: Mutex<Changes>,
}

#[derive(Default)]
struct Changes {
    watched: HashMap<PathBuf, FileStamp>,
    checked: Option<Instant>,
    revision: u64,
}

#[tauri::command]
pub async fn open_html_preview(
    previews: tauri::State<'_, HtmlPreviews>,
    workspace_root: String,
    path: String,
    owner: String,
    draft: Option<String>,
) -> Result<String, String> {
    previews
        .open(&workspace_root, Path::new(&path), owner, draft)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn close_html_preview_draft(
    previews: tauri::State<'_, HtmlPreviews>,
    url: String,
    owner: String,
) {
    let Ok(url) = tauri::Url::parse(&url) else {
        return;
    };
    let (Some(host), Some(port)) = (url.host_str(), url.port()) else {
        return;
    };
    let server = previews.0.lock().unwrap();
    if let Some(server) = server.as_ref() {
        if let Some(site) = server.sites.lock().unwrap().get(&format!("{host}:{port}")) {
            if site.drafts.lock().unwrap().remove(&owner).is_some() {
                site.changes.lock().unwrap().revision += 1;
            }
        }
    }
}

impl HtmlPreviews {
    fn open(
        &self,
        workspace_root: &str,
        path: &Path,
        owner: String,
        draft: Option<String>,
    ) -> io::Result<String> {
        let path = path.canonicalize()?;
        if !path.is_file() || !is_html(&path) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "请选择 HTML 文件。",
            ));
        }
        let root = Path::new(workspace_root)
            .canonicalize()
            .ok()
            .filter(|root| !workspace_root.is_empty() && path.starts_with(root))
            .unwrap_or_else(|| path.parent().expect("absolute file path").to_path_buf());
        let relative = path
            .strip_prefix(&root)
            .expect("preview path is within root");
        let root_key = root.to_string_lossy();
        #[cfg(windows)]
        let root_key = root_key.to_lowercase();
        let hash = format!("{:x}", Sha256::digest(root_key.as_bytes()));

        let mut state = self.0.lock().unwrap();
        if state.is_none() {
            *state = Some(Server::start()?);
        }
        let server = state.as_ref().expect("preview server was started");
        let authority = format!("superhigh-{}.localhost:{}", &hash[..24], server.port);
        let site = server
            .sites
            .lock()
            .unwrap()
            .entry(authority.clone())
            .or_insert_with(|| {
                Arc::new(Site {
                    root: root.clone(),
                    authority: authority.clone(),
                    drafts: Mutex::default(),
                    changes: Mutex::default(),
                })
            })
            .clone();

        let mut drafts = site.drafts.lock().unwrap();
        let changed = if let Some(draft) = draft {
            let updated = !drafts.get(&owner).is_some_and(|(previous_path, previous)| {
                *previous_path == path && *previous == draft
            });
            drafts.insert(owner, (path.clone(), draft));
            updated
        } else {
            drafts.remove(&owner).is_some()
        };
        if changed {
            site.changes.lock().unwrap().revision += 1;
        }
        let mut url =
            tauri::Url::parse(&format!("http://{authority}/")).expect("valid preview origin");
        {
            let mut segments = url.path_segments_mut().expect("preview URL has a path");
            for part in relative.iter() {
                segments.push(&part.to_string_lossy());
            }
        }
        Ok(url.into())
    }
}

impl Server {
    fn start() -> io::Result<Self> {
        let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, PREVIEW_PORT)) {
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
                TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?
            }
            result => result?,
        };
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let listener = tokio::net::TcpListener::from_std(listener)?;
        let sites = Arc::new(Mutex::new(HashMap::<String, Arc<Site>>::new()));
        let registered = sites.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let sites = registered.clone();
                tokio::spawn(async move {
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(5))
                        .serve_connection(
                            TokioIo::new(stream),
                            service_fn(move |request: Request<Incoming>| {
                                let site = request
                                    .headers()
                                    .get(header::HOST)
                                    .and_then(|host| host.to_str().ok())
                                    .and_then(|host| sites.lock().unwrap().get(host).cloned());
                                async move {
                                    let response = match site {
                                        Some(site) => site.respond(request).await,
                                        None => {
                                            plain(StatusCode::NOT_FOUND, "Preview site unavailable")
                                        }
                                    };
                                    Ok::<_, Infallible>(response)
                                }
                            }),
                        )
                        .await;
                });
            }
        });
        Ok(Self { port, sites })
    }
}

impl Site {
    async fn respond(self: Arc<Self>, request: Request<Incoming>) -> Response<Body> {
        let head = request.method() == Method::HEAD;
        let path = request.uri().path();
        let is_document = request
            .headers()
            .get("Sec-Fetch-Mode")
            .is_some_and(|value| value == "navigate");
        // A static target can receive a native POST form navigation and return its page.
        if !matches!(*request.method(), Method::GET | Method::HEAD | Method::POST) {
            return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        }
        if path == BRIDGE_PATH {
            return bytes(StatusCode::OK, "text/javascript; charset=utf-8", format!("{BRIDGE}\nif (window.parent !== window && window.parent === window.top) {{ {LONG_PRESS} }}"), head);
        }
        if path == REVISION_PATH {
            let site = self.clone();
            let revision = tokio::task::spawn_blocking(move || site.revision())
                .await
                .unwrap_or_default();
            return bytes(
                StatusCode::OK,
                "text/plain; charset=utf-8",
                revision.to_string(),
                head,
            );
        }
        let Some(relative) = relative_path(path) else {
            return plain(StatusCode::NOT_FOUND, "File not found");
        };
        let mut target = self.root.join(relative);
        let (mut file, mut open) = contained_file(&self.root, target.clone()).await;
        if open.is_none()
            && tokio::fs::metadata(&file)
                .await
                .is_ok_and(|meta| meta.is_dir())
        {
            if !path.ends_with('/') {
                let location = format!(
                    "{path}/{}",
                    request
                        .uri()
                        .query()
                        .map(|query| format!("?{query}"))
                        .unwrap_or_default()
                );
                return response(StatusCode::PERMANENT_REDIRECT)
                    .header(header::LOCATION, location)
                    .body(empty())
                    .unwrap();
            }
            target = file.join("index.html");
            (file, open) = contained_file(&self.root, target.clone()).await;
        }
        let metadata = match open.as_ref() {
            Some(open) => open.metadata().await.ok(),
            None => None,
        };
        self.changes
            .lock()
            .unwrap()
            .watched
            .entry(target)
            .or_insert_with(|| stamp(metadata));
        let Some(open) = open else {
            if is_document {
                return self.html(
                    StatusCode::NOT_FOUND,
                    "<!doctype html><title>文件不存在</title><h1>文件不存在</h1>",
                    head,
                );
            }
            return plain(StatusCode::NOT_FOUND, "File not found");
        };

        if is_html(&file) {
            let draft = self
                .drafts
                .lock()
                .unwrap()
                .values()
                .find(|(path, _)| *path == file)
                .map(|(_, document)| document.clone());
            let document = match draft {
                Some(draft) => Ok(draft),
                None => tokio::task::spawn_blocking(move || {
                    crate::fs_ops::read_text_file_with_encoding(&file, None)
                        .map(|text| text.content)
                })
                .await
                .unwrap_or_else(|err| Err(err.into())),
            };
            return match document {
                Ok(document) if is_document => self.html(StatusCode::OK, &document, head),
                Ok(document) => bytes(StatusCode::OK, "text/html; charset=utf-8", document, head),
                Err(_) => self.html(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "<!doctype html><title>无法读取 HTML</title><h1>无法读取 HTML</h1>",
                    head,
                ),
            };
        }
        serve_file(&file, open, head, request.headers().get(header::RANGE)).await
    }

    fn html(&self, status: StatusCode, source: &str, head: bool) -> Response<Body> {
        // Append an external helper so the original doctype and parser-inserted scripts
        // keep their order. An absolute URL also preserves custom <base> behavior.
        let revision = self.changes.lock().unwrap().revision;
        let html = format!(
            "{source}\n<script defer src=\"http://{}{BRIDGE_PATH}?revision={revision}\"></script>",
            self.authority
        );
        bytes(status, "text/html; charset=utf-8", html, head)
    }

    fn revision(&self) -> u64 {
        let mut changes = self.changes.lock().unwrap();
        if changes
            .checked
            .is_some_and(|checked| checked.elapsed() < Duration::from_millis(700))
        {
            return changes.revision;
        }
        changes.checked = Some(Instant::now());
        let mut changed = false;
        for (path, previous) in &mut changes.watched {
            let current = stamp(std::fs::metadata(path).ok());
            changed |= current != *previous;
            *previous = current;
        }
        changes.revision += u64::from(changed);
        changes.revision
    }
}

fn relative_path(url_path: &str) -> Option<PathBuf> {
    let mut relative = PathBuf::new();
    for part in url_path
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
    {
        let part = percent_decode_str(part).decode_utf8().ok()?;
        if part == "."
            || part == ".."
            || part.eq_ignore_ascii_case(".git")
            || part.ends_with(['.', ' '])
            || part.chars().any(|ch| {
                ch.is_control()
                    || matches!(ch, '/' | '\\' | ':' | '"' | '*' | '<' | '>' | '?' | '|')
            })
        {
            return None;
        }
        relative.push(part.as_ref());
    }
    Some(relative)
}

async fn contained_file(root: &Path, path: PathBuf) -> (PathBuf, Option<tokio::fs::File>) {
    if let Ok(canonical) = tokio::fs::canonicalize(&path).await {
        if canonical.starts_with(root)
            && tokio::fs::metadata(&canonical)
                .await
                .is_ok_and(|meta| meta.is_file())
        {
            let file = tokio::fs::File::open(&canonical).await.ok();
            return (canonical, file);
        }
    }
    (path, None)
}

fn stamp(meta: Option<std::fs::Metadata>) -> FileStamp {
    let meta = meta.filter(|meta| meta.is_file())?;
    Some((meta.modified().ok()?, meta.len()))
}

fn is_html(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
}

fn content_type(path: &Path) -> &'static str {
    if let Some(mime) = crate::fs_ops::media_mime_type(path) {
        return mime;
    }
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "json" | "map" | "webmanifest" => "application/json",
        "xml" => "application/xml",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "pdf" => "application/pdf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn empty() -> Body {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn response(status: StatusCode) -> hyper::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_SECURITY_POLICY, FRAME_ANCESTORS)
}

fn bytes(status: StatusCode, mime: &str, data: impl Into<Bytes>, head: bool) -> Response<Body> {
    let data = data.into();
    response(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, data.len())
        .body(if head {
            empty()
        } else {
            Full::new(data)
                .map_err(|never| match never {})
                .boxed_unsync()
        })
        .unwrap()
}

fn plain(status: StatusCode, message: &'static str) -> Response<Body> {
    bytes(status, "text/plain; charset=utf-8", message, false)
}

async fn serve_file(
    path: &Path,
    mut file: tokio::fs::File,
    head: bool,
    range: Option<&HeaderValue>,
) -> Response<Body> {
    let Ok(metadata) = file.metadata().await else {
        return plain(StatusCode::NOT_FOUND, "File not found");
    };
    let length = metadata.len();
    let (status, offset, size) = match range {
        None => (StatusCode::OK, 0, length),
        Some(range) => match range
            .to_str()
            .ok()
            .and_then(|range| crate::media_stream::byte_range(range, length))
        {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
            None => {
                return response(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{length}"))
                    .body(empty())
                    .unwrap()
            }
        },
    };
    let mut response = response(status)
        .header(header::CONTENT_TYPE, content_type(path))
        .header(header::CONTENT_LENGTH, size)
        .header(header::ACCEPT_RANGES, "bytes");
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {offset}-{}/{length}", offset + size - 1),
        );
    }
    if head || size == 0 {
        return response.body(empty()).unwrap();
    }
    if offset > 0 && file.seek(io::SeekFrom::Start(offset)).await.is_err() {
        return plain(StatusCode::NOT_FOUND, "File not found");
    }
    let stream = ReaderStream::new(file.take(size)).map(|data| data.map(Frame::data));
    response
        .body(StreamBody::new(stream).boxed_unsync())
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serves_real_urls_and_refreshes_requested_dependencies() {
        let workspace = tempfile::tempdir().unwrap();
        let directory = workspace.path().join("pages");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("入口 #1.html");
        let source = "<!doctype html><link rel=stylesheet href=/main.css><script type=module src=./app.js></script>";
        std::fs::write(&path, source).unwrap();
        let previews = HtmlPreviews::default();
        let url = previews
            .open(
                workspace.path().to_str().unwrap(),
                &path,
                "test".into(),
                None,
            )
            .unwrap();
        let url = tauri::Url::parse(&url).unwrap();
        assert_eq!(url.path(), "/pages/%E5%85%A5%E5%8F%A3%20%231.html");
        let client = reqwest::Client::builder()
            .no_proxy()
            .resolve(
                url.host_str().unwrap(),
                (Ipv4Addr::LOCALHOST, url.port().unwrap()).into(),
            )
            .build()
            .unwrap();
        let page = client
            .get(url.clone())
            .header("Sec-Fetch-Mode", "navigate")
            .send()
            .await
            .unwrap();
        assert!(page.text().await.unwrap().starts_with(source));
        assert_eq!(
            client
                .get(url.clone())
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap(),
            source
        );
        let stylesheet = url.join("/main.css").unwrap();
        assert_eq!(
            client
                .get(stylesheet.clone())
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        std::fs::write(workspace.path().join("main.css"), "body {color:red}").unwrap();
        let revision = client
            .get(url.join(REVISION_PATH).unwrap())
            .send()
            .await
            .unwrap();
        assert_eq!(revision.text().await.unwrap(), "1");
        let stylesheet = client.get(stylesheet).send().await.unwrap();
        assert_eq!(stylesheet.headers()[header::CONTENT_TYPE], "text/css");
        assert_eq!(stylesheet.text().await.unwrap(), "body {color:red}");
        let form = client
            .post(url.clone())
            .header("Sec-Fetch-Mode", "navigate")
            .body("name=test")
            .send()
            .await
            .unwrap();
        assert_eq!(form.status(), StatusCode::OK);
        assert!(form.text().await.unwrap().contains(BRIDGE_PATH));
        assert!(relative_path("/a/%2E%2E/file.txt").is_none());
        assert!(relative_path("/a%5csecret").is_none());
    }
}
