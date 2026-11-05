"""Local static server + optional UDP bridge. Python 3.10+, standard library only."""
import argparse
import ipaddress
import json
import math
from pathlib import Path
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from protocol import WATCHDOG_SECONDS

ROOT = Path(__file__).resolve().parent
ASSETS = {"/": ("index.html", "text/html; charset=utf-8"), "/index.html": ("index.html", "text/html; charset=utf-8"), "/style.css": ("style.css", "text/css"), "/app.js": ("app.js", "text/javascript"), "/analysis.js": ("analysis.js", "text/javascript"), "/feature-worklet.js": ("feature-worklet.js", "text/javascript")}
ASSETS.update({f"/{name}": (name, "text/javascript") for name in ("comparison.js", "comparison-ui.js", "comparison-worker.js")})


class Bridge:
    def __init__(self, target=None):
        self.target = target
        self.loopback = bool(target and ipaddress.ip_address(target[0]).is_loopback)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM) if target else None
        if self.sock:
            self.sock.bind(("0.0.0.0", 0))
            self.sock.setblocking(False)
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.active = False
        self.token = self.session = None
        self.wire_seq = 0
        self.browser_seq = -1
        self.last_seen = self.started = 0
        self.last_ack = None
        self.last_ack_seq = None
        self.receiver_mode = "unknown"
        self.speed = self.turn = 0.0
        self.reason = "送信オフ"
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def status(self):
        with self.lock:
            return {"target": f"{self.target[0]}:{self.target[1]}" if self.target else None, "loopback": self.loopback, "active": self.active, "reason": self.reason, "last_ack_seq": self.last_ack_seq, "ack_age_ms": round((time.monotonic() - self.last_ack) * 1000) if self.last_ack else None, "receiver_mode": self.receiver_mode}

    def arm(self, source):
        with self.lock:
            if not self.target:
                raise ValueError("UDP通信先が未設定です。--robot-host を指定してください。")
            if source not in ("live", "demo", "file") or source != "live" and not self.loopback:
                raise ValueError("デモ・ファイル再生はPC内の受信テストにのみ送信できます。")
            self._stop("新しい送信セッション")
            self.token, self.session = secrets.token_hex(16), secrets.token_hex(4)
            self.active = True
            self.wire_seq, self.browser_seq = 0, -1
            self.speed = self.turn = 0
            self.last_ack = self.last_ack_seq = None
            self.receiver_mode = "unknown"
            self.started = self.last_seen = time.monotonic()
            self.reason = "受信応答を待機中"
            self._send(False)
            return {"token": self.token, **self.status()}

    def command(self, body):
        with self.lock:
            if not self.active or body.get("token") != self.token:
                raise ValueError("送信セッションが無効です。送信を開始し直してください。")
            seq, speed, turn = body.get("seq"), body.get("speed"), body.get("turn")
            valid = type(seq) is int and 0 <= seq < 2**32 and all(type(v) in (int, float) and math.isfinite(v) for v in (speed, turn))
            if not valid or not (0 <= speed <= .6 and -.6 <= turn <= .6):
                self._stop("不正な指令を受信")
                raise ValueError("指令は範囲内の有限数で指定してください。")
            if seq <= self.browser_seq:
                raise ValueError("古い指令は受け付けません。")
            if time.monotonic() - self.last_seen > WATCHDOG_SECONDS:
                self._stop("ブラウザの更新が途絶えました")
                raise ValueError(self.reason)
            self.browser_seq, self.speed, self.turn = seq, speed, turn
            self.last_seen = time.monotonic()
            return self.status()

    def stop(self, token):
        with self.lock:
            if token == self.token:
                self._stop("送信を停止しました")
            return self.status()

    def _send(self, enabled):
        if not self.target or not self.session:
            return
        self.wire_seq += 1
        speed, turn = (self.speed, self.turn) if enabled else (0, 0)
        packet = f"G3,1,{self.session},{self.wire_seq},{int(enabled)},{speed:.4f},{turn:.4f}\n".encode("ascii")
        self.sock.sendto(packet, self.target)

    def _stop(self, reason):
        self.active = False
        self.speed = self.turn = 0
        self.token = None
        self.reason = reason
        try:
            self._send(False)
        except OSError:
            pass  # Receiver watchdog is the final stop when the link is unavailable.

    def _read_acks(self):
        if not self.sock:
            return
        for _ in range(32):
            try:
                packet, address = self.sock.recvfrom(256)
            except BlockingIOError:
                return
            if address != self.target:
                continue
            try:
                fields = packet.decode("ascii").strip().split(",")
                if len(fields) != 5 or fields[:2] != ["G3ACK", "1"] or fields[2] != self.session or fields[4] not in ("SIM", "DRY", "RUN"):
                    continue
                seq = int(fields[3])
                if seq > self.wire_seq or seq <= (self.last_ack_seq or 0):
                    continue
                self.last_ack_seq, self.last_ack = seq, time.monotonic()
                self.receiver_mode = fields[4]
            except (UnicodeDecodeError, ValueError):
                continue

    def _run(self):
        while not self.closed.wait(.05):
            with self.lock:
                try:
                    self._read_acks()
                    if not self.active:
                        continue
                    now = time.monotonic()
                    if now - self.last_seen > WATCHDOG_SECONDS:
                        self._stop("ブラウザの更新が350 ms以上途絶えました")
                    elif now - (self.last_ack or self.started) > .5:
                        self._stop("UDP受信応答が500 ms以上ありません")
                    else:
                        # Never send nonzero commands before the zero-handshake ACK.
                        self._send(self.last_ack is not None)
                except OSError as error:
                    self._stop(f"UDP通信エラー: {error}")

    def close(self):
        self.closed.set()
        self.thread.join(timeout=1)
        with self.lock:
            self._stop("サーバー終了")
            if self.sock:
                self.sock.close()


def make_server(port=8000, bridge=None):
    bridge = bridge or Bridge()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def local_request(self):
            host = self.headers.get("Host", "")
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            origin = self.headers.get("Origin")
            return host in allowed and (not origin or origin == f"http://{host}")

        def reply(self, code, payload, content_type="application/json"):
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8") if content_type == "application/json" else payload
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            if not self.local_request():
                self.reply(403, {"error": "localhostから利用してください。"})
                return
            path = urlsplit(self.path).path
            if path == "/api/status":
                self.reply(200, bridge.status())
            elif path in ASSETS:
                file, mime = ASSETS[path]
                self.reply(200, (ROOT / file).read_bytes(), mime)
            elif path == "/favicon.ico":
                self.reply(204, b"", "image/x-icon")
            else:
                self.reply(404, {"error": "Not found"})

        def do_POST(self):
            if not self.local_request():
                self.reply(403, {"error": "同じlocalhostページから操作してください。"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096 or self.headers.get("Content-Type") != "application/json":
                    raise ValueError("JSON形式で指定してください。")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("JSONオブジェクトを指定してください。")
                if self.path == "/api/arm":
                    data = bridge.arm(body.get("source"))
                elif self.path == "/api/command":
                    data = bridge.command(body)
                elif self.path == "/api/stop":
                    data = bridge.stop(body.get("token"))
                else:
                    self.reply(404, {"error": "Not found"})
                    return
                self.reply(200, data)
            except (ValueError, TypeError, OSError) as error:
                self.reply(400, {"error": str(error)})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler), bridge


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--robot-host", help="UDP受信機のIPv4アドレス。未指定ならシミュレーターのみ。")
    parser.add_argument("--robot-port", type=int, default=9000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.robot_port <= 65535:
        parser.error("ポート番号は1〜65535で指定してください。")
    target = None
    if args.robot_host:
        try:
            target = (str(ipaddress.IPv4Address(args.robot_host)), args.robot_port)
        except ipaddress.AddressValueError:
            parser.error("--robot-host はIPv4アドレスで指定してください。")
    bridge = Bridge(target)
    try:
        server, _ = make_server(args.port, bridge)
        print(f"Guitar Motion Lab: http://127.0.0.1:{server.server_port}", flush=True)
        print("停止: Ctrl+C / UDP: " + (f"{target[0]}:{target[1]}" if target else "未設定（シミュレーターのみ）"), flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.close()


if __name__ == "__main__":
    main()
