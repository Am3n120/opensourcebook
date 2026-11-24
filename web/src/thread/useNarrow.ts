import { useEffect, useState } from "react";

/** The width under which the project shows one panel at a time (project.css), where a thread is a sheet. */
const NARROW = "(max-width: 960px)";

/** Whether the window is narrow: a thread opens as a sheet over the thing's lower part, not beside it. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW);
    const change = () => setNarrow(query.matches);
    query.addEventListener?.("change", change);
    return () => query.removeEventListener?.("change", change);
  }, []);
  return narrow;
}
