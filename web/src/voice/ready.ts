import type { VoiceServiceView } from "../api/types";

/** Where Settings opens the Voice section on one service. */
export const setUpLink = (id: string) => `/settings?voice=${encodeURIComponent(id)}#voice`;

/** A service can speak now: its key is set, or it needs none and is installed here. */
export function serviceReady(s: VoiceServiceView): boolean {
  if (s.where === "local") return s.installed === true;
  return !s.needsKey || s.keySet === true;
}
