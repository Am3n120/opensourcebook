import { describe, expect, it } from "vitest";
import { AssetStore, isAssetPath } from "../src/assets";
import {
  extractAudioModule,
  type AudioTranscribingProvider,
  type AudioTranscription,
  type ExtractAudioInput,
} from "../src/extract/audio";
import {
  extractImageModule,
  type ExtractImageInput,
  type ImageDescribingProvider,
  type ImageDescription,
} from "../src/extract/image";
import type { FetchLike, R2BucketLike, StructuredGenerationRequest, StructuredProvider } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures. Tiny byte buffers whose leading magic identifies the media type.
// ---------------------------------------------------------------------------

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(72);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 17) % 256;
  return bytes;
}

function mp3Bytes(): Uint8Array {
  const bytes = new Uint8Array(128);
  bytes.set([0x49, 0x44, 0x33]); // "ID3"
  for (let i = 3; i < bytes.length; i++) bytes[i] = (i * 13) % 256;
  return bytes;
}

function htmlBytes(): Uint8Array {
  return new TextEncoder().encode("<html><body>not media</body></html>");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const notFoundFetch: FetchLike = async () => new Response("missing", { status: 404 });
const failingFetch: FetchLike = async () => {
  throw new Error("network down");
};

function bodyFetch(bytes: Uint8Array, contentType: string): FetchLike {
  return async () => new Response(toArrayBuffer(bytes), { status: 200, headers: { "content-type": contentType } });
}

function imageInput(overrides: Partial<ExtractImageInput> = {}): ExtractImageInput {
  return {
    sourceText: "",
    fetchImpl: notFoundFetch,
    timeoutMs: 5_000,
    maxBytes: 5_000_000,
    maxTextChars: 24_000,
    ...overrides,
  };
}

function audioInput(overrides: Partial<ExtractAudioInput> = {}): ExtractAudioInput {
  return {
    sourceText: "",
    fetchImpl: notFoundFetch,
    timeoutMs: 5_000,
    sidecarRetryDelayMs: 5,
    maxBytes: 5_000_000,
    maxTextChars: 24_000,
    ...overrides,
  };
}

/** A provider with only the base text-in/JSON-out contract; no media extensions. */
function textOnlyProvider(): StructuredProvider {
  return {
    name: "text-only",
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      return {} as T;
    },
  };
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

function throwingVisionProvider(): StructuredProvider {
  const provider: ImageDescribingProvider = {
    name: "broken-vision",
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      return {} as T;
    },
    describeImage: async () => {
      throw new Error("vision unavailable");
    },
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

function throwingTranscribingProvider(): StructuredProvider {
  const provider: AudioTranscribingProvider = {
    name: "broken-transcriber",
    async generateJSON<T>(_request: StructuredGenerationRequest): Promise<T> {
      return {} as T;
    },
    transcribeAudio: async () => {
      throw new Error("transcription unavailable");
    },
  };
  return provider;
}

class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, { bytes: ArrayBuffer; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();

  async get() {
    return null;
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

  async head() {
    return null;
  }
}

class FailingR2Bucket extends FakeR2Bucket {
  override async put(
    _key: string,
    _value: ArrayBuffer | ArrayBufferView | string,
    _options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<{ key: string }> {
    throw new Error("R2 unavailable");
  }
}

// ---------------------------------------------------------------------------
// Image module
// ---------------------------------------------------------------------------

describe("image extraction module", () => {
  it("stores the image and uses the vision caption when the provider offers one", async () => {
    const bucket = new FakeR2Bucket();
    const result = await extractImageModule(
      imageInput({
        url: "https://example.com/sunset.png",
        bytes: toArrayBuffer(pngBytes()),
        contentType: "image/png",
        provider: visionProvider({ title: "Sunset", caption: "A sunset over the bay", textContent: "RE" }),
        assetStore: new AssetStore(bucket),
      }),
    );
    expect(result?.title).toBe("Sunset");
    expect(result?.text).toBe("A sunset over the bay\n\nRE");
    expect(result?.excerpt).toBe("A sunset over the bay");
    expect(result?.canonicalURL).toBe("https://example.com/sunset.png");
    expect(result?.accessLevel).toBe("partial");
    expect(result?.depthCap).toBe("light");
    expect(result?.metadata).toMatchObject({ extraction: "image-vision", contentType: "image/png", byteLength: "72" });
    expect(result?.limitations).toEqual([]);
    expect(result?.references?.[0]).toMatchObject({ url: "https://example.com/sunset.png", domain: "example.com", label: "source" });
    expect(result?.assets).toHaveLength(1);
    const image = result?.assets?.[0];
    expect(image?.kind).toBe("image");
    expect(image?.caption).toBe("A sunset over the bay");
    expect(image?.contentType).toBe("image/png");
    expect(image?.sourceURL).toBe("https://example.com/sunset.png");
    expect(image && isAssetPath(image.url)).toBe(true);
    expect(bucket.objects.size).toBe(1);
    const stored = [...bucket.objects.values()][0];
    expect(stored.httpMetadata?.contentType).toBe("image/png");
    expect(stored.customMetadata).toMatchObject({ kind: "image", caption: "A sunset over the bay", sourceURL: "https://example.com/sunset.png" });
  });

  it("fetches the image over the network when only a URL is given", async () => {
    const bucket = new FakeR2Bucket();
    const result = await extractImageModule(
      imageInput({
        url: "https://example.com/photo.png",
        fetchImpl: bodyFetch(pngBytes(), "image/png"),
        provider: visionProvider({ caption: "A fetched photo" }),
        assetStore: new AssetStore(bucket),
      }),
    );
    expect(result?.text).toBe("A fetched photo");
    expect(result?.depthCap).toBe("light");
    expect(result?.assets?.[0]?.kind).toBe("image");
    expect(bucket.objects.size).toBe(1);
  });

  it("stores the image without a caption when the provider cannot describe images", async () => {
    const result = await extractImageModule(
      imageInput({
        bytes: toArrayBuffer(pngBytes()),
        contentType: "image/png",
        provider: textOnlyProvider(),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(result?.assets).toHaveLength(1);
    expect(result?.text).toBeUndefined();
    expect(result?.excerpt).toBeUndefined();
    expect(result?.accessLevel).toBe("metadata");
    expect(result?.depthCap).toBe("tiny");
    expect(result?.metadata?.extraction).toBe("image-bytes");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no vision caption/i);
  });

  it("says so when the vision provider returns nothing or fails", async () => {
    const empty = await extractImageModule(
      imageInput({
        bytes: toArrayBuffer(pngBytes()),
        contentType: "image/png",
        provider: visionProvider(undefined),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(empty?.depthCap).toBe("tiny");
    expect(empty?.extractionNotes?.join(" ")).toMatch(/returned no caption/i);

    const broken = await extractImageModule(
      imageInput({
        bytes: toArrayBuffer(pngBytes()),
        contentType: "image/png",
        provider: throwingVisionProvider(),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(broken?.depthCap).toBe("tiny");
    expect(broken?.extractionNotes?.join(" ")).toMatch(/returned no caption/i);
  });

  it("rejects bodies that are not images", async () => {
    await expect(
      extractImageModule(imageInput({ bytes: toArrayBuffer(htmlBytes()), contentType: "text/html" })),
    ).resolves.toBeUndefined();
    await expect(
      extractImageModule(imageInput({ url: "https://example.com/page", fetchImpl: bodyFetch(htmlBytes(), "text/html") })),
    ).resolves.toBeUndefined();
    // Undeclared bytes that do not sniff as a known image format are rejected too.
    await expect(extractImageModule(imageInput({ bytes: toArrayBuffer(htmlBytes()) }))).resolves.toBeUndefined();
  });

  it("sniffs the image format when no content type is declared", async () => {
    const result = await extractImageModule(
      imageInput({ bytes: toArrayBuffer(pngBytes()), assetStore: new AssetStore(new FakeR2Bucket()) }),
    );
    expect(result?.metadata?.contentType).toBe("image/png");
    expect(result?.depthCap).toBe("tiny");
  });

  it("returns undefined when the body exceeds maxBytes", async () => {
    const png = pngBytes();
    await expect(
      extractImageModule(imageInput({ bytes: toArrayBuffer(png), contentType: "image/png", maxBytes: png.length - 1 })),
    ).resolves.toBeUndefined();
    await expect(
      extractImageModule(
        imageInput({ url: "https://example.com/big.png", fetchImpl: bodyFetch(png, "image/png"), maxBytes: png.length - 1 }),
      ),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the fetch fails, the URL is unreachable, or nothing is supplied", async () => {
    await expect(extractImageModule(imageInput({ url: "https://example.com/a.png" }))).resolves.toBeUndefined();
    await expect(
      extractImageModule(imageInput({ url: "https://example.com/a.png", fetchImpl: failingFetch })),
    ).resolves.toBeUndefined();
    await expect(extractImageModule(imageInput({}))).resolves.toBeUndefined();
    await expect(extractImageModule(imageInput({ bytes: new ArrayBuffer(0), contentType: "image/png" }))).resolves.toBeUndefined();
  });

  it("keeps a remote reference when no asset store is configured and says so", async () => {
    const result = await extractImageModule(
      imageInput({ url: "https://example.com/remote.png", fetchImpl: bodyFetch(pngBytes(), "image/png") }),
    );
    expect(result?.assets).toHaveLength(1);
    expect(result?.assets?.[0]).toMatchObject({ kind: "image", url: "https://example.com/remote.png", sourceURL: "https://example.com/remote.png" });
    expect(result?.depthCap).toBe("tiny");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no asset store/i);
  });

  it("keeps the caption even when the image cannot be persisted", async () => {
    const result = await extractImageModule(
      imageInput({
        bytes: toArrayBuffer(pngBytes()),
        contentType: "image/png",
        provider: visionProvider({ caption: "Unpersisted but described" }),
      }),
    );
    expect(result?.text).toBe("Unpersisted but described");
    expect(result?.assets).toBeUndefined();
    expect(result?.depthCap).toBe("light");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no asset store/i);
  });

  it("reports a limitation when the asset store fails mid-store", async () => {
    const result = await extractImageModule(
      imageInput({
        url: "https://example.com/failing.png",
        bytes: toArrayBuffer(pngBytes()),
        contentType: "image/png",
        assetStore: new AssetStore(new FailingR2Bucket()),
      }),
    );
    expect(result?.extractionNotes?.join(" ")).toMatch(/could not be persisted/i);
    // The URL keeps a remote reference alive even though the store failed.
    expect(result?.assets?.[0]?.url).toBe("https://example.com/failing.png");
  });
});

// ---------------------------------------------------------------------------
// Audio module
// ---------------------------------------------------------------------------

describe("audio extraction module", () => {
  const depthCases: Array<[number, string]> = [
    [35_000, "veryDeep"],
    [4_500, "deep"],
    [700, "medium"],
    [100, "light"],
  ];

  it.each(depthCases)("maps a %i-char transcript to depthCap %s", async (transcriptLength, depthCap) => {
    const result = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        provider: transcribingProvider({ text: "x".repeat(transcriptLength) }),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(result?.depthCap).toBe(depthCap);
    expect(result?.accessLevel).toBe("full");
    expect(result?.metadata?.extraction).toBe("audio-transcription");
    expect(result?.limitations).toEqual([]);
  });

  it("truncates the handoff transcript at maxTextChars but keeps depth honest", async () => {
    const result = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        provider: transcribingProvider({ text: "x".repeat(50_000) }),
        maxTextChars: 1_000,
      }),
    );
    expect(result?.text).toHaveLength(1_000);
    expect(result?.depthCap).toBe("veryDeep");
  });

  it("stores the clip as an audio asset and records the transcript language", async () => {
    const bucket = new FakeR2Bucket();
    const result = await extractAudioModule(
      audioInput({
        url: "https://example.com/episode.mp3",
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        provider: transcribingProvider({ text: "Hello and welcome to the show", language: "en" }),
        assetStore: new AssetStore(bucket),
      }),
    );
    expect(result?.text).toBe("Hello and welcome to the show");
    expect(result?.excerpt).toBe("Hello and welcome to the show");
    expect(result?.metadata).toMatchObject({ extraction: "audio-transcription", contentType: "audio/mpeg", language: "en" });
    expect(result?.canonicalURL).toBe("https://example.com/episode.mp3");
    expect(result?.references?.[0]).toMatchObject({ url: "https://example.com/episode.mp3", domain: "example.com", label: "source" });
    expect(result?.assets).toHaveLength(1);
    const clip = result?.assets?.[0];
    expect(clip?.kind).toBe("audio");
    expect(clip?.contentType).toBe("audio/mpeg");
    expect(clip?.sourceURL).toBe("https://example.com/episode.mp3");
    expect(clip && isAssetPath(clip.url)).toBe(true);
    expect([...bucket.objects.values()][0].customMetadata).toMatchObject({ kind: "audio", sourceURL: "https://example.com/episode.mp3" });
  });

  it("fetches the audio over the network when only a URL is given", async () => {
    const result = await extractAudioModule(
      audioInput({
        url: "https://example.com/podcast.mp3",
        fetchImpl: bodyFetch(mp3Bytes(), "audio/mpeg"),
        provider: transcribingProvider({ text: "Fetched transcript" }),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(result?.text).toBe("Fetched transcript");
    expect(result?.depthCap).toBe("light");
    expect(result?.assets?.[0]?.kind).toBe("audio");
  });

  it("prefers the faster-whisper sidecar and falls back to the configured provider when it is unavailable", async () => {
    const sidecarEndpoint = "https://sidecar.internal/transcribe";
    let providerCalls = 0;
    const provider = transcribingProvider({ text: "provider transcript" }) as AudioTranscribingProvider;
    provider.transcribeAudio = async () => {
      providerCalls += 1;
      return { text: "provider transcript" };
    };
    const fetchImpl: FetchLike = async (input) => {
      if (String(input) === sidecarEndpoint) {
        return new Response(JSON.stringify({ ok: true, text: "local whisper transcript", language: "en" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("missing", { status: 404 });
    };
    const result = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        sidecarURL: "https://sidecar.internal",
        provider,
        fetchImpl,
      }),
    );
    expect(result?.text).toBe("local whisper transcript");
    expect(result?.metadata).toMatchObject({ extraction: "audio-transcription", transcriptionSource: "faster-whisper", language: "en" });
    expect(providerCalls).toBe(0);

    const unavailable = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        sidecarURL: "https://sidecar.internal",
        provider,
        fetchImpl: async () => new Response("down", { status: 503 }),
      }),
    );
    expect(unavailable?.text).toBe("provider transcript");
    expect(providerCalls).toBe(1);
  });

  it("stores the clip as save-only with an honest limitation when no transcriber is available", async () => {
    const result = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        provider: textOnlyProvider(),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(result?.assets).toHaveLength(1);
    expect(result?.assets?.[0]?.kind).toBe("audio");
    expect(result?.text).toBeUndefined();
    expect(result?.excerpt).toBeUndefined();
    expect(result?.accessLevel).toBe("metadata");
    expect(result?.depthCap).toBe("saveOnly");
    expect(result?.metadata?.extraction).toBe("audio-metadata");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no transcription/i);
  });

  it("says so when the transcription provider returns nothing or fails", async () => {
    const empty = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        provider: transcribingProvider(undefined),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(empty?.depthCap).toBe("saveOnly");
    expect(empty?.extractionNotes?.join(" ")).toMatch(/returned no transcript/i);

    const broken = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        contentType: "audio/mpeg",
        provider: throwingTranscribingProvider(),
        assetStore: new AssetStore(new FakeR2Bucket()),
      }),
    );
    expect(broken?.depthCap).toBe("saveOnly");
    expect(broken?.extractionNotes?.join(" ")).toMatch(/returned no transcript/i);
  });

  it("rejects bodies that are not audio", async () => {
    await expect(
      extractAudioModule(audioInput({ bytes: toArrayBuffer(pngBytes()), contentType: "image/png" })),
    ).resolves.toBeUndefined();
    await expect(
      extractAudioModule(audioInput({ url: "https://example.com/page", fetchImpl: bodyFetch(htmlBytes(), "text/html") })),
    ).resolves.toBeUndefined();
    await expect(extractAudioModule(audioInput({ bytes: toArrayBuffer(htmlBytes()) }))).resolves.toBeUndefined();
  });

  it("sniffs the audio format when no content type is declared", async () => {
    const result = await extractAudioModule(
      audioInput({
        bytes: toArrayBuffer(mp3Bytes()),
        provider: transcribingProvider({ text: "sniffed" }),
      }),
    );
    expect(result?.metadata?.contentType).toBe("audio/mpeg");
  });

  it("returns undefined when the body exceeds maxBytes", async () => {
    const mp3 = mp3Bytes();
    await expect(
      extractAudioModule(audioInput({ bytes: toArrayBuffer(mp3), contentType: "audio/mpeg", maxBytes: mp3.length - 1 })),
    ).resolves.toBeUndefined();
    await expect(
      extractAudioModule(
        audioInput({ url: "https://example.com/big.mp3", fetchImpl: bodyFetch(mp3, "audio/mpeg"), maxBytes: mp3.length - 1 }),
      ),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when every input path fails", async () => {
    await expect(extractAudioModule(audioInput({ url: "https://example.com/a.mp3" }))).resolves.toBeUndefined();
    await expect(
      extractAudioModule(audioInput({ url: "https://example.com/a.mp3", fetchImpl: failingFetch })),
    ).resolves.toBeUndefined();
    await expect(extractAudioModule(audioInput({}))).resolves.toBeUndefined();
    await expect(extractAudioModule(audioInput({ bytes: new ArrayBuffer(0), contentType: "audio/mpeg" }))).resolves.toBeUndefined();
    // Raw bytes with no store and no transcriber leave nothing worth keeping.
    await expect(
      extractAudioModule(audioInput({ bytes: toArrayBuffer(mp3Bytes()), contentType: "audio/mpeg" })),
    ).resolves.toBeUndefined();
  });

  it("keeps a remote reference when no asset store is configured and says so", async () => {
    const result = await extractAudioModule(
      audioInput({ url: "https://example.com/remote.mp3", fetchImpl: bodyFetch(mp3Bytes(), "audio/mpeg") }),
    );
    expect(result?.assets).toHaveLength(1);
    expect(result?.assets?.[0]).toMatchObject({ kind: "audio", url: "https://example.com/remote.mp3", sourceURL: "https://example.com/remote.mp3" });
    expect(result?.depthCap).toBe("saveOnly");
    expect(result?.extractionNotes?.join(" ")).toMatch(/no asset store/i);
  });
});
