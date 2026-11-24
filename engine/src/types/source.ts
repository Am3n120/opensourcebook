/** Sources: what a job reads. One source is extracted once and cached by hash (engine/README.md). */
import type { ByteType, ByteDepth } from "../cards/blocks";
import type { AssetStore } from "../assets";
import type { FetchLike, StructuredProvider } from "./provider";
import { BYTE_TYPES } from "../cards/blocks";

export type SourceKind =
  | ByteType
  | "text"
  | "pdf"
  | "web"
  | "youtube"
  | "social"
  | "unknown";
export const SOURCE_KINDS: readonly SourceKind[] = [
  ...BYTE_TYPES,
  "text",
  "pdf",
  "web",
  "youtube",
  "social",
  "unknown",
];

export type AccessLevel = "full" | "partial" | "metadata" | "none";
export const ACCESS_LEVELS: readonly AccessLevel[] = ["full", "partial", "metadata", "none"];

export interface SourceReference {
  url: string;
  title?: string;
  domain?: string;
  label: "source" | "supplemental";
  relation?: string;
}

export type AssetKind = "image" | "figure" | "frame" | "slide" | "thumbnail" | "audio" | "video";
export const ASSET_KINDS: readonly AssetKind[] = [
  "image",
  "figure",
  "frame",
  "slide",
  "thumbnail",
  "audio",
  "video",
];

/**
 * A harvested media asset persisted in the assets R2 bucket. `url` is the
 * worker-relative `/v1/assets/<id>` path; serving resolves the host.
 */
export interface AssetRef {
  id: string;
  kind: AssetKind;
  url: string;
  sourceURL?: string;
  caption?: string;
  page?: number;
  timestampMs?: number;
  width?: number;
  height?: number;
  contentType?: string;
}

/**
 * Between two pages of a source's text (a form feed on its own line). A
 * ladder that knows where pages end puts one between every two pages, empty
 * pages included, so the text before the nth break is pages 1 to n. The
 * chunker never lets a passage cross one and gives each passage its page.
 */
export const PAGE_BREAK = "\n\f\n";

export interface SourceEnvelope {
  originalText: string;
  originalURL?: string;
  kind: SourceKind;
  canonicalURL?: string;
  title?: string;
  author?: string;
  sourceDomain?: string;
  excerpt?: string;
  text: string;
  references: SourceReference[];
  assets?: AssetRef[];
  metadata: Record<string, string>;
  accessLevel: AccessLevel;
  depthCap: ByteDepth;
  /**
   * What could not be read, in plain words a client shows to a person: short
   * sentences about the source, never how the reading worked.
   */
  limitations: string[];
  /**
   * How the reading went, in technical words, for logs: every gap behind a
   * limitation plus notes no person needs ("rendered in a browser").
   * Absent on extractions stored before Nov 13, 2026.
   */
  extractionNotes?: string[];
  fetchedAt: string;
}

export interface SupplementalReference extends SourceReference {
  label: "supplemental";
  reason: string;
}

/** Structured, no-key metadata returned by a paper enrichment tier. */
export interface PaperMetadata {
  workURL?: string;
  title: string;
  doiURL?: string;
  landingPageURL?: string;
  publicationYear?: number;
  authors: string[];
  venue?: string;
  citedByCount?: number;
  referenceCount: number;
  references: Array<{ url: string; title?: string }>;
}

export interface PaperMetadataProvider {
  readonly name: string;
  enrich(source: SourceEnvelope): Promise<PaperMetadata | undefined>;
}

export interface ResearchResult {
  summary: string;
  claims: string[];
  references: SupplementalReference[];
  limitations: string[];
  /** Present when a paper/pdf source was enriched by a metadata provider. */
  paper?: PaperMetadata;
}


export interface ExtractionRequest {
  sourceText: string;
  sourceURL?: string;
  sourceKind: SourceKind;
  /** Raw bytes of a client-uploaded file; routed by contentType when present. */
  uploadBytes?: { bytes: ArrayBuffer; contentType: string; filename?: string };
  provider?: StructuredProvider;
  assetStore?: AssetStore;
  fetchImpl?: FetchLike;
  now?: () => string;
}
