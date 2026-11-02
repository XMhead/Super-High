//! The viewer owns a native surface and a libmpv handle, not a transcoded file.
//! All decoded frames and packet buffers remain in memory. No player process,
//! IPC socket, resume file, shader cache or screenshot file is created.
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Copy, Deserialize)]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    visible: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    Open { path: String, bounds: Bounds },
    Bounds { bounds: Bounds },
    Status,
    Pause { paused: bool },
    Seek { seconds: f64 },
    Volume { volume: f64 },
    Screenshot,
    Close,
}

#[cfg(not(windows))]
#[derive(Clone, Default)]
pub struct NativeVideos;

#[cfg(not(windows))]
impl NativeVideos {
    pub fn close_owner(&self, _: &str) {}
    pub fn execute(&self, _: tauri::WebviewWindow, _: String, _: Action) -> anyhow::Result<Value> {
        anyhow::bail!("当前平台未启用原生视频引擎")
    }
}

#[cfg(windows)]
pub use platform::NativeVideos;

#[cfg(windows)]
mod platform {
    use super::*;
    use anyhow::{bail, ensure, Context, Result};
    use base64::Engine;
    use libloading::Library;
    use std::{collections::HashMap, ffi::{c_char, c_int, c_void, CStr, CString}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}};
    use tauri::Manager;
    use windows_sys::Win32::{Foundation::HWND, UI::WindowsAndMessaging::*};

    type Handle = *mut c_void;
    #[repr(C)]
    union NodeValue { string: *mut c_char, flag: c_int, int64: i64, double: f64, list: *mut NodeList, bytes: *mut ByteArray }
    #[repr(C)]
    struct Node { value: NodeValue, format: c_int }
    #[repr(C)]
    struct NodeList { count: c_int, values: *mut Node, keys: *mut *mut c_char }
    #[repr(C)]
    struct ByteArray { data: *mut c_void, size: usize }
    #[repr(C)]
    struct Event { id: c_int, error: c_int, reply: u64, data: *mut c_void }
    #[repr(C)]
    struct EndFile { reason: c_int, error: c_int }

    struct Api {
        _library: Library,
        create: unsafe extern "C" fn() -> Handle,
        initialize: unsafe extern "C" fn(Handle) -> c_int,
        option: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
        command: unsafe extern "C" fn(Handle, *const *const c_char) -> c_int,
        command_ret: unsafe extern "C" fn(Handle, *const *const c_char, *mut Node) -> c_int,
        property: unsafe extern "C" fn(Handle, *const c_char, c_int, *mut c_void) -> c_int,
        wait_event: unsafe extern "C" fn(Handle, f64) -> *const Event,
        free_node: unsafe extern "C" fn(*mut Node),
        error_string: unsafe extern "C" fn(c_int) -> *const c_char,
        destroy: unsafe extern "C" fn(Handle),
    }

    impl Api {
        fn load(path: &Path) -> Result<Self> {
            unsafe {
                let library = Library::new(path).context("无法加载原生视频引擎，请重新构建或修复应用资源")?;
                Ok(Self {
                    create: *library.get(b"mpv_create\0")?,
                    initialize: *library.get(b"mpv_initialize\0")?,
                    option: *library.get(b"mpv_set_option_string\0")?,
                    command: *library.get(b"mpv_command\0")?,
                    command_ret: *library.get(b"mpv_command_ret\0")?,
                    property: *library.get(b"mpv_get_property\0")?,
                    wait_event: *library.get(b"mpv_wait_event\0")?,
                    free_node: *library.get(b"mpv_free_node_contents\0")?,
                    error_string: *library.get(b"mpv_error_string\0")?,
                    destroy: *library.get(b"mpv_terminate_destroy\0")?,
                    _library: library,
                })
            }
        }
        fn check(&self, code: c_int) -> Result<()> {
            if code < 0 {
                let message = unsafe { CStr::from_ptr((self.error_string)(code)) }.to_string_lossy();
                bail!("视频引擎：{message}");
            }
            Ok(())
        }
    }

    fn engine(window: &tauri::WebviewWindow) -> Result<Arc<Api>> {
        // Keep the module loaded until process exit; mpv releases every player
        // and decoder on close, but FFmpeg's process-wide TLS may outlive a player.
        static API: OnceLock<Arc<Api>> = OnceLock::new();
        if let Some(api) = API.get() { return Ok(api.clone()); }
        let mut candidates = vec![];
        if let Ok(root) = window.app_handle().path().resource_dir() { candidates.push(root.join("native-media/libmpv-2.dll")); }
        if let Ok(executable) = std::env::current_exe() {
            if let Some(root) = executable.parent() { candidates.push(root.join("native-media/libmpv-2.dll")); }
        }
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.superhigh/cache/native-media/libmpv-2.dll"));
        let path = candidates.iter().find(|path| path.is_file()).context("原生视频引擎缺失，请运行桌面构建以准备应用资源")?;
        let api = Arc::new(Api::load(path)?);
        let _ = API.set(api.clone());
        Ok(API.get().cloned().unwrap_or(api))
    }

    struct Surface { handle: usize, parent: usize, owner: tauri::WebviewWindow }
    impl Surface {
        fn create(window: &tauri::WebviewWindow, bounds: Bounds) -> Result<Self> {
            let parent = window.hwnd()?.0 as usize;
            let (sender, receiver) = std::sync::mpsc::sync_channel(1);
            let (x, y, width, height) = rectangle(bounds)?;
            window.run_on_main_thread(move || {
                let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
                let handle = unsafe {
                    if IsWindow(parent as HWND) == 0 { std::ptr::null_mut() }
                    else { CreateWindowExW(0, class.as_ptr(), std::ptr::null(), WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS | WS_DISABLED, x, y, width, height, parent as HWND, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null()) }
                };
                if sender.send(handle as usize).is_err() && !handle.is_null() { unsafe { DestroyWindow(handle); } }
            })?;
            let handle = receiver.recv_timeout(std::time::Duration::from_secs(5)).context("无法创建视频画面")?;
            ensure!(handle != 0, "无法创建原生视频画面");
            Ok(Self { handle, parent, owner: window.clone() })
        }
        fn resize(&self, bounds: Bounds) -> Result<()> {
            let (x, y, width, height) = rectangle(bounds)?;
            let handle = self.handle;
            let parent = self.parent;
            self.owner.run_on_main_thread(move || unsafe {
                if GetParent(handle as HWND) != parent as HWND { return; }
                SetWindowPos(handle as HWND, HWND_TOP, x, y, width, height, SWP_NOACTIVATE);
                ShowWindow(handle as HWND, if bounds.visible { SW_SHOWNA } else { SW_HIDE });
            })?;
            Ok(())
        }
    }
    impl Drop for Surface {
        fn drop(&mut self) {
            let handle = self.handle;
            let parent = self.parent;
            let _ = self.owner.run_on_main_thread(move || unsafe {
                if GetParent(handle as HWND) == parent as HWND { DestroyWindow(handle as HWND); }
            });
        }
    }

    fn rectangle(bounds: Bounds) -> Result<(i32, i32, i32, i32)> {
        ensure!([bounds.x, bounds.y, bounds.width, bounds.height, bounds.scale].iter().all(|value| value.is_finite()), "无效视频区域");
        ensure!((0.1..=8.0).contains(&bounds.scale) && bounds.width >= 0.0 && bounds.height >= 0.0, "无效视频区域");
        let pixel = |value: f64| (value * bounds.scale).round().clamp(-32768.0, 32768.0) as i32;
        Ok((pixel(bounds.x), pixel(bounds.y), pixel(bounds.width).max(1), pixel(bounds.height).max(1)))
    }

    struct Player { api: Arc<Api>, handle: usize, surface: Surface, error: Option<String> }
    impl Player {
        fn open(window: &tauri::WebviewWindow, source: &str, bounds: Bounds) -> Result<Self> {
            let path = std::fs::canonicalize(source)?;
            crate::fs_ops::validate_video_for_preview(&path)?;
            ensure!(crate::fs_ops::media_mime_type(&path).unwrap_or("").starts_with("video/"), "请选择视频文件");
            let api = engine(window)?;
            let surface = Surface::create(window, bounds)?;
            let handle = unsafe { (api.create)() } as usize;
            ensure!(handle != 0, "无法初始化视频引擎");
            let player = Self { api, handle, surface, error: None };
            for (name, value) in [
                ("config", "no"), ("load-scripts", "no"), ("osc", "no"),
                ("input-default-bindings", "no"), ("input-vo-keyboard", "no"), ("input-cursor", "no"),
                ("save-position-on-quit", "no"), ("resume-playback", "no"),
                ("cache", "no"), ("cache-on-disk", "no"), ("gpu-shader-cache", "no"),
                ("screenshot-sw", "yes"),
                ("vo", "gpu-next"), ("gpu-api", "d3d11"), ("hwdec", "auto-safe"),
                ("keep-open", "yes"), ("idle", "yes"), ("pause", "yes"), ("terminal", "no"),
            ] { player.option(name, value)?; }
            player.option("wid", &player.surface.handle.to_string())?;
            player.api.check(unsafe { (player.api.initialize)(player.raw()) })?;
            player.command(&["loadfile", &path.to_string_lossy(), "replace"])?;
            Ok(player)
        }
        fn raw(&self) -> Handle { self.handle as Handle }
        fn option(&self, name: &str, value: &str) -> Result<()> {
            let (name, value) = (CString::new(name)?, CString::new(value)?);
            self.api.check(unsafe { (self.api.option)(self.raw(), name.as_ptr(), value.as_ptr()) })
        }
        fn command(&self, args: &[&str]) -> Result<()> {
            let args: Vec<CString> = args.iter().map(|value| CString::new(*value)).collect::<std::result::Result<_, _>>()?;
            let pointers: Vec<_> = args.iter().map(|value| value.as_ptr()).chain(std::iter::once(std::ptr::null())).collect();
            self.api.check(unsafe { (self.api.command)(self.raw(), pointers.as_ptr()) })
        }
        fn number(&self, name: &str) -> f64 {
            let mut value = 0.0f64;
            if let Ok(name) = CString::new(name) {
                unsafe { (self.api.property)(self.raw(), name.as_ptr(), 5, &mut value as *mut _ as *mut c_void); }
            }
            if value.is_finite() { value } else { 0.0 }
        }
        fn flag(&self, name: &str) -> bool {
            let mut value = 0i32;
            if let Ok(name) = CString::new(name) {
                unsafe { (self.api.property)(self.raw(), name.as_ptr(), 3, &mut value as *mut _ as *mut c_void); }
            }
            value != 0
        }
        fn status(&mut self) -> Result<Value> {
            for _ in 0..64 {
                let event = unsafe { &*(self.api.wait_event)(self.raw(), 0.0) };
                if event.id == 0 { break; }
                if event.id == 7 && !event.data.is_null() {
                    let ended = unsafe { &*(event.data as *const EndFile) };
                    if ended.reason == 4 {
                        self.error = Some(self.api.check(ended.error).err().map(|error| error.to_string()).unwrap_or_else(|| "视频解码失败".into()));
                    }
                }
            }
            if let Some(error) = &self.error { bail!("{error}"); }
            Ok(serde_json::json!({
                "position": self.number("time-pos"), "duration": self.number("duration"),
                "paused": self.flag("pause"), "ended": self.flag("eof-reached"),
                "width": self.number("video-params/w"), "height": self.number("video-params/h"),
                "ready": self.flag("vo-configured"), "volume": self.number("volume"),
            }))
        }
        fn screenshot(&self) -> Result<String> {
            let args = [c"screenshot-raw".as_ptr(), c"video".as_ptr(), std::ptr::null()];
            let mut node: Node = unsafe { std::mem::zeroed() };
            self.api.check(unsafe { (self.api.command_ret)(self.raw(), args.as_ptr(), &mut node) })?;
            // The node owns mpv's image memory; copy/encode it before releasing it,
            // on both success and error. Never route screenshots through a file.
            let result = unsafe { screenshot_png(&node) };
            unsafe { (self.api.free_node)(&mut node); }
            Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(result?)))
        }
    }
    impl Drop for Player {
        fn drop(&mut self) { unsafe { (self.api.destroy)(self.raw()); } }
    }

    unsafe fn map_entry<'a>(node: &'a Node, name: &[u8]) -> Result<&'a Node> {
        ensure!(node.format == 8 && !node.value.list.is_null(), "无效视频帧");
        let map = &*node.value.list;
        ensure!((0..=64).contains(&map.count) && !map.keys.is_null() && !map.values.is_null(), "无效视频帧");
        for index in 0..map.count as usize {
            if CStr::from_ptr(*map.keys.add(index)).to_bytes() == name { return Ok(&*map.values.add(index)); }
        }
        bail!("视频帧缺少字段")
    }
    unsafe fn screenshot_png(node: &Node) -> Result<Vec<u8>> {
        let integer = |name: &[u8]| -> Result<usize> {
            let entry = map_entry(node, name)?;
            ensure!(entry.format == 4 && entry.value.int64 > 0, "无效视频帧尺寸");
            Ok(entry.value.int64 as usize)
        };
        let (width, height, stride) = (integer(b"w")?, integer(b"h")?, integer(b"stride")?);
        ensure!(width <= 32768 && height <= 32768 && width * height <= 100_000_000 && stride >= width * 4, "视频帧尺寸过大");
        let format = map_entry(node, b"format")?;
        ensure!(format.format == 1 && !format.value.string.is_null(), "无效视频帧格式");
        let format = CStr::from_ptr(format.value.string).to_bytes();
        ensure!(format == b"bgr0" || format == b"rgb0" || format == b"rgba" || format == b"bgra", "不支持的视频帧格式");
        let data = map_entry(node, b"data")?;
        ensure!(data.format == 9 && !data.value.bytes.is_null(), "无效视频帧数据");
        let bytes = &*data.value.bytes;
        ensure!(!bytes.data.is_null() && stride.checked_mul(height).map(|size| size <= bytes.size).unwrap_or(false), "视频帧数据不完整");
        let source = std::slice::from_raw_parts(bytes.data as *const u8, bytes.size);
        let mut rgb = Vec::with_capacity(width * height * 3);
        let bgr = format.starts_with(b"bg");
        for row in source.chunks(stride).take(height) {
            for pixel in row[..width * 4].chunks_exact(4) {
                if bgr { rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]); }
                else { rgb.extend_from_slice(&pixel[..3]); }
            }
        }
        let mut output = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut output, width as u32, height as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header()?.write_image_data(&rgb)?;
        }
        Ok(output)
    }

    struct Slot { id: String, player: Option<Player> }
    #[derive(Clone, Default)]
    pub struct NativeVideos(Arc<Mutex<HashMap<String, Slot>>>);
    impl NativeVideos {
        pub fn close_owner(&self, owner: &str) {
            let slot = self.0.lock().unwrap().remove(owner);
            drop(slot);
        }
        pub fn execute(&self, window: tauri::WebviewWindow, id: String, action: Action) -> Result<Value> {
            let owner = window.label().to_string();
            if let Action::Open { path, bounds } = action {
                ensure!(!id.is_empty(), "视频会话标识缺失");
                ensure!(window.app_handle().get_webview_window(&owner).is_some(), "查看器已关闭");
                let old = self.0.lock().unwrap().insert(owner.clone(), Slot { id: id.clone(), player: None });
                drop(old);
                let player = Player::open(&window, &path, bounds)?;
                let mut slots = self.0.lock().unwrap();
                if let Some(slot) = slots.get_mut(&owner).filter(|slot| slot.id == id) {
                    slot.player = Some(player);
                    return Ok(Value::Null);
                }
                drop(slots);
                bail!("视频已关闭");
            }
            if let Action::Close = action {
                let mut slots = self.0.lock().unwrap();
                let removed = if slots.get(&owner).map(|slot| slot.id == id).unwrap_or(false) { slots.remove(&owner) } else { None };
                drop(slots);
                drop(removed);
                return Ok(Value::Null);
            }
            if let Action::Bounds { bounds } = action {
                // Queue window work without waiting while holding the map lock:
                // a Destroyed event may need this same lock on the UI thread.
                let slots = self.0.lock().unwrap();
                let player = slots.get(&owner).filter(|slot| slot.id == id).and_then(|slot| slot.player.as_ref()).context("视频已关闭")?;
                player.surface.resize(bounds)?;
                return Ok(Value::Null);
            }
            let mut slots = self.0.lock().unwrap();
            let player = slots.get_mut(&owner).filter(|slot| slot.id == id).and_then(|slot| slot.player.as_mut()).context("视频已关闭")?;
            match action {
                Action::Status => return player.status(),
                Action::Pause { paused } => {
                    if !paused && player.flag("eof-reached") { player.command(&["seek", "0", "absolute+exact"])?; }
                    player.command(&["set", "pause", if paused { "yes" } else { "no" }])?;
                }
                Action::Seek { seconds } => {
                    ensure!(seconds.is_finite() && seconds >= 0.0, "无效播放位置");
                    player.command(&["seek", &seconds.to_string(), "absolute+exact"])?;
                }
                Action::Volume { volume } => {
                    ensure!(volume.is_finite() && (0.0..=100.0).contains(&volume), "无效音量");
                    player.command(&["set", "volume", &volume.to_string()])?;
                }
                Action::Screenshot => return Ok(Value::String(player.screenshot()?)),
                _ => unreachable!(),
            }
            Ok(Value::Null)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn maps_css_bounds_to_physical_pixels_and_rejects_invalid_values() {
            let bounds = Bounds { x: 10.0, y: 70.0, width: 800.0, height: 450.0, scale: 1.5, visible: true };
            assert_eq!(rectangle(bounds).unwrap(), (15, 105, 1200, 675));
            assert!(rectangle(Bounds { scale: f64::NAN, ..bounds }).is_err());
            assert!(rectangle(Bounds { width: -1.0, ..bounds }).is_err());
        }

        #[test]
        fn copies_raw_bgr_frames_to_png_without_losing_color_or_row_padding() {
            let mut pixels = vec![30u8, 20, 10, 0, 60, 50, 40, 0, 0, 0, 0, 0];
            let mut bytes = ByteArray { data: pixels.as_mut_ptr() as *mut c_void, size: pixels.len() };
            let names: Vec<CString> = ["w", "h", "stride", "format", "data"].iter().map(|key| CString::new(*key).unwrap()).collect();
            let mut keys: Vec<_> = names.iter().map(|key| key.as_ptr() as *mut c_char).collect();
            let format = c"bgr0";
            let mut values = [
                Node { value: NodeValue { int64: 2 }, format: 4 },
                Node { value: NodeValue { int64: 1 }, format: 4 },
                Node { value: NodeValue { int64: 12 }, format: 4 },
                Node { value: NodeValue { string: format.as_ptr() as *mut c_char }, format: 1 },
                Node { value: NodeValue { bytes: &mut bytes }, format: 9 },
            ];
            let mut map = NodeList { count: 5, values: values.as_mut_ptr(), keys: keys.as_mut_ptr() };
            let node = Node { value: NodeValue { list: &mut map }, format: 8 };
            let encoded = unsafe { screenshot_png(&node).unwrap() };
            let mut reader = png::Decoder::new(std::io::Cursor::new(encoded)).read_info().unwrap();
            let mut decoded = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut decoded).unwrap();
            assert_eq!((info.width, info.height), (2, 1));
            assert_eq!(&decoded[..info.buffer_size()], &[10, 20, 30, 40, 50, 60]);
            unsafe { (*values[4].value.bytes).size = 1; }
            assert!(unsafe { screenshot_png(&node) }.is_err());
        }
    }
}
