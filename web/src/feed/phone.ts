/** A phone: a narrow screen worked with a finger. A narrow desktop window with a mouse is not one. */
export const PHONE_QUERY = "(max-width: 700px) and (pointer: coarse)";

export function isPhone(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}
