import type { ApiClient } from "../api/client";
import type { SourceDetail } from "../api/types";

export type SourcePayload =
  | { mode: "upload"; files: File[] }
  | { mode: "link"; url: string }
  | { mode: "text"; text: string; title?: string };

/** Uploads each file under its name, then adds it as a source (POST /v1/uploads, then POST /v1/sources); the engine names it by its file. */
export async function addFiles(client: ApiClient, files: File[], projectId?: string): Promise<SourceDetail[]> {
  const added: SourceDetail[] = [];
  for (const file of files) {
    const upload = await client.upload(file, file.name);
    added.push(await client.addSource({ uploadId: upload.id, ...(projectId ? { projectId } : {}) }));
  }
  return added;
}

/** Submits one source by upload, link or pasted text; with `projectId` it goes into that project, else into the Inbox. */
export async function submitSource(client: ApiClient, payload: SourcePayload, projectId?: string): Promise<SourceDetail[]> {
  const place = projectId ? { projectId } : {};
  if (payload.mode === "upload") return addFiles(client, payload.files, projectId);
  if (payload.mode === "link") return [await client.addSource({ url: payload.url.trim(), ...place })];
  return [await client.addSource({ text: payload.text, ...(payload.title?.trim() ? { title: payload.title.trim() } : {}), ...place })];
}

/** Submits several source entries in order through the shared upload, link and paste paths. */
export async function submitSources(client: ApiClient, payloads: readonly SourcePayload[], projectId?: string): Promise<SourceDetail[]> {
  const added: SourceDetail[] = [];
  for (const payload of payloads) added.push(...(await submitSource(client, payload, projectId)));
  return added;
}

/** One thing waiting to be added: a file, a link (from the Link, YouTube or Google Drive field) or pasted text. */
export type EntryPayload =
  | { kind: "file"; file: File }
  | { kind: "link"; url: string; via: "link" | "youtube" | "drive" }
  | { kind: "text"; text: string; title?: string };

export type EntryState = "waiting" | "adding" | "reading" | "done" | "failed";

/** Where one entry stands, in the words shown beside it. */
export interface EntryStatus {
  state: EntryState;
  text?: string;
}

export interface QueueEntry {
  id: string;
  /** The name shown: the file's name (with its folder), the address, or the pasted text's title. */
  label: string;
  /** What it is: "PDF", "YouTube link", "Google Drive link", "Link", "Pasted text". */
  kind: string;
  payload: EntryPayload;
  status: EntryStatus;
}

/**
 * Adds a shared Google Drive file or folder by its link. The engine fetches a
 * shared Drive link like any link; this is the one place to swap in its own
 * route if it gets one.
 */
export function addDriveLink(client: ApiClient, url: string, projectId?: string): Promise<SourceDetail> {
  return client.addSource({ url: url.trim(), ...(projectId ? { projectId } : {}) });
}

/** Adds one entry, saying "adding" while it goes up. A project's id puts it there, else it lands in the Inbox. */
export async function addEntry(client: ApiClient, payload: EntryPayload, projectId?: string, onState?: (status: EntryStatus) => void): Promise<SourceDetail> {
  const place = projectId ? { projectId } : {};
  onState?.({ state: "adding" });
  let added: SourceDetail;
  if (payload.kind === "file") {
    const upload = await client.upload(payload.file, payload.file.name);
    added = await client.addSource({ uploadId: upload.id, ...place });
  } else if (payload.kind === "link") {
    added = payload.via === "drive" ? await addDriveLink(client, payload.url, projectId) : await client.addSource({ url: payload.url.trim(), ...place });
  } else {
    added = await client.addSource({ text: payload.text, ...(payload.title?.trim() ? { title: payload.title.trim() } : {}), ...place });
  }
  onState?.(readStatus(added));
  return added;
}

/** How an added source stands: read, being read, or not readable. */
export function readStatus(a: SourceDetail): EntryStatus {
  if (a.extraction.status === "failed") return { state: "failed", text: "Added, but it could not be read" };
  if (a.extraction.status === "ready") return { state: "done", text: "Read" };
  return { state: "reading", text: "Reading" };
}
