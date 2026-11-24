import type { ApiClient } from "../api/client";
import { isApiError } from "../api/errors";

/** Whether a file found in a folder is one to add, by its name. */
export type IsReadable = (name: string) => boolean;

/** File endings taken when the engine does not list its own (an engine older than `GET /v1/uploads/types`). */
const FALLBACK = [
  "pdf",
  "doc", "docx", "ppt", "pptx", "xls", "xlsx", "odt", "odp", "ods", "rtf", "epub",
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "srt", "vtt", "tex",
  "png", "jpg", "jpeg", "webp", "gif", "heic", "bmp", "tif", "tiff",
  "mp3", "m4a", "wav", "ogg", "oga", "aac", "flac", "opus",
  "mp4", "mov", "webm", "m4v",
];

/** Reads a name by its ending, against these endings: a hidden file or an unknown kind is left out. */
export function readableBy(endings: Iterable<string>): IsReadable {
  const set = new Set([...endings].map((e) => e.replace(/^\./, "").toLowerCase()));
  return (name) => {
    const base = name.split("/").pop() ?? name;
    if (base.startsWith(".")) return false;
    const dot = base.lastIndexOf(".");
    return dot > 0 && set.has(base.slice(dot + 1).toLowerCase());
  };
}

const asked = new WeakMap<ApiClient, Promise<IsReadable>>();

/**
 * What a folder's files are kept by: the engine's own list of the types it
 * takes (`GET /v1/uploads/types`, the list `POST /v1/uploads` checks), asked
 * once per client. Only an engine without that route falls back to the list
 * above; any other failure is thrown, and asked again next time.
 */
export function readableFiles(client: ApiClient): Promise<IsReadable> {
  const known = asked.get(client);
  if (known) return known;
  const loading = client.uploadTypes().then(
    (r) => readableBy(r.types.flatMap((t) => t.extensions)),
    (e: unknown) => {
      asked.delete(client);
      if (isApiError(e) && e.status === 404) return readableBy(FALLBACK);
      throw e;
    },
  );
  asked.set(client, loading);
  return loading;
}

/** "3 files", "1 file". */
export function countFiles(n: number): string {
  return `${n} ${n === 1 ? "file" : "files"}`;
}
