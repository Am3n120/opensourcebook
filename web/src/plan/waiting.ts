import type { ItemJob } from "../api/types";

/**
 * What a waiting item says under its step, from the engine's words
 * (engine/src/jobs/failure-words.ts), with a reset time the agent gave shown
 * in this device's own clock. Undefined when the item is not waiting.
 */
export function waitingLine(job: ItemJob | undefined, now: Date = new Date()): string | undefined {
  const waiting = job?.waiting;
  if (!waiting) return undefined;
  // The agent's own words win; a time it gave, and only then, is read out in the person's clock.
  if (waiting.resets || !waiting.resetsAt) return waiting.words;
  const at = new Date(waiting.resetsAt);
  if (Number.isNaN(at.getTime())) return waiting.words;
  const sameDay = at.toDateString() === now.toDateString();
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const when = sameDay ? time : `${at.toLocaleDateString([], { weekday: "long" })} ${time}`;
  return `${waiting.words} It resets at ${when}.`;
}
