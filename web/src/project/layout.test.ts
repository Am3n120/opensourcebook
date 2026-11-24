/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Tests run from web/. jsdom draws no CSS, so the layout rules are read as written.
const css = readFileSync(resolve("src/project/project.css"), "utf8");
const rule = (selector: string) => new RegExp(`${selector.replace(/[.:()]/g, "\\$&")} \\{[^}]*grid-template-columns: ([^;]+);`).exec(css)?.[1];

test("a view open in the right column makes it wider than Make and Made here, and the chat gives up the room", () => {
  expect(rule(".app3")).toMatch(/ 372px$/);
  expect(rule(".app3.rv-open:not(.playing)")).toMatch(/ 412px$/);
  expect(rule(".app3.reading.rv-open:not(.playing)")).toMatch(/ 412px$/);
  // The chat's column is the one that flexes.
  expect(rule(".app3.rv-open:not(.playing)")).toContain("minmax(0, 1fr)");
});

test("on a phone a thing playing fills the whole screen, over the project's bar and tabs", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 960px)"));
  expect(narrow).toMatch(/\.app3\.playing\.tab-made > \.immerse \{[^}]*position: fixed; inset: 0;/);
});
