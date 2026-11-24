/**
 * A thread on a made thing (engine/docs/api.md, "Threads"): everything Open Sourcebook
 * makes can be talked back to in place, at the spot the person is looking
 * at. A thread is not a store of its own: each message in it is a message
 * of the chat that made the thing, carrying `about` (which item, where in
 * it, and that spot said in a few words), and the reply to it carries the
 * same `about`. So the chat and the thread are one conversation: the chat
 * shows every message, the thread shows only those about its thing.
 *
 * A thing no chat made (a Studio tile) gets a chat the first time someone
 * writes in its thread: a new chat titled from the thing, linked to it.
 *
 * Where the person is comes from the player's own report (the item's kept
 * progress, in the player's shape), and the words for it from the format
 * (`describeAnchor`); nothing here names a format.
 */
import type { FormatRegistry } from "../studio/registry";
import type { Output, Plan, PlanNode, Project, Session, StudioRepositories } from "../studio/repositories";
import type { JsonValue } from "../studio/types";
import { thingState, thingWords } from "./making/direct";
import { titleFrom } from "./service";

/** What a thread message is about, as it is kept on the chat message (`content.about`). */
export interface ThreadAbout {
  /** The plan item. */
  item: string;
  plan: string;
  /** The made output the person was looking at. */
  output?: string;
  /** The format id, for the chat's "on the video …" line. */
  format: string;
  /** The thing's title when the message was written. */
  title: string;
  /** Where the person was in it, in the player's own shape. */
  at?: JsonValue;
  /** That spot in a few words, from the format ("at 0:42"); absent when the format has none. */
  label?: string;
}

/** A thread message as the turn takes it: what it is about, and the facts of that spot for the agent. */
export interface ThreadTurn extends ThreadAbout {
  facts: string[];
}

/** Largest spot a player may report, as JSON. */
export const MAX_AT_CHARS = 20_000;

export interface Thing {
  project: Project;
  plan: Plan;
  node: PlanNode;
  output?: Output;
}

/** A plan item of the owner's, with its project and newest made output; undefined when it is not theirs or not there. */
export async function thingOf(repos: StudioRepositories, ownerId: string, planId: string, itemId: string): Promise<Thing | undefined> {
  const plan = await repos.plans.get(planId);
  const node = await repos.plans.getNode(itemId);
  if (!plan || !node || node.planId !== plan.id || plan.ownerId !== ownerId) return undefined;
  const project = await repos.projects.get(plan.projectId);
  if (!project) return undefined;
  const output = await repos.outputs.latestForNode(node.id);
  return { project, plan, node, ...(output ? { output } : {}) };
}

/** The chat a thing's thread lives in: the one that made it, if it still exists. */
export async function linkedChat(repos: StudioRepositories, thing: Thing): Promise<Session | undefined> {
  if (!thing.plan.sessionId) return undefined;
  const chat = await repos.sessions.get(thing.plan.sessionId);
  return chat && chat.projectId === thing.project.id ? chat : undefined;
}

/**
 * The thing's chat, made and linked when it has none (made from the Studio,
 * or its chat deleted). Several items of one plan share its chat.
 */
export async function chatFor(repos: StudioRepositories, thing: Thing): Promise<{ chat: Session; created: boolean }> {
  const linked = await linkedChat(repos, thing);
  if (linked) return { chat: linked, created: false };
  const title = titleFrom(thing.plan.direct || !thing.plan.title ? thing.node.title : thing.plan.title);
  const chat = await repos.sessions.create({ ownerId: thing.plan.ownerId, projectId: thing.project.id, title });
  // A deleted chat leaves its plan with none (0004: ON DELETE SET NULL), so this links it too.
  await repos.plans.linkSession(thing.plan.id, chat.id);
  return { chat, created: true };
}

/** What a message about the thing at `at` is about: the item and, when the format can say it, the spot in words. */
export function aboutOf(registry: FormatRegistry, thing: Thing, at: JsonValue | undefined): { about: ThreadAbout; facts: string[] } {
  const served = thing.output ? registry.served(thing.output) : undefined;
  const words = served && at !== undefined ? registry.anchor(served, at) : undefined;
  const about: ThreadAbout = {
    item: thing.node.id,
    plan: thing.plan.id,
    ...(served ? { output: served.id } : {}),
    format: registry.servedType(thing.node.type),
    title: served?.title || thing.node.title,
    ...(at !== undefined ? { at } : {}),
    ...(words ? { label: words.label } : {}),
  };
  // A spot the format has no words for is kept as the player gave it.
  const facts = words?.facts ?? (at !== undefined ? [`Where they are in it, as its player keeps it: ${JSON.stringify(at)}`] : []);
  return { about, facts };
}

/**
 * The facts a turn about a thread message starts from, as lines: which
 * thing, what it is and was made from, and the spot the person is at.
 * Generated from the item and its format, never written per format.
 */
export function threadFacts(registry: FormatRegistry, thing: Thing, turn: ThreadTurn): string {
  const label = registry.descriptor(thing.node.type)?.label ?? thing.node.type;
  const lines = [
    `The thing: the ${label} "${turn.title}" (item ${thing.node.id}${thing.plan.direct ? `, thing ${thing.plan.id}` : `, in the plan "${thing.plan.title ?? "Untitled plan"}"`}): ${thingWords(registry, thing.node)}; ${thingState(thing.plan, thing.node)}.`,
    `Its brief: ${thing.node.prompt}`,
  ];
  if (thing.output?.summary) lines.push(`What it covers: ${thing.output.summary}`);
  if (turn.facts.length) lines.push(`Where they are in it${turn.label ? ` (${turn.label})` : ""}:\n${turn.facts.map((fact) => `  - ${fact}`).join("\n")}`);
  else lines.push("They did not say where in it they are.");
  return lines.map((line) => (line.startsWith("-") ? line : `- ${line}`)).join("\n");
}

/** A message's `about`, when it is a thread message or a reply to one. */
export function aboutIn(content: JsonValue): ThreadAbout | undefined {
  if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
  const about = content.about;
  if (!about || typeof about !== "object" || Array.isArray(about) || typeof about.item !== "string") return undefined;
  return about as unknown as ThreadAbout;
}
