import type { ChatCommand, FormatDescriptor } from "../../api/types";
import { findFormat } from "../../design/formatLook";

/** How long ago, in a few plain words: "now", "5 min ago", "3 hours ago", "yesterday", "2 days ago". */
export function ago(at: string, now: number): string {
  const ms = now - Date.parse(at);
  if (!Number.isFinite(ms) || ms < 60_000) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The line under the box: the first two shapes the engine lists and a plan, in plain words. */
export function helpLine(commands: readonly ChatCommand[], formats: readonly FormatDescriptor[]): string {
  const shapes = commands
    .filter((c) => c.group === "make" && c.format)
    .slice(0, 2)
    .map((c) => {
      const f = findFormat(formats, c.format!);
      const word = f?.singular ?? f?.label ?? c.title;
      return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
    });
  const plan = commands.some((c) => c.group === "plan");
  const asked = [...shapes, ...(plan ? ["a plan"] : [])];
  if (asked.length === 0) return "Ask about your sources here; every answer shows the spot it came from.";
  const list = asked.length === 1 ? asked[0] : `${asked.slice(0, -1).join(", ")} or ${asked.at(-1)}`;
  return `Ask for ${list} here and its make sheet opens on the right, filled in.`;
}
