/**
 * The pictures a quiz's sources hold, for the kinds of question that ask
 * about one (`usesPicture`): what the writer is shown, and what the check
 * holds a question's picture to. Only pictures Open Sourcebook keeps can be shown
 * (cards/pictures.ts), so a picture known only by a web address is left out.
 */
import { isAssetPath } from "../../assets";
import type { NodeSource } from "../../studio/types";

const STILL = new Set(["image", "figure", "slide", "frame", "thumbnail"]);

export interface SourcePicture {
  url: string;
  source: string;
  caption?: string;
  page?: number;
}

export function sourcePictures(sources: readonly NodeSource[]): SourcePicture[] {
  const seen = new Set<string>();
  return sources.flatMap((source) =>
    (source.envelope.assets ?? [])
      .filter((asset) => STILL.has(asset.kind) && isAssetPath(asset.url) && !seen.has(asset.url) && seen.add(asset.url))
      .map((asset) => ({
        url: asset.url,
        source: source.title?.trim() || source.envelope.title?.trim() || "a source",
        ...(asset.caption?.trim() ? { caption: asset.caption.replace(/\s+/g, " ").trim() } : {}),
        ...(asset.page !== undefined ? { page: asset.page } : {}),
      })),
  );
}

/** The pictures as lines a writer reads, or undefined when there are none. */
export function picturesNote(pictures: readonly SourcePicture[]): string | undefined {
  if (pictures.length === 0) return undefined;
  const lines = pictures.map((picture) => `- ${picture.url} from "${picture.source}"${picture.page !== undefined ? `, page ${picture.page}` : ""}${picture.caption ? `: ${picture.caption}` : ""}`);
  return `The sources' pictures (a question about a picture uses one of these exactly; you cannot see them, so only what the sources' text says about a picture is known):\n${lines.join("\n")}`;
}
