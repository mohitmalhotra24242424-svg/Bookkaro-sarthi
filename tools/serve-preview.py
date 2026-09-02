#!/usr/bin/env python3
"""Dev static server for the BookKaro shell with proper video support.

Why not `python -m http.server`: it ignores Range requests, so <video> cannot
seek and Chrome/Safari sometimes refuse to start the hero MP4. This adds byte
ranges, correct MIME types and `Cache-Control: no-store` so edits show up
immediately in the preview.

Serve root = <repo>/app  (tools/ -> repo root -> app)
"""
import functools
import os
import posixpath
import re
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))          # <repo>/tools
ROOT = os.path.normpath(os.path.join(HERE, os.pardir, "app"))
PORT = int(os.environ.get("PORT") or os.environ.get("PORT0") or "4173")

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".gif": "image/gif",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
    ".ttf": "font/ttf", ".otf": "font/otf", ".woff2": "font/woff2",
}


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    _range = None

    def guess_type(self, path):
        return TYPES.get(posixpath.splitext(path)[1].lower(),
                         "application/octet-stream")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        SimpleHTTPRequestHandler.end_headers(self)

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            for idx in ("index.html", "hero.html"):
                if os.path.isfile(os.path.join(path, idx)):
                    self.path = posixpath.join(self.path, idx).replace("//", "/")
                    return SimpleHTTPRequestHandler.send_head(self)
        header = self.headers.get("Range")
        if not header or not os.path.isfile(path):
            return SimpleHTTPRequestHandler.send_head(self)
        m = re.match(r"bytes=(\d*)-(\d*)$", header.strip())
        if not m:
            return SimpleHTTPRequestHandler.send_head(self)
        size = os.path.getsize(path)
        start = int(m.group(1) or 0)
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, "Range Not Satisfiable")
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206, "Partial Content")
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        Handler._range = (f, end - start + 1)
        return f

    def copyfile(self, source, outputfile):
        pending = Handler._range
        if not pending or source is not pending[0]:
            return SimpleHTTPRequestHandler.copyfile(self, source, outputfile)
        f, remaining = pending
        Handler._range = None
        while remaining > 0:
            chunk = f.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def log_message(self, fmt, *args):
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not os.path.isdir(ROOT):
        raise SystemExit("[bookkaro] app dir not found: %s" % ROOT)
    handler = functools.partial(Handler, directory=ROOT)
    with Server(("0.0.0.0", PORT), handler) as httpd:
        print("[bookkaro] serving %s on 0.0.0.0:%d" % (ROOT, PORT), flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
