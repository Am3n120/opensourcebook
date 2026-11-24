/** Words and links for the Activity page (Activity.tsx): times, token counts and where a row opens. */
import type { ActivityOpen } from "../api/types";

/** How often the page reads again by itself while something is being made. */
export const ACTIVITY_REFRESH_MS = 4000;

/** Where a row opens: the thing made, else the plan or the chat in its project. */
export function linkOf(open: ActivityOpen | undefined): string | undefined {
  if (!open) return undefined;
  if (open.outputId) return `/outputs/${encodeURIComponent(open.outputId)}`;
  const project = `/projects/${encodeURIComponent(open.projectId)}`;
  if (open.planId) return `${project}?plan=${encodeURIComponent(open.planId)}`;
  if (open.chatId) return `${project}?chat=${encodeURIComponent(open.chatId)}`;
  return project;
}

/** "8 s", "4 min", "1 h 5 min". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "950", "12k", "1.2M". */
export function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${count < 10_000 ? (count / 1000).toFixed(1).replace(/\.0$/, "") : Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
