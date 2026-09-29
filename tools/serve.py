#!/usr/bin/env python3
"""
Serve the PP-OCR reader to the browser app over localhost.

The app reads receipts in the browser with Tesseract. PP-OCR reads them more
accurately — measured against `fixtures/ground-truth.json`, all 48 inventory
count rows exact against 40, and 41 invoice rows against 38 — but it cannot run in the
browser: the ONNX stages need OpenCV, and OpenCV.js wedges the main thread for
minutes on its 10 MB synchronous WASM init. This puts the reader where it works
and hands the words back.

Standard library only, deliberately. A framework would be one more thing to
install for what is a single endpoint, and this has no business being reachable
from anywhere but the machine it runs on.

    .venv/bin/python tools/serve.py
    # then set the app's reader to 'python'

Receipts do not leave the machine: the server binds to 127.0.0.1, refuses
requests from anywhere else, and writes nothing to disk.
"""

from __future__ import annotations

import argparse
import errno
import io
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from read_receipt import (  # noqa: E402
    load_engine,
    read_words,
    suppress_colored_watermark,
)

# Only the dev server and a preview build. An `Origin` outside this list is
# refused rather than answered, so a page the user happens to have open cannot
# quietly post their receipts at this port.
ALLOWED_ORIGINS = {
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5273",
    "http://127.0.0.1:5273",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
}

MAX_UPLOAD_BYTES = 40 * 1024 * 1024

_engine = None


def engine():
    """Built once. Session setup costs seconds; reading costs hundreds of ms."""
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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # --- plumbing ---------------------------------------------------------- #

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        # A direct call (curl, the health check) sends no Origin; a browser
        # always does, and then it has to be one we know.
        return origin is None or origin in ALLOWED_ORIGINS

    def _send(self, status: int, payload: dict, origin: str | None) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        # The default logs every request to stderr with the client address;
        # one line per read is enough.
        return

    # --- routes ------------------------------------------------------------ #

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        self.send_response(204)
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "86400")
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin")
        if self.path != "/health":
            self._send(404, {"error": "not found"}, origin)
            return
        self._send(200, {"status": "ok", "reader": "pp-ocr"}, origin)

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

        raw = self.rfile.read(length)

        try:
            started = time.perf_counter()
            rgb = decode_image(raw)
            page, ratio = suppress_colored_watermark(rgb)
            words = read_words(engine(), page, scale=2.0)
            elapsed = round((time.perf_counter() - started) * 1000)
        except Exception as error:  # noqa: BLE001 - report, never crash the server
            self._send(500, {"error": f"{type(error).__name__}: {error}"}, origin)
            return

        print(f"read {page.shape[1]}x{page.shape[0]} -> {len(words)} words in {elapsed}ms", flush=True)
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
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return json.loads(response.read()).get("reader") == "pp-ocr"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8756)
    parser.add_argument(
        "--warm",
        action="store_true",
        help="build the models at startup rather than on the first read",
    )
    args = parser.parse_args()

    # Bind before loading the models. Warming first means a good half minute of
    # work is thrown away when the port turns out to be taken — which it usually
    # is because the reader is already running and doing its job.
    try:
        # 127.0.0.1, not 0.0.0.0: these are someone's receipts.
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError as error:
        if error.errno != errno.EADDRINUSE:
            raise
        if _already_serving(args.port):
            print(
                f"A reader is already listening on port {args.port} — nothing to do.\n"
                f"Stop it with:  lsof -ti tcp:{args.port} | xargs kill",
                file=sys.stderr,
            )
            return 0
        print(
            f"Port {args.port} is in use by something that is not this reader.\n"
            f"Pick another with --port, or find the holder:  lsof -nP -iTCP:{args.port} -sTCP:LISTEN",
            file=sys.stderr,
        )
        return 1

    if args.warm:
        engine()

    print(f"reader listening on http://127.0.0.1:{args.port}  (POST /read)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
