/**
 * Calendar days as plan stages carry them (migrations/0017): YYYY-MM-DD,
 * with no time or zone. Which day is today is the person's, so it always
 * comes from the app they are using, never from this computer's clock.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True for a real calendar day written YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

function epochDay(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date) / MS_PER_DAY;
}

/** The day `days` after `day` (before it when negative). */
export function addDays(day: string, days: number): string {
  return new Date((epochDay(day) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** How many days `to` is after `from`; negative when it is before. */
export function daysBetween(from: string, to: string): number {
  return epochDay(to) - epochDay(from);
}
