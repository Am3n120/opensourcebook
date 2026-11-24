/**
 * The toolbox's way out to the web, for real, on this computer only: a server at 127.0.0.1 stands in for a public
 * site (see fixtures/web.ts) and a server at [::1] for something private, the web app's engine say, that keeps every
 * request it gets. Whatever the public one does (redirect, a name that changes its address, a playlist, a page whose
 * scripts reach for the private one), the private one must get nothing and nothing of it may come back.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { useChrome } from "../src/chrome.ts";
import { pageHtml, takeScreenshot } from "../src/toolbox/headless.ts";
import type { Toolbox } from "../src/toolbox/index.ts";
import { checkUrl, connectPinned, fetchChecked, Refused, resolveHost, type Web } from "../src/toolbox/net.ts";
import { withRelay } from "../src/toolbox/relay.ts";
import { frameAt, resolveVideo } from "../src/toolbox/video.ts";
import { callTool, emptyDraft, type ToolContext } from "../src/tools.ts";
import { DEFAULT_LIMITS } from "../src/script.ts";
import { listStyles } from "../src/styles.ts";
import { silentVoice } from "../src/voice.ts";
import { passages } from "./fixtures/scenes.ts";
import { loopbackAsPublic, serve, type Served } from "./fixtures/web.ts";

const chrome = useChrome();
const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-guard-"));
const SECRET = "SECRET-PROJECT-LIST";
let pub: Served;
let inside: Served;
/** Where the private server is, as the public one's pages and redirects name it. */
let secret = "";

before(async () => {
  inside = await serve("::1", (_req, res) => res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify({ projects: SECRET })));
  secret = `${inside.origin}/api/v1/projects`;
  const clip = join(folder, "clip.mp4");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:duration=2:rate=10", "-pix_fmt", "yuv420p", clip], { timeout: 60_000 });
  pub = await serve("127.0.0.1", (req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/hop") return void res.writeHead(302, { location: secret }).end();
    if (path === "/hop-twice") return void res.writeHead(301, { location: "/hop" }).end();
    if (path === "/hop.mp4") return void res.writeHead(302, { location: `${inside.origin}/secret.mp4` }).end();
    if (path === "/list.m3u8") return void res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${inside.origin}/segment.ts\n#EXT-X-ENDLIST\n`);
    if (path === "/clip.mp4") return void res.writeHead(200, { "content-type": "video/mp4" }).end(readFileSync(clip));
    if (path === "/pic.png") return void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    if (path === "/worker.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(`fetch(${JSON.stringify(secret + "?from=worker")}).catch(() => {}); try { new WebSocket(${JSON.stringify(secret.replace("http", "ws") + "?from=worker")}); } catch {}`);
    if (path === "/sw.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(`self.addEventListener("install", () => fetch(${JSON.stringify(secret + "?from=sw")}).catch(() => {}));`);
    if (path === "/hostile") {
      // Almost no text, so open_page reads it in Chrome; then every way a page can reach for another address.
      return void res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Hostile</title><p>Hi.</p>
<img src="/pic.png" id="ok"><img src="${secret}?from=img"><iframe src="${secret}?from=iframe"></iframe>
<link rel="prefetch" href="${secret}?from=prefetch"><link rel="stylesheet" href="${secret}?from=css">
<script src="${secret}?from=script"></script>
<script>
  fetch(${JSON.stringify(secret + "?from=fetch")}).then((r) => r.text()).then((t) => document.body.insertAdjacentText("beforeend", t)).catch(() => {});
  fetch(${JSON.stringify(`http://[::ffff:7f00:1]:${inside.port}/?from=mapped`)}).catch(() => {});
  const x = new XMLHttpRequest(); x.open("GET", ${JSON.stringify(secret + "?from=xhr")}); x.send();
  try { new WebSocket(${JSON.stringify(secret.replace("http", "ws") + "?from=ws")}); } catch {}
  try { new WebSocket(${JSON.stringify(`ws://localhost:${inside.port}/?from=ws-name`)}); } catch {}
  navigator.sendBeacon(${JSON.stringify(secret + "?from=beacon")}, "x");
  try { new Worker("/worker.js"); } catch {}
  navigator.serviceWorker?.register("/sw.js").catch(() => {});
  setTimeout(() => { location = ${JSON.stringify(secret + "?from=location")}; }, 50);
</script>`);
    }
    res.writeHead(404).end();
  });
});
after(async () => {
  await pub?.close();
  await inside?.close();
  rmSync(folder, { recursive: true, force: true });
});

const nothingInside = () => assert.deepEqual(inside.hits, [], "the private server got no request");

test("a redirect to a private address is refused at the hop, however many hops in", async () => {
  const web = loopbackAsPublic();
  await assert.rejects(fetchChecked(`${pub.origin}/hop`, { maxBytes: 1e6 }, web), /private network/);
  await assert.rejects(fetchChecked(`${pub.origin}/hop-twice`, { maxBytes: 1e6 }, web), /private network/);
  nothingInside();
  assert.ok(pub.hits.includes("GET /hop-twice") && pub.hits.includes("GET /hop"), "the public hops were followed");
});

test("a name is looked up once, and the connection goes to the address that was checked", async () => {
  // Two servers on one port, 127.0.0.1 (public here) and [::1] (private); the name answers public first, private after.
  const twin = await serve("127.0.0.1", (_req, res) => res.writeHead(200).end("public page"));
  const same = await serve("::1", (_req, res) => res.writeHead(200).end(SECRET), twin.port);
  try {
    const asked: string[] = [];
    const flipping: Web = loopbackAsPublic(async (h) => (asked.push(h), [asked.length === 1 ? "127.0.0.1" : "::1"]));
    const url = `http://flip.test:${twin.port}/`;
    const got = await fetchChecked(url, { maxBytes: 1e6 }, flipping);
    assert.equal(got.bytes.toString(), "public page");
    assert.equal(asked.length, 1, "looked up once");
    assert.deepEqual(same.hits, [], "the private twin got nothing");
    // The name now answers private: a new check refuses it, and a connection pinned to the old answer still goes there.
    await assert.rejects(checkUrl(url, flipping.resolve, flipping.allows), /private network/);
    const res = await connectPinned(new URL(url), {}, { address: "127.0.0.1", family: 4 });
    assert.equal(await res.text(), "public page");
    assert.deepEqual(same.hits, []);
  } finally {
    await same.close();
    await twin.close();
  }
});

test("ffmpeg's own redirects and playlist parts go through the relay and a private one is refused", async () => {
  const web = loopbackAsPublic();
  const out = join(folder, "frame.jpg");
  await withRelay(web, (relay) => frameAt(`${pub.origin}/clip.mp4`, 0.5, out, relay));
  await assert.rejects(withRelay(web, (relay) => frameAt(`${pub.origin}/hop.mp4`, 0.5, join(folder, "x.jpg"), relay)));
  await assert.rejects(withRelay(web, (relay) => frameAt(`${pub.origin}/list.m3u8`, 0.5, join(folder, "y.jpg"), relay)));
  await assert.rejects(withRelay(web, (relay) => frameAt(secret, 0.5, join(folder, "z.jpg"), relay)));
  nothingInside();
});

test("the relay refuses a program that does not have its password, and private tunnels", async () => {
  const web = loopbackAsPublic();
  await withRelay(web, async (relay) => {
    const { host, password } = new URL(relay);
    const ask = (head: string) =>
      new Promise<string>((resolve) => {
        import("node:net").then(({ connect }) => {
          const s = connect(Number(host.split(":")[1]), "127.0.0.1", () => s.write(head));
          let got = "";
          s.on("data", (d) => (got += d));
          s.on("close", () => resolve(got));
          s.on("error", () => resolve(got));
          setTimeout(() => s.destroy(), 3000);
        });
      });
    const auth = `Proxy-Authorization: Basic ${Buffer.from(`opensourcebook:${password}`).toString("base64")}\r\n`;
    assert.match(await ask(`GET ${pub.origin}/pic.png HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 407/);
    assert.match(await ask(`GET ${pub.origin}/pic.png HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`), /^HTTP\/1\.1 200/);
    assert.match(await ask(`GET ${secret} HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`), /^HTTP\/1\.1 403/);
    assert.match(await ask(`CONNECT [::1]:${inside.port} HTTP/1.1\r\nHost: x\r\n${auth}\r\n`), /^HTTP\/1\.1 403/);
    assert.match(await ask(`CONNECT [::ffff:a9fe:a9fe]:80 HTTP/1.1\r\nHost: x\r\n${auth}\r\n`), /^HTTP\/1\.1 403/);
    assert.match(await ask(`CONNECT localhost:${inside.port} HTTP/1.1\r\nHost: x\r\n${auth}\r\n`), /^HTTP\/1\.1 403/);
  });
  nothingInside();
});

const ytdlp = (() => {
  try {
    return execFileSync("which", ["yt-dlp"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
})();

test("yt-dlp opens a page through the relay, so a redirect to a private address is refused", { skip: !ytdlp && "yt-dlp is not installed" }, async () => {
  await assert.rejects(withRelay(loopbackAsPublic(), (relay) => resolveVideo(`${pub.origin}/hop`, ytdlp, relay)));
  nothingInside();
});

test("headless Chrome reaches nothing private, whatever the page's scripts, tags and redirects ask for", { skip: !chrome && "no headless Chrome" }, async () => {
  const web = loopbackAsPublic();
  const html = await pageHtml(chrome!, `${pub.origin}/hostile`, { width: 800, height: 600 }, web, { timeout: 40_000 });
  assert.match(html, /<title>Hostile<\/title>/);
  assert.doesNotMatch(html, new RegExp(SECRET));
  assert.ok(pub.hits.includes("GET /pic.png"), "the page's own picture was fetched for it");
  await takeScreenshot(chrome!, `${pub.origin}/hostile`, join(folder, "shot.png"), { width: 800, height: 600 }, web, { timeout: 40_000 });
  await assert.rejects(pageHtml(chrome!, `${pub.origin}/hop`, { width: 800, height: 600 }, web, { timeout: 40_000 }), /could not open/);
  await assert.rejects(pageHtml(chrome!, secret, { width: 800, height: 600 }, web, { timeout: 40_000 }), /private network/);
  for (const url of ["file:///etc/hosts", "chrome://version", "view-source:http://example.org/", "data:text/html,hi", "javascript:alert(1)"]) await assert.rejects(pageHtml(chrome!, url, { width: 800, height: 600 }, web, { timeout: 10_000 }), Refused, url);
  nothingInside();
});

test("open_page on a private address in any spelling, or a page that reaches for one, returns nothing of it", { skip: !chrome && "no headless Chrome" }, async () => {
  const box: Toolbox = { fetch, web: loopbackAsPublic(), env: {}, chrome: chrome! };
  const context = (b: Toolbox): ToolContext => ({
    request: { id: "g1", title: "Guard", brief: "a page", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 12, style: "chalkboard", passages, limits: DEFAULT_LIMITS },
    draft: emptyDraft(),
    folder,
    styles: listStyles(),
    voice: silentVoice(),
    step: () => undefined,
    save: () => undefined,
    toolbox: b,
  });
  // The real web, as the toolbox has it: the public stand-in at 127.0.0.1 is this computer again, in every spelling.
  const real = context({ ...box, web: { resolve: resolveHost, connect: connectPinned } });
  const spelled = ["127.0.0.1", "[::ffff:7f00:1]", "[::ffff:127.0.0.1]", "[::7f00:1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::]", "2130706433", "0x7f.1", "0177.0.0.1", "127.1", "localhost"];
  for (const host of spelled) {
    const got = await callTool("open_page", { url: `http://${host}:${pub.port}/spelled` }, real);
    assert.equal(got.isError, true, host);
    assert.match(got.text, /this computer/, host);
  }
  assert.ok(!pub.hits.some((h) => h.includes("/spelled")), "no spelling of this computer reached it");
  const ctx = context(box);
  for (const url of [secret, `${pub.origin}/hop`]) {
    const got = await callTool("open_page", { url }, ctx);
    assert.equal(got.isError, true, url);
    assert.doesNotMatch(got.text, new RegExp(SECRET));
  }
  const page = await callTool("open_page", { url: `${pub.origin}/hostile`, screenshot: "desktop" }, ctx);
  assert.doesNotMatch(page.text, new RegExp(SECRET));
  assert.match(page.text, /Hostile/);
  nothingInside();
});
