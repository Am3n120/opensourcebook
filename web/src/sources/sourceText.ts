import type { ExtractionStatus, Source } from "../api/types";
import type { Tone } from "../screens/planStatus";

export function extractionText(status: ExtractionStatus | undefined): { text: string; tone: Tone } {
  switch (status) {
    case "ready":
      return { text: "Ready", tone: "done" };
    case "pending":
      return { text: "Waiting", tone: "idle" };
    case "extracting":
      return { text: "Reading", tone: "run" };
    case "failed":
      return { text: "Could not read", tone: "fail" };
    default:
      return { text: "Unknown", tone: "idle" };
  }
}

/**
 * A quiet mark for a source that was read only in part, or of which only a
 * title and description could be read; undefined when it was read whole (or
 * not yet). Its plain `limitations` say the rest.
 */
export function readMark(source: Pick<Source, "status" | "accessLevel">): string | undefined {
  if (source.status !== "ready") return undefined;
  if (source.accessLevel === "partial") return "Partly read";
  if (source.accessLevel === "metadata") return "Title only";
  return undefined;
}
