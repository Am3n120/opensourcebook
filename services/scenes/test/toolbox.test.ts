/**
 * The toolbox with no network: the web, the archives and Meta are played by a fake fetch on made-up public
 * addresses, and pictures, PDFs and videos are made here with ffmpeg and Chrome. Saving, building with a kept picture,
 * looking at it, cutting a thing out and crediting it run for real.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { useChrome } from "../src/chrome.ts";
import { closeRenderer } from "../pipeline/stages/scene.ts";
import { playerProps } from "../pipeline/stages/render.ts";
import { finalBuild, renderVideo, shownAssets, voiceAll } from "../src/produce.ts";
import { systemPrompt } from "../src/prompt.ts";
import { readSkill } from "../src/skills.ts";
import { DEFAULT_LIMITS } from "../src/script.ts";
import { listStyles } from "../src/styles.ts";
import { callTool, emptyDraft, listing, type ToolContext } from "../src/tools.ts";
import { assetsIn, creditLine } from "../src/toolbox/assets.ts";
import { iaLicense, smithsonianHits } from "../src/toolbox/archives.ts";
import { cutWith } from "../src/toolbox/cutout.ts";
import type { Toolbox } from "../src/toolbox/index.ts";
import { allowsAddress, checkUrl, fetchChecked, Refused } from "../src/toolbox/net.ts";
import { parseAddress } from "../../../common/addresses.ts";
import { withRelay } from "../src/toolbox/relay.ts";
import { loopbackAsPublic, serve } from "./fixtures/web.ts";
import { readHtml } from "../src/toolbox/page.ts";
import { parsePages } from "../src/toolbox/pdf.ts";
import { pageHtml, printPdf, takeScreenshot } from "../src/toolbox/headless.ts";
import { searchesFor } from "../src/toolbox/search.ts";
import { frameAt } from "../src/toolbox/video.ts";
import { silentVoice } from "../src/voice.ts";
import { passages, script } from "./fixtures/scenes.ts";

const chrome = useChrome();
const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-toolbox-"));
after(async () => {
  await closeRenderer();
  rmSync(folder, { recursive: true, force: true });
});

// Pictures to serve: a wide test pattern, and a red disc on white to cut out.
const made = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-made-"));
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-y", "-v", "error", ...args], { timeout: 60_000 });
ff("-f", "lavfi", "-i", "testsrc2=size=1600x1000", "-frames:v", "1", join(made, "wide.jpg"));
ff("-f", "lavfi", "-i", "color=white:size=800x800", "-vf", "geq=r='if(lt(hypot(X-400,Y-400),200),255,255)':g='if(lt(hypot(X-400,Y-400),200),0,255)':b='if(lt(hypot(X-400,Y-400),200),0,255)'", "-frames:v", "1", join(made, "disc.jpg"));
const jpeg = (name: string) => readFileSync(join(made, name));
after(() => rmSync(made, { recursive: true, force: true }));

/** A fake web: each address answers with a body and a type; Meta answers by path. */
const web = new Map<string, { body: Buffer | string; type: string; status?: number; location?: string }>();
const calls: string[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  if (url.startsWith("https://api.meta.ai/v1/images/")) {
    const body = init?.body instanceof FormData ? Object.fromEntries([...init.body.entries()].filter(([, v]) => typeof v === "string")) : JSON.parse(String(init?.body));
    assert.equal(body.model, "muse-image-1.0");
    return new Response(JSON.stringify({ data: [{ b64_json: jpeg("wide.jpg").toString("base64") }] }), { headers: { "content-type": "application/json" } });
  }
  const page = web.get(url);
  if (!page) return new Response("not here", { status: 404 });
  return new Response(typeof page.body === "string" ? page.body : new Uint8Array(page.body), { status: page.status ?? 200, headers: { "content-type": page.type, ...(page.location ? { location: page.location } : {}) } });
}) as typeof fetch;
const resolve = async (h: string) => (h === "inside.example" ? ["192.168.1.20"] : ["93.184.216.34"]);
const box: Toolbox = { fetch: fakeFetch, web: { resolve, connect: fakeFetch }, env: { META_API_KEY: "test-key" }, ...(chrome ? { chrome } : {}) };

const ctx: ToolContext = {
  request: { id: "t1", title: "Levers", brief: "how a lever lifts a load", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 12, style: "chalkboard", passages, limits: DEFAULT_LIMITS },
  draft: emptyDraft(),
  folder,
  styles: listStyles(),
  voice: silentVoice(),
  step: () => undefined,
  save: () => undefined,
  toolbox: box,
};

test("addresses on this computer or a private network are never opened, redirects included", async () => {
  for (const ip of ["127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.0.9", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"]) assert.equal(allowsAddress(parseAddress(ip)!), false, ip);
  for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(allowsAddress(parseAddress(ip)!), true, ip);

  await assert.rejects(checkUrl("http://127.0.0.1:8650/status", resolve), Refused);
  await assert.rejects(checkUrl("http://localhost:8670/", resolve), Refused);
  await assert.rejects(checkUrl("https://inside.example/", resolve), /private network/);
  await assert.rejects(checkUrl("file:///etc/passwd", resolve), /Only http and https/);
  await assert.rejects(checkUrl("https://user:pw@example.org/", resolve), /user name or password/);
  web.set("https://example.org/hop", { body: "", type: "text/plain", status: 302, location: "http://127.0.0.1:8650/turns" });
  await assert.rejects(fetchChecked("https://example.org/hop", { maxBytes: 1e6 }, box.web), /this computer/);
  web.set("https://example.org/big", { body: Buffer.alloc(3000), type: "application/octet-stream" });
  await assert.rejects(fetchChecked("https://example.org/big", { maxBytes: 1000 }, box.web), /limit is/);
});

test("a page is read into its title, words, links and pictures", () => {
  const html = `<html><head><title>The Lever &amp; Its Parts</title><meta property="og:image" content="/og.jpg"><meta name="description" content="All about levers"></head>
  <body><nav><a href="/menu">Menu</a></nav><main><h1>Levers</h1><p>A lever turns on a <b>fulcrum</b>.</p><script>var x = 1;</script>
  <img src="/tiny.gif" width="16" height="16"><img src="/thumb.jpg" srcset="/a-small.jpg 300w, /a-big.jpg 1200w" alt="A see-saw"><a href="https://other.org/x">More about it</a></main></body></html>`;
  const page = readHtml(html, "https://example.org/levers/");
  assert.equal(page.title, "The Lever & Its Parts");
  assert.equal(page.description, "All about levers");
  assert.match(page.text, /# Levers\nA lever turns on a fulcrum \./);
  assert.doesNotMatch(page.text, /var x|Menu/);
  assert.deepEqual(page.links, [{ href: "https://other.org/x", text: "More about it" }]);
  assert.deepEqual(page.images.map((i) => i.src), ["https://example.org/og.jpg", "https://example.org/a-big.jpg"]);
  assert.equal(page.images[1]!.alt, "A see-saw");
});

test("archive answers become credited hits, and only open licenses count", () => {
  assert.equal(iaLicense("https://creativecommons.org/licenses/by-sa/4.0/"), "CC BY-SA 4.0");
  assert.equal(iaLicense("https://creativecommons.org/publicdomain/zero/1.0/"), "CC0");
  assert.equal(iaLicense("https://creativecommons.org/licenses/by-nc/4.0/"), null);
  const hits = smithsonianHits({ response: { rows: [{ title: "Telescope", content: { descriptiveNonRepeating: { data_source: "Air and Space", record_link: "https://si.edu/x", online_media: { media: [{ type: "Images", idsId: "abc", usage: { access: "CC0" } }] } } } }, { title: "Closed", content: { descriptiveNonRepeating: { online_media: { media: [{ type: "Images", idsId: "z", usage: { access: "Usage conditions apply" } }] } } } }] } });
  assert.equal(hits.length, 1);
  assert.equal(creditLine(hits[0]!.origin), "Air and Space, Smithsonian (CC0)");
});

test("the agent is offered the toolbox this computer can run, and told what it is for", () => {
  const names = listing(box).map((t) => t.name);
  for (const n of ["read_passages", "finish", "web_search", "open_page", "find_images", "view_images", "save_image", "generate_image", "video_frames", "read_pdf", "cut_out", "assets"]) assert.ok(names.includes(n), n);
  const keyless = listing({ ...box, env: {} }).map((t) => t.name);
  assert.ok(!keyless.includes("generate_image") && !keyless.includes("cut_out"), "paid tools need the key");
  assert.ok(keyless.includes("web_search"), "Wikipedia's search needs no key");
  assert.deepEqual(listing().map((t) => t.name), ["read_passages", "read_skill", "about_video", "write_beat", "look", "render", "watch", "viewer_report", "sound", "finish", "find_piece", "save_piece"]);
  // What each picture tool is for is knowledge in the media skill, not in the instructions.
  assert.match(systemPrompt(), /- media: /);
  assert.match(readSkill("media", undefined, { language: "" })!, /`generate_image` makes a picture/);
});

test("find_images shows archive hits as pictures with ids, and save_image keeps one with its credit", async () => {
  web.set("https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=24&gsrsearch=lever&prop=imageinfo&iiprop=url|extmetadata|mime|size&iiurlwidth=2048", {
    type: "application/json",
    body: JSON.stringify({ query: { pages: { 1: { index: 1, title: "File:Lever.jpg", imageinfo: [{ mime: "image/jpeg", width: 1600, height: 1000, thumburl: "https://upload.wikimedia.org/thumb/2048px-Lever.jpg", descriptionurl: "https://commons.wikimedia.org/wiki/File:Lever.jpg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a>Ann Example</a>" } } }] } } } }),
  });
  web.set("https://upload.wikimedia.org/thumb/500px-Lever.jpg", { body: jpeg("wide.jpg"), type: "image/jpeg" });
  web.set("https://upload.wikimedia.org/thumb/2048px-Lever.jpg", { body: jpeg("wide.jpg"), type: "image/jpeg" });
  const found = await callTool("find_images", { query: "lever", sources: ["commons", "nasa"] }, ctx);
  assert.equal(found.isError, undefined, found.text);
  assert.match(found.text, /c1: Lever \(1600 by 1000\); Wikimedia Commons, CC BY-SA 4\.0/);
  assert.match(found.text, /NASA did not answer this time/);
  assert.equal(found.images?.length, 1);
  assert.equal((await callTool("save_image", { from: "c1", name: "bad name" }, ctx)).isError, true);
  const saved = await callTool("save_image", { from: "c1", name: "lever_photo" }, ctx);
  assert.equal(saved.isError, undefined, saved.text);
  assert.match(saved.text, /Kept as lever_photo: found, 1600 by 1000 \(wide\)/);
  assert.match(saved.text, /shown with "Ann Example, Wikimedia Commons \(CC BY-SA 4\.0\)"/);
  assert.match(saved.text, /image ID asset=lever_photo w=1600 h=1000/);
  assert.ok(existsSync(join(folder, "assets", "lever_photo.jpg")));
  assert.match((await callTool("save_image", { from: "c1", name: "lever_photo" }, ctx)).text, /already an asset named lever_photo/);
});

test("open_page reads a page and lists its pictures as ids; a picture on it can be kept", async () => {
  web.set("https://example.org/see-saw", { type: "text/html", body: `<title>See-saws</title><main><p>${"A see-saw is a lever. ".repeat(30)}</p><img src="/saw.jpg" alt="Two children on a see-saw" width="800" height="600"></main>` });
  web.set("https://example.org/saw.jpg", { body: jpeg("disc.jpg"), type: "image/jpeg" });
  const page = await callTool("open_page", { url: "https://example.org/see-saw" }, ctx);
  assert.equal(page.isError, undefined, page.text);
  assert.match(page.text, /^See-saws <https:\/\/example\.org\/see-saw>/);
  const id = /(c\d+): Two children on a see-saw \(800 by 600\); example\.org/.exec(page.text)?.[1];
  assert.ok(id, page.text);
  const seen = await callTool("view_images", { from: [id!, "lever_photo", "nope"] }, ctx);
  assert.equal(seen.images?.length, 2);
  assert.match(seen.text, /Unknown: nope/);
  const kept = await callTool("save_image", { from: id!, name: "disc" }, ctx);
  assert.match(kept.text, /shown with "example\.org"/);
  assert.equal((await callTool("open_page", { url: "http://127.0.0.1:8650/status" }, ctx)).isError, true);
});

test("a file the agent made in its working folder can be kept, credited only when it says where it came from", async () => {
  mkdirSync(join(folder, "work"), { recursive: true });
  copyFileSync(join(made, "disc.jpg"), join(folder, "work", "chart.jpg"));
  const own = await callTool("save_image", { from: "work/chart.jpg", name: "chart" }, ctx);
  assert.equal(own.isError, undefined, own.text);
  assert.equal(ctx.draft.pictures!.assets.chart!.credit, undefined);
  const fetched = await callTool("save_image", { from: "chart.jpg", name: "chart2", source: "nasa.gov", page: "https://nasa.gov/x" }, ctx);
  assert.match(fetched.text, /shown with "nasa\.gov"/);
  assert.equal((await callTool("save_image", { from: "work/../draft.json", name: "escape" }, ctx)).isError, true);
  assert.equal((await callTool("save_image", { from: "/etc/hosts", name: "escape2" }, ctx)).isError, true);
  assert.match(systemPrompt(true), /in skills\/ in your folder, as files/);
  assert.match(systemPrompt(false), /Read them with read_skill/);
  assert.match(readSkill("media", undefined, { language: "" })!, /save_image from=work\/FILE/);
});

test("generate_image makes a picture and keeps it, with no credit line, as made for this video", async () => {
  const made = await callTool("generate_image", { prompt: "A wooden see-saw in a park at dusk, flat colors, no text", name: "park", shape: "tall", references: ["lever_photo"] }, ctx);
  assert.equal(made.isError, undefined, made.text);
  assert.ok(calls.some((u) => u.endsWith("/images/edits")), "a reference goes through edits");
  const park = ctx.draft.pictures!.assets.park!;
  assert.equal(park.kind, "generated");
  assert.equal(park.credit, undefined);
  assert.match(park.origin.source, /made for this video with Muse Image/);
});

test("a scene shows a kept picture: it builds, its stills show it, and the render credits it", async () => {
  const source = `@0\nimage photo asset=lever_photo w=1000 h=625\ntext t "The lever" role=title\n@4 keep\ntag photo "fulcrum" side=right\n`;
  const built = await callTool("write_beat", { ...script.scenes[0]!, source }, ctx);
  assert.equal(built.isError, undefined, built.text);
  const unknown = await callTool("write_beat", { ...script.scenes[1]!, source: "@0\nimage p asset=nothing w=600 h=600\n" }, ctx);
  assert.match(unknown.text, /needs asset=NAME with a name from the assets list\. Available: lever_photo, disc, chart, chart2, park/);
  const look = await callTool("look", { scene: "s1", at: [1] }, ctx);
  assert.equal(look.isError, undefined, look.text);
  // The test pattern is colorful; a still without it would be the style's plain surface.
  const still = Buffer.from(look.images![0]!.dataBase64, "base64");
  const colors = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=8:8,format=rgb24", "-f", "rawvideo", "-"], { input: still, timeout: 60_000 });
  const spread = new Set([...colors].map((v) => Math.round(v / 64))).size;
  assert.ok(spread >= 3, "the picture is in the still");
  ctx.draft.scenes.s2 = { source: "@0\ntext t \"Push\" role=title\n", built: true, looked: true, writes: 1, looks: 1 };
  assert.deepEqual(assetsIn(source), ["lever_photo"]);
  const shown = shownAssets(ctx);
  assert.deepEqual(shown.map((a) => a.name), ["lever_photo"]);
  const props = playerProps({ fps: 30, width: 1080, height: 1920, frames: 1, audio: "", style: {} as never, clips: [], captions: [] }, folder, { [shown[0]!.file]: shown[0]!.credit! });
  assert.equal(props.imageCredits["assets/lever_photo.jpg"], "Ann Example, Wikimedia Commons (CC BY-SA 4.0)");
});

test("the finished video shows the kept picture from the job's folder", async () => {
  ctx.draft.scenes.s2 = { source: "@0\nimage p asset=park w=900 h=1600 frame=fit\n", built: true, looked: true, writes: 1, looks: 1 };
  const spoken = await voiceAll(ctx);
  const { placed, broken } = await finalBuild(ctx, spoken);
  assert.deepEqual(broken, {});
  const out = await renderVideo(ctx, placed, spoken, () => undefined);
  const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", out.path, "-frames:v", "1", "-vf", "crop=iw:ih/3:0:ih/6,scale=8:8,format=rgb24", "-f", "rawvideo", "-"], { timeout: 60_000 });
  assert.ok(new Set([...frame].map((v) => Math.round(v / 64))).size >= 4, "the test pattern is in the video");
});

test("a cut-out keeps the thing and makes the rest see-through", async () => {
  const sam = join(folder, "disc-sam.jpg");
  ff("-i", join(made, "disc.jpg"), sam);
  // A 4 by 4 mask over the disc's box (200..600), on in its middle.
  const raster = new Uint8Array(16).map((_, i) => ([5, 6, 9, 10].includes(i) ? 1 : 0));
  const out = join(folder, "cut.png");
  await cutWith(sam, 800, 800, { raster, width: 4, height: 4, bounds: { left: 200, top: 200, right: 600, bottom: 600 } }, out);
  const rgba = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { timeout: 60_000 });
  assert.equal(rgba.length, 400 * 400 * 4, "cropped to the box");
  const alpha = (x: number, y: number) => rgba[(y * 400 + x) * 4 + 3];
  assert.equal(alpha(200, 200), 255, "the middle stays");
  assert.equal(alpha(10, 10), 0, "the corner is see-through");
});

/** The files made here, served at 127.0.0.1, which these tests count as a public address (Chrome opens only the web). */
const files = serve("127.0.0.1", (req, res) => {
  const file = join(made, decodeURIComponent(new URL(req.url!, "http://x").pathname));
  if (!existsSync(file)) return void res.writeHead(404).end();
  const type = file.endsWith(".html") ? "text/html" : file.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
  const bytes = readFileSync(file);
  // Ranges, as a video host answers them: ffmpeg seeks to the index at the end of the file.
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (!range) return void res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": bytes.length }).end(bytes);
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": end - start + 1 }).end(bytes.subarray(start, end + 1));
});
after(async () => (await files).close());

test("read_pdf reads the pages asked for and shows a page as a picture", { skip: !chrome && "no headless Chrome" }, async () => {
  const html = join(made, "doc.html");
  writeFileSync(html, `<h1>Simple machines</h1><p>The lever has three classes.</p><div style="page-break-after:always"></div><h1>Pulleys</h1><p>A pulley changes the direction of a force.</p>`);
  await printPdf(chrome!, `${(await files).origin}/doc.html`, join(made, "doc.pdf"), loopbackAsPublic(), { timeout: 40_000 });
  web.set("https://example.org/machines.pdf", { body: readFileSync(join(made, "doc.pdf")), type: "application/pdf" });
  const read = await callTool("read_pdf", { url: "https://example.org/machines.pdf", pages: "2", pictures: true }, ctx);
  assert.equal(read.isError, undefined, read.text);
  assert.match(read.text, /A PDF of 2 pages/);
  assert.match(read.text, /--- page 2 ---\n[\s\S]*A pulley changes the direction of a force/);
  assert.doesNotMatch(read.text, /three classes/);
  assert.match(read.text, /c\d+: page 2 of the PDF/);
  assert.equal(read.images?.length, 1);
  assert.deepEqual(parsePages("1,3-4,9", 5, 10), [1, 3, 4]);
});

test("a page is shown as a picture and read after its scripts ran, through the same headless Chrome", { skip: !chrome && "no headless Chrome" }, async () => {
  const html = join(made, "built.html");
  writeFileSync(html, `<body style="background:#c33"><script>document.body.insertAdjacentHTML("beforeend", "<p>Built by a script</p>")</script></body>`);
  const shot = join(made, "built.png");
  const page = `${(await files).origin}/built.html`;
  await takeScreenshot(chrome!, page, shot, { width: 430, height: 932, scale: 2 }, loopbackAsPublic(), { timeout: 40_000 });
  const png = readFileSync(shot);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 860, "two device pixels per page pixel");
  assert.match(await pageHtml(chrome!, page, { width: 1440, height: 1000 }, loopbackAsPublic(), { timeout: 40_000 }), /Built by a script/);
  await assert.rejects(pageHtml(chrome!, `file://${html}`, { width: 1440, height: 1000 }, loopbackAsPublic(), { timeout: 40_000 }), /Only http and https/);
});

test("a Chrome that never answers is stopped with a plain message instead of hanging", async () => {
  const stuck = join(made, "stuck-chrome");
  writeFileSync(stuck, "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(printPdf(stuck, "about:blank", join(made, "never.pdf"), box.web, { timeout: 1_500 }), /took more than \d+ seconds/);
  assert.ok(Date.now() - started < 10_000);
});

test("a frame is read from a video at the moment asked, through the relay", async () => {
  const video = join(made, "clip.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=640x360:duration=3:rate=10", "-pix_fmt", "yuv420p", video);
  const out = join(made, "frame.jpg");
  const served = await files;
  const before = served.hits.length;
  await withRelay(loopbackAsPublic(), (relay) => frameAt(`${served.origin}/clip.mp4`, 1.5, out, relay));
  assert.ok(readFileSync(out).length > 1000);
  assert.ok(served.hits.slice(before).some((h) => h.includes("/clip.mp4")), "the served video was read");
  await assert.rejects(withRelay(loopbackAsPublic(), (relay) => frameAt(video, 1.5, out, relay)), /not at a web address/);
});

test("web results from Spark are listed only when their page is there", async () => {
  const pages: Record<string, number> = { "https://real.example/levers": 200, "https://made-up.example/levers": 404 };
  const sparkFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/responses")) {
      const results = Object.keys(pages).map((u) => ({ title: u, url: u, snippet: "about levers" }));
      return new Response(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ results }) }] }] }), { headers: { "content-type": "application/json" } });
    }
    return new Response("<html><title>x</title></html>", { status: pages[url] ?? 404, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  const found = await searchesFor({ META_API_KEY: "k" })[0]!.search("levers", 5, { fetch: sparkFetch, web: { resolve: async () => ["93.184.216.34"], connect: sparkFetch }, env: { META_API_KEY: "k" } });
  assert.deepEqual(found.map((r) => r.url), ["https://real.example/levers"]);
});
