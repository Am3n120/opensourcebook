import type { AssetStore } from "../../assets";
import type { AccessLevel, FetchLike, SourceEnvelope, SourceKind, StructuredProvider } from "../../types";
import { boundedFetch, hostname } from "../../net";
import { extractAudioModule } from "../audio";
import { extractImageModule } from "../image";
import { extractOfficeModule } from "../office";
import { extractPlainModule } from "../plain";
import { renderPageHTML } from "../render";
import { LITTLE_TEXT, extractWebModule } from "../web";
import { gaps } from "../limits";
import { capForWeb, defaultFetch, mergeModuleResult, sourceReference, type LadderContext } from "../context";
import { fetchHTML } from "../html";
import { isOfficeContentType, isPlainDataContentType, officeSourceKind, webSourceKind } from "../kinds";
import type { ModuleExtraction } from "../module";
import { extractPDF } from "./pdf";

/**
 * Content-type probe for kind routing. HEAD is unreliable in the wild
 * (405s, silent CDNs, blocked HEAD); when it fails or omits the header,
 * fall back to a one-byte GET, which follows redirects and answers with the
 * final content-type.
 */
export async function probeContentType(ctx: LadderContext, sourceURL: string, fetcher: FetchLike): Promise<string> {
  const head = await boundedFetch(sourceURL, fetcher, { method: "HEAD" }, ctx.options.timeoutMs);
  const headType = head?.ok ? head.headers.get("content-type") : undefined;
  if (headType) return headType.toLowerCase();
  const get = await boundedFetch(sourceURL, fetcher, { method: "GET", headers: { range: "bytes=0-0" } }, ctx.options.timeoutMs);
  await get?.body?.cancel().catch(() => undefined);
  return (get?.headers.get("content-type") ?? "").toLowerCase();
}

export async function extractWeb(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  kind: SourceKind,
  provider: StructuredProvider | undefined,
  fetchImpl: FetchLike | undefined,
  assetStore: AssetStore | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  const fetcher = fetchImpl ?? defaultFetch;
  const suppliedText = sourceText.length > 0;
  // Some hosts serve PDFs from extension-less URLs (e.g. arxiv.org/pdf/<id>);
  // sniff the content type and hand off to the PDF ladder when it is one.
  // The same probe routes direct image/audio/office links to their modules.
  // HEAD is unreliable in the wild (405s, silent CDNs), so it GET-falls back.
  const probedType = await probeContentType(ctx, sourceURL, fetcher);
  if (probedType.includes("application/pdf")) {
    return extractPDF(ctx, sourceText, sourceURL, fetcher, assetStore, now);
  }
  // Binary media get the larger document cap, like PDFs — pages get maxBytes.
  if (probedType.startsWith("image/")) {
    const image = await extractImageModule({
      url: sourceURL,
      sourceText,
      provider,
      fetchImpl: fetcher,
      ...(assetStore ? { assetStore } : {}),
      timeoutMs: ctx.options.timeoutMs,
      maxBytes: ctx.options.pdfMaxBytes,
      maxTextChars: ctx.options.maxTextChars,
    });
    if (image) {
      return mergeModuleResult(ctx, {
        result: image,
        kind,
        sourceText,
        sourceURL,
        textIncludesSource: false,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  }
  if (probedType.startsWith("audio/")) {
    const audio = await extractAudioModule({
      url: sourceURL,
      sourceText,
      provider,
      fetchImpl: fetcher,
      ...(assetStore ? { assetStore } : {}),
      ...(ctx.options.sidecarURL ? { sidecarURL: ctx.options.sidecarURL } : {}),
      ...(ctx.options.sidecarToken ? { sidecarToken: ctx.options.sidecarToken } : {}),
      timeoutMs: ctx.options.timeoutMs,
      maxBytes: ctx.options.pdfMaxBytes,
      maxTextChars: ctx.options.maxTextChars,
    });
    if (audio) {
      return mergeModuleResult(ctx, {
        result: audio,
        kind,
        sourceText,
        sourceURL,
        textIncludesSource: false,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  }
  if (isOfficeContentType(probedType)) {
    const office = await extractOfficeModule({
      url: sourceURL,
      sourceText,
      contentType: probedType,
      fetchImpl: fetcher,
      ...(assetStore ? { assetStore } : {}),
      timeoutMs: ctx.options.timeoutMs,
      maxBytes: ctx.options.pdfMaxBytes,
      maxTextChars: ctx.options.maxTextChars,
    });
    if (office) {
      return mergeModuleResult(ctx, {
        result: office,
        kind: officeSourceKind(kind, office),
        sourceText,
        sourceURL,
        textIncludesSource: true,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  }
  // Raw data files (text/markdown/JSON/XML/RSS/CSV/robots/sitemap) — the web
  // tier only accepts HTML, so these get their own reader.
  if (isPlainDataContentType(probedType)) {
    const plain = await extractPlainModule({
      url: sourceURL,
      contentType: probedType,
      sourceText,
      fetchImpl: fetcher,
      timeoutMs: ctx.options.timeoutMs,
      maxBytes: ctx.options.maxBytes,
      maxTextChars: ctx.options.maxTextChars,
    });
    if (plain) {
      return mergeModuleResult(ctx, {
        result: plain,
        kind,
        sourceText,
        sourceURL,
        textIncludesSource: true,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  }
  const web = await extractWebModule({
    url: sourceURL,
    sourceText,
    fetchImpl: fetcher,
    ...(assetStore ? { assetStore } : {}),
    timeoutMs: ctx.options.timeoutMs,
    maxBytes: ctx.options.maxBytes,
    maxTextChars: ctx.options.maxTextChars,
  });
  // Browser-render tier: plain fetches from Workers get bot-blocked or
  // return thin shells on JS-heavy pages, so when a browser binding is
  // configured and reader mode came back empty or thin (reader text under
  // the 600-char full-access bar), render the page in headless Chromium and
  // re-run the same web module on the rendered DOM. A failed render keeps
  // the original result, so the legacy fallbacks below are untouched.
  let renderedWeb: ModuleExtraction | undefined;
  if (ctx.options.browser && (!web || web.accessLevel !== "full")) {
    const renderedHTML = await renderPageHTML(ctx.options.browser, sourceURL, ctx.options.timeoutMs);
    if (renderedHTML) {
      renderedWeb = await extractWebModule({
        url: sourceURL,
        sourceText,
        fetchImpl: fetcher,
        ...(assetStore ? { assetStore } : {}),
        timeoutMs: ctx.options.timeoutMs,
        maxBytes: ctx.options.maxBytes,
        maxTextChars: ctx.options.maxTextChars,
        renderedHTML,
      });
    }
  }
  const webResult = renderedWeb ?? web;
  if (webResult && webResult.accessLevel === "full") {
    return mergeModuleResult(ctx, {
      result: webResult,
      kind: webSourceKind(kind, webResult),
      sourceText,
      sourceURL,
      textIncludesSource: true,
      minAccessLevel: suppliedText ? "partial" : "none",
      minDepthCap: suppliedText ? "light" : "saveOnly",
      now,
    });
  }
  // Reader-service tier (r.jina.ai): the last escalation for bot-walled or
  // JS-app pages that beat plain fetches AND the render tier. Requires an API
  // key — the anonymous tier bot-blocks Workers IPs ("security verification").
  // CAPTCHA-grade sites still lose — that's the honest wall.
  if (ctx.options.jinaApiKey) {
    const readerService = await fetchReaderService(sourceURL, fetcher, ctx.options.timeoutMs, ctx.options.maxTextChars, ctx.options.jinaApiKey);
    if (readerService && (readerService.text?.length ?? 0) >= (webResult?.text?.length ?? 0)) {
      return mergeModuleResult(ctx, {
        result: readerService,
        kind,
        sourceText,
        sourceURL,
        textIncludesSource: true,
        minAccessLevel: suppliedText ? "partial" : "none",
        minDepthCap: suppliedText ? "light" : "saveOnly",
        now,
      });
    }
  }
  if (webResult) {
    return mergeModuleResult(ctx, {
      result: webResult,
      kind: webSourceKind(kind, webResult),
      sourceText,
      sourceURL,
      textIncludesSource: true,
      minAccessLevel: suppliedText ? "partial" : "none",
      minDepthCap: suppliedText ? "light" : "saveOnly",
      now,
    });
  }
  const page = await fetchHTML(sourceURL, fetcher, ctx.options);
  if (!page) {
    return {
      originalText: sourceText,
      originalURL: sourceURL,
      canonicalURL: sourceURL,
      kind,
      sourceDomain: hostname(sourceURL),
      text: sourceText,
      references: [sourceReference(sourceURL)],
      metadata: { extraction: "url-only" },
      accessLevel: suppliedText ? "partial" : "none",
      depthCap: suppliedText ? "light" : "saveOnly",
      ...gaps([
        suppliedText ? "This page could not be opened, so only the text added with it was read." : "This page could not be opened.",
        "Web page could not be fetched; only caller-supplied text is available",
      ]),
      fetchedAt: now(),
    };
  }
  const text = [sourceText, page.text].filter(Boolean).join("\n\n").slice(0, ctx.options.maxTextChars).trim();
  const accessLevel: AccessLevel = page.text.length >= 600 ? "full" : suppliedText || page.title || page.description ? "partial" : "metadata";
  const depthCap = capForWeb(accessLevel, page.text.length);
  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: page.canonicalURL ?? sourceURL,
    kind,
    title: page.title,
    author: page.author,
    sourceDomain: hostname(sourceURL),
    excerpt: page.description ?? page.text.slice(0, 500),
    text,
    references: [sourceReference(sourceURL)],
    metadata: {
      extraction: "lightweight-html",
      ...(page.imageURL ? { imageURL: page.imageURL } : {}),
    },
    accessLevel,
    depthCap,
    ...gaps(
      [undefined, "HTML extraction is lightweight and excludes scripts, styles, and authenticated content"],
      page.text.length < 600 && [LITTLE_TEXT, "The page exposed limited readable text"],
    ),
    fetchedAt: now(),
  };
}



/**
 * Reader-service escalation (r.jina.ai, no key on the free tier): fetches a
 * reader-rendered markdown view of a page. Used only after the web module and
 * the render tier both come back thin. Returns undefined on walls ("Just a
 * moment", CAPTCHA warnings, upstream 4xx warnings) so the honest fallback
 * ladder keeps its behavior.
 */
async function fetchReaderService(
  sourceURL: string,
  fetcher: FetchLike,
  timeoutMs: number,
  maxTextChars: number,
  apiKey: string,
): Promise<ModuleExtraction | undefined> {
  const response = await boundedFetch(
    `https://r.jina.ai/${sourceURL}`,
    fetcher,
    { headers: { accept: "text/plain", authorization: `Bearer ${apiKey}` } },
    Math.max(timeoutMs * 2, 60_000), // reader services re-render upstream and legitimately take 30–60s on hard pages
  );
  if (!response?.ok) return undefined;
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return undefined;
  }
  const title = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  if (!title || /just a moment|attention required|access denied/i.test(title)) return undefined;
  if (/Warning:.*(error 4\d\d|requiring CAPTCHA|blocked by network security)/i.test(raw)) return undefined;
  const body = raw
    .replace(/^Title:.*$/m, "")
    .replace(/^URL Source:.*$/m, "")
    .replace(/^Published Time:.*$/m, "")
    .replace(/^Warning:.*$/m, "")
    .replace(/^Markdown Content:\s*/m, "")
    .trim();
  if (body.length < 200) return undefined;
  const text = body.slice(0, maxTextChars);
  return {
    text,
    title,
    canonicalURL: sourceURL,
    excerpt: text.slice(0, 500),
    references: [{ url: sourceURL, domain: hostname(sourceURL), label: "source" }],
    metadata: { extraction: "reader-service" },
    accessLevel: text.length >= 600 ? "full" : "partial",
    depthCap: text.length >= 4_000 ? "deep" : text.length >= 600 ? "medium" : "light",
    ...gaps([undefined, "Extracted via a reader service; interactive content (comments, embeds) may be flattened"]),
  };
}
