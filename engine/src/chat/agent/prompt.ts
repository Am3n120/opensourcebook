/**
 * What the person's agent is told for one turn. The system prompt is how
 * to work in Open Sourcebook's chat (tools, cites, the reply), Open Sourcebook from the one place the
 * chat knows it (about-opensourcebook.ts), the planner's skill (skills/planner, given
 * whole every turn), how a plan is written down, and what the registries
 * hold now. Nothing here names a format, a subject or a plan shape.
 */
import type { ConditionRegistry } from "../../studio/conditions";
import type { EdgeKindRegistry } from "../../studio/edge-kinds";
import type { FormatRegistry } from "../../studio/registry";
import type { Message, Plan, Source } from "../../studio/repositories";
import { ABOUT_OPENSOURCEBOOK, type KnownSkill } from "../about-opensourcebook";
import { MIND_MAP_GUIDE } from "../mind-map";
import { TEACH_BACK_GUIDE } from "../teach-back";
import { renderHistory } from "../context";
import { packGuides, plannerGuide, plannerReferences, PLANNER_SKILL } from "../planning/guide";
import { catalog, PLAN_RULES } from "../planning/prompts";
import { planState } from "../planning/state";
import type { AgentRequest } from "./tools";

const HISTORY_CHARS = 8_000;

export const AGENT_RULES = `You are Open Sourcebook, in the chat of one project of the person's own sources: you answer from those sources, and you are the planner who decides what Open Sourcebook makes from them. You act only through Open Sourcebook's tools. You cannot see files, run commands or browse the web; do not try. The sources are labelled S1, S2, ... and their passages S1#1, S1#2, ...

Each turn is one of these, read together with the conversation:
- A question about what the sources say. Find it with search_passages (and read_passages for more around a hit), then reply, citing the exact passage for every claim with a few words copied from it. Use only the ticked sources and never general knowledge. If they do not hold the answer, say so plainly, say what they do cover if that helps, and set covered to false.
- Talk about Open Sourcebook itself or the conversation (a greeting, thanks, what Open Sourcebook can make). Reply briefly, with no cites and without reading sources.
- One thing to make: a /<format> command, or a plain request for one thing ("make me a quiz on chapter 3", "a short video about X"). Open its make sheet filled in with make_item, as your planner's guide says under "One thing, or a plan": the person looks it over and presses its button; nothing is made until they do. Reply in one line saying what the sheet holds.
- A change to something made in this chat, in plain words ("make it shorter", "simpler", "redo it in ink", "more questions", "this one but about chapter 5", "again"): remake_item on that thing, which opens its sheet with the change filled in, then one line saying what would change. The thing is the one the person names, else the one open in front of them, else the newest made.
- A message from the thread on one thing Open Sourcebook made: the person is looking at it and writes about where they are in it (a moment of a video, a card, a quiz question and the answer they gave), and the facts of that spot come with the message. Answer about that spot first, in a few sentences, cited; no lecture and no recap of the whole thing. When they disagree, read the source before you defend the thing. If the thing is wrong, say so plainly and offer to remake it with the fix (remake_item, once they want it), rather than only apologising. If the source does not settle it, say that. If they are right that the source says otherwise, say so. Your reply shows in the thread and in this chat.
- A teach-back: the person explains an idea from their sources in their own words to see how well they have it, with its command or plainly ("here's how I understand X, is that right?"). Find what the sources say about that idea (search_passages, then read_passages around the hits). ${TEACH_BACK_GUIDE} With nothing to check yet (only the command), ask which idea, and to explain it in their own words as if to a friend.
- A mind map: the person asks to see the main ideas laid out and how they connect, with its command or plainly ("map out chapter 3", "how does it all fit together?"). Look at what the sources cover (outline_sources, or search_passages for a topic they name), read the passages that hold the main ideas, then draw it. ${MIND_MAP_GUIDE}
- A plan, or a plan this chat made: a path through the material or several things ("help me learn this for my exam", "a video and then a quiz on each chapter", /plan), making one, changing it, a remark or a question about it. Look at what the sources cover first (outline_sources), then plan as your planner's guide says. To change a plan, read_plan, then change_plan with only what was asked.

Work in few steps: read what you need, act, then reply. Always end the turn with reply, in the person's language, written as its description says: answer first, and a list, a table or short paragraphs as the answer's shape asks. In the reply, name sources by their titles and plan items by their titles, never by labels like S1, S1#4 or I2, and never mention passage counts, sizes in characters, tool names or ids. A plan card under your reply already lists its items with their lengths: do not list them again.`;

/** The system prompt: how to work here, Open Sourcebook, the planner's guide, how a plan is written, what can be made now, and the commands. */
export function agentSystemPrompt(registry: FormatRegistry, conditions: ConditionRegistry, skills: readonly KnownSkill[], edgeKinds?: EdgeKindRegistry): string {
  const commands = skills.filter((skill) => skill.command);
  const references = plannerReferences();
  return [
    AGENT_RULES,
    `About Open Sourcebook:\n${ABOUT_OPENSOURCEBOOK}`,
    `Your planner's guide (the "${PLANNER_SKILL}" skill${references.length ? `; read_skill opens its ${references.join(" and ")}` : ""}):\n\n${plannerGuide()}`,
    PLAN_RULES,
    catalog(registry, conditions, edgeKinds),
    commands.length ? `Commands the person can type:\n${commands.map((skill) => `- /${skill.command}: ${skill.about}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Most plans of the chat named in the turn's prompt. */
const PLANS_SHOWN = 5;

/** The turn's message, with what the agent needs around it to start well. */
export function agentPrompt(input: {
  projectTitle?: string;
  /** The packs on for the project; their skills are given with the turn. */
  packs?: readonly string[];
  sources: Source[];
  ticked: ReadonlySet<string> | undefined;
  plans: Plan[];
  /** The things made at once in this chat, as `renderMade` says them; empty when none. */
  made?: string;
  history: Message[];
  request: AgentRequest;
}): string {
  const { sources, ticked } = input;
  const lines: string[] = [`Project: "${input.projectTitle ?? "Untitled project"}".`];
  const packs = packGuides(input.packs ?? []);
  if (packs) lines.push(packs);
  if (sources.length === 0) lines.push("The project has no sources yet.");
  else {
    const on = sources.filter((source) => !ticked || ticked.has(source.id));
    const off = sources.length - on.length;
    lines.push(`Ticked for this chat: ${on.length ? on.map((source) => `"${source.title}"`).join(", ") : "none"}${off ? ` (${off} more not ticked)` : ""}. list_sources gives their labels.`);
  }
  if (input.plans.length) {
    const shown = input.plans.slice(0, PLANS_SHOWN).map((plan) => `- "${plan.title ?? "Untitled plan"}" (id ${plan.id}): ${planState(plan)}.`);
    const more = input.plans.length > PLANS_SHOWN ? `\n(${input.plans.length - PLANS_SHOWN} older plans; read_plan lists them.)` : "";
    lines.push(
      `Plans made in this chat, newest first, as they are right now. The person may have pressed Start or changed a plan by hand since anything said in the conversation, so go by these states, not by earlier words:\n${shown.join("\n")}${more}`,
    );
  } else lines.push("No plan has been made in this chat yet.");
  if (input.made) lines.push(input.made);
  const mentions = input.request.mentions.map((mention) => `${mention.kind} "${mention.label ?? mention.id}"${mention.kind === "plan" ? ` (id ${mention.id})` : ""}`);
  if (mentions.length) lines.push(`The person @-mentioned: ${mentions.join(", ")}.`);
  const history = renderHistory(input.history, HISTORY_CHARS);
  if (history) lines.push(`Conversation so far:\n${history}`);
  const command = input.request.command;
  if (command?.format) {
    const words = input.request.text.trim();
    lines.push(
      `The person typed /${command.word}: ${input.request.from === "terminal" ? "make one item" : "open the make sheet for one item"} of format "${command.format}" now with make_item${words ? ", about what they wrote after it" : ", from the ticked sources; only if those hold several unrelated things and nothing in the chat says which, ask the one thing you need (about what?) with ask"}. No plan, no card.`,
    );
  } else if (command) lines.push(`The person typed /${command.word}: ${command.about} Do that now, without asking first.`);
  if (input.request.today) lines.push(`Today is ${weekday(input.request.today)} ${input.request.today} where the person is.`);
  if (input.request.picked) lines.push("The message picks options in the questions Open Sourcebook asked last.");
  if (input.request.thread)
    lines.push(`The person wrote this in the thread on one thing Open Sourcebook made, while looking at it. Answer about this spot first; the reply shows in that thread and in this chat.\n${input.request.thread.facts}`);
  if (input.request.from === "terminal")
    lines.push("The person is writing from a terminal, with the opensourcebook command, not in the app: they see your words but no plan card, make sheet or buttons, so make_item and remake_item make the thing at once there. Where you would point at the card or Start, say the command instead, such as opensourcebook plan start <plan id> to start a plan, opensourcebook plan show <plan id> to see it.");
  lines.push(`Message:\n${input.request.text.trim() || `/${input.request.command?.word ?? ""}`}`);
  return lines.join("\n\n");
}

/** The day of the week of a YYYY-MM-DD day, in English. */
function weekday(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}
