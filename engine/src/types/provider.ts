/** LLM provider interface shared by every adapter and the router. */
import type { ByteDepth } from "../cards/blocks";
import type { MediaTask } from "./media";

export type ProviderTask = "planning" | "section" | "repair" | "youtube" | "research" | "longContext" | "chat";

export interface StructuredGenerationRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Routing hint; it is never logged or sent as user content. */
  task?: ProviderTask;
  depth?: ByteDepth;
  /** Provider-specific request hint; it is never logged. */
  grounding?: boolean;
  youtubeURL?: string;
}

export interface StructuredProvider {
  readonly name: string;
  generateJSON<T>(request: StructuredGenerationRequest): Promise<T>;
  generateYouTubeJSON?<T>(request: StructuredGenerationRequest & { youtubeURL: string }): Promise<T>;
  generateGroundedJSON?<T>(request: StructuredGenerationRequest): Promise<T>;
}

export interface FetchLike {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}


export interface ImageDescription {
  title?: string;
  caption?: string;
  /** Text visible inside the image (OCR), when the provider can read it. */
  textContent?: string;
}

/**
 * Optional vision capability on top of StructuredProvider. The base contract
 * is text-in/JSON-out and cannot accept image bytes, so image description
 * rides on this extension; providers without it are skipped with an honest
 * limitation.
 */
export interface ImageDescribingProvider extends StructuredProvider {
  describeImage?(bytes: ArrayBuffer, contentType: string): Promise<ImageDescription | undefined>;
}

export interface AudioTranscription {
  text?: string;
  /** BCP-47 language tag when the provider reports one; surfaced in metadata. */
  language?: string;
  /** Optional provenance such as faster-whisper; provider adapters may omit it. */
  source?: string;
}

/**
 * Optional transcription capability on top of StructuredProvider. Providers
 * without it are skipped with an honest limitation; the sidecar is attempted
 * before this provider path.
 */
export interface AudioTranscribingProvider extends StructuredProvider {
  transcribeAudio?(bytes: ArrayBuffer, contentType: string): Promise<AudioTranscription | undefined>;
}

/**
 * One provider call, as seen by the usage log. Every adapter reports one event
 * per upstream request so per-item cost can be shown everywhere
 * (docs/DECISIONS.md #11: "show cost everywhere from day one").
 */
export interface UsageEvent {
  provider: string;
  model: string;
  task?: ProviderTask | "describeImage" | "transcribeAudio" | MediaTask;
  tokensIn?: number;
  tokensOut?: number;
  /** Estimated cost in USD when a price is known for the model; otherwise omitted. */
  usd?: number;
  latencyMs: number;
  ok: boolean;
  /**
   * Why a failed call failed. `timeout`: the engine stopped waiting, so the
   * provider may have produced (and billed) an answer nobody read; such a
   * call has no `usd` and totals count it as possibly unbilled cost.
   */
  error?: UsageError;
  /** Set by the caller that owns the job; adapters leave it undefined. */
  jobId?: string;
}

export type UsageError = "timeout" | "http" | "network" | "output";

export interface UsageSink {
  record(event: UsageEvent): void | Promise<void>;
}

/** USD per one million tokens for a model id. */
export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** ISO date (YYYY-MM-DD) from which this price applies; absent means always. */
  effectiveFrom?: string;
}

/**
 * Model id → its price, or a schedule of prices when the list price changes
 * on a known date. A model missing from the table is unpriced: its calls are
 * recorded with no `usd` and counted as unpriced, never as $0.
 */
export type PriceTable = Record<string, ModelPrice | ModelPrice[]>;
