/**
 * A plan's size in a line, for the planner to read back and quote: how
 * many items of each shape, and the planned length where a shape's
 * settings give one in time. Read from the descriptors, so no shape is
 * named here: a setting whose unit is minutes is a length in time.
 */
import type { FormatRegistry } from "../../studio/registry";
import type { DraftPlan } from "./draft";

/** "15 videos (about 2 h 5 min), 3 quizzes; 18 items in 6 stages". Left-out items are not counted. */
export function planSize(draft: DraftPlan, registry: FormatRegistry): string {
  const items = draft.items.filter((item) => item.enabled);
  const byType = new Map<string, { count: number; minutes: number; timed: number }>();
  for (const item of items) {
    const entry = byType.get(item.type) ?? { count: 0, minutes: 0, timed: 0 };
    entry.count += 1;
    const minutes = minutesOf(registry, item.type, item.settings);
    if (minutes !== undefined) {
      entry.minutes += minutes;
      entry.timed += 1;
    }
    byType.set(item.type, entry);
  }
  const parts = [...byType].map(([type, entry]) => {
    const descriptor = registry.descriptor(type);
    const word = entry.count === 1 ? (descriptor?.singular ?? descriptor?.label ?? type) : (descriptor?.plural ?? `${descriptor?.label ?? type}s`);
    const time = entry.timed > 0 ? ` (about ${duration(entry.minutes)}${entry.timed < entry.count ? ` for ${entry.timed} of them` : ""})` : "";
    return `${entry.count} ${word}${time}`;
  });
  const stages = new Set(items.map((item) => item.level)).size;
  return `${parts.join(", ") || "nothing"}; ${items.length} item${items.length === 1 ? "" : "s"} in ${stages} stage${stages === 1 ? "" : "s"}`;
}

/** An item's planned length in minutes, from its format's setting in minutes; undefined when it sets none. */
export function minutesOf(registry: FormatRegistry, type: string, settings: Record<string, unknown>): number | undefined {
  const descriptor = registry.descriptor(type);
  const field = descriptor?.settings.find((candidate) => candidate.kind === "number" && candidate.unit === "min");
  if (!field) return undefined;
  const value = field.key in settings ? settings[field.key] : descriptor?.defaults[field.key];
  return typeof value === "number" && value > 0 ? value : undefined;
}

/** 45 min, 2 h 5 min. */
export function duration(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole < 60) return `${Math.max(1, whole)} min`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${hours} h${rest ? ` ${rest} min` : ""}`;
}
