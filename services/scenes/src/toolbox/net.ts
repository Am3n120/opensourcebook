/**
 * The toolbox's way out to the web. Every address the agent names, or a page or an archive hands back, is checked
 * with Open Sourcebook's one address check (`common/addresses.ts`) before anything is fetched: only http and https, no user names
 * or passwords, and only addresses on the public internet, never this computer (any of its own addresses included)
 * or a private network, so a page the agent opens can't reach the agent connector, the web app, this service or
 * anything else on the person's own network.
 *
 * A name is resolved once, every address it has is checked, and the connection goes to that checked address (the
 * name is still what TLS checks the certificate against), so the name can't point somewhere else between the check
 * and the fetch. Redirects are followed by hand and each hop is checked the same way. Bodies are read up to a limit.
 */
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import { addressText, isPublicAddress, parseAddress, readTarget, refusedHost } from "../../../../common/addresses.ts";

export type Resolve = (host: string) => Promise<string[]>;

export const resolveHost: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Where a checked address connects: the one address the check let through. */
export interface Pin {
  address: string;
  family: 4 | 6;
}

/** Opens one hop at a checked address. The real one connects to `to`; tests play the web here and may ignore it. */
export type Connect = (url: URL, init: RequestInit, to: Pin) => Promise<Response>;

/** The web as the toolbox reaches it: how names are found, how a checked hop is opened, and which addresses may be. */
export interface Web {
  resolve: Resolve;
  connect: Connect;
  /** Whether an address may be opened; by default a public address that is not this computer's own. */
  allows?: (address: Uint8Array) => boolean;
}

const key = (bytes: Uint8Array) => addressText(bytes).address;

/** This computer's own addresses, read each time (a network can come and go): a public address on it is still this computer. */
export function ownAddresses(): Set<string> {
  const own = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      const bytes = parseAddress(a.address.replace(/%.*$/, ""));
      if (bytes) own.add(key(bytes));
    }
  }
  return own;
}

export const allowsAddress = (bytes: Uint8Array): boolean => isPublicAddress(bytes) && !ownAddresses().has(key(bytes));

export class Refused extends Error {}

export interface Checked extends Pin {
  url: URL;
}

/** The address, checked: a public http(s) address and the one address to connect to, or a plain reason it is refused. */
export async function checkUrl(raw: string, resolve: Resolve = resolveHost, allows: (address: Uint8Array) => boolean = allowsAddress): Promise<Checked> {
  const target = readTarget(raw, allows);
  if ("refused" in target) throw new Refused(target.refused);
  const found = target.literal ? [target.literal] : (await resolve(target.host).catch(() => [] as string[])).map((a) => parseAddress(a));
  if (!found.length) throw new Refused(`${target.host} could not be found.`);
  // Every address the name has must pass, and one the check can't read fails it.
  if (!found.every((b): b is Uint8Array => !!b && allows(b))) throw new Refused(refusedHost(target.host));
  return { url: target.url, ...addressText(found[0]!) };
}

const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length"]);
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

/**
 * One request to `url` over a connection to the checked address `to` only: the name is never looked up again, and
 * for https the certificate is still checked against the name. Redirects are not followed. The answer is as the
 * server sent it, still compressed if it was.
 */
export function openPinned(url: URL, to: Pin, o: { method?: string; headers?: Record<string, string>; body?: string | Buffer; signal?: AbortSignal } = {}): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const headers: Record<string, string> = { host: url.host };
  for (const [k, v] of Object.entries(o.headers ?? {})) if (!DROP_REQUEST.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  if (o.body !== undefined) headers["content-length"] = String(Buffer.byteLength(o.body));
  const options: https.RequestOptions = {
    hostname: host,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: o.method ?? "GET",
    headers,
    agent: false,
    lookup: ((_name: string, opts: { all?: boolean }, done: (...a: unknown[]) => void) => (opts?.all ? done(null, [{ address: to.address, family: to.family }]) : done(null, to.address, to.family))) as never,
    ...(isIP(host) ? {} : { servername: host }),
    ...(o.signal ? { signal: o.signal } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(options, resolve);
    req.on("error", reject);
    req.end(o.body);
  });
}

function decoded(res: IncomingMessage): Readable {
  const how = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
  const unpack = how === "gzip" || how === "x-gzip" ? zlib.createGunzip() : how === "deflate" ? zlib.createInflate() : how === "br" ? zlib.createBrotliDecompress() : how === "zstd" && "createZstdDecompress" in zlib ? (zlib as any).createZstdDecompress() : undefined;
  if (!unpack) return res;
  res.on("error", (e) => unpack.destroy(e));
  return res.pipe(unpack);
}

/** The toolbox's real connection: one hop over `openPinned`, answered as a fetch Response, its body uncompressed. */
export const connectPinned: Connect = async (url, init, to) => {
  const headers: Record<string, string> = { "accept-encoding": "gzip, deflate, br" };
  new Headers(init.headers).forEach((v, k) => (headers[k] = v));
  const body = typeof init.body === "string" ? init.body : undefined;
  const res = await openPinned(url, to, { method: init.method ?? "GET", headers, ...(body !== undefined ? { body } : {}), ...(init.signal ? { signal: init.signal } : {}) });
  const status = res.statusCode ?? 502;
  if (status < 200 || status > 599) throw new Refused(`${url.hostname} answered in a way that can't be read (${status}).`);
  const out = new Headers();
  for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
    const name = res.rawHeaders[i]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === "content-encoding" || name === "content-length") continue;
    out.append(name, res.rawHeaders[i + 1]!);
  }
  const length = res.headers["content-length"];
  if (length && !res.headers["content-encoding"]) out.set("content-length", length);
  const empty = status === 204 || status === 205 || status === 304 || init.method === "HEAD";
  if (empty) res.resume();
  return new Response(empty ? null : (Readable.toWeb(decoded(res)) as ReadableStream), { status, headers: out });
};

/** The real web: names resolved by this computer, hops opened at the checked address. */
export const realWeb = (): Web => ({ resolve: resolveHost, connect: connectPinned });

export interface Fetched {
  url: string;
  status: number;
  contentType: string;
  bytes: Buffer;
}

export interface FetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
  signal?: AbortSignal;
}

export const USER_AGENT = "OpenSourcebook-Scenes/0.1 (study videos from the person's own sources)";

/** Fetches a public address, following up to five redirects, each checked. Refuses a body over maxBytes. */
export async function fetchChecked(raw: string, o: FetchOptions, web: Web): Promise<Fetched> {
  let at = await checkUrl(raw, web.resolve, web.allows);
  const signal = AbortSignal.any([AbortSignal.timeout(o.timeoutMs ?? 30_000), ...(o.signal ? [o.signal] : [])]);
  for (let hop = 0; hop <= 5; hop++) {
    const response = await web.connect(at.url, { method: o.method ?? "GET", redirect: "manual", signal, headers: { "user-agent": USER_AGENT, ...o.headers }, ...(o.body ? { body: o.body } : {}) }, at);
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => undefined);
      at = await checkUrl(new URL(response.headers.get("location")!, at.url).href, web.resolve, web.allows);
      continue;
    }
    const url = at.url;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > o.maxBytes) throw new Refused(`${url.hostname} sends ${Math.round(length / 1e6)} MB; the limit is ${Math.round(o.maxBytes / 1e6)} MB.`);
    const bytes = await readLimited(response, o.maxBytes, url.hostname);
    return { url: url.href, status: response.status, contentType: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(), bytes };
  }
  throw new Refused(`${at.url.hostname} redirects too many times.`);
}

/** A response's body, refused past `max` bytes. */
export async function readLimited(response: Response, max: number, host: string): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) {
      await response.body.cancel().catch(() => undefined);
      throw new Refused(`${host} sends more than ${Math.round(max / 1e6)} MB; the limit is ${Math.round(max / 1e6)} MB.`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** JSON from a public address (an API the toolbox calls), with a short retry on a network failure or a 5xx. */
export async function getJson(raw: string, web: Web, o: { headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  for (let i = 1; ; i++) {
    try {
      const r = await fetchChecked(raw, { maxBytes: 8e6, timeoutMs: o.timeoutMs ?? 20_000, ...(o.headers ? { headers: o.headers } : {}), ...(o.signal ? { signal: o.signal } : {}) }, web);
      if (r.status >= 500 && i < 2) continue;
      if (r.status >= 400) throw new Error(`${r.status} from ${new URL(r.url).hostname}`);
      return JSON.parse(r.bytes.toString("utf8"));
    } catch (e) {
      if (e instanceof Refused || i >= 2 || o.signal?.aborted) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
