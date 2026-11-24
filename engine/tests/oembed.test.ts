import { describe, expect, it } from "vitest";
import { discoverOEmbedEndpoint, fetchOEmbedFromHTML } from "../src/extract/oembed";
import type { FetchLike } from "../src/types";

const PAGE_URL = "https://embed.example.com/items/42";
const HTML = `<html><head>
<link rel="alternate" type="application/json+oembed" href="/oembed?format=json">
</head><body>Item</body></html>`;

function response(body: string, contentType = "application/json"): Response {
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

describe("generic JSON oEmbed extraction", () => {
  it("discovers a relative endpoint and supplies the source URL and JSON format", () => {
    expect(discoverOEmbedEndpoint(HTML, PAGE_URL)).toBe(
      "https://embed.example.com/oembed?format=json&url=https%3A%2F%2Fembed.example.com%2Fitems%2F42",
    );
  });

  it("keeps an absolute endpoint's existing query and preserves provider HTML verbatim", async () => {
    const endpoint = "https://provider.example/oembed?url=already%2Fencoded";
    const html = `<link type="Application/JSON+oEmbed; charset=utf-8" href="${endpoint}">`;
    const providerHTML = '<iframe src="https://provider.example/embed/42?x=1&amp;y=2" width="640" height="360"></iframe>\n';
    const fetchImpl: FetchLike = async (input) => {
      expect(String(input)).toBe(`${endpoint}&format=json`);
      return response(JSON.stringify({
        type: "rich",
        version: "1.0",
        title: "An embedded item",
        author_name: "A creator",
        author_url: "/creators/a",
        provider_name: "Provider",
        provider_url: "https://provider.example",
        cache_age: 3600,
        thumbnail_url: "https://cdn.example/image.jpg",
        thumbnail_width: 640,
        thumbnail_height: 360,
        html: providerHTML,
        width: 640,
        height: 360,
      }));
    };

    const result = await fetchOEmbedFromHTML(html, PAGE_URL, fetchImpl, 1_000);
    expect(result?.endpoint).toBe(`${endpoint}&format=json`);
    expect(result?.metadata).toEqual({
      type: "rich",
      version: "1.0",
      title: "An embedded item",
      authorName: "A creator",
      authorURL: "https://provider.example/creators/a",
      providerName: "Provider",
      providerURL: "https://provider.example/",
      cacheAge: "3600",
      thumbnailURL: "https://cdn.example/image.jpg",
      thumbnailWidth: 640,
      thumbnailHeight: 360,
      html: providerHTML,
      width: 640,
      height: 360,
    });
  });

  it("falls through for missing, failed, malformed, and non-object responses", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (input) => {
      calls.push(String(input));
      return response("not json");
    };
    expect(await fetchOEmbedFromHTML("<html></html>", PAGE_URL, fetchImpl, 1_000)).toBeUndefined();
    expect(calls).toEqual([]);

    const failed: FetchLike = async () => new Response("no", { status: 404 });
    expect(await fetchOEmbedFromHTML(HTML, PAGE_URL, failed, 1_000)).toBeUndefined();

    const malformed: FetchLike = async () => response("[]");
    expect(await fetchOEmbedFromHTML(HTML, PAGE_URL, malformed, 1_000)).toBeUndefined();

    const missingRequiredFields: FetchLike = async () => response(JSON.stringify({ title: "not enough" }));
    expect(await fetchOEmbedFromHTML(HTML, PAGE_URL, missingRequiredFields, 1_000)).toBeUndefined();
  });
});
