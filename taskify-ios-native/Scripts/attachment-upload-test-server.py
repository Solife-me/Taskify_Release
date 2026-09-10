"""Loopback-only streaming fixture for AttachmentUploadTests; uses synthetic files.

Prints an ephemeral port. Originless accepts one multipart `file`; Blossom accepts
the raw ciphertext and requires an upload authorization matching its SHA-256.
No real file server, user key or relay is contacted.
"""
import base64
import hashlib
import http.server
import json
import pathlib
import re
import shutil
import tempfile
import time


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.receive(multipart=True)

    def do_PUT(self):
        self.receive(multipart=False)

    def receive(self, multipart):
        temporary = None
        try:
            remaining = int(self.headers['Content-Length'])
            assert 0 < remaining <= 501 * 1024 * 1024
            end = b''
            if multipart:
                content_type = self.headers['Content-Type']
                assert content_type.startswith('multipart/form-data; boundary=')
                boundary = content_type.split('boundary=', 1)[1].encode()
                opening = self.rfile.readline(8192)
                assert opening == b'--' + boundary + b'\r\n'
                remaining -= len(opening)
                headers = []
                while True:
                    line = self.rfile.readline(8192)
                    assert line
                    remaining -= len(line)
                    if line == b'\r\n':
                        break
                    headers.append(line)
                assert any(b'name="file"' in h and b'filename="' in h for h in headers)
                assert b'Content-Type: application/octet-stream\r\n' in headers
                end = b'\r\n--' + boundary + b'--\r\n'
                remaining -= len(end)
            else:
                assert self.headers['Content-Type'] == 'application/octet-stream'

            digest = hashlib.sha256()
            size = 0
            with tempfile.NamedTemporaryFile(dir=self.server.directory, delete=False) as output:
                temporary = pathlib.Path(output.name)
                while remaining:
                    data = self.rfile.read(min(64 * 1024, remaining))
                    if not data:
                        raise ConnectionResetError('incomplete body')
                    digest.update(data)
                    output.write(data)
                    size += len(data)
                    remaining -= len(data)
                    if self.path == '/slow/upload':
                        time.sleep(0.03)
            if end:
                assert self.rfile.read(len(end)) == end
            sha256 = digest.hexdigest()
            if not multipart:
                authorization = self.headers['Authorization']
                assert authorization.startswith('Nostr ')
                encoded = authorization[6:]
                event = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
                assert event['kind'] == 24242
                assert ['t', 'upload'] in event['tags']
                assert ['x', sha256] in event['tags']
            if self.path == '/reject/upload':
                self.respond(413, {'error': 'fixture upload size limit'})
                return
            destination = pathlib.Path(self.server.directory, sha256)
            temporary.replace(destination)
            temporary = None
            self.respond(200, {'url': f'http://127.0.0.1:{self.server.server_port}/blobs/{sha256}',
                               'sha256': sha256, 'size': size})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (AssertionError, ValueError, TypeError, KeyError) as error:
            self.respond(400, {'error': f'Invalid test upload: {type(error).__name__}'})
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def do_GET(self):
        if not re.fullmatch(r'/blobs/[0-9a-f]{64}', self.path):
            self.respond(404, {'error': 'missing blob'})
            return
        path = pathlib.Path(self.server.directory, self.path.rsplit('/', 1)[1])
        if not path.is_file():
            self.respond(404, {'error': 'missing blob'})
            return
        self.send_response(200)
        self.send_header('Content-Length', str(path.stat().st_size))
        self.end_headers()
        try:
            with path.open('rb') as source:
                shutil.copyfileobj(source, self.wfile, 64 * 1024)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='taskify-test-upload-') as directory:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.directory = directory
        print(server.server_port, flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
