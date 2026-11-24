/**
 * Retries and the error engines throw, shared by every engine.
 */
import { isFinalProviderError, isRateLimitOrServerError } from "../net";
import type { SchemaError } from "../cards/blocks";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;

export interface RetryOptions {
  maxAttempts?: number;
  sleep: (milliseconds: number) => Promise<void>;
  beforeAttempt?: () => Promise<void> | void;
}

/**
 * Retries one provider step. Rate limits and upstream overloads get a real
 * backoff (3 s, 10 s, 25 s), anything else a short one; a saturated provider
 * would otherwise burn every attempt in under a second. A refused account
 * and an error marked final are not retried.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await options.beforeAttempt?.();
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // A refused account (out of credit, bad key) or a final error is the same on every attempt.
      if (attempt === maxAttempts || isFinalProviderError(error)) break;
      await options.sleep(retryDelayMs(attempt, error));
    }
  }
  throw lastError instanceof Error ? lastError : new PipelineError("Pipeline operation failed", "OPERATION_FAILED");
}

function retryDelayMs(attempt: number, error: unknown): number {
  if (isRateLimitOrServerError(error)) {
    const schedule = [3_000, 10_000, 25_000];
    return schedule[Math.min(attempt - 1, schedule.length - 1)];
  }
  return DEFAULT_BACKOFF_MS * 2 ** (attempt - 1);
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly validationErrors?: SchemaError[],
  ) {
    super(message);
    this.name = "PipelineError";
  }
}

export function isRetryablePipelineError(error: unknown): boolean {
  if (!(error instanceof PipelineError)) return true;
  // EMPTY_STRUCTURE stays retryable: a section-less plan or an all-sections
  // failure is probabilistic model/provider behaviour, not a deterministic
  // defect like a schema or URL violation — a later run can succeed.
  // A source with no text, or settings the engine cannot use, will be the same next time.
  return !["VALIDATION_FAILED", "INVALID_SECTION_OUTPUT", "INVALID_BLUEPRINT", "NO_SOURCE_TEXT", "INVALID_SETTINGS"].includes(error.code);
}
