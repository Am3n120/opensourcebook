/**
 * Web search, behind a small registry: each provider says whether it can run with the settings at hand, and the tool
 * uses the first that can unless the agent names one. Muse Spark's web search (with META_API_KEY) searches the whole
 * web; Wikipedia's own search needs no key and finds encyclopedia articles. Another search service is one more entry.
 */
import { metaFromEnv, sparkSearch, type WebResult } from "./meta.ts";
import { fetchChecked, getJson, Refused, type Web } from "./net.ts";

export interface SearchContext {
  fetch: typeof fetch;
  web: Web;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface WebSearch {
  id: string;
  label: string;
  covers: string;
  available(env: NodeJS.ProcessEnv): boolean;
  search(q: string, n: number, x: SearchContext): Promise<WebResult[]>;
}

const spark: WebSearch = {
  id: "web",
  label: "the web (Muse Spark's web search)",
  covers: "the whole web",
  available: (env) => !!env.META_API_KEY?.trim(),
  async search(q, n, x) {
    // Spark can write an address its search never returned (seen live: a made-up site that answered 404), so each
    // one is opened before it is listed, and only pages that are there are kept.
    const found = await sparkSearch(metaFromEnv(x.env, x.fetch)!, q, n, x.signal);
    const there = await Promise.all(found.map((r) => isThere(r.url, x)));
    return found.filter((_, i) => there[i]);
  },
};

/** Whether a page answers at its address: not missing (404, 410), not a name that doesn't exist, not refused. */
export async function isThere(url: string, x: SearchContext): Promise<boolean> {
  try {
    const r = await fetchChecked(url, { maxBytes: 4e6, timeoutMs: 10_000, ...(x.signal ? { signal: x.signal } : {}) }, x.web);
    return r.status !== 404 && r.status !== 410 && r.status < 500;
  } catch (e) {
    // Too big to read here is still a page; a private address, a dead name or no answer is not.
    return e instanceof Refused && /sends/.test(e.message);
  }
}

const wikipedia: WebSearch = {
  id: "wikipedia",
  label: "Wikipedia",
  covers: "encyclopedia articles, in English",
  available: () => true,
  async search(q, n, x) {
    const j = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${n}&srsearch=${encodeURIComponent(q)}`, x.web, x.signal ? { signal: x.signal } : {});
    return (j.query?.search ?? []).map((r: any) => ({
      title: r.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, "_"))}`,
      snippet: String(r.snippet ?? "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#0?39;/g, "'"),
    }));
  },
};

export const SEARCHES: WebSearch[] = [spark, wikipedia];

export const searchesFor = (env: NodeJS.ProcessEnv) => SEARCHES.filter((s) => s.available(env));
