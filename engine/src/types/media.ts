/**
 * Media providers the video engine needs beyond text:
 * a reasoner that can look at pictures, image generation and editing,
 * segmentation of a phrase into masks, speech with word timings, and picture
 * search that keeps licence and credit.
 *
 * Every interface is vendor-neutral (docs/DECISIONS.md #18). Each call takes a
 * `MediaCallContext` (abort signal, remaining budget, job id), reports one
 * `UsageEvent` per upstream request, and returns stored media as `AssetRef`s
 * from the asset store. Nothing here names a style, voice, size or length:
 * the caller decides all of those per call.
 */
import type { AssetRef } from "./source";
import type { ProviderTask } from "./provider";

export type MediaTask = "reason" | "generateImage" | "editImage" | "segment" | "speak" | "searchPictures" | "render";

/** What every media call receives from the job that makes it. */
export interface MediaCallContext {
  /** Aborted when the job is cancelled; adapters stop before and during the call. */
  signal?: AbortSignal;
  /**
   * What the job may still spend, in USD. An adapter that can price a call up
   * front refuses it when the price is above this; one that cannot refuses
   * only when nothing is left. Undefined means no limit was set.
   */
  remainingUSD?: () => number | undefined;
  /** Copied onto usage events so cost is summed per job. */
  jobId?: string;
}

/** Bytes plus their media type: the input form for pictures and masks. */
export interface MediaBytes {
  bytes: ArrayBuffer;
  contentType: string;
}

/** Media an adapter made and stored, with the bytes kept for the next step. */
export interface StoredMedia {
  asset: AssetRef;
  bytes: ArrayBuffer;
}

/** How a vendor bills a model; the unit count comes from each request. */
export type MediaPriceUnit = "image" | "megapixel" | "character" | "second" | "request";

export interface MediaPrice {
  unit: MediaPriceUnit;
  usdPerUnit: number;
}

/** Media prices by model id. Kept apart from token prices (`PriceTable`). */
export type MediaPriceTable = Record<string, MediaPrice>;

// Reasoner ------------------------------------------------------------------

export type ReasoningEffort = "low" | "medium" | "high";

export interface ReasonRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Pictures the model should look at (a rendered still, a candidate image). */
  images?: MediaBytes[];
  effort?: ReasoningEffort;
  /** Routing hint for providers that route by task. */
  task?: ProviderTask;
}

/** Structured output, with vision when the adapter has it. */
export interface Reasoner {
  readonly name: string;
  /** False when `images` would be refused; callers check before sending pictures. */
  readonly seesImages: boolean;
  reasonJSON<T>(request: ReasonRequest, ctx: MediaCallContext): Promise<T>;
}

// Image generation ----------------------------------------------------------

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageGenerateRequest {
  prompt: string;
  size: ImageSize;
  /** Pictures whose look the result should share (a video keeps one look). */
  styleReferences?: MediaBytes[];
  seed?: number;
}

export interface ImageEditRequest {
  prompt: string;
  image: MediaBytes;
  /** Where to change the image; without it the adapter edits the whole picture. */
  mask?: MediaBytes;
  styleReferences?: MediaBytes[];
  size?: ImageSize;
  seed?: number;
}

export interface GeneratedImage extends StoredMedia {
  width: number;
  height: number;
  provider: string;
  model: string;
  /** Some vendors rewrite the prompt; kept so a review can see what was drawn. */
  revisedPrompt?: string;
}

/** Generated pictures are always marked generated, never passed off as found. */
export interface ImageGenerator {
  readonly name: string;
  generate(request: ImageGenerateRequest, ctx: MediaCallContext): Promise<GeneratedImage>;
  edit?(request: ImageEditRequest, ctx: MediaCallContext): Promise<GeneratedImage>;
}

// Segmentation --------------------------------------------------------------

/** Pixel box inside the source picture, origin top left. */
export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentRequest {
  image: MediaBytes;
  /** What to find, in words ("the left ventricle", "every planet"). */
  phrase: string;
  maxMasks?: number;
}

export interface SegmentMask extends StoredMedia {
  /** Tight box around the mask in the source picture. */
  box: PixelBox;
  /** 0...1 confidence as the vendor reports it. */
  score: number;
}

export interface Segmentation {
  /** Size of the picture the masks belong to. */
  width: number;
  height: number;
  /** Best first; empty when the phrase matched nothing. */
  masks: SegmentMask[];
  provider: string;
  model: string;
}

export interface Segmenter {
  readonly name: string;
  segment(request: SegmentRequest, ctx: MediaCallContext): Promise<Segmentation>;
}

// Speech --------------------------------------------------------------------

export interface SpeechRequest {
  text: string;
  /** Vendor voice id; chosen per video, never defaulted here. */
  voice: string;
  /** BCP-47 tag when known. */
  language?: string;
  /** Text read before and after this part, for continuous intonation. Not spoken. */
  previousText?: string;
  nextText?: string;
}

/** One spoken word, with where it sits in the request text and in the audio. */
export interface SpokenWord {
  text: string;
  /** Offsets into `SpeechRequest.text`, end exclusive. */
  charStart: number;
  charEnd: number;
  startMs: number;
  endMs: number;
}

export interface Speech extends StoredMedia {
  durationMs: number;
  /** In order, one per word of the text; what captions and sync read. */
  words: SpokenWord[];
  provider: string;
  model: string;
}

export interface SpeechSynthesizer {
  readonly name: string;
  speak(request: SpeechRequest, ctx: MediaCallContext): Promise<Speech>;
}

// Picture search ------------------------------------------------------------

export interface PictureSearchRequest {
  query: string;
  limit?: number;
  /** Smallest width worth returning, in pixels. */
  minWidth?: number;
}

export interface PictureLicence {
  /** Short name as the archive gives it ("CC BY-SA 4.0", "Public domain"). */
  name: string;
  url?: string;
}

/** A found picture. Not stored until a later step picks it. */
export interface PictureCandidate {
  url: string;
  /** The archive page that describes the picture. */
  pageURL: string;
  title: string;
  width?: number;
  height?: number;
  contentType?: string;
  description?: string;
  licence: PictureLicence;
  /** Author or holder to show with the video. */
  credit: string;
  /** Which archive it came from. */
  archive: string;
}

export interface PictureSearch {
  readonly name: string;
  search(request: PictureSearchRequest, ctx: MediaCallContext): Promise<PictureCandidate[]>;
}

/** The media providers a video job is given; any may be missing until configured. */
export interface MediaProviders {
  reasoner?: Reasoner;
  images?: ImageGenerator;
  segmenter?: Segmenter;
  speech?: SpeechSynthesizer;
  pictures?: PictureSearch;
}
