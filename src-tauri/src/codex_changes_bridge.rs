//! Observe each TUI connection to one native Codex WebSocket app-server.
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tungstenite::{Error as WsError, Message, WebSocket};

use crate::codex_plan::PlanRelay;

type Observer = Arc<dyn Fn(Value) + Send + Sync>;

pub struct CodexBridge {
    endpoint: String,
    pub(crate) plans: Arc<PlanRelay>,
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl CodexBridge {
    pub fn start(
        program: &str,
        args: &[String],
        cwd: &Path,
        env: &HashMap<String, String>,
        observer: Observer,
    ) -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = format!("ws://{}", listener.local_addr()?);
        let reservation = TcpListener::bind(("127.0.0.1", 0))?;
        let upstream = reservation.local_addr()?;
        drop(reservation);
        let mut command = Command::new(program);
        command
            .args(args)
            .args(["--listen", &format!("ws://{upstream}")])
            .current_dir(cwd)
            .env_clear()
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().context("start native Codex app-server")?;
        #[cfg(windows)]
        let job = match ProcessJob::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stderr = child
            .stderr
            .take()
            .context("app-server stderr unavailable")?;
        // Retain a bounded diagnostic tail so a failed server does not look like
        // a successful launch followed by an unexplained TUI connection error.
        let diagnostics = Arc::new(Mutex::new(Vec::<u8>::new()));
        let error_tail = diagnostics.clone();
        let errors = thread::spawn(move || {
            let mut stderr = stderr;
            let mut buffer = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                let mut tail = error_tail.lock().unwrap();
                tail.extend_from_slice(&buffer[..n]);
                let excess = tail.len().saturating_sub(8192);
                tail.drain(..excess);
            }
        });
        let ready = (|| -> Result<()> {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(status) = child.try_wait()? {
                    anyhow::bail!("Codex app-server exited: {status}");
                }
                if TcpStream::connect_timeout(&upstream, Duration::from_millis(100)).is_ok() {
                    return Ok(());
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "Codex app-server startup timed out"
                );
                thread::sleep(Duration::from_millis(20));
            }
        })();
        if let Err(error) = ready {
            reap(&mut child);
            #[cfg(windows)]
            drop(job);
            let _ = errors.join();
            let tail = diagnostics.lock().unwrap();
            anyhow::bail!("{error}: {}", String::from_utf8_lossy(&tail).trim());
        }
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let plans = Arc::new(PlanRelay::default());
        let worker_plans = plans.clone();
        let worker = thread::spawn(move || {
            serve(listener, upstream, &worker_stop, &observer, &worker_plans, || {
                matches!(child.try_wait(), Ok(Some(_)) | Err(_))
            });
            worker_stop.store(true, Ordering::Release);
            reap(&mut child);
            #[cfg(windows)]
            drop(job);
            let _ = errors.join();
        });
        Ok(Self {
            endpoint,
            plans,
            stop,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                if handle.thread().id() != thread::current().id() {
                    let _ = handle.join();
                }
            }
        }
    }
}

impl Drop for CodexBridge {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn observe(observer: &Observer, connection: u64, direction: &str, text: &str) {
    if let Ok(message) = serde_json::from_str::<Value>(text) {
        // An observer must never interrupt the protocol transport.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            observer(json!({"connection": connection, "direction": direction, "message": message}))
        }));
    }
}

fn serve(
    listener: TcpListener,
    upstream: std::net::SocketAddr,
    stop: &Arc<AtomicBool>,
    observer: &Observer,
    plans: &Arc<PlanRelay>,
    mut exited: impl FnMut() -> bool,
) {
    let mut connections: Vec<JoinHandle<()>> = Vec::new();
    let mut connection = 0;
    while !stop.load(Ordering::Acquire) && !exited() {
        let mut index = 0;
        while index < connections.len() {
            if connections[index].is_finished() {
                let _ = connections.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        match listener.accept() {
            Ok((stream, _)) => {
                connection += 1;
                let stop = stop.clone();
                let observer = observer.clone();
                let plans = plans.clone();
                connections.push(thread::spawn(move || {
                    let _ = forward(stream, upstream, connection, &stop, &observer, &plans);
                    plans.detach(connection);
                }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        thread::sleep(Duration::from_millis(5));
    }
    stop.store(true, Ordering::Release);
    for connection in connections {
        let _ = connection.join();
    }
}

fn forward(
    stream: TcpStream,
    upstream: std::net::SocketAddr,
    connection: u64,
    stop: &AtomicBool,
    observer: &Observer,
    plans: &Arc<PlanRelay>,
) -> Result<()> {
    // Windows accepted sockets inherit the listener's non-blocking mode, and a
    // cold-started TUI may send its upgrade request late. Retry the handshake
    // until a deadline while still honoring shutdown.
    stream.set_nonblocking(true)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut handshake = tungstenite::accept(stream);
    let mut client = loop {
        match handshake {
            Ok(client) => break client,
            Err(tungstenite::HandshakeError::Interrupted(mid)) => {
                anyhow::ensure!(
                    !stop.load(Ordering::Acquire) && Instant::now() < deadline,
                    "TUI WebSocket handshake did not complete"
                );
                thread::sleep(Duration::from_millis(5));
                handshake = mid.handshake();
            }
            Err(tungstenite::HandshakeError::Failure(error)) => return Err(error.into()),
        }
    };
    // Bound the upstream handshake so a stalled server cannot prevent shutdown.
    let timeout = Some(Duration::from_millis(250));
    let stream = TcpStream::connect_timeout(&upstream, Duration::from_millis(250))?;
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;
    let (mut server, _) = tungstenite::client(format!("ws://{upstream}"), stream)?;
    client.get_mut().set_nonblocking(true)?;
    server.get_mut().set_nonblocking(true)?;
    let replies = plans.attach(connection);
    let relay = plans.clone();
    while !stop.load(Ordering::Acquire) {
        // Drain native TUI answers before processing a notice answer.
        if !forward_frame(&mut client, &mut server, connection, "client", &observer, &relay)
            || !forward_frame(&mut server, &mut client, connection, "server", &observer, &relay)
        {
            break;
        }
        for reply in replies.try_iter() {
            let result = relay.take_response(connection, &reply).and_then(|response| {
                match server.send(Message::Text(response.to_string().into())) {
                    Ok(()) => Ok(()),
                    Err(error) if would_block(&error) => Ok(()),
                    Err(error) => Err(error.into()),
                }
            }).map_err(|error| error.to_string());
            let _ = reply.done.send(result);
        }
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn would_block(error: &WsError) -> bool {
    matches!(error, WsError::Io(e) if e.kind() == std::io::ErrorKind::WouldBlock)
}

fn forward_frame(
    source: &mut WebSocket<TcpStream>,
    target: &mut WebSocket<TcpStream>,
    connection: u64,
    direction: &str,
    observer: &Observer,
    plans: &PlanRelay,
) -> bool {
    // Drain queued bytes before reading another frame from this direction.
    if let Err(error) = target.flush() {
        return would_block(&error);
    }
    match source.read() {
        Ok(message @ (Message::Text(_) | Message::Binary(_))) => {
            if let Message::Text(text) = &message {
                if let Ok(value) = serde_json::from_str::<Value>(text) {
                    if !plans.observe(connection, direction, &value) { return true }
                }
                observe(observer, connection, direction, text);
            }
            match target.send(message) {
                Ok(()) => true,
                Err(error) => would_block(&error),
            }
        }
        Ok(Message::Close(frame)) => {
            let _ = target.close(frame);
            false
        }
        // tungstenite queues pong responses; the reverse direction flushes them.
        Ok(_) => true,
        Err(error) => would_block(&error),
    }
}

#[cfg(windows)]
struct ProcessJob(usize);

#[cfg(windows)]
impl ProcessJob {
    fn attach(child: &Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            anyhow::ensure!(
                !handle.is_null(),
                "create Codex process job: {}",
                std::io::Error::last_os_error()
            );
            let job = Self(handle as usize);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            anyhow::ensure!(
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32
                ) != 0,
                "configure Codex process job: {}",
                std::io::Error::last_os_error()
            );
            anyhow::ensure!(
                AssignProcessToJobObject(handle, child.as_raw_handle()) != 0,
                "attach Codex process job: {}",
                std::io::Error::last_os_error()
            );
            Ok(job)
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

fn reap(child: &mut Child) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.wait();
            return;
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn stub(observer: Observer) -> CodexBridge {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let native = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        native.set_nonblocking(true).unwrap();
        let upstream = native.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = stop.clone();
        let plans = Arc::new(PlanRelay::default());
        let worker_plans = plans.clone();
        let worker = thread::spawn(move || {
            let native_stop = worker_stop.clone();
            let native_worker = thread::spawn(move || {
                let mut clients = Vec::new();
                while !native_stop.load(Ordering::Acquire) {
                    if let Ok((stream, _)) = native.accept() {
                        let stop = native_stop.clone();
                        clients.push(thread::spawn(move || {
                            stream
                                .set_read_timeout(Some(Duration::from_millis(250)))
                                .unwrap();
                            let Ok(mut ws) = tungstenite::accept(stream) else {
                                return;
                            };
                            ws.get_mut().set_nonblocking(true).unwrap();
                            while !stop.load(Ordering::Acquire) {
                                match ws.read() {
                                    Ok(message @ Message::Text(_)) => {
                                        ws.send(message).unwrap();
                                    }
                                    Ok(Message::Close(_)) => break,
                                    Err(error) if would_block(&error) => {}
                                    Ok(_) => {}
                                    Err(_) => break,
                                }
                                thread::sleep(Duration::from_millis(5));
                            }
                        }));
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                for client in clients {
                    client.join().unwrap();
                }
            });
            serve(listener, upstream, &worker_stop, &observer, &worker_plans, || false);
            native_worker.join().unwrap();
        });
        CodexBridge {
            endpoint,
            plans,
            stop,
            worker: Mutex::new(Some(worker)),
        }
    }

    #[test]
    fn forwards_ids_order_and_multiline_messages_without_secondary_requests() {
        let (tx, rx) = mpsc::channel();
        let bridge = stub(Arc::new(move |value| {
            let _ = tx.send(value);
        }));
        let address = bridge.endpoint().strip_prefix("ws://").unwrap();
        let stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let (mut ws, _) = tungstenite::client(bridge.endpoint(), stream).unwrap();
        let messages = [
            json!({"id":"initialize","method":"initialize","params":{}}),
            json!({"id":17,"result":{"text":"a\nb","kind":"approval"}}),
            json!({"method":"turn/diff/updated","params":{"diff":"+a\n-b"}}),
        ];
        for message in &messages {
            ws.send(Message::Text(message.to_string().into())).unwrap();
        }
        for expected in &messages {
            let Message::Text(text) = ws.read().unwrap() else {
                panic!("expected text");
            };
            assert_eq!(&serde_json::from_str::<Value>(&text).unwrap(), expected);
        }
        let events: Vec<_> = (0..6)
            .map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        for direction in ["client", "server"] {
            let values: Vec<_> = events
                .iter()
                .filter(|e| e["direction"] == direction)
                .map(|e| e["message"].clone())
                .collect();
            assert_eq!(values, messages);
        }
        ws.close(None).unwrap();
        bridge.shutdown();
        assert!(std::net::TcpStream::connect(address).is_err());
    }

    fn connect(bridge: &CodexBridge) -> WebSocket<TcpStream> {
        let stream = TcpStream::connect(bridge.endpoint().strip_prefix("ws://").unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        tungstenite::client(bridge.endpoint(), stream).unwrap().0
    }

    fn exchange(socket: &mut WebSocket<TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .unwrap();
        let Message::Text(reply) = socket.read().unwrap() else {
            panic!("expected reply");
        };
        assert_eq!(serde_json::from_str::<Value>(&reply).unwrap(), value);
    }

    #[test]
    fn plan_answers_keep_connection_and_native_request_id() {
        let bridge = stub(Arc::new(|_| {}));
        let mut main = connect(&bridge);
        let mut other = connect(&bridge);
        let request = json!({"id":"plan-7","method":"item/tool/requestUserInput","params":{"threadId":"native-thread","questions":[
            {"id":"scope","header":"范围","question":"选哪一个？","options":[{"label":"A","description":"推荐"}]},
            {"id":"notes","question":"补充？","options":null}
        ]}});
        exchange(&mut main, request.clone());
        exchange(&mut other, request.clone());
        let plans = bridge.plans.clone();
        assert!(plans.pending(1, &json!("plan-7")).is_some());
        let answer = thread::spawn(move || plans.reply(1, json!("plan-7"), HashMap::from([
            ("scope".into(), vec!["A".into()]), ("notes".into(), vec!["保留时长".into()])
        ])));
        let Message::Text(text) = main.read().unwrap() else { panic!("expected reply") };
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({"id":"plan-7","result":{"answers":{
            "scope":{"answers":["A"]},"notes":{"answers":["保留时长"]}
        }}}));
        answer.join().unwrap().unwrap();
        assert!(bridge.plans.pending(1, &json!("plan-7")).is_none());
        assert!(bridge.plans.pending(2, &json!("plan-7")).is_some());
        assert!(bridge.plans.reply(1, json!("plan-7"), HashMap::new()).is_err());
        // The TUI may race the notice. Its duplicate response must not reach Codex.
        main.send(Message::Text(json!({"id":"plan-7","result":{"answers":{}}}).to_string().into())).unwrap();
        exchange(&mut main, json!({"id":99,"method":"thread/list"}));
        exchange(&mut other, json!({"method":"serverRequest/resolved","params":{"threadId":"native-thread","requestId":"plan-7"}}));
        assert!(bridge.plans.pending(2, &json!("plan-7")).is_none());
        bridge.shutdown();
    }

    #[test]
    fn picker_connections_can_reopen_without_interrupting_the_main_tui() {
        let (tx, rx) = mpsc::channel();
        let bridge = stub(Arc::new(move |value| {
            tx.send(value).unwrap();
        }));
        let mut main = connect(&bridge);
        exchange(&mut main, json!({"id":1,"method":"initialize"}));
        for _ in 0..2 {
            let mut picker = connect(&bridge);
            exchange(&mut picker, json!({"id":1,"method":"initialize"}));
            exchange(&mut picker, json!({"id":2,"method":"thread/list"}));
            picker.close(None).unwrap();
            exchange(&mut main, json!({"id":2,"method":"thread/resume"}));
        }
        let events: Vec<_> = (0..14)
            .map(|_| rx.recv_timeout(Duration::from_secs(3)).unwrap())
            .collect();
        let connections: std::collections::HashSet<_> = events
            .iter()
            .filter(|event| {
                event["direction"] == "client" && event["message"]["method"] == "initialize"
            })
            .map(|event| event["connection"].as_u64().unwrap())
            .collect();
        assert_eq!(connections.len(), 3);
        bridge.shutdown();
    }

    #[test]
    fn partial_handshake_does_not_block_picker_or_shutdown() {
        let bridge = stub(Arc::new(|_| {}));
        let _partial =
            TcpStream::connect(bridge.endpoint().strip_prefix("ws://").unwrap()).unwrap();
        let mut picker = connect(&bridge);
        exchange(&mut picker, json!({"id":1,"method":"thread/list"}));
        let start = Instant::now();
        bridge.shutdown();
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn slow_client_handshake_is_not_dropped() {
        let bridge = stub(Arc::new(|_| {}));
        let stream = TcpStream::connect(bridge.endpoint().strip_prefix("ws://").unwrap()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        // A cold-started TUI may connect well before it sends the upgrade request.
        thread::sleep(Duration::from_millis(100));
        let (mut socket, _) = tungstenite::client(bridge.endpoint(), stream).unwrap();
        exchange(&mut socket, json!({"id":1,"method":"initialize"}));
        bridge.shutdown();
    }

    #[test]
    fn shutdown_before_connection_is_bounded_and_idempotent() {
        let bridge = stub(Arc::new(|_| {}));
        let start = Instant::now();
        bridge.shutdown();
        bridge.shutdown();
        assert!(start.elapsed() < Duration::from_secs(6));
    }

    #[test]
    fn missing_launcher_does_not_create_bridge() {
        assert!(CodexBridge::start(
            "nonexistent-codex-bridge-launcher",
            &[],
            &std::env::current_dir().unwrap(),
            &HashMap::new(),
            Arc::new(|_| {})
        )
        .is_err());
    }
}
