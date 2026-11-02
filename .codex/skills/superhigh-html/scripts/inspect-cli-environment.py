import argparse
import ctypes
import json
import os
from pathlib import Path
import re
import sys
from ctypes import wintypes


CONFIGURATION_KEYS = (
    "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "KIMI_CODE_HOME",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "GEMINI_API_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
)


def policy_keys():
    source = Path(__file__).resolve().parents[4] / "src-tauri/src/terminal.rs"
    match = re.search(r"const INHERITED_AGENT_VARIABLES:.*?= &\[(.*?)\];", source.read_text(encoding="utf-8"), re.S)
    if not match:
        raise RuntimeError("INHERITED_AGENT_VARIABLES was not found in terminal.rs")
    keys = re.findall(r'"([A-Z][A-Z0-9_]*)"', match.group(1))
    if not keys or len(keys) != len(set(keys)):
        raise RuntimeError("invalid inherited environment policy")
    return keys


def select_environment(environment, keys):
    model_keys = {key for key in keys if key.endswith(("_MODEL", "_MODEL_NAME"))}
    return {
        "models": {key: environment[key] for key in keys if key in model_keys and key in environment},
        "sessionMarkers": [key for key in keys if key not in model_keys and key in environment],
        "configurationKeysPresent": [key for key in CONFIGURATION_KEYS if key in environment],
    }


def inspect_process(pid, keys):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    native = ctypes.WinDLL("ntdll")
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    kernel.ReadProcessMemory.restype = wintypes.BOOL
    kernel.IsWow64Process.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
    kernel.IsWow64Process.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.GetProcessTimes.restype = wintypes.BOOL

    class BasicInfo(ctypes.Structure):
        _fields_ = [("reserved", ctypes.c_void_p), ("peb", ctypes.c_void_p), ("reserved2", ctypes.c_void_p * 2), ("pid", ctypes.c_size_t), ("reserved3", ctypes.c_void_p)]

    class MemoryInfo(ctypes.Structure):
        _fields_ = [("base", ctypes.c_void_p), ("allocation", ctypes.c_void_p), ("allocation_protect", wintypes.DWORD), ("partition", wintypes.WORD), ("size", ctypes.c_size_t), ("state", wintypes.DWORD), ("protect", wintypes.DWORD), ("kind", wintypes.DWORD)]

    native.NtQueryInformationProcess.argtypes = [wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG, ctypes.c_void_p]
    native.NtQueryInformationProcess.restype = wintypes.LONG
    kernel.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MemoryInfo), ctypes.c_size_t]
    kernel.VirtualQueryEx.restype = ctypes.c_size_t
    handle = kernel.OpenProcess(0x410, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        wow64 = wintypes.BOOL()
        if not kernel.IsWow64Process(handle, ctypes.byref(wow64)):
            raise ctypes.WinError(ctypes.get_last_error())
        if wow64.value:
            raise RuntimeError("32-bit target processes are not supported")

        def read(address, length):
            buffer = ctypes.create_string_buffer(length)
            count = ctypes.c_size_t()
            if not kernel.ReadProcessMemory(handle, address, buffer, length, ctypes.byref(count)):
                raise ctypes.WinError(ctypes.get_last_error())
            if count.value != length:
                raise RuntimeError("incomplete process memory read")
            return buffer.raw

        info = BasicInfo()
        status = native.NtQueryInformationProcess(handle, 0, ctypes.byref(info), ctypes.sizeof(info), None)
        if status:
            raise RuntimeError(f"NtQueryInformationProcess failed: {status}")
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(value) for value in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        parameters = int.from_bytes(read(info.peb + 0x20, 8), "little")
        address = int.from_bytes(read(parameters + 0x80, 8), "little")
        memory = MemoryInfo()
        if not kernel.VirtualQueryEx(handle, address, ctypes.byref(memory), ctypes.sizeof(memory)):
            raise ctypes.WinError(ctypes.get_last_error())
        length = min(memory.base + memory.size - address, 2 * 1024 * 1024)
        raw = read(address, length - length % 2)
        end = next((offset for offset in range(0, len(raw) - 3, 2) if raw[offset:offset + 4] == b"\0\0\0\0"), None)
        if end is None:
            raise RuntimeError("environment block is incomplete")
        entries = raw[:end].decode("utf-16-le", errors="strict").split("\0")
        environment = dict(entry.split("=", 1) for entry in entries if "=" in entry and not entry.startswith("="))
        return {
            "pid": pid,
            "startedAtFiletime": (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime,
            **select_environment(environment, keys),
        }
    finally:
        kernel.CloseHandle(handle)


def self_test(keys):
    os.environ["ANTHROPIC_MODEL"] = "environment-probe-model"
    os.environ["ANTHROPIC_API_KEY"] = "environment-probe-secret"
    os.environ["CLAUDE_CODE_MESSAGING_TOKEN"] = "environment-probe-session-secret"
    result = inspect_process(os.getpid(), keys)
    assert result["models"]["ANTHROPIC_MODEL"] == "environment-probe-model"
    assert "ANTHROPIC_API_KEY" in result["configurationKeysPresent"]
    assert "CLAUDE_CODE_MESSAGING_TOKEN" in result["sessionMarkers"]
    serialized = json.dumps(result)
    assert "environment-probe-secret" not in serialized
    assert "environment-probe-session-secret" not in serialized
    return {"processMemoryRead": True, "modelValueRead": True, "secretValuesExcluded": True}


def main():
    parser = argparse.ArgumentParser(description="Read selected CLI environment evidence from Windows x64 process memory without exposing credentials or changing the target process.")
    parser.add_argument("--pid", action="append", type=int, default=[], help="Exact process ID; repeat to compare a host and its CLI")
    parser.add_argument("--self-test", action="store_true", help="Verify process memory reading and secret filtering inside this Python process")
    parser.add_argument("--json", action="store_true", help="Emit compact JSON")
    args = parser.parse_args()
    if bool(args.pid) == args.self_test or any(pid <= 0 or pid > 0xFFFFFFFF for pid in args.pid):
        parser.error("provide positive 32-bit --pid values or --self-test")
    result = {"ok": True, "scope": "explicit Windows x64 PIDs; policy keys from src-tauri/src/terminal.rs", "complete": True}
    try:
        if os.name != "nt" or ctypes.sizeof(ctypes.c_void_p) != 8:
            raise RuntimeError("64-bit Python on Windows is required")
        keys = policy_keys()
        if args.self_test:
            result["checks"] = self_test(keys)
        else:
            result["processes"] = []
            for pid in dict.fromkeys(args.pid):
                try:
                    result["processes"].append(inspect_process(pid, keys))
                except Exception as error:
                    result["ok"] = result["complete"] = False
                    result["processes"].append({"pid": pid, "error": str(error)})
    except Exception as error:
        result.update(ok=False, complete=False, error=str(error))
    print(json.dumps(result, ensure_ascii=False, indent=None if args.json else 2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
