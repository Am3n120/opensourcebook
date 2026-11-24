/**
 * Media in a payload is drawn only when Open Sourcebook keeps it: the engine's
 * /v1/assets/<id> path (the phone resolves it against its engine URL; the
 * web reaches the engine only through its own /api proxy, so the path is
 * rewritten) or a raster picture embedded as data. A web address is never
 * drawn: a picture or sound loaded from another server is a request made
 * without a click, which could carry what a maker read
 * (engine/src/cards/pictures.ts). Anything else (javascript:, SVG data) is
 * dropped too.
 */
const KEPT = /^\/v1\/assets\/[A-Za-z0-9._~-]+$/;
const DATA_PICTURE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i;

export function mediaUrl(url: string | undefined, apiBase = "/api"): string | undefined {
  if (!url) return undefined;
  if (KEPT.test(url)) return `${apiBase}${url}`;
  return DATA_PICTURE.test(url) ? url : undefined;
}

/**
 * A link a person clicks (a link card, a link preview's page, a clip's
 * video): an http(s) address opens in a new tab, a kept asset through the
 * /api proxy. Anything else is not a link.
 */
export function linkUrl(url: string | undefined, apiBase = "/api"): string | undefined {
  if (!url) return undefined;
  if (KEPT.test(url)) return `${apiBase}${url}`;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A picture the engine describes by its own path (a setting option's
 * `preview`, `/v1/...`), through the /api proxy, which adds the token the
 * engine asks for. Anything else is not loaded.
 */
export function previewUrl(path: string | undefined, apiBase = "/api"): string | undefined {
  return path && /^\/v1\/[^/\s]/.test(path) ? `${apiBase}${path}` : undefined;
}

/** A YouTube id as an embed URL. */
export function youtubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}`;
}
