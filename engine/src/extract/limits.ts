/**
 * What a reading could not do, said twice. A tier that finds a gap names it
 * where it finds it, once in plain words for the person and once in full for
 * the logs:
 *
 *   gaps.add("Only the first 40 rows of this table were read.", "CSV preview cut at 40 rows (812 total)");
 *   gaps.note("Page HTML was rendered in a headless browser before parsing");
 *
 * `limitations` on the envelope is the plain list a client shows under
 * "What could not be read": short sentences, the words source, page, video
 * and file, no service or model names, nothing a person cannot act on or
 * would not miss. `extractionNotes` holds every technical line, plain ones'
 * included, for logs and debugging. A line that only tells how the reading
 * worked ("rendered in a browser", "scripts and styles left out") is a note
 * and nothing more. New tiers add their own lines this way; there is no
 * central list of messages.
 */
export class ReadingGaps {
  private readonly plain: string[] = [];
  private readonly details: string[] = [];

  /** A gap the person should know about: its plain line and its technical note. */
  add(plain: string, note: string): this {
    if (!this.plain.includes(plain)) this.plain.push(plain);
    return this.note(note);
  }

  /** A technical note only; nothing is shown to the person. */
  note(note: string): this {
    if (!this.details.includes(note)) this.details.push(note);
    return this;
  }

  /** Takes over another reading's gaps (a tier this one fell back to or built on). */
  merge(other: { limitations?: string[]; extractionNotes?: string[] } | undefined): this {
    for (const line of other?.limitations ?? []) if (!this.plain.includes(line)) this.plain.push(line);
    for (const line of other?.extractionNotes ?? []) this.note(line);
    return this;
  }

  get limitations(): string[] {
    return [...this.plain];
  }

  get extractionNotes(): string[] {
    return [...this.details];
  }

  /** Both lists, ready to spread into a module result or an envelope. */
  fields(): { limitations: string[]; extractionNotes: string[] } {
    return { limitations: this.limitations, extractionNotes: this.extractionNotes };
  }
}

/** A one-gap (or no-gap) pair of lists, for envelopes built in one expression. */
export function gaps(...entries: Array<[plain: string | undefined, note: string] | false | undefined>): {
  limitations: string[];
  extractionNotes: string[];
} {
  const collected = new ReadingGaps();
  for (const entry of entries) {
    if (!entry) continue;
    const [plain, note] = entry;
    if (plain) collected.add(plain, note);
    else collected.note(note);
  }
  return collected.fields();
}

/** Shared by every file reader that keeps a file's pictures (PDF, Office). */
export const SOME_PICTURES_LEFT_OUT = "Some pictures in this file were left out.";

/** Said when a reading is `partial` but no reader said what was missed. */
export const PART_READ = "Only part of this source could be read.";
/** Said when a reading is `metadata` but no reader said what was missed. */
export const ABOUT_ONLY_READ = "Only this source's title and description could be read.";

/**
 * A source read only in part (`partial`) or only for its title and
 * description (`metadata`) always says so in `limitations`, so a client
 * that marks it "partly read" can say why. Readers name their own gaps; this
 * is the guard for one that did not.
 */
export function withAccessExplained<T extends { accessLevel: string; limitations: string[] }>(envelope: T): T {
  if (envelope.limitations.some((line) => line.trim())) return envelope;
  if (envelope.accessLevel === "partial") return { ...envelope, limitations: [PART_READ] };
  if (envelope.accessLevel === "metadata") return { ...envelope, limitations: [ABOUT_ONLY_READ] };
  return envelope;
}
