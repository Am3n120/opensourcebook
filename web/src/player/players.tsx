import type { ReactNode } from "react";
import type { Condition, Json, Output } from "../api/types";
import type { OpenCite } from "./CiteMarks";

export interface SourceRef {
  id: string;
  name: string;
}

/** The thing before or after this one in plan order. */
export interface Neighbour {
  outputId: string;
  title: string;
}

/** Why there is no made thing on one side although the plan has more there: one is being made, or the rest are not made yet. */
export type Waiting = "making" | "unmade";

/**
 * What every player is given. Besides these, a player may tell the chrome
 * around it (chrome.tsx) its title, how far through it is (0 to 1), what the
 * done tick does, and steps of its own before the next thing, with
 * `useChrome`; one that says nothing still wears the whole chrome.
 */
/** An item of the plan made from this thing's result when its condition holds (a quiz's score below a mark). */
export interface Branch {
  title: string;
  /** The plan item's condition as the engine stores it (engine/docs/api.md, plan items: `{ kind: "metric", metric: "score", below: 0.7 }`). */
  condition: Condition;
  /** Already made. */
  made: boolean;
}

export interface PlayerProps {
  output: Output;
  /** Shown where the person reaches the end. */
  finish: ReactNode;
  sources: SourceRef[];
  prev?: Neighbour;
  next?: Neighbour;
  /** Set when there is no `prev`/`next` made yet but the plan has items on that side. */
  prevWaiting?: Waiting;
  nextWaiting?: Waiting;
  /** The only thing in its plan (a thing asked for on its own), or in none: there is no before or after to speak of. */
  alone?: boolean;
  /** Moves to another thing in plan order. */
  go: (outputId: string) => void;
  /** Ticks the plan item done with a result (a quiz's grade); absent outside a plan. */
  record?: (result: Json) => void;
  /** Ticks the plan item done with no result (a video played to its end); absent outside a plan or once done. */
  complete?: () => void;
  /** Whether the plan item is already ticked done. */
  done?: boolean;
  /** What the plan makes from this thing's result, in plan order; absent outside a plan or with none. */
  branches?: Branch[];
  /**
   * False while the player is a neighbour in a feed (drawn, scrolled past,
   * not in view): it takes no keys, so only the one in view answers them.
   */
  active?: boolean;
  /** In a feed: a video starts on its own, muted, when it is in view (browsers allow sound only after a tap). */
  autoplay?: boolean;
  /** Opens a cited spot beside the player (a project does); without it a cite mark links to the source. */
  onOpenCite?: OpenCite;
  /** Where the person stopped last time, in this player's own shape (engine/docs/api.md, "Item"). */
  progress?: Json;
  /** Keeps where the person is now; absent outside a plan. Called when it changes, not on every frame. */
  keep?: (progress: Json) => void;
  /**
   * Where the person is right now, in the same shape `keep` takes, reported
   * as it changes and finer than `keep` (a video's time as it plays), so a
   * thread on the thing is written at the spot they are looking at. A player
   * that does not offer it is placed by what it keeps.
   */
  here?: (at: Json) => void;
  /**
   * A slot any player may offer under what it has just shown or explained
   * (a quiz under an answer's explanation): what is drawn there is about
   * that spot (`at`, in the player's own shape), such as a way to ask about
   * it or disagree. Absent: the player draws nothing there.
   */
  aboutHere?: (at: Json) => ReactNode;
}

/**
 * Kept so players that still draw it compile: the chrome around every player
 * (chrome.tsx) goes to the thing before and after by scroll, swipe and the
 * arrow keys, so a player shows no buttons or labels for it. It draws nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function NeighbourButton(_props: { dir: "up" | "down"; n?: Neighbour; waiting?: Waiting | undefined; alone?: boolean | undefined; go: (id: string) => void }): null {
  return null;
}
