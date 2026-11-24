import { type BrowserBindingLike, type BrowserSessionLike } from "../types";

/** Desktop Chrome UA + viewport so bot filters and responsive layouts see a normal browser. */
const RENDER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const RENDER_VIEWPORT = { width: 1366, height: 900 };
/** Post-load settle time for client-rendered content to reach the DOM. */
const RENDER_SETTLE_MS = 1_500;

/**
 * Browser Rendering tier: renders the page in headless Chromium and returns
 * the post-load DOM HTML for the web module to parse. Navigation uses
 * waitUntil "load" — networkidle0 stalls indefinitely on ad/analytics-heavy
 * pages — plus a short settle delay; a navigation timeout still yields
 * whatever DOM is there. Never throws, and always closes the page and the
 * session: unclosed browsers keep billing browser-time until the 60s idle
 * timeout.
 */
export async function renderPageHTML(
  browser: BrowserBindingLike,
  url: string,
  timeoutMs: number,
): Promise<string | undefined> {
  let session: BrowserSessionLike | undefined;
  try {
    session = await browser.launch();
    const page = await session.newPage();
    try {
      await page.setUserAgent(RENDER_USER_AGENT);
      await page.setViewport(RENDER_VIEWPORT);
      let response: unknown;
      try {
        response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
      } catch (error) {
        // Timed out waiting for the load event — the partially rendered DOM
        // may still hold the content, so fall through and read it. Any other
        // navigation failure (no such host, refused, reset) leaves the
        // browser's own error page in the DOM, which is not the source.
        if (!isTimeout(error)) return undefined;
      }
      // A page that is not there (404, 410, a server error) renders as the
      // site's error page; reading it would store that page as the source.
      // Bot walls (401, 403, 429, 503) are why this tier exists, so they are read.
      if (isMissingPage(statusOf(response))) return undefined;
      await new Promise((resolve) => setTimeout(resolve, RENDER_SETTLE_MS));
      const html = await page.content();
      return html.trim() ? html : undefined;
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch {
    return undefined;
  } finally {
    if (session) await session.close().catch(() => undefined);
  }
}

const WALL_STATUSES = new Set([401, 403, 429, 503]);

/** True for an answer that says the page is not there, rather than a wall in front of it. */
export function isMissingPage(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && !WALL_STATUSES.has(status);
}

/** The HTTP status of a puppeteer navigation response, when it has one. */
function statusOf(response: unknown): number | undefined {
  if (!response || typeof response !== "object") return undefined;
  const status = (response as { status?: unknown }).status;
  const value = typeof status === "function" ? (status as () => unknown).call(response) : status;
  return typeof value === "number" ? value : undefined;
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || /timeout|timed out/i.test(error.message);
}
