import type { MouseEvent, ReactNode } from "react";
import { Icon } from "./Icon";

export interface PickRowProps {
  /** The provider's mark or a small icon, drawn on a rounded tile. */
  mark?: ReactNode;
  title: string;
  /** The line under the title: "Sonnet · medium effort". */
  sub?: string;
  /** The time at the right: "about 4 min", with its own small line: "from your last 5". */
  time?: string;
  timeSub?: string;
  /** Draws the time quieter, as for "no time yet". */
  timeMuted?: boolean;
  /** Opens the picker for this row. Without it the row is plain words and has no chevron. */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}

/** One row of a "Made by" box: Made by, Reviewed by, Voice. */
export function PickRow({ mark, title, sub, time, timeSub, timeMuted, onClick }: PickRowProps) {
  const body = (
    <>
      {mark !== undefined && (
        <span className="pick-mark" aria-hidden="true">
          {mark}
        </span>
      )}
      <span className="pick-who">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </span>
      {time && (
        <span className={`pick-time${timeMuted ? " muted" : ""}`}>
          <b>{time}</b>
          {timeSub && <span>{timeSub}</span>}
        </span>
      )}
      {onClick && <Icon name="chev-r" className="ico pick-chev" />}
    </>
  );
  return onClick ? (
    <button type="button" className="pick" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="pick">{body}</div>
  );
}
