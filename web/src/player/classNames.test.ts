/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Tests run from web/. Every stylesheet loads into one page, so a class a player styles must not
// also be styled by Home for something else: the later rule wins and breaks one of them.

/** The class each rule starts from (".pstage" in ".pstage .pline"), read from the file as written. */
function rootClasses(file: string): Set<string> {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const names = new Set<string>();
  for (const [, head] of css.matchAll(/([^{}]+)\{/g)) {
    if (head!.trim().startsWith("@")) continue;
    for (const selector of head!.split(",")) {
      const root = /^\.([A-Za-z_][\w-]*)/.exec(selector.trim());
      if (root) names.add(root[1]!);
    }
  }
  return names;
}

test("the players' stylesheets and Home's share no class a rule starts from", () => {
  const home = rootClasses(resolve("src/screens/home.css"));
  const dir = resolve("src/player");
  const shared = readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .flatMap((f) => [...rootClasses(resolve(dir, f))].filter((c) => home.has(c)).map((c) => `${f}: .${c}`));
  expect(home.size).toBeGreaterThan(0);
  expect(shared).toEqual([]);
});
