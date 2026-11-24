import { useEffect, useState } from "react";

const QUERY = "(max-width: 640px)";

/** Whether the screen is a phone's width, where the adder drops its drop line and shortens its words. */
export function useNarrow(): boolean {
  const query = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : undefined);
  const [narrow, setNarrow] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const m = query();
    if (!m) return;
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}
