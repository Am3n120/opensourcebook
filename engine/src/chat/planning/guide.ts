/**
 * The planner's skill (skills/planner), as every planner reads it: the
 * person's agent in the chat (agent/prompt.ts) and Open Sourcebook's own model
 * (prompts.ts). Its SKILL.md is given whole on every turn, since a small
 * model may not open a file by itself; its references are there to read
 * with `read_skill`. What the skill says is judgement written by hand; what
 * is registered (shapes, settings, makers, styles, what is ready now) is
 * generated from the registries at the moment of the turn (`catalog`).
 */
import { packsOn, readSkillFile, skillFiles } from "../agent/work-skills";

export const PLANNER_SKILL = "planner";

/** The planner's SKILL.md without its front matter. */
export function plannerGuide(): string {
  const text = readSkillFile(`${PLANNER_SKILL}/SKILL.md`) ?? "";
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

/** The files of the planner's skill besides SKILL.md, for the turn to name. */
export function plannerReferences(): string[] {
  return skillFiles()
    .filter((path) => path.startsWith(`${PLANNER_SKILL}/`) && !path.endsWith("/SKILL.md"))
    .map((path) => path.slice(PLANNER_SKILL.length + 1));
}

/** The packs a project has on, by name, from its settings (`settings.packs`). */
export function projectPacks(settings: Readonly<Record<string, unknown>> | undefined): string[] {
  const on = settings?.packs;
  return Array.isArray(on) ? on.filter((name): name is string => typeof name === "string") : [];
}

/**
 * The skills of the packs on for the project, given to the planner the way
 * its own guide is: whole, front matter left out, each under its name. A
 * pack is knowledge about one kind of work (docs/STRUCTURE.md, "Pack").
 * Empty when none is on.
 */
export function packGuides(packs: readonly string[]): string {
  return packsOn(packs)
    .map((pack) => {
      const text = (readSkillFile(`${pack.name}/SKILL.md`, packs) ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
      return `The "${pack.name}" pack is on for this project (${pack.description}):\n\n${text}`;
    })
    .join("\n\n");
}
