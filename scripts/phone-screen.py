#!/usr/bin/env python3
"""Start the local Android screen viewer used by the Super High preview page."""
import argparse
import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def program(name):
    result = shutil.which(name)
    if not result and name == 'adb':
        result = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk', 'platform-tools', 'adb.exe')
    if not result or not os.path.isfile(result):
        raise RuntimeError(f'找不到 {name}，请安装后重试。')
    return result


def run(args, timeout=10):
    result = subprocess.run(args, capture_output=True, timeout=timeout, creationflags=FLAGS)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', 'replace').strip() or '手机操作失败')
    return result.stdout


class Viewer:
    def __init__(self):
        self.adb = program('adb')
        self.ffmpeg = program('ffmpeg')
        devices = run([self.adb, 'devices']).decode('utf-8', 'replace').splitlines()[1:]
        devices = [line.split()[0] for line in devices if len(line.split()) >= 2 and line.split()[1] == 'device']
        if len(devices) != 1:
            raise RuntimeError('请连接并授权一台 Android 手机；当前可用设备数：' + str(len(devices)))
        self.device = devices[0]
        self.token = secrets.token_urlsafe(24)
        self.last_seen = time.monotonic()
        self.frame = None
        self.frame_version = 0
        self.condition = threading.Condition()
        self.stopped = threading.Event()
        self.error = ''
        self.processes = []

    def adb_cmd(self, *args):
        return [self.adb, '-s', self.device, *args]

    def stream(self):
        try:
            capture = subprocess.Popen(self.adb_cmd('exec-out', 'screenrecord', '--output-format=h264', '--time-limit', '0', '-'), stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=FLAGS)
            self.processes.append(capture)
            encoder = subprocess.Popen([self.ffmpeg, '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0', '-flags', 'low_delay', '-threads', '1', '-f', 'h264', '-i', 'pipe:0', '-q:v', '5', '-threads', '1', '-f', 'image2pipe', '-flush_packets', '1', '-vcodec', 'mjpeg', 'pipe:1'], stdin=capture.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=FLAGS)
            self.processes.append(encoder)
            capture.stdout.close()
            data = bytearray()
            while not self.stopped.is_set():
                chunk = encoder.stdout.read1(65536)
                if not chunk:
                    break
                data.extend(chunk)
                while True:
                    start = data.find(b'\xff\xd8')
                    if start < 0:
                        data.clear()
                        break
                    end = data.find(b'\xff\xd9', start + 2)
                    if end < 0:
                        if start: del data[:start]
                        break
                    frame = bytes(data[start:end + 2])
                    del data[:end + 2]
                    with self.condition:
                        self.frame = frame
                        self.frame_version += 1
                        self.condition.notify_all()
            if not self.stopped.is_set():
                detail = encoder.stderr.read().decode('utf-8', 'replace').strip()
                if capture.poll() is not None: detail += ' ' + capture.stderr.read().decode('utf-8', 'replace').strip()
                self.error = '手机视频流已中断，请重试。' + detail[:500]
        except Exception as exc:
            self.error = str(exc)
        finally:
            with self.condition: self.condition.notify_all()

    def close(self):
        self.stopped.set()
        for process in reversed(self.processes):
            if process.poll() is None: process.terminate()
        for process in reversed(self.processes):
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        with self.condition: self.condition.notify_all()


def serve():
    viewer = Viewer()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_): pass

        def allowed(self):
            query = parse_qs(urlsplit(self.path).query)
            return secrets.compare_digest(query.get('token', [''])[0], viewer.token)

        def reply(self, value, status=200):
            body = json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', 'null')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.allowed(): return self.reply({'error': '连接已失效'}, 403)
            path = urlsplit(self.path).path
            if path == '/status':
                viewer.last_seen = time.monotonic()
                return self.reply({'ready': viewer.frame is not None, 'error': viewer.error, 'device': viewer.device})
            if path != '/stream': return self.reply({'error': '未知请求'}, 404)
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Access-Control-Allow-Origin', 'null')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            version = 0
            try:
                while not viewer.stopped.is_set():
                    with viewer.condition:
                        viewer.condition.wait_for(lambda: viewer.frame_version != version or viewer.stopped.is_set() or viewer.error, timeout=3)
                        if viewer.error or viewer.stopped.is_set(): return
                        if viewer.frame_version == version: continue
                        version, frame = viewer.frame_version, viewer.frame
                    self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + str(len(frame)).encode() + b'\r\n\r\n' + frame + b'\r\n')
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError): pass

        def do_POST(self):
            if not self.allowed(): return self.reply({'error': '连接已失效'}, 403)
            path = urlsplit(self.path).path
            if path == '/stop':
                self.reply({'ok': True})
                threading.Thread(target=server.shutdown, daemon=True).start()
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > 1024: raise ValueError('参数过长')
                data = json.loads(self.rfile.read(length))
                if path == '/touch':
                    coords = [float(data[k]) for k in ('x1', 'y1', 'x2', 'y2')]
                    if any(not 0 <= value <= 1 for value in coords): raise ValueError('坐标无效')
                    size = run(viewer.adb_cmd('shell', 'wm', 'size')).decode('utf-8', 'replace').strip().splitlines()[-1].split(':')[-1].strip()
                    width, height = map(int, size.split('x'))
                    if bool(data.get('landscape')) != (width > height): width, height = height, width
                    x1, y1, x2, y2 = [round(v * limit) for v, limit in zip(coords, (width - 1, height - 1, width - 1, height - 1))]
                    duration = max(50, min(3000, int(data.get('duration', 100))))
                    action = ['tap', str(x1), str(y1)] if abs(x1-x2) + abs(y1-y2) < 10 and duration < 400 else ['swipe', str(x1), str(y1), str(x2), str(y2), str(duration)]
                    run(viewer.adb_cmd('shell', 'input', *action))
                elif path == '/key':
                    key = str(data.get('key', ''))
                    if key not in ('BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL', 'TAB', 'SPACE', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT'): raise ValueError('按键无效')
                    run(viewer.adb_cmd('shell', 'input', 'keyevent', 'KEYCODE_' + key))
                else: return self.reply({'error': '未知请求'}, 404)
                viewer.last_seen = time.monotonic()
                self.reply({'ok': True})
            except Exception as exc: self.reply({'error': str(exc)}, 400)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    print(json.dumps({'port': server.server_port, 'token': viewer.token, 'pid': os.getpid()}), flush=True)
    threading.Thread(target=viewer.stream, daemon=True).start()
    def monitor():
        while not viewer.stopped.wait(5):
            if time.monotonic() - viewer.last_seen > 20:
                server.shutdown()
                return
    threading.Thread(target=monitor, daemon=True).start()
    try: server.serve_forever(poll_interval=0.2)
    finally:
        viewer.close()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--serve', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.serve: return serve()
    child = subprocess.Popen([sys.executable, os.path.abspath(__file__), '--serve'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=FLAGS)
    line = child.stdout.readline()
    if not line:
        error = child.stderr.read().decode('utf-8', 'replace')
        child.wait()
        raise RuntimeError(error.strip().splitlines()[-1] if error else '手机画面启动失败')
    print(line.decode('utf-8').strip())
    child.stdout.close()
    child.stderr.close()


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
