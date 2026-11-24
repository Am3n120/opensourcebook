import { readFileSync } from "node:fs";
import { carryOldStorage } from "./oldStorage";

afterEach(() => window.localStorage.clear());

test("every key kept under the old name is copied to the new name, and the old one stays", () => {
  window.localStorage.setItem("re.theme", "dark");
  window.localStorage.setItem("re.audio.speed", "1.5");
  window.localStorage.setItem("re.thread.d1-i", "open");
  window.localStorage.setItem("re.newChatTicks.p1", '["s1"]');
  expect(carryOldStorage()).toBe(4);
  expect(window.localStorage.getItem("opensourcebook.theme")).toBe("dark");
  expect(window.localStorage.getItem("opensourcebook.audio.speed")).toBe("1.5");
  expect(window.localStorage.getItem("opensourcebook.thread.d1-i")).toBe("open");
  expect(window.localStorage.getItem("opensourcebook.newChatTicks.p1")).toBe('["s1"]');
  expect(window.localStorage.getItem("re.theme")).toBe("dark");
});

test("a choice already kept under the new name wins", () => {
  window.localStorage.setItem("re.theme", "dark");
  window.localStorage.setItem("opensourcebook.theme", "light");
  expect(carryOldStorage()).toBe(0);
  expect(window.localStorage.getItem("opensourcebook.theme")).toBe("light");
});

test("it happens once: a choice taken back later (the theme set to System) is not filled in again from the old name", () => {
  window.localStorage.setItem("re.theme", "dark");
  expect(carryOldStorage()).toBe(1);
  window.localStorage.removeItem("opensourcebook.theme");
  expect(carryOldStorage()).toBe(0);
  expect(window.localStorage.getItem("opensourcebook.theme")).toBeNull();
});

test("another site's or another app's keys are left alone", () => {
  window.localStorage.setItem("reader.size", "12");
  window.localStorage.setItem("re", "x");
  expect(carryOldStorage()).toBe(0);
  expect(window.localStorage.getItem("opensourcebook.size")).toBeNull();
  expect(window.localStorage.getItem("opensourcebook.")).toBeNull();
});

test("storage that throws does not stop the app", () => {
  const broken = { get length(): number { throw new Error("blocked"); } } as unknown as Storage;
  expect(carryOldStorage(broken)).toBe(0);
});

test("the page reads the theme under the new name first and the old name second, before the app runs", () => {
  const page = readFileSync("index.html", "utf8");
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1]!;
  const themeFor = (kept: Record<string, string>) => {
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia;
    window.localStorage.clear();
    for (const [key, value] of Object.entries(kept)) window.localStorage.setItem(key, value);
    new Function(script)();
    return document.documentElement.getAttribute("data-theme");
  };
  expect(themeFor({ "re.theme": "dark" })).toBe("dark");
  expect(themeFor({ "opensourcebook.theme": "dark" })).toBe("dark");
  expect(themeFor({ "opensourcebook.theme": "light", "re.theme": "dark" })).toBe("light");
  expect(themeFor({ "re.theme": "dark", "opensourcebook.carried": "1" })).toBe("light");
  expect(themeFor({})).toBe("light");
});
