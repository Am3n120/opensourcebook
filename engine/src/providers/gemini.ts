import type {
  AudioTranscribingProvider,
  AudioTranscription,
  FetchLike,
  ImageDescribingProvider,
  ImageDescription,
  PriceTable,
  StructuredGenerationRequest,
  UsageEvent,
  UsageError,
  UsageSink,
} from "../types";
import { toBase64 } from "./shared";
import { estimateUSD, priceFor, safeRecord, usageErrorOf, tokensFromGeminiUsage } from "./usage";

export interface GeminiProviderOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Receives one UsageEvent per upstream call. */
  usageSink?: UsageSink;
  /** USD per million tokens by model id; enables the usd estimate. */
  prices?: PriceTable;
}

export interface GeminiGenerationConfig {
  responseMimeType: "application/json";
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GeminiPart {
  text?: string;
  fileData?: {
    fileUri: string;
    mimeType: string;
  };
  inlineData?: {
    data: string;
    mimeType: string;
  };
}

export interface GeminiRequestBody {
  contents: Array<{
    role: "user";
    parts: GeminiPart[];
  }>;
  generationConfig: GeminiGenerationConfig;
  tools?: Array<{ googleSearch: Record<string, never> }>;
}

export interface GeminiResponseBody {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  error?: { message?: string; status?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Gemini's inlineData ceiling is ~20MB per request; larger media is skipped, not attempted. */
const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export class GeminiProvider implements ImageDescribingProvider, AudioTranscribingProvider {
  readonly name = "gemini";
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly usageSink?: UsageSink;
  private readonly prices?: PriceTable;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "gemini-2.5-flash";
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.usageSink = options.usageSink;
    this.prices = options.prices;
  }

  async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
    return this.generate<T>(request);
  }

  async generateGroundedJSON<T>(request: StructuredGenerationRequest): Promise<T> {
    return this.generate<T>({ ...request, grounding: true });
  }

  async generateYouTubeJSON<T>(request: StructuredGenerationRequest & { youtubeURL: string }): Promise<T> {
    return this.generate<T>(request, request.youtubeURL);
  }

  /**
   * Vision extension (ImageDescribingProvider): describes image bytes via
   * inlineData. Extraction treats undefined as "no caption available", so any
   * failure — unconfigured key, oversize media, upstream error, malformed JSON
   * — resolves undefined instead of throwing.
   */
  async describeImage(bytes: ArrayBuffer, contentType: string): Promise<ImageDescription | undefined> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_MEDIA_BYTES) return undefined;
    try {
      const description = await this.generate<ImageDescription>({
        systemPrompt: "Return only valid JSON. Do not invent captions, visible text, or metadata.",
        userPrompt: [
          "Describe the attached image for a knowledge card.",
          'Return a JSON object with optional string fields: "title" (a short descriptive title),',
          '"caption" (one paragraph describing what the image shows), and',
          '"textContent" (any text visible inside the image, transcribed verbatim).',
          "Omit fields you cannot determine honestly.",
        ].join(" "),
      }, undefined, { data: toBase64(bytes), mimeType: contentType }, "describeImage");
      return description && typeof description === "object" ? description : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Transcription extension (AudioTranscribingProvider): transcribes audio
   * bytes via inlineData. Same defensive contract as describeImage — undefined
   * on any failure, never a throw into extraction.
   */
  async transcribeAudio(bytes: ArrayBuffer, contentType: string): Promise<AudioTranscription | undefined> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_MEDIA_BYTES) return undefined;
    try {
      const transcription = await this.generate<AudioTranscription>({
        systemPrompt: "Return only valid JSON. Do not invent transcript text or metadata.",
        userPrompt: [
          "Transcribe the attached audio.",
          'Return a JSON object with optional string fields: "text" (the verbatim transcript) and',
          '"language" (the BCP-47 language tag of the speech).',
          "Omit fields you cannot determine honestly.",
        ].join(" "),
      }, undefined, { data: toBase64(bytes), mimeType: contentType }, "transcribeAudio");
      return transcription && typeof transcription === "object" ? transcription : undefined;
    } catch {
      return undefined;
    }
  }

  private async generate<T>(
    request: StructuredGenerationRequest,
    youtubeURL?: string,
    inlineMedia?: { data: string; mimeType: string },
    taskOverride?: UsageEvent["task"],
  ): Promise<T> {
    if (!this.apiKey) {
      throw new GeminiProviderError("Gemini provider is not configured", "NOT_CONFIGURED");
    }
    const startedAt = Date.now();
    let tokens: { tokensIn?: number; tokensOut?: number } = {};
    let ok = false;
    let error: UsageError | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const endpoint = `${this.baseURL}/models/${encodeURIComponent(this.model)}:generateContent`;
    const body: GeminiRequestBody = {
      contents: [
        {
          role: "user",
          parts: [
            ...(youtubeURL
              ? [{ fileData: { fileUri: youtubeURL, mimeType: "video/*" } }]
              : []),
            ...(inlineMedia
              ? [{ inlineData: { data: inlineMedia.data, mimeType: inlineMedia.mimeType } }]
              : []),
            { text: `${request.systemPrompt}\n\n${request.userPrompt}` },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
      ...(request.grounding ? { tools: [{ googleSearch: {} }] } : {}),
    };

    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new GeminiProviderError(`Gemini request failed (${response.status})`, "UPSTREAM_HTTP", response.status);
      }
      const payload = (await response.json()) as GeminiResponseBody;
      tokens = tokensFromGeminiUsage(payload.usageMetadata);
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!text) {
        throw new GeminiProviderError("Gemini returned no JSON content", "EMPTY_OUTPUT");
      }
      const parsed = parseJSON<T>(text);
      ok = true;
      return parsed;
    } catch (cause) {
      error = usageErrorOf(cause);
      if (cause instanceof GeminiProviderError) throw cause;
      const message = cause instanceof Error && cause.name === "AbortError" ? "Gemini request timed out" : "Gemini request failed";
      throw new GeminiProviderError(message, "NETWORK", undefined, cause);
    } finally {
      clearTimeout(timeout);
      safeRecord(this.usageSink, {
        provider: this.name,
        model: this.model,
        task: taskOverride ?? (youtubeURL ? "youtube" : request.task),
        ...tokens,
        usd: estimateUSD(priceFor(this.prices, this.model), tokens.tokensIn, tokens.tokensOut),
        latencyMs: Date.now() - startedAt,
        ok,
        ...(error ? { error } : {}),
      });
    }
  }
}

export class GeminiProviderError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "UPSTREAM_HTTP" | "EMPTY_OUTPUT" | "INVALID_JSON" | "NETWORK",
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

export function parseJSON<T>(text: string): T {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(normalized) as T;
  } catch (cause) {
    throw new GeminiProviderError("Provider returned invalid JSON", "INVALID_JSON", undefined, cause);
  }
}

export function createGeminiProvider(options: GeminiProviderOptions = {}): GeminiProvider {
  return new GeminiProvider(options);
}
