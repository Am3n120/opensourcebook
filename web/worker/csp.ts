/**
 * What the web app's pages may load, said once and used in three places:
 * `vite dev` (vite.config.ts), the built app's static files
 * (`public/_headers`, kept equal to this by src/csp.test.ts) and every
 * response of the /api Worker (worker/index.ts).
 *
 * Scripts come only from the app itself, plus the one inline script in
 * index.html (the theme before anything is drawn), allowed by its hash.
 * Pictures, sound and video come only from the app (`/api/v1/assets/…`
 * through the proxy), embedded data or blobs: a maker's card can never make
 * the page load something from another server (engine/src/cards/pictures.ts).
 * The one other server the app shows is the privacy-enhanced YouTube player
 * in a frame. Styles allow inline because KaTeX draws maths with style
 * attributes; fonts (Inter, KaTeX's) are the app's own files.
 */

/** sha256 of index.html's inline theme script, exactly as written; src/csp.test.ts checks it. */
export const THEME_SCRIPT_HASH = "sha256-rxvgrlNwZqXXT9qhqcgH1Bk5kbmlNTfvdCsB1CjJR9o=";

/** The privacy-enhanced YouTube player a video block embeds (src/player/media.ts). */
const YOUTUBE_PLAYER = "https://www.youtube-nocookie.com";

/**
 * The policy. In `vite dev` the dev server's own inline module (React's
 * fast refresh) carries `nonce`, and its live-reload socket is the same
 * host and port, which `'self'` covers.
 */
export function contentSecurityPolicy(options: { nonce?: string } = {}): string {
  const scripts = ["'self'", `'${THEME_SCRIPT_HASH}'`, ...(options.nonce ? [`'nonce-${options.nonce}'`] : [])];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src ${YOUTUBE_PLAYER}`,
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Every header the app's responses carry; a response that already says its own policy (a kept asset's sandbox) keeps it. */
export function securityHeaders(options: { nonce?: string } = {}): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(options),
    "x-content-type-options": "nosniff",
    // The YouTube player needs to know which site embeds it; never more than the origin leaves.
    "referrer-policy": "strict-origin-when-cross-origin",
  };
}

/** A response with the app's headers added, keeping any it already has. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) if (!headers.has(name)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
