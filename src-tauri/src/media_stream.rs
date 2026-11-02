use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::http::{Request, Response, StatusCode};

const CHUNK_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Default)]
pub struct MediaStreams(Arc<Mutex<HashMap<String, PathBuf>>>);

impl MediaStreams {
    pub fn register(&self, path: &Path) -> anyhow::Result<String> {
        crate::fs_ops::validate_video_for_preview(path)?;
        let mut streams = self.0.lock().unwrap();
        if let Some((key, _)) = streams.iter().find(|(_, source)| source.as_path() == path) {
            return Ok(key.clone());
        }
        let key = uuid::Uuid::new_v4().simple().to_string();
        streams.insert(key.clone(), path.to_path_buf());
        Ok(key)
    }

    pub fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let key = request.uri().path().trim_start_matches('/');
        let path = self.0.lock().unwrap().get(key).cloned();
        match path {
            Some(path) => file_response(&path, &request).unwrap_or_else(|_| empty(StatusCode::NOT_FOUND)),
            None => empty(StatusCode::NOT_FOUND),
        }
    }
}

fn response(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
        .header("Accept-Ranges", "bytes")
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    response(status).body(Vec::new()).unwrap()
}

fn byte_range(header: &str, length: u64) -> Option<(u64, u64)> {
    let (start, end) = header.strip_prefix("bytes=")?.trim().split_once('-')?;
    if length == 0 { return None; }
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 { return None; }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start = start.parse::<u64>().ok()?;
        let end = if end.is_empty() { length - 1 } else { end.parse::<u64>().ok()?.min(length - 1) };
        (start, end)
    };
    if start >= length || end < start { return None; }
    Some((start, end.min(start.saturating_add(CHUNK_BYTES - 1))))
}

fn file_response(path: &Path, request: &Request<Vec<u8>>) -> std::io::Result<Response<Vec<u8>>> {
    if request.method() == "OPTIONS" {
        return Ok(response(StatusCode::NO_CONTENT)
            .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            .header("Access-Control-Allow-Headers", "Range")
            .body(Vec::new()).unwrap());
    }
    if request.method() != "GET" && request.method() != "HEAD" {
        return Ok(empty(StatusCode::METHOD_NOT_ALLOWED));
    }
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let mime = crate::fs_ops::media_mime_type(path).unwrap_or("application/octet-stream");
    if request.method() == "HEAD" || length == 0 {
        return Ok(response(StatusCode::OK)
            .header("Content-Type", mime)
            .header("Content-Length", length)
            .body(Vec::new()).unwrap());
    }
    let range = request.headers().get("range");
    let (start, end) = if let Some(header) = range {
        match header.to_str().ok().and_then(|value| byte_range(value, length)) {
            Some(range) => range,
            None => return Ok(response(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("Content-Range", format!("bytes */{length}"))
                .body(Vec::new()).unwrap()),
        }
    } else {
        if length > CHUNK_BYTES { return Ok(empty(StatusCode::BAD_REQUEST)); }
        (0, length - 1)
    };
    let size = (end - start + 1) as usize;
    let mut bytes = vec![0; size];
    file.seek(SeekFrom::Start(start))?;
    file.read_exact(&mut bytes)?;
    let mut builder = response(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header("Content-Type", mime)
        .header("Content-Length", size);
    if range.is_some() {
        builder = builder.header("Content-Range", format!("bytes {start}-{end}/{length}"));
    }
    Ok(builder.body(bytes).unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn handles_bounded_open_closed_and_suffix_ranges() {
        assert_eq!(byte_range("bytes=0-", u32::MAX as u64 + 1), Some((0, CHUNK_BYTES - 1)));
        let offset = u32::MAX as u64 + 10;
        assert_eq!(byte_range(&format!("bytes={offset}-"), offset + 4), Some((offset, offset + 3)));
        assert_eq!(byte_range("bytes=8-99", 10), Some((8, 9)));
        assert_eq!(byte_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(byte_range("bytes=-99", 10), Some((0, 9)));
        for invalid in ["bytes=10-", "bytes=4-1", "bytes=-0", "bytes=1-2,4-5", "bytes=a-", "items=0-1"] {
            assert_eq!(byte_range(invalid, 10), None, "{invalid}");
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }

    #[test]
    fn serves_registered_media_and_seeks_to_the_tail() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("recording.mp4");
        let mut file = File::create(&path).unwrap();
        let offset = CHUNK_BYTES + 10;
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(b"tail").unwrap();
        let streams = MediaStreams::default();
        let key = streams.register(&path).unwrap();
        assert_eq!(streams.register(&path).unwrap(), key);
        let make = |method, range: Option<&str>| {
            let mut request = Request::builder().method(method).uri(format!("media://localhost/{key}"));
            if let Some(range) = range { request = request.header("Range", range); }
            streams.respond(request.body(Vec::new()).unwrap())
        };
        let response = make("GET", Some(&format!("bytes={offset}-")));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"tail");
        assert_eq!(response.headers()["content-range"], format!("bytes {offset}-{}/{}", offset + 3, offset + 4));
        let response = make("GET", Some("bytes=0-"));
        assert_eq!(response.body().len(), CHUNK_BYTES as usize);
        assert!(make("HEAD", None).body().is_empty());
        assert_eq!(make("HEAD", None).headers()["content-length"], (offset + 4).to_string());
        assert_eq!(make("GET", Some("bytes=99999999999-")).status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(make("GET", None).status(), StatusCode::BAD_REQUEST);
        let missing = streams.respond(Request::builder().uri("media://localhost/unregistered").body(Vec::new()).unwrap());
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }
}
