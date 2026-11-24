/**
 * The clock of a quiz with a time limit (engine quiz schema `timeLimit`):
 * it starts when the person presses Start, keeps running while they are
 * elsewhere, and at zero the quiz ends as it stands.
 */

/** The time now, in milliseconds. */
export function clockNow(): number {
  return Date.now();
}

/** Milliseconds left, never below zero. */
export function msLeft(startedAt: number, limitMinutes: number, now: number): number {
  return Math.max(0, startedAt + limitMinutes * 60_000 - now);
}

/** "4:05", or "1:02:09" from an hour up; a part second counts as a whole one, so 0:00 is only the end. */
export function clockWords(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1_000);
  const h = Math.floor(total / 3_600);
  const m = Math.floor((total % 3_600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** What the result keeps of the clock: seconds from Start to the end, at most the limit, and whether the time ran out. */
export function timing(startedAt: number, endedAt: number, limitMinutes: number): { seconds: number; timedOut: boolean } {
  const limit = limitMinutes * 60;
  const seconds = Math.min(limit, Math.max(0, Math.round((endedAt - startedAt) / 1_000)));
  return { seconds, timedOut: endedAt - startedAt >= limit * 1_000 };
}

/** "34 minutes", "1 minute", "under a minute". */
export function minutesWords(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m === 0) return "under a minute";
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/**
 * What a screen reader is told as the clock passes 5 minutes left and then
 * 1 minute: the words change only at those marks, so each is said once. A
 * mark at or past the whole limit is not one the clock passes, so it is left out.
 */
export function warningFor(left: number, limitMinutes: number): string {
  const marks = [1, 5].filter((m) => m < limitMinutes);
  const mark = marks.find((m) => left <= m * 60_000);
  return mark === undefined ? "" : `${mark} minute${mark === 1 ? "" : "s"} left`;
}
