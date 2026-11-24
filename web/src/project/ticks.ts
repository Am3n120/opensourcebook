import type { Source } from "../api/types";

/** Sources a chat can read: everything but a source that could not be read, which is never ticked or counted. */
export function usable(sources: Source[]): Source[] {
  return sources.filter((s) => s.status !== "failed");
}

const key = (projectId: string) => `opensourcebook.newChatTicks.${projectId}`;

/**
 * The ticks of a new chat, kept in this browser until its first message
 * creates the chat (the engine saves a chat's ticks from then on). Undefined
 * is every source. Storage that is blocked or empty reads as undefined.
 */
export function loadNewChatTicks(projectId: string): string[] | undefined {
  try {
    const raw = localStorage.getItem(key(projectId));
    const ids: unknown = raw ? JSON.parse(raw) : undefined;
    return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ids : undefined;
  } catch {
    return undefined;
  }
}

export function saveNewChatTicks(projectId: string, ids: string[] | undefined): void {
  try {
    if (ids) localStorage.setItem(key(projectId), JSON.stringify(ids));
    else localStorage.removeItem(key(projectId));
  } catch {
    // Storage blocked: the ticks last until the page is left, as before.
  }
}

/** The ticked ids to save: undefined when every readable source is ticked. */
export function tickedIds(sources: Source[], unselected: ReadonlySet<string>): string[] | undefined {
  const readable = usable(sources);
  const on = readable.filter((s) => !unselected.has(s.id)).map((s) => s.id);
  return on.length === readable.length ? undefined : on;
}
