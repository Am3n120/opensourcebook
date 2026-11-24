/**
 * Scripted fakes for the media providers (`src/types/media.ts`). Each one
 * goes through the same metering and storing an adapter does, so tests see
 * real usage events, budget refusals and stored assets. Queue what the next
 * calls return with `script`; a queued `Error` is thrown instead. With an
 * empty queue a fake answers with a small default made from the request.
 */
import type { AssetStore } from "../../src/assets";
import { meteredCall, mediaUSD, storeMedia, wordsFromCharacterTimes } from "../../src/providers/media";
import type {
  GeneratedImage,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageGenerator,
  MediaCallContext,
  MediaPrice,
  PictureCandidate,
  PictureSearch,
  PictureSearchRequest,
  Reasoner,
  ReasonRequest,
  Segmentation,
  SegmentRequest,
  Segmenter,
  Speech,
  SpeechRequest,
  SpeechSynthesizer,
  UsageSink,
} from "../../src/types";

type Scripted<T> = T | Error;

class Script<T> {
  private readonly queue: Array<Scripted<T>> = [];
  push(...items: Array<Scripted<T>>): void {
    this.queue.push(...items);
  }
  next(): Scripted<T> | undefined {
    return this.queue.shift();
  }
}

function unwrap<T>(item: Scripted<T> | undefined, fallback: () => T): T {
  if (item instanceof Error) throw item;
  return item ?? fallback();
}

interface FakeOptions {
  usage?: UsageSink;
  price?: MediaPrice;
  model?: string;
}

/** Bytes that differ per call, so content-addressed ids differ too. */
function fakeBytes(label: string): ArrayBuffer {
  return new TextEncoder().encode(label).buffer as ArrayBuffer;
}

export class FakeReasoner implements Reasoner {
  readonly name = "fake-reasoner";
  readonly requests: ReasonRequest[] = [];
  private readonly script = new Script<unknown>();

  constructor(
    private readonly options: FakeOptions & { seesImages?: boolean } = {},
  ) {}

  get seesImages(): boolean {
    return this.options.seesImages ?? true;
  }

  respond(...answers: Array<Scripted<unknown>>): this {
    this.script.push(...answers);
    return this;
  }

  async reasonJSON<T>(request: ReasonRequest, ctx: MediaCallContext): Promise<T> {
    this.requests.push(request);
    return meteredCall({
      provider: this.name,
      model: this.options.model ?? "fake-reason-1",
      task: "reason",
      ctx,
      usage: this.options.usage,
      estimateUSD: mediaUSD(this.options.price, 1),
      call: async () => ({ result: unwrap(this.script.next(), () => ({})) as T, tokensIn: 10, tokensOut: 5 }),
    });
  }
}

export class FakeImageGenerator implements ImageGenerator {
  readonly name = "fake-images";
  readonly requests: Array<ImageGenerateRequest | ImageEditRequest> = [];
  private readonly script = new Script<{ bytes: ArrayBuffer; revisedPrompt?: string }>();
  private calls = 0;

  constructor(private readonly assets: AssetStore, private readonly options: FakeOptions = {}) {}

  respond(...images: Array<Scripted<{ bytes: ArrayBuffer; revisedPrompt?: string }>>): this {
    this.script.push(...images);
    return this;
  }

  generate(request: ImageGenerateRequest, ctx: MediaCallContext): Promise<GeneratedImage> {
    this.requests.push(request);
    return this.make("generateImage", request.prompt, request.size.width, request.size.height, ctx);
  }

  edit(request: ImageEditRequest, ctx: MediaCallContext): Promise<GeneratedImage> {
    this.requests.push(request);
    return this.make("editImage", request.prompt, request.size?.width ?? 1, request.size?.height ?? 1, ctx);
  }

  private async make(
    task: "generateImage" | "editImage",
    prompt: string,
    width: number,
    height: number,
    ctx: MediaCallContext,
  ): Promise<GeneratedImage> {
    const model = this.options.model ?? "fake-image-1";
    const call = ++this.calls;
    const made: { bytes: ArrayBuffer; revisedPrompt?: string } = await meteredCall({
      provider: this.name,
      model,
      task,
      ctx,
      usage: this.options.usage,
      estimateUSD: mediaUSD(this.options.price, 1),
      call: async () => ({ result: unwrap(this.script.next(), () => ({ bytes: fakeBytes(`image ${call}: ${prompt}`) })) }),
    });
    const stored = await storeMedia(this.assets, made.bytes, { kind: "image", contentType: "image/png", width, height, caption: "generated" });
    return {
      ...stored,
      width,
      height,
      provider: this.name,
      model,
      ...(made.revisedPrompt ? { revisedPrompt: made.revisedPrompt } : {}),
    };
  }
}

export class FakeSegmenter implements Segmenter {
  readonly name = "fake-segmenter";
  readonly requests: SegmentRequest[] = [];
  private readonly script = new Script<Array<{ box: { x: number; y: number; width: number; height: number }; score: number }>>();

  constructor(
    private readonly assets: AssetStore,
    private readonly options: FakeOptions & { size?: { width: number; height: number } } = {},
  ) {}

  /** Each entry is the masks one call finds; an empty list means nothing matched. */
  respond(...results: Array<Scripted<Array<{ box: { x: number; y: number; width: number; height: number }; score: number }>>>): this {
    this.script.push(...results);
    return this;
  }

  async segment(request: SegmentRequest, ctx: MediaCallContext): Promise<Segmentation> {
    this.requests.push(request);
    const model = this.options.model ?? "fake-segment-1";
    const size = this.options.size ?? { width: 100, height: 100 };
    const found = await meteredCall({
      provider: this.name,
      model,
      task: "segment",
      ctx,
      usage: this.options.usage,
      estimateUSD: mediaUSD(this.options.price, 1),
      call: async () => ({ result: unwrap(this.script.next(), () => []) }),
    });
    const masks = await Promise.all(
      found
        .slice(0, request.maxMasks ?? found.length)
        .map(async (mask, index) => ({
          ...(await storeMedia(this.assets, fakeBytes(`mask ${request.phrase} ${index}`), {
            kind: "image",
            contentType: "image/png",
            width: mask.box.width,
            height: mask.box.height,
          })),
          box: mask.box,
          score: mask.score,
        })),
    );
    masks.sort((a, b) => b.score - a.score);
    return { ...size, masks, provider: this.name, model };
  }
}

export class FakeSpeech implements SpeechSynthesizer {
  readonly name = "fake-speech";
  readonly requests: SpeechRequest[] = [];
  private readonly script = new Script<{ msPerChar: number }>();

  constructor(private readonly assets: AssetStore, private readonly options: FakeOptions = {}) {}

  /** Each entry sets the pace of one call; the default is 60 ms per character. */
  respond(...paces: Array<Scripted<{ msPerChar: number }>>): this {
    this.script.push(...paces);
    return this;
  }

  async speak(request: SpeechRequest, ctx: MediaCallContext): Promise<Speech> {
    this.requests.push(request);
    const model = this.options.model ?? "fake-voice-1";
    const characters = Array.from(request.text);
    const { msPerChar } = await meteredCall({
      provider: this.name,
      model,
      task: "speak",
      ctx,
      usage: this.options.usage,
      estimateUSD: mediaUSD(this.options.price, characters.length),
      call: async () => ({ result: unwrap(this.script.next(), () => ({ msPerChar: 60 })) }),
    });
    const starts = characters.map((_, index) => index * msPerChar);
    const ends = characters.map((_, index) => (index + 1) * msPerChar);
    const stored = await storeMedia(this.assets, fakeBytes(`speech ${request.voice}: ${request.text}`), {
      kind: "audio",
      contentType: "audio/mpeg",
    });
    return {
      ...stored,
      durationMs: characters.length * msPerChar,
      words: wordsFromCharacterTimes(request.text, starts, ends),
      provider: this.name,
      model,
    };
  }
}

export class FakePictureSearch implements PictureSearch {
  readonly name = "fake-pictures";
  readonly requests: PictureSearchRequest[] = [];
  private readonly script = new Script<PictureCandidate[]>();

  constructor(private readonly options: FakeOptions = {}) {}

  respond(...results: Array<Scripted<PictureCandidate[]>>): this {
    this.script.push(...results);
    return this;
  }

  async search(request: PictureSearchRequest, ctx: MediaCallContext): Promise<PictureCandidate[]> {
    this.requests.push(request);
    const found = await meteredCall({
      provider: this.name,
      model: this.options.model ?? "fake-archive",
      task: "searchPictures",
      ctx,
      usage: this.options.usage,
      estimateUSD: mediaUSD(this.options.price, 1),
      call: async () => ({ result: unwrap(this.script.next(), () => []) }),
    });
    return found.slice(0, request.limit ?? found.length);
  }
}
