import { describe, expect, it } from "vitest";
import { URLVerifier, verifyPayloadURLs } from "../src/verify";
import type { PagePayload, FetchLike } from "../src/types";

const baseByte: PagePayload = {
  id: "8f4c0b7e-2a3d-4e5f-9a1b-7c6d5e4f3a2b",
  type: "article",
  title: "Verified links",
  subtitle: "Test source",
  timeAgo: "just now",
  tags: [],
  status: { type: "ready" },
  blocks: [],
  byteDepth: "medium",
};

describe("URL verification", () => {
  it("uses bounded concurrency and HEAD/GET fallback with media checks", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchImpl: FetchLike = async (input, init) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "HEAD" && url.includes("fallback")) return new Response(null, { status: 405 });
      if (url.includes("image")) return new Response(null, { status: 200, headers: { "content-type": "image/png" } });
      if (url.includes("audio")) return new Response(null, { status: 200, headers: { "content-type": "audio/mpeg" } });
      return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    };

    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "linkCard", url: "https://example.com/fallback", title: "Fallback", domain: "example.com" },
        { type: "linkCard", url: "https://example.com/ok", title: "OK", domain: "example.com" },
        { type: "image", url: "https://cdn.example.com/image.png", caption: "Image", systemIcon: "photo" },
        { type: "audio", url: "https://cdn.example.com/audio.mp3", title: "Audio" },
      ],
    }, { fetchImpl, maxConcurrency: 2 });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(report.valid).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.checked.some((entry) => entry.method === "GET" && entry.url.includes("fallback"))).toBe(true);
    expect(report.mediaChecked).toBe(2);
  });

  it("validates YouTube through oEmbed and rejects inconsistent charts", async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes("youtube.com/oembed")) {
        return new Response(JSON.stringify({ title: "Real video" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 200 });
    };

    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "video", youtubeID: "dQw4w9WgXcQ", title: "Real video" },
        {
          type: "lineChart",
          xLabels: ["A", "B"],
          series: [{ name: "Series", values: [1, Number.NaN], color: "primary" }],
        },
      ],
    }, { fetchImpl });

    expect(report.checked[0]).toMatchObject({ method: "oEmbed", ok: true });
    expect(report.chartErrors.length).toBeGreaterThan(0);
    expect(report.valid).toBe(false);
  });

  it("keeps an inaccessible original source as a warning while failing a dead supplemental URL", async () => {
    const sourceURL = "https://neal.fun/size-of-space/";
    const supplementalURL = "https://supplemental.example/dead";
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      return new Response(null, { status: url === sourceURL ? 403 : 404 });
    };

    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "linkCard", url: sourceURL, title: "Original source", domain: "neal.fun" },
        { type: "linkCard", url: supplementalURL, title: "Supplemental", domain: "supplemental.example" },
      ],
    }, { fetchImpl, warningURLs: [sourceURL] });

    expect(report.checked).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: sourceURL, ok: false, status: 403 }),
      expect.objectContaining({ url: supplementalURL, ok: false, status: 404 }),
    ]));
    expect(report.failures).toEqual([expect.objectContaining({ url: supplementalURL, ok: false, status: 404 })]);
    expect(report.warnings.some((warning) => warning.includes(sourceURL) && warning.includes("403"))).toBe(true);
    expect(report.valid).toBe(false);
  });
});

function recordingFetch(respond: (url: string, method: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; range?: string }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    calls.push({ url, method, ...(range ? { range } : {}) });
    return respond(url, method);
  };
  return { fetchImpl, calls };
}

describe("URL verification: requests", () => {
  it("stops at HEAD when HEAD succeeds with a fitting content type", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200, headers: { "content-type": "image/jpeg" } }));
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [{ type: "figure", url: "https://cdn.example.com/f.jpg" }],
    }, { fetchImpl });
    expect(calls).toEqual([{ url: "https://cdn.example.com/f.jpg", method: "HEAD" }]);
    expect(report.checked[0]).toMatchObject({ ok: true, method: "HEAD", status: 200, contentType: "image/jpeg" });
  });

  it("falls back to a ranged GET when HEAD reports the wrong media type", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, method) =>
      method === "HEAD"
        ? new Response(null, { status: 200, headers: { "content-type": "text/html" } })
        : new Response(null, { status: 206, headers: { "content-type": "image/webp" } }),
    );
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [{ type: "image", url: "https://cdn.example.com/i", systemIcon: "photo" }],
    }, { fetchImpl });
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "GET"]);
    expect(calls[1].range).toBe("bytes=0-2048");
    expect(report.checked[0]).toMatchObject({ ok: true, method: "GET", status: 206 });
  });

  it("fails media that is served as something else on both requests", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "figure", url: "https://cdn.example.com/login-wall" },
        { type: "audio", url: "https://cdn.example.com/podcast", title: "Episode" },
      ],
    }, { fetchImpl });
    expect(report.valid).toBe(false);
    expect(report.failures).toEqual([
      expect.objectContaining({ url: "https://cdn.example.com/login-wall", error: "Expected image media but received text/html" }),
      expect.objectContaining({ url: "https://cdn.example.com/podcast", error: "Expected audio media but received text/html" }),
    ]);
  });

  it("accepts audio served as video and media with no content type", async () => {
    const { fetchImpl } = recordingFetch((url) =>
      url.endsWith("mp4")
        ? new Response(null, { status: 200, headers: { "content-type": "video/mp4" } })
        : new Response(null, { status: 200 }),
    );
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "audio", url: "https://cdn.example.com/a.mp4", title: "Audio track" },
        { type: "figure", url: "https://cdn.example.com/untyped" },
      ],
    }, { fetchImpl });
    expect(report.valid).toBe(true);
  });

  it("reports network errors and timeouts as failures, not exceptions", async () => {
    const fetchImpl: FetchLike = (input, init) => {
      if (String(input).includes("throws")) return Promise.reject(new TypeError("fetch failed"));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "linkCard", url: "https://throws.example.com/", title: "Throws", domain: "throws.example.com" },
        { type: "linkCard", url: "https://hangs.example.com/", title: "Hangs", domain: "hangs.example.com" },
      ],
    }, { fetchImpl, timeoutMs: 10 });
    expect(report.failures).toHaveLength(2);
    for (const failure of report.failures) {
      expect(failure).toMatchObject({ ok: false, error: "URL request failed or timed out" });
      expect(failure.method).toBeUndefined();
    }
  });

  it("reports the GET status when both requests return errors", async () => {
    const { fetchImpl } = recordingFetch((_url, method) => new Response(null, { status: method === "HEAD" ? 405 : 410 }));
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [{ type: "linkCard", url: "https://gone.example.com/", title: "Gone", domain: "gone.example.com" }],
    }, { fetchImpl });
    expect(report.failures[0]).toMatchObject({ method: "GET", status: 410, error: "URL returned a non-success response" });
  });

  it("fails a YouTube video whose oEmbed lookup is refused", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response("Not Found", { status: 404 }));
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [{ type: "video", youtubeID: "removed123" }],
    }, { fetchImpl });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://www.youtube.com/oembed?url=");
    expect(calls[0].url).toContain(encodeURIComponent("https://www.youtube.com/watch?v=removed123"));
    expect(report.failures[0]).toMatchObject({ ok: false, method: "oEmbed", error: "YouTube oEmbed did not return metadata" });
  });
});

describe("URL verification: collection and bounds", () => {
  it("checks a URL once however many blocks use it, including inside reveals", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200, headers: { "content-type": "image/png" } }));
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "figure", url: "https://cdn.example.com/same.png" },
        {
          type: "reveal",
          title: "More",
          blocks: [
            { type: "figure", url: "https://cdn.example.com/same.png" },
            { type: "gallery", images: [{ url: "https://cdn.example.com/g.png" }] },
          ],
        },
      ],
    }, { fetchImpl });
    expect(calls.map((call) => call.url)).toEqual(["https://cdn.example.com/same.png", "https://cdn.example.com/g.png"]);
    expect(report.checked).toHaveLength(2);
    expect(report.mediaChecked).toBe(3);
  });

  it("checks at most maxURLs and warns about the rest", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
    const blocks = Array.from({ length: 6 }, (_, index) => ({
      type: "linkCard" as const,
      url: `https://example.com/${index}`,
      title: `Link ${index}`,
      domain: "example.com",
    }));
    const report = await verifyPayloadURLs({ ...baseByte, blocks }, { fetchImpl, maxURLs: 4 });
    expect(calls).toHaveLength(4);
    expect(report.checked.map((entry) => entry.url)).toEqual(blocks.slice(0, 4).map((block) => block.url));
    expect(report.warnings).toContain("URL verification bounded at 4 URLs");
    expect(report.valid).toBe(true);
  });

  it("makes no requests for a byte without links or media", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 200 }));
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [{ type: "image", systemIcon: "photo" }],
    }, { fetchImpl });
    expect(calls).toHaveLength(0);
    expect(report).toMatchObject({ checked: [], failures: [], warnings: [], valid: true, mediaChecked: 1 });
  });
});

describe("URL verification: charts", () => {
  const okFetch: FetchLike = async () => new Response(null, { status: 200 });

  it("flags empty charts, length mismatches and non-finite bars with their paths", async () => {
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "lineChart", xLabels: [], series: [] },
        { type: "lineChart", xLabels: ["A", "B", "C"], series: [{ name: "Short", values: [1, 2], color: "primary" }] },
        { type: "barChart", items: [] },
        {
          type: "reveal",
          title: "Nested",
          blocks: [{ type: "barChart", items: [{ label: "x", value: Number.POSITIVE_INFINITY, displayValue: "inf" }] }],
        },
      ],
    }, { fetchImpl: okFetch });
    expect(report.chartErrors).toEqual([
      "$.blocks[0]: lineChart has no data",
      "$.blocks[1]: series 'Short' length does not match xLabels",
      "$.blocks[2]: barChart has no data",
      "$.blocks[3].blocks[0]: barChart contains a non-finite value",
    ]);
    expect(report.warnings).toContain("One or more charts failed finite/consistent data checks");
    expect(report.valid).toBe(false);
  });

  it("passes well-formed charts", async () => {
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "lineChart", xLabels: ["A", "B"], series: [{ name: "S", values: [1, 2], color: "primary" }] },
        { type: "barChart", items: [{ label: "x", value: 3, displayValue: "3" }] },
      ],
    }, { fetchImpl: okFetch });
    expect(report.chartErrors).toEqual([]);
    expect(report.valid).toBe(true);
  });
});

describe("URLVerifier", () => {
  it("applies constructor defaults and lets a call override them", async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 403 }));
    const verifier = new URLVerifier({ fetchImpl, maxURLs: 1 });
    const blocks = [
      { type: "linkCard" as const, url: "https://source.example.com/", title: "Source", domain: "source.example.com" },
      { type: "linkCard" as const, url: "https://other.example.com/", title: "Other", domain: "other.example.com" },
    ];
    const first = await verifier.verify({ ...baseByte, blocks });
    expect(first.checked).toHaveLength(1);
    expect(first.valid).toBe(false);

    const second = await verifier.verify({ ...baseByte, blocks }, { warningURLs: ["https://source.example.com"] });
    expect(second.failures).toEqual([]);
    expect(second.valid).toBe(true);
    expect(calls.length).toBe(4);
  });
});
