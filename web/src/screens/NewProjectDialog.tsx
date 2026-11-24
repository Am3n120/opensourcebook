import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useApi } from "../app/context";
import { ErrorNotice } from "../app/Status";
import { OutlineButton, PrimaryButton } from "../design/Buttons";
import { Icon } from "../design/Icon";
import { AddingList, SourceAdder } from "../sources/SourceAdder";
import { useAddQueue } from "../sources/useAddQueue";
import { useNarrow } from "../sources/useNarrow";
import "../sources/sources.css";
import { finishProject } from "./startProject";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Starts a new project: an optional name and the shared adder (files, a
 * folder, YouTube, Google Drive, a link, pasted text). Nothing is needed; the
 * project may be made empty. What was added is read first, so a blank name is
 * taken from the first source, then it is all filed into the new project.
 * On a phone it rises from the bottom as a sheet.
 */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const client = useApi();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const queue = useAddQueue(client);

  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const latest = useRef({ busy, onClose });
  useEffect(() => {
    latest.current = { busy, onClose };
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!latest.current.busy) {
          e.preventDefault();
          latest.current.onClose();
        }
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const list = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("hidden") && !el.closest("[hidden]"),
      );
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialogRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const added = await queue.run();
      const { project, first } = await finishProject(client, title, added);
      navigate(first ? `/projects/${project.id}?source=${first.source.id}` : `/projects/${project.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const waiting = queue.entries.length;

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        ref={dialogRef}
        className={`np-dialog${narrow ? " np-sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        {narrow && <span className="np-grab" aria-hidden="true" />}
        <div className="np-dh">
          <h2 id={titleId}>New project</h2>
          <button type="button" className="ib" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <form className="np-form" onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input
              ref={nameRef}
              className="ipt"
              placeholder={narrow ? "Leave blank to name it from a source" : "Leave blank to name it from your first source"}
              maxLength={200}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <SourceAdder onEntries={queue.add} disabled={busy} />
          <AddingList entries={queue.entries} onRemove={busy ? undefined : queue.remove} />
          <ErrorNotice error={error} />
          <div className="np-foot">
            <span className="np-later">You can add sources later too.</span>
            {!narrow && (
              <OutlineButton className="np-cancel" disabled={busy} onClick={onClose}>
                Cancel
              </OutlineButton>
            )}
            <PrimaryButton type="submit" wide={narrow} disabled={busy}>
              {busy ? (waiting > 0 ? "Reading and creating…" : "Creating…") : "Create"}
            </PrimaryButton>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
