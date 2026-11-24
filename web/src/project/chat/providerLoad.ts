import type { Providers } from "../../api/types";
import type { ProvidersStatus } from "../../app/context";

/** How far loading the providers got: still loading, answered, or failed to load (the shared load's status). */
export type ProviderLoad = ProvidersStatus;

/**
 * What the chat box says about who answers: the picker, a quiet empty chip
 * while loading, Couldn't reach the engine when the load failed, Set up a
 * provider only once the engine has answered that none can answer, the
 * connector out of reach, or nothing.
 */
export function pickerState(providers: Providers | undefined, load: ProviderLoad, anyUsable: boolean): "picker" | "waiting" | "failed" | "setUp" | "unreachable" | "none" {
  if (load === "loading") return "waiting";
  if (load === "failed") return "failed";
  if (!providers?.connector.configured) return "none";
  if (!providers.connector.reachable) return "unreachable";
  return anyUsable ? "picker" : "setUp";
}
