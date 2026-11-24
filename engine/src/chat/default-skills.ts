/**
 * The skills the worker's chat uses. A new skill is registered here; the
 * chat core never names one.
 */
import { createMakeSkill } from "./making/skill";
import { createMindMapSkill } from "./mind-map";
import { createPlanningSkill } from "./planning/skill";
import { SkillRegistry } from "./skills";
import { createTalkSkill } from "./talk";
import { createTeachBackSkill } from "./teach-back";

export function createDefaultSkills(): SkillRegistry {
  return new SkillRegistry().register(createPlanningSkill()).register(createMakeSkill()).register(createTalkSkill()).register(createTeachBackSkill()).register(createMindMapSkill());
}
