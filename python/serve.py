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
import secrets
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
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

from read_receipt import (  # noqa: E402
    load_engine,
    read_words,
    suppress_colored_watermark,
)
from reader.boxes import WordBox  # noqa: E402
from reader.document import document_json, looks_like_pdf, read_document  # noqa: E402
from reader.export import (  # noqa: E402
    ExportPage,
    PageFailure,
    extra_tables,
    to_csv,
    to_document_json,
    to_skipped_csv,
    to_skipped_log,
    to_table_csv,
    to_table_json,
)
from reader.pdf_text import DPI, render_page  # noqa: E402

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

# Documents whose pages the page may still ask for a picture of.
#
# The reading is returned straight away; the pictures are fetched one at a
# time as the reader pages through them, so the bytes have to outlive the
# request that brought them. They are held in memory, never written to disk,
# and only until the cap or the age pushes them out — a receipt is not
# something to leave lying on a server.
PAGE_CACHE_SECONDS = 30 * 60
PAGE_CACHE_DOCUMENTS = 8
_documents: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()
_documents_lock = threading.Lock()


def _remember(data: bytes) -> str:
    token = secrets.token_urlsafe(18)
    now = time.time()
    with _documents_lock:
        stale = [key for key, (at, _) in _documents.items() if now - at > PAGE_CACHE_SECONDS]
        for key in stale:
            del _documents[key]
        _documents[token] = (now, data)
        while len(_documents) > PAGE_CACHE_DOCUMENTS:
            _documents.popitem(last=False)
    return token


def _recall(token: str) -> bytes | None:
    now = time.time()
    with _documents_lock:
        found = _documents.get(token)
        if found is None:
            return None
        at, data = found
        if now - at > PAGE_CACHE_SECONDS:
            del _documents[token]
            return None
        _documents.move_to_end(token)
        return data


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
        if path == "/page":
            self._serve_page(origin)
            return
        if self._serve_static(path):
            return
        self._send(404, {"error": "not found"}, origin)

    def _serve_page(self, origin: str | None) -> None:
        """One page of a document already read, as a JPEG, for the viewer."""
        if not self._origin_ok():
            self._send(403, {"error": "origin not allowed"}, origin)
            return
        query = parse_qs(urlparse(self.path).query)
        token = (query.get("doc") or [""])[0]
        try:
            number = int((query.get("n") or ["1"])[0])
        except ValueError:
            self._send(400, {"error": "bad page number"}, origin)
            return
        try:
            width = int((query.get("w") or ["0"])[0])
        except ValueError:
            width = 0
        data = _recall(token)
        if data is None:
            self._send(404, {"error": "that document is no longer held"}, origin)
            return
        try:
            body = _page_jpeg(data, number, width=width)
        except Exception as error:  # noqa: BLE001
            self._send(400, {"error": f"{type(error).__name__}: {error}"}, origin)
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(body)))
        # The picture of a page cannot change under a token that named it.
        self.send_header("Cache-Control", "private, max-age=1800")
        self._allow_origin(origin)
        self.end_headers()
        self.wfile.write(body)

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
        route = urlparse(self.path).path
        if route not in ("/read", "/document", "/export"):
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

        if route == "/export":
            # Shaping an export reads nothing, so it does not wait behind a read.
            _pending_reads.release()
            self._write_export(raw, origin)
            return

        if route == "/document":
            try:
                self._read_document(raw, origin, urlparse(self.path).query)
            finally:
                _pending_reads.release()
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


    def _write_export(self, raw: bytes, origin: str | None) -> None:
        """
        The document as one export, from the pages the caller holds.

        Posted back rather than kept here because the app may have had a cell
        typed into it or a table taken out, and the export is of what is on
        screen. A caller with nothing to change can ask `/document` for the
        same thing in one call instead.
        """
        try:
            body = json.loads(raw)
            pages = [ExportPage.from_json(page) for page in body.get("pages") or []]
            total = int(body.get("total") or len(pages))
            dropped = set(body.get("dropped") or [])
            failures = [
                PageFailure(page=int(f["page"]), message=str(f["message"]))
                for f in body.get("failures") or []
            ]
            what = body.get("what") or "data"
            form = body.get("format") or "json"
        except Exception as error:  # noqa: BLE001
            self._send(400, {"error": f"{type(error).__name__}: {error}"}, origin)
            return

        try:
            if what == "log":
                payload = (
                    to_skipped_csv(pages, total, failures)
                    if form == "csv"
                    else to_skipped_log(pages, total, failures)
                )
            elif what == "table":
                wanted = body.get("key")
                table = next((t for t in extra_tables(pages) if t.key == wanted), None)
                if table is None:
                    self._send(404, {"error": "no such table on these pages"}, origin)
                    return
                payload = to_table_csv(table, total) if form == "csv" else to_table_json(table, total)
            else:
                payload = to_csv(pages, total) if form == "csv" else to_document_json(pages, total, dropped)
        except Exception as error:  # noqa: BLE001
            self._send(500, {"error": f"{type(error).__name__}: {error}"}, origin)
            return

        if form == "csv":
            self._send_text(200, payload or "", "text/csv; charset=utf-8", origin)
            return
        self._send(200, payload if payload is not None else {}, origin)

    def _send_text(self, status: int, text: str, content_type: str, origin: str | None) -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self._allow_origin(origin)
        self.end_headers()
        self.wfile.write(body)

    def _read_document(self, raw: bytes, origin: str | None, query: str = "") -> None:
        """
        A whole document in, its reading out.

        The page used to do this for itself: rasterise the PDF, read its text
        layer, recognise what had none, and assemble the rows. All of it is
        here now, so there is one reader rather than two.
        """
        arrived = time.perf_counter()
        try:
            with _read_lock:
                started = time.perf_counter()
                readings = read_document(raw, _recognise)
                payload = document_json(readings)
                finished = time.perf_counter()
        except Exception as error:  # noqa: BLE001 - report, never crash the server
            self._send(500, {"error": f"{type(error).__name__}: {error}"}, origin)
            return

        # `?format=` is for a caller that only wants the finished export and
        # has nothing to edit: one call instead of three.
        wanted = (parse_qs(query).get("format") or [""])[0]
        if wanted in ("csv", "json"):
            pages = [ExportPage.of(r.number, r.result) for r in readings]
            if wanted == "csv":
                self._send_text(200, to_csv(pages, len(pages)), "text/csv; charset=utf-8", origin)
            else:
                self._send(200, to_document_json(pages, len(pages)) or {}, origin)
            return

        payload["document"] = _remember(raw)
        payload["pageCount"] = len(readings)
        elapsed = round((finished - started) * 1000)
        waited = round((started - arrived) * 1000)
        queued = f" after {waited}ms in the queue" if waited else ""
        rows = sum(len(page["rows"]) for page in payload["pages"])
        readers = ", ".join(sorted({reading.reader for reading in readings}))
        print(
            f"read {len(readings)} page(s) by {readers} -> {rows} rows in {elapsed}ms{queued}",
            flush=True,
        )
        self._send(200, payload, origin)


def _recognise(pixels) -> list:
    """The recogniser, as `reader.document` wants it: pixels in, words out."""
    page, _ratio = suppress_colored_watermark(pixels)
    return [
        WordBox(
            text=word["text"],
            x=float(word["x"]),
            y=float(word["y"]),
            width=float(word["width"]),
            height=float(word["height"]),
            confidence=float(word["confidence"]),
        )
        for word in read_words(engine(), page, scale=2.0)
    ]


#: Widths `/page` will render. A request is rounded up to one of these, so a
#: page is rendered a handful of ways however many sizes the page asks for.
PAGE_WIDTHS = (200, 800, 1600)


def _page_jpeg(data: bytes, number: int, width: int = 0, dpi: int = DPI) -> bytes:
    """
    One page of `data` as a JPEG, at or above the width asked for.

    The thumbnail strip wants seven small pictures and the viewer wants one
    large one. Serving the large one to both made the strip fetch three and a
    half megabytes to draw seven postage stamps.
    """
    from PIL import Image

    if looks_like_pdf(data):
        image = Image.fromarray(render_page(data, number, dpi)[:, :, :3])
    else:
        image = Image.open(io.BytesIO(data)).convert("RGB")

    if width > 0 and width < image.width:
        wanted = next((step for step in PAGE_WIDTHS if step >= width), image.width)
        if wanted < image.width:
            height = max(1, round(image.height * wanted / image.width))
            image = image.resize((wanted, height), Image.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=85)
    return buffer.getvalue()


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
