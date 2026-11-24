import type { AssetStore } from "../../assets";
import { MAX_UPLOAD_BYTES } from "../../uploads";
import type { SourceEnvelope, SourceKind, StructuredProvider } from "../../types";
import { extractAudioModule } from "../audio";
import { extractImageModule } from "../image";
import { extractOfficeModule } from "../office";
import { extractPdfModule } from "../pdf";
import { defaultFetch, mergeModuleResult, type LadderContext } from "../context";
import { isOfficeContentType, isTextFile, officeSourceKind } from "../kinds";
import { readPlainText } from "../plain";
import { gaps } from "../limits";
import type { ModuleExtraction } from "../module";

/**
 * Client-uploaded file ladder: routes the stored bytes to a module by
 * declared content type. The envelope keeps the caller's kind and carries no
 * URL fields (an upload has none); the module sets metadata.extraction. A
 * module resolving undefined — or a content type with no parser — keeps an
 * honest "could not parse" envelope instead of throwing.
 */
export async function extractUpload(
  ctx: LadderContext,
  sourceText: string,
  kind: SourceKind,
  upload: { bytes: ArrayBuffer; contentType: string; filename?: string },
  provider: StructuredProvider | undefined,
  assetStore: AssetStore | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  const contentType = upload.contentType.split(";")[0].trim().toLowerCase();
  const suppliedText = sourceText.length > 0;
  const moduleInput = {
    sourceText,
    fetchImpl: defaultFetch,
    ...(assetStore ? { assetStore } : {}),
    ...(ctx.options.sidecarURL ? { sidecarURL: ctx.options.sidecarURL } : {}),
    ...(ctx.options.sidecarToken ? { sidecarToken: ctx.options.sidecarToken } : {}),
    timeoutMs: ctx.options.timeoutMs,
    maxTextChars: ctx.options.maxTextChars,
  };
  let result: ModuleExtraction | undefined;
  if (contentType === "application/pdf") {
    result = await extractPdfModule({ ...moduleInput, pdfBytes: upload.bytes, maxBytes: ctx.options.pdfMaxBytes });
    if (result) {
      return mergeModuleResult(ctx, {
        result,
        kind,
        sourceText,
        textIncludesSource: true,
        minAccessLevel: suppliedText ? "full" : "metadata",
        minDepthCap: suppliedText ? "deep" : "saveOnly",
        now,
      });
    }
  } else if (isTextFile(contentType, upload.filename)) {
    // Text files (notes, Markdown, CSV, JSON) are read as they are.
    result = readPlainText(new TextDecoder("utf-8").decode(upload.bytes), {
      name: upload.filename ?? "",
      contentType,
      sourceText,
      maxTextChars: ctx.options.maxTextChars,
    });
    if (result) {
      return mergeModuleResult(ctx, {
        result,
        kind,
        sourceText,
        textIncludesSource: true,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  } else if (isOfficeContentType(contentType)) {
    result = await extractOfficeModule({
      ...moduleInput,
      bytes: upload.bytes,
      contentType,
      ...(upload.filename ? { filename: upload.filename } : {}),
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (result) {
      return mergeModuleResult(ctx, {
        result,
        kind: officeSourceKind(kind, result),
        sourceText,
        textIncludesSource: true,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  } else if (contentType.startsWith("image/")) {
    result = await extractImageModule({
      ...moduleInput,
      bytes: upload.bytes,
      contentType,
      provider,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (result) {
      return mergeModuleResult(ctx, {
        result,
        kind,
        sourceText,
        textIncludesSource: false,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  } else if (contentType.startsWith("audio/")) {
    result = await extractAudioModule({
      ...moduleInput,
      bytes: upload.bytes,
      contentType,
      provider,
      maxBytes: MAX_UPLOAD_BYTES,
    });
    if (result) {
      return mergeModuleResult(ctx, {
        result,
        kind,
        sourceText,
        textIncludesSource: false,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  } else if (contentType.startsWith("video/")) {
    // No video bytes parser yet — store-and-describe is image/audio only.
    return {
      originalText: sourceText,
      kind,
      text: sourceText,
      references: [],
      metadata: {
        extraction: "upload-video-metadata",
        contentType,
        ...(upload.filename ? { filename: upload.filename } : {}),
      },
      accessLevel: suppliedText ? "partial" : "metadata",
      depthCap: suppliedText ? "light" : "saveOnly",
      ...gaps([
        suppliedText
          ? "Uploaded videos are not read yet, so only the file's name and the text added with it were kept."
          : "Uploaded videos are not read yet, so only the file's name was kept.",
        "Uploaded video content is not extracted yet; only the file metadata and any supplied text are available",
      ]),
      fetchedAt: now(),
    };
  }
  return {
    originalText: sourceText,
    kind,
    text: sourceText,
    references: [],
    metadata: {
      extraction: "upload-unparsed",
      contentType,
      ...(upload.filename ? { filename: upload.filename } : {}),
    },
    accessLevel: suppliedText ? "partial" : "none",
    depthCap: suppliedText ? "light" : "saveOnly",
    ...gaps([
      suppliedText ? "This kind of file could not be read, so only the text added with it was used." : "This kind of file could not be read.",
      `The uploaded file (${contentType || "unknown content type"}) could not be parsed; only any supplied text is available`,
    ]),
    fetchedAt: now(),
  };
}

