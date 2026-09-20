# Zero-dependency static server for RED STARBASE (no npm on this machine).
# Mirrors vite's serving rules: repo root at /, public/ mounted at /.
# Usage: python3 tools/serve.py [port]
import http.server, os, sys, socketserver

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5173


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def translate_path(self, path):
        rel = path.split('?', 1)[0].split('#', 1)[0].lstrip('/')
        if rel.startswith('assets/') and not os.path.exists(os.path.join(ROOT, rel)):
            return http.server.SimpleHTTPRequestHandler.translate_path(self, '/public/' + rel)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('0.0.0.0', PORT), Handler) as httpd:
    print(f'RED STARBASE serving at http://localhost:{PORT}')
    httpd.serve_forever()
