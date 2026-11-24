"""Which addresses the sidecar opens for the engine, by the same rule as Open Sourcebook's own check (`common/addresses.ts`).

Only http and https, no user name or password, never a name of this machine, and every address the host has must
be on the public internet: not loopback, private, link-local, unique-local, carrier-grade NAT, multicast, reserved
or set aside for documentation and benchmarks. An IPv6 address carrying an IPv4 one is judged by that IPv4
address (IPv4-mapped, NAT64 64:ff9b::/96) or refused (the old IPv4-compatible form, 64:ff9b:1::/48, 6to4, Teredo).
The host is resolved with this machine's own resolver and every address it answers is judged; an IPv4 address
written any way but plain dotted decimal (127.1, 0x7f.1, 0177.0.0.1, 2130706433) is refused outright, since
resolvers and URL parsers read those differently. Standard library only, so it can be tested anywhere.

What yt-dlp and FFmpeg open after that (a redirect, the site's own media hosts) they look up and open on their
own; the sidecar's own small fetches (subtitles, a media link to transcribe) check every redirect hop here.
"""

import ipaddress
import re
import socket
import urllib.request
from urllib.parse import urlsplit

_V4_REFUSED = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
    "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
    "224.0.0.0/4", "240.0.0.0/4",
)]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_GLOBAL_UNICAST = ipaddress.ip_network("2000::/3")
_V6_REFUSED = [ipaddress.ip_network(n) for n in ("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")]
_LOCAL_NAMES = ("localhost", "localhost.localdomain")
_LOCAL_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")


_NUMBER = re.compile(r"^(0x[0-9a-f]*|[0-9]+)$")


def _plain_ipv4(host: str) -> bool:
    parts = host.split(".")
    return len(parts) == 4 and all(p.isdigit() and str(int(p)) == p and int(p) < 256 for p in parts)


class Refused(ValueError):
    """An address the sidecar never opens, with the reason in plain words."""


def is_public(ip: "ipaddress.IPv4Address | ipaddress.IPv6Address") -> bool:
    if isinstance(ip, ipaddress.IPv4Address):
        return not any(ip in network for network in _V4_REFUSED)
    if ip.ipv4_mapped is not None:
        return is_public(ip.ipv4_mapped)
    if ip in _NAT64:
        return is_public(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    if ip not in _GLOBAL_UNICAST:
        return False
    return not any(ip in network for network in _V6_REFUSED)


def _resolve(host: str, port: int) -> list:
    return [info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def check_url(url: str, resolve=_resolve) -> None:
    """Raises Refused unless `url` is a public http(s) address; every address its host resolves to is checked."""
    if any(c.isspace() or c == "\\" for c in url):
        raise Refused("That is not a web address.")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise Refused("Only http(s) URLs are supported")
    if "@" in parts.netloc:
        raise Refused("Addresses with a user name or password are not opened")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise Refused("URL has no host")
    if host in _LOCAL_NAMES or host.endswith(_LOCAL_SUFFIXES):
        raise Refused("Local URLs are not allowed")
    # An IPv4 address written any way but a.b.c.d in decimal (0177.0.0.1, 0x7f.1, 2130706433) is read differently
    # by different resolvers and URL parsers, so it is not opened at all.
    if all(_NUMBER.match(p) for p in host.split(".")) and not _plain_ipv4(host):
        raise Refused("An address written that way is not opened")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
        found = resolve(host, port)
    except (OSError, ValueError, UnicodeError):
        raise Refused(f"{host} could not be found") from None
    if not found:
        raise Refused(f"{host} could not be found")
    for address in found:
        try:
            ip = ipaddress.ip_address(str(address).split("%", 1)[0])
        except ValueError:
            raise Refused("Local URLs are not allowed") from None
        if not is_public(ip):
            raise Refused("Local URLs are not allowed")


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_CheckedRedirects)


def open_checked(request: urllib.request.Request, timeout: float):
    """urllib's urlopen, with the address and every redirect hop checked first."""
    check_url(request.full_url)
    return _opener.open(request, timeout=timeout)
