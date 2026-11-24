import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "../design/Icon";
import { OutlineButton, PrimaryButton } from "../design/Buttons";

/**
 * The frame of a picker opened from a row: a dialog over a dimmed page with
 * a title, an optional line under it, a body and a foot with Cancel and one
 * filled button. Under 640px it rises from the bottom as a sheet.
 */
export function Picker({
  title,
  note,
  className,
  onClose,
  primary,
  footNote,
  children,
}: {
  title: string;
  note?: string;
  className?: string;
  onClose: () => void;
  primary: { label: string; onClick: () => void; disabled?: boolean };
  /** A quiet line above the buttons. */
  footNote?: string;
  children: ReactNode;
}) {
  const heading = useId();
  const box = useRef<HTMLElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.querySelector<HTMLElement>('[aria-pressed="true"], [aria-selected="true"], button:not([disabled])')?.focus();
    // Escape closes only the topmost thing: this picker, when no other picker or dialog is open over it.
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const layers = document.querySelectorAll(".picker-layer");
      if (layers[layers.length - 1] !== layer.current || document.querySelector('[role="alertdialog"]')) return;
      e.preventDefault();
      close.current();
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      opener?.focus();
    };
  }, []);
  return (
    <div ref={layer} className="picker-layer">
      <div className="picker-scrim" aria-hidden="true" onClick={onClose} />
      <section ref={box} className={`picker${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={heading}>
        <span className="picker-grab" aria-hidden="true" />
        <header className="picker-head">
          <div>
            <h2 id={heading}>{title}</h2>
            {note && <p>{note}</p>}
          </div>
          <button type="button" className="ib" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </header>
        <div className="picker-body">{children}</div>
        {footNote && <p className="picker-note">{footNote}</p>}
        <footer className="picker-foot">
          <OutlineButton className="picker-cancel" onClick={onClose}>
            Cancel
          </OutlineButton>
          <PrimaryButton onClick={primary.onClick} disabled={primary.disabled}>
            {primary.label}
          </PrimaryButton>
        </footer>
      </section>
    </div>
  );
}
