/* eslint-disable react-refresh/only-export-components -- the slot's type, hook and registry belong with its provider. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PlanView } from "../api/types";

/**
 * What the right column of a project shows in place of Make and Made here:
 * the make sheet for one shape (already filled in, when something asked for
 * it), a plan, a new plan, or anything else a part of the app hands it.
 */
export type RightView =
  | { kind: "make"; shape: string; prefill?: Record<string, unknown> }
  | { kind: "plan"; planId: string }
  | { kind: "planNew" }
  | { kind: "custom"; node: React.ReactNode };

/** What a view drawn in the right column can reach of the project it is in. */
export interface RightPanelContext {
  projectId: string;
  /** The ticked sources: what anything made here is made from. */
  sources: string[];
  /** Goes back to Make and Made here. */
  close: () => void;
  /** Takes a plan view an action in the panel answered with (made, started, stopped). */
  onPlanChange: (view: PlanView) => void;
  /** Plays a made thing in the right column. */
  onPlay: (outputId: string) => void;
  /** Sends words to the project's chat as if typed there ("/plan …"). */
  ask?: (text: string) => void;
}

export type RightViewRenderer<K extends RightView["kind"] = RightView["kind"]> = (view: Extract<RightView, { kind: K }>, ctx: RightPanelContext) => ReactNode;

const renderers = new Map<string, RightViewRenderer>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * Plugs a view into the right column: the make sheet, the plan panel and the
 * pickers each register here from their own file, and the project draws them
 * without naming them. Returns a function that takes the registration back.
 */
export function registerRightView<K extends RightView["kind"]>(kind: K, render: RightViewRenderer<K>): () => void {
  const stored = render as unknown as RightViewRenderer;
  renderers.set(kind, stored);
  version++;
  listeners.forEach((l) => l());
  return () => {
    if (renderers.get(kind) !== stored) return;
    renderers.delete(kind);
    version++;
    listeners.forEach((l) => l());
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The renderer registered for a kind, read again whenever one is registered or taken back. */
export function useRightViewRenderer(kind: RightView["kind"] | undefined): RightViewRenderer | undefined {
  useSyncExternalStore(subscribe, () => version);
  return kind ? renderers.get(kind) : undefined;
}

interface RightPanelValue {
  view: RightView | null;
  open(view: RightView): void;
  /**
   * Opens a view only while the column is free for it: nothing is open there,
   * or only a plan, and no player is held in it. Something the person did not
   * ask for (a plan a reply just wrote) comes in this way, so it never closes
   * a player or a make sheet.
   */
  offer(view: RightView): void;
  /** Says a player is open in the column (or no longer), so an offered view waits. */
  hold(playing: boolean): void;
  close(): void;
}

const Ctx = createContext<RightPanelValue | null>(null);

/** Holds what the right column shows; the project screen provides it. */
export function RightPanelProvider({ children, initial = null }: { children: ReactNode; initial?: RightView | null }) {
  const [view, setView] = useState<RightView | null>(initial);
  const open = useCallback((next: RightView) => setView(next), []);
  const close = useCallback(() => setView(null), []);
  const held = useRef(false);
  const offer = useCallback((next: RightView) => setView((now) => ((now === null ? !held.current : now.kind === "plan") ? next : now)), []);
  const hold = useCallback((playing: boolean) => void (held.current = playing), []);
  const value = useMemo(() => ({ view, open, offer, hold, close }), [view, open, offer, hold, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** What the right column shows, and how to change it. Outside a project, nothing opens. */
export function useRightPanel(): RightPanelValue {
  return useContext(Ctx) ?? NONE;
}

const NONE: RightPanelValue = { view: null, open: () => undefined, offer: () => undefined, hold: () => undefined, close: () => undefined };
