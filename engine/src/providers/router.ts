import type {
  AudioTranscribingProvider,
  AudioTranscription,
  ImageDescribingProvider,
  ImageDescription,
  StructuredGenerationRequest,
  StructuredProvider,
} from "../types";
import { isFallbackWorthyError as isFallbackWorthy, isRateLimitOrServerError, sleep } from "../net";

export interface ProviderRouterOptions {
  gemini?: StructuredProvider;
  deepseek?: StructuredProvider;
  openrouter?: StructuredProvider;
  preferred?: "gemini" | "deepseek";
  /** How long a provider is skipped after a 429/5xx — its quota window. */
  rateLimitCooldownMs?: number;
}

/** Retry / provider-swap delays for rate-limited or overloaded upstreams. */
const FALLBACK_DELAYS_MS = [2_000, 6_000, 15_000];

/**
 * Routes work by task while preserving one small provider interface for the
 * pipeline. DeepSeek is the main text engine (planning, sections, repair);
 * OpenRouter is the primary multimodal/research engine; Google Gemini is
 * demoted to last-resort there and still owns the YouTube video input hook
 * outright. If the selected provider is rate-limited or temporarily down, the
 * request falls back along the task's candidate list instead of failing the job.
 */
export class ProviderRouter implements StructuredProvider {
  readonly name = "provider-router";
  private readonly gemini?: StructuredProvider;
  private readonly deepseek?: StructuredProvider;
  private readonly openrouter?: StructuredProvider;
  private readonly preferred: "gemini" | "deepseek";
  private readonly rateLimitCooldownMs: number;
  /** provider.name → epoch ms until which it is skipped (429/5xx quota window). */
  private readonly cooldownUntil = new Map<string, number>();

  constructor(options: ProviderRouterOptions) {
    this.gemini = options.gemini;
    this.deepseek = options.deepseek;
    this.openrouter = options.openrouter;
    this.preferred = options.preferred ?? "deepseek";
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 60_000;
  }

  async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
    const candidates = this.candidatesFor(request);
    if (candidates.length === 0) {
      throw new ProviderRoutingError("No generation provider is configured", "NO_PROVIDER");
    }

    // Providers inside a rate-limit cooldown are skipped entirely — re-hitting
    // a saturated provider just burns its window and stalls the job. If every
    // candidate is cooling down, try the preferred order anyway: a provider
    // that recovered early beats failing the job.
    const fresh = candidates.filter((candidate) => (this.cooldownUntil.get(candidate.name) ?? 0) <= Date.now());
    const ordered = fresh.length > 0 ? fresh : candidates;

    let lastError: unknown;
    for (let index = 0; index < ordered.length; index += 1) {
      const provider = ordered[index];
      try {
        return await provider.generateJSON<T>(request);
      } catch (error) {
        lastError = error;
        if (isRateLimitOrServerError(error)) {
          this.cooldownUntil.set(provider.name, Date.now() + this.rateLimitCooldownMs);
        }
        const hasFallback = index < ordered.length - 1;
        if (!isFallbackWorthy(error) || !hasFallback) throw error;
        // The chosen provider is saturated — pause briefly, then continue the
        // same task on the other provider rather than failing the whole job.
        await sleep(FALLBACK_DELAYS_MS[Math.min(index, FALLBACK_DELAYS_MS.length - 1)]);
      }
    }
    throw lastError instanceof Error ? lastError : new ProviderRoutingError("Generation failed", "NO_PROVIDER");
  }

  async generateYouTubeJSON<T>(request: StructuredGenerationRequest & { youtubeURL: string }): Promise<T> {
    // OpenRouter's Gemini upstream handles YouTube watch URLs via video_url;
    // Google's own API is kept only as the last-resort video path.
    const candidates = [this.openrouter, this.gemini].filter(
      (provider): provider is StructuredProvider => Boolean(provider?.generateYouTubeJSON),
    );
    if (candidates.length === 0) {
      throw new ProviderRoutingError(
        "No video-capable provider is configured; metadata fallback should be used",
        "GEMINI_VIDEO_UNAVAILABLE",
      );
    }
    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      const provider = candidates[index];
      try {
        return await provider.generateYouTubeJSON!<T>(request);
      } catch (error) {
        lastError = error;
        if (isRateLimitOrServerError(error)) {
          this.cooldownUntil.set(provider.name, Date.now() + this.rateLimitCooldownMs);
        }
        const hasFallback = index < candidates.length - 1;
        if (!isFallbackWorthy(error) || !hasFallback) throw error;
        await sleep(FALLBACK_DELAYS_MS[Math.min(index, FALLBACK_DELAYS_MS.length - 1)]);
      }
    }
    throw lastError instanceof Error ? lastError : new ProviderRoutingError("Video understanding failed", "GEMINI_VIDEO_UNAVAILABLE");
  }

  /**
   * Research ladder: OpenRouter leads with a plain research-task generation,
   * Gemini's search-grounded call follows, and the text engine is the
   * ungrounded last resort. Rate-limited providers are cooled down on 429s, and
   * a saturated provider must not kill the job — research continues on the next
   * rung instead.
   */
  async generateGroundedJSON<T>(request: StructuredGenerationRequest): Promise<T> {
    let lastError: unknown;
    if (this.openrouter) {
      try {
        return await this.openrouter.generateJSON<T>({ ...request, task: "research" });
      } catch (error) {
        lastError = error;
        if (isRateLimitOrServerError(error)) {
          this.cooldownUntil.set(this.openrouter.name, Date.now() + this.rateLimitCooldownMs);
        }
        if (!isFallbackWorthy(error)) throw error;
      }
    }
    if (this.gemini?.generateGroundedJSON) {
      try {
        return await this.gemini.generateGroundedJSON<T>(request);
      } catch (error) {
        lastError = error;
        if (isRateLimitOrServerError(error)) {
          this.cooldownUntil.set(this.gemini.name, Date.now() + this.rateLimitCooldownMs);
        }
        if (!isFallbackWorthy(error)) throw error;
      }
    }
    if (!this.deepseek) {
      if (lastError instanceof Error) throw lastError;
      throw new ProviderRoutingError(
        "Gemini grounding is unavailable; supplemental research should be skipped",
        "GEMINI_GROUNDING_UNAVAILABLE",
      );
    }
    return this.deepseek.generateJSON<T>({ ...request, task: "research" });
  }

  /**
   * Vision passthrough (ImageDescribingProvider): OpenRouter first, Gemini as
   * the last-resort fallback. Providers lacking the extension are skipped via
   * structural check; undefined means no caption is available anywhere.
   */
  async describeImage(bytes: ArrayBuffer, contentType: string): Promise<ImageDescription | undefined> {
    for (const provider of [this.openrouter, this.gemini]) {
      const vision = provider as ImageDescribingProvider | undefined;
      if (typeof vision?.describeImage !== "function") continue;
      const description = await vision.describeImage(bytes, contentType);
      if (description) return description;
    }
    return undefined;
  }

  /**
   * Transcription passthrough (AudioTranscribingProvider): OpenRouter first,
   * Gemini as the last-resort fallback. Providers lacking the extension are
   * skipped via structural check; undefined means no transcript is available.
   */
  async transcribeAudio(bytes: ArrayBuffer, contentType: string): Promise<AudioTranscription | undefined> {
    for (const provider of [this.openrouter, this.gemini]) {
      const transcriber = provider as AudioTranscribingProvider | undefined;
      if (typeof transcriber?.transcribeAudio !== "function") continue;
      const transcription = await transcriber.transcribeAudio(bytes, contentType);
      if (transcription) return transcription;
    }
    return undefined;
  }

  /**
   * DeepSeek first for text work; OpenRouter first for research, long context,
   * and veryDeep — the tasks Gemini used to lead before its free tier started
   * 429ing. Every order ends with the remaining providers as rate-limit
   * fallbacks. Video/grounding bypass this method entirely.
   */
  private candidatesFor(request: StructuredGenerationRequest): StructuredProvider[] {
    const openrouterFirst =
      request.task === "youtube" ||
      request.task === "longContext" ||
      request.task === "research" ||
      request.depth === "veryDeep";
    const ordered = openrouterFirst
      ? [this.openrouter, this.gemini, this.deepseek]
      : this.preferred === "gemini"
        ? [this.gemini, this.openrouter, this.deepseek]
        : [this.deepseek, this.openrouter, this.gemini];
    return ordered.filter((candidate): candidate is StructuredProvider => Boolean(candidate));
  }
}

export class ProviderRoutingError extends Error {
  constructor(
    message: string,
    readonly code: "GEMINI_VIDEO_UNAVAILABLE" | "GEMINI_GROUNDING_UNAVAILABLE" | "NO_PROVIDER",
  ) {
    super(message);
    this.name = "ProviderRoutingError";
  }
}

export function createProviderRouter(options: ProviderRouterOptions): ProviderRouter {
  return new ProviderRouter(options);
}
