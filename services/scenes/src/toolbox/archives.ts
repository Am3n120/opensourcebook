/**
 * Picture search in open archives: pictures that are public domain or under an open license, with who made them and
 * the page to check them on. The sources are Wikimedia Commons, NASA, The
 * Met, Smithsonian Open Access (CC0 media only), the Internet Archive and Openverse. Each source is one
 * entry in ARCHIVES, so adding one never touches the tool. A source that fails is skipped, and the rest still answer.
 */
import type { Origin } from "./assets.ts";
import { getJson, type Web } from "./net.ts";

export interface Hit {
  title: string;
  /** A small version to look at. */
  thumb: string;
  /** The large version to keep. */
  full: string;
  size?: string;
  origin: Origin;
}

export interface ArchiveContext {
  web: Web;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface Archive {
  id: string;
  label: string;
  /** What it holds, for the agent to pick sources by. */
  holds: string;
  search(q: string, n: number, x: ArchiveContext): Promise<Hit[]>;
}

const SAFE = /public domain|^pd|cc0|^cc[ -]by(-sa)?( |$|-\d|\d)/i;
const strip = (html = "") => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const get = (url: string, x: ArchiveContext) => getJson(url, x.web, x.signal ? { signal: x.signal } : {});

const commons: Archive = {
  id: "commons",
  label: "Wikimedia Commons",
  holds: "photos, diagrams, maps, paintings, scans of old documents: almost anything, openly licensed",
  async search(q, n, x) {
    const j = await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=24&gsrsearch=${encodeURIComponent(q)}&prop=imageinfo&iiprop=url|extmetadata|mime|size&iiurlwidth=2048`, x);
    return (Object.values(j.query?.pages ?? {}) as any[])
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ p, ii: p.imageinfo?.[0] }))
      .filter(({ ii }) => ii && /image\/(jpeg|png|webp|svg\+xml|tiff)/.test(ii.mime) && SAFE.test(ii.extmetadata?.LicenseShortName?.value ?? ""))
      .slice(0, n)
      .map(({ p, ii }) => ({
        title: p.title.replace(/^File:/, "").replace(/\.\w+$/, ""),
        // Commons serves only standard thumbnail widths; 500px works where 400px is refused.
        thumb: ii.thumburl.replace(/\/\d+px-/, "/500px-"),
        full: ii.thumburl,
        size: `${ii.width}x${ii.height}`,
        origin: { source: "Wikimedia Commons", title: p.title, page: ii.descriptionurl, license: ii.extmetadata?.LicenseShortName?.value, author: strip(ii.extmetadata?.Artist?.value) || undefined },
      }));
  },
};

const nasa: Archive = {
  id: "nasa",
  label: "NASA",
  holds: "space, planets, rockets, Earth from orbit, aircraft, NASA science",
  async search(q, n, x) {
    const j = await get(`https://images-api.nasa.gov/search?q=${encodeURIComponent(q)}&media_type=image`, x);
    return (j.collection?.items ?? []).slice(0, n).map((it: any) => {
      const id = it.data?.[0]?.nasa_id;
      return {
        title: it.data?.[0]?.title ?? id,
        thumb: it.links?.[0]?.href,
        full: `https://images-assets.nasa.gov/image/${encodeURIComponent(id)}/${encodeURIComponent(id)}~large.jpg`,
        origin: { source: "NASA", title: it.data?.[0]?.title, page: `https://images.nasa.gov/details/${id}`, license: "public domain in the US" },
      };
    });
  },
};

const met: Archive = {
  id: "met",
  label: "The Met",
  holds: "art and objects across history: paintings, sculpture, tools, clothing, artefacts",
  async search(q, n, x) {
    const j = await get(`https://collectionapi.metmuseum.org/public/collection/v1/search?q=${encodeURIComponent(q)}&hasImages=true`, x);
    const out: Hit[] = [];
    for (const id of (j.objectIDs ?? []).slice(0, n * 2)) {
      const o = await get(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, x).catch(() => null);
      if (o?.isPublicDomain && o.primaryImageSmall) out.push({ title: o.title, thumb: o.primaryImageSmall, full: o.primaryImage || o.primaryImageSmall, origin: { source: "The Met", title: o.title, page: o.objectURL, license: "CC0", author: o.artistDisplayName || undefined } });
      if (out.length >= n) break;
    }
    return out;
  },
};

// Without SI_API_KEY it uses api.data.gov's shared DEMO_KEY, which allows only a few searches an hour; a free key is
// instant at api.data.gov/signup.
const smithsonian: Archive = {
  id: "smithsonian",
  label: "Smithsonian",
  holds: "natural history, animals, plants, inventions, American history, air and space",
  async search(q, n, x) {
    const key = x.env.SI_API_KEY?.trim() || "DEMO_KEY";
    const j = await get(`https://api.si.edu/openaccess/api/v1.0/search?q=${encodeURIComponent(`${q} AND online_media_type:"Images"`)}&rows=${n * 3}&api_key=${key}`, x);
    return smithsonianHits(j).slice(0, n);
  },
};

export function smithsonianHits(j: any): Hit[] {
  const out: Hit[] = [];
  for (const row of j?.response?.rows ?? []) {
    const d = row.content?.descriptiveNonRepeating ?? {};
    const m = (d.online_media?.media ?? []).find((x: any) => x.type === "Images" && x.usage?.access === "CC0" && x.idsId);
    if (!m) continue;
    const big = (m.resources ?? []).find((r: any) => r.width && r.height);
    const ids = `https://ids.si.edu/ids/deliveryService?id=${encodeURIComponent(m.idsId)}`;
    out.push({ title: String(row.title ?? "untitled"), thumb: `${ids}&max=500`, full: `${ids}&max=2048`, ...(big ? { size: `${big.width}x${big.height}` } : {}), origin: { source: "Smithsonian", title: String(row.title ?? ""), page: d.record_link ?? ids, license: "CC0", author: d.data_source } });
  }
  return out;
}

const internetArchive: Archive = {
  id: "internet-archive",
  label: "Internet Archive",
  holds: "old books' plates, posters, photos and scans",
  async search(q, n, x) {
    // A slash inside a wildcard breaks the search backend, so ask broadly and keep only the safe licenses after.
    const query = `(${q}) AND mediatype:image AND (licenseurl:*publicdomain* OR licenseurl:*creativecommons*)`;
    const j = await get(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}&fl[]=identifier&fl[]=title&fl[]=licenseurl&fl[]=creator&rows=${n * 2}&output=json`, x);
    const metas = await Promise.all((j.response?.docs ?? []).map((doc: any) => get(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`, x).then((m) => internetArchiveHit(doc, m)).catch(() => null)));
    return metas.filter((c): c is Hit => !!c).slice(0, n);
  },
};

export function internetArchiveHit(doc: any, meta: any): Hit | null {
  const license = iaLicense(doc.licenseurl);
  if (!license) return null;
  const files = (meta?.files ?? []).filter((f: any) => /^(JPEG|PNG)$/i.test(f.format ?? "") && !/thumb/i.test(f.name ?? ""));
  const f = [...files].sort((a: any, b: any) => Number(b.size ?? 0) - Number(a.size ?? 0))[0];
  if (!f || Number(f.size ?? 0) < 150_000) return null;
  return {
    title: String(doc.title ?? doc.identifier),
    thumb: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
    full: `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(f.name)}`,
    origin: { source: "Internet Archive", title: String(doc.title ?? ""), page: `https://archive.org/details/${doc.identifier}`, license, author: [doc.creator].flat().filter(Boolean).join(", ") || undefined },
  };
}

export function iaLicense(url = ""): string | null {
  if (/publicdomain\/zero/i.test(url)) return "CC0";
  if (/publicdomain\/mark/i.test(url)) return "public domain";
  const m = url.match(/creativecommons\.org\/licenses\/(by(?:-sa)?)\/([\d.]+)/i);
  return m ? `CC ${m[1]!.toUpperCase()} ${m[2]}` : null;
}

// Openverse indexes openly licensed pictures across Flickr, museums and other collections. No key is needed for
// light use; only licenses that allow reuse in a video are asked for.
const openverse: Archive = {
  id: "openverse",
  label: "Openverse",
  holds: "openly licensed photos from Flickr, museums and many smaller collections",
  async search(q, n, x) {
    const j = await get(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license_type=commercial,modification&page_size=${Math.min(20, n * 2)}`, x);
    return (j.results ?? []).slice(0, n).map((r: any) => ({
      title: String(r.title ?? "untitled"),
      thumb: r.thumbnail ?? r.url,
      full: r.url,
      ...(r.width && r.height ? { size: `${r.width}x${r.height}` } : {}),
      origin: { source: r.source ? `${r.source} via Openverse` : "Openverse", title: r.title, page: r.foreign_landing_url ?? r.url, license: `${String(r.license ?? "").toUpperCase() === "PDM" ? "public domain" : `CC ${String(r.license ?? "").toUpperCase()}`}${r.license_version ? ` ${r.license_version}` : ""}`, author: r.creator || undefined },
    }));
  },
};

export const ARCHIVES: Archive[] = [commons, nasa, met, smithsonian, internetArchive, openverse];

/** Searches the named archives (all by default) and interleaves them, so the top hit of each comes first. */
export async function searchArchives(q: string, perSource: number, x: ArchiveContext, only?: string[]): Promise<{ hits: Hit[]; failed: string[] }> {
  const sources = only?.length ? ARCHIVES.filter((a) => only.includes(a.id)) : ARCHIVES;
  const failed: string[] = [];
  const found = await Promise.all(sources.map((a) => a.search(q, perSource, x).catch(() => (failed.push(a.label), [] as Hit[]))));
  const hits: Hit[] = [];
  for (let k = 0; k < perSource; k++) for (const list of found) if (list[k]?.thumb && list[k]?.full) hits.push(list[k]!);
  return { hits, failed };
}
