import { useState } from "react";
import type { Project, ProjectCounts } from "../api/types";
import { isApiError } from "../api/errors";
import { useApi } from "../app/context";
import { Confirm } from "../app/Confirm";
import { useLoad } from "../app/useLoad";

/** "3 sources, 5 made things and 2 chats": what a project holds, zeros left out. */
function countsText(counts: ProjectCounts): string {
  const parts = [
    [counts.sources, "source", "sources"],
    [counts.outputs, "made thing", "made things"],
    [counts.chats, "chat", "chats"],
    [counts.plans, "plan", "plans"],
  ] as const;
  const said = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return said.length ? new Intl.ListFormat("en", { type: "conjunction" }).format(said) : "";
}

/**
 * Asks before a project is deleted for good, saying what goes with it, counted
 * before anything is touched. A live project can be archived instead, right
 * from the question; an archived one is already put away.
 */
export function DeleteProject({
  project,
  archived,
  onCancel,
  onDone,
  onArchived,
}: {
  project: Project;
  archived?: boolean;
  onCancel: () => void;
  onDone: (said: string) => void;
  /** The project was archived from the question instead. */
  onArchived?: (project: Project) => void;
}) {
  const client = useApi();
  const counts = useLoad(() => client.projectCounts(project.id), [client, project.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await client.deleteProject(project.id);
      const what = countsText(r.deleted);
      onDone(what ? `Deleted “${project.title}” with ${what}.` : `Deleted “${project.title}”.`);
    } catch (e) {
      setBusy(false);
      setError(isApiError(e, "project_busy") ? new Error("Something in it is still running: a plan being made, or a reply being written. Open it and stop the plan, or wait, then delete it.") : e);
    }
  }
  async function archive() {
    setBusy(true);
    setError(undefined);
    try {
      onArchived?.(await client.archiveProject(project.id));
    } catch (e) {
      setBusy(false);
      setError(e);
    }
  }
  const what = counts.data ? countsText(counts.data) : "";
  return (
    <Confirm
      title={`Delete ${project.title}?`}
      action="Delete"
      {...(!archived && onArchived ? { alt: { label: "Archive instead", onClick: () => void archive() } } : {})}
      busy={busy || counts.loading}
      error={error ?? counts.error}
      onConfirm={() => void remove()}
      onCancel={onCancel}
    >
      <p>
        {!counts.data
          ? "Counting what is in it…"
          : what
            ? `Its ${what} go for good. This can't be undone. ${archived ? "To put it away and keep everything, leave it archived." : "Archive keeps them instead."}`
            : "It is empty. This can't be undone."}
      </p>
    </Confirm>
  );
}
