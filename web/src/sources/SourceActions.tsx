import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { isApiError } from "../api/errors";
import type { Source, SourceRemoved } from "../api/types";
import { useApi } from "../app/context";
import { Confirm } from "../app/Confirm";
import { Icon } from "../design/Icon";
import { useDismiss } from "../design/useDismiss";
import "./sources.css";

/** The ⋯ on a source's row: rename, any actions the place offers, and Remove last. */
export function SourceMenu({ source, onRename, onRemove, extra }: { source: Source; onRename: () => void; onRemove: () => void; extra?: Array<{ label: string; run: () => void }> }) {
  // Placed against the window, so a list that scrolls never clips it; it opens upward near the bottom.
  const [at, setAt] = useState<CSSProperties>();
  const open = at !== undefined;
  const box = useDismiss<HTMLSpanElement>(open, () => setAt(undefined));
  const name = source.title;
  useEffect(() => {
    if (!open) return;
    const close = () => setAt(undefined);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  function toggle(button: HTMLElement) {
    if (open) return setAt(undefined);
    const r = button.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    setAt(r.bottom + 180 > window.innerHeight ? { position: "fixed", right, bottom: window.innerHeight - r.top + 6, top: "auto" } : { position: "fixed", right, top: r.bottom + 6 });
  }
  const setOpen = (v: boolean) => !v && setAt(undefined);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <span className="anchor smenu" ref={box}>
      <button className="x more" type="button" aria-label={`More for ${name}`} title="More" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu" style={at} role="menu" aria-label={`More for ${name}`}>
          <button className="mi" type="button" role="menuitem" onClick={pick(onRename)}>
            Rename
          </button>
          {extra?.map((x) => (
            <button key={x.label} className="mi" type="button" role="menuitem" onClick={pick(x.run)}>
              {x.label}
            </button>
          ))}
          <hr />
          <button className="mi danger" type="button" role="menuitem" onClick={pick(onRemove)}>
            Remove…
          </button>
        </div>
      )}
    </span>
  );
}

/** A source's name, edited in place: Enter saves, Escape or leaving the box empty-handed cancels. Empty goes back to the name it was read with. */
export function RenameSource({ source, onDone, className }: { source: Source; onDone: (renamed?: Source) => void; className?: string }) {
  const client = useApi();
  const [title, setTitle] = useState(source.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const cancelled = useRef(false);
  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (cancelled.current || busy) return;
    const next = title.trim();
    if (next === (source.title ?? "").trim()) return onDone();
    setBusy(true);
    try {
      onDone(await client.renameSource(source.id, next || null));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <form className={`srename${className ? ` ${className}` : ""}`} onSubmit={save}>
      <input
        className="ipt"
        autoFocus
        aria-label="Source name"
        maxLength={200}
        placeholder={source.url ?? "Name"}
        value={title}
        disabled={busy}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          cancelled.current = true;
          onDone();
        }}
        onBlur={() => !error && void save()}
      />
      {error !== undefined && <small className="fail">Could not rename it. Try again.</small>}
    </form>
  );
}

/**
 * Asks before a source is removed and says what happens (docs/DECISIONS.md
 * #52): chats stop using it and plans not started stop reading it; what was
 * made, started or cited keeps pointing at it and still opens it.
 */
export function RemoveSource({ source, place, onDone, onCancel }: { source: Source; /** "this project" or "the Inbox". */ place: string; onDone: (result: SourceRemoved) => void; onCancel: () => void }) {
  const client = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      onDone(await client.removeSource(source.id));
    } catch (e) {
      // Already gone (removed in another tab): the list just catches up.
      if (isApiError(e) && e.status === 404) return onDone({ sourceId: source.id, deleted: true, changedPlanIds: [] });
      setError(e);
      setBusy(false);
    }
  }
  return (
    <Confirm title={`Remove “${source.title}”?`} action="Remove source" busy={busy} error={error} onConfirm={() => void remove()} onCancel={onCancel}>
      <p>It leaves {place}. Chats stop using it, and plans not started yet stop reading it.</p>
      <p>Answers, started plans and things made from it keep their citations, and those still open it.</p>
    </Confirm>
  );
}
