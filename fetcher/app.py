"""Browser-impersonating fetch service for the 流光 player.

Cloudflare tells Node's built-in fetch apart from a real browser by its TLS and
HTTP/2 fingerprint and answers with a challenge page. This service performs the
upstream requests with curl_cffi impersonating Chrome (the same approach as
FetchJAV). When a challenge still appears and FlareSolverr is configured, a
real headless Chrome solves it once; the resulting cf_clearance cookie and
User-Agent are then reused for later requests to that domain.

It listens only on the internal Docker network and is called by the Node app:

    POST /fetch  {"url": ..., "method": "GET"|"HEAD", "headers": {...}}

The reply mirrors the upstream status, headers and body (streamed). Redirects
are NOT followed: the Node app re-validates every Location itself. Errors from
this service (not from upstream) carry an X-Fetcher-Error header.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from curl_cffi import requests as curl

PORT = int(os.environ.get("PORT", "8080"))
IMPERSONATE = os.environ.get("IMPERSONATE", "chrome")
FLARESOLVERR_URL = os.environ.get("FLARESOLVERR_URL", "").strip()
FLARESOLVERR_TIMEOUT_MS = int(os.environ.get("FLARESOLVERR_TIMEOUT_MS", "60000"))
CLEARANCE_TTL_S = int(os.environ.get("CLEARANCE_TTL_S", str(2 * 60 * 60)))
# A failed solve is not retried for this long, so a broken source cannot keep
# a headless Chrome busy on every segment request.
SOLVE_BACKOFF_S = 60
CONNECT_TIMEOUT_S = 15
READ_TIMEOUT_S = 60
MAX_HTML_BYTES = 8 * 1024 * 1024
CHUNK_BYTES = 64 * 1024

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "set-cookie",
}
CHALLENGE_RE = re.compile(
    rb"<title>\s*just a moment|cf-browser-verification|cf_chl_|challenge-platform",
    re.I,
)


class FetchError(Exception):
    def __init__(self, code: str, status: int = 502):
        super().__init__(code)
        self.code = code
        self.status = status


# ── clearance store ─────────────────────────────────────────────────────────

_clearance: dict[str, dict] = {}
_clearance_lock = threading.Lock()
_solve_locks: dict[str, threading.Lock] = {}
_solve_failed_at: dict[str, float] = {}


def _domain_matches(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def clearance_for(host: str) -> tuple[dict[str, str], str | None]:
    cookies: dict[str, str] = {}
    user_agent = None
    now = time.time()
    with _clearance_lock:
        for domain, entry in list(_clearance.items()):
            if entry["until"] <= now:
                del _clearance[domain]
                continue
            if _domain_matches(host, domain):
                cookies.update(entry["cookies"])
                user_agent = entry["ua"] or user_agent
    return cookies, user_agent


def store_clearance(host: str, cookies: list[dict], user_agent: str) -> None:
    by_domain: dict[str, dict[str, str]] = {}
    for cookie in cookies:
        domain = (cookie.get("domain") or host).lstrip(".").lower()
        if not _domain_matches(host, domain):
            continue
        by_domain.setdefault(domain, {})[cookie["name"]] = cookie["value"]
    until = time.time() + CLEARANCE_TTL_S
    with _clearance_lock:
        for domain, values in by_domain.items():
            _clearance[domain] = {"cookies": values, "ua": user_agent, "until": until}


def solve_with_flaresolverr(url: str, host: str) -> dict | None:
    """Ask FlareSolverr to open the URL in Chrome. Returns its solution or None."""
    if not FLARESOLVERR_URL:
        return None
    with _clearance_lock:
        lock = _solve_locks.setdefault(host, threading.Lock())
    with lock:
        if time.time() - _solve_failed_at.get(host, 0) < SOLVE_BACKOFF_S:
            return None
        payload = json.dumps(
            {"cmd": "request.get", "url": url, "maxTimeout": FLARESOLVERR_TIMEOUT_MS}
        ).encode()
        request = urllib.request.Request(
            FLARESOLVERR_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(
                request, timeout=FLARESOLVERR_TIMEOUT_MS / 1000 + 15
            ) as response:
                data = json.load(response)
        except Exception as error:  # noqa: BLE001 - any failure means "unsolved"
            log("flaresolverr unreachable or failed", host=host, error=str(error))
            _solve_failed_at[host] = time.time()
            return None
        solution = data.get("solution") or {}
        if data.get("status") != "ok" or not solution:
            log("flaresolverr could not solve", host=host, message=data.get("message"))
            _solve_failed_at[host] = time.time()
            return None
        store_clearance(host, solution.get("cookies") or [], solution.get("userAgent") or "")
        log("flaresolverr solved challenge", host=host, status=solution.get("status"))
        return solution


# ── upstream requests ───────────────────────────────────────────────────────


def assert_public(url: str) -> str:
    """Defence in depth: the Node app validates targets too, but DNS can change
    between its check and this request, so resolve and check again here."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise FetchError("INVALID_URL", 400)
    host = parts.hostname.lower()
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as error:
        raise FetchError("DNS_FAILED") from error
    for info in infos:
        address = ipaddress.ip_address(info[4][0].split("%")[0])
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        if not address.is_global:
            raise FetchError("PRIVATE_URL", 403)
    return host


def upstream_headers(headers: dict[str, str], host: str) -> dict[str, str]:
    cookies, user_agent = clearance_for(host)
    result = {
        name: value
        for name, value in headers.items()
        if name.lower() not in HOP_BY_HOP and name.lower() != "host"
    }
    # Let curl_cffi send the User-Agent that matches the impersonated TLS
    # fingerprint, unless a clearance cookie is bound to FlareSolverr's UA.
    for name in [name for name in result if name.lower() == "user-agent"]:
        del result[name]
    if user_agent:
        result["User-Agent"] = user_agent
    if cookies:
        existing = result.pop("Cookie", "") or result.pop("cookie", "")
        jar = "; ".join(f"{name}={value}" for name, value in cookies.items())
        result["Cookie"] = f"{existing}; {jar}" if existing else jar
    return result


def open_upstream(method: str, url: str, headers: dict[str, str]):
    try:
        return curl.request(
            method,
            url,
            headers=headers,
            impersonate=IMPERSONATE,
            allow_redirects=False,
            stream=True,
            timeout=(CONNECT_TIMEOUT_S, READ_TIMEOUT_S),
        )
    except Exception as error:  # noqa: BLE001 - curl errors have many types
        raise FetchError("UPSTREAM_UNREACHABLE") from error


def is_html(response) -> bool:
    return "text/html" in (response.headers.get("content-type") or "").lower()


def read_all(response, limit: int = MAX_HTML_BYTES) -> bytes:
    chunks: list[bytes] = []
    total = 0
    try:
        for chunk in response.iter_content(chunk_size=CHUNK_BYTES):
            total += len(chunk)
            if total > limit:
                raise FetchError("UPSTREAM_TOO_LARGE", 413)
            chunks.append(chunk)
    except FetchError:
        raise
    except Exception as error:  # noqa: BLE001
        raise FetchError("UPSTREAM_READ_FAILED") from error
    finally:
        response.close()
    return b"".join(chunks)


def is_challenge(response, body: bytes) -> bool:
    if (response.headers.get("cf-mitigated") or "").lower() == "challenge":
        return True
    return bool(CHALLENGE_RE.search(body[:256 * 1024]))


# ── HTTP server ─────────────────────────────────────────────────────────────


def log(message: str, **fields) -> None:
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "msg": message, **fields}, ensure_ascii=False), flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "liuguang-fetcher"
    sys_version = ""

    def log_message(self, format, *args):  # noqa: A002 - silence default access log
        pass

    def do_GET(self):
        if self.path == "/health":
            self._send_plain(200, b"ok")
        else:
            self._send_plain(404, b"not found")

    def do_POST(self):
        if self.path != "/fetch":
            self._send_plain(404, b"not found")
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            if length <= 0 or length > 64 * 1024:
                raise FetchError("BAD_REQUEST", 400)
            request = json.loads(self.rfile.read(length))
            url = str(request["url"])
            method = str(request.get("method") or "GET").upper()
            if method not in ("GET", "HEAD"):
                raise FetchError("BAD_REQUEST", 400)
            headers = {str(k): str(v) for k, v in (request.get("headers") or {}).items()}
            self._proxy(url, method, headers)
        except FetchError as error:
            self._send_error(error)
        except (ValueError, KeyError, TypeError):
            self._send_error(FetchError("BAD_REQUEST", 400))
        except (BrokenPipeError, ConnectionResetError):
            pass  # the player went away mid-stream (seek, close tab)
        except Exception as error:  # noqa: BLE001 - e.g. upstream died mid-stream
            log("fetch failed", error=repr(error))
            self.close_connection = True

    def _proxy(self, url: str, method: str, headers: dict[str, str]) -> None:
        host = assert_public(url)
        response = open_upstream(method, url, upstream_headers(headers, host))
        if method == "HEAD":
            self._stream(response, head=True)
            return
        if not is_html(response):
            self._stream(response)
            return

        body = read_all(response)
        if not is_challenge(response, body):
            self._send_buffered(response, body)
            return

        log("challenge detected", host=host, status=response.status_code)
        solution = solve_with_flaresolverr(url, host)
        if solution is None:
            self._send_buffered(response, body)
            return
        retry = open_upstream(method, url, upstream_headers(headers, host))
        if not is_html(retry):
            self._stream(retry)
            return
        retry_body = read_all(retry)
        if not is_challenge(retry, retry_body):
            self._send_buffered(retry, retry_body, via="curl+clearance")
            return
        # The clearance cookie did not carry over (e.g. a different fingerprint
        # check). For HTML pages, FlareSolverr's own rendering is still usable.
        html = (solution.get("response") or "").encode()
        if solution.get("status") == 200 and html and not CHALLENGE_RE.search(html[:256 * 1024]):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.send_header("X-Fetcher-Via", "flaresolverr")
            self.end_headers()
            self.wfile.write(html)
            return
        self._send_buffered(retry, retry_body)

    def _copy_headers(self, response, decoded: bool) -> None:
        encoded = bool(response.headers.get("content-encoding"))
        for name, value in response.headers.multi_items():
            lower = name.lower()
            if lower in HOP_BY_HOP:
                continue
            # curl decodes gzip/br bodies, so the upstream length and encoding
            # no longer describe what we send.
            if (encoded or decoded) and lower in ("content-encoding", "content-length"):
                continue
            self.send_header(name, value)

    def _stream(self, response, head: bool = False) -> None:
        try:
            self.send_response(response.status_code)
            # A HEAD answer arrives here as the reply to a POST, which has no
            # body, so the upstream length must not travel as Content-Length.
            self._copy_headers(response, decoded=head)
            length = response.headers.get("content-length")
            if head and length and not response.headers.get("content-encoding"):
                self.send_header("X-Upstream-Content-Length", length)
                self.send_header("Content-Length", "0")
            self.send_header("X-Fetcher-Via", "curl")
            self.end_headers()
            for chunk in response.iter_content(chunk_size=CHUNK_BYTES):
                self.wfile.write(chunk)
        finally:
            response.close()

    def _send_buffered(self, response, body: bytes, via: str = "curl") -> None:
        self.send_response(response.status_code)
        self._copy_headers(response, decoded=True)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Fetcher-Via", via)
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, error: FetchError) -> None:
        try:
            self.send_response(error.status)
            self.send_header("X-Fetcher-Error", error.code)
            self.send_header("Content-Length", "0")
            self.end_headers()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_plain(self, status: int, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    log(
        "fetcher listening",
        port=PORT,
        impersonate=IMPERSONATE,
        flaresolverr=bool(FLARESOLVERR_URL),
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
