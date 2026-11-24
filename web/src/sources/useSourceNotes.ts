import { useState } from "react";
import { isApiError } from "../api/errors";
import type { Source } from "../api/types";
import { useApi } from "../app/context";
import { useLoad } from "../app/useLoad";
import { readMark } from "./sourceText";

/** What a source's row says beside its name, from its reading: why it failed, or what could not be read. */
export interface SourceNote {
  /** Why it could not be read, in the engine's words. */
  error?: string;
  /** What could not be read, one plain line each. */
  limitations?: string[];
}

/**
 * The notes of the sources that need one. Why one could not be read comes
 * with the list; what could not be read of one read in part or by title
 * is read from the source itself, so only those are loaded.
 */
export function useSourceNotes(sources: Source[]): { notes: Map<string, SourceNote>; set: (id: string, note: SourceNote) => void } {
  const client = useApi();
  const partial = sources.filter((s) => readMark(s) !== undefined);
  const key = partial.map((s) => `${s.id}@${s.updatedAt}`).join(",");
  const loaded = useLoad(
    () => Promise.all(partial.map((s) => client.getSource(s.id).then((d) => [s.id, d.extraction.limitations?.length ? { limitations: d.extraction.limitations } : {}] as const, () => [s.id, {}] as const))),
    [client, key],
  );
  const [fresh, setFresh] = useState<Map<string, SourceNote>>(new Map());
  const failed = sources.flatMap((s) => (s.status === "failed" && s.errorMessage ? [[s.id, { error: s.errorMessage }] as const] : []));
  const notes = new Map<string, SourceNote>([...failed, ...(loaded.data ?? []), ...fresh]);
  return { notes, set: (id, note) => setFresh((m) => new Map(m).set(id, note)) };
}

/** Reads a source that could not be read once more; says calmly when it is being read already. */
export function useRetrySource(onRead: (id: string, note: SourceNote) => void, after: () => Promise<void> | void) {
  const client = useApi();
  const [retrying, setRetrying] = useState<string>();
  async function retry(source: Source) {
    setRetrying(source.id);
    try {
      const d = await client.retrySource(source.id);
      onRead(source.id, d.extraction.errorMessage ? { error: d.extraction.errorMessage } : {});
    } catch (e) {
      if (isApiError(e, "source_busy")) onRead(source.id, { error: "It is being read right now. This updates when it is done." });
      else if (!isApiError(e, "source_not_failed")) onRead(source.id, { error: isApiError(e) ? e.message : "It could not be read again just now." });
    } finally {
      setRetrying(undefined);
      await after();
    }
  }
  return { retrying, retry };
}
