/**
 * Decides per turn whether to answer from the sources or to use a skill,
 * from what each registered skill says about itself. A forced skill
 * (`/command`) never reaches here. With no skills registered nothing is
 * asked. Anything but a registered skill id means the sources.
 */
import { isRecord } from "../net";
import type { Plan } from "../studio/repositories";
import type { StructuredProvider } from "../types/provider";
import type { ChatSkill } from "./skills";

export const ROUTER_SYSTEM_PROMPT = `You decide how Open Sourcebook handles one chat message in a project of someone's sources.
Choose "sources" only when the message asks about what the project's sources say or contain: their content, a claim in them, something in them to explain. Open Sourcebook then answers from the sources with citations.
Otherwise choose the skill whose "Use it when" fits. Read the message together with the conversation so far: a reply or a remark about what Open Sourcebook just said or made belongs with what Open Sourcebook was doing, not with the sources.
If nothing else fits, choose "sources".
Return only JSON: {"use": "sources" | "<skill id>"}`;

export async function routeTurn(input: {
  text: string;
  history: string;
  skills: ChatSkill[];
  chatPlans: Plan[];
  provider: StructuredProvider;
}): Promise<ChatSkill | undefined> {
  if (input.skills.length === 0) return undefined;
  const plans = input.chatPlans.length
    ? `Plans made in this chat, newest first:\n${input.chatPlans
        .slice(0, 5)
        .map((plan) => `- "${plan.title ?? "Untitled plan"}", ${plan.kickedOffAt ? "started" : plan.status}`)
        .join("\n")}`
    : "No plan has been made in this chat yet.";
  const skills = input.skills.map((skill) => `- ${skill.id}: ${skill.about} Use it when: ${skill.whenToUse}`).join("\n");
  const raw = await input.provider.generateJSON<unknown>({
    systemPrompt: ROUTER_SYSTEM_PROMPT,
    userPrompt: [`Skills:\n${skills}`, plans, input.history ? `Conversation so far:\n${input.history}` : "", `Message:\n${input.text}`].filter(Boolean).join("\n\n"),
    task: "chat",
  });
  const use = isRecord(raw) && typeof raw.use === "string" ? raw.use.trim() : "answer";
  return input.skills.find((skill) => skill.id === use);
}
