import { act, renderHook } from "@testing-library/react";
import { applyTheme, readTheme, useTheme } from "./theme";

function systemIs(dark: boolean) {
  window.matchMedia = ((query: string) => ({ matches: dark && query.includes("dark"), media: query, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

test("system follows the device", () => {
  systemIs(true);
  applyTheme("system");
  expect(document.documentElement.dataset.theme).toBe("dark");
  systemIs(false);
  applyTheme("system");
  expect(document.documentElement.dataset.theme).toBe("light");
});

test("a choice wins over the device and is remembered; system forgets it", () => {
  systemIs(false);
  const { result } = renderHook(() => useTheme());
  expect(result.current[0]).toBe("system");
  act(() => result.current[1]("dark"));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(readTheme()).toBe("dark");
  act(() => result.current[1]("system"));
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(window.localStorage.getItem("opensourcebook.theme")).toBeNull();
});
