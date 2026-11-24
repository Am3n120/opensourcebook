import { describe, expect, it } from "vitest";
import { AssetStore, isAssetPath } from "../src/assets";
import { extractVideoModule } from "../src/extract/video";
import type { FetchLike, R2BucketLike } from "../src/types";

const VIDEO_URL = "https://www.youtube.com/watch?v=abc123";
const SIDECAR_URL = "https://sidecar.internal";
const ENDPOINT = `${SIDECAR_URL}/extract?url=${encodeURIComponent(VIDEO_URL)}`;
const THUMBNAIL_URL = "https://i.ytimg.com/vi/abc123/hqdefault.jpg";

interface StoredObject {
  bytes: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();

  async get() {
    return null;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ) {
    const bytes = value instanceof ArrayBuffer ? value : new TextEncoder().encode(String(value)).buffer as ArrayBuffer;
    this.objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    return { key };
  }

  async head() {
    return null;
  }
}

function mockFetch(routes: Record<string, Response>): FetchLike {
  return async (input) => routes[String(input)] ?? new Response("missing", { status: 404 });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sidecarPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    title: "A real video",
    uploader: "Channel One",
    duration_seconds: 3725,
    webpage_url: VIDEO_URL,
    extractor: "Youtube",
    description: "A description of the video.",
    transcript: "word ".repeat(200).trim(),
    transcript_source: "subtitles",
    thumbnail: THUMBNAIL_URL,
    chapters: [
      { title: "Intro", start_time: 0, end_time: 61 },
      { title: "Main segment", start_time: 61 },
    ],
    storyboard_urls: [],
    ...overrides,
  };
}

function baseInput(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}) {
  return {
    url: VIDEO_URL,
    sourceText: "",
    fetchImpl,
    sidecarURL: SIDECAR_URL,
    timeoutMs: 1_000,
    maxTextChars: 24_000,
    sidecarRetryDelayMs: 5,
    ...overrides,
  };
}

describe("video module extraction", () => {
  it("returns undefined without calling the network when no sidecar is configured", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response("nope", { status: 500 });
    };
    const result = await extractVideoModule(baseInput(fetchImpl, { sidecarURL: undefined }));
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it("maps a full sidecar payload with transcript into a module extraction", async () => {
    const fetchImpl = mockFetch({ [ENDPOINT]: jsonResponse(sidecarPayload()) });
    const result = await extractVideoModule(baseInput(fetchImpl));
    expect(result).toBeDefined();
    expect(result?.title).toBe("A real video");
    expect(result?.author).toBe("Channel One");
    expect(result?.canonicalURL).toBe("https://www.youtube.com/watch?v=abc123");
    expect(result?.text).toContain("word word");
    expect(result?.text).toContain("A description of the video.");
    expect(result?.excerpt).toBe("A description of the video.");
    expect(result?.accessLevel).toBe("full");
    expect(result?.depthCap).toBe("deep");
    expect(result?.metadata?.extraction).toBe("ytdlp-sidecar");
    expect(result?.metadata?.extractor).toBe("Youtube");
    expect(result?.metadata?.durationText).toBe("1:02:05");
    expect(result?.metadata?.chapterCount).toBe("2");
    expect(JSON.parse(result?.metadata?.chapters ?? "[]")).toHaveLength(2);
    expect(result?.references).toEqual([
      { url: "https://www.youtube.com/watch?v=abc123", title: "A real video", domain: "www.youtube.com", label: "source" },
    ]);
    expect(result?.extractionNotes?.join(" ")).not.toMatch(/no subtitles/i);
  });

  it("sends the configured bearer token to the sidecar", async () => {
    let authorization: string | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get("authorization") ?? undefined;
      return jsonResponse(sidecarPayload());
    };
    const result = await extractVideoModule(baseInput(fetchImpl, { sidecarToken: "secret-token" }));
    expect(result).toBeDefined();
    expect(authorization).toBe("Bearer secret-token");
  });

  it("caps depth at veryDeep for long transcripts", async () => {
    const payload = sidecarPayload({ transcript: "word ".repeat(1_000).trim() });
    const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: jsonResponse(payload) })));
    expect(result?.depthCap).toBe("veryDeep");
    expect(result?.accessLevel).toBe("full");
  });

  it("drops to light with description only and no transcript", async () => {
    const payload = sidecarPayload({ transcript: "", transcript_source: "none" });
    const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: jsonResponse(payload) })));
    expect(result?.depthCap).toBe("light");
    expect(result?.accessLevel).toBe("metadata");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no subtitles/i);
  });

  it("drops to tiny with metadata only", async () => {
    const payload = sidecarPayload({ transcript: "", description: "", transcript_source: "none" });
    const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: jsonResponse(payload) })));
    expect(result?.depthCap).toBe("tiny");
    expect(result?.accessLevel).toBe("metadata");
    expect(result?.text).toBeUndefined();
    expect(result?.excerpt).toBeUndefined();
  });

  it("flags auto-generated transcripts honestly", async () => {
    const payload = sidecarPayload({ transcript_source: "automatic" });
    const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: jsonResponse(payload) })));
    expect(result?.extractionNotes?.join(" ")).toMatch(/auto-generated/i);
  });

  it("returns undefined when the sidecar reports an error or rejects", async () => {
    for (const response of [
      jsonResponse({ ok: false, error: "invalid token" }, 401),
      jsonResponse({ ok: false, error: "login required" }, 422),
      jsonResponse({ ok: false, error: "video gone" }, 404),
      jsonResponse({ ok: true }, 200),
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]) {
      const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: response })));
      expect(result).toBeUndefined();
    }
  });

  it("returns undefined when the sidecar times out", async () => {
    const fetchImpl: FetchLike = (_input, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
      });
    const result = await extractVideoModule(baseInput(fetchImpl, { timeoutMs: 25 }));
    expect(result).toBeUndefined();
  });

  it("retries a transient sidecar failure once and returns the warm retry", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ ok: false, error: "container starting" }, 502);
      return jsonResponse(sidecarPayload());
    };
    const result = await extractVideoModule(baseInput(fetchImpl));
    expect(result?.metadata?.extraction).toBe("ytdlp-sidecar");
    expect(calls).toBe(2);
  });

  it("retries a timed-out sidecar call once", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = (_input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
        });
      }
      return Promise.resolve(jsonResponse(sidecarPayload()));
    };
    const result = await extractVideoModule(baseInput(fetchImpl, { timeoutMs: 25 }));
    expect(result?.metadata?.extraction).toBe("ytdlp-sidecar");
    expect(calls).toBe(2);
  });

  it("does not retry permanent sidecar answers", async () => {
    for (const status of [401, 404, 422]) {
      let calls = 0;
      const fetchImpl: FetchLike = async () => {
        calls += 1;
        return jsonResponse({ ok: false, error: "permanent" }, status);
      };
      const result = await extractVideoModule(baseInput(fetchImpl));
      expect(result).toBeUndefined();
      expect(calls).toBe(1);
    }
  });

  it("gives up after one retry when the sidecar stays unavailable", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse({ ok: false, error: "upstream failure" }, 502);
    };
    const result = await extractVideoModule(baseInput(fetchImpl));
    expect(result).toBeUndefined();
    expect(calls).toBe(2);
  });

  it("maps the thumbnail as a remote asset reference without an asset store", async () => {
    const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: jsonResponse(sidecarPayload()) })));
    expect(result?.assets).toHaveLength(1);
    const asset = result?.assets?.[0];
    expect(asset?.kind).toBe("thumbnail");
    expect(asset?.url).toBe(THUMBNAIL_URL);
    expect(asset?.sourceURL).toBe(THUMBNAIL_URL);
    expect(isAssetPath(asset?.url ?? "")).toBe(false);
  });

  it("stores the thumbnail in the asset store when one is provided", async () => {
    const bucket = new FakeR2Bucket();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
    const fetchImpl = mockFetch({
      [ENDPOINT]: jsonResponse(sidecarPayload()),
      [THUMBNAIL_URL]: new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    });
    const result = await extractVideoModule(baseInput(fetchImpl, { assetStore: new AssetStore(bucket) }));
    const asset = result?.assets?.[0];
    expect(asset?.kind).toBe("thumbnail");
    expect(asset?.url).toMatch(/^\/v1\/assets\//);
    expect(asset?.sourceURL).toBe(THUMBNAIL_URL);
    expect(asset?.contentType).toBe("image/png");
    expect(bucket.objects.size).toBe(1);
  });

  it("requests chapter frames and persists them as timestamped R2 assets", async () => {
    const bucket = new FakeR2Bucket();
    const frameBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const frameEndpoint = `${SIDECAR_URL}/frames`;
    let frameRequest: { url?: string; timestamps_ms?: number[] } | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url === ENDPOINT) return jsonResponse(sidecarPayload());
      if (url === THUMBNAIL_URL) return new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/jpeg" } });
      if (url === frameEndpoint) {
        frameRequest = JSON.parse(String(init?.body)) as { url?: string; timestamps_ms?: number[] };
        return jsonResponse({
          ok: true,
          frames: [
            { timestamp_ms: 0, content_type: "image/jpeg", data_base64: btoa(String.fromCharCode(...frameBytes)), width: 640, height: 360 },
            { timestamp_ms: 61000, content_type: "image/jpeg", data_base64: btoa(String.fromCharCode(...frameBytes)), width: 640, height: 360 },
          ],
        });
      }
      return new Response("missing", { status: 404 });
    };
    const result = await extractVideoModule(baseInput(fetchImpl, { assetStore: new AssetStore(bucket) }));
    expect(frameRequest).toEqual({ url: VIDEO_URL, timestamps_ms: [0, 61000] });
    expect(result?.assets?.filter((asset) => asset.kind === "frame")).toHaveLength(2);
    expect(result?.assets?.find((asset) => asset.kind === "frame" && asset.timestampMs === 61000)?.url).toMatch(/^\/v1\/assets\//);
    // The two identical fixture frames are content-addressed and dedupe to one R2 object.
    expect(bucket.objects.size).toBe(2);
  });

  it("falls back to a remote thumbnail reference when the download is too large", async () => {
    const bucket = new FakeR2Bucket();
    const oversized = new ArrayBuffer(2_500_000);
    const fetchImpl = mockFetch({
      [ENDPOINT]: jsonResponse(sidecarPayload()),
      [THUMBNAIL_URL]: new Response(oversized, { status: 200, headers: { "content-type": "image/jpeg" } }),
    });
    const result = await extractVideoModule(baseInput(fetchImpl, { assetStore: new AssetStore(bucket) }));
    const asset = result?.assets?.[0];
    expect(asset?.kind).toBe("thumbnail");
    expect(asset?.url).toBe(THUMBNAIL_URL);
    expect(bucket.objects.size).toBe(0);
  });

  it("omits assets when the payload has no usable thumbnail", async () => {
    const payload = sidecarPayload({ thumbnail: "not-a-url" });
    const result = await extractVideoModule(baseInput(mockFetch({ [ENDPOINT]: jsonResponse(payload) })));
    expect(result).toBeDefined();
    expect(result?.assets).toBeUndefined();
  });
});
