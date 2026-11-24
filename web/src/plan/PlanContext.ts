import { createContext, useContext } from "react";
import type { FormatDescriptor, PlanView, Source } from "../api/types";

export interface PlanCtx {
  view: PlanView;
  formats: FormatDescriptor[];
  /** Sources of the plan's project, for item sources. */
  sources: Source[];
  /** The sources ticked in the chat the card is in: what a new item reads at first. */
  ticked?: string[];
  editable: boolean;
  /** Runs an edit that answers with the plan view; shows its error if it fails. */
  edit: (run: () => Promise<PlanView>) => Promise<boolean>;
  /** Runs anything else, then reloads the plan. */
  act: (run: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  /** The last edit's error, shown in the card. */
  error?: unknown;
}

export const PlanContext = createContext<PlanCtx | null>(null);

export function usePlan(): PlanCtx {
  const v = useContext(PlanContext);
  if (!v) throw new Error("usePlan outside PlanContext");
  return v;
}
