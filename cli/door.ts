/**
 * The door: how a phone on the home network reaches Open Sourcebook, and the only part of Open Sourcebook that listens beyond this computer.
 *
 * The web app, the engine and the other programs keep listening on 127.0.0.1 only. When the person turns the phone
 * on, the launcher opens this door on the network and it passes requests to the web app, after these checks, in this
 * order, on every request:
 *
 *  1. The Host must be a name or address of this computer with the door's port, so a web page elsewhere cannot reach
 *     it by pointing a name of its own at this computer's address (DNS rebinding).
 *  2. A request that changes something must come from the door's own origin (Origin, else Sec-Fetch-Site), so another
 *     site cannot make a browser send one (the device cookie is also SameSite=Strict).
 *  3. Anything not from this computer itself (loopback) must carry a paired device's token in its cookie. Without one
 *     the page says "scan the code on your computer" and nothing else is served.
 *  4. The request's path must already be in the one plain form the web app would read it as: no `.` or `..` parts,
 *     no encoded dots, slashes or backslashes, no doubled slashes, no backslashes. Anything else is refused, so the
 *     door and the web app always decide on the same path.
 *  5. Managing the phone (`/api/phone/...`: devices, codes, turning it off) is never served through the door. The door
 *     refuses it by path, and it also marks everything it passes on with its own per-run key (`x-opensourcebook-door`); the web
 *     app's proxy (web/worker/proxy.ts) never lets a request carrying that key manage the phone, however its path is
 *     spelled. This computer manages the phone at its own address, not through the door.
 *
 * Pairing: the QR code's address is `/pair#<code>`. The code is in the fragment, which a browser never sends, so it
 * is in no request line or log. The pairing page reads it, takes it out of the address bar, and posts it to
 * `/_opensourcebook/pair`; a right code gives the device its own long random token in a cookie its scripts cannot read, stored
 * hashed (devices.ts). The code works once (pairing.ts).
 *
 * This is plain HTTP on the home network: someone who can watch the network's traffic can read it. The pairing page
 * and the docs say so.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { deviceName, type Device, type DeviceStore } from "./devices.ts";
import type { PairingCodes } from "./pairing.ts";

export const COOKIE = "opensourcebook_device";
/** The cookie's name before the rename. A phone paired then still holds it: it is let in, and given the new one. */
export const OLD_COOKIE = "re_device";
/** The door's own paths, and the same two as they were before the rename (a pairing page loaded then still posts there). */
const PAIR_PATHS = new Set(["/_opensourcebook/pair", "/_re/pair"]);
const PING_PATHS = new Set(["/_opensourcebook/ping", "/_re/ping"]);
/** How long a device's cookie lasts. Each page it opens starts the time again, so a phone in use stays paired. */
export const COOKIE_LIFE_S = 30 * 24 * 60 * 60;
/** The header that marks a request as one the door passed on. Its value is the door's per-run key. */
export const DOOR_HEADER = "x-opensourcebook-door";
/** Headers a device may never send through: the door's own mark and the tokens Open Sourcebook's programs use with each other. */
const NEVER_FORWARD = ["cookie", "referer", DOOR_HEADER, "authorization", "x-client-token", "x-phone-token"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface DoorOptions {
  /** The web app on this computer. */
  upstreamPort: number;
  /** The port to listen on (0 picks one, for tests). */
  port: number;
  /** Where to listen: every address by default. */
  listenHost?: string;
  store: DeviceStore;
  codes: PairingCodes;
  /** The names and addresses of this computer, lower case, without brackets. */
  names?: () => Set<string>;
  /** Whether a connection's address is this computer itself. Loopback only, by default. */
  isThisComputer?: (address: string) => boolean;
  onPaired?: (device: Device) => void;
  /** The per-run key the door adds to everything it passes on (DOOR_HEADER), so the web app knows it came through here. */
  key?: string;
}

/**
 * The request target when its path is already in the one form a URL parser reads it as, else undefined. The web app
 * behind the door reads paths with the URL parser, which turns `/api/./phone`, `/api/v1/../phone` and
 * `/api/v1/%2e%2e/phone` into `/api/phone`; the door must never decide on one path and pass on another. So it refuses
 * every path the parser would change, and every spelling a parser or server might still read differently: doubled
 * slashes, backslashes, and encoded dots, slashes, backslashes, percent signs, spaces or control characters. A
 * browser never sends any of these for Open Sourcebook's own pages.
 */
export function canonicalTarget(target: string | undefined): string | undefined {
  if (!target || !target.startsWith("/") || target.length > 8192) return undefined;
  const q = target.indexOf("?");
  const path = q < 0 ? target : target.slice(0, q);
  if (path.includes("//") || path.includes("\\") || /[\u0000- \u007f-￿]/.test(path)) return undefined;
  // Every % must start a real escape, and none may stand for a dot, a slash, a backslash, a percent sign or a control.
  for (const m of path.matchAll(/%(.{0,2})/g)) {
    const hex = m[1]!;
    if (!/^[0-9a-f]{2}$/i.test(hex)) return undefined;
    const code = parseInt(hex, 16);
    if (code <= 0x20 || code >= 0x7f || code === 0x2e || code === 0x2f || code === 0x5c || code === 0x25) return undefined;
  }
  if (path.split("/").some((part) => part === "." || part === "..")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(path, "http://door.invalid");
  } catch {
    return undefined;
  }
  if (parsed.pathname !== path) return undefined;
  return target;
}

/** True for the phone's management routes, read with every escape undone and in any case. */
export function isPhoneRoute(path: string): boolean {
  let plain: string;
  try {
    plain = decodeURIComponent(path).toLowerCase();
  } catch {
    return true;
  }
  // By prefix: `/api/phone;x` or `/api/phone.json` must not slip past a check for `/api/phone/`.
  return plain.startsWith("/api/phone");
}

/** Loopback: the only addresses that count as this computer. A Mac reaching its own LAN address must pair like a phone. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.replace(/^::ffff:/, "");
  return a === "::1" || /^127\./.test(a);
}

/** Every name this computer answers to here: loopback, its addresses on each network, its host name and `.local` name. */
export function thisComputerNames(): Set<string> {
  const names = new Set(["localhost", "127.0.0.1", "::1"]);
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) names.add(i.address.toLowerCase().replace(/%.*$/, ""));
  const host = hostname().toLowerCase();
  if (host) {
    names.add(host);
    names.add(host.endsWith(".local") ? host : `${host}.local`);
  }
  return names;
}

/** The hostname of a Host header when its port is the door's, else undefined. */
export function hostOf(header: string | undefined, port: number): string | undefined {
  if (!header) return undefined;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d+))?$/i.exec(header.trim());
  if (!m) return undefined;
  if (Number(m[2] ?? 80) !== port) return undefined;
  return m[1]!.toLowerCase().replace(/^\[|\]$/g, "");
}

function cookieNamed(header: string | undefined, wanted: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === wanted) return rest.join("=");
  }
  return undefined;
}

/** The device's token: from its cookie, or from the cookie as it was named before the rename. */
const cookieToken = (header: string | undefined): string | undefined => cookieNamed(header, COOKIE) ?? cookieNamed(header, OLD_COOKIE);

/** A device's cookie: scripts cannot read it, other sites cannot send it, and it lasts COOKIE_LIFE_S from now. */
const deviceCookie = (token: string) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_LIFE_S}`;
/** Takes the cookie under its old name off a device that still sent it. */
const DROP_OLD_COOKIE = `${OLD_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
/** The cookie to give a device, and the old one taken away when the device still holds it. */
const cookiesFor = (token: string, sent: string | undefined): string | string[] => (cookieNamed(sent, OLD_COOKIE) !== undefined ? [deviceCookie(token), DROP_OLD_COOKIE] : deviceCookie(token));

const COMMON = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin" };

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { ...COMMON, "content-type": type, "cache-control": "no-store", "content-length": Buffer.byteLength(body), ...extra });
  res.end(body);
}
const json = (res: ServerResponse, status: number, error: string, message: string, extra: Record<string, string> = {}) =>
  send(res, status, JSON.stringify({ error, message }), "application/json; charset=utf-8", extra);

function wantsPage(req: IncomingMessage): boolean {
  return (req.method === "GET" || req.method === "HEAD") && (req.headers["sec-fetch-mode"] === "navigate" || (req.headers.accept ?? "").includes("text/html"));
}

/** True when a browser sent this from somewhere other than the door's own origin. */
function crossSite(req: IncomingMessage, host: string): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) return origin !== `http://${host}`;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site !== "same-origin";
  // Neither header: not a current browser. Only this computer's own tools send those, and they are let through below.
  return true;
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
      } else parts.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}

export interface Door {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function openDoor(options: DoorOptions): Promise<Door> {
  const names = options.names ?? thisComputerNames;
  const local = options.isThisComputer ?? isLoopback;

  async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, "bad_request", "Send the code as JSON.");
    const text = await readBody(req, 2048);
    let code: unknown;
    try {
      code = (JSON.parse(text ?? "") as { code?: unknown }).code;
    } catch {
      return json(res, 400, "bad_request", "Send the code as JSON.");
    }
    const outcome = options.codes.redeem(code, req.socket.remoteAddress ?? "");
    if (outcome === "limited") return json(res, 429, "too_many_tries", "Too many wrong codes from this device. Wait ten minutes, then scan a new code.");
    if (outcome === "wrong") return json(res, 403, "wrong_code", "That code is not the one on your computer. Scan it again.");
    if (outcome !== "paired") return json(res, 410, "code_gone", "That code was used or has run out. Make a new one on your computer.");
    // Pairing again on a device that was paired replaces its old entry instead of adding a second.
    const before = options.store.find(cookieToken(req.headers.cookie));
    if (before) options.store.remove(before.id);
    const { device, token } = options.store.add(deviceName(req.headers["user-agent"]));
    options.onPaired?.(device);
    send(res, 200, JSON.stringify({ paired: true, device: { id: device.id, name: device.name } }), "application/json; charset=utf-8", {
      "set-cookie": cookiesFor(token, req.headers.cookie),
    });
  }

  function forward(req: IncomingMessage, res: ServerResponse, target: string, refresh?: string): void {
    const inner = `127.0.0.1:${options.upstreamPort}`;
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: inner };
    // The device token stays at the door; the web app behind it sees the request as one the door passed on.
    for (const name of NEVER_FORWARD) delete headers[name];
    if (options.key) headers[DOOR_HEADER] = options.key;
    if (headers.origin) headers.origin = `http://${inner}`;
    const up = httpRequest({ host: "127.0.0.1", port: options.upstreamPort, method: req.method, path: target, headers }, (answer) => {
      const out: Record<string, string | string[] | undefined> = { ...answer.headers, "x-frame-options": "DENY", "x-content-type-options": "nosniff" };
      // The web app's own cookies are for this computer's browser; a device keeps only the door's.
      delete out["set-cookie"];
      // Each page a paired device opens starts its cookie's time again (and a cookie from before the rename becomes the new one).
      if (refresh) out["set-cookie"] = cookiesFor(refresh, req.headers.cookie);
      res.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) json(res, 502, "web_unreachable", "This phone can't reach Open Sourcebook on your computer right now. Check that it is still running there, and that this phone is on the same Wi-Fi.");
      else res.destroy();
    });
    req.pipe(up);
  }

  /** Every check before anything is served. Answers and returns undefined when the request stops here. */
  function admit(req: IncomingMessage, res: ServerResponse | undefined): { host: string; fromHere: boolean; device?: Device } | undefined {
    const deny = (status: number, error: string, message: string) => {
      if (res) json(res, status, error, message);
      return undefined;
    };
    const host = hostOf(req.headers.host, door.port);
    if (!host || !names().has(host)) return deny(421, "wrong_host", "This address is not this computer.");
    const hostHeader = req.headers.host!.trim().toLowerCase();
    const fromHere = local(req.socket.remoteAddress ?? "");
    const changes = !SAFE.has(req.method ?? "GET");
    // This computer's own tools (no Origin and no Sec-Fetch-Site at all) may write; a browser must be same-origin.
    const browser = req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined;
    if (changes && (browser || !fromHere) && crossSite(req, hostHeader)) return deny(403, "cross_site", "Requests must come from Open Sourcebook's own page.");
    const device = fromHere ? undefined : options.store.find(cookieToken(req.headers.cookie));
    return { host: hostHeader, fromHere, ...(device ? { device } : {}) };
  }

  const server = createServer((req, res) => {
    const target = canonicalTarget(req.url);
    if (!target) return json(res, 400, "bad_path", "This address is not one of Open Sourcebook's pages.");
    const path = target.split("?")[0]!;
    if (path === "/pair" && (req.method === "GET" || req.method === "HEAD")) {
      // The pairing page is the one page anyone who reaches the right address may see.
      const host = hostOf(req.headers.host, door.port);
      if (!host || !names().has(host)) return json(res, 421, "wrong_host", "This address is not this computer.");
      return pairingPage(res);
    }
    const admitted = admit(req, res);
    if (!admitted) return;
    if (PAIR_PATHS.has(path)) {
      if (req.method !== "POST") return json(res, 405, "method_not_allowed", "Post the code.");
      return void pair(req, res);
    }
    const allowed = admitted.fromHere || admitted.device !== undefined;
    if (PING_PATHS.has(path)) {
      return allowed ? send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8") : json(res, 401, "not_paired", "Scan the code on your computer to use Open Sourcebook on this phone.");
    }
    if (!allowed) {
      if (wantsPage(req)) return pairingPage(res, 401);
      return json(res, 401, "not_paired", "Scan the code on your computer to use Open Sourcebook on this phone.");
    }
    if (isPhoneRoute(path)) {
      return json(res, 403, "this_computer_only", "Paired devices are managed on the computer Open Sourcebook runs on, at its own address.");
    }
    forward(req, res, target, admitted.device && wantsPage(req) ? cookieToken(req.headers.cookie) : undefined);
  });

  // The web app's live reload runs over a WebSocket; it gets the same checks, then the two sockets are joined.
  server.on("upgrade", (req: IncomingMessage, socket, head: Buffer) => {
    const target = canonicalTarget(req.url);
    const admitted = target ? admit(req, undefined) : undefined;
    if (!target || !admitted || !(admitted.fromHere || admitted.device) || isPhoneRoute(target.split("?")[0]!) || (req.headers.origin !== undefined && req.headers.origin !== `http://${admitted.host}`)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    const inner = `127.0.0.1:${options.upstreamPort}`;
    const up = connect(options.upstreamPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${target} HTTP/1.1`];
      if (options.key) lines.push(`${DOOR_HEADER}: ${options.key}`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        const lower = name.toLowerCase();
        if (NEVER_FORWARD.includes(lower)) continue;
        const value = lower === "host" ? inner : lower === "origin" ? `http://${inner}` : req.rawHeaders[i + 1]!;
        lines.push(`${name}: ${value}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  const door = { server, port: 0, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: options.listenHost ?? "0.0.0.0", port: options.port }, () => resolve());
  });
  const address = server.address();
  door.port = typeof address === "object" && address ? address.port : options.port;
  return door;
}

/** The one page an unpaired device sees, and the page the QR code opens. Self-contained; light and dark. */
function pairingPage(res: ServerResponse, status = 200): void {
  const nonce = randomBytes(16).toString("base64");
  send(res, status, PAGE.replace("__NONCE__", nonce), "text/html; charset=utf-8", {
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "referrer-policy": "no-referrer",
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Open Sourcebook</title>
<style>
  :root { --bg: #f7f7f5; --ink: #1c1c1a; --mute: #6b6b66; --edge: #e2e2dd; --accent: #2f5bd3; --bad: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --ink: #ececea; --mute: #a2a29c; --edge: #2c2c2a; --accent: #8fa9ff; --bad: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
    font: 17px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
    padding: max(24px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); }
  main { max-width: 26rem; }
  .logo { font-weight: 700; font-size: 28px; letter-spacing: -0.02em; margin: 0 0 28px; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; color: var(--mute); }
  #state { color: var(--ink); min-height: 1.5em; }
  #state.bad { color: var(--bad); }
  small { display: block; margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--edge); color: var(--mute); font-size: 14px; }
</style>
</head>
<body>
<main>
  <p class="logo">Open Sourcebook</p>
  <h1>Scan the code on your computer</h1>
  <p>Open Sourcebook runs on your computer. To use it on this phone, start Open Sourcebook on your computer, go to Settings there and turn on <b>Open on your phone</b>. Then point this phone's camera at the code it shows.</p>
  <p id="state" role="status"></p>
  <small>Open Sourcebook reaches this phone over your home network in plain HTTP, which is not encrypted. Use it on a network you trust.</small>
</main>
<script nonce="__NONCE__">
(function () {
  var code = location.hash.slice(1);
  var state = document.getElementById("state");
  if (!code) return;
  // The code leaves the address bar before anything else, so it is in no history entry or shared link.
  history.replaceState(null, "", "/pair");
  state.textContent = "Pairing this phone...";
  fetch("/_opensourcebook/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code }), credentials: "same-origin" })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (a) {
      if (a.ok) { state.textContent = "Paired. Opening Open Sourcebook..."; location.replace("/"); return; }
      state.className = "bad";
      state.textContent = a.body && a.body.message ? a.body.message : "That did not work. Scan the code again.";
    })
    .catch(function () { state.className = "bad"; state.textContent = "This phone can't reach Open Sourcebook on your computer right now. Check that it is still running there, and that this phone is on the same Wi-Fi."; });
})();
</script>
</body>
</html>
`;
