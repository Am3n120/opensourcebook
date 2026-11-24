/**
 * Shared plumbing for media adapters (`src/types/media.ts`): the budget check
 * before a call, the abort checks around it, one usage event per upstream
 * request, and storing what came back in the asset store. Adapters only write
 * the vendor request and parse its answer.
 */
import type { AssetStore, PutAssetInput } from "../assets";
import type { BudgetGuard } from "./budget";
import type { UsageSink } from "../types/provider";
import type { MediaCallContext, MediaPrice, MediaPriceTable, MediaTask, SpokenWord, StoredMedia } from "../types/media";
import { safeRecord } from "./usage";

/** A call was refused because the job's budget cannot cover it. Nothing was spent. */
export class MediaBudgetError extends Error {
  constructor(
    message: string,
    readonly estimateUSD: number | undefined,
    readonly remainingUSD: number,
  ) {
    super(message);
    this.name = "MediaBudgetError";
  }
}

/** The adapter cannot do what was asked (no vision, no edit, no bucket bound). */
export class MediaCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaCapabilityError";
  }
}

/**
 * The media context for a job whose usage runs through `budget` (the guard the
 * output runner builds). Media adapters must report to that same guard, so
 * what they spend counts against what is left.
 */
export function mediaContextFrom(
  budget: Pick<BudgetGuard, "budgetUSD" | "spentUSD">,
  options: { signal?: AbortSignal; jobId?: string } = {},
): MediaCallContext {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.jobId ? { jobId: options.jobId } : {}),
    remainingUSD: () => (budget.budgetUSD === undefined ? undefined : budget.budgetUSD - budget.spentUSD),
  };
}

/** Cost of `units` at `price`, rounded to a millionth of a dollar. */
export function mediaUSD(price: MediaPrice | undefined, units: number | undefined): number | undefined {
  if (!price || units === undefined || !Number.isFinite(units) || units < 0) return undefined;
  return Math.round(price.usdPerUnit * units * 1_000_000) / 1_000_000;
}

export function mediaPriceFor(table: MediaPriceTable | undefined, model: string): MediaPrice | undefined {
  return table?.[model];
}

/** Refuses before any spend when the job has nothing left or the known price is above what is left. */
export function assertWithinBudget(ctx: MediaCallContext, estimateUSD: number | undefined): void {
  const remaining = ctx.remainingUSD?.();
  if (remaining === undefined) return;
  if (remaining <= 0) {
    throw new MediaBudgetError("The job's budget is spent", estimateUSD, remaining);
  }
  if (estimateUSD !== undefined && estimateUSD > remaining) {
    throw new MediaBudgetError(
      `This call costs about $${estimateUSD} and the job has $${remaining} left`,
      estimateUSD,
      remaining,
    );
  }
}

export interface MeteredCallInput<T> {
  provider: string;
  model: string;
  task: MediaTask;
  ctx: MediaCallContext;
  usage?: UsageSink;
  /** Known price of this call before it is made; drives the budget check. */
  estimateUSD?: number;
  /** The upstream request. Returns its result and, when the vendor says, the real cost. */
  call(signal: AbortSignal | undefined): Promise<{ result: T; usd?: number; tokensIn?: number; tokensOut?: number }>;
  now?: () => number;
}

/**
 * Runs one upstream media request: budget check, abort check, the call, one
 * usage event (also on failure, with no cost), abort check again so a
 * cancelled job does not go on to store or use the result.
 */
export async function meteredCall<T>(input: MeteredCallInput<T>): Promise<T> {
  const now = input.now ?? Date.now;
  input.ctx.signal?.throwIfAborted();
  assertWithinBudget(input.ctx, input.estimateUSD);
  const started = now();
  let outcome: Awaited<ReturnType<MeteredCallInput<T>["call"]>>;
  try {
    outcome = await input.call(input.ctx.signal);
  } catch (error) {
    // A failed request is logged too, with no cost, so failure rates show per vendor.
    safeRecord(input.usage, {
      provider: input.provider,
      model: input.model,
      task: input.task,
      latencyMs: now() - started,
      ok: false,
      ...(input.ctx.jobId ? { jobId: input.ctx.jobId } : {}),
    });
    throw error;
  }
  const { result, usd, tokensIn, tokensOut } = outcome;
  const cost = usd ?? input.estimateUSD;
  safeRecord(input.usage, {
    provider: input.provider,
    model: input.model,
    task: input.task,
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(tokensOut !== undefined ? { tokensOut } : {}),
    ...(cost !== undefined ? { usd: cost } : {}),
    latencyMs: now() - started,
    ok: true,
    ...(input.ctx.jobId ? { jobId: input.ctx.jobId } : {}),
  });
  input.ctx.signal?.throwIfAborted();
  return result;
}

/** Puts generated media in the asset store; an engine without a bucket cannot keep media. */
export async function storeMedia(
  assets: AssetStore,
  bytes: ArrayBuffer,
  input: PutAssetInput,
): Promise<StoredMedia> {
  const asset = await assets.putAsset(bytes, input);
  if (!asset) throw new MediaCapabilityError("No asset bucket is bound, so generated media cannot be stored");
  return { asset, bytes };
}

/**
 * Turns per-character timings (what speech vendors return) into words.
 * Only letters and digits move a word's start and end: vendors give
 * punctuation and spaces their own time slots, which would make words end
 * late. `starts` and `ends` are in milliseconds, one per character of `text`.
 */
export function wordsFromCharacterTimes(text: string, starts: number[], ends: number[]): SpokenWord[] {
  const chars = Array.from(text);
  if (starts.length !== chars.length || ends.length !== chars.length) {
    throw new RangeError("Character timings must have one start and one end per character");
  }
  const words: SpokenWord[] = [];
  let current: { charStart: number; charEnd: number; startMs?: number; endMs?: number } | undefined;
  let offset = 0;
  const close = () => {
    if (current && current.startMs !== undefined && current.endMs !== undefined) {
      words.push({
        text: text.slice(current.charStart, current.charEnd),
        charStart: current.charStart,
        charEnd: current.charEnd,
        startMs: current.startMs,
        endMs: current.endMs,
      });
    }
    current = undefined;
  };
  chars.forEach((char, index) => {
    const width = char.length;
    if (/\s/u.test(char)) {
      close();
    } else {
      current ??= { charStart: offset, charEnd: offset };
      current.charEnd = offset + width;
      if (/[\p{L}\p{N}]/u.test(char)) {
        current.startMs ??= starts[index];
        current.endMs = ends[index];
      }
    }
    offset += width;
  });
  close();
  return words;
}

export interface WordTimingIssue {
  index: number;
  problem: string;
}

/**
 * Checks that word timings can drive captions and sync: in order, not
 * overlapping, inside the audio, and pointing at the words of the text.
 */
export function checkWordTimings(text: string, words: SpokenWord[], durationMs: number): WordTimingIssue[] {
  const issues: WordTimingIssue[] = [];
  let lastEnd = 0;
  let lastChar = 0;
  words.forEach((word, index) => {
    if (word.startMs > word.endMs) issues.push({ index, problem: "starts after it ends" });
    if (word.startMs < lastEnd) issues.push({ index, problem: "overlaps the word before" });
    if (word.endMs > durationMs) issues.push({ index, problem: "ends after the audio" });
    if (word.charStart < lastChar || word.charEnd > text.length || word.charStart >= word.charEnd) {
      issues.push({ index, problem: "character range is outside the text or out of order" });
    } else if (text.slice(word.charStart, word.charEnd) !== word.text) {
      issues.push({ index, problem: "text does not match its character range" });
    }
    lastEnd = Math.max(lastEnd, word.endMs);
    lastChar = Math.max(lastChar, word.charEnd);
  });
  return issues;
}
