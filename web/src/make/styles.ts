import type { FormatDescriptor, SettingField, SettingOption } from "../api/types";

export interface StyleList {
  format: FormatDescriptor;
  field: SettingField & { kind: "choice" };
  /** As the engine lists them, its "let the maker pick" option first. */
  options: SettingOption[];
}

/**
 * The styles the engine serves today: the choice setting of a format whose
 * options come with pictures (GET /v1/formats; the video makers' styles,
 * each with its `preview`). Read from the list, never written here; a new
 * style file shows up on its own. `formatId` narrows it to one shape.
 */
export function styleList(formats: readonly FormatDescriptor[], formatId?: string): StyleList | undefined {
  for (const format of formats) {
    if (formatId && format.id !== formatId) continue;
    const field = format.settings.find((f): f is SettingField & { kind: "choice" } => f.kind === "choice" && f.options.some((o) => o.preview));
    if (field) return { format, field, options: field.options };
  }
  return undefined;
}

/** The style a value means: the picked one, else the shape's default. */
export function styleOf(list: StyleList, value: string | null): SettingOption | undefined {
  const id = value ?? list.format.defaults[list.field.key];
  return list.options.find((o) => o.value === id);
}

/** About five short lines of a card: a first sentence longer than this is cut at its last comma or semicolon before it, else at a word. */
const SHORT = 100;

/** A style's first sentence, cut short at a pause when it runs long, and whether there is more after it. */
export function firstSentence(text: string): { first: string; more: boolean } {
  const all = text.trim();
  const m = /^.+?[.!?](?=\s|$)/s.exec(all);
  let first = m ? m[0] : all;
  if (first.length > SHORT) {
    const pause = Math.max(first.lastIndexOf(",", SHORT), first.lastIndexOf(";", SHORT));
    first = `${first.slice(0, pause > SHORT / 2 ? pause : first.lastIndexOf(" ", SHORT)).trimEnd()}…`;
  }
  return { first, more: first.length < all.length || first.endsWith("…") };
}
