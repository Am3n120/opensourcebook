/** Why a source could not be read, and whether reading it again could help. */

/** How the reason starts when a reading finished and found nothing in it. */
export const NOTHING_READ = "Nothing could be read from this source.";

/**
 * Whether reading a failed source again could end differently. A link can
 * (the page may open next time); an uploaded file whose reading finished and
 * found nothing cannot, since the same bytes read the same way. An upload
 * whose reading broke off for another reason can.
 */
export function canReadAgain(source: { url?: string | null }, errorMessage: string | undefined | null): boolean {
  if (source.url) return true;
  return !errorMessage?.startsWith(NOTHING_READ);
}
