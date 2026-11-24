/**
 * Per-turn usage log (`.opensourcebook/logs/usage.jsonl`): one JSON object per line, appended when a turn ends, and read back,
 * newest first, for `GET /usage`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type UsageOutcome = "done" | "failed" | "stopped";

export interface UsageLogEntry {
  time: string;
  type: string | null;
  targetId: string | null;
  turnId: string;
  agent: string;
  model: string | null;
  effort: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  durationMs: number;
  toolCalls: number;
  outcome: UsageOutcome;
}

/** Appends one JSONL entry to `path`, creating parent folders if needed. */
export function appendUsageLog(path: string, entry: UsageLogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * One finished turn as `GET /usage` serves it: the log's fields with what it did not report left out, and never the
 * reported cost (no screen shows money, docs/DECISIONS.md). `line` is its line in the log, counted from 1: a line
 * never moves, since the log is only appended to, so `before=<line>` pages back from it.
 */
export interface UsageTurn {
  line: number;
  time: string;
  turnId: string;
  agent: string;
  type?: string;
  targetId?: string;
  model?: string;
  effort?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  toolCalls: number;
  outcome: UsageOutcome;
}

export const USAGE_PAGE = 50;
export const USAGE_PAGE_MAX = 500;
const OUTCOMES: ReadonlySet<string> = new Set<UsageOutcome>(["done", "failed", "stopped"]);

/**
 * The newest `limit` turns of the log before line `before` (all of it when absent), newest first. `next` is the line
 * to pass as `before` for the turns older than these, when there are any. A log that is not there yet has no turns,
 * and a line that is not a turn (cut off by a crash, written by hand) is passed over.
 */
export async function readUsageLog(path: string, options: { limit?: number; before?: number } = {}): Promise<{ turns: UsageTurn[]; next?: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return { turns: [] };
    throw error;
  }
  const lines = text.split("\n");
  const limit = Math.max(1, Math.min(USAGE_PAGE_MAX, options.limit ?? USAGE_PAGE));
  const turns: UsageTurn[] = [];
  let index = Math.min(lines.length, (options.before ?? lines.length + 1) - 1);
  while (--index >= 0 && turns.length < limit) {
    const turn = usageTurn(lines[index]!, index + 1);
    if (turn) turns.push(turn);
  }
  // Only lines before the oldest one read are left; `next` is offered while any of them is not blank.
  const more = lines.slice(0, Math.max(0, index + 1)).some((line) => line.trim());
  return { turns, ...(more && turns.length > 0 ? { next: turns.at(-1)!.line } : {}) };
}

function usageTurn(raw: string, line: number): UsageTurn | undefined {
  if (!raw.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const text = (key: string, max = 200) => (typeof entry[key] === "string" && entry[key] ? (entry[key] as string).slice(0, max) : undefined);
  const count = (key: string) => (typeof entry[key] === "number" && Number.isFinite(entry[key]) && (entry[key] as number) >= 0 ? Math.round(entry[key] as number) : undefined);
  const time = text("time", 40);
  const turnId = text("turnId");
  const agent = text("agent", 40);
  if (!time || !Number.isFinite(Date.parse(time)) || !turnId || !agent) return undefined;
  const outcome = typeof entry.outcome === "string" && OUTCOMES.has(entry.outcome) ? (entry.outcome as UsageOutcome) : "failed";
  const optional = { type: text("type", 64), targetId: text("targetId"), model: text("model"), effort: text("effort", 64), inputTokens: count("inputTokens"), outputTokens: count("outputTokens"), cacheReadTokens: count("cacheReadTokens"), cacheWriteTokens: count("cacheWriteTokens") };
  return {
    line,
    time,
    turnId,
    agent,
    ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)),
    durationMs: count("durationMs") ?? 0,
    toolCalls: count("toolCalls") ?? 0,
    outcome,
  };
}
