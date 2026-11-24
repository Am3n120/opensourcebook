import { useLayoutEffect, useState } from "react";

/**
 * Which ends of a scrolling box have more past them, as a class for the box:
 * `fade-top`, `fade-bottom`, both or none. The chat's CSS fades the box's
 * content out at an edge it is cut at, so a list that scrolls says so.
 * Returns the callback to put on the box as its ref, and the class; `shows`
 * names what the box shows, so it is read again when that changes.
 */
export function useScrollFade<E extends HTMLElement>(shows?: unknown): [(el: E | null) => void, string] {
  const [el, setEl] = useState<E | null>(null);
  const [cut, setCut] = useState({ top: false, bottom: false });
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setCut((old) => (old.top === top && old.bottom === bottom ? old : { top, bottom }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const watch = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(read);
    watch?.observe(el);
    for (const child of el.children) watch?.observe(child);
    return () => {
      el.removeEventListener("scroll", read);
      watch?.disconnect();
    };
  }, [el, shows]);
  return [setEl, `${cut.top ? " fade-top" : ""}${cut.bottom ? " fade-bottom" : ""}`];
}
