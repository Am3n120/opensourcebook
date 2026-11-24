/**
 * Days on plan stages, on this device's calendar. The engine stores a day as
 * YYYY-MM-DD with no time or zone and never decides which day is today:
 * the app does, from the person's own clock, and sends it.
 */

export type DayWhen = "missed" | "today" | "soon" | "later";

const MS_PER_DAY = 86_400_000;

/** Today on this device, YYYY-MM-DD. */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y!, m!, d!];
}

/** How many days `to` is after `from`. */
export function daysFrom(from: string, to: string): number {
  const [a, b] = [parts(from), parts(to)];
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / MS_PER_DAY);
}

/** Where a day falls from today: before it, on it, within a week, or later. */
export function whenOf(day: string, today: string): DayWhen {
  const gap = daysFrom(today, day);
  return gap < 0 ? "missed" : gap === 0 ? "today" : gap <= 7 ? "soon" : "later";
}

/** A day in short words from today: "Today", "Tomorrow", "Yesterday", else "Mon 24 Nov" (in this device's language). */
export function dayWords(day: string, today: string): string {
  const gap = daysFrom(today, day);
  if (gap === 0) return "Today";
  if (gap === 1) return "Tomorrow";
  if (gap === -1) return "Yesterday";
  const [y, m, d] = parts(day);
  const at = new Date(y, m - 1, d);
  const sameYear = y === parts(today)[0];
  return at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** A day as a stage's chip says it: "Today", "Due Mon 24 Nov", "Missed yesterday". */
export function dueWords(day: string, missed: boolean, today: string): string {
  const words = dayWords(day, today);
  if (missed) return `Missed ${words === "Yesterday" ? "yesterday" : words}`;
  return words === "Today" || words === "Tomorrow" ? `Due ${words.toLowerCase()}` : `Due ${words}`;
}

/** A near day in the middle of a sentence: "yesterday", "today", else "Mon 24 Nov". */
export function dayInWords(day: string, today: string): string {
  const words = dayWords(day, today);
  return Math.abs(daysFrom(today, day)) <= 1 ? words.toLowerCase() : words;
}

/** True when a stage still has something to go through: an item in the plan, not skipped and not ticked done. */
export function hasLeft(stage: { rows: ReadonlyArray<{ item: { done: boolean; enabled: boolean; status: string } }> }): boolean {
  return stage.rows.some((r) => r.item.enabled && r.item.status !== "skipped" && !r.item.done);
}

/** The stages whose day passed with something still left in them. */
export function missedStages<S extends { dueOn?: string; rows: ReadonlyArray<{ item: { done: boolean; enabled: boolean; status: string } }> }>(stages: readonly S[], today: string): S[] {
  return stages.filter((s) => s.dueOn !== undefined && whenOf(s.dueOn, today) === "missed" && hasLeft(s));
}

/** A dated stage's name where its plan is not in view: its label, else its place in the plan. */
export function dueName(stage: { label?: string; number: number }): string {
  return stage.label ?? `Stage ${stage.number}`;
}
