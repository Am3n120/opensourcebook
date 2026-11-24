/**
 * The skills' pages given whole to the video agent at the start of every turn, in its system prompt, through the one
 * path Open Sourcebook already uses for that (the connector's systemPrompt), so it reaches every agent the same way. Read when an
 * agent chose which pages to open, almost none opened more than the main video page and the scene language, and what
 * viewers marked videos down for was written in the pages left shut. So these come with the instructions, whole,
 * never condensed: what viewers notice, how to explain, how an Open Sourcebook video is made with the tools with the pieces on the
 * shelf, and last, set apart as reference, the scene language for the video's style. The rest of the skills stay files
 * to open (read_skill, or the folder): depicting, the cookbook, media, the worked session, simulation, whiteboard,
 * worked maths. SCENES_AGENT_KNOWLEDGE=index gives the index alone, as before, to compare.
 *
 * What is edited while the pages are put together, and only that: each page's front matter goes, and a part that
 * says again what sits just above or below (what Open Sourcebook needs, a list of the references that follow, the shelf's list
 * inside the scene language) becomes a line saying where it is. The pages' own words are otherwise as in their files.
 */
import type { LibraryEntry } from "../engine/language/library.ts";
import { shelf } from "./shelf.ts";
import { readSkill, type ForVideo } from "./skills.ts";

/** The pages given whole, by their path in the skills folder, in the order they are given. */
export const GIVEN = {
  viewers: ["make-a-video/references/what-viewers-notice.md"],
  explaining: ["teaching/SKILL.md", "teaching/references/attention.md", "teaching/references/craft.md", "teaching/references/demonstrate.md", "teaching/references/art-direction.md"],
  making: ["make-a-video/SKILL.md"],
  reference: ["make-a-video/references/scene-language.md"],
} as const;

export const GIVEN_PAGES: readonly string[] = [...GIVEN.viewers, ...GIVEN.explaining, ...GIVEN.making, ...GIVEN.reference];

/** Whether the pages are given whole (the default), or only the index of skills (SCENES_AGENT_KNOWLEDGE=index). */
export const knowledgeFromEnv = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(index|off|0|false|no)$/i.test(env.SCENES_AGENT_KNOWLEDGE?.trim() ?? "");

/** A piece on the shelf, as the scene language names it: its name, whether it was saved, its settings, its own line. */
export const pieceLine = (p: LibraryEntry) => `\`${p.name}\`${p.origin === "saved" ? " (saved)" : ""} (${Object.keys(p.params).join(", ") || "no settings"}): ${p.doc}`;

/** The pieces on the shelf, a line each, from each piece's own `about`. */
export const shelfList = (pieces: LibraryEntry[] = shelf()) => (pieces.length ? pieces.map((p) => `- ${pieceLine(p)}`).join("\n") : "- none yet");

const frontMatterOff = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, "");

/** A page's `## Heading` section, from its heading to the next of the same level, replaced by `by` (empty drops it). */
export function replaceSection(text: string, heading: string, by: string): string {
  const at = text.indexOf(`\n## ${heading}\n`);
  if (at < 0) throw new Error(`no section "${heading}" to replace`);
  const next = text.indexOf("\n## ", at + 4);
  return text.slice(0, at + 1) + (by ? `${by.trim()}\n` : "") + (next < 0 ? "" : text.slice(next + 1));
}

const page = (path: string, video: ForVideo): string => {
  const [skill, ...rest] = path.split("/");
  const text = readSkill(skill!, rest.join("/"), video);
  if (text === undefined) throw new Error(`the given page ${path} is missing`);
  return frontMatterOff(text).trim();
};

/** One given page, with the line that says which file it is. */
const given = (path: string, text: string) => `<page file="skills/${path}">\n${text.trim()}\n</page>`;

export interface Knowledge {
  /** The video's style when the turn starts: the request's, or the one the agent picked so far, or the first. */
  style: string;
  /** The style is the agent's to pick. */
  open: boolean;
}

/** The pages given whole, put together for the system prompt, in order. */
export function knowledgeText(video: ForVideo, k: Knowledge, pieces: LibraryEntry[] = shelf()): string {
  const list = shelfList(pieces);
  const making = replaceSection(page("make-a-video/SKILL.md", video), "What Open Sourcebook needs from a video", "## What Open Sourcebook needs from a video\n\nAs under What Open Sourcebook needs at the top of these instructions.");
  const teaching = replaceSection(page("teaching/SKILL.md", video), "More in this skill", "");
  // The scene language lists the shelf too: here it is given once, in its own part, and the guide says where.
  const language = page("make-a-video/references/scene-language.md", video);
  const languageGiven = language.includes(`\n${list}\n`) ? language.replace(`\n${list}\n`, "\n(The pieces are listed above, under The pieces on the shelf, with their settings.)\n") : language;
  const parts = [
    "# The pages given whole",
    "",
    "What follows are pages of the skills, whole, as they are in their files: first what viewers noticed in finished videos, then how to explain, then how an Open Sourcebook video is made with the tools and the pieces on the shelf, and last, set apart, the scene language as reference.",
    "",
    "## What viewers notice",
    "",
    ...GIVEN.viewers.map((p) => given(p, page(p, video))),
    "",
    "## How to explain",
    "",
    given("teaching/SKILL.md", teaching),
    ...GIVEN.explaining.slice(1).map((p) => given(p, page(p, video))),
    "",
    "## Making an Open Sourcebook video with the tools",
    "",
    given("make-a-video/SKILL.md", making),
    "",
    "## The pieces on the shelf",
    "",
    "Each is a program you run by name in a scene (`run NAME id key=value w= h=`), shipped with Open Sourcebook or saved on this person's shelf, with its settings and its own line on what it is. This is what is there, so you know it.",
    "",
    list,
    "",
    "## Reference: the scene language",
    "",
    `Everything below is reference, to come back to while writing a scene: the whole guide to the scene language, written for ${k.open ? `the style ${k.style}, the first one, as none is picked yet; once you pick another, read_skill (make-a-video, references/scene-language.md) gives it for yours, though most of it is the same in every style` : `this video's style, ${k.style}`}, and this frame.`,
    "",
    given("make-a-video/references/scene-language.md", languageGiven),
  ];
  return parts.join("\n");
}

/** A size in tokens, as a rule of thumb: four characters a token. */
export const tokens = (text: string) => Math.round(text.length / 4);
