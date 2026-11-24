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
import { estimateUSD, priceFor, safeRecord, usageErrorOf, tokensFromOpenAIUsage } from "./usage";

export interface OpenRouterProviderOptions {
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

export type OpenRouterContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "video_url"; video_url: { url: string } };

export interface OpenRouterMessage {
  role: "system" | "user";
  content: string | OpenRouterContentPart[];
}

export interface OpenRouterRequestBody {
  model: string;
  messages: OpenRouterMessage[];
  response_format: { type: "json_object" };
  temperature?: number;
}

export interface OpenRouterResponseBody {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "google/gemini-3.6-flash";
/** Same ceiling as Gemini's inlineData; larger media is skipped, not attempted. */
const MAX_INLINE_MEDIA_BYTES = 20 * 1024 * 1024;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * OpenRouter speaks the OpenAI chat/completions shape, so this mirrors the
 * DeepSeek adapter; the model id selects the upstream (multimodal models
 * accept image_url / input_audio content parts). It is the primary
 * non-text/multimodal engine — Google Gemini is the last-resort fallback.
 */
export class OpenRouterProvider implements ImageDescribingProvider, AudioTranscribingProvider {
  readonly name = "openrouter";
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly usageSink?: UsageSink;
  private readonly prices?: PriceTable;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.usageSink = options.usageSink;
    this.prices = options.prices;
  }

  async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
    return this.chat<T>([
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ], request.task);
  }

  /**
   * YouTube understanding via the video_url part — the Gemini upstream
   * ingests the watch URL directly (verified live 2026-08-09 with
   * google/gemini-3.6-flash), so no Google-direct API is required.
   */
  async generateYouTubeJSON<T>(request: StructuredGenerationRequest & { youtubeURL: string }): Promise<T> {
    return this.chat<T>([
      { role: "system", content: request.systemPrompt },
      {
        role: "user",
        content: [
          { type: "video_url", video_url: { url: request.youtubeURL } },
          { type: "text", text: request.userPrompt },
        ],
      },
    ], request.task ?? "youtube");
  }

  /**
   * Vision extension (ImageDescribingProvider): describes image bytes as a
   * data-URI image_url part. Same contract as the Gemini adapter — extraction
   * treats undefined as "no caption available", so any failure resolves
   * undefined instead of throwing.
   */
  async describeImage(bytes: ArrayBuffer, contentType: string): Promise<ImageDescription | undefined> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_MEDIA_BYTES) return undefined;
    try {
      const description = await this.chat<ImageDescription>([
        { role: "system", content: "Return only valid JSON. Do not invent captions, visible text, or metadata." },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Describe the attached image for a knowledge card.",
                'Return a JSON object with optional string fields: "title" (a short descriptive title),',
                '"caption" (one paragraph describing what the image shows), and',
                '"textContent" (any text visible inside the image, transcribed verbatim).',
                "Omit fields you cannot determine honestly.",
              ].join(" "),
            },
            { type: "image_url", image_url: { url: `data:${contentType};base64,${toBase64(bytes)}` } },
          ],
        },
      ], "describeImage");
      return description && typeof description === "object" ? description : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Transcription extension (AudioTranscribingProvider): transcribes audio
   * bytes as an input_audio part. Same defensive contract as describeImage —
   * undefined on any failure, never a throw into extraction.
   */
  async transcribeAudio(bytes: ArrayBuffer, contentType: string): Promise<AudioTranscription | undefined> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_INLINE_MEDIA_BYTES) return undefined;
    try {
      const transcription = await this.chat<AudioTranscription>([
        { role: "system", content: "Return only valid JSON. Do not invent transcript text or metadata." },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Transcribe the attached audio.",
                'Return a JSON object with optional string fields: "text" (the verbatim transcript) and',
                '"language" (the BCP-47 language tag of the speech).',
                "Omit fields you cannot determine honestly.",
              ].join(" "),
            },
            { type: "input_audio", input_audio: { data: toBase64(bytes), format: audioFormatFor(contentType) } },
          ],
        },
      ], "transcribeAudio");
      return transcription && typeof transcription === "object" ? transcription : undefined;
    } catch {
      return undefined;
    }
  }

  private async chat<T>(messages: OpenRouterMessage[], task?: UsageEvent["task"]): Promise<T> {
    if (!this.apiKey) {
      throw new OpenRouterProviderError("OpenRouter provider is not configured", "NOT_CONFIGURED");
    }
    const startedAt = Date.now();
    let tokens: { tokensIn?: number; tokensOut?: number } = {};
    let ok = false;
    let error: UsageError | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const endpoint = `${this.baseURL}/chat/completions`;
    const body: OpenRouterRequestBody = {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.2,
    };
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OpenRouterProviderError(`OpenRouter request failed (${response.status})`, "UPSTREAM_HTTP", response.status);
      }
      const payload = (await response.json()) as OpenRouterResponseBody;
      tokens = tokensFromOpenAIUsage(payload.usage);
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new OpenRouterProviderError("OpenRouter returned no JSON content", "EMPTY_OUTPUT");
      }
      const parsed = parseOpenRouterJSON<T>(text);
      ok = true;
      return parsed;
    } catch (cause) {
      error = usageErrorOf(cause);
      if (cause instanceof OpenRouterProviderError) throw cause;
      const message = cause instanceof Error && cause.name === "AbortError" ? "OpenRouter request timed out" : "OpenRouter request failed";
      throw new OpenRouterProviderError(message, "NETWORK", undefined, cause);
    } finally {
      clearTimeout(timeout);
      safeRecord(this.usageSink, {
        provider: this.name,
        model: this.model,
        task,
        ...tokens,
        usd: estimateUSD(priceFor(this.prices, this.model), tokens.tokensIn, tokens.tokensOut),
        latencyMs: Date.now() - startedAt,
        ok,
        ...(error ? { error } : {}),
      });
    }
  }
}

export class OpenRouterProviderError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "UPSTREAM_HTTP" | "EMPTY_OUTPUT" | "INVALID_JSON" | "NETWORK",
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OpenRouterProviderError";
  }
}

export function parseOpenRouterJSON<T>(text: string): T {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(normalized) as T;
  } catch (cause) {
    // Models sometimes wrap JSON in prose — extract the outermost balanced
    // object before declaring the output invalid.
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(normalized.slice(start, end + 1)) as T;
      } catch {
        // Fall through to the original error.
      }
    }
    throw new OpenRouterProviderError("Provider returned invalid JSON", "INVALID_JSON", undefined, cause);
  }
}

/** OpenRouter's input_audio format wants a bare codec name, not a MIME subtype. */
function audioFormatFor(contentType: string): string {
  const subtype = contentType.split(";")[0].split("/")[1]?.trim().toLowerCase() ?? "";
  if (subtype === "mpeg" || subtype === "x-mpeg" || subtype === "mp3") return "mp3";
  if (subtype === "x-wav" || subtype === "wave") return "wav";
  return subtype || "mp3";
}

export function createOpenRouterProvider(options: OpenRouterProviderOptions = {}): OpenRouterProvider {
  return new OpenRouterProvider(options);
}
