import { useEffect, useRef, type RefObject } from "react";

const ITEMS = '[role="menuitem"], .menu button, .menu a';

/**
 * Closes a menu or popover when the person presses outside it or presses
 * Escape, and makes it usable from the keyboard: opening moves focus to its
 * first item, the arrow keys move between items, and Escape gives focus back
 * to the button that opened it. Returns the ref for the element that holds
 * the button and the menu, and accepts an optional `extra` ref when the
 * popup itself renders in a portal outside `box`.
 */
export function useDismiss<T extends HTMLElement = HTMLDivElement>(open: boolean, close: () => void, extra?: RefObject<HTMLElement | null>) {
  const box = useRef<T>(null);
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...(box.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])].filter((e) => !e.hasAttribute("disabled"));
    // A menu that holds a form (renaming in place) keeps its own focus.
    if (!box.current?.querySelector(".menu input, .menu textarea")) items()[0]?.focus();
    const outside = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !extra?.current?.contains(e.target as Node) && latest.current();
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        latest.current();
        if (opener && box.current?.contains(opener)) opener.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      e.preventDefault();
      list[(at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length]?.focus();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", keys);
    };
  }, [open, extra]);
  return box;
}
