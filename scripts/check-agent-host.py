"""Exercise a real detached PTY worker without making a model request (Windows)."""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid


def wait_for(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError("Timed out waiting for Agent host")


def identity(pid):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000 | 0x100000, False, pid)
    if not handle:
        return None
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return None
        if kernel.WaitForSingleObject(handle, 0) != 258:
            return None
        return {"pid": pid, "created": (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime}
    finally:
        kernel.CloseHandle(handle)


def rpc(record, operation, **params):
    with socket.create_connection(("127.0.0.1", record["port"]), timeout=15) as stream:
        stream.sendall((json.dumps({"token": record["token"], "operation": operation, "params": params}) + "\n").encode())
        response = json.loads(stream.makefile("rb").readline())
        assert response["ok"], response.get("error")
        return response.get("result")


def descendants(pid):
    raw = subprocess.check_output(["powershell.exe", "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"],
        creationflags=subprocess.CREATE_NO_WINDOW)
    processes = json.loads(raw)
    owned = {pid}
    while True:
        found = {p["ProcessId"] for p in processes if p["ParentProcessId"] in owned}
        if found <= owned:
            return [item for child in owned if (item := identity(child))]
        owned.update(found)


def window_visible(window):
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    return bool(user.IsWindowVisible(window))


def console_input(pid, text, direct=False):
    """Send real console input records to this test's native terminal only."""
    if not direct:
        result = subprocess.run([sys.executable, __file__, "--console-input", str(pid), text],
                                stdin=subprocess.DEVNULL, capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
        assert result.returncode == 0, result.stderr.decode(errors="replace")
        return
    class Character(ctypes.Union):
        _fields_ = [("UnicodeChar", wintypes.WCHAR), ("AsciiChar", ctypes.c_char)]
    class Key(ctypes.Structure):
        _fields_ = [("down", wintypes.BOOL), ("repeat", wintypes.WORD), ("key", wintypes.WORD),
                    ("scan", wintypes.WORD), ("character", Character), ("control", wintypes.DWORD)]
    class Event(ctypes.Union):
        _fields_ = [("key", Key), ("padding", ctypes.c_byte * 16)]
    class Record(ctypes.Structure):
        _fields_ = [("kind", wintypes.WORD), ("event", Event)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.WriteConsoleInputW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Record), wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.FreeConsole()
    assert kernel.AttachConsole(pid), ctypes.get_last_error()
    handle = kernel.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None)
    assert handle and handle != ctypes.c_void_p(-1).value
    try:
        records = []
        for char in text:
            for down in (True, False):
                item = Record()
                item.kind = 1
                item.event.key.down = down
                item.event.key.repeat = 1
                item.event.key.key = 13 if char == "\r" else 0
                item.event.key.character.UnicodeChar = char
                records.append(item)
        data = (Record * len(records))(*records)
        written = wintypes.DWORD()
        assert kernel.WriteConsoleInputW(handle, data, len(data), ctypes.byref(written))
        assert written.value == len(data)
    finally:
        kernel.CloseHandle(handle)
        kernel.FreeConsole()


def controller(cli, directory):
    spec = json.load(sys.stdin)
    worker = subprocess.Popen([cli, "__agent-host", directory], stdin=subprocess.PIPE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        worker.stdin.write(json.dumps(spec).encode())
        worker.stdin.close()
        wait_for(lambda: (Path(directory) / "state.json").is_file() or worker.poll() is not None, 35)
        if not (Path(directory) / "state.json").is_file():
            raise AssertionError((Path(directory) / "error.txt").read_text(encoding="utf-8"))
        print(worker.pid)
    except BaseException:
        if worker.poll() is None:
            subprocess.run(["taskkill", "/PID", str(worker.pid), "/T", "/F"], capture_output=True)
        worker.wait(timeout=15)
        raise


CHILD = """import os,sys
print('HOST_TEST_READY:'+str(os.getpid()),flush=True)
for line in sys.stdin:
    line=line.strip()
    if line=='exit': break
    if line=='flood':
        for i in range(12000): print(str(i)+':'+('x'*100))
        print('HOST_TEST_DRAINED',flush=True)
    else: print('HOST_TEST_ACK:'+line,flush=True)
"""


def exercise(cli, root, codex=False, native_console=False):
    session_id = str(uuid.uuid4())
    directory = root / session_id
    directory.mkdir(parents=True)
    program, args = sys.executable, ["-u", "-c", CHILD]
    if codex:
        launcher = shutil.which("codex.cmd") or shutil.which("codex.exe")
        assert launcher, "Codex CLI not installed"
        program, args = (("cmd.exe", ["/d", "/s", "/c", "call", launcher])
                         if launcher.lower().endswith(".cmd") else (launcher, []))
    spec = {"session": {"id": session_id, "title": "Agent host lifecycle check", "providerKind": "codex" if codex else "local",
                        "cwd": str(root), "readOnly": False},
            "workspace_id": "test", "project": str(root), "cwd": str(root), "env": {},
            "initial_input": None, "native_session_id": None, "data_dir": str(root / "data"),
            "launch": {"program": program, "args": args, "title": "Agent host lifecycle check",
                       "path_env": None, "superhigh_cli_path": str(cli)}}
    record = None
    child_identity = None
    owned = []
    console = None
    try:
        launch = subprocess.run([sys.executable, __file__, "--controller", str(cli), str(directory)],
                                input=json.dumps(spec).encode(), capture_output=True, timeout=40,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        assert launch.returncode == 0, launch.stderr.decode(errors="replace")
        record = json.loads((directory / "state.json").read_text(encoding="utf-8"))
        assert identity(record["process"]["pid"]) == record["process"]
        # The controller has already exited. Connect using the persisted identity.
        before = rpc(record, "status")
        assert before["running"] and before["holdsPtyChild"]
        child_identity = identity(before["processId"])
        assert child_identity
        if not codex:
            wait_for(lambda: "HOST_TEST_READY:" in rpc(record, "buffer")["buffer"])
        if native_console:
            owner = directory / "console-owner.json"
            owner.write_text(json.dumps(identity(os.getpid())), encoding="utf-8")
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 0
            console = subprocess.Popen([str(cli), "__agent-console", str(directory)],
                                       creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup)
            wait_for(lambda: (directory / "console.json").is_file())
            view = json.loads((directory / "console.json").read_text(encoding="utf-8"))
            assert not window_visible(view["window"])
            # Re-showing a claimed console must not create a second visible view.
            user = ctypes.WinDLL("user32", use_last_error=True)
            user.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
            user.ShowWindow(view["window"], 4)
            wait_for(lambda: not window_visible(view["window"]), 3)
            owner.unlink()
            wait_for(lambda: window_visible(view["window"]))
            if not codex:
                console_input(console.pid, "native-中文\r")
                wait_for(lambda: "HOST_TEST_ACK:native-中文" in rpc(record, "buffer")["buffer"])
            owner.write_text(json.dumps(identity(os.getpid())), encoding="utf-8")
            wait_for(lambda: not window_visible(view["window"]))
            assert rpc(record, "status")["processId"] == before["processId"]
        rpc(record, "resize", cols=91, rows=29, force=True)
        resized = rpc(record, "buffer")
        assert (resized["cols"], resized["rows"]) == (91, 29)
        if not codex:
            rpc(record, "input", input="flood\r")
            # No UI/output reader is connected during this burst (> history limit).
            time.sleep(1)
            drained = wait_for(lambda: (snap if "HOST_TEST_DRAINED" in (snap := rpc(record, "buffer"))["buffer"] else None))
            assert drained["startByte"] > 0 and len(drained["buffer"].encode()) <= 256 * 1024
            cursor = drained["endByte"]
            rpc(record, "input", input="reconnected\r")
            wait_for(lambda: "HOST_TEST_ACK:reconnected" in rpc(record, "buffer", after=cursor)["buffer"])
            assert rpc(record, "status")["processId"] == before["processId"]
            assert identity(before["processId"]) == child_identity
            owned = descendants(record["process"]["pid"])
            rpc(record, "input", input="exit\r")
            wait_for(lambda: identity(record["process"]["pid"]) is None, 15)
        else:
            # Boot the real app-server + remote TUI; no prompt/inference is sent.
            time.sleep(2)
            assert rpc(record, "status")["processId"] == before["processId"]
            owned = descendants(record["process"]["pid"])
            if native_console:
                owner.unlink()
                wait_for(lambda: window_visible(view["window"]))
                user = ctypes.WinDLL("user32", use_last_error=True)
                user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
                assert user.PostMessageW(view["window"], 0x0010, 0, 0)
            else:
                rpc(record, "terminate")
            wait_for(lambda: identity(record["process"]["pid"]) is None, 15)
        wait_for(lambda: identity(child_identity["pid"]) is None)
        for process in owned:
            wait_for(lambda: identity(process["pid"]) != process)
        if console:
            console.wait(timeout=15)
        print("PASS: " + ("Codex backend survives controller exit; explicit close reaps host" if codex else
                          "PTY survives controller exit; output drains; same PID reconnects; natural exit reaps host"))
        if native_console:
            print("PASS: native window stays hidden while attached, shows on detach, accepts input and exits with its Agent")
    finally:
        if record and identity(record["process"]["pid"]) == record["process"]:
            try:
                rpc(record, "terminate")
                wait_for(lambda: identity(record["process"]["pid"]) is None, 15)
            except Exception:
                subprocess.run(["taskkill", "/PID", str(record["process"]["pid"]), "/T", "/F"], capture_output=True)
                wait_for(lambda: identity(record["process"]["pid"]) is None)
        if child_identity:
            wait_for(lambda: identity(child_identity["pid"]) is None)
        for process in owned:
            wait_for(lambda: identity(process["pid"]) != process)
        if console and console.poll() is None:
            console.wait(timeout=15)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--console-input":
        console_input(int(sys.argv[2]), sys.argv[3], direct=True)
    elif len(sys.argv) > 1 and sys.argv[1] == "--controller":
        controller(sys.argv[2], sys.argv[3])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--cli", type=Path, required=True)
        parser.add_argument("--output", type=Path, required=True)
        parser.add_argument("--codex", action="store_true")
        parser.add_argument("--console", action="store_true")
        options = parser.parse_args()
        options.output.mkdir(parents=True, exist_ok=True)
        exercise(options.cli.resolve(), options.output.resolve(), native_console=options.console)
        if options.codex:
            exercise(options.cli.resolve(), options.output.resolve(), codex=True, native_console=options.console)
