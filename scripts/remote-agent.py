"""
Super High Remote Agent — 远程文件代理
========================================
在远程 Windows 服务器上运行，通过 HTTP 暴露文件操作 API。
本机 Super High 通过 Tailscale 虚拟 IP 连接。
只能使用 Python 标准库，无需 pip 安装。

启动方式:
  python remote-agent.py --port 10310 --token "你的密码" --root "E:\你的目录"

然后本机访问: http://<Tailscale IP>:10310
"""

import argparse
import base64
import fnmatch
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ── Token 认证 ──────────────────────────────────────────────

AUTH_TOKEN = None
ROOT_PATH = None
IGNORED_DIRS = {".git", "node_modules", "target", "dist", "build", "logs",
                ".superhigh", "coverage", ".vite", ".turbo", ".next", "out",
                "skills-backup", "__pycache__", ".venv", "venv", ".idea", ".vscode"}

MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB 文本文件上限


def check_auth(handler):
    """验证 Bearer token，失败返回 401"""
    auth = handler.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        handler.send_response(401)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "Missing token"}, ensure_ascii=False).encode("utf-8"))
        return False
    token = auth[7:]
    if token != AUTH_TOKEN:
        handler.send_response(403)
        handler.send_header("Content-Type", "application/json")
        handler.end_headers()
        handler.wfile.write(json.dumps({"error": "Invalid token"}, ensure_ascii=False).encode("utf-8"))
        return False
    return True


def safe_path(rel_path: str) -> Path:
    """将 URL 路径解析为 ROOT 下的安全绝对路径，防止目录遍历攻击"""
    # 去掉首尾 /
    rel = rel_path.strip("/")
    # URL decode
    rel = urllib.parse.unquote(rel)
    # resolve 防止 .. 穿越
    target = (ROOT_PATH / rel).resolve()
    if not str(target).startswith(str(ROOT_PATH.resolve())):
        raise ValueError("路径越界")
    return target


def path_to_rel(abs_path: Path) -> str:
    """绝对路径转 ROOT 相对路径"""
    try:
        return str(abs_path.relative_to(ROOT_PATH.resolve())).replace("\\", "/")
    except ValueError:
        return str(abs_path).replace("\\", "/")


def is_text_file(path: Path) -> bool:
    """判断是否为文本文件"""
    ext = path.suffix.lower()
    binary_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".dll", ".exe",
                   ".zip", ".7z", ".rar", ".tar", ".gz", ".pdf", ".jar", ".class",
                   ".dat", ".db", ".sqlite", ".mca", ".mcr", ".nbt", ".so", ".dylib",
                   ".pyd", ".bin", ".mp3", ".mp4", ".avi", ".mkv", ".ttf", ".woff", ".woff2"}
    return ext not in binary_exts


def should_visit(path: Path) -> bool:
    """是否遍历该目录"""
    return path.name not in IGNORED_DIRS and not path.name.startswith(".")


# ── API Handler ─────────────────────────────────────────────

class RemoteAgentHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        """简洁日志"""
        print(f"[{time.strftime('%H:%M:%S')}] {args[0]}")

    def _json(self, data, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"))

    def _text(self, text: str, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(text.encode("utf-8"))

    def _error(self, msg, status=400):
        self._json({"error": msg}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, DELETE, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    # ── GET /api/status ──────────────────────────────────────
    def do_GET(self):
        if not check_auth(self):
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/status":
            self._json({
                "status": "ok",
                "root": str(ROOT_PATH.resolve()),
                "serverTime": int(time.time()),
            })
            return

        # GET /api/dirs/<path> — 列目录
        if path.startswith("/api/dirs/"):
            rel = path[len("/api/dirs/"):]
            try:
                target = safe_path(rel) if rel else ROOT_PATH
            except ValueError:
                return self._error("路径越界", 403)

            if not target.exists():
                return self._error("目录不存在", 404)
            if not target.is_dir():
                return self._error("不是目录", 400)

            entries = []
            try:
                for item in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                    if not should_visit(item):
                        continue
                    try:
                        st = item.stat()
                        entries.append({
                            "name": item.name,
                            "path": path_to_rel(item),
                            "type": "directory" if item.is_dir() else "file",
                            "extension": item.suffix if item.is_file() else None,
                            "size": st.st_size if item.is_file() else None,
                            "modified": int(st.st_mtime * 1000),
                            "isHidden": item.name.startswith("."),
                        })
                    except OSError:
                        continue
            except PermissionError:
                return self._error("权限不足", 403)

            self._json({
                "path": path_to_rel(target),
                "entries": entries,
            })
            return

        # GET /api/files/<path> — 读文件
        if path.startswith("/api/files/"):
            rel = path[len("/api/files/"):]
            try:
                target = safe_path(rel)
            except ValueError:
                return self._error("路径越界", 403)

            if not target.exists():
                return self._error("文件不存在", 404)
            if not target.is_file():
                return self._error("不是文件", 400)
            if target.stat().st_size > MAX_FILE_BYTES:
                return self._error(f"文件过大（>{MAX_FILE_BYTES // 1024 // 1024}MB）", 413)
            if not is_text_file(target):
                return self._error("不是文本文件", 415)

            try:
                content = target.read_text(encoding="utf-8")
                self._text(content)
            except UnicodeDecodeError:
                try:
                    content = target.read_text(encoding="gbk")
                    self._text(content)
                except Exception:
                    return self._error("无法解码文件", 415)
            except PermissionError:
                return self._error("权限不足", 403)
            return

        # GET /api/search — 搜索文件
        if path == "/api/search":
            qs = urllib.parse.parse_qs(parsed.query)
            query = qs.get("q", [""])[0].strip().lower()
            if not query:
                return self._error("缺少查询参数 ?q=", 400)

            files = []
            text_matches = []
            limit = 80

            for dirpath, dirnames, filenames in os.walk(ROOT_PATH.resolve()):
                dirnames[:] = [d for d in dirnames if should_visit(Path(dirpath) / d)]
                for fname in filenames:
                    full = Path(dirpath) / fname
                    rel = path_to_rel(full)
                    if query in fname.lower() and len(files) < limit:
                        files.append({"path": str(full), "relativePath": rel, "name": fname})
                    if is_text_file(full) and full.stat().st_size <= MAX_FILE_BYTES and len(text_matches) < limit:
                        try:
                            for i, line in enumerate(full.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                                if query in line.lower() and len(text_matches) < limit:
                                    text_matches.append({
                                        "path": str(full), "relativePath": rel,
                                        "lineNumber": i, "column": line.lower().index(query) + 1,
                                        "preview": line.strip()[:200],
                                    })
                        except Exception:
                            continue

            self._json({"files": files, "textMatches": text_matches})
            return

        return self._error("Not Found", 404)

    # ── PUT /api/files/<path> — 写文件 ───────────────────────
    def do_PUT(self):
        if not check_auth(self):
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path.startswith("/api/files/"):
            rel = path[len("/api/files/"):]
            try:
                target = safe_path(rel)
            except ValueError:
                return self._error("路径越界", 403)

            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)

            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
                self._json({"ok": True, "path": path_to_rel(target), "bytes": len(body)})
            except PermissionError:
                return self._error("权限不足", 403)
            except Exception as e:
                return self._error(str(e), 500)
            return

        return self._error("Not Found", 404)

    # ── DELETE /api/files/<path> — 删除文件/目录 ─────────────
    def do_DELETE(self):
        if not check_auth(self):
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path.startswith("/api/files/"):
            rel = path[len("/api/files/"):]
            try:
                target = safe_path(rel)
            except ValueError:
                return self._error("路径越界", 403)

            if not target.exists():
                return self._error("路径不存在", 404)

            try:
                if target.is_dir():
                    shutil.rmtree(target)
                else:
                    target.unlink()
                self._json({"ok": True, "deleted": path_to_rel(target)})
            except PermissionError:
                return self._error("权限不足", 403)
            except Exception as e:
                return self._error(str(e), 500)
            return

        return self._error("Not Found", 404)

    # ── POST /api/dirs/<path> — 创建目录 ─────────────────────
    # ── POST /api/rename — 重命名 ────────────────────────────
    def do_POST(self):
        if not check_auth(self):
            return

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")

        # POST /api/dirs/<path>
        if path.startswith("/api/dirs/"):
            rel = path[len("/api/dirs/"):]
            try:
                target = safe_path(rel)
            except ValueError:
                return self._error("路径越界", 403)

            try:
                target.mkdir(parents=True, exist_ok=True)
                self._json({"ok": True, "created": path_to_rel(target)})
            except PermissionError:
                return self._error("权限不足", 403)
            except Exception as e:
                return self._error(str(e), 500)
            return

        # POST /api/rename
        if path == "/api/rename":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            from_rel = body.get("from", "")
            to_rel = body.get("to", "")
            if not from_rel or not to_rel:
                return self._error("缺少 from/to 参数", 400)
            try:
                src = safe_path(from_rel)
                dst = safe_path(to_rel)
            except ValueError:
                return self._error("路径越界", 403)
            if not src.exists():
                return self._error("源路径不存在", 404)
            try:
                dst.parent.mkdir(parents=True, exist_ok=True)
                src.rename(dst)
                self._json({"ok": True, "from": path_to_rel(src), "to": path_to_rel(dst)})
            except PermissionError:
                return self._error("权限不足", 403)
            except Exception as e:
                return self._error(str(e), 500)
            return

        return self._error("Not Found", 404)


# ── 主入口 ──────────────────────────────────────────────────

def main():
    global AUTH_TOKEN, ROOT_PATH

    parser = argparse.ArgumentParser(description="Super High Remote Agent")
    parser.add_argument("--port", type=int, default=10310, help="监听端口 (默认 10310)")
    parser.add_argument("--token", required=True, help="认证令牌")
    parser.add_argument("--root", required=True, help="暴露的根目录路径")
    parser.add_argument("--bind", default="0.0.0.0", help="绑定地址 (默认 0.0.0.0)")
    args = parser.parse_args()

    AUTH_TOKEN = args.token
    ROOT_PATH = Path(args.root).resolve()

    if not ROOT_PATH.exists():
        print(f"错误：根目录不存在 - {ROOT_PATH}")
        sys.exit(1)
    if not ROOT_PATH.is_dir():
        print(f"错误：根路径不是目录 - {ROOT_PATH}")
        sys.exit(1)

    server = HTTPServer((args.bind, args.port), RemoteAgentHandler)

    print(f"╔══════════════════════════════════════════╗")
    print(f"║   Super High Remote Agent               ║")
    print(f"╠══════════════════════════════════════════╣")
    print(f"║  Root : {str(ROOT_PATH):<33} ║")
    print(f"║  Port : {args.port:<33} ║")
    print(f"║  Bind : {args.bind:<33} ║")
    print(f"╚══════════════════════════════════════════╝")
    print(f"  本机连接: http://<Tailscale IP>:{args.port}")
    print(f"  Ctrl+C 停止")
    print()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        server.shutdown()


if __name__ == "__main__":
    main()
