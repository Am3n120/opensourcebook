import { describe, expect, it } from "vitest";
import {
  AssetStore,
  assetPathForId,
  assetURLFromPath,
  createNullAssetStore,
  isAssetPath,
} from "../src/assets";
import { verifyPayloadURLs } from "../src/verify";
import { byteRange, getAsset } from "../src/routes/media";
import type { EngineDeps } from "../src/wiring";
import type { PagePayload, R2BucketLike } from "../src/types";

interface StoredObject {
  bytes: ArrayBuffer;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();

  /** Every get, with the range it asked for, so a test can see what was read. */
  readonly reads: Array<{ key: string; range?: { offset: number; length: number } }> = [];

  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    this.reads.push({ key, ...(options?.range ? { range: options.range } : {}) });
    const object = this.objects.get(key);
    if (!object) return null;
    const range = options?.range;
    const bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes.slice(0);
    return {
      key,
      size: object.bytes.byteLength,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      body: new Response(bytes).body!,
      arrayBuffer: async () => bytes.slice(0),
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


const baseByte: PagePayload = {
  id: "8f4c0b7e-2a3d-4e5f-9a1b-7c6d5e4f3a2b",
  type: "paper",
  title: "Asset-backed byte",
  subtitle: "Test source",
  timeAgo: "just now",
  tags: [],
  status: { type: "ready" },
  blocks: [],
  byteDepth: "medium",
};

describe("AssetStore", () => {
  it("stores bytes content-addressed and roundtrips them with metadata", async () => {
    const bucket = new FakeR2Bucket();
    const store = new AssetStore(bucket);
    const ref = await store.putAsset(new TextEncoder().encode("figure-bytes"), {
      kind: "figure",
      sourceURL: "https://example.com/paper.pdf",
      caption: "System overview",
      page: 12,
      contentType: "image/png",
    });
    expect(ref).toBeDefined();
    expect(ref!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(ref!.url).toBe(`/v1/assets/${ref!.id}`);
    expect(ref!.kind).toBe("figure");
    expect(ref!.page).toBe(12);
    expect(ref!.contentType).toBe("image/png");

    const stored = bucket.objects.get(`assets/${ref!.id}`);
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored!.bytes)).toBe("figure-bytes");
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect(stored!.customMetadata).toMatchObject({
      kind: "figure",
      sourceURL: "https://example.com/paper.pdf",
      caption: "System overview",
      page: "12",
    });

    const object = await bucket.get(`assets/${ref!.id}`);
    expect(new TextDecoder().decode(await object!.arrayBuffer())).toBe("figure-bytes");
  });

  it("derives deterministic ids from the bytes", async () => {
    const store = new AssetStore(new FakeR2Bucket());
    const first = await store.putAsset(new TextEncoder().encode("same"), { kind: "image" });
    const second = await store.putAsset(new TextEncoder().encode("same"), { kind: "image" });
    const different = await store.putAsset(new TextEncoder().encode("other"), { kind: "image" });
    expect(first!.id).toBe(second!.id);
    expect(different!.id).not.toBe(first!.id);
    expect(first!.contentType).toBe("application/octet-stream");
  });

  it("maps stored metadata back through headAsset", async () => {
    const bucket = new FakeR2Bucket();
    const store = new AssetStore(bucket);
    const ref = await store.putAsset(new TextEncoder().encode("frame"), {
      kind: "frame",
      sourceURL: "https://youtube.com/watch?v=x",
      timestampMs: 83_000,
      contentType: "image/jpeg",
    });
    const head = await store.headAsset(ref!.id);
    expect(head).toMatchObject({
      id: ref!.id,
      kind: "frame",
      url: ref!.url,
      sourceURL: "https://youtube.com/watch?v=x",
      timestampMs: 83_000,
      contentType: "image/jpeg",
    });
    await expect(store.headAsset("missing")).resolves.toBeUndefined();
  });

  it("degrades to undefined when no bucket is bound", async () => {
    const store = createNullAssetStore();
    await expect(store.putAsset(new TextEncoder().encode("x"), { kind: "image" })).resolves.toBeUndefined();
    await expect(store.headAsset("anything")).resolves.toBeUndefined();
  });
});

describe("asset path helpers", () => {
  it("matches only worker-relative asset paths", () => {
    expect(isAssetPath("/v1/assets/9f2cAb.-_~")).toBe(true);
    expect(isAssetPath(assetPathForId("abc123"))).toBe(true);
    expect(isAssetPath("/v1/assets/")).toBe(false);
    expect(isAssetPath("/v1/assets/a/b")).toBe(false);
    expect(isAssetPath("/v1/assets/a b")).toBe(false);
    expect(isAssetPath("https://cdn.example.com/v1/assets/abc")).toBe(false);
    expect(isAssetPath("/v1/jobs/abc")).toBe(false);
  });

  it("resolves asset paths against an optional public base URL", () => {
    expect(assetURLFromPath("/v1/assets/abc")).toBe("/v1/assets/abc");
    expect(assetURLFromPath("/v1/assets/abc", "https://engine.example.com/")).toBe("https://engine.example.com/v1/assets/abc");
    expect(assetURLFromPath("https://example.com/x.png", "https://engine.example.com")).toBeUndefined();
  });
});

describe("asset URLs in verification", () => {
  it("passes worker-relative asset paths without any network fetch", async () => {
    let fetches = 0;
    const fetchImpl = async () => {
      fetches += 1;
      return new Response(null, { status: 200 });
    };
    const report = await verifyPayloadURLs({
      ...baseByte,
      blocks: [
        { type: "figure", url: "/v1/assets/abc123", caption: "Figure" },
        { type: "gallery", images: [{ url: "/v1/assets/a" }, { url: "/v1/assets/b" }] },
        { type: "clip", url: "/v1/assets/clip1", startSeconds: 0, posterURL: "/v1/assets/poster" },
      ],
    }, { fetchImpl });
    expect(fetches).toBe(0);
    expect(report.checked).toHaveLength(5);
    expect(report.failures).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.mediaChecked).toBe(3);
  });
});

describe("byte ranges of an asset", () => {
  it("reads one range, open ends and suffixes, and ignores what it does not handle", () => {
    expect(byteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(byteRange("bytes=0-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=0-1,5-9", 1000)).toBe("ignore");
    expect(byteRange("items=0-1", 1000)).toBe("ignore");
  });
});

describe("an asset opened by its address", () => {
  async function served(contentType: string, range?: string) {
    const bucket = new FakeR2Bucket();
    const ref = await new AssetStore(bucket).putAsset(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), { kind: "image", contentType });
    return getAsset(ref!.id, { bucket } as unknown as EngineDeps, range);
  }

  it("is never sniffed and may run or load nothing, whole or one range of it", async () => {
    for (const response of [await served("image/png"), await served("image/png", "bytes=0-3")]) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
      expect(response.headers.get("content-disposition")).toBeNull();
    }
  });

  it("is a download when it is an SVG or any type a browser would open as a page; pictures, sound and video show in place", async () => {
    for (const type of ["image/svg+xml", "image/svg+xml; charset=utf-8", "text/html", "application/octet-stream", "image/x-icon"]) {
      expect((await served(type)).headers.get("content-disposition"), type).toBe("attachment");
    }
    for (const type of ["image/jpeg", "image/webp", "audio/mpeg", "video/mp4"]) {
      expect((await served(type)).headers.get("content-disposition"), type).toBeNull();
    }
  });
});

describe("a video asset read in ranges", () => {
  const size = 1000;
  async function setUp() {
    const bucket = new FakeR2Bucket();
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const ref = await new AssetStore(bucket).putAsset(bytes, { kind: "video", contentType: "video/mp4" });
    bucket.reads.length = 0;
    const get = (range?: string) => getAsset(ref!.id, { bucket } as unknown as EngineDeps, range);
    return { bucket, bytes, get };
  }

  it("sends the whole file with its length when no range is asked", async () => {
    const { bucket, bytes, get } = await setUp();
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(bucket.reads).toEqual([{ key: bucket.reads[0]!.key }]);
  });

  it("asks storage for only the bytes of a closed range", async () => {
    const { bucket, bytes, get } = await setUp();
    const response = await get("bytes=100-199");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect(response.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(100, 200));
    expect(bucket.reads.map((read) => read.range)).toEqual([{ offset: 100, length: 100 }]);
  });

  it("sends the rest of the file for an open range, read from that byte on", async () => {
    const { bucket, bytes, get } = await setUp();
    const response = await get("bytes=900-");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 900-999/${size}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(900));
    expect(bucket.reads.map((read) => read.range)).toEqual([{ offset: 900, length: 100 }]);
  });

  it("sends the last bytes for a suffix range", async () => {
    const { bucket, bytes, get } = await setUp();
    const response = await get("bytes=-50");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 950-999/${size}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(950));
    expect(bucket.reads.map((read) => read.range)).toEqual([{ offset: 950, length: 50 }]);
  });

  it("answers 416 with the size, and reads nothing, for a range past the end", async () => {
    const { bucket, get } = await setUp();
    const response = await get(`bytes=${size}-`);
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bucket.reads).toEqual([]);
  });

  it("is not found when there is no such asset", async () => {
    const response = await getAsset("missing", { bucket: new FakeR2Bucket() } as unknown as EngineDeps, "bytes=0-1");
    expect(response.status).toBe(404);
  });
});
