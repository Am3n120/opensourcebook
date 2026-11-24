import { useRef, type TouchEvent } from "react";

/** How far a finger must travel sideways, in CSS pixels, for a swipe. */
const DISTANCE = 40;

/**
 * Sideways swipes inside a thing (docs/DECISIONS.md #36): a
 * finger moving left goes on, moving right goes back. A movement mostly up
 * or down is left alone, so the feed around it still scrolls.
 */
export function useSwipe(onNext: () => void, onPrev: () => void) {
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  return {
    onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      start.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : undefined;
    },
    onTouchEnd(e: TouchEvent) {
      const from = start.current;
      const t = e.changedTouches[0];
      start.current = undefined;
      if (!from || !t) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (Math.abs(dx) < DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) onNext();
      else onPrev();
    },
  };
}
