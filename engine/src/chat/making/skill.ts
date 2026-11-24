/**
 * The make skill: one thing asked for on its own opens its make sheet filled
 * in, and a follow-up about something made in this chat ("make it shorter",
 * "redo it in ink", "again") opens the sheet for a remake with the change
 * (making/direct.ts). Nothing is made until the person presses the sheet's
 * button (`POST /v1/projects/:id/make` with `proposal`); a message from the
 * terminal, which has no sheet, makes it at once. It takes
 * one command per format that can be made now, by the format's own id, with
 * its label and few words from the format's descriptor: a new format is a
 * new command with no change here. This is how Open Sourcebook's own model does it; the
 * person's agent does the same with the make_item and remake_item tools.
 */
import { isRecord } from "../../net";
import { ABOUT_OPENSOURCEBOOK } from "../about-opensourcebook";
import { renderHistory, renderMentions } from "../context";
import { draftServicesFor, picksByScope } from "../planning/commit";
import { catalog, PLANNER_SYSTEM_PROMPT } from "../planning/prompts";
import { SourceMap } from "../planning/sources";
import { question, say } from "../pieces";
import type { ChatSkill, SkillReply, SkillTurn } from "../skills";
import { makeOne, proposeOne, readOne, remakeDraft, renderMade, thingOf, thingWords, type MakeOutcome } from "./direct";

const REPAIR_ROUNDS = 2;
const MAP_BUDGET = 30_000;
const HISTORY_CHARS = 6_000;

export const MAKE_SHAPE = `Return JSON, one of:
- To fill in the make sheet for one new thing: { "reply": "<one line saying what the sheet holds>", "item": { "format": "<a format id>", "title": "...", "brief": "...", "settings": { }, "sources": [ { "source": "S1", "from"?: n, "to"?: n } ] } }
- To fill in the sheet that remakes a thing made in this chat with a change: { "reply": "<one line saying what would be remade and how>", "remake": { "thing": "<its thing id>", "format"?: "<id>", "title"?: "...", "brief"?: "<the whole new brief, when what it covers or how changes>", "settings"?: { <only the settings that change> }, "sources"?: [ ... ] } }
- To ask the one thing you need first: { "ask": { "reply": "...", "questions": [ { "text": "...", "options": [ "..." ] } ] } }
Set real values on every setting you can (your guide says how). Nothing is made until the person presses the sheet's button. The reply is one line, such as what it is, how long, in which look, from which source; it never lists settings by their keys.`;

export function createMakeSkill(): ChatSkill {
  return {
    id: "make",
    label: "make",
    about: "Opens the make sheet for one thing from the sources (a video, a quiz, ...), filled in, with no plan to approve; and opens it to remake something made in this chat with a change.",
    whenToUse:
      "the person asks for one thing to be made (one video, one quiz, ... about something), not a set of things or a path through the material; or asks for a change to something made in this chat (shorter, simpler, another look, more questions, the same about another part, again).",
    commandsFor(registry) {
      // A format that cannot be made here now for a reason the person can fix keeps its command, which says that reason.
      return registry.views().flatMap((view) => {
        if (!view.ready && !view.problem) return [];
        return [{ word: view.id, title: view.label, group: "make" as const, label: view.singular ?? view.label, about: view.problem ?? view.blurb ?? view.about ?? `Makes one ${view.label} now.`, format: view.id }];
      });
    },
    async run(turn) {
      const unavailable = turn.format ? turn.services.registry.problem(turn.format) : undefined;
      if (unavailable) {
        const descriptor = turn.services.registry.descriptor(turn.format!);
        return { pieces: [say(`Open Sourcebook can't make ${descriptor?.singular ?? descriptor?.label ?? turn.format} on this computer yet. ${unavailable}`)] };
      }
      const map = new SourceMap(turn.context.sources);
      if (map.entries.length === 0) {
        return { pieces: [say(turn.context.unread.length ? "Your sources are still being read, so there is nothing to make from yet. Try again once they show as ready." : "There are no sources to make from. Add a source to the project, or tick one, and ask again.")] };
      }
      const picks = await picksByScope(turn.services.repos, turn.ownerId);
      const services = draftServicesFor({
        repos: turn.services.repos,
        registry: turn.services.registry,
        conditions: turn.services.conditions,
        projectSources: turn.context.projectSources,
        sources: turn.context.sources,
        ...(picks ? { picks } : {}),
      });
      const forced = turn.format ? turn.services.registry.descriptor(turn.format) : undefined;
      const base = [
        `About Open Sourcebook:\n${ABOUT_OPENSOURCEBOOK}`,
        catalog(turn.services.registry, turn.services.conditions, turn.services.plans?.edgeKinds),
        `Sources (passages numbered from 1):\n${map.render(MAP_BUDGET)}`,
        await renderMade(turn.services.repos, turn.services.registry, turn.chat.id),
        renderMentions(turn.context),
        turn.history.length ? `Conversation so far:\n${renderHistory(turn.history, HISTORY_CHARS)}` : "",
        forced
          ? `The person typed /${turn.format}: fill in the make sheet for one ${forced.singular ?? forced.label} (format ${forced.id}) now${turn.text.trim() ? ", about what they wrote" : " from the ticked sources; ask only when they hold several unrelated things and nothing says which"}.`
          : "",
        `What the person said: ${turn.text.trim() || "(nothing after the command)"}`,
        MAKE_SHAPE,
      ]
        .filter(Boolean)
        .join("\n\n");
      let feedback = "";
      for (let round = 0; round <= REPAIR_ROUNDS; round += 1) {
        const raw = await turn.provider.generateJSON<unknown>({ systemPrompt: PLANNER_SYSTEM_PROMPT, userPrompt: base + feedback, task: "planning" });
        if (round === 0) {
          const asked = askFirst(raw);
          if (asked) return asked;
        }
        const outcome = await attempt(raw, turn, map, services);
        if ("plan" in outcome) {
          const reply = isRecord(raw) && typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : `Making “${outcome.node.title}”: ${thingWords(turn.services.registry, outcome.node)}.`;
          return { pieces: [say(reply), { kind: "plan", planId: outcome.plan.id, action: "created", made: outcome.plan.supersedesPlanId ? "remade" : "made" }] };
        }
        if ("cannot" in outcome) return { pieces: [say(`I can't make that on this computer now: ${outcome.cannot.join(" ")}`)] };
        if ("pickNeeded" in outcome) return { pieces: [say(outcome.pickNeeded)] };
        if ("piece" in outcome) {
          const { piece } = outcome;
          if (piece.issues.length) return { pieces: [say(`I can't make that on this computer now: ${piece.issues.join(" ")}`), piece] };
          const reply = isRecord(raw) && typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : `Here is “${piece.title}”: ${piece.plannedAs}. Make it from the sheet when it looks right.`;
          return { pieces: [say(reply), piece] };
        }
        feedback = `\n\nYour last answer:\n${JSON.stringify(raw)}\n\nIt has these problems; answer again with them fixed. The person never saw that answer.\n${outcome.issues.map((issue) => `- ${issue}`).join("\n")}`;
      }
      return { pieces: [say("I couldn't settle that into something I can make, so there is no sheet to open. Say a little more about what you want.")] };
    },
  };
}

async function attempt(raw: unknown, turn: SkillTurn, map: SourceMap, services: ReturnType<typeof draftServicesFor>): Promise<Awaited<ReturnType<typeof proposeOne>> | MakeOutcome> {
  const context = { registry: turn.services.registry, services };
  // From the terminal it is made at once, as the agent's make_item does there.
  const making = {
    ...context,
    repos: turn.services.repos,
    ...(turn.services.plans ? { runner: turn.services.plans } : {}),
    owner: { ownerId: turn.ownerId, projectId: turn.project.id, sessionId: turn.chat.id },
  };
  const now = turn.from === "terminal";
  if (isRecord(raw) && isRecord(raw.remake)) {
    const ref = typeof raw.remake.thing === "string" ? raw.remake.thing : "";
    const old = ref ? await thingOf(turn.services.repos, { ownerId: turn.ownerId, projectId: turn.project.id }, ref) : undefined;
    if (!old) return { issues: [`"${ref}" is not a thing made in this project; use a thing id from the list`] };
    const { item, issues } = await remakeDraft(turn.services.repos, old.node, raw.remake, map);
    if (issues.length) return { issues };
    if (now) return makeOne(item, { ...making, ...(old.plan.direct ? { remakeOf: old.plan } : {}) });
    return proposeOne(item, { ...context, remakes: { planId: old.plan.id, itemId: old.node.id } });
  }
  const { item, issues } = readOne(isRecord(raw) ? raw.item : undefined, map);
  if (!item || issues.length) return { issues: issues.length ? issues : ['answer with "item", "remake" or "ask"'] };
  if (turn.format && item.type !== turn.format) return { issues: [`the person asked for format "${turn.format}", not "${item.type}"`] };
  return now ? makeOne(item, making) : proposeOne(item, context);
}

function askFirst(raw: unknown): SkillReply | undefined {
  const ask = isRecord(raw) && isRecord(raw.ask) ? raw.ask : undefined;
  if (!ask || !Array.isArray(ask.questions)) return undefined;
  const questions = ask.questions
    .slice(0, 3)
    .map((entry, index) => question(`q${index + 1}`, entry, () => "make"))
    .filter((piece) => piece !== undefined);
  if (questions.length === 0) return undefined;
  return { pieces: [...(typeof ask.reply === "string" && ask.reply.trim() ? [say(ask.reply.trim())] : []), ...questions] };
}
