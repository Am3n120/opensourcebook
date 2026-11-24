/**
 * The toolbox's tools, in the same shape as the video tools (`../tools.ts`): a name, plain words on what it is for, its
 * input, and a run that does the work in code and answers in words and pictures. `available` says whether this
 * computer has what the tool needs; a tool that can't run is not offered.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Tool, ToolAnswer, ToolContext } from "../tools.ts";
import { addCandidate, base64, creditLine, describeAsset, emptyPictures, keep, NAME, preview, SMALL_SIDE, type Asset, type AssetKind, type Candidate, type Origin, type Pictures } from "./assets.ts";
import { ARCHIVES, searchArchives } from "./archives.ts";
import { coverage, cutWith, onGrey, samCopy } from "./cutout.ts";
import { generatorsFor, type Reference } from "./generators.ts";
import type { Toolbox } from "./index.ts";
import { metaFromEnv, samMasks, SHAPES, type Shape } from "./meta.ts";
import { fetchChecked, Refused } from "./net.ts";
import { readHtml, renderedHtml, screenshot, type View } from "./page.ts";
import { pageCount, pageFigures, pagePicture, pagesText, parsePages } from "./pdf.ts";
import { searchesFor } from "./search.ts";
import { withRelay } from "./relay.ts";
import { frameAt, resolveVideo } from "./video.ts";

export interface BoxTool extends Tool {
  available(box: Toolbox): boolean;
}

const fail = (text: string): ToolAnswer => ({ text, isError: true });
const box = (ctx: ToolContext): Toolbox => {
  if (!ctx.toolbox) throw new Error("the toolbox is not set up in this service");
  return ctx.toolbox;
};
export const pictures = (ctx: ToolContext): Pictures => (ctx.draft.pictures ??= emptyPictures());
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 60);
  }
};
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const picture = (file: string) => ({ mimeType: "image/jpeg", dataBase64: base64(file) });

/** A remote picture as a small local JPEG to show the agent, cached in the job's folder. */
async function seeRemote(ctx: ToolContext, url: string, side = 384): Promise<string> {
  const dir = join(ctx.folder, "seen");
  mkdirSync(dir, { recursive: true });
  const raw = join(dir, hash(url));
  if (!existsSync(raw)) {
    const got = await fetchChecked(url, { maxBytes: 25e6, timeoutMs: 30_000, ...(ctx.signal ? { signal: ctx.signal } : {}) }, box(ctx).web);
    if (got.status >= 400) throw new Error(`${got.status} from ${host(url)}`);
    writeFileSync(raw, got.bytes);
  }
  return preview(raw, side);
}

/** Shows candidates as small pictures, in order, skipping any that fail to load; says which did. */
async function show(ctx: ToolContext, list: Candidate[], side = 384): Promise<{ images: ToolAnswer["images"]; shown: Candidate[]; missing: string[] }> {
  const loaded = await Promise.all(list.map(async (c) => {
    try {
      return { c, file: c.file ? await preview(join(ctx.folder, c.file), side) : await seeRemote(ctx, c.thumb ?? c.url!, side) };
    } catch {
      return { c, file: undefined };
    }
  }));
  return {
    images: loaded.flatMap((x) => (x.file ? [picture(x.file)] : [])),
    shown: loaded.flatMap((x) => (x.file ? [x.c] : [])),
    missing: loaded.flatMap((x) => (x.file ? [] : [x.c.id])),
  };
}

const line = (c: Candidate) => `${c.id}: ${c.about}${c.size ? ` (${c.size.replace("x", " by ")})` : ""}; ${c.origin.source}${c.origin.license ? `, ${c.origin.license}` : ""}${c.origin.page ? ` <${c.origin.page}>` : ""}`;

function checkName(ctx: ToolContext, name: string, replace: boolean): string | undefined {
  if (!NAME.test(name)) return `name: "${name}" won't do; use letters, digits, - and _ (starting with a letter, at most 40), like heart_diagram.`;
  if (pictures(ctx).assets[name] && !replace) return `There is already an asset named ${name}; pick another name, or send replace: true to change it.`;
  return undefined;
}

async function keepAsset(ctx: ToolContext, a: { name: string; kind: AssetKind; about: string; origin: Origin; credit?: string; prompt?: string }, input: Buffer | string, alpha = false): Promise<Asset> {
  const saved = await keep(ctx.folder, a.name, input, { alpha, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  const asset: Asset = { name: a.name, file: saved.file, kind: a.kind, width: saved.width, height: saved.height, about: a.about, origin: a.origin, ...(a.credit ? { credit: a.credit } : {}), ...(a.prompt ? { prompt: a.prompt } : {}) };
  pictures(ctx).assets[a.name] = asset;
  ctx.save();
  return asset;
}

/** A file in the video's working folder (work/…, or its full path), when `from` names one; never outside it. */
function workFile(ctx: ToolContext, from: string): string | undefined {
  if (!from || /^https?:\/\//.test(from) || /^c\d+$/.test(from)) return undefined;
  const root = join(ctx.folder, "work");
  const path = isAbsolute(from) ? from : join(root, from.replace(/^work\//, ""));
  if (!existsSync(path)) return undefined;
  const real = realpathSync(path);
  const r = relative(realpathSync(root), real);
  return r && !r.startsWith("..") && !isAbsolute(r) && statSync(real).isFile() ? relative(realpathSync(ctx.folder), real) : undefined;
}

const kept = (a: Asset) => `Kept as ${describeAsset(a)}. Show it in a scene with \`image ID asset=${a.name} w=${a.width} h=${a.height}\` (frame=fill to cover the frame, frame=fit to show all of it), or mark, tag and frame its parts like any picture.`;

// ---------------------------------------------------------------------------------------------------------------------

const webSearch: BoxTool = {
  name: "web_search",
  description: "Search the web. Answers with pages (title, address, a line on what is on each); open one with open_page. For what something really looks like, a reference to draw from, a diagram, a real photo, a video or a PDF on the subject. The video's facts still come only from the passages.",
  inputSchema: { type: "object", properties: { query: { type: "string" }, n: { type: "number", description: "How many results, up to 10 (default 6)." }, where: { type: "string", description: "Which search to use, when more than one is listed below; default the first." } }, required: ["query"] },
  available: (b) => searchesFor(b.env).length > 0,
  async run(input, ctx) {
    const q = str(input.query, 300);
    if (!q) return fail("Give a query.");
    const all = searchesFor(box(ctx).env);
    const engine = all.find((s) => s.id === str(input.where)) ?? all[0]!;
    ctx.step("Searching the web");
    const n = Math.max(1, Math.min(10, Number(input.n) || 6));
    const results = await engine.search(q, n, { fetch: box(ctx).fetch, web: box(ctx).web, env: box(ctx).env, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (!results.length) return { text: `Nothing found in ${engine.label} for "${q}". Try other words${all.length > 1 ? ` or another search (${all.map((s) => s.id).join(", ")})` : ""}.` };
    return { text: [`${results.length} from ${engine.label}:`, ...results.map((r, i) => `${i + 1}. ${r.title} <${r.url}>\n   ${r.snippet.slice(0, 300)}`)].join("\n") };
  },
};

const openPage: BoxTool = {
  name: "open_page",
  description: "Open a web page and read it: its title, words (in parts of about 12,000 characters; ask for more with from), links, and the pictures on it as ids you can look at (view_images) or keep (save_image). With screenshot, also see it as a phone or a desktop shows it, as an id you can keep. A PDF or a video address goes to read_pdf or video_frames instead.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      from: { type: "number", description: "Where in the page's words to start, in characters (default 0)." },
      screenshot: { type: "string", enum: ["phone", "desktop"], description: "Also take a screenshot of the page's first screen." },
    },
    required: ["url"],
  },
  available: () => true,
  async run(input, ctx) {
    const url = str(input.url, 2000);
    ctx.step(`Reading ${host(url)}`);
    const b = box(ctx);
    const got = await fetchChecked(url, { maxBytes: 8e6, timeoutMs: 30_000, headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.5" }, ...(ctx.signal ? { signal: ctx.signal } : {}) }, b.web);
    if (got.status >= 400) return fail(`${host(got.url)} answered ${got.status}.`);
    if (got.contentType === "application/pdf") return fail("That address is a PDF; read it with read_pdf.");
    if (got.contentType.startsWith("video/")) return fail("That address is a video; take frames with video_frames.");
    if (got.contentType.startsWith("image/")) {
      const c = addCandidate(pictures(ctx), { kind: "found", about: `a picture at ${host(got.url)}`, url: got.url, thumb: got.url, origin: { source: host(got.url), page: got.url } });
      ctx.save();
      const seen = await show(ctx, [c], 512);
      return { text: `That address is a picture: ${line(c)}. Keep it with save_image from=${c.id}.`, images: seen.images };
    }
    let page = readHtml(got.bytes.toString("utf8"), got.url);
    let note = "";
    // A page that builds its words with scripts reads as almost nothing from its HTML; open it in the browser instead.
    if (page.text.length < 400 && b.chrome) {
      try {
        page = readHtml(await renderedHtml(b.chrome, got.url, b.web, ctx.signal), got.url);
        note = " (read after the page's scripts ran)";
      } catch {
        note = " (little text in its HTML, and the browser could not open it)";
      }
    }
    const p = pictures(ctx);
    const pics = page.images.slice(0, 24).map((img) => addCandidate(p, { kind: "found", about: img.alt || `a picture on ${host(got.url)}`, url: img.src, thumb: img.src, ...(img.width && img.height ? { size: `${img.width}x${img.height}` } : {}), origin: { source: host(got.url), ...(page.title ? { title: page.title } : {}), page: got.url } }));
    const from = Math.max(0, Math.floor(Number(input.from) || 0));
    const part = page.text.slice(from, from + 12_000);
    const out: ToolAnswer = {
      text: [
        `${page.title || host(got.url)} <${got.url}>${note}`,
        ...(page.description ? [page.description] : []),
        "",
        part || "(no words here)",
        ...(from + 12_000 < page.text.length ? [`\n[${page.text.length - from - 12_000} more characters; open_page with from=${from + 12_000}]`] : []),
        ...(pics.length ? ["", `Pictures on the page (look with view_images, keep with save_image):`, ...pics.map(line)] : []),
        ...(page.links.length ? ["", "Links:", ...page.links.slice(0, 40).map((l) => `- ${l.text} <${l.href}>`)] : []),
      ].join("\n"),
    };
    const view = str(input.screenshot) as View;
    if (view === "phone" || view === "desktop") {
      if (!b.chrome) out.text += "\n\nNo screenshot: there is no headless Chrome on this computer (npm run browser).";
      else {
        const dir = join(ctx.folder, "seen");
        mkdirSync(dir, { recursive: true });
        const file = join("seen", `shot-${hash(got.url + view)}.png`);
        await screenshot(b.chrome, got.url, join(ctx.folder, file), view, b.web, ctx.signal);
        const c = addCandidate(p, { kind: "screenshot", about: `a screenshot of ${page.title || host(got.url)} as a ${view} shows it`, file, origin: { source: host(got.url), ...(page.title ? { title: page.title } : {}), page: got.url } });
        const seen = await show(ctx, [c], 640);
        out.text += `\n\nScreenshot: ${c.id} (keep it with save_image from=${c.id}).`;
        out.images = seen.images;
      }
    }
    ctx.save();
    return out;
  },
};

const findImages: BoxTool = {
  name: "find_images",
  description: `Search open picture archives for real photos, paintings, diagrams, maps and scans that are public domain or openly licensed (credited on screen when shown). You see the results as small pictures with ids; keep the right one with save_image. Archives: ${ARCHIVES.map((a) => `${a.id} (${a.holds})`).join("; ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "A few plain words for what is in the picture, in English." },
      sources: { type: "array", items: { type: "string" }, description: "Archive ids to search; default all." },
      n: { type: "number", description: "Results per archive, 1 to 4 (default 2)." },
    },
    required: ["query"],
  },
  available: () => true,
  async run(input, ctx) {
    const q = str(input.query, 200);
    if (!q) return fail("Give a query.");
    ctx.step("Looking for pictures");
    const b = box(ctx);
    const only = Array.isArray(input.sources) ? input.sources.map(String) : undefined;
    const per = Math.max(1, Math.min(4, Number(input.n) || 2));
    const { hits, failed } = await searchArchives(q, per, { web: b.web, env: b.env, ...(ctx.signal ? { signal: ctx.signal } : {}) }, only);
    const p = pictures(ctx);
    const found = hits.slice(0, 12).map((h) => addCandidate(p, { kind: "found", about: h.title, url: h.full, thumb: h.thumb, ...(h.size ? { size: h.size } : {}), origin: h.origin }));
    ctx.save();
    if (!found.length) return { text: `Nothing found for "${q}"${failed.length ? ` (${failed.join(", ")} did not answer)` : ""}. Try other or fewer words, another archive, web_search for a page with the picture, or generate_image.` };
    const seen = await show(ctx, found);
    return {
      text: [`${seen.shown.length} pictures for "${q}", in the order shown below:`, ...seen.shown.map(line), ...(seen.missing.length ? [`(${seen.missing.join(", ")} did not load.)`] : []), ...(failed.length ? [`${failed.join(", ")} did not answer this time.`] : []), "Keep one with save_image, look closer with view_images, or search again."].join("\n"),
      images: seen.images,
    };
  },
};

const viewImages: BoxTool = {
  name: "view_images",
  description: "Look at pictures before you keep them: ids from find_images, open_page, video_frames or read_pdf, picture addresses, or names of assets already kept. Up to 8, larger than in a search.",
  inputSchema: { type: "object", properties: { from: { type: "array", items: { type: "string" }, description: "Ids (c12), addresses, or asset names." } }, required: ["from"] },
  available: () => true,
  async run(input, ctx) {
    const p = pictures(ctx);
    const list: Candidate[] = [];
    const unknown: string[] = [];
    for (const raw of (Array.isArray(input.from) ? input.from : []).map(String).slice(0, 8)) {
      const asset = p.assets[raw];
      if (p.candidates[raw]) list.push(p.candidates[raw]!);
      else if (asset) list.push({ id: asset.name, kind: asset.kind, about: asset.about, file: asset.file, size: `${asset.width}x${asset.height}`, origin: asset.origin });
      else if (/^https?:\/\//.test(raw)) list.push(addCandidate(p, { kind: "found", about: `a picture at ${host(raw)}`, url: raw, thumb: raw, origin: { source: host(raw), page: raw } }));
      else unknown.push(raw);
    }
    ctx.save();
    if (!list.length) return fail(`Nothing to show${unknown.length ? `: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an id, an address or an asset` : ""}.`);
    const seen = await show(ctx, list, 768);
    return { text: [`${seen.shown.length} in order:`, ...seen.shown.map(line), ...(seen.missing.length ? [`(${seen.missing.join(", ")} did not load.)`] : []), ...(unknown.length ? [`Unknown: ${unknown.join(", ")}.`] : [])].join("\n"), images: seen.images };
  },
};

const saveImage: BoxTool = {
  name: "save_image",
  description: "Keep a picture for the video under a name, from an id you were shown (search results, pictures on a page, screenshots, video frames, PDF pages and figures), a picture's address, or a file in the working folder (work/NAME) when you have one. It is stored at full size (up to 2048 pixels) and you see it back. A picture from somewhere else is credited under it while it is on screen and on the end card.",
  inputSchema: {
    type: "object",
    properties: {
      from: { type: "string", description: "An id like c12, or a picture's address." },
      name: { type: "string", description: "The asset name scenes use: letters, digits, - and _, like heart_photo." },
      about: { type: "string", description: "What it shows, in a few words, for you later." },
      source: { type: "string", description: "For a file in the working folder or a bare address: where the picture came from (a site, an archive, its maker), shown as its credit. Leave out for a picture you made yourself." },
      page: { type: "string", description: "The page a viewer could check it on, when there is one." },
      replace: { type: "boolean" },
    },
    required: ["from", "name"],
  },
  available: () => true,
  async run(input, ctx) {
    const name = str(input.name, 60);
    const bad = checkName(ctx, name, input.replace === true);
    if (bad) return fail(bad);
    const from = str(input.from);
    const p = pictures(ctx);
    const source = str(input.source, 200);
    const page = str(input.page, 1000);
    const work = workFile(ctx, from);
    const c: Candidate | undefined = p.candidates[from]
      ?? (work ? { id: "", kind: source ? "found" : "generated", about: `${from.replace(/^work\//, "")}, from the working folder`, file: work, origin: source ? { source, ...(page ? { page } : {}) } : { source: "made for this video" } } : undefined)
      ?? (/^https?:\/\//.test(from) ? { id: "", kind: "found" as const, about: `a picture at ${host(from)}`, url: from, origin: { source: source || host(from), page: page || from } } : undefined);
    if (!c) return fail(`${from} is not an id you were shown in this video (they look like c12), a file in the working folder (work/NAME), or a picture's address.`);
    ctx.step("Keeping a picture");
    let input2: Buffer | string;
    if (c.file) input2 = join(ctx.folder, c.file);
    else {
      const got = await fetchChecked(c.url!, { maxBytes: 40e6, timeoutMs: 60_000, ...(ctx.signal ? { signal: ctx.signal } : {}) }, box(ctx).web);
      if (got.status >= 400) return fail(`${host(got.url)} answered ${got.status} for that picture; try another.`);
      input2 = got.bytes;
    }
    let asset: Asset;
    try {
      asset = await keepAsset(ctx, { name, kind: c.kind, about: str(input.about, 200) || c.about, origin: c.origin, ...(c.kind === "generated" ? {} : { credit: creditLine(c.origin) }) }, input2);
    } catch {
      return fail("That is not a picture that can be read (it may be a page, not the picture itself). Open the page, or pick another.");
    }
    const look = await preview(join(ctx.folder, asset.file), 640);
    return { text: `${kept(asset)}${Math.min(asset.width, asset.height) < SMALL_SIDE ? " It is small: filling a phone's frame it will look soft." : ""}`, images: [picture(look)] };
  },
};

const generateImage: BoxTool = {
  name: "generate_image",
  description: `Make a picture from words and keep it as an asset: an illustration, a scene, a character, a texture or background, a clean diagram, in the video's look or any other. It costs a little money, so use it when it shows something better than drawing it or finding a real picture would. It is not a record of anything real, so it does not stand in for a real person, place, document or event the video presents as real. Give references (assets or ids) to keep a look or a subject the same across pictures. Shapes: ${Object.keys(SHAPES).join(", ")}.`,
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the picture shows and how it looks: subject, composition, medium, palette, light. Say if it should have no text." },
      name: { type: "string", description: "The asset name scenes use." },
      shape: { type: "string", enum: Object.keys(SHAPES), description: "tall fills a phone's frame (default), square or wide sit inside one." },
      references: { type: "array", items: { type: "string" }, description: "Up to 4 asset names or ids whose look or subject to follow." },
      about: { type: "string" },
      replace: { type: "boolean" },
    },
    required: ["prompt", "name"],
  },
  available: (b) => generatorsFor(b.env).length > 0,
  async run(input, ctx) {
    const name = str(input.name, 60);
    const bad = checkName(ctx, name, input.replace === true);
    if (bad) return fail(bad);
    const prompt = str(input.prompt, 4000);
    if (prompt.length < 10) return fail("Say what the picture shows and how it looks.");
    const shape = (Object.keys(SHAPES).includes(str(input.shape)) ? str(input.shape) : "tall") as Shape;
    const p = pictures(ctx);
    const refs: Reference[] = [];
    for (const r of (Array.isArray(input.references) ? input.references.map(String) : []).slice(0, 4)) {
      const file = p.assets[r]?.file ?? p.candidates[r]?.file;
      const remote = p.candidates[r]?.url;
      if (file) refs.push({ bytes: readFileSync(join(ctx.folder, file)), type: file.endsWith(".png") ? "image/png" : "image/jpeg", name: `${r}${file.endsWith(".png") ? ".png" : ".jpg"}` });
      else if (remote) refs.push({ bytes: readFileSync(await seeRemote(ctx, remote, 1024)), type: "image/jpeg", name: `${r}.jpg` });
      else return fail(`${r} is not an asset or an id you were shown.`);
    }
    const generator = generatorsFor(box(ctx).env)[0]!;
    ctx.step("Making a picture");
    const bytes = await generator.make(prompt, shape, refs, { fetch: box(ctx).fetch, env: box(ctx).env, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    p.spent.generate = (p.spent.generate ?? 0) + 1;
    const asset = await keepAsset(ctx, { name, kind: "generated", about: str(input.about, 200) || prompt.slice(0, 160), origin: { source: `made for this video with ${generator.label}` }, prompt }, bytes);
    const look = await preview(join(ctx.folder, asset.file), 640);
    return { text: `${kept(asset)} Look at it as a viewer would: if it is wrong, generate it again with a better prompt (replace: true).`, images: [picture(look)] };
  },
};

const videoFrames: BoxTool = {
  name: "video_frames",
  description: "Take frames from a video at the moments you name: a video file's address, or a page with a video on it (YouTube and most video sites) when yt-dlp is installed. You see each frame as an id to keep with save_image. With no moments, it takes 6 spread over the video so you can find the one you want.",
  inputSchema: { type: "object", properties: { url: { type: "string" }, at: { type: "array", items: { type: "number" }, description: "Seconds into the video, up to 8." } }, required: ["url"] },
  available: () => true,
  async run(input, ctx) {
    const url = str(input.url, 2000);
    const b = box(ctx);
    try {
      await fetchChecked(url, { maxBytes: 1, timeoutMs: 15_000, method: "GET", headers: { range: "bytes=0-0" } }, b.web).catch((e) => {
        if (e instanceof Refused && /is on this computer|private network|not a web address|Only http/.test(e.message)) throw e;
      });
    } catch (e) {
      return fail((e as Error).message);
    }
    ctx.step("Taking frames from a video");
    // yt-dlp and ffmpeg fetch by themselves; everything they open goes through the relay and is checked there.
    const got = await withRelay(b.web, async (relay) => {
      let v;
      try {
        v = await resolveVideo(url, b.ytdlp, relay, ctx.signal);
      } catch (e) {
        return { error: (e as Error).message.split("\n")[0]!.slice(0, 400) };
      }
      const asked = Array.isArray(input.at) ? input.at.map(Number).filter((n) => Number.isFinite(n) && n >= 0).slice(0, 8) : [];
      const moments = asked.length ? asked : v.seconds ? [0.08, 0.24, 0.4, 0.56, 0.72, 0.88].map((f) => Math.round(v.seconds! * f)) : [1, 5, 10, 20, 40, 60];
      const dir = join(ctx.folder, "seen");
      mkdirSync(dir, { recursive: true });
      const p = pictures(ctx);
      const taken: Candidate[] = [];
      const failed: number[] = [];
      for (const at of moments) {
        const file = join("seen", `frame-${hash(url)}-${at}.jpg`);
        try {
          if (!existsSync(join(ctx.folder, file))) await frameAt(v.media, at, join(ctx.folder, file), relay, ctx.signal);
          if (!existsSync(join(ctx.folder, file))) throw new Error("past the end");
          taken.push(addCandidate(p, { kind: "frame", about: `${v.title ?? `the video at ${host(url)}`} at ${at} s`, file, origin: { source: v.title ? `${v.title}, ${host(url)}` : host(url), page: url } }));
        } catch {
          failed.push(at);
        }
      }
      return { v, taken, failed };
    });
    if ("error" in got) return fail(got.error!);
    const { v, taken, failed } = got;
    ctx.save();
    if (!taken.length) return fail(`No frames could be read${v.seconds ? ` (the video is ${Math.round(v.seconds)} s long)` : ""}.`);
    const seen = await show(ctx, taken, 512);
    return { text: [`${v.title ?? host(url)}${v.seconds ? `, ${Math.round(v.seconds)} s long` : ""}. Frames in order:`, ...seen.shown.map(line), ...(failed.length ? [`No frame at ${failed.join(", ")} s.`] : []), "Keep one with save_image, or ask for other moments."].join("\n"), images: seen.images };
  },
};

const readPdf: BoxTool = {
  name: "read_pdf",
  description: "Read a PDF from the web: the words of the pages you ask for (default 1-3, up to 10 at a time), how many pages it has, and, when asked, the pages drawn as pictures and the figures inside them, as ids to look at or keep with save_image.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      pages: { type: "string", description: 'Like "2", "4-6" or "1,3,8-9".' },
      pictures: { type: "boolean", description: "Also see each of those pages as a picture (up to 4)." },
      figures: { type: "boolean", description: "Also take out the pictures embedded in those pages." },
    },
    required: ["url"],
  },
  available: () => true,
  async run(input, ctx) {
    const url = str(input.url, 2000);
    const b = box(ctx);
    const dir = join(ctx.folder, "seen");
    mkdirSync(dir, { recursive: true });
    const local = join(dir, `pdf-${hash(url)}.pdf`);
    ctx.step(`Reading a PDF from ${host(url)}`);
    if (!existsSync(local)) {
      const got = await fetchChecked(url, { maxBytes: 60e6, timeoutMs: 90_000, ...(ctx.signal ? { signal: ctx.signal } : {}) }, b.web);
      if (got.status >= 400) return fail(`${host(got.url)} answered ${got.status}.`);
      if (!got.bytes.subarray(0, 1024).includes("%PDF")) return fail("That address is not a PDF; open it with open_page.");
      writeFileSync(local, got.bytes);
    }
    const bytes = readFileSync(local);
    const total = await pageCount(bytes);
    const pages = parsePages(input.pages, total, 10);
    if (!pages.length) return fail(`It has ${total} pages; ask for pages between 1 and ${total}.`);
    const text = await pagesText(bytes);
    const p = pictures(ctx);
    const shownAs: Candidate[] = [];
    if (input.pictures === true) {
      for (const n of pages.slice(0, 4)) {
        const file = join("seen", `pdf-${hash(url)}-p${n}.png`);
        if (!existsSync(join(ctx.folder, file))) await pagePicture(bytes, n, join(ctx.folder, file));
        shownAs.push(addCandidate(p, { kind: "figure", about: `page ${n} of the PDF`, file, origin: { source: host(url), page: url } }));
      }
    }
    if (input.figures === true) {
      for (const n of pages) {
        for (const f of await pageFigures(bytes, n, join(ctx.folder, "seen", `pdf-${hash(url)}-p${n}-fig`))) {
          shownAs.push(addCandidate(p, { kind: "figure", about: `a figure on page ${n}`, file: f.file.slice(ctx.folder.length + 1), size: `${f.width}x${f.height}`, origin: { source: host(url), page: url } }));
        }
      }
    }
    ctx.save();
    const words = pages.map((n) => `--- page ${n} ---\n${(text[n - 1] ?? "").slice(0, 6000) || "(no text on this page; it may be a scan: see it with pictures)"}`).join("\n\n");
    const seen = shownAs.length ? await show(ctx, shownAs.slice(0, 10), 640) : { images: [], shown: [], missing: [] };
    return { text: [`A PDF of ${total} pages from ${host(url)}. Pages ${pages.join(", ")}:`, "", words.slice(0, 30_000), ...(seen.shown.length ? ["", "As pictures, in order:", ...seen.shown.map(line)] : [])].join("\n"), ...(seen.images?.length ? { images: seen.images } : {}) };
  },
};

const cutOut: BoxTool = {
  name: "cut_out",
  description: "Cut one thing out of a kept picture along its own edge (a person, an animal, an object, a building), as a new asset with a see-through background, so a scene can place it on its own surface, move it or set it beside drawn things. Name the thing in a few plain words. Scenery with no edge (sky, sea, a field) does not cut well. It costs a little money.",
  inputSchema: {
    type: "object",
    properties: {
      asset: { type: "string", description: "The kept picture to cut from." },
      thing: { type: "string", description: 'A short noun phrase, like "the red car" or "the heart".' },
      name: { type: "string", description: "The new asset's name." },
      replace: { type: "boolean" },
    },
    required: ["asset", "thing", "name"],
  },
  available: (b) => !!metaFromEnv(b.env),
  async run(input, ctx) {
    const p = pictures(ctx);
    const from = p.assets[str(input.asset)];
    if (!from) return fail(`${str(input.asset) || "That"} is not a kept asset; keep the picture first (save_image or generate_image).`);
    const name = str(input.name, 60);
    const bad = checkName(ctx, name, input.replace === true);
    if (bad) return fail(bad);
    const thing = str(input.thing, 120);
    if (!thing) return fail("Name the thing to cut out.");
    ctx.step("Cutting out a picture");
    const work = join(ctx.folder, "seen", `sam-${from.name}.jpg`);
    mkdirSync(join(ctx.folder, "seen"), { recursive: true });
    const sam = await samCopy(join(ctx.folder, from.file), work);
    const masks = await samMasks(metaFromEnv(box(ctx).env, box(ctx).fetch)!, sam.jpeg, thing, ctx.signal);
    p.spent.cutout = (p.spent.cutout ?? 0) + 1;
    if (!masks.length) return fail(`No "${thing}" was found in ${from.name}. Name it differently (what it looks like, plainly), or pick another picture.`);
    const best = [...masks].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0]!;
    const cover = coverage(best, sam.width, sam.height);
    const out = join(ctx.folder, "seen", `cut-${name}.png`);
    await cutWith(work, sam.width, sam.height, best, out);
    const asset = await keepAsset(ctx, { name, kind: "cutout", about: `${thing}, cut out of ${from.name}`, origin: from.origin, ...(from.credit ? { credit: from.credit } : {}) }, out, true);
    const look = join(ctx.folder, "seen", `cut-${name}.grey.jpg`);
    await onGrey(join(ctx.folder, asset.file), look);
    const notes = [masks.length > 1 ? `SAM found ${masks.length}; this is the surest${best.confidence !== undefined ? ` (${Math.round(best.confidence * 100)}%)` : ""}.` : "", cover.area > 0.8 ? "It covers almost the whole picture, so it may not be the thing alone." : "", cover.area < 0.01 ? "It is tiny in the picture, so it will be small and soft." : ""].filter(Boolean);
    return { text: `${kept(asset)} Shown below on grey so you can see its edge.${notes.length ? ` ${notes.join(" ")}` : ""}`, images: [picture(look)] };
  },
};

const listAssets: BoxTool = {
  name: "assets",
  description: "See every picture kept for this video: names, sizes, where each came from, and the pictures themselves.",
  inputSchema: { type: "object", properties: {} },
  available: () => true,
  async run(_input, ctx) {
    const all = Object.values(pictures(ctx).assets);
    if (!all.length) return { text: "No pictures kept yet." };
    const files = await Promise.all(all.slice(0, 12).map((a) => preview(join(ctx.folder, a.file), 320)));
    return { text: [`${all.length} kept${all.length > 12 ? " (the first 12 shown)" : ""}, in order:`, ...all.map(describeAsset)].join("\n"), images: files.map(picture) };
  },
};

export const BOX_TOOLS: BoxTool[] = [webSearch, openPage, findImages, viewImages, saveImage, generateImage, videoFrames, readPdf, cutOut, listAssets];

export const boxTools = (b: Toolbox | undefined): BoxTool[] => (b ? BOX_TOOLS.filter((t) => t.available(b)) : []);
