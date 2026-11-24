import { useContext, type CSSProperties } from "react";
import type { FormatDescriptor } from "../api/types";
import { Ctx } from "../app/context";
import { findFormat, lookFor } from "../design/formatLook";

/** The formats the engine declares, or none outside an app (a player drawn on its own). */
function useFormatList(): readonly FormatDescriptor[] {
  return useContext(Ctx)?.formats ?? [];
}

/**
 * The tint a player's screen takes: its format's own colour slot from the
 * registry, washed from the top into the page. Nothing here names a format.
 */
export function useStageTint(type: string): CSSProperties {
  const slot = lookFor(useFormatList(), type).colorSlot;
  return { ["--stage-tint" as string]: `var(--fmt-${slot}-bg)`, ["--stage-ink" as string]: `var(--fmt-${slot}-fg)` };
}

/**
 * What a kind of card or question is called, in the format's own words: the
 * label of that kind among the format's "kinds" setting. Undefined when the
 * format does not name it, so nothing is shown.
 */
export function kindLabel(formats: readonly FormatDescriptor[], type: string, kind: string): string | undefined {
  const field = findFormat(formats, type)?.settings.find((s) => s.key === "kinds");
  if (!field || (field.kind !== "choice" && field.kind !== "choices")) return undefined;
  return field.options.find((o) => o.value === kind)?.label;
}

export function useKindLabel(type: string, kind: string | undefined): string | undefined {
  const formats = useFormatList();
  return kind ? kindLabel(formats, type, kind) : undefined;
}
