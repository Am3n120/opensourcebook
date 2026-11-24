/**
 * Open Sourcebook's own writer's working shapes: the section outline it plans, and what
 * a writer hands back for one section before the set is assembled. The
 * payload itself is `CardSet` in src/cards/contract.ts.
 */
import type { ByteBlock, ByteType } from "../../cards/blocks";
import type { Card } from "../../cards/contract";

export interface StructureSection {
  id: string;
  title: string;
  purpose: string;
  suggestedBlocks: string[];
  /**
   * For a long item: the passages (by id) this section covers, from the
   * range the planner named on the map (engine/docs/long-sources.md). Absent
   * when the item is short enough for every section to read all of it.
   */
  passages?: string[];
  /** The range as the planner wrote it, until the engine resolves it into `passages`. */
  range?: string[];
}

export interface StructurePlan {
  type: ByteType;
  title: string;
  subtitle: string;
  sourceDomain?: string;
  author?: string;
  tags: string[];
  excerpt?: string;
  durationText?: string;
  sections: StructureSection[];
}

export interface SectionDraft {
  sectionID: string;
  /** Cards in order, cites already resolved to passages; ids are set when the set is assembled. */
  cards: Card[];
}

export interface SetMetadata {
  type: ByteType;
  title: string;
  subtitle: string;
  sourceDomain?: string;
  author?: string;
  tags: string[];
  excerpt?: string;
  durationText?: string;
}

/** A card as a writer may return it: its kind, its sides, cites by passage label (block counted front, then back). */
export interface DraftCard {
  id?: string;
  kind?: string;
  front: ByteBlock[];
  back?: ByteBlock[];
  cites?: Array<{ passage?: string; quote?: string; block?: number }>;
}
