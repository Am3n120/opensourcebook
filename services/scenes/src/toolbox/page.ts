/**
 * Reading a web page: its title, its words, its links and the pictures on it, from the HTML; and, through the same
 * headless Chrome that draws the scenes, a screenshot of it as a phone or a desktop shows it, or the page after its
 * scripts ran when the HTML alone carries little text. No HTML library: a page is read with a few plain rules, which is
 * enough to find what is on it, not to reproduce it.
 */
import { join } from "node:path";
import { findBinary } from "../chrome.ts";
import { pageHtml, takeScreenshot } from "./headless.ts";
import type { Web } from "./net.ts";

export interface PageImage {
  src: string;
  alt: string;
  width?: number;
  height?: number;
}

export interface ReadPage {
  title: string;
  description: string;
  text: string;
  links: { href: string; text: string }[];
  images: PageImage[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) return undefined;
  try {
    const u = new URL(href, base);
    return /^https?:$/.test(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** The page's words, links and pictures, read from its HTML. */
export function readHtml(html: string, base: string): ReadPage {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const meta = (key: string) => {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const tag = m[0];
      if ((attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase() === key) return attr(tag, "content") ?? "";
    }
    return "";
  };
  const description = (meta("og:description") || meta("description")).trim();
  const body = html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  // The main part of the page when it marks one; navigation, headers and footers otherwise add noise.
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(body)?.[0] ?? body.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const text = decode(main.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/figcaption|\/blockquote)\b[^>]*>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ").replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n${"#".repeat(Number(n))} `).replace(/<[^>]+>/g, " "))
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const links: ReadPage["links"] = [];
  const seenLinks = new Set<string>();
  for (const m of main.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = absolute(attr(m[1]!, "href"), base);
    const words = decode(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!href || !words || seenLinks.has(href)) continue;
    seenLinks.add(href);
    links.push({ href, text: words.slice(0, 100) });
  }
  const images: PageImage[] = [];
  const seenImages = new Set<string>();
  const og = absolute(meta("og:image"), base);
  if (og) (seenImages.add(og), images.push({ src: og, alt: "the page's own preview picture" }));
  for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    // The largest candidate in srcset when there is one: lazy pages often put a placeholder in src.
    const set = (attr(tag, "srcset") ?? attr(tag, "data-srcset"))?.split(",").map((x) => x.trim().split(/\s+/)).sort((a, b) => parseFloat(b[1] ?? "0") - parseFloat(a[1] ?? "0"))[0]?.[0];
    const src = absolute(set ?? attr(tag, "data-src") ?? attr(tag, "src"), base);
    const width = Number(attr(tag, "width")) || undefined;
    const height = Number(attr(tag, "height")) || undefined;
    if (!src || seenImages.has(src) || /\.svg($|\?)/i.test(src) || (width !== undefined && width < 120) || (height !== undefined && height < 120)) continue;
    seenImages.add(src);
    images.push({ src, alt: (attr(tag, "alt") ?? "").trim().slice(0, 160), ...(width ? { width } : {}), ...(height ? { height } : {}) });
  }
  return { title, description, text, links, images };
}

/** The headless Chrome to open pages with: the one the scenes use, else the one Remotion downloaded. */
export function pageChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENSOURCEBOOK_CHROME?.trim() || findBinary(join(import.meta.dirname, "..", "..", "node_modules", ".remotion"));
}

const VIEWS = { phone: { width: 430, height: 932, scale: 2 }, desktop: { width: 1440, height: 1000, scale: 1 } } as const;
export type View = keyof typeof VIEWS;

/** A screenshot of the page's first screen as a phone or a desktop shows it, written to `out` (PNG). */
export async function screenshot(chrome: string, url: string, out: string, view: View, web: Web, signal?: AbortSignal): Promise<void> {
  await takeScreenshot(chrome, url, out, VIEWS[view], web, { timeout: 45_000, signal });
}

/** The page's HTML after its scripts ran, for pages that build their words in the browser. */
export async function renderedHtml(chrome: string, url: string, web: Web, signal?: AbortSignal): Promise<string> {
  return pageHtml(chrome, url, VIEWS.desktop, web, { timeout: 45_000, signal });
}
