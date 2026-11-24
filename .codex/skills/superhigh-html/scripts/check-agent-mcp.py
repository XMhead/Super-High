"""Read-only probe of a deployed SuperHigh stdio MCP entry and desktop bridge.

No tasks, sessions, client configuration, login or approval state are changed.
Task execution, native completion and desktop presentation need separate checks.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading

FIELD_CONSUMERS = {
    'ok': {'superhigh-html/references/mobile-usb.md': 'Decide whether stdio and read-only bridge acceptance passed.'},
    'scope': {'superhigh-html/references/mobile-usb.md': 'Limit acceptance to protocol and read-only operations rather than task execution or UI.'},
    'protocol': {'superhigh-html/references/mobile-usb.md': 'Identify the negotiated MCP protocol when diagnosing a handshake mismatch.'},
    'toolCount': {'superhigh-html/references/mobile-usb.md': 'Detect missing deployed tools before attempting feature acceptance.'},
    'sessionCount': {'superhigh-html/references/mobile-usb.md': 'Confirm the running desktop session bridge responds without creating a session.'},
    'taskCount': {'superhigh-html/references/mobile-usb.md': 'Confirm the read-only task bridge responds before separate task acceptance.'},
    'adbDeviceCount': {'superhigh-html/references/mobile-usb.md': 'Check USB and wireless ADB device discovery before real-device acceptance.'},
    'mobileTools': {'superhigh-html/references/mobile-usb.md': 'Check mobile tool discovery before using the desktop Agent.'},
    'error': {'superhigh-html/references/mobile-usb.md': 'Choose the failed handshake, schema or bridge path for diagnosis.'},
    'processId': {'superhigh-html/references/mobile-usb.md': 'Identify the exact probe process during task cleanup.'},
    'clientExitCode': {'superhigh-html/references/mobile-usb.md': 'Reject acceptance if the probe failed to exit normally.'},
    'processExited': {'superhigh-html/references/mobile-usb.md': 'Verify the probe process ended while preserving the desktop application.'},
}


class Client:
    def __init__(self, executable, timeout):
        self.timeout = timeout
        self.sequence = 0
        self.messages = queue.Queue()
        self.errors = tempfile.TemporaryFile(mode="w+b")
        try:
            self.process = subprocess.Popen(
                [str(executable), "mcp", "serve"], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=self.errors, text=True, encoding="utf-8",
                creationflags=0x08000000 if os.name == "nt" else 0,
            )
        except Exception:
            self.errors.close()
            raise
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            for line in self.process.stdout:
                self.messages.put(json.loads(line))
        except Exception as error:
            self.messages.put(error)
        finally:
            self.messages.put(None)

    def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        self.send({"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params})
        try:
            response = self.messages.get(timeout=self.timeout)
        except queue.Empty as error:
            raise RuntimeError(f"{method}: response timeout") from error
        if isinstance(response, Exception):
            raise RuntimeError("stdout contains invalid MCP JSON") from response
        if response is None:
            raise RuntimeError("MCP process exited before responding")
        if response.get("jsonrpc") != "2.0" or response.get("id") != self.sequence:
            raise RuntimeError("unexpected JSON-RPC response envelope")
        return response

    def call(self, name):
        response = self.request("tools/call", {"name": name, "arguments": {}})
        result = response.get("result", {})
        structured = result.get("structuredContent", {})
        if structured.get("ok") is not True or result.get("isError") is True:
            message = structured.get("error", {}).get("message", "MCP tool/desktop bridge failed")
            raise RuntimeError(f"{name}: {message}")
        text = result.get("content", [])
        if not text or json.loads(text[0].get("text", "")) != structured:
            raise RuntimeError("text and structuredContent disagree")
        return structured["result"]

    def close(self):
        try:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
            self.reader.join(timeout=2)
            return self.process.returncode
        finally:
            self.process.stdout.close()
            self.errors.close()


def probe(client, mobile=False):
    initialized = client.request("initialize", {
        "protocolVersion": "2025-11-25", "capabilities": {},
        "clientInfo": {"name": "superhigh-mcp-check", "version": "1"},
    })
    result = initialized.get("result", {})
    if result.get("serverInfo", {}).get("name") != "superhigh" or "tools" not in result.get("capabilities", {}):
        raise RuntimeError("unexpected MCP server or missing tools capability")
    client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    tools = client.request("tools/list", {}).get("result", {}).get("tools", [])
    names = {tool.get("name") for tool in tools}
    if not {"sessions_list", "tasks_list", "tasks_submit"}.issubset(names):
        raise RuntimeError("missing session/task tools")
    for tool in tools:
        if tool.get("inputSchema", {}).get("type") != "object":
            raise RuntimeError("tool is missing an object input schema")
    invalid = client.request("tools/call", {"name": "tasks_submit", "arguments": {}})
    if invalid.get("error", {}).get("code") != -32602:
        raise RuntimeError("invalid submission was not rejected before execution")
    sessions = client.call("sessions_list").get("sessions")
    tasks = client.call("tasks_list").get("tasks")
    if not isinstance(sessions, list) or not isinstance(tasks, list):
        raise RuntimeError("desktop read-only response has an invalid shape")
    if client.request("ping", {}).get("result") != {}:
        raise RuntimeError("ping failed after tool calls")
    report = {"protocol": result.get("protocolVersion"), "toolCount": len(tools),
              "sessionCount": len(sessions), "taskCount": len(tasks)}
    if mobile:
        required = {"mobile_status", "mobile_connect", "mobile_reload", "mobile_update",
                    "mobile_debug_start", "mobile_debug_status", "mobile_debug_stop", "mobile_disconnect"}
        if not required.issubset(names):
            raise RuntimeError("missing ADB mobile tools")
        invalid = client.request("tools/call", {"name": "mobile_update", "arguments": {}})
        if invalid.get("error", {}).get("code") != -32602:
            raise RuntimeError("invalid APK update was not rejected before execution")
        phone = client.call("mobile_status")
        if not isinstance(phone.get("devices"), list) or not isinstance(phone.get("debug"), list):
            raise RuntimeError("invalid real ADB status response")
        report.update(adbDeviceCount=len(phone["devices"]), mobileTools=len(required))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", required=True, type=Path, help="Absolute deployed superhigh-cli executable path")
    parser.add_argument("--timeout", type=float, default=50, help="Per-response timeout in seconds (1..60)")
    parser.add_argument("--output", type=Path, help="Optional UTF-8 JSON evidence file")
    parser.add_argument("--mobile", action="store_true", help="Also validate USB tools and read real phone status; never update or launch")
    args = parser.parse_args()
    if not args.cli.is_absolute() or not args.cli.is_file() or not 1 <= args.timeout <= 60:
        parser.error("--cli must name an existing absolute file; --timeout must be between 1 and 60")
    report = {"ok": False, "scope": "stdio protocol and read-only desktop bridge; excludes task execution and UI"}
    client = None
    try:
        client = Client(args.cli, args.timeout)
        report.update(probe(client, args.mobile))
        report["ok"] = True
    except Exception as error:
        report["error"] = str(error)
    finally:
        if client:
            report["processId"] = client.process.pid
            report["clientExitCode"] = client.close()
            report["processExited"] = client.process.poll() is not None
            report["ok"] = report["ok"] and report["clientExitCode"] == 0 and report["processExited"]
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
