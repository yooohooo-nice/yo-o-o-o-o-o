"""Run with: python -m unittest test_app (needs curl_cffi installed)."""

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import app

REAL_ASSERT_PUBLIC = app.assert_public
SOLVER_UA = "Mozilla/5.0 SolverChrome/140"
SEGMENT = bytes(range(256)) * 4096  # 1 MiB


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, body=b"", content_type="text/html", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if self.path == "/page":
            self._send(200, b"<html><title>ok page</title></html>")
        elif self.path == "/ua":
            self._send(200, self.headers.get("user-agent", "").encode(), "text/plain")
        elif self.path == "/protected":
            cleared = "cf_clearance=good" in (self.headers.get("cookie") or "")
            if cleared and self.headers.get("user-agent") == SOLVER_UA:
                self._send(200, b"<html><title>real video page</title></html>")
            else:
                self._send(
                    403,
                    b"<html><title>Just a moment...</title></html>",
                    extra={"cf-mitigated": "challenge"},
                )
        elif self.path == "/segment":
            self._send(200, SEGMENT, "video/mp2t")
        elif self.path == "/redirect":
            self._send(302, b"", extra={"Location": "/page"})
        else:
            self._send(404, b"")


class Solver(BaseHTTPRequestHandler):
    calls = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        Solver.calls += 1
        self.rfile.read(int(self.headers["content-length"]))
        body = json.dumps(
            {
                "status": "ok",
                "solution": {
                    "status": 200,
                    "userAgent": SOLVER_UA,
                    "response": "<html>solver html</html>",
                    "cookies": [
                        {"name": "cf_clearance", "value": "good", "domain": ".127.0.0.1"}
                    ],
                },
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class FetcherTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = serve(Upstream)
        cls.solver = serve(Solver)
        cls.fetcher = serve(app.Handler)
        cls.base = f"http://127.0.0.1:{cls.upstream.server_port}"
        # Test servers live on loopback, which the real check rightly rejects.
        app.assert_public = lambda url: "127.0.0.1"
        app._domain_matches = lambda host, domain: True

    @classmethod
    def tearDownClass(cls):
        app.assert_public = REAL_ASSERT_PUBLIC
        for server in (cls.upstream, cls.solver, cls.fetcher):
            server.shutdown()

    def setUp(self):
        app._clearance.clear()
        app._solve_failed_at.clear()
        app.FLARESOLVERR_URL = ""
        Solver.calls = 0

    def fetch(self, path, method="GET", headers=None):
        payload = json.dumps(
            {"url": self.base + path, "method": method, "headers": headers or {}}
        ).encode()
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.fetcher.server_port}/fetch",
            data=payload,
            headers={"Content-Type": "application/json"},
        )

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        opener = urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(request, timeout=30) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_html_page(self):
        status, headers, body = self.fetch("/page")
        self.assertEqual(status, 200)
        self.assertIn(b"ok page", body)
        self.assertEqual(headers["X-Fetcher-Via"], "curl")

    def test_impersonated_user_agent_replaces_callers(self):
        _, _, body = self.fetch("/ua", headers={"User-Agent": "node"})
        self.assertIn(b"Chrome", body)
        self.assertNotEqual(body, b"node")

    def test_streams_binary_segment(self):
        status, headers, body = self.fetch("/segment")
        self.assertEqual(status, 200)
        self.assertEqual(body, SEGMENT)
        self.assertEqual(headers["Content-Type"], "video/mp2t")

    def test_head(self):
        status, headers, body = self.fetch("/segment", method="HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(headers["X-Upstream-Content-Length"], str(len(SEGMENT)))

    def test_redirect_not_followed(self):
        status, headers, _ = self.fetch("/redirect")
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], "/page")

    def test_challenge_without_solver_is_passed_through(self):
        status, _, body = self.fetch("/protected")
        self.assertEqual(status, 403)
        self.assertIn(b"Just a moment", body)

    def test_challenge_solved_and_clearance_reused(self):
        app.FLARESOLVERR_URL = f"http://127.0.0.1:{self.solver.server_port}/v1"
        status, headers, body = self.fetch("/protected")
        self.assertEqual(status, 200)
        self.assertIn(b"real video page", body)
        self.assertEqual(headers["X-Fetcher-Via"], "curl+clearance")
        # Second request reuses the stored cookie without asking the solver.
        status, _, _ = self.fetch("/protected")
        self.assertEqual(status, 200)
        self.assertEqual(Solver.calls, 1)

    def test_rejects_private_targets(self):
        self.assertRaises(app.FetchError, REAL_ASSERT_PUBLIC, "http://127.0.0.1/x")
        self.assertRaises(app.FetchError, REAL_ASSERT_PUBLIC, "http://10.1.2.3/x")
        self.assertRaises(app.FetchError, REAL_ASSERT_PUBLIC, "file:///etc/passwd")


if __name__ == "__main__":
    unittest.main()
