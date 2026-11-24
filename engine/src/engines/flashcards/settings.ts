/**
 * What a set of flashcards may set: how many cards, which kinds of card, and
 * who makes it. Read by the descriptor (the settings form, the planner), the
 * makers and the plan's own words for an item.
 */
import type { GenerationDepth } from "../../cards/blocks";

export interface FlashcardSettings {
  /** How many cards; 0 lets the brief and the sources decide. */
  cards: number;
  /** The kinds of card the set may use; ids from the card kinds (cards/kinds.ts). */
  kinds: string[];
  /** Earlier summaries the writing should sound like (hidden; from older items). */
  exemplarSummaries: string[];
  /** The maker's id, or "auto" (absent) for the one Open Sourcebook picks (engines/makers.ts). */
  maker?: string;
  /** Who makes it when the person's agent does: "auto" (the default from Settings) or a pick id (engines/agent-fields.ts). */
  agent?: string;
  /** How hard that agent thinks: "auto" or an effort id. */
  effort?: string;
}

/** Most cards one set holds; a source with more becomes more than one set. */
export const MAX_CARDS = 200;

/**
 * How many cards a source of this size usually deserves when nothing says
 * otherwise: about eight for a thousand characters of text, growing with the
 * square root of its length, since a longer text repeats and elaborates more
 * than it adds new things to remember. A starting count, never a quota: the
 * maker writes what the material holds and says so when it differs.
 */
export function fitCardCount(sourceChars: number): number {
  if (sourceChars <= 0) return 0;
  return Math.max(4, Math.min(MAX_CARDS, Math.round(8 * Math.sqrt(sourceChars / 1000))));
}

/** The length Open Sourcebook's own writer plans its sections for, from a count of cards (0: from the sources). */
export function requestedDepthOf(settings: Pick<FlashcardSettings, "cards">): Exclude<GenerationDepth, "saveOnly"> {
  if (!settings.cards) return "auto";
  if (settings.cards <= 10) return "light";
  if (settings.cards <= 30) return "standard";
  return "deep";
}

/** Whether a set's size is clearly not the one planned: off by more than a card or two, and by more than a sixth. */
export function offPlan(made: number, planned: number): boolean {
  const off = Math.abs(made - planned);
  return off > 2 && off / planned > 1 / 6;
}
