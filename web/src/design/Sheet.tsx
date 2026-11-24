import { createContext, useContext, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import { OutlineButton, PrimaryButton } from "./Buttons";

/** Set by a host that already dims the page behind its view (the project's right column on a phone), so a sheet inside draws no second scrim. */
// eslint-disable-next-line react-refresh/only-export-components -- the context belongs beside the sheet that reads it.
export const ScrimDrawn = createContext(false);

/** Set by that same host: a sheet inside hands it its own close, so pressing the host's scrim closes the sheet the way its own buttons do (asking first, when it asks). */
// eslint-disable-next-line react-refresh/only-export-components -- the context belongs beside the sheet that reads it.
export const ScrimClose = createContext<((close: (() => void) | null) => void) | null>(null);

/** Anything drawn over the sheet's own fields: a picker, a dialog, a menu. Escape is theirs while one is open. */
const ABOVE = '.picker-layer, [role="dialog"], [role="alertdialog"], [role="menu"]';

export interface SheetProps {
  title: string;
  /** The tile beside the title, such as the shape's FormatTile. */
  icon?: ReactNode;
  /** Back (in the right panel) or close (on a phone); both go where the sheet was opened from. */
  onClose: () => void;
  /** What going back leads to, for screen readers: "Back to Made here". */
  closeLabel?: string;
  children: ReactNode;
  /** The filled button at the foot: "Make the video". */
  primary: { label: string; onClick: () => void; disabled?: boolean };
  cancelLabel?: string;
}

/**
 * The make sheet's frame: back, tile, title, a body that scrolls, and a foot
 * with Cancel and one filled button. At phone width it rises from the bottom
 * over a dimmed page, with a close button and only the filled button.
 */
export function Sheet({ title, icon, onClose, closeLabel = "Back", children, primary, cancelLabel = "Cancel" }: SheetProps) {
  const heading = useId();
  const dimmed = useContext(ScrimDrawn);
  const host = useContext(ScrimClose);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    if (!host) return;
    host(() => latest.current());
    return () => host(null);
  }, [host]);
  // Escape closes only the topmost thing: a picker or dialog open over the sheet (or drawn from it in a portal) takes it first.
  function escape(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const sheet = e.currentTarget;
    if (!sheet.contains(e.target as Node) || sheet.querySelector(ABOVE)) return;
    // Taken here: a question the close opens ("Discard what you filled in?") must not see this same press.
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }
  return (
    <>
      {!dimmed && <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />}
      <section className="sheet" aria-labelledby={heading} onKeyDown={escape}>
        <span className="sheet-grab" aria-hidden="true" />
        <header className="sheet-head">
          <button type="button" className="ib sheet-back" aria-label={closeLabel} onClick={onClose}>
            <Icon name="chev-l" />
          </button>
          {icon}
          <h2 id={heading}>{title}</h2>
          <button type="button" className="ib sheet-close" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        <footer className="sheet-foot">
          <OutlineButton className="sheet-cancel" onClick={onClose}>
            {cancelLabel}
          </OutlineButton>
          <PrimaryButton onClick={primary.onClick} disabled={primary.disabled}>
            {primary.label}
          </PrimaryButton>
        </footer>
      </section>
    </>
  );
}
