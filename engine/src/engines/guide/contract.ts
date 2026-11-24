/**
 * The guide payload (engine/docs/guide.md is the contract): a page or a few
 * of notes to keep, print and change by hand. Sections, each a list of
 * points; a point is one claim with the passages it rests on, or background
 * (the maker's own explanation, shown as such), or the person's own words
 * once they have changed or added it.
 */
import type { Citation, SourceLocator } from "../../studio/types";

export const GUIDE_SCHEMA_VERSION = 1;

export const GUIDE_LIMITS = {
  title: 200,
  about: 400,
  sectionTitle: 100,
  sections: 30,
  /** Points in one section. */
  points: 40,
  term: 80,
  pointText: 1_200,
  cites: 4,
  quote: 300,
  lengthNote: 300,
  /** The most pages a guide may be asked to run. */
  maxPages: 10,
} as const;

/**
 * Words on one printed page of notes: dense, short lines under headings,
 * about half of a page of prose. Only ever said as "about".
 */
export const WORDS_PER_PAGE = 450;

export interface GuideCite {
  sourceId: string;
  chunkId?: string;
  locator?: SourceLocator;
  quote: string;
}

export interface GuidePoint {
  id: string;
  /** A key word or name the point is about, shown first and strong; absent for a plain point. */
  term?: string;
  /** The claim, in the inline marks cards use (bold, italic, code, links, $math$). */
  text: string;
  /** The maker's own explanation, not from the sources: never cited. */
  background: boolean;
  cites: GuideCite[];
  /** The person wrote or changed it by hand. */
  yours?: boolean;
  /** What the maker wrote, kept when the person changed it, so they can go back to it. */
  made?: { term?: string; text: string };
}

export interface GuideSection {
  id: string;
  title: string;
  points: GuidePoint[];
}

export interface GuidePayload {
  schemaVersion: number;
  title: string;
  about: string;
  sections: GuideSection[];
  lengthNote?: string;
  /** When the person last changed it by hand. */
  editedAt?: string;
}

/** Words in some text, as a reader counts them. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Words in the whole guide: titles, terms and points. */
export function guideWords(guide: Pick<GuidePayload, "sections">): number {
  return guide.sections.reduce((total, section) => total + wordCount(section.title) + section.points.reduce((sum, point) => sum + wordCount(`${point.term ?? ""} ${point.text}`), 0), 0);
}

/** About how many printed pages some words fill, to a half page. */
export function pagesOf(words: number): number {
  return Math.max(0.5, Math.round((words / WORDS_PER_PAGE) * 2) / 2);
}

/** "1 page", "2½ pages", "half a page". */
export function pagesWords(pages: number): string {
  if (pages <= 0.5) return "half a page";
  const whole = Math.floor(pages);
  const half = pages - whole >= 0.5;
  return `${whole}${half ? "½" : ""} page${pages > 1 ? "s" : ""}`;
}

/** The citations of a guide as an output keeps them, each anchored at its point. */
export function guideCitations(sections: GuideSection[]): Citation[] {
  return sections.flatMap((section, s) =>
    section.points.flatMap((point, p) =>
      point.cites.map((cite) => ({ sourceId: cite.sourceId, ...(cite.chunkId ? { chunkId: cite.chunkId } : {}), ...(cite.locator ? { locator: cite.locator } : {}), quote: cite.quote, anchor: `sections[${s}].points[${p}]` })),
    ),
  );
}
