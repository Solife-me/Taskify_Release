"""Local-only fixture for AttachmentDownloadTests. Prints its ephemeral loopback port."""
import http.server
import time


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(503 if self.path == '/error' else 200)
        if self.path == '/advertised-oversize':
            self.send_header('Content-Length', str(100 * 1024 * 1024))
        self.end_headers()
        try:
            count = 8 if self.path == '/small' else 512
            for _ in range(count):
                self.wfile.write(b'b' * 1024)
                self.wfile.flush()
                if self.path == '/slow':
                    time.sleep(0.02)
        except (BrokenPipeError, ConnectionResetError):
            pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
