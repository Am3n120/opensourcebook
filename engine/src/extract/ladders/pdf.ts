import type { AssetStore } from "../../assets";
import type { FetchLike, SourceEnvelope } from "../../types";
import { boundedFetch, hostname } from "../../net";
import { extractPdfModule } from "../pdf";
import { defaultFetch, mergeModuleResult, sourceReference, type LadderContext } from "../context";
import { gaps } from "../limits";

export async function extractPDF(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  fetchImpl: FetchLike | undefined,
  assetStore: AssetStore | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  const pdf = await extractPdfModule({
    url: sourceURL,
    sourceText,
    fetchImpl: fetchImpl ?? defaultFetch,
    ...(assetStore ? { assetStore } : {}),
    timeoutMs: ctx.options.timeoutMs,
    maxBytes: ctx.options.pdfMaxBytes,
    maxTextChars: ctx.options.maxTextChars,
  });
  if (pdf) {
    const suppliedText = sourceText.length > 0;
    return mergeModuleResult(ctx, {
      result: pdf,
      kind: "pdf",
      sourceText,
      sourceURL,
      textIncludesSource: true,
      minAccessLevel: suppliedText ? "full" : "metadata",
      minDepthCap: suppliedText ? "deep" : "saveOnly",
      now,
    });
  }
  const response = await boundedFetch(sourceURL, fetchImpl ?? defaultFetch, { method: "HEAD" }, ctx.options.timeoutMs);
  const contentType = response?.headers.get("content-type") ?? "application/pdf";
  const suppliedText = sourceText.length > 0;
  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: sourceURL,
    kind: "pdf",
    sourceDomain: hostname(sourceURL),
    text: sourceText,
    references: [sourceReference(sourceURL)],
    metadata: {
      extraction: suppliedText ? "supplied-pdf-text" : "pdf-metadata-only",
      contentType,
      ...(response ? { httpStatus: String(response.status) } : {}),
    },
    accessLevel: suppliedText ? "full" : response ? "metadata" : "none",
    depthCap: suppliedText ? "deep" : "saveOnly",
    ...gaps(
      !response && [suppliedText ? undefined : "The file could not be downloaded from its link.", "PDF URL could not be reached during extraction"],
      !suppliedText && response && ["The file's text could not be read.", "PDF bytes could not be fetched or parsed; supply extracted text or retry"],
    ),
    fetchedAt: now(),
  };
}
