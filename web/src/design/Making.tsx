import type { ReactNode } from "react";
import { OutlineButton } from "./Buttons";

/** Where a thing being made stands. The same five everywhere: Home card, Made here, a plan, the phone. */
export type MakingState = "waiting" | "making" | "stopped" | "failed" | "done";

export interface MakingProps {
  state: MakingState;
  /** The status words, written by the caller: "Making video · 4 min", "Waiting · about 2 min", "Couldn't be made: …". */
  text: string;
  /** The thing's name, as a bold first line. Left out on the Home card's tag. */
  title?: string;
  /** What sits at the left, such as the shape's tile. */
  lead?: ReactNode;
  /** How far along, 0 to 1. Left out while making, the line moves without a number. */
  progress?: number;
  /** What the line says to a screen reader, such as "3 of 7 scenes". */
  progressLabel?: string;
  /** Stops it; shown only while waiting or making. */
  onStop?: () => void;
  stopLabel?: string;
  /** One way on once it has stopped, failed or is done, such as Try again, Go on or Play. */
  action?: ReactNode;
  /** Shown last on a row in every state, such as the row's ⋯ menu. */
  menu?: ReactNode;
  /** `row`: a bordered row (Made here, a plan). `tag`: one line on a picture (the Home card). */
  look?: "row" | "tag";
}

const LIVE: ReadonlySet<MakingState> = new Set(["waiting", "making"]);

/** The one progress look: an amber dot, the status words, a thin line, and one Stop. */
export function Making({ state, text, title, lead, progress, progressLabel, onStop, stopLabel = "Stop", action, menu, look = "row" }: MakingProps) {
  const live = LIVE.has(state);
  const stop = live && onStop && (
    <OutlineButton icon="stop" onClick={onStop}>
      {stopLabel}
    </OutlineButton>
  );
  // The state's own word leads in its colour; the rest of the status stays muted. A failure reads as one red sentence.
  const cut = state === "failed" ? -1 : text.search(/[\s·]/);
  const words = (
    <span className={`making-st ${state}`}>
      {(state !== "failed" || look === "tag") && <span className="dot" aria-hidden="true" />}
      {cut > 0 ? (
        <>
          <b className="w">{text.slice(0, cut)}</b>
          {text.slice(cut)}
        </>
      ) : (
        text
      )}
    </span>
  );
  if (look === "tag") {
    return (
      <div className={`making tag ${state}`} role="status">
        {words}
        {stop}
      </div>
    );
  }
  const known = progress !== undefined;
  const pct = known ? Math.round(Math.max(0, Math.min(1, progress)) * 100) : undefined;
  return (
    <div className={`making row ${state}`} role="status">
      <div className="making-top">
        {lead}
        <div className="making-tx">
          {title && <b>{title}</b>}
          {words}
        </div>
        {stop}
        {!live && action}
        {menu}
      </div>
      {state === "making" && (
        <div
          className={`making-line${known ? "" : " unknown"}`}
          role="progressbar"
          aria-label={progressLabel ?? text}
          aria-valuemin={known ? 0 : undefined}
          aria-valuemax={known ? 100 : undefined}
          aria-valuenow={pct}
        >
          <i style={known ? { width: `${pct}%` } : undefined} />
        </div>
      )}
    </div>
  );
}
