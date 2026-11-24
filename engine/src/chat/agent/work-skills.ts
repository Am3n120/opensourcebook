/**
 * The skills the person's agent reads while it makes an item (DECISIONS
 * #64; docs/STRUCTURE.md, "Skill"): folders under the repo's top-level
 * `skills/`, each a SKILL.md (a name and a line on when it helps, then the
 * knowledge) with references beside it. They are knowledge, never rules:
 * the agent reads what serves the item through `read_skill`.
 *
 * The engine runs where it cannot list a folder, so the files are bundled
 * as text (wrangler's Text rule for `.md`; the same in the tests). This is
 * the one list of them: a new file of a skill is one line here.
 */
import guide from "../../../../skills/guide/SKILL.md";
import listening from "../../../../skills/listening/SKILL.md";
import notebook from "../../../../skills/notebook/SKILL.md";
import notebookFlashcards from "../../../../skills/notebook/references/flashcards.md";
import notebookQuizzes from "../../../../skills/notebook/references/quizzes.md";
import notebookSources from "../../../../skills/notebook/references/sources.md";
import planner from "../../../../skills/planner/SKILL.md";
import plannerBriefs from "../../../../skills/planner/references/briefs.md";
import plannerSizing from "../../../../skills/planner/references/sizing.md";
import { PACK_FILES } from "./pack-files";

/** Every file of every skill, by its path inside `skills/`. */
const FILES: Record<string, string> = {
  "guide/SKILL.md": guide,
  "listening/SKILL.md": listening,
  "notebook/SKILL.md": notebook,
  "notebook/references/flashcards.md": notebookFlashcards,
  "notebook/references/quizzes.md": notebookQuizzes,
  "notebook/references/sources.md": notebookSources,
  "planner/SKILL.md": planner,
  "planner/references/briefs.md": plannerBriefs,
  "planner/references/sizing.md": plannerSizing,
};

export interface SkillAbout {
  name: string;
  /** When it helps, in a line: what the agent sees before it opens the skill. */
  description: string;
}

/** A SKILL.md's front matter: its name and description. */
export function frontMatter(text: string): SkillAbout | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)?.[1];
  if (!block) return undefined;
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  return name && description ? { name, description } : undefined;
}

export function skills(): SkillAbout[] {
  return Object.entries(FILES)
    .filter(([path]) => /^[^/]+\/SKILL\.md$/.test(path))
    .map(([, text]) => frontMatter(text))
    .filter((skill): skill is SkillAbout => skill !== undefined);
}

/** The skills, a line each. */
export function skillIndex(): string {
  return skills()
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
}

export function skillFiles(): string[] {
  return Object.keys(FILES);
}

/**
 * A skill's file by its path inside `skills/` ("notebook/references/flashcards.md"),
 * by its path inside the skill ("references/flashcards.md"), or a skill by name
 * ("notebook"). Undefined when there is none.
 */
export function readSkillFile(path: string, packs: readonly string[] = []): string | undefined {
  const files = { ...packFiles(packs), ...FILES };
  const wanted = path.trim().replace(/^\.?\/+/, "").replace(/^(skills|packs)\//, "");
  if (files[wanted]) return files[wanted];
  if (files[`${wanted}/SKILL.md`]) return files[`${wanted}/SKILL.md`];
  const inside = Object.keys(files).filter((file) => file.endsWith(`/${wanted}`));
  return inside.length === 1 ? files[inside[0]!] : undefined;
}

/**
 * Packs (docs/STRUCTURE.md, "Pack"): a folder in `packs/` for one kind of
 * work, whose skill the agent may read while the pack is on for the item's
 * project (`project.settings.packs`). Only the packs named are offered; a
 * name with no pack is passed over.
 */
function packFiles(packs: readonly string[]): Record<string, string> {
  const on = new Set(packs);
  return Object.fromEntries(Object.entries(PACK_FILES).filter(([path]) => on.has(path.split("/")[0]!)));
}

/** The packs on for a project that exist, each with its skill's line. */
export function packsOn(packs: readonly string[]): SkillAbout[] {
  return Object.entries(packFiles(packs))
    .filter(([path]) => /^[^/]+\/SKILL\.md$/.test(path))
    .map(([, text]) => frontMatter(text))
    .filter((skill): skill is SkillAbout => skill !== undefined);
}

/** The packs on for a project as skills to send elsewhere (the scenes service's video agent): each pack's folder name and its files by path inside it. */
export function packSkills(packs: readonly string[]): Array<{ name: string; files: Record<string, string> }> {
  const byPack = new Map<string, Record<string, string>>();
  for (const [path, text] of Object.entries(packFiles(packs))) {
    const [name, ...rest] = path.split("/");
    byPack.set(name!, { ...(byPack.get(name!) ?? {}), [rest.join("/")]: text });
  }
  return [...byPack].filter(([, files]) => files["SKILL.md"] !== undefined).map(([name, files]) => ({ name, files }));
}

/** A line for the item's instructions when its project has packs on, else undefined. */
export function packsNote(packs: readonly string[]): string | undefined {
  const on = packsOn(packs);
  if (on.length === 0) return undefined;
  return `This project has packs on: knowledge for the kind of work the person is doing, which read_skill reads like Open Sourcebook's other skills (by the pack's name):\n${on.map((pack) => `- ${pack.name}: ${pack.description}`).join("\n")}`;
}
