import type { ApiClient } from "../api/client";
import type { Project, SourceDetail } from "../api/types";
import { submitSources, type SourcePayload } from "../sources/addFiles";

/** What was dropped or pasted: files, a link, or some text. */
export type Dropped = { files: File[] } | { link: string } | { text: string };

/** A link when the whole of what was pasted is one web address, else text. */
export function readPasted(pasted: string): Dropped | undefined {
  const trimmed = pasted.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { link: trimmed };
  return { text: pasted };
}

/** The name a project takes when the person gave none and nothing was read to name it from. */
export const FALLBACK_PROJECT_NAME = "Untitled project";

/** Makes the project for sources already read, named as typed or from the first one, and files them into it. */
export async function finishProject(client: ApiClient, title: string | undefined, added: readonly SourceDetail[]): Promise<{ project: Project; first?: SourceDetail }> {
  const first = added[0];
  const name = (title?.trim() || first?.source.title || FALLBACK_PROJECT_NAME).slice(0, 200);
  const project = await client.createProject({ title: name });
  for (const a of added) await client.fileSource(a.source.id, project.id);
  return first ? { project, first } : { project };
}

/**
 * Creates a project with optional sources through the shared upload, link and
 * paste paths: any non-empty sources are read first so an unnamed project can
 * take the title read from its first source, then filed into the new project.
 */
export async function createProjectWithSources(
  client: ApiClient,
  input: { title?: string; sources?: readonly SourcePayload[] },
): Promise<{ project: Project; first?: SourceDetail }> {
  const active = (input.sources ?? []).filter((s) =>
    s.mode === "upload" ? s.files.length > 0 : s.mode === "link" ? s.url.trim() !== "" : s.text.trim() !== "",
  );
  const added = await submitSources(client, active);
  return finishProject(client, input.title, added);
}

/**
 * Makes a project from what was dropped: the sources are read first, the
 * project takes the typed name or the name read from the first source, and
 * they are filed into it.
 */
export async function startProject(client: ApiClient, dropped: Dropped, title?: string): Promise<{ project: Project; first: SourceDetail }> {
  const payload: SourcePayload =
    "files" in dropped ? { mode: "upload", files: dropped.files } : "link" in dropped ? { mode: "link", url: dropped.link } : { mode: "text", text: dropped.text };
  const created = await createProjectWithSources(client, { ...(title !== undefined ? { title } : {}), sources: [payload] });
  if (!created.first) throw new Error("Nothing was added.");
  return { project: created.project, first: created.first };
}
