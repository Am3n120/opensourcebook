/**
 * Shared fetch / URL / error-classification helpers. The August engine carried
 * eight private copies of `boundedFetch` and `hostname`; every module now
 * imports from here so a fix lands once.
 */
import type { FetchLike } from "./types/provider";

/** Fetch with a hard timeout. Resolves `undefined` on any failure instead of throwing. */
export async function boundedFetch(
  url: string,
  fetchImpl: FetchLike,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function isHTTPURL(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostname(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hex SHA-256 of bytes, or of a string's UTF-8 encoding. */
export async function sha256Hex(value: ArrayBuffer | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

/** True only for rate limiting (HTTP 429 or a quota message); 5xx is not included. */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (errorStatus(error) === 429) return true;
  const message = errorMessage(error);
  return /\b429\b/.test(message) || /rate.?limit|resource.?exhausted|quota/i.test(message);
}

/** True when a provider call failed because of rate limiting or a 5xx. */
export function isRateLimitOrServerError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = errorStatus(error);
  if (status === 429 || (status !== undefined && status >= 500 && status < 600)) return true;
  const message = errorMessage(error);
  return /\b(429|500|502|503|504)\b/.test(message) || /rate.?limit|overloaded|resource.?exhausted|quota/i.test(message);
}

/**
 * Slow or unreachable upstreams (client-side timeouts, socket failures) are as
 * fallback-worthy as explicit rate limits: providers report them with a
 * NETWORK code and "timed out" messages, never an HTTP status.
 */
export function isTimeoutOrNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: unknown }).code === "NETWORK") return true;
  return /timed?\s?out|timeout|network|econnreset|econnrefused|socket/i.test(errorMessage(error));
}

export function isFallbackWorthyError(error: unknown): boolean {
  return isRateLimitOrServerError(error) || isTimeoutOrNetworkError(error);
}

/** Retries `operation` on rate-limit errors only, waiting `delaysMs[attempt]` between tries. */
export async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = [5_000, 20_000],
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === delaysMs.length || !isRateLimitError(error)) break;
      await sleepImpl(delaysMs[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("provider call failed");
}

/**
 * Why a provider refused the account, in plain words, when it did: 402 is
 * out of credit, 401 and 403 a refused key. Undefined for anything else.
 * A retry cannot change either, so nothing retries or redelivers it.
 */
export function accountProblem(error: unknown): string | undefined {
  const refusal = accountRefusal(error);
  if (!refusal) return undefined;
  const name = error instanceof Error ? error.name.replace(/ProviderError$/, "") : "";
  const provider = name && name !== "Error" ? `The ${name}` : "The model";
  return refusal === "outOfCredit"
    ? `${provider} account is out of credit, so no model could be called. Add credit or set another provider, then try again.`
    : `${provider} key was refused, so no model could be called. Check the key, then try again.`;
}

/** How the model account refused a call: out of credit (402) or the key refused (401, 403). Undefined for any other error. */
export function accountRefusal(error: unknown): "outOfCredit" | "keyRefused" | undefined {
  const status = errorStatus(error);
  if (status === 402) return "outOfCredit";
  if (status === 401 || status === 403) return "keyRefused";
  return undefined;
}

/** True when retrying cannot help: a refused account, or an error that says it is final (`retryable: false`). */
export function isFinalProviderError(error: unknown): boolean {
  if (accountProblem(error) !== undefined) return true;
  return Boolean(error && typeof error === "object" && (error as { retryable?: unknown }).retryable === false);
}
