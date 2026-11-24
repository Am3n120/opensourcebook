import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./Icon";
import { useDismiss } from "./useDismiss";

/** One line of a row's menu. A `danger` line comes last, under a rule, in red when pointed at. */
export interface RowMenuItem {
  label: string;
  /** A few quiet words after the label, such as why it is greyed. */
  note?: string;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * The ⋯ at the end of a row in a list, and the small menu it opens. The menu
 * is placed against the window, so a list that scrolls never clips it, and it
 * opens upward near the bottom. Scrolling, resizing, Escape or a press
 * outside closes it.
 */
export function RowMenu({ name, items, className }: { /** What the row is, for "More for …". */ name: string; items: RowMenuItem[]; className?: string }) {
  const [at, setAt] = useState<CSSProperties>();
  const open = at !== undefined;
  const box = useDismiss<HTMLSpanElement>(open, () => setAt(undefined));
  const pop = useRef<HTMLDivElement>(null);
  // A menu wider than the room left of its button (a card at the left of a phone) slides right until it is inside the window.
  useLayoutEffect(() => {
    const box = pop.current?.getBoundingClientRect();
    if (box && box.width > 0 && box.left < 8) setAt((now) => (now ? { ...now, left: 8, right: "auto" } : now));
  }, [at]);
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
    const tall = 44 * items.length + 24;
    setAt(r.bottom + tall > window.innerHeight ? { position: "fixed", right, bottom: window.innerHeight - r.top + 6, top: "auto" } : { position: "fixed", right, top: r.bottom + 6 });
  }
  const plain = items.filter((i) => !i.danger);
  const danger = items.filter((i) => i.danger);
  const line = (i: RowMenuItem) => (
    <button
      key={i.label}
      className={`mi${i.danger ? " danger" : ""}`}
      type="button"
      role="menuitem"
      disabled={i.disabled}
      onClick={() => {
        setAt(undefined);
        i.run();
      }}
    >
      {i.label}
      {i.note && <small>{i.note}</small>}
    </button>
  );
  return (
    <span className={`anchor rmenu${className ? ` ${className}` : ""}`} ref={box}>
      <button className="ib" type="button" aria-label={`More for ${name}`} title="More" aria-haspopup="menu" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu rmenu-pop" ref={pop} style={at} role="menu" aria-label={`More for ${name}`}>
          {plain.map(line)}
          {plain.length > 0 && danger.length > 0 && <hr />}
          {danger.map(line)}
        </div>
      )}
    </span>
  );
}
