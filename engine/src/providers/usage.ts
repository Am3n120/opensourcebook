import type { ModelPrice, PriceTable, UsageError, UsageEvent, UsageSink } from "../types/provider";

/** Estimates USD from token counts; undefined when the model has no price or no counts. */
export function estimateUSD(
  price: ModelPrice | undefined,
  tokensIn: number | undefined,
  tokensOut: number | undefined,
): number | undefined {
  if (!price || tokensIn === undefined || tokensOut === undefined) return undefined;
  const usd = (tokensIn * price.inputPerMillion + tokensOut * price.outputPerMillion) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** The price in force on `at` (default now): the entry with the latest `effectiveFrom` not after it. */
export function priceFor(table: PriceTable | undefined, model: string, at: Date = new Date()): ModelPrice | undefined {
  const entry = table?.[model];
  if (!entry) return undefined;
  const day = at.toISOString().slice(0, 10);
  const schedule = Array.isArray(entry) ? entry : [entry];
  let chosen: ModelPrice | undefined;
  for (const price of schedule) {
    if (price.effectiveFrom && price.effectiveFrom > day) continue;
    if (!chosen || (price.effectiveFrom ?? "") >= (chosen.effectiveFrom ?? "")) chosen = price;
  }
  return chosen;
}

/** Collects events in memory; used by tests and by local dev without D1. */
export class InMemoryUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];

  record(event: UsageEvent): void {
    this.events.push(event);
  }

  totalUSD(): number {
    return this.events.reduce((sum, event) => sum + (event.usd ?? 0), 0);
  }
}

/** Swallows events. Default when no sink is configured. */
export const nullUsageSink: UsageSink = { record() {} };

/**
 * Wraps a sink so that a failing record() never fails a generation call.
 */
/**
 * Why a provider call failed, for its usage row. An abort is the adapter's
 * own timer (the request may still be answered and billed); an error with a
 * `code` the adapters use says the rest.
 */
export function usageErrorOf(cause: unknown): UsageError {
  if (cause instanceof Error && cause.name === "AbortError") return "timeout";
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (code === "UPSTREAM_HTTP") return "http";
  if (code === "EMPTY_OUTPUT" || code === "INVALID_JSON") return "output";
  return "network";
}

export function safeRecord(sink: UsageSink | undefined, event: UsageEvent): void {
  if (!sink) return;
  try {
    const result = sink.record(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => undefined);
    }
  } catch {
    // Usage logging is best effort.
  }
}

/** OpenAI-style `usage` object → token counts. */
export function tokensFromOpenAIUsage(usage: unknown): { tokensIn?: number; tokensOut?: number } {
  if (!usage || typeof usage !== "object") return {};
  const record = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  return {
    tokensIn: typeof record.prompt_tokens === "number" ? record.prompt_tokens : undefined,
    tokensOut: typeof record.completion_tokens === "number" ? record.completion_tokens : undefined,
  };
}

/** Gemini `usageMetadata` object → token counts. */
export function tokensFromGeminiUsage(usage: unknown): { tokensIn?: number; tokensOut?: number } {
  if (!usage || typeof usage !== "object") return {};
  const record = usage as { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
  return {
    tokensIn: typeof record.promptTokenCount === "number" ? record.promptTokenCount : undefined,
    tokensOut: typeof record.candidatesTokenCount === "number" ? record.candidatesTokenCount : undefined,
  };
}

/**
 * Passes events through to `inner` and remembers the writes still in
 * flight, so a job can wait for every call it made to be logged before it
 * sums its cost.
 */
export class SettlingUsageSink implements UsageSink {
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly inner: UsageSink) {}

  record(event: UsageEvent): void | Promise<void> {
    const result = this.inner.record(event);
    if (result && typeof (result as Promise<void>).then === "function") {
      const write = (result as Promise<void>).catch(() => undefined).finally(() => this.pending.delete(write));
      this.pending.add(write);
    }
    return result;
  }

  /** Resolves once every write started so far has finished (failed writes included). */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
