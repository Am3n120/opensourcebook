import type { AccessLevel, AssetRef, ByteDepth, SourceReference } from "../types";

/**
 * What one extraction module contributes. Every field is optional: the ladder
 * that owns the source merges module results over its own defaults and keeps
 * the caller-supplied text.
 */
export interface ModuleExtraction {
  text?: string;
  title?: string;
  author?: string;
  canonicalURL?: string;
  excerpt?: string;
  metadata?: Record<string, string>;
  assets?: AssetRef[];
  references?: SourceReference[];
  accessLevel?: AccessLevel;
  depthCap?: ByteDepth;
  /** Plain lines for the person (see `ReadingGaps` in ./limits). */
  limitations?: string[];
  /** Technical lines for logs. */
  extractionNotes?: string[];
}
