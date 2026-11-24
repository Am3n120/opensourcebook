/**
 * Every pack's skill files as text, by their path inside the repo's
 * top-level `packs/` (docs/STRUCTURE.md, "Pack"). The engine runs as a Worker
 * and cannot list a folder, so the files are bundled like the skills in
 * work-skills.ts; everything else reads the folder itself (`opensourcebook pack list`).
 * This list is kept equal to the folder: `cli/test/packs.test.ts` fails when
 * a pack's file is missing here, so a new file of a pack is one line here.
 */
import study from "../../../../packs/study/SKILL.md";

export const PACK_FILES: Record<string, string> = {
  "study/SKILL.md": study,
};
