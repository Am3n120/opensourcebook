import { describe, expect, it } from "vitest";
import { createSourceExtractor } from "../src/extract";
import { extractWebModule } from "../src/extract/web";
import type {
  BrowserBindingLike,
  BrowserPageLike,
  BrowserSessionLike,
  FetchLike,
} from "../src/types";

const PAGE_URL = "https://www.bbcgoodfood.com/recipes/easy-pancakes";
const SENTENCE = "Whisk the flour, eggs, and milk into a smooth batter, then rest it before frying until golden. ";

function richArticleHTML(): string {
  const paragraph = SENTENCE.repeat(12);
  return `<html><head>
<title>Ignored title tag</title>
<meta property="og:title" content="Easy pancakes">
<meta property="og:description" content="A simple batter for fluffy pancakes.">
<meta property="og:image" content="/og-cover.jpg">
</head><body>
<nav>Subscribe to our newsletter for daily deals</nav>
<article>
<h1>Easy pancakes</h1>
<p>${paragraph}</p>
<p>${paragraph}</p>
</article>
</body></html>`;
}

const THIN_HTML = `<html><head>
<meta property="og:title" content="Thin Page">
</head><body><main><p>Hello.</p></main></body></html>`;

type GotoOptions = { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number };

class FakeBrowserPage implements BrowserPageLike {
  readonly gotoCalls: Array<{ url: string; options?: GotoOptions }> = [];
  userAgent?: string;
  viewport?: { width: number; height: number };
  closes = 0;

  constructor(private readonly behavior: { html?: string; failContent?: boolean }) {}

  async setUserAgent(userAgent: string): Promise<void> {
    this.userAgent = userAgent;
  }

  async setViewport(viewport: { width: number; height: number }): Promise<void> {
    this.viewport = viewport;
  }

  async goto(url: string, options?: GotoOptions): Promise<unknown> {
    this.gotoCalls.push({ url, ...(options ? { options } : {}) });
    return undefined;
  }

  async content(): Promise<string> {
    if (this.behavior.failContent) throw new Error("Target crashed");
    return this.behavior.html ?? "<html></html>";
  }

  async close(): Promise<void> {
    this.closes += 1;
  }
}

/** Fake browser binding recording launch/goto/close and serving canned HTML. */
class FakeBrowserBinding implements BrowserBindingLike {
  launches = 0;
  sessionCloses = 0;
  readonly pages: FakeBrowserPage[] = [];

  constructor(private readonly behavior: { html?: string; failLaunch?: boolean; failContent?: boolean }) {}

  async launch(): Promise<BrowserSessionLike> {
    this.launches += 1;
    if (this.behavior.failLaunch) throw new Error("429: browser instance limit reached");
    const page = new FakeBrowserPage(this.behavior);
    this.pages.push(page);
    return {
      newPage: async () => page,
      close: async () => {
        this.sessionCloses += 1;
      },
    };
  }
}

/** HEAD probes get a generic HTML 200; GETs on the page URL follow the given route. */
function fakeFetch(pageResponse: () => Response): FetchLike {
  return async (input, init) => {
    const url = String(input);
    if (init?.method === "HEAD") {
      return new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url === PAGE_URL) return pageResponse();
    return new Response(`image-bytes-for-${url}`, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "128" },
    });
  };
}

const blockedFetch = () => fakeFetch(() => new Response("Just a moment...", { status: 403 }));
const htmlResponse = (html: string) => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

describe("browser-render extraction tier", () => {
  it("renders bot-blocked pages and merges the reader-mode envelope", async () => {
    const binding = new FakeBrowserBinding({ html: richArticleHTML() });
    const extractor = createSourceExtractor({ browser: binding });
    const envelope = await extractor.extract({
      sourceText: "",
      sourceURL: PAGE_URL,
      sourceKind: "web",
      fetchImpl: blockedFetch(),
    });

    expect(envelope.metadata.extraction).toBe("readability+render");
    expect(envelope.accessLevel).toBe("full");
    expect(envelope.title).toBe("Easy pancakes");
    expect(envelope.text.length).toBeGreaterThanOrEqual(600);
    expect(envelope.references[0]).toMatchObject({ url: PAGE_URL, label: "source" });
    expect(envelope.extractionNotes).toContain("Page HTML was rendered in a headless browser before parsing");

    expect(binding.launches).toBe(1);
    expect(binding.sessionCloses).toBe(1);
    const page = binding.pages[0];
    expect(page.gotoCalls).toHaveLength(1);
    expect(page.gotoCalls[0].url).toBe(PAGE_URL);
    expect(page.gotoCalls[0].options?.waitUntil).toBe("load");
    expect(typeof page.gotoCalls[0].options?.timeout).toBe("number");
    expect(page.userAgent).toContain("Chrome");
    expect(page.viewport).toEqual({ width: 1366, height: 900 });
    expect(page.closes).toBe(1);
  });

  it("re-renders thin reader-mode results through the browser", async () => {
    const binding = new FakeBrowserBinding({ html: richArticleHTML() });
    const extractor = createSourceExtractor({ browser: binding });
    const envelope = await extractor.extract({
      sourceText: "",
      sourceURL: PAGE_URL,
      sourceKind: "web",
      fetchImpl: fakeFetch(() => htmlResponse(THIN_HTML)),
    });

    expect(binding.launches).toBe(1);
    expect(envelope.metadata.extraction).toBe("readability+render");
    expect(envelope.accessLevel).toBe("full");
  });

  it("does not render when the plain fetch already yields full text", async () => {
    const binding = new FakeBrowserBinding({ html: richArticleHTML() });
    const extractor = createSourceExtractor({ browser: binding });
    const envelope = await extractor.extract({
      sourceText: "",
      sourceURL: PAGE_URL,
      sourceKind: "web",
      fetchImpl: fakeFetch(() => htmlResponse(richArticleHTML())),
    });

    expect(binding.launches).toBe(0);
    expect(envelope.metadata.extraction).toBe("readability");
    expect(envelope.accessLevel).toBe("full");
  });

  it("leaves the legacy path untouched when no browser binding is configured", async () => {
    const extractor = createSourceExtractor();
    const envelope = await extractor.extract({
      sourceText: "",
      sourceURL: PAGE_URL,
      sourceKind: "web",
      fetchImpl: blockedFetch(),
    });

    expect(envelope.metadata.extraction).toBe("url-only");
    expect(envelope.accessLevel).toBe("none");
  });

  it("falls back cleanly when the browser fails to launch", async () => {
    const binding = new FakeBrowserBinding({ failLaunch: true });
    const extractor = createSourceExtractor({ browser: binding });
    const envelope = await extractor.extract({
      sourceText: "",
      sourceURL: PAGE_URL,
      sourceKind: "web",
      fetchImpl: blockedFetch(),
    });

    expect(binding.launches).toBe(1);
    expect(envelope.metadata.extraction).toBe("url-only");
    expect(envelope.accessLevel).toBe("none");
  });

  it("always closes the browser, even when reading the page fails", async () => {
    const binding = new FakeBrowserBinding({ failContent: true });
    const extractor = createSourceExtractor({ browser: binding });
    const envelope = await extractor.extract({
      sourceText: "",
      sourceURL: PAGE_URL,
      sourceKind: "web",
      fetchImpl: blockedFetch(),
    });

    expect(envelope.metadata.extraction).toBe("url-only");
    expect(binding.sessionCloses).toBe(1);
    expect(binding.pages[0].closes).toBe(1);
  });

  it("parses supplied rendered HTML without fetching and absolutizes relative images", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("fetch must not run for pre-rendered HTML");
    };
    const result = await extractWebModule({
      url: PAGE_URL,
      sourceText: "",
      fetchImpl,
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      maxTextChars: 24_000,
      renderedHTML: richArticleHTML(),
    });

    expect(result).toBeDefined();
    expect(result?.metadata?.extraction).toBe("readability+render");
    expect(result?.accessLevel).toBe("full");
    expect(result?.assets?.[0]?.url).toBe("https://www.bbcgoodfood.com/og-cover.jpg");
  });
});
