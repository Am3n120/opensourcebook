/**
 * What the chat knows about Open Sourcebook (engine/docs/api.md, "What the chat knows
 * about Open Sourcebook"). The one place: a short description of the product, kept here,
 * plus what the registries hold right now (every declared format and
 * whether it can be made, and the registered skills). The router, the talk
 * skill and the planner read it from here; no prompt names a format or a
 * skill.
 */
import type { FormatRegistry, FormatView } from "../studio/registry";

/** Open Sourcebook in a few sentences. It names no format: formats come from the registry. */
export const ABOUT_OPENSOURCEBOOK = `Open Sourcebook turns a person's own sources into things to watch, read and answer. A person adds their sources (files, links, pasted notes) to a project, and Open Sourcebook makes things out of them that are better than the source: clearer than the lecture, better than the paper, and as thorough, as short or as fun as the person wants. People use it to learn a subject from scratch, keep up with a course, revise, explore something out of curiosity, keep a reference, or simply enjoy their own material.
In a project's chat Open Sourcebook answers questions about the sources, citing the exact spot each claim came from. One thing asked for on its own is made at once. A path through the material is a plan: an ordered set of items, each made in one of Open Sourcebook's formats, with stages, items side by side and branches that run only when an earlier result calls for them. The plan is priced before anything is made, the person can change it by hand or by asking, and nothing is made until they press Start. They then go through the items at their own pace on the phone or the web.
What Open Sourcebook says and makes comes only from the person's sources, each claim cited. The chat itself does not browse the web. Open Sourcebook does go to the web for what a link source points at, and the agent making a video may search the web and open pages for pictures and to see what things look like, never for what the video says. Open Sourcebook has no server of its own: the sources stay on the person's computer, apart from what the person's own agent sends its provider as it works.`;

/** Something the chat can do besides answering from the sources, as the skill registry describes it. */
export interface KnownSkill {
  id: string;
  command?: string;
  about: string;
}

/** The formats as the registry declares them now, ready ones first. */
export function formatsNow(registry: FormatRegistry): FormatView[] {
  return [...registry.views()].sort((a, b) => Number(b.ready) - Number(a.ready));
}

/** What a format is and whether it can be made now, in one line. */
export function formatLine(format: FormatView): string {
  const state = format.ready
    ? "Open Sourcebook can make it now"
    : format.problem
      ? `Open Sourcebook can't make it on this computer now, so it is never in a plan: ${format.problem} Say that to the person when they ask for one`
      : "Open Sourcebook can't make it yet, so it is never in a plan";
  return `- ${format.id} ("${format.label}"): ${format.about ?? "no description"} (${state})`;
}

/** Open Sourcebook, its formats and its skills, for a prompt. */
export function describeOpenSourcebook(registry: FormatRegistry, skills: readonly KnownSkill[]): string {
  const formats = formatsNow(registry).map(formatLine);
  const lines = [
    `About Open Sourcebook:\n${ABOUT_OPENSOURCEBOOK}`,
    `Formats Open Sourcebook has (from its registry, now):\n${formats.join("\n")}`,
  ];
  if (skills.length > 0) {
    lines.push(`What the chat can do besides answering from the sources:\n${skills.map((skill) => `- ${skill.id}${skill.command ? ` (/${skill.command})` : ""}: ${skill.about}`).join("\n")}`);
  }
  return lines.join("\n\n");
}
