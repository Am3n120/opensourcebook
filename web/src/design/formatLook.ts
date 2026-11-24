/**
 * How a format looks on screen: its label, colour slot and icon, taken from
 * the descriptors GET /v1/formats serves. Nothing here names a format.
 */
export interface FormatLook {
  id: string;
  label: string;
  colorSlot: number;
  icon: string;
}

/** The part of a format descriptor a badge needs. */
export interface FormatLike extends FormatLook {
  aliases?: string[];
}

/** Slots that exist in tokens.css (--fmt-1-* to --fmt-8-*). */
export const SLOT_COUNT = 8;
/** The neutral slot for an id no descriptor knows (docs/GLOSSARY.md). */
export const NEUTRAL_SLOT = 8;

/** Finds the descriptor for an id or one of its aliases. */
export function findFormat<T extends FormatLike>(formats: readonly T[], id: string): T | undefined {
  return formats.find((f) => f.id === id) ?? formats.find((f) => f.aliases?.includes(id));
}

/** The look for a stored format id; an unknown id keeps its own text on a neutral badge. */
export function lookFor(formats: readonly FormatLike[], id: string): FormatLook {
  const f = findFormat(formats, id);
  if (!f) return { id, label: id, colorSlot: NEUTRAL_SLOT, icon: "doc" };
  const slot = Number.isInteger(f.colorSlot) && f.colorSlot >= 1 && f.colorSlot <= SLOT_COUNT ? f.colorSlot : NEUTRAL_SLOT;
  return { id: f.id, label: f.label, colorSlot: slot, icon: f.icon };
}
