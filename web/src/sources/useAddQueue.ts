import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../api/client";
import type { SourceDetail } from "../api/types";
import { addEntry, type EntryPayload, type EntryStatus, type QueueEntry } from "./addFiles";

/** What an adder hands over: the thing to add and how to name it. */
export interface NewEntry {
  payload: EntryPayload;
  label: string;
  kind: string;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "File";
}

/** A file ready to queue, named with its folder when it came from one. */
export function fileEntry(file: File): NewEntry {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return { payload: { kind: "file", file }, label: path || file.name, kind: extOf(file.name) };
}

export function linkEntry(url: string, via: "link" | "youtube" | "drive"): NewEntry {
  const kind = via === "youtube" ? "YouTube link" : via === "drive" ? "Google Drive link" : "Link";
  return { payload: { kind: "link", url: url.trim(), via }, label: url.trim(), kind };
}

export function textEntry(text: string, title: string): NewEntry {
  return { payload: { kind: "text", text, title }, label: title.trim() || text.trim().split("\n")[0]!.slice(0, 60), kind: "Pasted text" };
}

/**
 * The list of things being added. `add` queues them; `run` sends every
 * waiting one in order, marking each as it goes, and returns what was added.
 */
export function useAddQueue(client: ApiClient, projectId?: string) {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const next = useRef(0);
  const live = useRef<QueueEntry[]>([]);
  useEffect(() => {
    live.current = entries;
  });

  const setStatus = useCallback((id: string, status: EntryStatus) => setEntries((all) => all.map((e) => (e.id === id ? { ...e, status } : e))), []);

  /** Queues entries and returns them, so a caller can send just these. */
  const add = useCallback((more: NewEntry[]): QueueEntry[] => {
    const made = more.map((m) => ({ ...m, id: `q${next.current++}`, status: { state: "waiting" } as EntryStatus }));
    setEntries((all) => [...all, ...made]);
    return made;
  }, []);
  const remove = useCallback((id: string) => setEntries((all) => all.filter((e) => e.id !== id)), []);
  const clear = useCallback(() => setEntries([]), []);

  /** Sends the waiting entries one by one. A failure marks its row and stops there, throwing what went wrong. */
  const run = useCallback(
    async (target: string | undefined = projectId, only?: QueueEntry[]): Promise<SourceDetail[]> => {
      const added: SourceDetail[] = [];
      for (const entry of only ?? live.current.filter((e) => e.status.state === "waiting")) {
        try {
          added.push(await addEntry(client, entry.payload, target, (s) => setStatus(entry.id, s)));
        } catch (err) {
          setStatus(entry.id, { state: "failed", text: err instanceof Error ? err.message : "Could not be added" });
          throw err;
        }
      }
      return added;
    },
    [client, projectId, setStatus],
  );

  return { entries, add, remove, clear, run };
}
