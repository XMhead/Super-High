use std::{
    ffi::{c_char, c_void, CStr, CString},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const WORKER_FLAG: &str = "--prompt-spacing-worker";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROMPT_BYTES: usize = 512 * 1024;
const RESOURCE_VERSION: &str = "sherpa-onnx-1.13.8-ct-transformer-int8-2024-04-12-r2";
const THIRD_PARTY_NOTICES: &str = include_str!("../prompt-spacing/THIRD_PARTY_NOTICES.md");
const RUNTIME_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts.tar.bz2";
const RUNTIME_SHA256: &str = "876e6b89b8cf84a3a1b375a397507f2cfe9c227c2a945411a11a668475fcb5d3";
const MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2";
const MODEL_SHA256: &str = "c0d5aa5f8eeb686032345e180bedf39319dc2e0556781c6264bcadba8328a6e1";
static INSTALL_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

#[derive(Debug, Serialize)]
pub struct PromptSpacingStatus {
    pub ready: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSpacingCliResult {
    pub text: String,
    pub elapsed_ms: u128,
}

#[derive(Serialize, Deserialize)]
struct WorkerRequest {
    texts: Vec<String>,
}

struct ChildGuard {
    child: Child,
    reaped: bool,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[repr(C)]
struct OfflinePunctuationModelConfig {
    ct_transformer: *const c_char,
    num_threads: i32,
    debug: i32,
    provider: *const c_char,
}

#[repr(C)]
struct OfflinePunctuationConfig {
    model: OfflinePunctuationModelConfig,
}

type CreatePunctuation = unsafe extern "C" fn(*const OfflinePunctuationConfig) -> *const c_void;
type DestroyPunctuation = unsafe extern "C" fn(*const c_void);
type AddPunctuation = unsafe extern "C" fn(*const c_void, *const c_char) -> *const c_char;
type FreeText = unsafe extern "C" fn(*const c_char);

pub fn worker_requested() -> bool {
    std::env::args_os().any(|arg| arg == WORKER_FLAG)
}

pub fn run_worker_from_env() -> i32 {
    match run_worker() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("prompt spacing worker failed: {error:#}");
            1
        }
    }
}

fn run_worker() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let mut model = None;
    let mut runtime_dir = None;
    while let Some(arg) = args.next() {
        if arg == WORKER_FLAG {
            continue;
        }
        if arg == "--model" {
            model = args.next().map(PathBuf::from);
            continue;
        }
        if arg == "--runtime-dir" {
            runtime_dir = args.next().map(PathBuf::from);
            continue;
        }
        bail!("unknown worker argument: {}", arg.to_string_lossy());
    }
    let model = model.context("worker model path is missing")?;
    let runtime_dir = runtime_dir.context("worker runtime directory is missing")?;

    // Read before loading the model so the parent can always finish writing to the pipe.
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input)?;
    let request: WorkerRequest =
        serde_json::from_slice(&input).context("invalid worker request")?;
    let predictions = infer_punctuation(&runtime_dir, &model, &request.texts)?;
    serde_json::to_writer(std::io::stdout().lock(), &predictions)?;
    Ok(())
}

fn infer_punctuation(runtime_dir: &Path, model: &Path, texts: &[String]) -> Result<Vec<String>> {
    #[cfg(not(windows))]
    {
        let _ = (runtime_dir, model, texts);
        bail!("prompt spacing is currently supported on Windows only");
    }
    #[cfg(windows)]
    return infer_punctuation_windows(runtime_dir, model, texts);
}

#[cfg(windows)]
fn infer_punctuation_windows(
    runtime_dir: &Path,
    model: &Path,
    texts: &[String],
) -> Result<Vec<String>> {
    use std::{mem, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::{
        Foundation::{FreeLibrary, HMODULE},
        System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    };

    struct LibraryGuard(HMODULE);
    impl Drop for LibraryGuard {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.0) };
        }
    }
    unsafe fn load(path: &Path) -> Result<LibraryGuard> {
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
        if handle.is_null() {
            bail!("failed to load {}", path.display());
        }
        Ok(LibraryGuard(handle))
    }
    unsafe fn symbol<T: Copy>(library: &LibraryGuard, name: &'static [u8]) -> Result<T> {
        let raw = unsafe { GetProcAddress(library.0, name.as_ptr()) }.with_context(|| {
            format!(
                "missing runtime symbol {}",
                String::from_utf8_lossy(&name[..name.len() - 1])
            )
        })?;
        Ok(unsafe { mem::transmute_copy(&raw) })
    }

    let ort_path = runtime_dir.join("onnxruntime.dll");
    let providers_path = runtime_dir.join("onnxruntime_providers_shared.dll");
    let sherpa_path = runtime_dir.join("sherpa-onnx-c-api.dll");
    for path in [&ort_path, &providers_path, &sherpa_path, model] {
        if !path.is_file() {
            bail!("prompt spacing resource is missing: {}", path.display());
        }
    }

    // Keep dependencies loaded for the full lifetime of the sherpa library.
    let _ort = unsafe { load(&ort_path) }?;
    let _providers = unsafe { load(&providers_path) }?;
    let sherpa = unsafe { load(&sherpa_path) }?;

    let create: CreatePunctuation =
        unsafe { symbol(&sherpa, b"SherpaOnnxCreateOfflinePunctuation\0")? };
    let destroy: DestroyPunctuation =
        unsafe { symbol(&sherpa, b"SherpaOnnxDestroyOfflinePunctuation\0")? };
    let add: AddPunctuation =
        unsafe { symbol(&sherpa, b"SherpaOfflinePunctuationAddPunct\0")? };
    let free_text: FreeText =
        unsafe { symbol(&sherpa, b"SherpaOfflinePunctuationFreeText\0")? };

    let model =
        CString::new(model.to_string_lossy().as_bytes()).context("model path contains NUL")?;
    let provider = CString::new("cpu")?;
    let config = OfflinePunctuationConfig {
        model: OfflinePunctuationModelConfig {
            ct_transformer: model.as_ptr(),
            num_threads: 1,
            debug: 0,
            provider: provider.as_ptr(),
        },
    };
    let punctuation = unsafe { create(&config) };
    if punctuation.is_null() {
        bail!("failed to initialize punctuation model");
    }
    struct PunctuationGuard<'a> {
        value: *const c_void,
        destroy: &'a DestroyPunctuation,
    }
    impl Drop for PunctuationGuard<'_> {
        fn drop(&mut self) {
            unsafe { (self.destroy)(self.value) };
        }
    }
    let guard = PunctuationGuard {
        value: punctuation,
        destroy: &destroy,
    };

    let mut output = Vec::with_capacity(texts.len());
    for text in texts {
        let text = CString::new(text.as_bytes()).context("prompt contains NUL")?;
        let result = unsafe { add(guard.value, text.as_ptr()) };
        if result.is_null() {
            bail!("punctuation inference returned no text");
        }
        let value = unsafe { CStr::from_ptr(result) }
            .to_string_lossy()
            .into_owned();
        unsafe { free_text(result) };
        output.push(value);
    }
    Ok(output)
}

pub fn normalize_with_resource_dir(prompt: &str, resource_dir: &Path) -> Result<String> {
    normalize_with_resource_dir_and_timeout(prompt, resource_dir, DEFAULT_TIMEOUT)
}

pub fn status(resource_root: &Path) -> PromptSpacingStatus {
    PromptSpacingStatus {
        ready: resources_ready(&resource_root.join("prompt-spacing")),
    }
}

fn resources_ready(directory: &Path) -> bool {
    directory.join("READY").is_file()
        && fs::read_to_string(directory.join("READY")).ok().as_deref() == Some(RESOURCE_VERSION)
        && [
            "model.int8.onnx",
            "onnxruntime.dll",
            "onnxruntime_providers_shared.dll",
            "sherpa-onnx-c-api.dll",
        ]
        .iter()
        .all(|name| directory.join(name).is_file())
}

pub async fn install(resource_root: &Path) -> Result<()> {
    let _guard = INSTALL_LOCK.lock().await;
    let destination = resource_root.join("prompt-spacing");
    if resources_ready(&destination) {
        return Ok(());
    }
    fs::create_dir_all(resource_root)?;
    let staging = resource_root.join(format!(
        "prompt-spacing.installing-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&staging)?;
    let runtime_archive = staging.join("runtime.tar.bz2");
    let model_archive = staging.join("model.tar.bz2");
    let result = async {
        download_verified(RUNTIME_URL, RUNTIME_SHA256, &runtime_archive).await?;
        download_verified(MODEL_URL, MODEL_SHA256, &model_archive).await?;
        let extraction_dir = staging.clone();
        tokio::task::spawn_blocking(move || {
            extract_resources(&runtime_archive, &model_archive, &extraction_dir)
        })
        .await
        .context("resource extraction task failed")??;
        fs::write(staging.join("THIRD_PARTY_NOTICES.md"), THIRD_PARTY_NOTICES)?;
        fs::write(staging.join("READY"), RESOURCE_VERSION)?;
        if destination.exists() {
            fs::remove_dir_all(&destination)?;
        }
        fs::rename(&staging, &destination)?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

async fn download_verified(url: &str, expected_sha256: &str, destination: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    let mut response = client.get(url).send().await?.error_for_status()?;
    let mut output = fs::File::create(destination)?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await? {
        hasher.update(&chunk);
        output.write_all(&chunk)?;
    }
    output.flush()?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected_sha256 {
        bail!("download checksum mismatch: expected {expected_sha256}, got {actual}");
    }
    Ok(())
}

fn extract_resources(
    runtime_archive: &Path,
    model_archive: &Path,
    destination: &Path,
) -> Result<()> {
    extract_selected(runtime_archive, destination, &[
        ("sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts/lib/onnxruntime.dll", "onnxruntime.dll"),
        ("sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts/lib/onnxruntime_providers_shared.dll", "onnxruntime_providers_shared.dll"),
        ("sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts/lib/sherpa-onnx-c-api.dll", "sherpa-onnx-c-api.dll"),
    ])?;
    extract_selected(
        model_archive,
        destination,
        &[(
            "sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/model.int8.onnx",
            "model.int8.onnx",
        )],
    )?;
    let _ = fs::remove_file(runtime_archive);
    let _ = fs::remove_file(model_archive);
    Ok(())
}

fn extract_selected(
    archive_path: &Path,
    destination: &Path,
    selected: &[(&str, &str)],
) -> Result<()> {
    for (entry_name, output_name) in selected {
        let output = fs::File::create(destination.join(output_name))?;
        let mut command = Command::new("tar.exe");
        command
            .args(["-xOf"])
            .arg(archive_path)
            .arg(entry_name)
            .stdout(Stdio::from(output))
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let result = command
            .output()
            .context("failed to run Windows archive extractor")?;
        if !result.status.success() {
            let _ = fs::remove_file(destination.join(output_name));
            bail!(
                "failed to extract {entry_name}: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            );
        }
    }
    Ok(())
}

pub fn normalize_with_resource_dir_and_timeout(
    prompt: &str,
    resource_dir: &Path,
    timeout: Duration,
) -> Result<String> {
    if prompt.len() > MAX_PROMPT_BYTES {
        bail!("prompt is too large to normalize (limit: {MAX_PROMPT_BYTES} bytes)");
    }
    let plan = NormalizationPlan::new(prompt);
    if plan.model_inputs.is_empty() {
        return Ok(plan.finish(Vec::new())?);
    }
    let model_dir = resource_dir.join("prompt-spacing");
    let predictions = run_supervised_worker(
        &std::env::current_exe().context("failed to locate current executable")?,
        &model_dir,
        &plan.model_inputs,
        timeout,
    )?;
    plan.finish(predictions)
}

pub fn cli_resource_dir() -> PathBuf {
    if let Ok(value) = std::env::var("SUPERHIGH_PROMPT_SPACING_RESOURCE_DIR") {
        return PathBuf::from(value);
    }
    #[cfg(windows)]
    if let Some(value) = std::env::var_os("APPDATA") {
        return PathBuf::from(value).join("com.superhigh.desktop");
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
}

fn run_supervised_worker(
    executable: &Path,
    model_dir: &Path,
    texts: &[String],
    timeout: Duration,
) -> Result<Vec<String>> {
    let started = Instant::now();
    let mut command = Command::new(executable);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let child = command
        .arg(WORKER_FLAG)
        .arg("--model")
        .arg(model_dir.join("model.int8.onnx"))
        .arg("--runtime-dir")
        .arg(model_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("failed to start prompt spacing worker")?;
    let mut child = ChildGuard {
        child,
        reaped: false,
    };

    let request = serde_json::to_vec(&WorkerRequest {
        texts: texts.to_vec(),
    })?;
    let mut stdin = child.child.stdin.take().context("worker stdin unavailable")?;

    let stdout = child.child.stdout.take().context("worker stdout unavailable")?;
    let stderr = child.child.stderr.take().context("worker stderr unavailable")?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stderr;
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stdin_writer = thread::spawn(move || stdin.write_all(&request));

    let status = loop {
        if let Some(status) = child.child.try_wait()? {
            child.reaped = true;
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.child.kill();
            let _ = child.child.wait();
            child.reaped = true;
            let _ = stdin_writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            bail!("prompt spacing timed out after {} ms", timeout.as_millis());
        }
        thread::sleep(Duration::from_millis(5));
    };
    stdin_writer
        .join()
        .map_err(|_| anyhow::anyhow!("worker stdin writer failed"))??;
    let stdout = stdout_reader
        .join()
        .map_err(|_| anyhow::anyhow!("worker stdout reader failed"))??;
    let stderr = stderr_reader
        .join()
        .map_err(|_| anyhow::anyhow!("worker stderr reader failed"))??;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        bail!(
            "prompt spacing worker exited with {status}: {}",
            detail.trim()
        );
    }
    serde_json::from_slice(&stdout).context("invalid prompt spacing worker output")
}

#[derive(Debug)]
struct LinePlan {
    original: String,
    cleaned: String,
    runs: Vec<WhitespaceRun>,
    prediction_index: Option<usize>,
    preserve_exact: bool,
    needs_model: bool,
}

#[derive(Debug)]
struct WhitespaceRun {
    start: usize,
    end: usize,
    boundary: usize,
    exact: bool,
    force_space: bool,
    drop_always: bool,
}

struct NormalizationPlan {
    lines: Vec<LinePlan>,
    model_inputs: Vec<String>,
}

impl NormalizationPlan {
    fn new(prompt: &str) -> Self {
        let mut lines = Vec::new();
        let mut model_inputs = Vec::new();
        let mut fenced = false;
        for original in split_preserving_newlines(prompt) {
            let content = original.trim_end_matches(['\r', '\n']);
            let trimmed = content.trim_start();
            let delimiter = trimmed.starts_with("```") || trimmed.starts_with("~~~");
            let preserve_exact = fenced || delimiter;
            let mut line = plan_line(&original, preserve_exact);
            if delimiter {
                fenced = !fenced;
            }
            if line.needs_model && !line.cleaned.trim().is_empty() {
                line.prediction_index = Some(model_inputs.len());
                model_inputs.push(line.cleaned.clone());
            }
            lines.push(line);
        }
        Self {
            lines,
            model_inputs,
        }
    }

    fn finish(self, predictions: Vec<String>) -> Result<String> {
        if predictions.len() != self.model_inputs.len() {
            bail!("punctuation result count mismatch");
        }
        let mut result = String::new();
        for line in self.lines {
            if line.preserve_exact || line.runs.is_empty() {
                result.push_str(&line.original);
                continue;
            }
            let predicted_boundaries = line
                .prediction_index
                .map(|index| punctuation_boundaries(&line.cleaned, &predictions[index]))
                .unwrap_or_default();
            let mut cursor = 0;
            for run in line.runs {
                result.push_str(&line.original[cursor..run.start]);
                if run.exact {
                    result.push_str(&line.original[run.start..run.end]);
                } else if !run.drop_always
                    && (run.force_space || predicted_boundaries.contains(&run.boundary))
                {
                    result.push(' ');
                }
                cursor = run.end;
            }
            result.push_str(&line.original[cursor..]);
        }
        Ok(result)
    }
}

fn plan_line(original: &str, preserve_exact: bool) -> LinePlan {
    if preserve_exact {
        return LinePlan {
            original: original.to_string(),
            cleaned: original.to_string(),
            runs: Vec::new(),
            prediction_index: None,
            preserve_exact,
            needs_model: false,
        };
    }
    let content_end = original.trim_end_matches(['\r', '\n']).len();
    let mut runs = Vec::new();
    let mut cleaned = String::new();
    let mut cursor = 0;
    let mut protected = false;
    let mut quote = None;
    let mut chars = original[..content_end].char_indices().peekable();
    while let Some((index, ch)) = chars.next() {
        if !protected && matches!(ch, '`' | '"' | '\'') {
            protected = true;
            quote = Some(ch);
            continue;
        }
        if protected && Some(ch) == quote {
            protected = false;
            quote = None;
        }
        if !is_horizontal_space(ch) {
            continue;
        }
        let start = index;
        let mut end = index + ch.len_utf8();
        while let Some((next_index, next_ch)) = chars.peek().copied() {
            if !is_horizontal_space(next_ch) {
                break;
            }
            chars.next();
            end = next_index + next_ch.len_utf8();
        }
        cleaned.push_str(&original[cursor..start]);
        let boundary = cleaned.chars().count();
        let previous = original[..start].chars().next_back();
        let next = original[end..content_end].chars().next();
        let leading = previous.is_none();
        let trailing = next.is_none();
        let exact = protected || leading || original[..start].trim_end().ends_with('`');
        let force_space = !trailing
            && !exact
            && should_preserve_without_model(previous, next, &original[..start]);
        if exact || force_space {
            cleaned.push(' ');
        }
        runs.push(WhitespaceRun {
            start,
            end,
            boundary,
            exact,
            force_space,
            drop_always: trailing,
        });
        cursor = end;
    }
    cleaned.push_str(&original[cursor..content_end]);
    cleaned.push_str(&original[content_end..]);
    let needs_model = runs
        .iter()
        .any(|run| !run.exact && !run.force_space && run.end < content_end);
    LinePlan {
        original: original.to_string(),
        cleaned,
        runs,
        prediction_index: None,
        preserve_exact,
        needs_model,
    }
}

fn should_preserve_without_model(previous: Option<char>, next: Option<char>, prefix: &str) -> bool {
    let Some(previous) = previous else {
        return false;
    };
    let Some(next) = next else { return false };
    if (previous.is_ascii() || next.is_ascii())
        && !previous.is_ascii_whitespace()
        && !next.is_ascii_whitespace()
    {
        return true;
    }
    let trimmed = prefix.trim_start();
    matches!(trimmed, "-" | "*" | "+")
        || trimmed
            .strip_suffix(['.', ')'])
            .is_some_and(|value| !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit()))
}

fn punctuation_boundaries(cleaned: &str, predicted: &str) -> std::collections::HashSet<usize> {
    let source = cleaned
        .trim_end_matches(['\r', '\n'])
        .chars()
        .collect::<Vec<_>>();
    let mut boundaries = std::collections::HashSet::new();
    let mut index = 0;
    for ch in predicted.trim().chars() {
        if source.get(index) == Some(&ch) {
            index += 1;
        } else if is_boundary_punctuation(ch) {
            boundaries.insert(index);
        } else if let Some(offset) = source[index..].iter().position(|value| *value == ch) {
            index += offset + 1;
        }
    }
    boundaries
}

fn is_boundary_punctuation(ch: char) -> bool {
    matches!(
        ch,
        '，' | '。' | '？' | '！' | '；' | '：' | ',' | '.' | '?' | '!' | ';' | ':'
    )
}

fn is_horizontal_space(ch: char) -> bool {
    ch != '\r' && ch != '\n' && ch.is_whitespace()
}

fn split_preserving_newlines(value: &str) -> Vec<String> {
    if value.is_empty() {
        return vec![String::new()];
    }
    let mut output = Vec::new();
    let mut start = 0;
    for (index, ch) in value.char_indices() {
        if ch == '\n' {
            output.push(value[start..index + 1].to_string());
            start = index + 1;
        }
    }
    if start < value.len() {
        output.push(value[start..].to_string());
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(prompt: &str, predictions: &[&str]) -> String {
        NormalizationPlan::new(prompt)
            .finish(predictions.iter().map(|value| value.to_string()).collect())
            .unwrap()
    }

    #[test]
    fn combines_cjk_copy_artifacts_and_removes_trailing_space() {
        assert_eq!(apply("我\t \u{00a0} 是  ", &["我是。"]), "我是");
    }

    #[test]
    fn keeps_model_boundary_as_one_space() {
        assert_eq!(
            apply("先保存       然后关闭窗口", &["先保存，然后关闭窗口。"]),
            "先保存 然后关闭窗口"
        );
    }

    #[test]
    fn protects_english_paths_inline_code_and_newlines() {
        let input =
            "运行 npm   run build\n路径 \"C:\\Program   Files\\App\"\n```sh\ngit    status\n```";
        let expected =
            "运行 npm run build\n路径 \"C:\\Program   Files\\App\"\n```sh\ngit    status\n```";
        assert_eq!(apply(input, &[]), expected);
    }
}
