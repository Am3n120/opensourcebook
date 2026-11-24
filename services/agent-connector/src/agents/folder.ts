/** What a files-only folder holds that an agent's own path rules can't see past: links that lead out of it. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { within } from "../box.ts";

/** The links in `dir` (at any depth, at most `max` entries looked at) whose real path is outside it, or can't be found. */
export function linksOut(dir: string, max = 20_000): string[] {
  const root = realpathSync(dir);
  const found: string[] = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < max) {
    const here = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(here);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++seen > max) break;
      const path = join(here, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        let target: string | undefined;
        try {
          target = realpathSync(path);
        } catch {
          target = undefined;
        }
        if (!target || !within(target, root)) found.push(path);
      } else if (stat.isDirectory()) queue.push(path);
    }
  }
  return found;
}
