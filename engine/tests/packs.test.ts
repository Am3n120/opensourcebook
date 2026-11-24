import { describe, expect, it } from "vitest";
import { PACK_FILES } from "../src/chat/agent/pack-files";
import { frontMatter, packsNote, packsOn, readSkillFile } from "../src/chat/agent/work-skills";
import { agentPrompt } from "../src/chat/agent/prompt";
import type { AgentRequest } from "../src/chat/agent/tools";
import { packGuides, projectPacks } from "../src/chat/planning/guide";

const names = [...new Set(Object.keys(PACK_FILES).map((path) => path.split("/")[0]!))];

describe("packs offered to the maker", () => {
  it("every bundled pack has a skill with a name and a line on when it helps", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(frontMatter(PACK_FILES[`${name}/SKILL.md`]!)).toBeDefined();
  });

  it("a pack's skill is read only while the pack is on for the project", () => {
    const name = names[0]!;
    expect(readSkillFile(name)).toBeUndefined();
    expect(readSkillFile(name, [])).toBeUndefined();
    expect(readSkillFile(name, [name])).toBe(PACK_FILES[`${name}/SKILL.md`]);
    expect(readSkillFile(`packs/${name}/SKILL.md`, [name])).toBe(PACK_FILES[`${name}/SKILL.md`]);
  });

  it("the item's instructions name the packs that are on, and nothing when none is", () => {
    const name = names[0]!;
    expect(packsNote([])).toBeUndefined();
    expect(packsNote(["no-such-pack"])).toBeUndefined();
    expect(packsOn([name]).map((p) => p.name)).toEqual([frontMatter(PACK_FILES[`${name}/SKILL.md`]!)!.name]);
    expect(packsNote([name])).toContain(frontMatter(PACK_FILES[`${name}/SKILL.md`]!)!.description);
  });

  it("the planner's turn carries the skill of each pack on for the project, as its own guide is carried", () => {
    const name = names[0]!;
    expect(projectPacks({ packs: [name, 3, "nope"] })).toEqual([name, "nope"]);
    expect(projectPacks({})).toEqual([]);
    const base = { sources: [], ticked: undefined, plans: [], history: [], request: { text: "/plan", mentions: [] } as unknown as AgentRequest };
    const body = PACK_FILES[`${name}/SKILL.md`]!.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    expect(agentPrompt({ ...base, packs: [name] })).toContain(body.slice(0, 200));
    expect(agentPrompt({ ...base, packs: [] })).not.toContain(body.slice(0, 200));
    expect(packGuides(["nope"])).toBe("");
  });

  it("Open Sourcebook's own skills are read as before, with or without packs", () => {
    expect(readSkillFile("notebook")).toBeDefined();
    expect(readSkillFile("notebook", names)).toBe(readSkillFile("notebook"));
  });
});
