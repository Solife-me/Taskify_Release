"""Network boundaries for media and relay destinations supplied by Nostr peers."""

import http.client
import io
import ipaddress
import re
import socket
import ssl
import time
from urllib.parse import urlsplit

DEFAULT_ATTACHMENT_ORIGINS = (
    "https://originless.solife.me",
    "https://blossom.solife.me",
)
DEFAULT_RESTRICTED_ATTACHMENT_MIB = 64
DEFAULT_OWNER_ATTACHMENT_MIB = 512
_HOSTNAME = re.compile(r"[a-z0-9.-]+")


def _url(value, scheme):
    if any(c.isspace() or ord(c) < 32 for c in value) or "\\" in value:
        raise ValueError("Invalid network destination")
    parsed = urlsplit(value)
    host = parsed.hostname
    if (parsed.scheme != scheme or not host or parsed.username is not None
            or parsed.password is not None or parsed.fragment):
        raise ValueError("Invalid network destination")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not _HOSTNAME.fullmatch(host) or host.endswith("."):
            raise ValueError("Invalid network hostname")
    return parsed


def https_origin(value):
    parsed = _url(value, "https")
    return parsed.hostname, parsed.port or 443


def attachment_origins(configured, *, defaults=DEFAULT_ATTACHMENT_ORIGINS):
    origins = {https_origin(url) for url in defaults}
    for url in configured:
        parsed = _url(url, "https")
        if parsed.path not in ("", "/") or parsed.query:
            raise ValueError("An attachment setting must contain HTTPS origins")
        origins.add(https_origin(url))
    return frozenset(origins)


def approved_peer_relays(advertised, configured):
    """Use only operator-controlled routes, including the path and query."""
    known = {}
    for url in configured:
        try:
            parsed = _url(url, "wss")
            key = (parsed.hostname, parsed.port or 443, parsed.path or "/", parsed.query)
            known[key] = url
        except ValueError:
            continue
    approved = []
    for url in advertised:
        try:
            parsed = _url(url, "wss")
            match = known.get((parsed.hostname, parsed.port or 443, parsed.path or "/", parsed.query))
            if match:
                approved.append(match)
        except ValueError:
            continue
    return list(dict.fromkeys(approved))


def _public_ips(host, port, *, allow_private=False):
    addresses = []
    for _, _, _, _, endpoint in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM):
        address = ipaddress.ip_address(endpoint[0])
        checked = getattr(address, "ipv4_mapped", None) or address
        transition = isinstance(checked, ipaddress.IPv6Address) and (
            checked.is_site_local or checked.sixtofour is not None or checked.teredo is not None
        )
        if allow_private:
            # An explicit owner origin may be a loopback or LAN service.
            # Do not route to broadcast-like or scoped destinations.
            if checked.is_multicast or checked.is_unspecified or checked.is_link_local or transition:
                raise ValueError("Network destination resolved to an unusable address")
        elif not checked.is_global or checked.is_multicast or checked.is_reserved or transition:
            raise ValueError("Network destination resolved to a non-public address")
        addresses.append(str(address))
    if not addresses:
        raise ValueError("Network destination did not resolve")
    return list(dict.fromkeys(addresses))


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Dial a validated numeric address and verify TLS for the original hostname."""

    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port=port, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip
        self._tls_context = self._context

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        try:
            self.sock = self._tls_context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def download_https(url, *, origins, limit, timeout, accept="application/octet-stream"):
    """Read a small response using the same pinned HTTPS transport as attachments."""
    body = io.BytesIO()
    stream_https(url, body.write, origins=origins, limit=limit, timeout=timeout, accept=accept)
    return body.getvalue()


def stream_https(url, write, *, origins, limit, timeout, accept="application/octet-stream",
                 private_origins=()):
    """Stream HTTPS to a writer, without redirects, proxies, or a second DNS lookup."""
    parsed = _url(url, "https")
    host, port = parsed.hostname, parsed.port or 443
    if origins is not None and (host, port) not in origins:
        raise ValueError("Attachment origin is not approved")
    deadline = time.monotonic() + timeout
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    addresses = _public_ips(host, port, allow_private=(host, port) in private_origins)
    for ip in addresses:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Download timed out")
        conn = _PinnedHTTPSConnection(host, port, ip, min(remaining, 10))
        try:
            conn.connect()
        except (TimeoutError, ConnectionError, OSError):
            conn.close()
            continue
        try:
            socket_for_timeout = conn.sock
            conn.request("GET", path, headers={"Accept": accept, "Accept-Encoding": "identity"})
            with conn.getresponse() as response:
                if response.status != 200:
                    raise ValueError(f"Download returned HTTP {response.status}")
                encoding = response.getheader("Content-Encoding")
                if encoding not in (None, "identity"):
                    raise ValueError("Unexpected download encoding")
                size = response.getheader("Content-Length")
                if size is not None and not 0 <= int(size) <= limit:
                    raise ValueError("Download exceeds the size limit")
                transferred = 0
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError("Download timed out")
                    socket_for_timeout.settimeout(min(remaining, 10))
                    chunk = response.read1(min(64 * 1024, limit - transferred + 1))
                    if not chunk:
                        if size is not None and transferred != int(size):
                            raise ValueError("Download ended before its declared length")
                        return transferred
                    transferred += len(chunk)
                    if transferred > limit:
                        raise ValueError("Download exceeds the size limit")
                    write(chunk)
        finally:
            conn.close()
    raise OSError("No approved address accepted a verified HTTPS connection")
