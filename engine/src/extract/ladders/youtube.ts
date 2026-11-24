import type { AssetStore } from "../../assets";
import type { FetchLike, SourceEnvelope, StructuredProvider } from "../../types";
import { boundedFetch, hostname, isHTTPURL, withRateLimitRetry } from "../../net";
import {
  DEFAULT_TIMEOUT_MS,
  capForWeb,
  defaultFetch,
  mergeModuleResult,
  sourceReference,
  videoTier,
  type LadderContext,
} from "../context";
import { cleanOptional, cleanStringArray, cleanText, fetchHTML } from "../html";
import { ReadingGaps, gaps as gapLists } from "../limits";

/** Said when only the public card of a video (its title and channel) could be read. */
const VIDEO_TITLE_AND_CHANNEL_ONLY = "Only this video's title and channel name could be read, not what is said in it.";

/**
 * Prompt for the provider video hook. Extraction-only: it asks for what the
 * video publicly exposes and forbids inventing a transcript.
 */
export function buildYouTubeExtractionPrompt(url: string, suppliedText: string): string {
  return `Return only valid JSON. Use only information the video itself exposes; do not invent transcript text, claims, links, authors, or metadata.
Extract publicly available information from this YouTube video URL using the video input hook. URL: ${url}
Caller-supplied text: ${suppliedText || "(none)"}
Return an object with optional title, author, durationText, transcript, summary, claims, and references. Do not claim a transcript if the video cannot be accessed.`;
}

export interface YouTubeModelExtraction {
  title?: string;
  author?: string;
  durationText?: string;
  transcript?: string;
  summary?: string;
  claims?: string[];
  references?: Array<{ url: string; title?: string; relation?: string }>;
}

/** Channels/playlists aren't extractable videos: public page metadata + an honest limitation, fast. */
export async function extractYouTubeNonVideo(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  fetchImpl: FetchLike | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  const page = await fetchHTML(sourceURL, fetchImpl ?? defaultFetch, ctx.options);
  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: page?.canonicalURL ?? sourceURL,
    kind: "youtube",
    title: page?.title,
    author: page?.author,
    sourceDomain: hostname(sourceURL),
    excerpt: page?.description,
    text: [sourceText, page?.description ?? page?.title ?? ""].filter(Boolean).join("\n\n").trim(),
    references: [sourceReference(sourceURL)],
    metadata: {
      extraction: page ? "youtube-channel-og" : "url-only",
      ...(page?.imageURL ? { imageURL: page.imageURL } : {}),
    },
    accessLevel: page ? "metadata" : sourceText ? "partial" : "none",
    depthCap: "tiny",
    ...gapLists([
      "This link is a channel or playlist, not a single video, so only its title and description were read.",
      "YouTube channel and playlist pages are not single videos; share a specific video for full extraction",
    ]),
    fetchedAt: now(),
  };
}

export async function extractYouTube(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  provider: StructuredProvider | undefined,
  fetchImpl: FetchLike | undefined,
  assetStore: AssetStore | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  // The yt-dlp sidecar leads for YouTube: it reliably returns real
  // transcripts. The Gemini video hook runs when the sidecar is not
  // configured, fails, or comes back metadata-only; oEmbed stays last.
  const video = await videoTier(ctx, sourceText, sourceURL, fetchImpl ?? defaultFetch, assetStore);
  if (video && video.accessLevel !== "metadata") {
    return mergeModuleResult(ctx, {
      result: video,
      kind: "youtube",
      sourceText,
      sourceURL,
      textIncludesSource: false,
      minAccessLevel: sourceText ? "partial" : "none",
      minDepthCap: sourceText ? "light" : "saveOnly",
      now,
    });
  }
  // Which video reader was missing or failed is a note; what could be read is said to the person by the tier that read it.
  const gaps = new ReadingGaps();
  const references = [sourceReference(sourceURL)];
  const generateYouTube = provider?.generateYouTubeJSON?.bind(provider);
  if (generateYouTube) {
    try {
      const extracted = await withRateLimitRetry(() =>
        generateYouTube<YouTubeModelExtraction>({
          youtubeURL: sourceURL,
          task: "youtube",
          systemPrompt: "Return only valid JSON. Do not invent transcript text, claims, links, or metadata.",
          userPrompt: buildYouTubeExtractionPrompt(sourceURL, sourceText),
        }),
      );
      const transcript = cleanText(extracted.transcript, ctx.options.maxTextChars);
      const summary = cleanText(extracted.summary, 4_000);
      const claims = cleanStringArray(extracted.claims, 12);
      const text = [sourceText, transcript, summary, claims.join("\n")].filter(Boolean).join("\n\n").trim();
      if (text || extracted.title || extracted.author) {
        const substantive = Boolean(transcript || summary || claims.length > 0);
        if (!substantive) gaps.add(VIDEO_TITLE_AND_CHANNEL_ONLY, "Gemini returned metadata without transcript or substantive content");
        for (const reference of extracted.references ?? []) {
          if (isHTTPURL(reference.url)) {
            references.push({
              url: reference.url,
              title: reference.title,
              domain: hostname(reference.url),
              label: "source",
              relation: reference.relation,
            });
          }
        }
        return {
          originalText: sourceText,
          originalURL: sourceURL,
          canonicalURL: sourceURL,
          kind: "youtube",
          title: cleanOptional(extracted.title),
          author: cleanOptional(extracted.author),
          sourceDomain: hostname(sourceURL),
          excerpt: summary || undefined,
          text: text || sourceText,
          references,
          metadata: {
            ...(extracted.durationText ? { durationText: extracted.durationText } : {}),
            extraction: "gemini-youtube-video-hook",
          },
          accessLevel: substantive ? "full" : "metadata",
          depthCap: substantive ? "deep" : "tiny",
          ...gaps.fields(),
          fetchedAt: now(),
        };
      }
    } catch {
      gaps.note("Gemini YouTube extraction was unavailable; used public metadata fallback");
    }
  } else {
    gaps.note("No Gemini YouTube extraction provider configured; used public metadata fallback");
  }

  if (video) {
    // A metadata-only sidecar result still beats oEmbed: it carries the
    // description, chapters, duration, and thumbnail even without a transcript.
    return mergeModuleResult(ctx, {
      // The video tier says itself that only the title and description were read.
      result: { ...video, ...gaps.merge(video).fields() },
      kind: "youtube",
      sourceText,
      sourceURL,
      textIncludesSource: false,
      minAccessLevel: sourceText ? "partial" : "none",
      minDepthCap: sourceText ? "light" : "saveOnly",
      now,
    });
  }

  const oembed = await fetchYouTubeOEmbed(sourceURL, fetchImpl ?? defaultFetch, ctx.options.timeoutMs);
  if (oembed) {
    const fallbackText = [sourceText, oembed.title, oembed.author_name].filter(Boolean).join("\n\n").trim();
    return {
      originalText: sourceText,
      originalURL: sourceURL,
      canonicalURL: sourceURL,
      kind: "youtube",
      title: oembed.title,
      author: oembed.author_name,
      sourceDomain: hostname(sourceURL),
      excerpt: oembed.title,
      text: fallbackText,
      references,
      metadata: {
        extraction: "youtube-oembed",
        ...(oembed.type ? { oembedType: oembed.type } : {}),
        ...(oembed.provider_name ? { provider: oembed.provider_name } : {}),
      },
      accessLevel: "metadata",
      depthCap: "tiny",
      ...gaps.add(VIDEO_TITLE_AND_CHANNEL_ONLY, "YouTube oEmbed provides metadata only; transcript and claims were not available").fields(),
      fetchedAt: now(),
    };
  }

  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: sourceURL,
    kind: "youtube",
    sourceDomain: hostname(sourceURL),
    text: sourceText,
    references,
    metadata: { extraction: "url-only" },
    accessLevel: sourceText ? "partial" : "none",
    // Supplied text is the only evidence here, so it earns the same
    // graduated cap a partial web extraction would — not a flat floor.
    depthCap: sourceText ? capForWeb("partial", sourceText.length) : "saveOnly",
    ...gaps
      .add(
        sourceText ? "This video could not be opened, so only the text added with it was read." : "This video could not be opened.",
        "YouTube metadata endpoint was unavailable",
      )
      .fields(),
    fetchedAt: now(),
  };
}


export async function fetchYouTubeOEmbed(
  sourceURL: string,
  fetchImpl: FetchLike = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<YouTubeOEmbedResponse | undefined> {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(sourceURL)}&format=json`;
  const response = await boundedFetch(endpoint, fetchImpl, { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
  if (!response?.ok) return undefined;
  try {
    const payload = (await response.json()) as Partial<YouTubeOEmbedResponse>;
    if (typeof payload.title !== "string") return undefined;
    return {
      title: payload.title,
      author_name: typeof payload.author_name === "string" ? payload.author_name : undefined,
      type: typeof payload.type === "string" ? payload.type : undefined,
      provider_name: typeof payload.provider_name === "string" ? payload.provider_name : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface YouTubeOEmbedResponse {
  title: string;
  author_name?: string;
  type?: string;
  provider_name?: string;
}
