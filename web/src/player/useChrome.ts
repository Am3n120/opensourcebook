import { createContext, useContext, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * What a player may tell the chrome around it (`useChrome`). Every field is
 * optional; a player that says nothing still gets the whole chrome, with the
 * made thing's own title and no progress line.
 */
export interface ChromeReport {
  /** Shown in the bar instead of the made thing's title. */
  title?: string;
  /** How far through the person is, 0 to 1: the thin line along the bottom. */
  progress?: number;
  /** Where the parts of the thing begin, each 0 to 1: small breaks in the line. */
  marks?: number[];
  /**
   * The line in equal pieces, one per step (a card, a question), each in its
   * state: "good" green, "warn" amber, "done" passed, "now" the one in view,
   * "todo" not reached. Drawn instead of `progress` when given.
   */
  segments?: Segment[];
  /** Makes the line a control that moves to a point, 0 to 1 (a video's or audio's time). */
  onSeek?: (fraction: number) => void;
  /** What the done tick does instead of ticking the plan item with no result (a quiz sends its grade with it). */
  onDone?: () => void;
  /**
   * A step forward inside the thing before the chrome goes on to the next
   * thing, on scroll, swipe or the down arrow: true when the player took it.
   */
  onNext?: () => boolean;
  /** The same backwards. */
  onPrev?: () => boolean;
  /**
   * Drawn right up to the top edge, under the floating bar: "dark" for a
   * picture (the bar turns light over a shade), "themed" for a page in the
   * app's colours. Such a player keeps its own words clear of the bar with
   * `var(--chrome-top)` and of the line with `var(--chrome-bottom)`.
   * Absent: the player starts under the bar.
   */
  behind?: "dark" | "themed";
}

/** One piece of a segmented progress line. */
export type Segment = "good" | "warn" | "done" | "now" | "todo";

export type Sink = (report: ChromeReport | undefined) => void;
export const ChromeSink = createContext<Sink | undefined>(undefined);
/** Where a player's own tools go in the bar (`ChromeTools`), and whether its slot is the one in view. */
export const ChromeToolsTarget = createContext<HTMLElement | null>(null);
export const ChromeSlotActive = createContext(true);

/**
 * Tells the chrome around this player what it shows (see `ChromeReport`).
 * Call it on every render with the current values. It says whether a chrome
 * hears it: outside one it does nothing, and a player drawn anywhere else
 * (a feed of its own) may draw its own line instead.
 */
export function useChrome(report: ChromeReport): boolean {
  const sink = useContext(ChromeSink);
  const latest = useRef(report);
  useLayoutEffect(() => {
    latest.current = report;
  });
  const { title, behind } = report;
  // Finer than a pixel of the line is not worth a redraw.
  const progress = report.progress === undefined ? undefined : Math.round(Math.min(1, Math.max(0, report.progress)) * 1000) / 1000;
  const marksKey = report.marks?.map((m) => Math.round(m * 1000) / 1000).join(",") ?? "";
  const segmentsKey = report.segments?.join(",") ?? "";
  const seek = !!report.onSeek;
  const done = !!report.onDone;
  const next = !!report.onNext;
  const prev = !!report.onPrev;
  useEffect(() => {
    sink?.({
      ...(title !== undefined ? { title } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(marksKey ? { marks: marksKey.split(",").map(Number) } : {}),
      ...(segmentsKey ? { segments: segmentsKey.split(",") as Segment[] } : {}),
      ...(behind ? { behind } : {}),
      ...(seek ? { onSeek: (f: number) => latest.current.onSeek?.(f) } : {}),
      ...(done ? { onDone: () => latest.current.onDone?.() } : {}),
      ...(next ? { onNext: () => latest.current.onNext?.() ?? false } : {}),
      ...(prev ? { onPrev: () => latest.current.onPrev?.() ?? false } : {}),
    });
  }, [sink, title, progress, marksKey, segmentsKey, behind, seek, done, next, prev]);
  useEffect(() => (sink ? () => sink(undefined) : undefined), [sink]);
  return sink !== undefined;
}

/** How far a wheel must turn, or a finger travel up or down, before it counts as a step. */
const WHEEL_STEP = 60;
const SWIPE_STEP = 60;
/** After a step, the rest of the same spin or glide is let go (a trackpad keeps sending for a while). */
const SETTLE_MS = 700;

/**
 * Scroll, swipe and the up and down arrows as steps to the thing after or
 * before, once whatever can still scroll that way inside the player has
 * scrolled. The keys are heard first (capture) and, when they step, go no
 * further, so a player's own up and down never move a second time. Keys
 * typed into a field or the thread are left alone.
 */
export function useStepGestures(root: RefObject<HTMLElement | null>, next: (() => void) | undefined, prev: (() => void) | undefined) {
  const steps = useRef({ next, prev });
  useLayoutEffect(() => {
    steps.current = { next, prev };
  });
  const on = !!next || !!prev;
  useEffect(() => {
    const box = root.current;
    if (!box || !on) return;
    let lockedUntil = 0;
    let swept = 0;
    let sweptAt = 0;
    const step = (down: boolean) => {
      const go = down ? steps.current.next : steps.current.prev;
      if (!go) return false;
      go();
      return true;
    };
    function onWheel(e: WheelEvent) {
      if (e.defaultPrevented || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const down = e.deltaY > 0;
      if (scrollsFurther(e.target, box!, down)) return;
      const now = Date.now();
      if (now < lockedUntil) {
        lockedUntil = now + 250;
        return;
      }
      if (now - sweptAt > 300) swept = 0;
      sweptAt = now;
      swept += e.deltaMode === 0 ? e.deltaY : e.deltaY * 40;
      if (Math.abs(swept) < WHEEL_STEP) return;
      swept = 0;
      lockedUntil = now + SETTLE_MS;
      step(down);
    }
    let touch: { x: number; y: number; target: EventTarget | null } | undefined;
    function onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      touch = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, target: e.target } : undefined;
    }
    function onTouchEnd(e: TouchEvent) {
      const from = touch;
      const t = e.changedTouches[0];
      touch = undefined;
      if (!from || !t) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (Math.abs(dy) < SWIPE_STEP || Math.abs(dy) < Math.abs(dx) * 1.5) return;
      // A finger moving up shows what is below: the next thing.
      const down = dy < 0;
      if (scrollsFurther(from.target, box!, down)) return;
      step(down);
    }
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], .thread")) return;
      if (!step(e.key === "ArrowDown")) return;
      // The chrome owns up and down: a player listening for them too never moves a second time.
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    box.addEventListener("wheel", onWheel, { passive: true });
    box.addEventListener("touchstart", onTouchStart, { passive: true });
    box.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("keydown", onKey, true);
    return () => {
      box.removeEventListener("wheel", onWheel);
      box.removeEventListener("touchstart", onTouchStart);
      box.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [root, on]);
}

/** Whether something between `target` and `root` can still scroll that way, so the scroll is its own and not a step. */
function scrollsFurther(target: EventTarget | null, root: HTMLElement, down: boolean): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== root.parentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const style = getComputedStyle(el).overflowY;
    if (style !== "auto" && style !== "scroll") continue;
    if (down ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 2) return true;
  }
  return false;
}
