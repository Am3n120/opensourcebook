import { useState } from "react";
import { sourceKind } from "../../api/measure";
import type { Source } from "../../api/types";
import { Icon } from "../../design/Icon";
import { Checkbox } from "../../design/ui";
import { useDismiss } from "../../design/useDismiss";
import { useNarrow } from "../../sources/useNarrow";

/**
 * The sources chip in the chat box, "N sources", and what it opens: which
 * sources this chat reads, ticked as in the Sources panel (the same ticks),
 * "Use all" when some are off, and Add sources. On a phone the chip is the
 * count with the sources icon, and the list rises from the bottom as a sheet.
 */
export function SourcesChip({
  sources,
  unselected,
  onChange,
  onAdd,
  disabled,
}: {
  /** The sources the chat could read: none that failed. */
  sources: Source[];
  unselected: ReadonlySet<string>;
  onChange: (unselected: Set<string>) => void;
  /** Opens the adder; left out where sources can't be added. */
  onAdd?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const narrow = useNarrow();
  const box = useDismiss<HTMLSpanElement>(open, () => setOpen(false));
  const on = sources.filter((s) => !unselected.has(s.id)).length;
  if (sources.length === 0) return null;
  const words = on === sources.length ? `${on} source${on === 1 ? "" : "s"}` : `${on} of ${sources.length} sources`;
  function tick(id: string, yes: boolean) {
    const next = new Set(unselected);
    if (yes) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  return (
    <span className="cchip-at" ref={box}>
      <button type="button" className={`cchip${open ? " on" : ""}${on < sources.length ? " some" : ""}`} aria-expanded={open} aria-haspopup="dialog" aria-label={`This chat reads ${words}. Change`} disabled={disabled} onClick={() => setOpen(!open)}>
        {narrow ? (
          <>
            <Icon name="doc" />
            {on === sources.length ? on : `${on}/${sources.length}`}
          </>
        ) : (
          words
        )}
      </button>
      {open && narrow && <div className="srcpop-scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
      {open && (
        <div className="cpop srcpop" role="dialog" aria-label="This chat reads" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {narrow && <span className="srcpop-grab" aria-hidden="true" />}
          <div className="srcpop-hd">
            <b>This chat reads</b>
            {on < sources.length && (
              <button type="button" className="link small" onClick={() => onChange(new Set())}>
                Use all {sources.length}
              </button>
            )}
          </div>
          <ul className="srcpop-list">
            {sources.map((s) => {
              const yes = !unselected.has(s.id);
              return (
                <li key={s.id} className={yes ? undefined : "off"}>
                  <Checkbox checked={yes} onChange={(v) => tick(s.id, v)} label={`Read ${s.title} in this chat`} />
                  <span>
                    <b>{s.title}</b>
                    <small>{sourceKind(s)}</small>
                  </span>
                </li>
              );
            })}
          </ul>
          {onAdd && (
            <button
              type="button"
              className="obtn srcpop-add"
              onClick={() => {
                setOpen(false);
                onAdd();
              }}
            >
              <Icon name="plus" />
              Add sources
            </button>
          )}
          <p className="srcpop-note">Same ticks as the Sources panel. What you make from this chat reads these too.</p>
        </div>
      )}
    </span>
  );
}
