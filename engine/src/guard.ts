/**
 * The engine's way out to an address a source or a model gave: a link source and everything read from it (its
 * pictures, its PDF, its oEmbed and llms.txt), and the links a model put in a card. Each address is checked with Open Sourcebook's
 * one address check (`common/addresses.ts`): only http and https, no user name or password, never a name of this
 * computer, and every address the host has must be on the public internet. Redirects are followed here, by hand, and
 * each hop is checked the same way. Open Sourcebook's own programs (the connector, the scenes service, the yt-dlp sidecar) are
 * called at the addresses the engine is set up with and never through here.
 *
 * The engine runs in workerd (Cloudflare's runtime, also under `wrangler dev`), where a fetch can't be told which
 * address to connect to, so a name is looked up here over DNS over HTTPS and then looked up again by the runtime when
 * it connects. A name whose answer changes between the two (DNS rebinding), or one this computer's own resolver
 * answers differently from public DNS (a hosts file entry), can still reach an address the check never saw. The
 * deployed engine can't reach this computer or its network at all; on a computer running the engine itself, that
 * gap remains. The scenes toolbox, in Node, connects to the checked address and has no such gap.
 */
import { isPublicAddress, parseAddress, readTarget, refusedHost } from "../../common/addresses";
import type { FetchLike } from "./types/provider";

export type ResolveName = (host: string) => Promise<string[]>;

export class AddressRefused extends Error {
  override name = "AddressRefused";
}

const DOH = "https://cloudflare-dns.com/dns-query";

/** Looks a name up over DNS over HTTPS (A and AAAA). Fails, so the address is refused, when the lookup does. */
export function dohResolver(fetchImpl: FetchLike = (input, init) => fetch(input, init), endpoint = DOH): ResolveName {
  return async (host) => {
    const ask = async (type: "A" | "AAAA"): Promise<string[]> => {
      const response = await fetchImpl(`${endpoint}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`DNS answered ${response.status}`);
      const answer = (await response.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
      // 0 is an answer, 3 is "no such name"; anything else is a lookup that failed.
      if (answer.Status !== 0 && answer.Status !== 3) throw new Error(`DNS status ${answer.Status}`);
      return (answer.Answer ?? []).filter((a) => (a.type === 1 || a.type === 28) && typeof a.data === "string").map((a) => a.data!);
    };
    const [v4, v6] = await Promise.all([ask("A"), ask("AAAA")]);
    return [...v4, ...v6];
  };
}

/**
 * The address, checked: refused with a plain reason when it is not a public http(s) address. Without `resolve`, only
 * what the address says by itself is checked (its scheme, a host written as an address, a name of this computer).
 */
export async function checkSourceAddress(raw: string, resolve?: ResolveName): Promise<URL> {
  const target = readTarget(raw);
  if ("refused" in target) throw new AddressRefused(target.refused);
  if (target.literal || !resolve) return target.url;
  const found = await resolve(target.host).catch(() => [] as string[]);
  if (!found.length) throw new AddressRefused(`${target.host} could not be found.`);
  if (!found.every((a) => { const bytes = parseAddress(a); return !!bytes && isPublicAddress(bytes); })) throw new AddressRefused(refusedHost(target.host));
  return target.url;
}

/** A fetch that opens only checked addresses, with the check it uses and the plain fetch under it for Open Sourcebook's own programs. */
export interface GuardedFetch extends FetchLike {
  check(raw: string): Promise<URL>;
  unguarded: FetchLike;
}

const MAX_HOPS = 8;

/** `inner`, opening only addresses that pass the check, every redirect hop checked before it is followed. */
export function guardedFetch(inner: FetchLike, options: { resolve?: ResolveName } = {}): GuardedFetch {
  const check = (raw: string) => checkSourceAddress(raw, options.resolve);
  const guarded = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    let url = request ? request.url : String(input);
    let method = (init.method ?? request?.method ?? "GET").toUpperCase();
    let body = init.body ?? (request && method !== "GET" && method !== "HEAD" ? await request.arrayBuffer() : undefined);
    let headers: HeadersInit | undefined = init.headers ?? request?.headers;
    const byHand = init.redirect !== "manual";
    for (let hop = 0; ; hop++) {
      const at = await check(url);
      const response = await inner(at.href, { ...init, method, ...(headers ? { headers } : {}), ...(body !== undefined ? { body } : {}), redirect: "manual" });
      const location = response.headers.get("location");
      if (!byHand || response.status < 300 || response.status >= 400 || !location) return response;
      await response.body?.cancel().catch(() => undefined);
      if (hop >= MAX_HOPS) throw new AddressRefused(`${at.hostname} redirects too many times.`);
      url = new URL(location, at).href;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = undefined;
        const kept = new Headers(headers);
        kept.delete("content-type");
        kept.delete("content-length");
        headers = kept;
      }
    }
  };
  return Object.assign(guarded, { check, unguarded: inner });
}

/** The guarded fetch's own check and Open Sourcebook's plain fetch, when `fetchImpl` is guarded; else only what an address says by itself. */
export function guardOf(fetchImpl: FetchLike): { check: (raw: string) => Promise<URL>; unguarded: FetchLike } {
  const g = fetchImpl as Partial<GuardedFetch>;
  return g.check && g.unguarded ? { check: g.check, unguarded: g.unguarded } : { check: (raw) => checkSourceAddress(raw), unguarded: fetchImpl };
}
