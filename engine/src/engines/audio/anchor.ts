/**
 * A moment of an audio in words (`FormatDefinition.describeAnchor`): the time
 * the person is at, as the audio player keeps it (`{ time }` in seconds), with
 * the part being said then, the words said around that moment (from the real
 * word times), whether the part is the maker's own explanation, and that
 * part's cites.
 */
import type { AnchorWords, JsonValue } from "../../studio/types";
import { clock, type AudioPart, type AudioPayload } from "./contract";

/** Words said before and after the moment. */
const BEFORE = 14;
const AFTER = 8;

export function audioAnchor(audio: AudioPayload, at: JsonValue): AnchorWords | undefined {
  if (!at || typeof at !== "object" || Array.isArray(at) || typeof at.time !== "number" || !Number.isFinite(at.time) || at.time < 0) return undefined;
  const parts = Array.isArray(audio?.parts) ? audio.parts.filter((part) => part && typeof part.text === "string") : [];
  if (parts.length === 0) return undefined;
  const ms = at.time * 1000;
  const index = partAt(parts, ms);
  const part = parts[index]!;
  const total = audio.file?.durationMs ?? parts.at(-1)?.endMs ?? 0;
  const facts = [`At ${clock(ms)}${total ? ` of ${clock(total)}` : ""}, in part ${index + 1} of ${parts.length}: "${part.title}".`];
  if (part.background) facts.push("This part is the maker's own explanation, not from the person's sources, and it says so aloud.");
  const words = Array.isArray(part.words) && part.words.length > 0 ? part.words : undefined;
  if (words) {
    let now = words.findIndex((word) => ms < word.endMs);
    if (now === -1) now = words.length - 1;
    const from = Math.max(0, now - BEFORE);
    const to = Math.min(words.length, now + AFTER + 1);
    facts.push(`Around this moment the voice says: "${from > 0 ? "… " : ""}${words.slice(from, to).map((word) => word.text).join(" ")}${to < words.length ? " …" : ""}"`);
  }
  facts.push(`The part's whole words: "${part.text}"`);
  const before = parts[index - 1];
  if (before) facts.push(`The part before ("${before.title}") said: "${before.text}"`);
  for (const cite of part.cites ?? []) if (cite.quote) facts.push(`The part cites: "${cite.quote}"`);
  return { label: `at ${clock(ms)}`, facts };
}

/** The part being said at `ms`: by its times when voiced, else by its place among the words. */
function partAt(parts: AudioPart[], ms: number): number {
  const timed = parts.every((part) => typeof part.endMs === "number");
  if (timed) {
    const found = parts.findIndex((part) => ms < part.endMs!);
    return found === -1 ? parts.length - 1 : found;
  }
  return 0;
}
