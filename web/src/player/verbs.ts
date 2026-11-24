import { findFormat, type FormatLike } from "../design/formatLook";

/**
 * Formats a person reads rather than goes through, keyed like the players in
 * `registry.tsx`: their button says Open. Everything else is played.
 */
const READ: ReadonlySet<string> = new Set(["guide"]);

/** What the button on a made thing says: Open for a thing to read, Play for a thing to watch or go through. */
export function madeVerb(formats: readonly FormatLike[], type: string): "Play" | "Open" {
  return READ.has(findFormat(formats, type)?.id ?? type) ? "Open" : "Play";
}
