import { describe, expect, it } from "vitest";
import { AssetStore, isAssetPath } from "../src/assets";
import { extractWebModule } from "../src/extract/web";
import type { FetchLike, R2BucketLike } from "../src/types";

interface StoredObject {
  bytes: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      size: object.bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      arrayBuffer: async () => object.bytes.slice(0),
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes = typeof value === "string"
      ? (new TextEncoder().encode(value).buffer as ArrayBuffer)
      : value instanceof ArrayBuffer
        ? value
        : (value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
    this.objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    return { key };
  }

  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, size: object.bytes.byteLength, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata };
  }
}

const PAGE_URL = "https://example.com/articles/reading-habits";
const SENTENCE = "The report traces how reading habits shift when interfaces reward saving over finishing. ";

function articleHTML(): string {
  const paragraph = SENTENCE.repeat(24);
  return `<html><head>
<title>Ignored title tag</title>
<meta property="og:title" content="How Reading Habits Change">
<meta property="og:description" content="A long look at saving versus finishing.">
<meta property="og:image" content="/og-cover.jpg">
<meta property="og:site_name" content="Example Mag">
<meta property="article:published_time" content="2024-05-01T00:00:00Z">
<meta name="author" content="Jane Doe">
<link rel="canonical" href="https://example.com/canonical-article">
</head><body>
<nav>Subscribe to our newsletter for daily deals</nav>
<article>
<h1>How Reading Habits Change</h1>
<p>${paragraph}</p>
<figure><img src="/media/figure-one.jpg" alt="Figure one alt"><figcaption>System overview</figcaption></figure>
<p><img src="https://media.example.com/inline-two.jpg"></p>
<p>${paragraph}</p>
<p><img src="https://cdn.example.com/wide-small.jpg" srcset="https://cdn.example.com/wide-400.jpg 400w, https://cdn.example.com/wide-1200.jpg 1200w"></p>
<p><img src="/media/photo-four.jpg"></p>
<p><img src="/media/photo-five.jpg"></p>
<p><img src="/media/photo-six.jpg"></p>
<p><img src="/media/photo-seven.jpg"></p>
<p><img src="/media/photo-eight.jpg"></p>
<p><img src="/media/logo.png"></p>
<p><img src="/media/icon-share.png"></p>
<p><img src="/media/tracker.gif" width="1" height="1"></p>
<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></p>
</article>
</body></html>`;
}

const THIN_URL = "https://example.com/thin";
const THIN_HTML = `<html><head>
<meta property="og:title" content="Thin Page">
<meta property="og:description" content="A page with barely any text.">
</head><body><main><p>Hello.</p></main></body></html>`;

interface FakeFetch {
  fetchImpl: FetchLike;
  requested: string[];
}

/** Routes the page URL to HTML and every other URL to a small image body. */
function fakeFetch(routes: Record<string, Response>): FakeFetch {
  const requested: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (route) return route;
    return new Response(`image-bytes-for-${url}`, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "128" },
    });
  };
  return { fetchImpl, requested };
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

const baseInput = { timeoutMs: 5_000, maxBytes: 1_000_000, maxTextChars: 24_000 };

describe("extractWebModule", () => {
  it("extracts reader-mode text and metadata and harvests images into the asset store", async () => {
    const bucket = new FakeR2Bucket();
    const { fetchImpl, requested } = fakeFetch({ [PAGE_URL]: htmlResponse(articleHTML()) });
    const result = await extractWebModule({
      ...baseInput,
      url: PAGE_URL,
      sourceText: "",
      fetchImpl,
      assetStore: new AssetStore(bucket),
    });

    expect(result).toBeDefined();
    expect(result?.title).toBe("How Reading Habits Change");
    expect(result?.author).toBe("Jane Doe");
    expect(result?.canonicalURL).toBe("https://example.com/canonical-article");
    expect(result?.excerpt).toBe("A long look at saving versus finishing.");

    // Reader-mode text wins over raw tag stripping: article body in, nav junk out.
    expect(result?.text).toContain("reading habits shift");
    expect(result?.text).not.toContain("Subscribe to our newsletter");

    expect(result?.accessLevel).toBe("full");
    expect(result?.depthCap).toBe("veryDeep");
    expect(result?.metadata).toMatchObject({
      extraction: "readability",
      siteName: "Example Mag",
      published: "2024-05-01T00:00:00Z",
      images: "6",
    });
    expect(result?.references).toEqual([{ url: PAGE_URL, domain: "example.com", label: "source" }]);

    // og:image leads as a thumbnail; harvest is capped at six assets total.
    const assets = result?.assets ?? [];
    expect(assets).toHaveLength(6);
    expect(assets[0]?.kind).toBe("thumbnail");
    expect(assets.slice(1).every((asset) => asset.kind === "image")).toBe(true);
    expect(assets.every((asset) => isAssetPath(asset.url))).toBe(true);
    expect(assets[1]?.caption).toBe("System overview");
    expect(bucket.objects.size).toBe(6);

    // The largest srcset candidate wins; junk and tracker images are never fetched.
    expect(requested).toContain("https://cdn.example.com/wide-1200.jpg");
    expect(requested).not.toContain("https://cdn.example.com/wide-400.jpg");
    expect(requested.some((url) => /logo|icon|tracker/.test(url))).toBe(false);
  });

  it("keeps remote absolute URLs when no asset store is bound", async () => {
    const { fetchImpl } = fakeFetch({ [PAGE_URL]: htmlResponse(articleHTML()) });
    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });

    const assets = result?.assets ?? [];
    expect(assets).toHaveLength(6);
    expect(assets[0]).toMatchObject({ kind: "thumbnail", url: "https://example.com/og-cover.jpg" });
    expect(assets[1]?.url).toBe("https://example.com/media/figure-one.jpg");
    expect(assets.some((asset) => asset.url === "https://cdn.example.com/wide-1200.jpg")).toBe(true);
    expect(assets.every((asset) => asset.url.startsWith("https://"))).toBe(true);
    expect(assets.every((asset) => asset.sourceURL === PAGE_URL)).toBe(true);
  });

  it("surfaces a top-level schema.org Recipe JSON-LD node as metadata.schemaType", async () => {
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Recipe","name":"Easy pancakes","recipeIngredient":["100g plain flour","2 large eggs","300ml milk"],"totalTime":"PT20M"}</script>
<meta property="og:title" content="Easy pancakes">
</head><body><article><h1>Easy pancakes</h1><p>${SENTENCE.repeat(24)}</p></article></body></html>`;
    const { fetchImpl } = fakeFetch({ [PAGE_URL]: htmlResponse(html) });
    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });

    expect(result).toBeDefined();
    expect(result?.metadata?.schemaType).toBe("Recipe");
  });

  it("finds a Recipe node nested in a JSON-LD @graph and ignores malformed blocks", async () => {
    const html = `<html><head>
<script type="application/ld+json">{not valid json</script>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"Easy pancakes"},{"@type":["Recipe","HowTo"],"name":"Easy pancakes"}]}</script>
</head><body><article><p>${SENTENCE.repeat(24)}</p></article></body></html>`;
    const { fetchImpl } = fakeFetch({ [PAGE_URL]: htmlResponse(html) });
    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });

    expect(result?.metadata?.schemaType).toBe("Recipe");
  });

  it("leaves schemaType unset when no Recipe JSON-LD is present", async () => {
    const { fetchImpl } = fakeFetch({ [PAGE_URL]: htmlResponse(articleHTML()) });
    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });

    expect(result?.metadata?.schemaType).toBeUndefined();
  });

  it("drops images that fail to fetch and keeps the rest", async () => {
    const bucket = new FakeR2Bucket();
    const { fetchImpl } = fakeFetch({
      [PAGE_URL]: htmlResponse(articleHTML()),
      "https://example.com/og-cover.jpg": new Response("gone", { status: 404 }),
    });
    const result = await extractWebModule({
      ...baseInput,
      url: PAGE_URL,
      sourceText: "",
      fetchImpl,
      assetStore: new AssetStore(bucket),
    });

    const assets = result?.assets ?? [];
    expect(assets).toHaveLength(5);
    expect(assets.every((asset) => asset.kind === "image")).toBe(true);
    expect(result?.metadata?.images).toBe("5");
    expect(bucket.objects.size).toBe(5);
  });

  it("falls back to OG metadata when the page has too little readable text", async () => {
    const { fetchImpl } = fakeFetch({ [THIN_URL]: htmlResponse(THIN_HTML) });
    const result = await extractWebModule({ ...baseInput, url: THIN_URL, sourceText: "", fetchImpl });

    expect(result).toBeDefined();
    expect(result?.title).toBe("Thin Page");
    expect(result?.accessLevel).toBe("partial");
    expect(result?.depthCap).toBe("light");
    expect(result?.metadata?.extraction).toMatch(/og/);
    expect(result?.assets).toEqual([]);
    expect(result?.extractionNotes?.join(" ")).toMatch(/no article|limited readable text/i);
  });

  it("resolves undefined for non-HTML responses so the ladder keeps its fallback", async () => {
    const { fetchImpl } = fakeFetch({
      [PAGE_URL]: new Response("%PDF-1.7 bytes", { status: 200, headers: { "content-type": "application/pdf" } }),
    });
    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });
    expect(result).toBeUndefined();
  });

  it("resolves undefined when the fetch throws or the page is not found", async () => {
    const throwing: FetchLike = async () => {
      throw new Error("network down");
    };
    await expect(extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl: throwing })).resolves.toBeUndefined();

    const { fetchImpl } = fakeFetch({ [PAGE_URL]: new Response("nope", { status: 404 }) });
    await expect(extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl })).resolves.toBeUndefined();
  });
});

const DOCS_URL = "https://docs.example.com/workers/";
const DOCS_HTML = `<html><head>
<meta property="og:title" content="Workers Overview">
<meta property="og:description" content="Build serverless apps.">
</head><body><main><p>Overview landing with mostly cards.</p></main></body></html>`;
const DOCS_MARKDOWN = `---
title: Workers Overview
---
# Workers

A serverless platform for building and deploying apps.

> Documentation Index
> Fetch the complete documentation index at: https://docs.example.com/workers/llms.txt

## On this page
`;
const LLMS_INDEX = `# Workers

## Overview

- [Workers Overview](https://docs.example.com/workers/index.md): The overview page itself.
- [Examples](https://docs.example.com/workers/examples/index.md): Browse code examples.

## Static Assets

- [Get Started](https://docs.example.com/workers/static-assets/get-started/index.md): Static-site quickstart (nested feature).

## Testing

- [Get Started](https://docs.example.com/workers/testing/miniflare/get-started/index.md): Miniflare quickstart (deeply nested feature).

## Get started

- [Dashboard](https://docs.example.com/workers/get-started/dashboard/index.md): Deploy from the dashboard.
- [CLI](https://docs.example.com/workers/get-started/guide/index.md): Set up Wrangler and deploy.
- [Other product](https://docs.example.com/other/get-started/index.md): Different product docs.
- [Offsite](https://elsewhere.example.com/workers/get-started/index.md): Another origin entirely.
`;
const GUIDE_MARKDOWN = `# Get started with the CLI

\`\`\`sh
npm create cloudflare@latest
\`\`\`

\`\`\`js
export default { async fetch() { return new Response("Hello World!"); } };
\`\`\`
`;
const DASHBOARD_MARKDOWN = `# Deploy from the dashboard

Open the dashboard, create a Worker, and paste your code.
`;

/** Routes by URL + Accept header: docs sites answer text/markdown when asked for it. */
function docsFetch(routes: Record<string, { markdown?: string; html?: string; status?: number }>): FakeFetch {
  const requested: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (!route || route.status === 404) return new Response("nope", { status: 404 });
    const accept = String((init?.headers as Record<string, string> | undefined)?.accept ?? "");
    if (accept.includes("text/markdown") && route.markdown !== undefined) {
      return new Response(route.markdown, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    if (route.html !== undefined) return htmlResponse(route.html);
    if (route.markdown !== undefined && !accept.includes("text/html")) {
      return new Response(route.markdown, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
    }
    return htmlResponse(route.html ?? route.markdown ?? "");
  };
  return { fetchImpl, requested };
}

describe("docs-markdown tier", () => {
  it("prefers site-served Markdown and pulls core subpages from the advertised llms.txt index", async () => {
    const { fetchImpl, requested } = docsFetch({
      [DOCS_URL]: { html: DOCS_HTML, markdown: DOCS_MARKDOWN },
      "https://docs.example.com/workers/llms.txt": { markdown: LLMS_INDEX },
      "https://docs.example.com/workers/get-started/dashboard/index.md": { markdown: DASHBOARD_MARKDOWN },
      "https://docs.example.com/workers/get-started/guide/index.md": { markdown: GUIDE_MARKDOWN },
      "https://docs.example.com/workers/examples/index.md": { markdown: "# Examples\n" },
    });

    const result = await extractWebModule({ ...baseInput, url: DOCS_URL, sourceText: "", fetchImpl });

    expect(result).toBeDefined();
    expect(result?.metadata?.extraction).toBe("site-markdown+llms-index");
    expect(result?.accessLevel).toBe("full");
    expect(result?.text).toContain("# Workers");
    // The two root-level get-started pages join as evidence: their core
    // segment sits closer to the product root than the nested features' own
    // get-started pages that appear earlier in the index. The page itself,
    // peripheral examples, other products, and other origins never qualify.
    expect(result?.text).toContain("Deploy from the dashboard");
    expect(result?.text).toContain("npm create cloudflare@latest");
    expect(result?.text).not.toContain("# Examples");
    expect(result?.references).toEqual([
      { url: DOCS_URL, domain: "docs.example.com", label: "source" },
      {
        url: "https://docs.example.com/workers/get-started/dashboard/index.md",
        title: "Dashboard",
        domain: "docs.example.com",
        label: "supplemental",
        relation: "llms-index",
      },
      {
        url: "https://docs.example.com/workers/get-started/guide/index.md",
        title: "CLI",
        domain: "docs.example.com",
        label: "supplemental",
        relation: "llms-index",
      },
    ]);
    expect(result?.extractionNotes?.join(" ")).toContain("documentation index");
    expect(requested).not.toContain("https://docs.example.com/other/get-started/index.md");
    expect(requested).not.toContain("https://elsewhere.example.com/workers/get-started/index.md");
  });

  it("uses site Markdown without supplements when the page advertises no index", async () => {
    const markdown = "# Plain Docs\n\nSome prose with no index pointer.\n\n" + "More detail. ".repeat(80);
    const { fetchImpl, requested } = docsFetch({ [DOCS_URL]: { html: DOCS_HTML, markdown } });

    const result = await extractWebModule({ ...baseInput, url: DOCS_URL, sourceText: "", fetchImpl });

    expect(result?.metadata?.extraction).toBe("site-markdown");
    expect(result?.text).toContain("# Plain Docs");
    expect(requested.filter((url) => url !== DOCS_URL)).toEqual([]);
  });

  it("keeps reader mode when the site does not negotiate Markdown", async () => {
    const { fetchImpl } = docsFetch({ [PAGE_URL]: { html: articleHTML() } });

    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });

    expect(result?.metadata?.extraction).toBe("readability");
    expect(result?.text).toContain("reading habits shift");
  });

  it("discovers a generic JSON oEmbed endpoint and exposes its metadata for generation", async () => {
    const endpoint = "https://example.com/oembed?format=json&url=https%3A%2F%2Fexample.com%2Farticles%2Freading-habits";
    const providerHTML = '<iframe src="https://player.example/embed/42"></iframe>';
    const html = `<html><head>
      <meta property="og:title" content="Embedded report">
      <link rel="alternate" type="application/json+oembed" href="/oembed?format=json">
      </head><body><article><p>${SENTENCE.repeat(24)}</p></article></body></html>`;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === PAGE_URL) return htmlResponse(html);
      if (url === endpoint) {
        expect(new Headers(init?.headers).get("accept")).toContain("application/json");
        return new Response(JSON.stringify({ type: "rich", version: "1.0", title: "Embedded report", html: providerHTML }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });
    expect(result?.metadata?.extraction).toBe("readability+oembed");
    expect(result?.metadata?.oembedEndpoint).toBe(endpoint);
    expect(JSON.parse(result?.metadata?.oembedJSON ?? "{}")).toEqual({ type: "rich", version: "1.0", title: "Embedded report", html: providerHTML });
  });

  it("keeps ordinary web extraction when generic oEmbed discovery or fetch fails", async () => {
    const html = `<html><head><meta property="og:title" content="No widget">
      <link rel="alternate" type="application/json+oembed" href="/oembed"></head><body><article><p>${SENTENCE.repeat(24)}</p></article></body></html>`;
    const fetchImpl: FetchLike = async (input) => {
      if (String(input) === PAGE_URL) return htmlResponse(html);
      return new Response("gone", { status: 404 });
    };
    const result = await extractWebModule({ ...baseInput, url: PAGE_URL, sourceText: "", fetchImpl });
    expect(result?.metadata?.extraction).toBe("readability");
    expect(result?.metadata?.oembedJSON).toBeUndefined();
  });
});

describe("github repo facts", () => {
  const REPO_URL = "https://github.com/yt-dlp/yt-dlp";
  const REPO_README = `<article><p>${"README body about the downloader. ".repeat(30)}</p></article>`;
  const REPO_COUNTERS = `<span id="repo-stars-counter-star" aria-label="183505 users starred this repository" title="183,505">183k</span>
<a href="/yt-dlp/yt-dlp/forks"><span id="repo-network-counter" data-turbo-replace="true" title="15,804" class="Counter">15.8k</span></a>`;
  const repoHTML = (counters: string) =>
    `<html><head><meta property="og:title" content="yt-dlp"></head><body>${counters}${REPO_README}</body></html>`;

  it("enriches repo roots with star/fork stats parsed from the page counters", async () => {
    const requested: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === REPO_URL) return htmlResponse(repoHTML(REPO_COUNTERS));
      return new Response("nope", { status: 404 });
    };

    const result = await extractWebModule({ ...baseInput, url: REPO_URL, sourceText: "", fetchImpl });

    expect(result?.metadata?.extraction).toBe("readability+repo-stats");
    expect(result?.text).toContain("Stars: 183505");
    expect(result?.text).toContain("Forks: 15804");
    expect(result?.text).toContain("README body about the downloader");
    expect(result?.extractionNotes?.join(" ")).not.toContain("statistics were unavailable");
    // No extra subrequests: the stats come from the page itself.
    expect(requested.filter((url) => url !== REPO_URL)).toEqual([]);
  });

  it("stands on the README alone when the page carries no counters", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === REPO_URL) return htmlResponse(repoHTML(""));
      return new Response("nope", { status: 404 });
    };

    const result = await extractWebModule({ ...baseInput, url: REPO_URL, sourceText: "", fetchImpl });

    expect(result?.metadata?.extraction).toBe("readability");
    expect(result?.text).toContain("README body about the downloader");
    expect(result?.extractionNotes?.join(" ")).toContain("GitHub repository statistics were unavailable");
  });

  it("ignores non-repo GitHub pages", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://github.com/topics/python") return htmlResponse(repoHTML(REPO_COUNTERS));
      return new Response("nope", { status: 404 });
    };

    const result = await extractWebModule({ ...baseInput, url: "https://github.com/topics/python", sourceText: "", fetchImpl });

    expect(result).toBeDefined();
    expect(result?.metadata?.extraction).toBe("readability");
    expect(result?.extractionNotes?.join(" ")).not.toContain("statistics were unavailable");
  });
});
