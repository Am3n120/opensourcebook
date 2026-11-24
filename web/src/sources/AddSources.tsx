import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SourceDetail } from "../api/types";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { Icon } from "../design/Icon";
import { PrimaryButton } from "../design/Buttons";
import { AddingList, SourceAdder, type Tile } from "./SourceAdder";
import { useAddQueue } from "./useAddQueue";
import "./sources.css";

/** Which way to add is open from the start. */
export type Mode = "link" | "text" | "upload" | "youtube" | "drive";

const TILE_OF: Record<Mode, Tile | undefined> = { link: "link", text: "text", youtube: "youtube", drive: "drive", upload: undefined };

/**
 * Adds sources by file, folder, YouTube, Google Drive, link or pasted text
 * (POST /v1/uploads, then POST /v1/sources). Each goes up as soon as it is
 * picked and shows where it stands. With a project it goes there; without,
 * into the Inbox. `onAdded` is called for each source once the batch is done.
 */
export function AddSources({
  projectId,
  onAdded,
  initialMode,
  onDone,
}: {
  projectId?: string;
  onAdded: (added: SourceDetail) => void;
  initialMode?: Mode;
  /** Shows a Done button that calls this, as the dialog does. */
  onDone?: () => void;
}) {
  const client = useApi();
  const queue = useAddQueue(client, projectId);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<unknown>();
  const added = useRef<SourceDetail[]>([]);

  async function take(more: Parameters<typeof queue.add>[0]) {
    const mine = queue.add(more);
    setError(undefined);
    setBusy((n) => n + 1);
    try {
      const done = await queue.run(projectId, mine);
      added.current.push(...done);
    } catch (err) {
      setError(err);
    } finally {
      setBusy((n) => n - 1);
    }
  }

  // Once nothing is still going up, hand over what was added.
  useEffect(() => {
    if (busy === 0 && added.current.length > 0) {
      const done = added.current;
      added.current = [];
      done.forEach(onAdded);
    }
  });

  return (
    <div className="addsrc" role="group" aria-label="Add sources">
      <SourceAdder onEntries={(e) => void take(e)} initial={initialMode ? TILE_OF[initialMode] : undefined} />
      <AddingList entries={queue.entries} />
      <ErrorNotice error={error} />
      {onDone && (
        <div className="addsrc-foot">
          <PrimaryButton onClick={onDone} disabled={busy > 0}>
            Done
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

/**
 * Add sources to a project as its own dialog: "Add sources to <project>", the
 * same adder, the list of what is being added, and Done. Escape closes it.
 */
export function AddSourcesDialog({ projectId, projectTitle, onAdded, onClose }: { projectId: string; projectTitle: string; onAdded: (added: SourceDetail) => void; onClose: () => void }) {
  const heading = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} tabIndex={-1} className="np-dialog as-dialog" role="dialog" aria-modal="true" aria-labelledby={heading}>
        <div className="np-dh">
          <h2 id={heading}>Add sources to {projectTitle}</h2>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <AddSources projectId={projectId} onAdded={onAdded} onDone={onClose} />
      </div>
    </div>,
    document.body,
  );
}
