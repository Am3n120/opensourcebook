import { useEffect, useState } from "react";
import type { Step, StepLine } from "../api/types";

/**
 * What the person's agent is doing, quietly: one line that says the step it
 * is on in plain words ("Reading Lecture 7"), and for how long, which opens
 * into the steps so far. Once the turn ends the same place reads "Worked in
 * N steps" and opens to what it did, said in the past and in fewer lines
 * ("Read 9 passages of Lecture 7"), as the engine gives them.
 *
 * The list is only in the page while it is open, so copying the chat never
 * picks up a closed list.
 */
export function AgentSteps({ steps, lines, running, startedAt, onStop }: { steps: Step[]; lines?: StepLine[]; running: boolean; startedAt: string; onStop?: () => void }) {
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  if (!running && steps.length === 0) return null;
  const current = steps.at(-1);
  const seconds = Math.max(0, Math.round(((running ? now : Date.parse(current?.endedAt ?? current?.startedAt ?? startedAt)) - Date.parse(startedAt)) / 1000));
  const shown = !running && lines?.length ? lines : sameInARow(steps);
  const line = running ? `${current?.label ?? "Getting started"}…` : `Worked in ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  return (
    <div className={`steps${running ? " live" : ""}`} data-copy="skip">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="now" role={running ? "status" : undefined} aria-live={running ? "polite" : undefined}>
            {line}
          </span>
          {seconds > 0 && <small className="muted">{duration(seconds)}</small>}
        </summary>
        {open && shown.length > 0 && (
          <ol aria-label="What your agent did">
            {shown.map((entry, i) => (
              <li key={i} className={entry.state}>
                {entry.text}
                {entry.steps > 1 && !lines?.length && <small className="muted"> ×{entry.steps}</small>}
              </li>
            ))}
          </ol>
        )}
      </details>
      {running && onStop && (
        <button className="mini stop" type="button" onClick={onStop}>
          Stop
        </button>
      )}
    </div>
  );
}

/** Steps as lines, those in a row with the same words as one: for a turn still running, or one stored before lines were. */
function sameInARow(steps: Step[]): Array<{ text: string; steps: number; state: string }> {
  const out: Array<{ text: string; steps: number; state: string }> = [];
  for (const step of steps) {
    const last = out.at(-1);
    if (last && last.text === step.label && (last.state === step.state || step.state === "running")) {
      last.steps += 1;
      last.state = step.state;
    } else out.push({ text: step.label, steps: 1, state: step.state });
  }
  return out;
}

function duration(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The time, ticking each second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}
