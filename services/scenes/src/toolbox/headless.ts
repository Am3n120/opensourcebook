/**
 * Drives the headless Chrome over its DevTools socket: open a page, wait for it, take a screenshot, print a PDF or read
 * the HTML after its scripts ran. Chrome's one-shot flags (--screenshot, --print-to-pdf, --dump-dom) do not exit on
 * every build (Chrome 157's headless shell on a Mac stays alive after the page is ready and never writes), so nothing
 * here relies on them. Every call has a time limit, and the browser (with its own throwaway profile and a port Chrome
 * picks itself) is always killed when the call ends, so a broken earlier run cannot get in the way of the next.
 *
 * Chrome never reaches the network itself. Every request a page makes (the page, its pictures, scripts, styles,
 * frames, its scripts' own fetches, workers, redirects) is paused through the DevTools protocol, its address checked
 * like any other toolbox address (`checkUrl`), fetched here at the checked address and handed back to Chrome; a
 * request whose address fails, or anything that goes wrong on the way, is refused. Redirects come back to Chrome as
 * they are, so the next hop is paused and checked too. WebSockets do not pass through that pause, so Chrome is
 * started with every host mapped to "not found": it never needs to find one itself, and a socket it might open on
 * its own (a WebSocket from a page or a worker, written with a name or an address, a preconnect) finds no host.
 * Only http and https pages are opened.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUrl, readLimited, type Web } from "./net.ts";

export interface Look {
  width: number;
  height: number;
  /** Device pixels per page pixel. */
  scale?: number;
}

export interface Limits {
  /** Whole call, in milliseconds. */
  timeout?: number;
  signal?: AbortSignal;
}

/** Time the scripts of a page get after it has loaded, to build what they build. */
const SETTLE_MS = 1_500;
const DEFAULT_TIMEOUT = 45_000;
/** The most one thing on a page may be, a picture or a script. */
const MAX_RESOURCE = 25e6;

/**
 * How Chrome is started, past the usual: every host it would connect to itself is "not found" (IP addresses too:
 * every request is fetched here, so it needs none; this is what stops WebSockets), WebRTC may only go through a
 * proxy, which it has none of, and it makes no requests of its own.
 */
const LOCKED = ["--host-resolver-rules=MAP * ~NOTFOUND", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-pings"];
/** Request headers Chrome sends that are about its own connection, not the request. */
const CONNECTION_HEADERS = new Set(["host", "connection", "keep-alive", "accept-encoding", "content-length", "transfer-encoding", "upgrade", "proxy-connection"]);

interface Cdp {
  send(method: string, params?: object): Promise<any>;
  once(method: string, ms: number): Promise<void>;
}

/** Runs `use` on a page opened at `url`; the browser is gone when it returns or fails. */
async function withPage<T>(chrome: string, url: string, look: Look, web: Web, limits: Limits, use: (cdp: Cdp) => Promise<T>): Promise<T> {
  if (url !== "about:blank") await checkUrl(url, web.resolve, web.allows);
  const timeout = limits.timeout ?? DEFAULT_TIMEOUT;
  const profile = mkdtempSync(join(tmpdir(), "opensourcebook-chrome-"));
  const args = ["--headless", "--hide-scrollbars", "--mute-audio", "--disable-gpu", "--no-first-run", "--disable-extensions", "--no-default-browser-check", `--user-data-dir=${profile}`, "--remote-debugging-port=0", ...LOCKED, ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"];
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  let ws: WebSocket | undefined;
  let stop: (e: Error) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => (stop = reject));
  const timer = setTimeout(() => stop(new Error(`headless Chrome took more than ${Math.round(timeout / 1000)} seconds on ${url} and was stopped`)), timeout);
  const onAbort = () => stop(new Error("stopped"));
  limits.signal?.addEventListener("abort", onAbort, { once: true });
  child.once("error", (e) => stop(new Error(`headless Chrome did not start: ${e.message}`)));
  child.once("exit", (code, sig) => stop(new Error(`headless Chrome closed early (${sig ?? `exit ${code}`})`)));
  const kill = () => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  try {
    if (limits.signal?.aborted) throw new Error("stopped");
    const endpoint = new Promise<string>((resolve) => {
      let seen = "";
      child.stderr!.on("data", (d: Buffer) => {
        seen += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (m) resolve(m[1]!);
      });
    });
    const work = (async () => {
      ws = new WebSocket(await endpoint);
      await new Promise<void>((resolve, reject) => {
        ws!.addEventListener("open", () => resolve(), { once: true });
        ws!.addEventListener("error", () => reject(new Error("could not reach headless Chrome")), { once: true });
      });
      let id = 0;
      const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
      const listeners: { method: string; fire: () => void }[] = [];
      let session = "";
      const raw = (method: string, params: object = {}, sessionId?: string) =>
        new Promise<any>((ok, no) => {
          const n = ++id;
          waiting.set(n, { ok, no });
          ws!.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      let landed = false;
      const pass = passer(web, limits.signal, raw, () => landed);
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id !== undefined) {
          const w = waiting.get(m.id);
          waiting.delete(m.id);
          if (m.error) w?.no(new Error(`${m.error.message}`));
          else w?.ok(m.result);
        } else if (m.method === "Fetch.requestPaused") {
          void pass(m.params, m.sessionId);
        } else if (m.method) {
          for (const l of listeners.filter((x) => x.method === m.method)) l.fire();
        }
      });
      const cdp: Cdp = {
        send: (method, params) => raw(method, params, session),
        once: (method, ms) =>
          new Promise<void>((resolve) => {
            const l = { method, fire: () => resolve() };
            listeners.push(l);
            setTimeout(resolve, ms);
          }),
      };
      // Paused for the whole browser, so frames, workers and service workers in other processes are paused too.
      await raw("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
      const { targetId } = await raw("Target.createTarget", { url: "about:blank" });
      session = (await raw("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      await cdp.send("Page.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: look.width, height: look.height, deviceScaleFactor: look.scale ?? 1, mobile: false });
      const loaded = cdp.once("Page.loadEventFired", Math.max(5_000, timeout - 15_000));
      const nav = await cdp.send("Page.navigate", { url });
      if (nav.errorText) throw new Error(`Chrome could not open ${url}: ${nav.errorText}`);
      landed = true;
      await loaded;
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return use(cdp);
    })();
    return await Promise.race([work, failed]);
  } finally {
    clearTimeout(timer);
    limits.signal?.removeEventListener("abort", onAbort);
    try {
      ws?.close();
    } catch {
      /* closed */
    }
    kill();
    rmSync(profile, { recursive: true, force: true });
  }
}

/**
 * Answers each request Chrome pauses: an http(s) address that passes the check is fetched here at the checked address
 * (no redirect followed: Chrome gets the redirect, and the next hop is paused in turn); anything else is refused.
 * Once the page has opened, a refused page load (a script sending the page elsewhere) is answered "no content", so
 * the page stays where it is and can still be read; before that, the opening itself fails.
 */
function passer(web: Web, signal: AbortSignal | undefined, send: (method: string, params: object, sessionId?: string) => Promise<any>, landed: () => boolean) {
  return async (p: { requestId: string; resourceType?: string; request: { url: string; method: string; headers?: Record<string, string>; postData?: string; hasPostData?: boolean } }, sessionId?: string) => {
    try {
      const { request } = p;
      if (request.hasPostData && request.postData === undefined) throw new Error("a request body Chrome did not hand over");
      const at = await checkUrl(request.url, web.resolve, web.allows);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(request.headers ?? {})) if (!CONNECTION_HEADERS.has(k.toLowerCase())) headers[k] = v;
      const res = await web.connect(at.url, { method: request.method, headers, redirect: "manual", signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]), ...(request.postData !== undefined ? { body: request.postData } : {}) }, at);
      const body = await readLimited(res, MAX_RESOURCE, at.url.hostname);
      const responseHeaders: { name: string; value: string }[] = [];
      res.headers.forEach((value, name) => {
        if (name !== "content-length" && name !== "content-encoding" && name !== "transfer-encoding") responseHeaders.push({ name, value });
      });
      await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: res.status, responseHeaders, body: body.toString("base64") }, sessionId);
    } catch {
      const stay = p.resourceType === "Document" && landed();
      await send(stay ? "Fetch.fulfillRequest" : "Fetch.failRequest", stay ? { requestId: p.requestId, responseCode: 204, responseHeaders: [] } : { requestId: p.requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => undefined);
    }
  };
}

/** The first screen of the page as a PNG written to `out`. */
export async function takeScreenshot(chrome: string, url: string, out: string, look: Look, web: Web, limits: Limits = {}): Promise<void> {
  const { data } = await withPage(chrome, url, look, web, limits, (c) => c.send("Page.captureScreenshot", { format: "png" }));
  writeFileSync(out, Buffer.from(data, "base64"));
}

/** The page printed as a PDF, written to `out`. */
export async function printPdf(chrome: string, url: string, out: string, web: Web, limits: Limits = {}): Promise<void> {
  const { data } = await withPage(chrome, url, { width: 1024, height: 768 }, web, limits, (c) => c.send("Page.printToPDF", { printBackground: true, displayHeaderFooter: false }));
  writeFileSync(out, Buffer.from(data, "base64"));
}

/** The page's HTML after its scripts ran. */
export async function pageHtml(chrome: string, url: string, look: Look, web: Web, limits: Limits = {}): Promise<string> {
  const r = await withPage(chrome, url, look, web, limits, (c) => c.send("Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true }));
  return String(r.result?.value ?? "");
}
