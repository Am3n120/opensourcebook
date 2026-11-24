import { useCallback, useState } from "react";

/**
 * Light or dark. The person's choice in Settings is kept on this device;
 * "system" (the default) follows the device's own setting and changes with
 * it. The theme is `data-theme` on <html>, which tokens.css reads. The same
 * few lines run in index.html before the app loads, so the page never
 * flashes the other theme.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const KEY = "opensourcebook.theme";

export function readTheme(): ThemeChoice {
  try {
    const saved = window.localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Sets `data-theme` on <html> for a choice. */
export function applyTheme(choice: ThemeChoice = readTheme()): void {
  const dark = choice === "dark" || (choice === "system" && systemDark());
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/** Follows the device while the choice is "system". Answers a function that stops following. */
export function followSystem(): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const changed = () => {
    if (readTheme() === "system") applyTheme("system");
  };
  query.addEventListener?.("change", changed);
  return () => query.removeEventListener?.("change", changed);
}

/** The choice and a way to change it, remembered on this device and applied at once. */
export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const set = useCallback((next: ThemeChoice) => {
    try {
      if (next === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, next);
    } catch {
      // Not kept (private window); it still applies now.
    }
    setChoice(next);
    applyTheme(next);
  }, []);
  return [choice, set];
}
