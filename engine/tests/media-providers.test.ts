import { describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import {
  assertWithinBudget,
  checkWordTimings,
  MediaBudgetError,
  MediaCapabilityError,
  mediaContextFrom,
  mediaUSD,
  meteredCall,
  storeMedia,
  wordsFromCharacterTimes,
} from "../src/providers/media";
import { BudgetGuard } from "../src/providers/budget";
import { InMemoryUsageSink } from "../src/providers/usage";
import { FakeR2Bucket } from "./support/fake-r2";
import {
  FakeImageGenerator,
  FakePictureSearch,
  FakeReasoner,
  FakeSegmenter,
  FakeSpeech,
} from "./support/fake-media";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

function store() {
  const bucket = new FakeR2Bucket();
  return { bucket, assets: new AssetStore(bucket) };
}

describe("media pricing and budget", () => {
  it("prices units and rounds to a millionth of a dollar", () => {
    expect(mediaUSD({ unit: "image", usdPerUnit: 0.04 }, 3)).toBe(0.12);
    expect(mediaUSD({ unit: "character", usdPerUnit: 0.0000333 }, 1000)).toBe(0.0333);
    expect(mediaUSD(undefined, 3)).toBeUndefined();
    expect(mediaUSD({ unit: "image", usdPerUnit: 1 }, -1)).toBeUndefined();
  });

  it("refuses when the budget is spent or the known price is above what is left", () => {
    expect(() => assertWithinBudget({}, 5)).not.toThrow();
    expect(() => assertWithinBudget({ remainingUSD: () => undefined }, 5)).not.toThrow();
    expect(() => assertWithinBudget({ remainingUSD: () => 1 }, 0.5)).not.toThrow();
    expect(() => assertWithinBudget({ remainingUSD: () => 1 }, undefined)).not.toThrow();
    expect(() => assertWithinBudget({ remainingUSD: () => 0 }, undefined)).toThrow(MediaBudgetError);
    expect(() => assertWithinBudget({ remainingUSD: () => 0.1 }, 0.2)).toThrow(MediaBudgetError);
  });
});

describe("mediaContextFrom", () => {
  it("reads what is left from the job's budget guard, which media spend then counts against", async () => {
    const guard = new BudgetGuard(new InMemoryUsageSink(), 1, 0.25);
    const ctx = mediaContextFrom(guard, { jobId: "job-9" });
    expect(ctx.remainingUSD?.()).toBe(0.75);
    await meteredCall({ provider: "v", model: "m", task: "generateImage", ctx, usage: guard, estimateUSD: 0.5, call: async () => ({ result: 1 }) });
    expect(ctx.remainingUSD?.()).toBe(0.25);
    await expect(
      meteredCall({ provider: "v", model: "m", task: "generateImage", ctx, usage: guard, estimateUSD: 0.5, call: async () => ({ result: 2 }) }),
    ).rejects.toBeInstanceOf(MediaBudgetError);
    expect(mediaContextFrom(new BudgetGuard(new InMemoryUsageSink(), undefined)).remainingUSD?.()).toBeUndefined();
  });
});

describe("meteredCall", () => {
  it("logs one event with the vendor's cost, falling back to the estimate", async () => {
    const usage = new InMemoryUsageSink();
    let clock = 1_000;
    const now = () => (clock += 250);
    await meteredCall({ provider: "v", model: "m", task: "speak", ctx: { jobId: "job-1" }, usage, estimateUSD: 0.2, now, call: async () => ({ result: 1, usd: 0.15 }) });
    await meteredCall({ provider: "v", model: "m", task: "speak", ctx: {}, usage, estimateUSD: 0.2, now, call: async () => ({ result: 2 }) });
    expect(usage.events).toEqual([
      { provider: "v", model: "m", task: "speak", usd: 0.15, latencyMs: 250, ok: true, jobId: "job-1" },
      { provider: "v", model: "m", task: "speak", usd: 0.2, latencyMs: 250, ok: true },
    ]);
  });

  it("logs a failed call with no cost and rethrows", async () => {
    const usage = new InMemoryUsageSink();
    await expect(
      meteredCall({ provider: "v", model: "m", task: "generateImage", ctx: {}, usage, estimateUSD: 0.04, call: async () => { throw new Error("upstream 500"); } }),
    ).rejects.toThrow("upstream 500");
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({ ok: false });
    expect(usage.events[0].usd).toBeUndefined();
  });

  it("makes no call and logs nothing when refused by budget or already cancelled", async () => {
    const usage = new InMemoryUsageSink();
    let called = 0;
    const call = async () => ({ result: (called += 1) });
    await expect(meteredCall({ provider: "v", model: "m", task: "segment", ctx: { remainingUSD: () => 0.01 }, usage, estimateUSD: 0.02, call })).rejects.toBeInstanceOf(MediaBudgetError);
    const controller = new AbortController();
    controller.abort();
    await expect(meteredCall({ provider: "v", model: "m", task: "segment", ctx: { signal: controller.signal }, usage, call })).rejects.toThrow();
    expect(called).toBe(0);
    expect(usage.events).toHaveLength(0);
  });

  it("passes the job's signal to the call and stops after it when the job was cancelled meanwhile", async () => {
    const usage = new InMemoryUsageSink();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await expect(
      meteredCall({
        provider: "v",
        model: "m",
        task: "speak",
        ctx: { signal: controller.signal },
        usage,
        call: async (signal) => {
          seen = signal;
          controller.abort();
          return { result: "audio", usd: 0.3 };
        },
      }),
    ).rejects.toThrow();
    expect(seen).toBe(controller.signal);
    // The money was spent, so it is logged even though the result is dropped.
    expect(usage.events).toEqual([expect.objectContaining({ ok: true, usd: 0.3 })]);
  });
});

describe("storeMedia", () => {
  it("stores bytes as a content-addressed asset and keeps the bytes", async () => {
    const { bucket, assets } = store();
    const stored = await storeMedia(assets, bytes("png"), { kind: "image", contentType: "image/png", width: 4, height: 3 });
    expect(stored.asset).toMatchObject({ kind: "image", contentType: "image/png", width: 4, height: 3 });
    expect(stored.asset.url).toBe(`/v1/assets/${stored.asset.id}`);
    expect(bucket.objects.size).toBe(1);
    expect(new TextDecoder().decode(stored.bytes)).toBe("png");
  });

  it("fails clearly when no bucket is bound", async () => {
    await expect(storeMedia(new AssetStore(), bytes("x"), { kind: "audio" })).rejects.toBeInstanceOf(MediaCapabilityError);
  });
});

describe("word timings", () => {
  it("builds words from character times, ignoring the time vendors give punctuation", () => {
    const text = "Hi, you.";
    // H  i  ,  _  y  o  u  .
    const starts = [0, 100, 200, 400, 500, 600, 700, 800];
    const ends = [100, 200, 400, 500, 600, 700, 800, 1000];
    const words = wordsFromCharacterTimes(text, starts, ends);
    expect(words).toEqual([
      { text: "Hi,", charStart: 0, charEnd: 3, startMs: 0, endMs: 200 },
      { text: "you.", charStart: 4, charEnd: 8, startMs: 500, endMs: 800 },
    ]);
    expect(checkWordTimings(text, words, 1000)).toEqual([]);
  });

  it("keeps offsets right for characters outside the basic plane and drops punctuation-only tokens", () => {
    const text = "a 𝑥 — b";
    const chars = Array.from(text);
    const starts = chars.map((_, index) => index * 10);
    const ends = chars.map((_, index) => index * 10 + 10);
    const words = wordsFromCharacterTimes(text, starts, ends);
    expect(words.map((word) => word.text)).toEqual(["a", "𝑥", "b"]);
    expect(text.slice(words[1].charStart, words[1].charEnd)).toBe("𝑥");
    expect(text.slice(words[2].charStart, words[2].charEnd)).toBe("b");
    expect(words[2].startMs).toBe(60);
    expect(() => wordsFromCharacterTimes(text, [0], [1])).toThrow(RangeError);
  });

  it("reports timings captions cannot use", () => {
    const text = "one two";
    const issues = checkWordTimings(text, [
      { text: "one", charStart: 0, charEnd: 3, startMs: 0, endMs: 500 },
      { text: "two", charStart: 4, charEnd: 7, startMs: 400, endMs: 1200 },
      { text: "tow", charStart: 4, charEnd: 7, startMs: 1300, endMs: 1200 },
    ], 1000);
    expect(issues.map((issue) => `${issue.index}: ${issue.problem}`)).toEqual([
      "1: overlaps the word before",
      "1: ends after the audio",
      "2: starts after it ends",
      "2: ends after the audio",
      "2: character range is outside the text or out of order",
    ]);
  });
});

describe("scripted fakes", () => {
  it("image generator stores a generated image per call and logs its price", async () => {
    const usage = new InMemoryUsageSink();
    const { assets } = store();
    const images = new FakeImageGenerator(assets, { usage, price: { unit: "image", usdPerUnit: 0.04 } });
    images.respond({ bytes: bytes("first"), revisedPrompt: "a heart, drawn" }, new Error("content policy"));
    const first = await images.generate({ prompt: "a heart", size: { width: 640, height: 360 } }, { jobId: "j" });
    expect(first).toMatchObject({ width: 640, height: 360, revisedPrompt: "a heart, drawn", model: "fake-image-1" });
    expect(first.asset).toMatchObject({ kind: "image", caption: "generated" });
    await expect(images.edit({ prompt: "same look", image: { bytes: bytes("x"), contentType: "image/png" } }, {})).rejects.toThrow("content policy");
    expect(usage.events.map((event) => [event.task, event.ok, event.usd])).toEqual([
      ["generateImage", true, 0.04],
      ["editImage", false, undefined],
    ]);
  });

  it("segmenter returns masks best first, capped, and an empty list when nothing matched", async () => {
    const { assets } = store();
    const segmenter = new FakeSegmenter(assets, { size: { width: 200, height: 100 } });
    segmenter.respond(
      [
        { box: { x: 0, y: 0, width: 10, height: 10 }, score: 0.4 },
        { box: { x: 5, y: 5, width: 20, height: 20 }, score: 0.9 },
        { box: { x: 9, y: 9, width: 2, height: 2 }, score: 0.1 },
      ],
      [],
    );
    const image = { bytes: bytes("picture"), contentType: "image/jpeg" };
    const found = await segmenter.segment({ image, phrase: "planet", maxMasks: 2 }, {});
    expect(found).toMatchObject({ width: 200, height: 100 });
    expect(found.masks.map((mask) => mask.score)).toEqual([0.9, 0.4]);
    expect(found.masks[0].asset.kind).toBe("image");
    expect((await segmenter.segment({ image, phrase: "wave" }, {})).masks).toEqual([]);
  });

  it("speech returns audio with word timings that pass the caption check, priced per character", async () => {
    const usage = new InMemoryUsageSink();
    const { assets } = store();
    const speech = new FakeSpeech(assets, { usage, price: { unit: "character", usdPerUnit: 0.0001 } });
    speech.respond({ msPerChar: 50 });
    const text = "Blood leaves the heart.";
    const spoken = await speech.speak({ text, voice: "any-voice", previousText: "First," }, {});
    expect(spoken.asset.kind).toBe("audio");
    expect(spoken.durationMs).toBe(text.length * 50);
    expect(spoken.words.map((word) => word.text)).toEqual(["Blood", "leaves", "the", "heart."]);
    expect(checkWordTimings(text, spoken.words, spoken.durationMs)).toEqual([]);
    expect(usage.events[0]).toMatchObject({ task: "speak", usd: 0.0023 });
    expect(speech.requests[0].previousText).toBe("First,");
  });

  it("speech refuses a call the budget cannot cover before making it", async () => {
    const { bucket, assets } = store();
    const speech = new FakeSpeech(assets, { price: { unit: "character", usdPerUnit: 0.01 } });
    await expect(speech.speak({ text: "a long sentence", voice: "v" }, { remainingUSD: () => 0.05 })).rejects.toBeInstanceOf(MediaBudgetError);
    expect(bucket.objects.size).toBe(0);
  });

  it("reasoner and picture search answer from their scripts", async () => {
    const reasoner = new FakeReasoner().respond({ verdict: "keep" });
    expect(await reasoner.reasonJSON<{ verdict: string }>({ systemPrompt: "s", userPrompt: "u" }, {})).toEqual({ verdict: "keep" });
    const pictures = new FakePictureSearch().respond([
      { url: "u1", pageURL: "p1", title: "a", licence: { name: "CC0" }, credit: "x", archive: "test" },
      { url: "u2", pageURL: "p2", title: "b", licence: { name: "CC0" }, credit: "y", archive: "test" },
    ]);
    expect(await pictures.search({ query: "heart", limit: 1 }, {})).toHaveLength(1);
  });
});
