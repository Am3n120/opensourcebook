/**
 * The one name a source is shown by, everywhere it is named: lists, the
 * Inbox, chat context, briefs and cites. The person's own name for it wins;
 * else the title read from it (shared by everyone who added the same
 * content); else, for an upload, the name the file came with; else a plain
 * fallback from what it is.
 */

/** The longest fallback built from a link or a file name. */
const MAX_FALLBACK_NAME = 80;

export interface SourceNameParts {
  /** The person's own name for it (a rename, or a title sent when it was added). */
  own?: string | null;
  /** The title its reading found. */
  read?: string | null;
  kind: string;
  url?: string | null;
  /** The name an uploaded file came with, as sent (it may carry a path). */
  fileName?: string | null;
  origin?: string | null;
}

/** Fallback words for an uploaded file, by source kind. A kind not listed is a "File". */
const FILE_WORDS: Readonly<Record<string, string>> = {
  pdf: "PDF file",
  text: "Text file",
  image: "Picture",
  video: "Video file",
  podcast: "Sound file",
  spreadsheet: "Spreadsheet",
};

export function sourceTitle(parts: SourceNameParts): string {
  const own = parts.own?.trim();
  if (own) return own;
  const read = parts.read?.trim();
  if (read) return read;
  const file = parts.fileName ? fileTitle(parts.fileName) : undefined;
  if (file) return file;
  if (parts.url) {
    const name = linkName(parts.url);
    if (name) return name;
  }
  if (parts.origin === "paste") return "Pasted text";
  if (parts.origin === "note") return "Note";
  if (parts.origin === "upload") return FILE_WORDS[parts.kind] ?? "File";
  return "Untitled source";
}

/**
 * `week-3 notes` from `C:\notes\week-3 notes.md`: the file name without
 * its folders, and without its extension when what is left still has a
 * letter in it (`2024.pdf` stays as it is).
 */
export function fileTitle(fileName: string): string | undefined {
  const base = fileName.split(/[\\/]/).pop()?.trim() ?? "";
  if (!base) return undefined;
  const stem = base.replace(/\.[A-Za-z0-9]{1,8}$/, "").trim();
  const name = stem && /\p{L}/u.test(stem) ? stem : base;
  return name.length <= MAX_FALLBACK_NAME ? name : `${name.slice(0, MAX_FALLBACK_NAME - 1).trimEnd()}…`;
}

/** `example.com/notes/week-3` from a link: the host without `www.` and the path, short. */
function linkName(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (!host) return undefined;
    const path = decodeSafely(parsed.pathname).replace(/\/+$/, "");
    const name = `${host}${path}`;
    return name.length <= MAX_FALLBACK_NAME ? name : `${name.slice(0, MAX_FALLBACK_NAME - 1).trimEnd()}…`;
  } catch {
    return undefined;
  }
}

function decodeSafely(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
