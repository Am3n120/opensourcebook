/**
 * The styles a video can be drawn in: whatever style files are in styles/, with their own label and description.
 *
 * A style is offered (listed for the person, the planner and the agent to choose from) unless its file says
 * `"offered": false`: a style kept in the repo while it is not yet at the bar of the others. One that is not offered
 * still draws every video that names it, so an older plan keeps working.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { styleNames } from "../engine/render/theme.ts";
import type { StyleFile } from "../schemas/project.ts";

export interface Style {
  id: string;
  label: string;
  description: string;
  offered: boolean;
}

const DIR = join(import.meta.dirname, "../styles");

export function styleFile(id: string): StyleFile & { description?: string; offered?: boolean } {
  return JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8"));
}

/** Reads the folder's style files as styles; a file without a description, or with an offered that is not true or false, is refused. */
export function readStyles(ids: string[], file: (id: string) => StyleFile & { description?: string; offered?: unknown } = styleFile): Style[] {
  return ids.map((id) => {
    const f = file(id);
    if (!f.description) throw new Error(`styles/${id}.json has no description; every style says in plain words what it looks like.`);
    if (f.offered !== undefined && typeof f.offered !== "boolean") throw new Error(`styles/${id}.json: offered must be true or false.`);
    return { id, label: f.label, description: f.description, offered: f.offered !== false };
  });
}

let cached: Style[] | undefined;
/** Every style, offered or not, offered ones first, so a default pick is always an offered one. */
export function allStyles(): Style[] {
  cached ??= (() => {
    const all = readStyles(styleNames());
    return [...all.filter((s) => s.offered), ...all.filter((s) => !s.offered)];
  })();
  return cached;
}

/** The styles to choose from: those offered. */
export const listStyles = (): Style[] => allStyles().filter((s) => s.offered);

export const isStyle = (id: string) => allStyles().some((s) => s.id === id);
