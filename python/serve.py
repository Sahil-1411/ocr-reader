#!/usr/bin/env python3
"""
Serve the PP-OCR reader to the browser app.

The app reads receipts in the browser with Tesseract. PP-OCR reads them more
accurately — measured against `fixtures/ground-truth.json`, all 48 inventory
count rows exact against 40, and 41 invoice rows against 38 — but it cannot run in the
browser: the ONNX stages need OpenCV, and OpenCV.js wedges the main thread for
minutes on its 10 MB synchronous WASM init. This puts the reader where it works
and hands the words back.

Standard library only, deliberately. A framework would be one more thing to
install for what is a single endpoint.

    .venv/bin/python python/serve.py --warm          # dev, 127.0.0.1:8756
    .venv/bin/python python/serve.py --live --warm   # public, serves frontend/dist

Dev stays on localhost. `--live` binds every interface and serves the built
frontend next to `/read`, so a browser on another machine can use the site.
Uploaded receipts are then processed on this machine. The server still writes
nothing to disk.
"""

from __future__ import annotations

import argparse
import errno
import io
import json
import mimetypes
import os
import signal
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from read_receipt import (  # noqa: E402
    load_engine,
    read_words,
    suppress_colored_watermark,
)

# Dev server and preview. A live site is allowed when its Origin host matches
# the Host header (the page and `/read` are the same server), or when passed
# with `--origin`. Anything else is refused.
ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5273",
    "http://127.0.0.1:5273",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
}

MAX_UPLOAD_BYTES = 40 * 1024 * 1024

# Reads the server holds at once: the one being read and those waiting behind
# it. Each waiting read keeps its upload in memory, so past this the server says
# it is busy rather than queueing without bound.
MAX_PENDING_READS = 8

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_STATIC = REPO_ROOT / "frontend" / "dist"

mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")

_engine = None
_static_root: Path | None = None
_extra_origins: set[str] = set()

# One read at a time. ONNX Runtime already spreads a single read over every
# core, so two at once only make both slower and double the memory; in a queue
# each read takes as long as it would alone.
_read_lock = threading.Lock()
_pending_reads = threading.BoundedSemaphore(MAX_PENDING_READS)


def engine():
    """
    Built once. Session setup costs seconds; reading costs hundreds of ms.

    Only called under `_read_lock` or before the server starts, so two first
    reads arriving together cannot both build it.
    """
    global _engine
    if _engine is None:
        print("loading PP-OCR models…", flush=True)
        _engine = load_engine()
        print("ready", flush=True)
    return _engine


def decode_image(raw: bytes) -> np.ndarray:
    """Bytes to an RGB array, via Pillow so any format the browser sends works."""
    from PIL import Image

    with Image.open(io.BytesIO(raw)) as image:
        return np.asarray(image.convert("RGB"))


class Server(ThreadingHTTPServer):
    # A restart should be able to bind the port while the previous socket is
    # still in TIME_WAIT, and a stop should not wait on a stuck read.
    allow_reuse_address = True
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- plumbing ---------------------------------------------------------- #

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        # A direct call (curl, the health check) sends no Origin; a browser
        # always does, and then it has to be this site or a known dev server.
        if origin is None or origin in ALLOWED_ORIGINS or origin in _extra_origins:
            return True
        return _same_site(origin, self.headers.get("Host"))

    def _send(self, status: int, payload: dict, origin: str | None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._allow_origin(origin)
        self.end_headers()
        self.wfile.write(body)

    def _allow_origin(self, origin: str | None) -> None:
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def log_message(self, fmt: str, *args) -> None:
        # The default logs every request to stderr with the client address;
        # one line per read is enough.
        return

    # --- routes ------------------------------------------------------------ #

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        self.send_response(204)
        if origin and self._origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        path = self.path.split("?", 1)[0]
        if path == "/health":
            if not self._origin_ok():
                self._send(403, {"error": "origin not allowed"}, origin)
                return
            self._send(200, {"status": "ok", "reader": "pp-ocr"}, origin)
            return
        if self._serve_static(path):
            return
        self._send(404, {"error": "not found"}, origin)

    def _serve_static(self, url_path: str) -> bool:
        if _static_root is None:
            return False
        target = _resolve_static(url_path)
        # A route with no file extension is the single-page app. A missing
        # script or image should stay a 404.
        if target is None and "." not in Path(url_path).name:
            target = _resolve_static("/index.html")
        if target is None:
            return False
        body = target.read_bytes()
        mime, _ = mimetypes.guess_type(target.name)
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_POST(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        if not self._origin_ok():
            self._send(403, {"error": "origin not allowed"}, origin)
            return
        if self.path != "/read":
            self._send(404, {"error": "not found"}, origin)
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send(400, {"error": "bad Content-Length"}, origin)
            return
        if length <= 0:
            self._send(400, {"error": "empty body"}, origin)
            return
        if length > MAX_UPLOAD_BYTES:
            self._send(413, {"error": "image too large"}, origin)
            return

        # Read the body even when the answer is "busy": replying with the upload
        # left unread breaks the connection, and the browser then reports a
        # network error instead of the reply.
        raw = self.rfile.read(length)

        if not _pending_reads.acquire(blocking=False):
            print(f"busy: {MAX_PENDING_READS} reads pending, refused one", flush=True)
            self._send(503, {"error": "the reader is busy, try again shortly"}, origin)
            return

        try:
            arrived = time.perf_counter()
            with _read_lock:
                started = time.perf_counter()
                rgb = decode_image(raw)
                page, ratio = suppress_colored_watermark(rgb)
                words = read_words(engine(), page, scale=2.0)
                finished = time.perf_counter()
        except Exception as error:  # noqa: BLE001 - report, never crash the server
            self._send(500, {"error": f"{type(error).__name__}: {error}"}, origin)
            return
        finally:
            _pending_reads.release()

        elapsed = round((finished - started) * 1000)
        waited = round((started - arrived) * 1000)
        queued = f" after {waited}ms in the queue" if waited else ""
        print(f"read {page.shape[1]}x{page.shape[0]} -> {len(words)} words in {elapsed}ms{queued}", flush=True)
        self._send(
            200,
            {
                "words": words,
                "size": {"width": int(page.shape[1]), "height": int(page.shape[0])},
                "watermarkPixelRatio": round(ratio, 4),
                "elapsedMs": elapsed,
            },
            origin,
        )


def _already_serving(port: int) -> bool:
    """Whether the thing holding the port is another copy of this reader."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return json.loads(response.read()).get("reader") == "pp-ocr"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def _same_site(origin: str, host_header: str | None) -> bool:
    """True when the browser page is this server, not some other website."""
    if not host_header:
        return False
    netloc = urlparse(origin).netloc
    if netloc == host_header:
        return True

    def bare(value: str) -> str:
        host = value.rsplit("@", 1)[-1]
        if host.startswith("[") and "]" in host:
            return host[1 : host.index("]")]
        if host.count(":") == 1:
            return host.rsplit(":", 1)[0]
        return host

    return bare(netloc) == bare(host_header) and bare(netloc) != ""


def _resolve_static(url_path: str) -> Path | None:
    if _static_root is None:
        return None
    raw = url_path.split("?", 1)[0]
    if raw in ("", "/"):
        raw = "/index.html"
    if "\\" in raw or raw.startswith("//"):
        return None
    root = _static_root.resolve()
    candidate = (root / raw.lstrip("/")).resolve()
    if not candidate.is_relative_to(root):
        return None
    if candidate.is_dir():
        candidate = candidate / "index.html"
    if candidate.is_file():
        return candidate
    return None


def _extra_from_env() -> set[str]:
    raw = os.environ.get("OCR_ALLOWED_ORIGINS", "")
    return {item.strip() for item in raw.split(",") if item.strip()}


def main() -> int:
    global _static_root, _extra_origins

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument(
        "--host",
        default=None,
        help="interface to bind (default 127.0.0.1, or 0.0.0.0 with --live)",
    )
    parser.add_argument(
        "--static",
        type=Path,
        default=None,
        help="directory of the built frontend (default frontend/dist with --live)",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="bind 0.0.0.0 and serve frontend/dist on the same port as /read",
    )
    parser.add_argument(
        "--origin",
        action="append",
        default=[],
        help="extra browser Origin to allow, repeatable (or set OCR_ALLOWED_ORIGINS)",
    )
    parser.add_argument(
        "--warm",
        action="store_true",
        help="build the models at startup rather than on the first read",
    )
    args = parser.parse_args()

    host = args.host or ("0.0.0.0" if args.live else "127.0.0.1")
    port = args.port if args.port is not None else (8080 if args.live else 8756)
    static = args.static if args.static is not None else (DEFAULT_STATIC if args.live else None)
    if static is not None:
        static = static.resolve()
        if not (static / "index.html").is_file():
            print(
                f"No built frontend at {static}.\n"
                "Build it with:  pnpm --dir frontend build",
                file=sys.stderr,
            )
            return 1
        _static_root = static
    _extra_origins = _extra_from_env() | set(args.origin)

    # Bind before loading the models. Warming first means a good half minute of
    # work is thrown away when the port turns out to be taken — which it usually
    # is because the reader is already running and doing its job.
    try:
        server = Server((host, port), Handler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        if _already_serving(port):
            print(
                f"A reader is already listening on port {port} — nothing to do.\n"
                f"Stop it with:  lsof -ti tcp:{port} | xargs kill",
                file=sys.stderr,
            )
            return 0
        print(
            f"Port {port} is in use by something that is not this reader.\n"
            f"Pick another with --port, or find the holder:  lsof -nP -iTCP:{port} -sTCP:LISTEN",
            file=sys.stderr,
        )
        return 1

    if args.warm:
        engine()

    shown = "127.0.0.1" if host == "0.0.0.0" else host
    print(f"reader listening on http://{shown}:{port}  (POST /read)", flush=True)
    if _static_root is not None:
        print(f"frontend from {_static_root}", flush=True)
    if host == "0.0.0.0":
        print("open to the network — receipts uploaded here are read on this machine", flush=True)

    def stop(_signum: int, _frame: object) -> None:
        print("\nstopping", flush=True)
        # shutdown() waits for serve_forever() to return, so it has to run on
        # another thread or this process deadlocks on Ctrl-C and on Docker stop.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
