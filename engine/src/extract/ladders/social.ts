import type { AssetStore } from "../../assets";
import type { FetchLike, SourceEnvelope } from "../../types";
import { boundedFetch, hostname } from "../../net";
import { capForWeb, defaultFetch, mergeModuleResult, sourceReference, videoTier, type LadderContext } from "../context";
import { cleanOptional, cleanText, fetchHTML } from "../html";
import { isRedditURL } from "../kinds";
import { ReadingGaps, gaps as gapLists } from "../limits";

interface SocialOEmbedResponse {
  title?: string;
  author_name?: string;
}

const TWITTER_HOST_PATTERN = /(^|\.)(x|twitter)\.com$/i;

/** Reddit's public JSON view (append .json to any post/sub URL). */
export async function extractRedditJson(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  fetcher: FetchLike,
  now: () => string,
): Promise<SourceEnvelope | undefined> {
  const parsed = new URL(sourceURL);
  const endpoint = `https://www.reddit.com${parsed.pathname.replace(/\/$/, "")}.json?raw_json=1`;
  const response = await boundedFetch(endpoint, fetcher, { headers: { accept: "application/json" } }, ctx.options.timeoutMs);
  if (!response?.ok) return undefined;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }

  const lines: string[] = [];
  let title: string | undefined;
  let author: string | undefined;
  let kind: "post" | "listing" = "listing";

  const postChild = Array.isArray(payload)
    ? (payload[0] as { data?: { children?: Array<{ data?: Record<string, unknown> }> } })?.data?.children?.[0]?.data
    : undefined;

  if (postChild) {
    kind = "post";
    title = cleanOptional(typeof postChild.title === "string" ? postChild.title : undefined);
    author = cleanOptional(typeof postChild.author === "string" ? postChild.author : undefined);
    const selftext = typeof postChild.selftext === "string" ? postChild.selftext.trim() : "";
    const score = typeof postChild.score === "number" ? postChild.score : undefined;
    const comments = typeof postChild.num_comments === "number" ? postChild.num_comments : undefined;
    lines.push(title ?? "");
    if (selftext) lines.push(selftext);
    const meta = [author ? `u/${author}` : undefined, score !== undefined ? `${score} points` : undefined, comments !== undefined ? `${comments} comments` : undefined].filter(Boolean).join(" · ");
    if (meta) lines.push(meta);
    const commentChildren = ((payload as unknown[])[1] as { data?: { children?: Array<{ data?: Record<string, unknown> }> } })?.data?.children ?? [];
    const topComments = commentChildren
      .map((child) => child.data)
      .filter((data): data is Record<string, unknown> => Boolean(data) && typeof data!.body === "string")
      .slice(0, 8);
    if (topComments.length > 0) {
      lines.push("Top comments:");
      for (const comment of topComments) {
        const body = String(comment.body).replace(/\s+/g, " ").trim().slice(0, 500);
        const commentAuthor = typeof comment.author === "string" ? comment.author : "?";
        lines.push(`- u/${commentAuthor}: ${body}`);
      }
    }
  } else {
    const children = (payload as { data?: { children?: Array<{ data?: Record<string, unknown> }> } })?.data?.children ?? [];
    for (const child of children.slice(0, 25)) {
      const data = child.data;
      if (!data || typeof data.title !== "string") continue;
      const score = typeof data.score === "number" ? ` (${data.score}↑)` : "";
      const comments = typeof data.num_comments === "number" ? `, ${data.num_comments} comments` : "";
      lines.push(`- ${data.title}${score}${comments}`);
    }
    title = cleanOptional(parsed.pathname.split("/").filter(Boolean)[1] ? `r/${parsed.pathname.split("/").filter(Boolean)[1]}` : undefined);
  }

  const body = [sourceText, lines.join("\n")].filter(Boolean).join("\n\n").trim();
  if (body.length < 40) return undefined;
  const sub = parsed.pathname.match(/r\/([^/]+)/)?.[1];
  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: sourceURL,
    kind: "social",
    title,
    author,
    sourceDomain: "reddit.com",
    excerpt: title ?? lines[0]?.slice(0, 200),
    text: body.slice(0, ctx.options.maxTextChars),
    references: [sourceReference(sourceURL)],
    metadata: { extraction: kind === "post" ? "reddit-json-post" : "reddit-json-listing", ...(sub ? { subreddit: sub } : {}) },
    accessLevel: body.length >= 600 ? "full" : "partial",
    depthCap: body.length >= 10_000 ? "deep" : body.length >= 4_000 ? "medium" : body.length >= 600 ? "light" : "tiny",
    ...gapLists([
      "Only the posts and their top comments were read, not pictures or videos in them.",
      "Reddit JSON view covers the post/listing and top comments; media embeds are not expanded",
    ]),
    fetchedAt: now(),
  };
}

export async function extractSocial(
  ctx: LadderContext,
  sourceText: string,
  sourceURL: string,
  fetchImpl: FetchLike | undefined,
  assetStore: AssetStore | undefined,
  now: () => string,
): Promise<SourceEnvelope> {
  const fetcher = fetchImpl ?? defaultFetch;
  // Reddit exposes every post/sub as structured JSON via the .json suffix —
  // far richer than oEmbed/OG for feeds and text posts, and public.
  if (isRedditURL(sourceURL)) {
    const reddit = await extractRedditJson(ctx, sourceText, sourceURL, fetcher, now);
    if (reddit) return reddit;
  }
  const video = await videoTier(ctx, sourceText, sourceURL, fetcher, assetStore);
  if (video) {
    return mergeModuleResult(ctx, {
      result: video,
      kind: "social",
      sourceText,
      sourceURL,
      textIncludesSource: false,
      minAccessLevel: sourceText ? "partial" : "none",
      minDepthCap: sourceText ? "tiny" : "saveOnly",
      now,
    });
  }
  const references = [sourceReference(sourceURL)];
  const gaps = new ReadingGaps().note("Social platforms may require authentication or block content extraction");
  // X/Twitter tier: the public oEmbed endpoint is unreliable from datacenters
  // (observed returning empty bodies 2026-08-09); fxtwitter's public API mirrors
  // full tweet JSON. Deleted/private posts are reported honestly, not faked.
  let twitterUnavailable = false;
  if (isTwitterHost(sourceURL)) {
    const fx = await fetchFxTweet(sourceURL, fetcher, ctx.options.timeoutMs);
    if (fx?.tweet) {
      const tweet = fx.tweet;
      const text = [sourceText, tweet.text ?? ""].filter(Boolean).join("\n\n").trim();
      const photos = tweet.media?.photos ?? [];
      const assets = photos
        .filter((photo): photo is { url: string } => typeof photo?.url === "string" && photo.url.length > 0)
        .slice(0, 6)
        .map((photo) => ({ id: photo.url, kind: "image" as const, url: photo.url, sourceURL }));
      return {
        originalText: sourceText,
        originalURL: sourceURL,
        canonicalURL: tweet.url ?? sourceURL,
        kind: "social",
        title: cleanOptional(tweet.text),
        author: tweet.author?.name
          ? `${tweet.author.name}${tweet.author.screen_name ? ` (@${tweet.author.screen_name})` : ""}`
          : undefined,
        sourceDomain: hostname(sourceURL),
        excerpt: cleanText(tweet.text, 500),
        text,
        references,
        ...(assets.length ? { assets } : {}),
        metadata: {
          extraction: "x-fxtwitter",
          ...(tweet.created_at ? { postedAt: tweet.created_at } : {}),
          ...(typeof tweet.likes === "number" ? { likes: String(tweet.likes) } : {}),
          ...(typeof tweet.retweets === "number" ? { retweets: String(tweet.retweets) } : {}),
          ...(typeof tweet.replies === "number" ? { replies: String(tweet.replies) } : {}),
        },
        accessLevel: "full",
        depthCap: text.length >= 600 ? "light" : "tiny",
        ...gaps.fields(),
        fetchedAt: now(),
      };
    }
    if (fx?.unavailable) {
      twitterUnavailable = true;
      gaps.add("This post seems to be deleted or private.", "This post appears to be deleted, private, or otherwise unavailable");
    }
  }
  const oembed = await fetchSocialOEmbed(sourceURL, fetcher, ctx.options.timeoutMs);
  const page = await fetchHTML(sourceURL, fetcher, ctx.options);
  const title = oembed?.title ?? page?.title;
  const author = oembed?.author_name ?? page?.author;
  const description = page?.description;
  const text = [sourceText, title, description].filter(Boolean).join("\n\n").trim();
  const hasMetadata = Boolean(oembed || title || description);
  if (hasMetadata) {
    const hasSuppliedText = sourceText.length > 0;
    return {
      originalText: sourceText,
      originalURL: sourceURL,
      canonicalURL: page?.canonicalURL ?? sourceURL,
      kind: "social",
      title,
      author,
      sourceDomain: hostname(sourceURL),
      excerpt: description ?? title,
      text,
      references,
      metadata: {
        extraction: oembed ? "social-oembed-and-og" : "social-og",
        ...(twitterUnavailable ? { unavailable: "true" } : {}),
        ...(page?.imageURL ? { imageURL: page.imageURL } : {}),
      },
      accessLevel: hasSuppliedText ? "partial" : "metadata",
      depthCap: hasSuppliedText && sourceText.length >= 600 ? "light" : "tiny",
      ...gaps.add("Only this post's title and description could be read.", "Only publicly exposed metadata and supplied text are included").fields(),
      fetchedAt: now(),
    };
  }
  return {
    originalText: sourceText,
    originalURL: sourceURL,
    canonicalURL: sourceURL,
    kind: "social",
    sourceDomain: hostname(sourceURL),
    text: sourceText,
    references,
    metadata: { extraction: "url-only", ...(twitterUnavailable ? { unavailable: "true" } : {}) },
    accessLevel: sourceText ? "partial" : "none",
    // Supplied text is the only evidence here, so it earns the same
    // graduated cap a partial web extraction would — not a flat floor.
    depthCap: sourceText ? capForWeb("partial", sourceText.length) : "saveOnly",
    ...gaps
      .add(
        sourceText ? "This post could not be opened, so only the text added with it was read." : "This post could not be opened.",
        "No public social metadata was available",
      )
      .fields(),
    fetchedAt: now(),
  };
}

function isTwitterHost(url: string): boolean {
  const host = hostname(url);
  return Boolean(host && TWITTER_HOST_PATTERN.test(host));
}

interface FxTweet {
  url?: string;
  text?: string;
  created_at?: string;
  likes?: number;
  retweets?: number;
  replies?: number;
  author?: { name?: string; screen_name?: string };
  media?: { photos?: Array<{ url?: string }> };
}

/** Public tweet mirror (api.fxtwitter.com); 404 means the post is deleted/private.
 *  The FxTwitter API rejects requests without a User-Agent header with a 401
 *  ("You must identify yourself with a User-Agent header"); Worker subrequests
 *  send none by default, so we must set a descriptive one explicitly. */

/** Public tweet mirror (api.fxtwitter.com); 404 means the post is deleted/private.
 *  The FxTwitter API rejects requests without a User-Agent header with a 401
 *  ("You must identify yourself with a User-Agent header"); Worker subrequests
 *  send none by default, so we must set a descriptive one explicitly. */
const FX_USER_AGENT = "OpenSourcebook-Engine/1.0 (source extraction)";

async function fetchFxTweet(
  sourceURL: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ tweet?: FxTweet; unavailable?: boolean } | undefined> {
  const match = sourceURL.match(/(?:x|twitter)\.com\/([^/?#]+)\/status(?:es)?\/(\d+)/i);
  if (!match) return undefined;
  const endpoint = `https://api.fxtwitter.com/${match[1]}/status/${match[2]}`;
  const response = await boundedFetch(
    endpoint,
    fetchImpl,
    { method: "GET", headers: { accept: "application/json", "user-agent": FX_USER_AGENT } },
    timeoutMs,
  );
  if (!response) return undefined;
  if (response.status === 404) return { unavailable: true };
  if (!response.ok) return undefined;
  try {
    const payload = (await response.json()) as { code?: number; tweet?: FxTweet };
    if (payload.code === 404) return { unavailable: true };
    return payload.tweet ? { tweet: payload.tweet } : undefined;
  } catch {
    return undefined;
  }
}

async function fetchSocialOEmbed(sourceURL: string, fetchImpl: FetchLike, timeoutMs: number): Promise<SocialOEmbedResponse | undefined> {
  const host = hostname(sourceURL)?.toLowerCase();
  let endpoint: string | undefined;
  if (host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com") {
    endpoint = `https://publish.twitter.com/oembed?url=${encodeURIComponent(sourceURL)}`;
  } else if (host === "reddit.com" || host === "www.reddit.com") {
    endpoint = `https://www.reddit.com/oembed?url=${encodeURIComponent(sourceURL)}`;
  }
  if (!endpoint) return undefined;
  const response = await boundedFetch(endpoint, fetchImpl, { method: "GET", headers: { accept: "application/json" } }, timeoutMs);
  if (!response?.ok) return undefined;
  try {
    const payload = (await response.json()) as SocialOEmbedResponse;
    return {
      title: typeof payload.title === "string" ? payload.title : undefined,
      author_name: typeof payload.author_name === "string" ? payload.author_name : undefined,
    };
  } catch {
    return undefined;
  }
}
