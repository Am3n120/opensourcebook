import type {
  FetchLike,
  PriceTable,
  StructuredGenerationRequest,
  StructuredProvider,
  UsageError,
  UsageSink,
} from "../types";
import { estimateUSD, priceFor, safeRecord, usageErrorOf, tokensFromOpenAIUsage } from "./usage";

export interface DeepSeekProviderOptions {
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

export interface DeepSeekMessage {
  role: "system" | "user";
  content: string;
}

export interface DeepSeekRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  response_format: { type: "json_object" };
  temperature?: number;
}

export interface DeepSeekResponseBody {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export class DeepSeekProvider implements StructuredProvider {
  readonly name = "deepseek";
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly usageSink?: UsageSink;
  private readonly prices?: PriceTable;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "deepseek-chat";
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.usageSink = options.usageSink;
    this.prices = options.prices;
  }

  async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
    if (!this.apiKey) {
      throw new DeepSeekProviderError("DeepSeek provider is not configured", "NOT_CONFIGURED");
    }
    const startedAt = Date.now();
    let tokens: { tokensIn?: number; tokensOut?: number } = {};
    let ok = false;
    let error: UsageError | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const endpoint = `${this.baseURL}/chat/completions`;
    const body: DeepSeekRequestBody = {
      model: this.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt },
      ],
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
        throw new DeepSeekProviderError(`DeepSeek request failed (${response.status})`, "UPSTREAM_HTTP", response.status);
      }
      const payload = (await response.json()) as DeepSeekResponseBody;
      tokens = tokensFromOpenAIUsage(payload.usage);
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) {
        throw new DeepSeekProviderError("DeepSeek returned no JSON content", "EMPTY_OUTPUT");
      }
      const parsed = parseDeepSeekJSON<T>(text);
      ok = true;
      return parsed;
    } catch (cause) {
      error = usageErrorOf(cause);
      if (cause instanceof DeepSeekProviderError) throw cause;
      const message = cause instanceof Error && cause.name === "AbortError" ? "DeepSeek request timed out" : "DeepSeek request failed";
      throw new DeepSeekProviderError(message, "NETWORK", undefined, cause);
    } finally {
      clearTimeout(timeout);
      safeRecord(this.usageSink, {
        provider: this.name,
        model: this.model,
        task: request.task,
        ...tokens,
        usd: estimateUSD(priceFor(this.prices, this.model), tokens.tokensIn, tokens.tokensOut),
        latencyMs: Date.now() - startedAt,
        ok,
        ...(error ? { error } : {}),
      });
    }
  }
}

export class DeepSeekProviderError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "UPSTREAM_HTTP" | "EMPTY_OUTPUT" | "INVALID_JSON" | "NETWORK",
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DeepSeekProviderError";
  }
}

export function parseDeepSeekJSON<T>(text: string): T {
  const normalized = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(normalized) as T;
  } catch (cause) {
    // Models sometimes wrap JSON in prose ("Here is the JSON: … hope this
    // helps"). Extract the outermost balanced object before giving up.
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(normalized.slice(start, end + 1)) as T;
      } catch {
        // Fall through to the original error.
      }
    }
    throw new DeepSeekProviderError("Provider returned invalid JSON", "INVALID_JSON", undefined, cause);
  }
}

export function createDeepSeekProvider(options: DeepSeekProviderOptions = {}): DeepSeekProvider {
  return new DeepSeekProvider(options);
}
