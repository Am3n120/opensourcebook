/**
 * Source extraction: one SourceExtractor, one ladder per source kind
 * (extract/ladders/*), shared modules per content type (extract/*).
 * Every ladder ends in an honest envelope; nothing throws into the pipeline.
 */
import type { AssetStore } from "../assets";
import type { ExtractionRequest, SourceEnvelope } from "../types";
import {
  capSourceText,
  resolveExtractionOptions,
  textEnvelope,
  type ExtractionOptions,
  type LadderContext,
  type ResolvedExtractionOptions,
} from "./context";
import { arxivPdfURL, inferKind, isDriveURL, isYouTubeNonVideoURL } from "./kinds";
import { normalizeURL } from "./html";
import { withAccessExplained } from "./limits";
import { driveLink, extractDrive } from "./ladders/drive";
import { extractPDF } from "./ladders/pdf";
import { extractSocial } from "./ladders/social";
import { extractUpload } from "./ladders/upload";
import { extractWeb } from "./ladders/web";
import { extractYouTube, extractYouTubeNonVideo } from "./ladders/youtube";

export type { ExtractionOptions } from "./context";
export type { ModuleExtraction } from "./module";
export { ReadingGaps } from "./limits";
export { withPlainLimitations } from "./stored-limitations";
export { fetchYouTubeOEmbed, type YouTubeModelExtraction, type YouTubeOEmbedResponse } from "./ladders/youtube";

export class SourceExtractor {
  private readonly options: ResolvedExtractionOptions;
  private assetStore?: AssetStore;

  constructor(options: ExtractionOptions = {}) {
    this.options = resolveExtractionOptions(options);
  }

  /** Binds the asset store used to persist harvested media; extraction works unchanged without one. */
  withAssetStore(store: AssetStore): this {
    this.assetStore = store;
    return this;
  }

  async extract(request: ExtractionRequest): Promise<SourceEnvelope> {
    const envelope = withAccessExplained(await this.read(request));
    // Pasted text is kept whole, as it always was; what a ladder read is cut here, once, and says so.
    if (!request.uploadBytes && !normalizeURL(request.sourceURL)) return envelope;
    return capSourceText(envelope, this.options.maxTextChars, this.options.readTextChars);
  }

  private async read(request: ExtractionRequest): Promise<SourceEnvelope> {
    // Ladders read past the cut, so the cut can tell how long the source is.
    const ctx: LadderContext = { options: { ...this.options, maxTextChars: this.options.readTextChars } };
    const now = request.now ?? (() => new Date().toISOString());
    const sourceURL = normalizeURL(request.sourceURL);
    const kind = inferKind(request.sourceKind, sourceURL);
    const sourceText = request.sourceText.trim();
    // Flows to the extraction modules for media harvesting; a no-op without one.
    const assetStore = request.assetStore ?? this.assetStore;

    if (request.uploadBytes) {
      return extractUpload(ctx, sourceText, kind, request.uploadBytes, request.provider, assetStore, now);
    }

    if (!sourceURL) {
      return textEnvelope(sourceText, kind === "pdf" ? "pdf" : kind, now());
    }

    // arXiv abstract pages carry an abstract, but the paper itself is one hop
    // away — follow /abs/<id> and /html/<id> straight to the PDF ladder.
    const pdfRewrite = arxivPdfURL(sourceURL);
    if (pdfRewrite) {
      return extractPDF(ctx, sourceText, pdfRewrite, request.fetchImpl, assetStore, now);
    }

    // A Drive, Docs, Slides or Sheets link is read as the file it shares, never as its viewer page.
    const drive = isDriveURL(sourceURL) ? driveLink(sourceURL) : undefined;
    if (drive) {
      return extractDrive(ctx, sourceText, sourceURL, drive, kind, request.provider, request.fetchImpl, assetStore, now);
    }

    if (kind === "youtube") {
      // Channels/handles/playlists are not videos: answer honestly from public
      // metadata instead of burning the video tiers' long budgets on them.
      if (isYouTubeNonVideoURL(sourceURL)) {
        return extractYouTubeNonVideo(ctx, sourceText, sourceURL, request.fetchImpl, now);
      }
      return extractYouTube(ctx, sourceText, sourceURL, request.provider, request.fetchImpl, assetStore, now);
    }
    if (kind === "social") {
      return extractSocial(ctx, sourceText, sourceURL, request.fetchImpl, assetStore, now);
    }
    if (kind === "pdf") {
      return extractPDF(ctx, sourceText, sourceURL, request.fetchImpl, assetStore, now);
    }
    return extractWeb(ctx, sourceText, sourceURL, kind, request.provider, request.fetchImpl, assetStore, now);
  }
}

export function createSourceExtractor(options: ExtractionOptions = {}): SourceExtractor {
  return new SourceExtractor(options);
}

export async function extractSource(request: ExtractionRequest, options: ExtractionOptions = {}): Promise<SourceEnvelope> {
  return new SourceExtractor(options).extract(request);
}
