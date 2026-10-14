"""Local preview server with byte ranges, including a GitHub Pages-style subpath."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.byte_range = None
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path):
        if path.startswith('/silksong/'):
            path = path[len('/silksong'):]
        return super().translate_path(path)

    def send_head(self):
        self.byte_range = None
        parts = unquote(urlsplit(self.path).path).split('/')
        if any(p.startswith('.') or p == 'node_modules' for p in parts if p):
            self.send_error(403); return None
        path = Path(self.translate_path(self.path))
        requested = self.headers.get('Range')
        if requested and path.is_file():
            match = re.fullmatch(r'bytes=(\d+)-(\d*)', requested)
            if match:
                size = path.stat().st_size
                start = int(match[1]); end = min(int(match[2]) if match[2] else size - 1, size - 1)
                if start > end:
                    self.send_error(416); return None
                stream = path.open('rb'); stream.seek(start)
                self.send_response(206)
                self.send_header('Content-Type', self.guess_type(str(path)))
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Content-Length', str(end - start + 1))
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
                self.byte_range = end - start + 1
                return stream
        return super().send_head()

    def copyfile(self, source, outputfile):
        remaining = self.byte_range
        try:
            while remaining is None or remaining > 0:
                data = source.read(min(262144, remaining) if remaining is not None else 262144)
                if not data: break
                outputfile.write(data)
                if remaining is not None: remaining -= len(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Browser cancellation after the requested range is expected.

    def log_message(self, format, *args):
        if len(args) > 1 and str(args[1]).startswith(('4', '5')):
            super().log_message(format, *args)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    print(f'Player preview on 0.0.0.0:{args.port}', flush=True)
    ThreadingHTTPServer(('0.0.0.0', args.port), Handler).serve_forever()
