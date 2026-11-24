/**
 * The planning skill (docs/VISION.md, "A plan, when a path is wanted";
 * engine/docs/api.md, "Plans"). It makes a new plan from the turn's sources and what was
 * asked, or changes the plan this chat is working on. What a plan may hold
 * comes from the registries at run time; the model's plan is checked with
 * the plan model's own rules, sent back with its problems, and never
 * stored while it has any.
 */
import type { Message, Plan } from "../../studio/repositories";
import { renderHistory, renderMentions } from "../context";
import { question, say, type ReplyPiece } from "../pieces";
import type { ChatSkill, SkillReply, SkillTurn } from "../skills";
import { commitEdit, commitNewPlan, draftServicesFor, picksByScope } from "./commit";
import type { DraftServices } from "./draft";
import { readPlan, renderPlan, type HandItems, type PlanSnapshot } from "./edit";
import { ABOUT_OPENSOURCEBOOK } from "../about-opensourcebook";
import { ASK_SHAPE, catalog, EDIT_SHAPE, FORCED_NOTE, NEW_PLAN_SHAPE, PLANNER_SYSTEM_PROMPT } from "./prompts";
import { SourceMap } from "./sources";
import { isRecord } from "../../net";

export interface PlanningOptions {
  /** Rounds the model gets to fix a plan with problems before it is given up. */
  repairRounds?: number;
  /** About how many characters the map of the sources takes in the prompt. */
  mapBudgetChars?: number;
  historyChars?: number;
}

const DEFAULT_REPAIR_ROUNDS = 2;
const DEFAULT_MAP_BUDGET = 40_000;
const DEFAULT_HISTORY_CHARS = 6_000;
const SHOWN_ISSUES = 6;

export function createPlanningSkill(options: PlanningOptions = {}): ChatSkill {
  const rounds = options.repairRounds ?? DEFAULT_REPAIR_ROUNDS;
  return {
    id: "planning",
    label: "plan",
    command: "plan",
    title: "Plan a whole subject",
    group: "plan",
    action: "Make a plan",
    about: "A path through the sources: what to make and in what order, shown first for you to look over and start.",
    whenToUse:
      "the person asks for a plan, a path or a set of things to make; or says anything about a plan this chat made: a change (add, remove, shorten, reorder, change a format or a branch), a remark that it is wrong or not what they asked for, or a question about it; or says yes to being offered a plan, or answers questions Open Sourcebook asked before planning.",
    offerWhen:
      "the conversation shows what the person is after with these sources (what they want to learn, prepare for or be able to do) well enough to plan it, and no plan has been made for it yet.",
    async run(turn) {
      const map = new SourceMap(turn.context.sources);
      const services = await draftServices(turn);
      if (map.entries.length === 0) {
        const waiting = turn.context.unread.length > 0;
        return {
          pieces: [
            say(
              waiting
                ? "Your sources are still being read, so there is nothing I can plan from yet. Try again once they show as ready."
                : "There are no sources to plan from. Add a source to the project, or tick one, and ask again.",
            ),
          ],
        };
      }
      const target = turn.how === "command" ? undefined : await targetPlan(turn);
      if (target && "refused" in target) return { pieces: [say(target.refused)] };
      if (target) {
        const edited = await editPlan(turn, target.plan, map, services, rounds, options);
        if (edited) return edited;
      }
      return newPlan(turn, map, services, rounds, options);
    },
  };
}

/** The plan a change is about: the one mentioned, else the newest this chat made. */
async function targetPlan(turn: SkillTurn): Promise<{ plan: Plan } | { refused: string } | undefined> {
  const mentioned = turn.context.plans[0];
  const plan = mentioned ?? (await turn.services.repos.plans.listBySession(turn.chat.id))[0];
  if (!plan) return undefined;
  if (plan.kickedOffAt || plan.status === "discarded") {
    // A started plan that was not named is not what a request for a plan is about: make a new one.
    if (!mentioned) return undefined;
    return { refused: `"${plan.title ?? "That plan"}" has ${plan.kickedOffAt ? "started" : "been discarded"}, so it can't change. Type /plan to make a new one.` };
  }
  return { plan };
}

async function newPlan(turn: SkillTurn, map: SourceMap, services: DraftServices, rounds: number, options: PlanningOptions): Promise<SkillReply> {
  const base = [
    `About Open Sourcebook:\n${ABOUT_OPENSOURCEBOOK}`,
    catalog(turn.services.registry, turn.services.conditions, turn.services.plans?.edgeKinds),
    `Sources (passages numbered from 1):\n${map.render(options.mapBudgetChars ?? DEFAULT_MAP_BUDGET)}`,
    context(turn, options),
    `What the person asked: ${turn.text.trim() || "a plan from these sources."}`,
    (await turn.services.repos.plans.listBySession(turn.chat.id)).length > 0
      ? "Plans made earlier in this chat stay as they are. This is a new, separate plan: describe it as new, not as a change to an earlier one."
      : "",
    NEW_PLAN_SHAPE,
    // `/plan` plans at once; otherwise the planner may ask first.
    turn.how === "command" ? FORCED_NOTE : ASK_SHAPE,
  ]
    .filter(Boolean)
    .join("\n\n");
  let feedback = "";
  let issues: string[] = [];
  for (let round = 0; round <= rounds; round += 1) {
    const raw = await turn.provider.generateJSON<unknown>({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: base + feedback,
      task: "planning",
    });
    if (turn.how !== "command" && round === 0) {
      const asked = askFirst(raw);
      if (asked) return asked;
    }
    const committed = await commitNewPlan(raw, map, services, {
      repos: turn.services.repos,
      registry: turn.services.registry,
      owner: { ownerId: turn.ownerId, projectId: turn.project.id, sessionId: turn.chat.id },
    });
    if ("plan" in committed) {
      const { plan } = committed;
      return {
        pieces: [say(committed.reply || `Here is a plan: "${plan.title ?? "Untitled plan"}".`), { kind: "plan", planId: plan.id, action: "created" }, ...afterText(raw)],
      };
    }
    issues = committed.issues;
    feedback = `\n\nYour last answer:\n${JSON.stringify(raw)}\n\nIt has these problems; return the whole plan again with them fixed. The person never saw that answer: write the reply as if this is the first plan you show them.\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
  }
  return { pieces: [say(gaveUp("a plan", issues))] };
}

/** Undefined when the model says a different plan was asked for. */
async function editPlan(turn: SkillTurn, plan: Plan, map: SourceMap, services: DraftServices, rounds: number, options: PlanningOptions): Promise<SkillReply | undefined> {
  const { repos } = turn.services;
  const shown = await readPlan(repos, plan);
  const hand = await handItems(turn, plan, shown);
  const base = [
    `About Open Sourcebook:\n${ABOUT_OPENSOURCEBOOK}`,
    catalog(turn.services.registry, turn.services.conditions, turn.services.plans?.edgeKinds),
    `Sources (passages numbered from 1):\n${map.render(options.mapBudgetChars ?? DEFAULT_MAP_BUDGET)}`,
    `The plan this chat is working on:\n${renderPlan(shown, map, hand.byHand)}`,
    context(turn, options),
    `What the person said: ${turn.text.trim()}`,
    EDIT_SHAPE,
    ASK_SHAPE,
  ]
    .filter(Boolean)
    .join("\n\n");
  let feedback = "";
  let issues: string[] = [];
  for (let round = 0; round <= rounds; round += 1) {
    const raw = await turn.provider.generateJSON<unknown>({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: base + feedback,
      task: "planning",
    });
    if (isRecord(raw) && raw.newPlan === true) return undefined;
    if (round === 0) {
      const asked = askFirst(raw);
      if (asked) return asked;
    }
    const outcome = await commitEdit(raw, plan, shown, map, services, { repos, registry: turn.services.registry }, hand);
    if ("closed" in outcome) return { pieces: [say(outcome.closed)] };
    if ("issues" in outcome) issues = outcome.issues;
    else {
      const reply = isRecord(raw) && typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : outcome.changes.length ? "Done." : "I left the plan as it is.";
      const changes = [...outcome.changes, ...outcome.kept];
      // A remark or question that changed nothing is answered without the card again.
      if (changes.length === 0) return { pieces: [say(reply), ...afterText(raw)] };
      return {
        pieces: [say(reply), { kind: "plan", planId: plan.id, action: "edited", changes }, ...afterText(raw)],
      };
    }
    feedback = `\n\nYour last answer:\n${JSON.stringify(raw)}\n\nIt has these problems; return all the ops again with them fixed. The person never saw that answer: write the reply as if it is your first.\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
  }
  return { pieces: [say(gaveUp("that change", issues))] };
}

/**
 * The items the person made or changed by hand since this chat last wrote
 * the plan (its newest reply carrying it), and whether the message names
 * one: by @-mention, or by its title as words of their own.
 */
function handItems(turn: SkillTurn, plan: Plan, shown: PlanSnapshot): Promise<HandItems> {
  return handItemsIn(turn.services.repos, turn.chat.id, plan, shown, turn.context.items.map((item) => item.id), turn.text);
}

/**
 * `handItems` for any chat turn: the items mentioned by id, and the person's
 * words. A reply that is written over time (the person's agent) says when
 * it last wrote the plan through `wroteAt`, and `until` is when the current
 * turn began: what it changes itself is not by hand.
 */
export async function handItemsIn(
  repos: SkillTurn["services"]["repos"],
  chatId: string,
  plan: Plan,
  shown: PlanSnapshot,
  mentionedItems: string[],
  text: string,
  timing: { wroteAt?: (message: Message) => Promise<string>; until?: string } = {},
): Promise<HandItems> {
  const messages = await repos.sessions.listMessages(chatId, { limit: 500 });
  const last = messages.filter((message) => message.role === "assistant" && carriesPlan(message.content, plan.id)).at(-1);
  const wrote = last ? await (timing.wroteAt?.(last) ?? last.createdAt) : undefined;
  const byHand = new Set(wrote ? [...shown.stamps].filter(([, stamp]) => stamp > wrote && (!timing.until || stamp < timing.until)).map(([id]) => id) : []);
  const mentioned = new Set(mentionedItems);
  return {
    byHand,
    named: (item) => mentioned.has(item.key) || (item.title.trim() !== "" && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(item.title.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(text)),
  };
}

function carriesPlan(content: unknown, planId: string): boolean {
  return isRecord(content) && Array.isArray(content.pieces) && content.pieces.some((piece) => isRecord(piece) && piece.kind === "plan" && piece.planId === planId);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function context(turn: SkillTurn, options: PlanningOptions): string {
  const parts: string[] = [];
  if (turn.context.unread.length > 0) parts.push(`Not readable yet, so not in the plan: ${turn.context.unread.map((source) => source.title).join(", ")}.`);
  const mentions = renderMentions(turn.context);
  if (mentions) parts.push(mentions);
  const history = renderHistory(turn.history, options.historyChars ?? DEFAULT_HISTORY_CHARS);
  if (history) parts.push(`Conversation so far:\n${history}`);
  return parts.join("\n\n");
}

async function draftServices(turn: SkillTurn): Promise<DraftServices> {
  const picks = await picksByScope(turn.services.repos, turn.ownerId);
  return draftServicesFor({
    repos: turn.services.repos,
    registry: turn.services.registry,
    conditions: turn.services.conditions,
    projectSources: turn.context.projectSources,
    sources: turn.context.sources,
    ...(picks ? { picks } : {}),
  });
}

/**
 * The planner's questions before a plan, as a reply: its words, then a
 * question piece each. Picking an option comes back to this skill.
 * Undefined when the answer is not a request to ask.
 */
function askFirst(raw: unknown): SkillReply | undefined {
  const ask = isRecord(raw) && isRecord(raw.ask) ? raw.ask : undefined;
  if (!ask || !Array.isArray(ask.questions)) return undefined;
  const questions = ask.questions
    .slice(0, 8)
    .map((entry, index) => question(`q${index + 1}`, entry, () => "planning"))
    .filter((piece) => piece !== undefined);
  if (questions.length === 0) return undefined;
  const reply = typeof ask.reply === "string" && ask.reply.trim() ? [say(ask.reply.trim())] : [];
  return { pieces: [...reply, ...questions] };
}

/** What the planner wants to say after the plan card, if anything. */
function afterText(raw: unknown): ReplyPiece[] {
  return isRecord(raw) && typeof raw.after === "string" && raw.after.trim() ? [say(raw.after.trim())] : [];
}

function gaveUp(what: string, issues: string[]): string {
  const shown = issues.slice(0, SHOWN_ISSUES).map((issue) => `- ${issue}`).join("\n");
  return `I couldn't make ${what} hold together, so nothing was saved. What was still wrong:\n${shown}${issues.length > SHOWN_ISSUES ? `\n- and ${issues.length - SHOWN_ISSUES} more` : ""}`;
}
