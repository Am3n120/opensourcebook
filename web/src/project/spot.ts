/** A span of the source's text to show marked: a cited spot. */
export interface Spot {
  charStart: number;
  charEnd: number;
  quote?: string;
  /** The cite chip number the spot was opened from, drawn beside the marked words. */
  n?: number;
}

/** The span to mark: the quote inside the spot when it is there, else the spot. Undefined when the spot is outside the text. */
export function markSpan(text: string, spot: Spot): [number, number] | undefined {
  const start = Math.max(0, spot.charStart);
  const end = Math.min(text.length, spot.charEnd);
  if (end <= start) return undefined;
  if (spot.quote) {
    const at = text.slice(start, end).toLowerCase().indexOf(spot.quote.toLowerCase());
    if (at >= 0) return [start + at, start + at + spot.quote.length];
  }
  return [start, end];
}

