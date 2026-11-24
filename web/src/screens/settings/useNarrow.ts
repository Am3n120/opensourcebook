import { useEffect, useState } from "react";

/** Under this width Settings is a list of its sections, each opening on its own page (settings.css holds the same width). */
const QUERY = "(max-width: 640px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(QUERY);
    const change = () => setNarrow(query.matches);
    change();
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return narrow;
}
