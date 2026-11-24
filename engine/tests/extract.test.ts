import { describe, expect, it } from "vitest";
import { createSourceExtractor } from "../src/extract";
import type { AudioTranscribingProvider, AudioTranscription } from "../src/extract/audio";
import type { ImageDescribingProvider, ImageDescription } from "../src/extract/image";
import type { FetchLike, StructuredGenerationRequest, StructuredProvider } from "../src/types";

function mockFetch(routes: Record<string, Response>): FetchLike {
  return async (input) => routes[String(input)] ?? new Response("missing", { status: 404 });
}

/** Smallest PDF unpdf accepts: one page, one Helvetica text run. */
function minimalPdfBytes(): ArrayBuffer {
  const stream = "BT /F1 24 Tf 72 720 Td (Hello from upload) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf).buffer as ArrayBuffer;
}

function pngBytes(): ArrayBuffer {
  const bytes = new Uint8Array(72);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 17) % 256;
  return bytes.buffer as ArrayBuffer;
}

function mp3Bytes(): ArrayBuffer {
  const bytes = new Uint8Array(128);
  bytes.set([0x49, 0x44, 0x33]); // "ID3"
  for (let i = 3; i < bytes.length; i++) bytes[i] = (i * 13) % 256;
  return bytes.buffer as ArrayBuffer;
}

function visionProvider(description: ImageDescription | undefined): StructuredProvider {
  const provider: ImageDescribingProvider = {
    name: "vision",
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      return {} as T;
    },
    describeImage: async () => description,
  };
  return provider;
}

function transcribingProvider(transcription: AudioTranscription | undefined): StructuredProvider {
  const provider: AudioTranscribingProvider = {
    name: "transcriber",
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      return {} as T;
    },
    transcribeAudio: async () => transcription,
  };
  return provider;
}

describe("source extraction", () => {
  it("extracts lightweight HTML and caps access depth honestly", async () => {
    const url = "https://example.com/article";
    const fetchImpl = mockFetch({
      [url]: new Response('<html><head><meta property="og:title" content="A real title"><meta property="og:description" content="A description"><link rel="canonical" href="https://example.com/canonical"></head><body><article>Readable source text that is deliberately supplied by the public page.</article></body></html>', {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.title).toBe("A real title");
    expect(source.canonicalURL).toBe("https://example.com/canonical");
    expect(source.accessLevel).toBe("partial");
    expect(source.depthCap).toBe("light");
    expect(source.limitations.length).toBeGreaterThan(0);
  });

  it("cuts a long source once, at a paragraph end, and says how much of it is used", async () => {
    const url = "https://example.com/long";
    const paragraphs = Array.from({ length: 60 }, (_, n) => `<p>Paragraph ${n + 1}. ${"The printing press spread across Europe. ".repeat(10)}</p>`).join("");
    const fetchImpl = mockFetch({ [url]: new Response(`<html><head><title>Long</title></head><body><article>${paragraphs}</article></body></html>`, { status: 200, headers: { "content-type": "text/html" } }) });
    const source = await createSourceExtractor({ maxTextChars: 6_000 }).extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.text.length).toBeLessThanOrEqual(6_000);
    expect(source.text.length).toBeGreaterThan(4_800);
    expect(source.text).toMatch(/\.$/);
    const full = Number(source.metadata.textChars);
    expect(full).toBeGreaterThan(20_000);
    expect(source.metadata).toMatchObject({ textCut: "true", textUsedChars: String(source.text.length) });
    expect(source.limitations).toContain(
      `Only the first ${source.text.length.toLocaleString("en-US")} of ${full.toLocaleString("en-US")} characters of this source are used (about ${Math.floor((source.text.length / full) * 100)}%); the rest is not read by anything made from it.`,
    );
  });

  it("keeps pasted text whole and a short page uncut", async () => {
    const pasted = await createSourceExtractor({ maxTextChars: 100 }).extract({ sourceText: "word ".repeat(100), sourceKind: "text", fetchImpl: mockFetch({}) });
    expect(pasted.text.length).toBe(499);
    expect(pasted.metadata.textCut).toBeUndefined();
  });

  it("specializes kind to recipe when the page declares schema.org Recipe JSON-LD", async () => {
    const url = "https://recipes.example.com/easy-pancakes";
    const paragraph = "Whisk the flour, eggs, and milk into a thin batter, then rest it for thirty minutes before cooking. ".repeat(12);
    const html = `<html><head>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Recipe","name":"Easy pancakes","recipeIngredient":["100g plain flour","2 large eggs","300ml milk"],"totalTime":"PT20M"}</script>
<meta property="og:title" content="Easy pancakes">
</head><body><article><h1>Easy pancakes</h1><p>${paragraph}</p></article></body></html>`;
    const fetchImpl = mockFetch({
      [url]: new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.kind).toBe("recipe");
    expect(source.metadata.schemaType).toBe("Recipe");
    expect(source.accessLevel).toBe("full");
  });

  it("keeps kind web when the page declares no Recipe JSON-LD", async () => {
    const url = "https://example.com/plain-article";
    const paragraph = "A plain article with no structured recipe markup, just several paragraphs of ordinary prose. ".repeat(12);
    const html = `<html><head><meta property="og:title" content="Plain Article"></head><body><article><p>${paragraph}</p></article></body></html>`;
    const fetchImpl = mockFetch({
      [url]: new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.kind).toBe("web");
    expect(source.metadata.schemaType).toBeUndefined();
  });

  it("surfaces generic page oEmbed metadata, including verbatim HTML, in the source envelope", async () => {
    const url = "https://embed.example.com/items/42";
    const endpoint = "https://embed.example.com/oembed?format=json&url=https%3A%2F%2Fembed.example.com%2Fitems%2F42";
    const providerHTML = '<iframe src="https://player.example/embed/42"></iframe>\n';
    const pageHTML = `<html><head>
      <meta property="og:title" content="Embedded item">
      <link rel="alternate" type="application/json+oembed" href="/oembed?format=json">
      </head><body><article><p>${"A readable item with enough public text for the normal web tier. ".repeat(15)}</p></article></body></html>`;
    const fetchImpl: FetchLike = async (input) => {
      const target = String(input);
      if (target === url) return new Response(pageHTML, { status: 200, headers: { "content-type": "text/html" } });
      if (target === endpoint) return new Response(JSON.stringify({ type: "rich", version: "1.0", title: "Embedded item", html: providerHTML }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      return new Response("missing", { status: 404 });
    };
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.metadata.extraction).toBe("readability+oembed");
    expect(source.metadata.oembedEndpoint).toBe(endpoint);
    expect(JSON.parse(source.metadata.oembedJSON ?? "{}")).toMatchObject({ type: "rich", version: "1.0", html: providerHTML });
  });

  it("keeps the normal web fallback when a discovered oEmbed endpoint fails", async () => {
    const url = "https://embed.example.com/items/no-widget";
    const pageHTML = `<html><head>
      <meta property="og:title" content="Plain item">
      <link rel="alternate" type="application/json+oembed" href="/oembed">
      </head><body><article><p>${"A readable item whose provider widget is unavailable. ".repeat(15)}</p></article></body></html>`;
    const fetchImpl: FetchLike = async (input) => {
      if (String(input) === url) return new Response(pageHTML, { status: 200, headers: { "content-type": "text/html" } });
      return new Response("gone", { status: 404 });
    };
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.metadata.extraction).toBe("readability");
    expect(source.metadata.oembedJSON).toBeUndefined();
  });

  it("uses YouTube oEmbed metadata without pretending it has a transcript", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const fetchImpl = mockFetch({
      [oembed]: new Response(JSON.stringify({ title: "Video title", author_name: "Channel", type: "video" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "youtube", fetchImpl });
    expect(source.title).toBe("Video title");
    expect(source.author).toBe("Channel");
    expect(source.accessLevel).toBe("metadata");
    expect(source.depthCap).toBe("tiny");
    expect(source.extractionNotes?.join(" ")).toMatch(/metadata only/i);
  });

  it("routes extension-less PDF URLs to the PDF ladder via content-type sniffing", async () => {
    const url = "https://arxiv.org/pdf/1706.03762";
    const fetchImpl = mockFetch({
      [url]: new Response("not-actually-a-pdf", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.kind).toBe("pdf");
    expect(source.metadata.extraction).toBe("pdf-metadata-only");
    expect(source.accessLevel).toBe("metadata");
  });

  it("routes direct image URLs to the image module via content-type sniffing", async () => {
    const url = "https://example.com/photo.png";
    const fetchImpl = mockFetch({
      [url]: new Response(pngBytes(), { status: 200, headers: { "content-type": "image/png" } }),
    });
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceURL: url,
      sourceKind: "web",
      provider: visionProvider({ caption: "A fetched photo" }),
      fetchImpl,
    });
    expect(source.kind).toBe("web");
    expect(source.metadata.extraction).toBe("image-vision");
    expect(source.text).toBe("A fetched photo");
    expect(source.references[0]).toMatchObject({ url, label: "source" });
  });
});

describe("upload extraction", () => {
  it("routes PDF upload bytes to the PDF module", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "pdf",
      uploadBytes: { bytes: minimalPdfBytes(), contentType: "application/pdf", filename: "paper.pdf" },
    });
    expect(source.kind).toBe("pdf");
    expect(source.metadata.extraction).toBe("unpdf-text");
    expect(source.text).toContain("Hello from upload");
    expect(source.accessLevel).toBe("full");
    expect(source.originalURL).toBeUndefined();
    expect(source.references).toEqual([]);
  });

  it("routes image upload bytes to the image module with a vision provider", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "A note about this image",
      sourceKind: "image",
      provider: visionProvider({ caption: "A sunset over the bay" }),
      uploadBytes: { bytes: pngBytes(), contentType: "image/png" },
    });
    expect(source.kind).toBe("image");
    expect(source.metadata.extraction).toBe("image-vision");
    expect(source.text).toBe("A note about this image\n\nA sunset over the bay");
    expect(source.accessLevel).toBe("partial");
    expect(source.extractionNotes?.join(" ")).toMatch(/no asset store/i);
  });

  it("routes audio upload bytes to the audio module with a transcribing provider", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "podcast",
      provider: transcribingProvider({ text: "Hello and welcome", language: "en" }),
      uploadBytes: { bytes: mp3Bytes(), contentType: "audio/mpeg" },
    });
    expect(source.kind).toBe("podcast");
    expect(source.metadata.extraction).toBe("audio-transcription");
    expect(source.metadata.language).toBe("en");
    expect(source.text).toBe("Hello and welcome");
    expect(source.accessLevel).toBe("full");
  });

  it("keeps a metadata-only envelope for uploaded video", async () => {
    const source = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "video",
      uploadBytes: { bytes: new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, contentType: "video/mp4", filename: "clip.mp4" },
    });
    expect(source.metadata.extraction).toBe("upload-video-metadata");
    expect(source.metadata.filename).toBe("clip.mp4");
    expect(source.accessLevel).toBe("metadata");
    expect(source.extractionNotes?.join(" ")).toMatch(/not extracted yet/i);
  });

  it("keeps an honest envelope when the uploaded file cannot be parsed", async () => {
    const archive = await createSourceExtractor().extract({
      sourceText: "fallback notes",
      sourceKind: "unknown",
      uploadBytes: { bytes: new TextEncoder().encode("not a real archive").buffer as ArrayBuffer, contentType: "application/zip" },
    });
    expect(archive.metadata.extraction).toBe("upload-unparsed");
    expect(archive.text).toBe("fallback notes");
    expect(archive.accessLevel).toBe("partial");
    expect(archive.extractionNotes?.join(" ")).toMatch(/could not be parsed/i);

    // A declared image whose bytes are not an image takes the same honest path.
    const notAnImage = await createSourceExtractor().extract({
      sourceText: "",
      sourceKind: "image",
      uploadBytes: { bytes: new TextEncoder().encode("<html>nope</html>").buffer as ArrayBuffer, contentType: "image/png" },
    });
    expect(notAnImage.metadata.extraction).toBe("upload-unparsed");
    expect(notAnImage.accessLevel).toBe("none");
  });

  it("extracts X/Twitter posts via the fxtwitter tier with real content", async () => {
    const url = "https://x.com/jack/status/20";
    const fx = "https://api.fxtwitter.com/jack/status/20";
    const fetchImpl = mockFetch({
      [fx]: new Response(JSON.stringify({
        code: 200,
        tweet: {
          url,
          text: "just setting up my twttr",
          created_at: "Tue Mar 21 20:50:14 +0000 2006",
          likes: 100,
          retweets: 50,
          author: { name: "Jack Dorsey", screen_name: "jack" },
          media: { photos: [{ url: "https://pbs.twimg.com/media/example.jpg" }] },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "social", fetchImpl });
    expect(source.metadata.extraction).toBe("x-fxtwitter");
    expect(source.accessLevel).toBe("full");
    expect(source.title).toBe("just setting up my twttr");
    expect(source.author).toBe("Jack Dorsey (@jack)");
    expect(source.text).toContain("just setting up my twttr");
    expect(source.assets?.[0]?.url).toBe("https://pbs.twimg.com/media/example.jpg");
    expect(source.depthCap).toBe("tiny");
  });

  it("identifies itself to the fxtwitter API with a User-Agent header", async () => {
    // FxTwitter 401s requests without a User-Agent; Worker subrequests send none by default.
    const url = "https://x.com/jack/status/20";
    const fx = "https://api.fxtwitter.com/jack/status/20";
    let seenUserAgent: string | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      if (String(input) === fx) {
        seenUserAgent = new Headers(init?.headers).get("user-agent");
        return new Response(JSON.stringify({ code: 200, tweet: { text: "just setting up my twttr", author: { screen_name: "jack" } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("missing", { status: 404 });
    };
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "social", fetchImpl });
    expect(source.metadata.extraction).toBe("x-fxtwitter");
    expect(seenUserAgent).toBeTruthy();
  });

  it("marks deleted/private X posts honestly instead of fabricating content", async () => {
    const url = "https://x.com/sama/status/208646866170461671";
    const fx = "https://api.fxtwitter.com/sama/status/208646866170461671";
    const fetchImpl = mockFetch({
      [fx]: new Response(JSON.stringify({ code: 404, message: "NOT_FOUND", tweet: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "social", fetchImpl });
    expect(source.metadata.extraction).toBe("url-only");
    expect(source.metadata.unavailable).toBe("true");
    expect(source.limitations.join(" ")).toMatch(/deleted|unavailable/i);
  });

  it("graduates the social url-only fallback cap with supplied-text volume", async () => {
    const url = "https://www.instagram.com/p/abc123/";
    const fetchImpl = mockFetch({});
    const long = await createSourceExtractor().extract({
      sourceText: "A pasted caption the caller supplied. ".repeat(20),
      sourceURL: url,
      sourceKind: "social",
      fetchImpl,
    });
    expect(long.metadata.extraction).toBe("url-only");
    expect(long.depthCap).toBe("medium");
    const short = await createSourceExtractor().extract({ sourceText: "short note", sourceURL: url, sourceKind: "social", fetchImpl });
    expect(short.depthCap).toBe("light");
    const none = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "social", fetchImpl });
    expect(none.depthCap).toBe("saveOnly");
  });

  it("graduates the YouTube url-only fallback cap with supplied-text volume", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const fetchImpl = mockFetch({ [oembed]: new Response("missing", { status: 404 }) });
    const source = await createSourceExtractor().extract({
      sourceText: "A pasted transcript the caller supplied. ".repeat(20),
      sourceURL: url,
      sourceKind: "youtube",
      fetchImpl,
    });
    expect(source.metadata.extraction).toBe("url-only");
    expect(source.depthCap).toBe("medium");
  });

  it("retries the YouTube video hook through a 429 before succeeding", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    let attempts = 0;
    const flakyProvider = {
      name: "gemini",
      async generateJSON<T>(): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateYouTubeJSON<T>(): Promise<T> {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error("Gemini request failed (429)") as Error & { status: number };
          error.status = 429;
          throw error;
        }
        return { title: "A Video", author: "Channel", transcript: "real words here", summary: "s", claims: [] } as T;
      },
    };
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "youtube", provider: flakyProvider });
    expect(attempts).toBe(2);
    expect(source.title).toBe("A Video");
    expect(source.accessLevel).toBe("full");
  }, 20_000);

  it("lets the yt-dlp sidecar lead YouTube extraction when it returns a transcript", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    const sidecarURL = "https://sidecar.internal";
    const endpoint = `${sidecarURL}/extract?url=${encodeURIComponent(url)}`;
    const fetchImpl = mockFetch({
      [endpoint]: new Response(
        JSON.stringify({
          ok: true,
          title: "Sidecar Video",
          uploader: "Channel One",
          transcript: "real transcript words",
          transcript_source: "subtitles",
          webpage_url: url,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    let geminiCalls = 0;
    const provider = {
      name: "gemini",
      async generateJSON<T>(): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateYouTubeJSON<T>(): Promise<T> {
        geminiCalls += 1;
        throw new Error("the sidecar result should win before this hook runs");
      },
    };
    const source = await createSourceExtractor({ sidecarURL }).extract({ sourceText: "", sourceURL: url, sourceKind: "youtube", provider, fetchImpl });
    expect(geminiCalls).toBe(0);
    expect(source.metadata.extraction).toBe("ytdlp-sidecar");
    expect(source.title).toBe("Sidecar Video");
    expect(source.accessLevel).toBe("full");
  });

  it("runs the Gemini video hook when the sidecar returns nothing", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    // Sidecar configured but unreachable (404) → the video tier resolves undefined.
    const fetchImpl = mockFetch({});
    let geminiCalls = 0;
    const provider = {
      name: "gemini",
      async generateJSON<T>(): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateYouTubeJSON<T>(): Promise<T> {
        geminiCalls += 1;
        return { title: "Gemini Video", author: "Channel", transcript: "real words here", summary: "s", claims: [] } as T;
      },
    };
    const source = await createSourceExtractor({ sidecarURL: "https://sidecar.internal" }).extract({
      sourceText: "",
      sourceURL: url,
      sourceKind: "youtube",
      provider,
      fetchImpl,
    });
    expect(geminiCalls).toBe(1);
    expect(source.metadata.extraction).toBe("gemini-youtube-video-hook");
    expect(source.title).toBe("Gemini Video");
    expect(source.accessLevel).toBe("full");
  });

  it("runs the Gemini video hook when the sidecar returns metadata only", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    const sidecarURL = "https://sidecar.internal";
    const endpoint = `${sidecarURL}/extract?url=${encodeURIComponent(url)}`;
    const fetchImpl = mockFetch({
      [endpoint]: new Response(
        JSON.stringify({ ok: true, title: "Sidecar Video", uploader: "Channel One", webpage_url: url }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    let geminiCalls = 0;
    const provider = {
      name: "gemini",
      async generateJSON<T>(): Promise<T> {
        throw new Error("unreachable in this test");
      },
      async generateYouTubeJSON<T>(): Promise<T> {
        geminiCalls += 1;
        return { title: "Gemini Video", author: "Channel", transcript: "real words here", summary: "s", claims: [] } as T;
      },
    };
    const source = await createSourceExtractor({ sidecarURL }).extract({ sourceText: "", sourceURL: url, sourceKind: "youtube", provider, fetchImpl });
    expect(geminiCalls).toBe(1);
    expect(source.metadata.extraction).toBe("gemini-youtube-video-hook");
    expect(source.accessLevel).toBe("full");
  });

  it("keeps the metadata-only sidecar result when no Gemini hook is configured", async () => {
    const url = "https://www.youtube.com/watch?v=abc123";
    const sidecarURL = "https://sidecar.internal";
    const endpoint = `${sidecarURL}/extract?url=${encodeURIComponent(url)}`;
    const fetchImpl = mockFetch({
      [endpoint]: new Response(
        JSON.stringify({ ok: true, title: "Sidecar Video", uploader: "Channel One", webpage_url: url }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    const source = await createSourceExtractor({ sidecarURL }).extract({ sourceText: "", sourceURL: url, sourceKind: "youtube", fetchImpl });
    expect(source.metadata.extraction).toBe("ytdlp-sidecar");
    expect(source.title).toBe("Sidecar Video");
    expect(source.accessLevel).toBe("metadata");
    expect(source.extractionNotes?.join(" ")).toMatch(/No Gemini YouTube extraction provider configured/);
    expect(source.extractionNotes?.join(" ")).toMatch(/No subtitles available/);
  });

  it("routes image URLs when HEAD is refused (405) by probing with a ranged GET", async () => {
    const url = "https://images.example.com/photo";
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchImpl: FetchLike = async (_input, init) => {
      if (init?.method === "HEAD") return new Response("method not allowed", { status: 405 });
      return new Response(pngBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
    };
    const source = await createSourceExtractor().extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.metadata.extraction).toMatch(/^image/);
    expect(source.kind).toBe("web");
  });

  it("escalates to the reader-service tier when the page fetch is thin and the service returns rich text", async () => {
    const url = "https://hard-site.example.com/article";
    const readerURL = `https://r.jina.ai/${url}`;
    const thinHTML = '<html><head><title>Stub</title></head><body><p>tiny</p></body></html>';
    const richReader = `Title: Real Article\n\nURL Source: ${url}\n\nMarkdown Content:\n${"Substantive content paragraph. ".repeat(60)}`;
    const fetchImpl: FetchLike = async (input) => {
      const target = String(input);
      if (target === readerURL) {
        return new Response(richReader, { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response(thinHTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const source = await createSourceExtractor({ jinaApiKey: "test-key" }).extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.metadata.extraction).toBe("reader-service");
    expect(source.title).toBe("Real Article");
    expect(source.accessLevel).toBe("full");
  });

  it("does not use the reader service when it returns a challenge page", async () => {
    const url = "https://hard-site.example.com/blocked";
    const readerURL = `https://r.jina.ai/${url}`;
    const thinHTML = '<html><head><title>Stub</title></head><body><p>tiny</p></body></html>';
    const challenge = `Title: Just a moment...\n\nURL Source: ${url}\n\nWarning: Target URL returned error 403: Forbidden\n\nMarkdown Content:\n`;
    const fetchImpl: FetchLike = async (input) => {
      const target = String(input);
      if (target === readerURL) return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
      return new Response(thinHTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const source = await createSourceExtractor({ jinaApiKey: "test-key" }).extract({ sourceText: "", sourceURL: url, sourceKind: "web", fetchImpl });
    expect(source.metadata.extraction).not.toBe("reader-service");
  });
});
