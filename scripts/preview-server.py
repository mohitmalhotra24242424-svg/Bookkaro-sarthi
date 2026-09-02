#!/usr/bin/env python3
"""Preview-only static server for the BookKaro app folder.

Serves the repo root and lands the preview on the standalone design
preview (/ -> 302 /bookkaro-ai/preview.html). The live app pages remain
available under /app/ (chat at /app/chat.html, home at /app/index.html).
Not part of the deployed product — dev/preview convenience only.
"""
import http.server
import os

APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
os.chdir(APP_DIR)


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/', '/?'):
            self.send_response(302)
            self.send_header('Location', '/bookkaro-ai/preview.html')
            self.end_headers()
            return
        super().do_GET()


if __name__ == '__main__':
    server = http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Handler)
    print('preview serving', APP_DIR, 'on :8080 (root -> /chat.html)')
    server.serve_forever()
