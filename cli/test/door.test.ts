import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { DeviceStore, IDLE_LIMIT_MS, deviceName } from "../devices.ts";
import { COOKIE_LIFE_S, canonicalTarget, hostOf, isLoopback, isPhoneRoute, openDoor, type Door } from "../door.ts";
import { PairingCodes, TRIES_PER_ADDRESS, CODE_LIFE_MS } from "../pairing.ts";
import { PROGRAMS, type Wiring } from "../programs.ts";

/** The web app behind the door: answers with what it was sent. */
let upstream: Server;
let upstreamPort = 0;
const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders }> = [];

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  upstream.on("upgrade", (req, socket) => {
    seen.push({ method: "UPGRADE", url: req.url!, headers: req.headers });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as { port: number }).port;
});
after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const LAN = "192.168.1.50";
let dir: string;
let store: DeviceStore;
let codes: PairingCodes;
let clock = 1_000_000;
let door: Door;

async function open(remote: boolean): Promise<Door> {
  dir = mkdtempSync(join(tmpdir(), "opensourcebook-door-"));
  store = new DeviceStore(join(dir, "devices.json"));
  codes = new PairingCodes(() => clock);
  return openDoor({
    upstreamPort,
    port: 0,
    listenHost: "127.0.0.1",
    store,
    codes,
    names: () => new Set([LAN, "127.0.0.1", "localhost"]),
    // Every test connection comes from loopback; this one pretends it came from a phone on the network.
    isThisComputer: () => !remote,
  });
}

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(path: string, options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: door.port, path, method: options.method ?? "GET", headers: { host: options.host ?? `${LAN}:${door.port}`, ...options.headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const origin = () => `http://${LAN}:${door.port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", origin: origin(), ...headers } });

async function pairOnce(): Promise<string> {
  const { code } = codes.issue();
  const answer = await post("/_opensourcebook/pair", { code }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1" });
  assert.equal(answer.status, 200, answer.body);
  const cookie = String(answer.headers["set-cookie"]);
  return cookie.split(";")[0]!;
}

beforeEach(async () => {
  seen.length = 0;
  if (door) await door.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  door = await open(true);
});
after(async () => {
  await door?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("door: an unpaired device sees only the pairing page, and nothing reaches the web app", async () => {
  const page = await call("/", { headers: { accept: "text/html" } });
  assert.equal(page.status, 401);
  assert.match(page.body, /Scan the code on your computer/);
  assert.match(page.body, /plain HTTP/);
  const api = await call("/api/v1/projects");
  assert.equal(api.status, 401);
  assert.equal(JSON.parse(api.body).error, "not_paired");
  const src = await call("/src/main.tsx");
  assert.equal(src.status, 401);
  assert.equal(seen.length, 0);
});

test("door: the pairing page is locked down: a nonce for its one script, no referrer, no framing", async () => {
  const page = await call("/pair");
  assert.equal(page.status, 200);
  const csp = String(page.headers["content-security-policy"]);
  const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(page.body.includes(`nonce="${nonce}"`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["x-frame-options"], "DENY");
  // The script takes the code out of the address bar before it sends it.
  assert.ok(page.body.indexOf("history.replaceState") < page.body.indexOf("fetch("));
});

test("door: a right code pairs once, with a cookie scripts cannot read, stored only as a hash", async () => {
  const { code } = codes.issue();
  const answer = await post("/_opensourcebook/pair", { code }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Version/26.0 Mobile/15E148 Safari/604.1" });
  assert.equal(answer.status, 200);
  const cookie = String(answer.headers["set-cookie"]);
  assert.match(cookie, /^opensourcebook_device=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  const token = cookie.slice("opensourcebook_device=".length, cookie.indexOf(";"));
  const file = readFileSync(join(dir, "devices.json"), "utf8");
  assert.ok(!file.includes(token), "the token itself is not on disk");
  assert.match(file, /"tokenHash": "[0-9a-f]{64}"/);
  assert.deepEqual(store.list().map((d) => d.name), ["iPhone, Safari"]);

  const again = await post("/_opensourcebook/pair", { code });
  assert.equal(again.status, 410);
  assert.equal(JSON.parse(again.body).error, "code_gone");
  assert.equal(store.list().length, 1);
});

test("door: a paired device reaches the web app as if it were this computer, and its token stays at the door", async () => {
  const cookie = await pairOnce();
  const answer = await call("/api/v1/projects?x=1", { headers: { cookie, referer: `${origin()}/feed` } });
  assert.equal(answer.status, 200);
  const got = seen.at(-1)!;
  assert.equal(got.url, "/api/v1/projects?x=1");
  assert.equal(got.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(got.headers.cookie, undefined);
  assert.equal(got.headers.referer, undefined);
  assert.equal(answer.headers["x-frame-options"], "DENY");

  const write = await call("/api/v1/chats/c/messages", { method: "POST", body: "{}", headers: { cookie, origin: origin(), "content-type": "application/json" } });
  assert.equal(write.status, 200);
  assert.equal(seen.at(-1)!.headers.origin, `http://127.0.0.1:${upstreamPort}`);
});

test("door: wrong codes are counted and a guessing address is refused, but guesses from many addresses never close the code", async () => {
  const { code } = codes.issue();
  for (let i = 0; i < TRIES_PER_ADDRESS; i++) assert.equal((await post("/_opensourcebook/pair", { code: `guess-${i}` })).status, 403);
  const limited = await post("/_opensourcebook/pair", { code });
  assert.equal(limited.status, 429, "even the right code waits once an address has guessed too often");
  assert.equal(store.list().length, 0);

  // Someone on the network guessing from many addresses cannot shut the pairing step for the person.
  const fresh = new PairingCodes(() => clock);
  const open = fresh.issue();
  for (let i = 0; i < 200; i++) assert.equal(fresh.redeem(`guess-${i}`, `10.0.${i >> 8}.${i & 255}`), "wrong");
  assert.ok(fresh.openUntil(), "the open code stays open");
  assert.equal(fresh.redeem(open.code, "10.0.9.9"), "paired", "and the person's phone still pairs with it");
});

test("door: a device's cookie lasts thirty days from the last page it opened, and an unused device stops being paired", async () => {
  const cookie = await pairOnce();
  const page = await call("/feed", { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200);
  const again = String(page.headers["set-cookie"]);
  assert.ok(again.startsWith(`${cookie};`), "a page opened gives the same cookie a fresh life");
  assert.match(again, new RegExp(`Max-Age=${COOKIE_LIFE_S}`));
  assert.match(again, /HttpOnly/);
  assert.match(again, /SameSite=Strict/);
  assert.equal(COOKIE_LIFE_S, 30 * 24 * 60 * 60);
  // The web app's own cookies never reach a device.
  assert.equal((await call("/api/v1/projects", { headers: { cookie } })).headers["set-cookie"], undefined);

  const later = new DeviceStore(join(dir, "devices.json"), () => new Date(Date.now() + IDLE_LIMIT_MS + 60_000));
  assert.equal(later.find(cookie.split("=")[1]), undefined, "a device not seen for thirty days must pair again");
});

test("door: a code runs out", async () => {
  const { code } = codes.issue();
  clock += CODE_LIFE_MS + 1;
  const answer = await post("/_opensourcebook/pair", { code });
  assert.equal(answer.status, 410);
  assert.equal(codes.openUntil(), undefined);
});

test("door: a Host that is not this computer is refused, before anything else", async () => {
  const cookie = await pairOnce();
  for (const host of ["evil.example", `evil.example:${door.port}`, `${LAN}:1`, `${LAN}`, `${LAN}.evil.example:${door.port}`, "a b"]) {
    const answer = await call("/api/v1/projects", { host, headers: { cookie } });
    assert.ok(answer.status === 421 || answer.status === 400, `host "${host}" got ${answer.status}`);
  }
  assert.equal((await call("/pair", { host: `rebound.example:${door.port}` })).status, 421);
  assert.equal(seen.length, 0);
  assert.equal(hostOf(`[::1]:${door.port}`, door.port), "::1");
  assert.equal(hostOf("Example.COM:80", 80), "example.com");
});

test("door: a cross-site write is refused, with or without the cookie", async () => {
  const cookie = await pairOnce();
  const form = { method: "POST", body: "title=x", headers: { cookie, "content-type": "application/x-www-form-urlencoded" } };
  assert.equal((await call("/api/v1/projects", { ...form, headers: { ...form.headers, origin: "http://evil.example" } })).status, 403);
  assert.equal((await call("/api/v1/projects", { ...form, headers: { ...form.headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await call("/api/v1/projects", form)).status, 403, "no Origin and no Sec-Fetch-Site from a device is refused");
  assert.equal((await call("/api/v1/projects", { ...form, headers: { ...form.headers, "sec-fetch-site": "same-origin" } })).status, 200);
  // Pairing itself is a write: another site cannot pair the browser it runs in.
  const { code } = codes.issue();
  assert.equal((await post("/_opensourcebook/pair", { code }, { origin: "http://evil.example" })).status, 403);
  assert.equal((await call("/_opensourcebook/pair", { method: "POST", body: JSON.stringify({ code }), headers: { origin: origin(), "content-type": "text/plain" } })).status, 415);
});

test("door: a removed device is refused at once, also when another process removed it", async () => {
  const cookie = await pairOnce();
  assert.equal((await call("/api/v1/projects", { headers: { cookie } })).status, 200);
  // `opensourcebook devices remove` is another process with its own copy of the store.
  const other = new DeviceStore(join(dir, "devices.json"));
  assert.ok(other.remove(other.list()[0]!.id));
  assert.equal((await call("/api/v1/projects", { headers: { cookie } })).status, 401);
  assert.equal((await call("/api/v1/projects", { headers: { cookie: "opensourcebook_device=not-a-token" } })).status, 401);
  assert.equal((await call("/api/v1/projects", { headers: { cookie: `opensourcebook_device=${"x".repeat(500)}` } })).status, 401);
});

test("door: paired devices cannot manage pairing; that is for this computer", async () => {
  const cookie = await pairOnce();
  assert.equal((await call("/api/phone", { headers: { cookie } })).status, 403);
  assert.equal((await call("/api/phone/devices/abc", { method: "DELETE", headers: { cookie, origin: origin() } })).status, 403);
  assert.equal(seen.length, 0);
});

/** `call`, with a request the HTTP parser refuses outright (it closes the connection) as status 0. */
const tryCall = (path: string, options: Parameters<typeof call>[1] = {}) => call(path, options).catch(() => ({ status: 0, headers: {}, body: "" }) as Answer);

/** What the web app behind the door would read a path as: its proxy reads paths with the URL parser. */
const asTheAppReadsIt = (target: string) => {
  try {
    return decodeURIComponent(new URL(target, "http://web.test").pathname).toLowerCase();
  } catch {
    return target.toLowerCase();
  }
};

test("door: no spelling of a path reaches the phone's management through the door", async () => {
  const cookie = await pairOnce();
  const spellings = [
    "/api/./phone", "/api/v1/../phone", "/api/v1/%2e%2e/phone", "/api/v1/%2E%2E/phone", "/api/v1/.%2e/phone", "/api/%2e/phone",
    "//api/phone", "/api//phone", "/api/phone/", "/api\\phone", "/api%2fphone", "/api%2Fphone", "/api/%70hone", "/API/phone", "/api/Phone",
    "/api/phone%2f..", "/api/v1/..%2fphone", "/api/v1/%2e%2e%2fphone", "/api/./phone/code", "/api/v1/../phone/devices/abc", "/./api/phone",
    "/api/phone;x", "/api/phone%00", "/api/ph%6fne/off", "/a/../api/phone", "/api/phone/.", "/api/phone/..", "/api/v1/%252e%252e/phone",
  ];
  for (const path of spellings) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const answer = await tryCall(path, { method, headers: { cookie, origin: origin(), "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
      // 0: the HTTP parser itself refused the request line, which also passes nothing on.
      assert.ok([0, 400, 403].includes(answer.status), `${method} ${path} got ${answer.status}`);
    }
  }
  assert.ok(!seen.some((s) => asTheAppReadsIt(s.url).startsWith("/api/phone")), `forwarded: ${seen.map((s) => s.url).join(", ")}`);
});

test("door: a property over generated spellings: whatever the door passes on, the app reads exactly as the door did", async () => {
  const cookie = await pairOnce();
  // A small seeded generator, so a failure names a case that comes back the same.
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const pieces = ["api", "phone", "v1", "projects", ".", "..", "%2e", "%2E", "%2e%2e", ".%2e", "%2f", "%5c", "", "%70hone", "PHONE", "%25", "x", "%41"];
  const joins = ["/", "//", "\\", "/./", "/../"];
  for (let i = 0; i < 600; i++) {
    let path = "";
    const parts = 1 + rnd(5);
    for (let j = 0; j < parts; j++) path += joins[rnd(joins.length)]! + pieces[rnd(pieces.length)]!;
    if (!path.startsWith("/")) path = `/${path}`;
    seen.length = 0;
    const answer = await tryCall(path, { headers: { cookie } });
    if (answer.status === 200) {
      const got = seen.at(-1)!;
      assert.equal(got.url, path, "the door passes on the path it decided on, unchanged");
      assert.equal(new URL(path, "http://web.test").pathname, path, `${path}: the app reads the same path`);
      assert.ok(!asTheAppReadsIt(path).startsWith("/api/phone"), `${path} reached the phone's management`);
    } else {
      assert.ok([0, 400, 403].includes(answer.status), `${path} got ${answer.status}`);
      assert.equal(seen.length, 0, `${path} was refused, and nothing of it was passed on`);
    }
  }
});

test("door: what it passes on carries its own key, and nothing a device sends can claim to be the door or another program", async () => {
  await door.close();
  dir = mkdtempSync(join(tmpdir(), "opensourcebook-door-"));
  store = new DeviceStore(join(dir, "devices.json"));
  codes = new PairingCodes(() => clock);
  door = await openDoor({ upstreamPort, port: 0, listenHost: "127.0.0.1", store, codes, names: () => new Set([LAN]), isThisComputer: () => false, key: "door-key-of-this-run" });
  const cookie = await pairOnce();
  await call("/api/v1/projects", { headers: { cookie, "x-opensourcebook-door": "forged", authorization: "Bearer engine-token", "x-client-token": "t", "x-phone-token": "p" } });
  const got = seen.at(-1)!;
  assert.equal(got.headers["x-opensourcebook-door"], "door-key-of-this-run");
  assert.equal(got.headers.authorization, undefined);
  assert.equal(got.headers["x-client-token"], undefined);
  assert.equal(got.headers["x-phone-token"], undefined);
  assert.equal(canonicalTarget("/api/v1/projects?q=a/../b"), "/api/v1/projects?q=a/../b", "a query is passed on as it is");
  assert.equal(canonicalTarget("/src/App.tsx?t=1"), "/src/App.tsx?t=1");
  assert.equal(canonicalTarget("/node_modules/.vite/deps/react.js?v=1"), "/node_modules/.vite/deps/react.js?v=1");
  assert.equal(canonicalTarget("/@vite/client"), "/@vite/client");
  assert.equal(canonicalTarget("http://evil.example/api/phone"), undefined);
  assert.ok(isPhoneRoute("/api/%70hone") && isPhoneRoute("/API/Phone/off") && !isPhoneRoute("/api/v1/phones"));
});

test("door: pairing the same device again replaces its entry", async () => {
  const cookie = await pairOnce();
  const { code } = codes.issue();
  assert.equal((await post("/_opensourcebook/pair", { code }, { cookie })).status, 200);
  assert.equal(store.list().length, 1);
});

test("door: ping says whether this device may reach Open Sourcebook", async () => {
  assert.equal((await call("/_opensourcebook/ping")).status, 401);
  const cookie = await pairOnce();
  assert.equal((await call("/_opensourcebook/ping", { headers: { cookie } })).status, 200);
});

test("door: a phone paired before the rename is still let in by its old cookie, and is given the new one", async () => {
  const cookie = await pairOnce();
  const token = cookie.slice("opensourcebook_device=".length);
  const old = `re_device=${token}`;
  assert.equal((await call("/_re/ping", { headers: { cookie: old } })).status, 200, "the old cookie and the old path both still work");
  assert.equal((await call("/api/v1/projects", { headers: { cookie: old } })).status, 200);
  const page = await call("/feed", { headers: { cookie: old, accept: "text/html" } });
  assert.equal(page.status, 200);
  const set = page.headers["set-cookie"] ?? [];
  assert.equal(set.length, 2);
  assert.match(set[0]!, new RegExp(`^opensourcebook_device=${token}; .*Max-Age=${30 * 24 * 60 * 60}`), "the same token under the new name");
  assert.match(set[1]!, /^re_device=; .*Max-Age=0/, "and the old name is taken away");
  assert.equal(store.list().length, 1, "it is the same paired device, not a second one");
  // A device that already holds the new cookie gets only that one.
  const now = await call("/feed", { headers: { cookie, accept: "text/html" } });
  assert.deepEqual((now.headers["set-cookie"] ?? []).map((c) => c.split("=")[0]), ["opensourcebook_device"]);
});

test("door: a pairing page loaded before the rename can still post its code to the old path", async () => {
  const { code } = codes.issue();
  const answer = await post("/_re/pair", { code });
  assert.equal(answer.status, 200, answer.body);
  assert.match(String(answer.headers["set-cookie"]), /^opensourcebook_device=[A-Za-z0-9_-]{43};/);
  assert.equal((await call("/_re/ping")).status, 401, "the old path asks for a paired device like the new one");
});

test("door: live reload's WebSocket gets the same checks", async () => {
  const upgrade = (headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const socket = connect(door.port, "127.0.0.1", () => {
        const lines = [`GET /?token=x HTTP/1.1`, `host: ${LAN}:${door.port}`, "upgrade: websocket", "connection: Upgrade", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      });
      let text = "";
      socket.on("data", (c) => (text += c));
      socket.on("close", () => resolve(text));
      socket.on("end", () => resolve(text));
    });
  assert.match(await upgrade({}), /^HTTP\/1.1 403/);
  const cookie = await pairOnce();
  assert.match(await upgrade({ cookie, origin: "http://evil.example" }), /^HTTP\/1.1 403/);
  assert.match(await upgrade({ cookie, origin: origin() }), /^HTTP\/1.1 101/);
  const got = seen.at(-1)!;
  assert.equal(got.method, "UPGRADE");
  assert.equal(got.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(got.headers.cookie, undefined);
});

test("door: this computer itself needs no pairing, but still the right Host and no cross-site writes", async () => {
  await door.close();
  door = await open(false);
  assert.equal((await call("/api/v1/projects", { host: `127.0.0.1:${door.port}` })).status, 200);
  assert.equal((await call("/api/v1/projects", { host: `evil.example:${door.port}` })).status, 421);
  assert.equal((await call("/api/v1/projects", { method: "POST", body: "{}", host: `127.0.0.1:${door.port}`, headers: { origin: "http://evil.example" } })).status, 403);
  // This computer's own tools send no Origin at all.
  assert.equal((await call("/api/v1/projects", { method: "POST", body: "{}", host: `127.0.0.1:${door.port}` })).status, 200);
});

test("door: only loopback counts as this computer", () => {
  assert.ok(isLoopback("127.0.0.1"));
  assert.ok(isLoopback("::ffff:127.0.0.1"));
  assert.ok(isLoopback("::1"));
  assert.ok(!isLoopback("192.168.1.50"));
  assert.ok(!isLoopback("::ffff:10.0.0.2"));
  assert.ok(!isLoopback(undefined));
});

test("door: the engine and the web app stay on this computer; only the door listens on the network", () => {
  const w: Wiring = { root: "/r", home: mkdtempSync(join(tmpdir(), "opensourcebook-wiring-")), ports: { engine: 1, "engine-inspector": 2, web: 3, connector: 4, scenes: 5, "phone-control": 6 }, secrets: { OPENSOURCEBOOK_CLIENT_TOKEN: "a", OPENSOURCEBOOK_CONNECTOR_TOKEN: "b", SCENES_TOKEN: "c", PHONE_TOKEN: "d" } as Wiring["secrets"], env: {} };
  const args = (id: string) => PROGRAMS.find((p) => p.id === id)!.start(w).args;
  assert.equal(args("engine")[args("engine").indexOf("--ip") + 1], "127.0.0.1");
  assert.equal(args("web")[args("web").indexOf("--host") + 1], "127.0.0.1");
  assert.equal(PROGRAMS.find((p) => p.id === "web")!.start(w).env.PHONE_URL, "http://127.0.0.1:6");
  rmSync(w.home, { recursive: true, force: true });
});

test("devices: names from the browser", () => {
  assert.equal(deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1"), "iPhone, Safari");
  assert.equal(deviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36"), "Android phone, Chrome");
  assert.equal(deviceName(undefined), "A device");
});
