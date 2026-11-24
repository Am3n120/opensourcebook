import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ErrorNotice } from "./Status";

/**
 * Asks once before something is lost: what goes, in plain words, and one red
 * button that does it. Cancel is focused, so Enter or Escape never loses
 * anything by accident; pressing outside cancels too.
 */
export function Confirm({
  title,
  children,
  action,
  alt,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  children?: ReactNode;
  /** The red button's words: what it does ("Delete chat"). */
  action: string;
  /** An optional gentler way out, a button between Cancel and the red one ("Archive instead"). */
  alt?: { label: string; onClick: () => void };
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // Cancel takes focus once, when the card opens; a later render (counts arriving, busy) leaves focus where the person put it.
  useEffect(() => cancel.current?.focus(), []);
  const latest = useRef({ busy, onCancel });
  useEffect(() => {
    latest.current = { busy, onCancel };
  });
  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && !latest.current.busy && latest.current.onCancel();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={children ? bodyId : undefined}>
        <h2 id={titleId}>{title}</h2>
        {children && <div id={bodyId}>{children}</div>}
        <ErrorNotice error={error} />
        <div className="acts">
          <button ref={cancel} className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          {alt && (
            <button className="btn ghost" type="button" disabled={busy} onClick={alt.onClick}>
              {alt.label}
            </button>
          )}
          <button className="btn danger solid" type="button" disabled={busy} onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
