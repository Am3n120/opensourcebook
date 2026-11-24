/**
 * Making one thing (docs/VISION.md, "Asking for one"; engine/docs/api.md,
 * "Making one thing"). One thing asked for in the chat (a /<shape> command,
 * "make me a quiz on chapter 3") is first a make sheet filled in and saved
 * nowhere (`proposeOne`); it is made, with no card to approve and no Start
 * to press, when the person presses the sheet's button or a make tile, or
 * at once from a terminal (`makeOne`). Underneath it is a plan of one item,
 * marked `direct`, that starts itself, so jobs, steps, the Studio, the feed,
 * progress and `opensourcebook` all treat it as any plan. The item is checked, settled
 * and priced exactly as a plan item is (planning/draft.ts). A remake ("make
 * it shorter") is a new direct plan from the old one's item with the change,
 * pointing back at it through `supersedesPlanId`; the old one stays.
 *
 * Nothing here names a format: what an item may be comes from the registry.
 */
import { isRecord } from "../../net";
import { PickNeededError } from "../providers";
import { issueMessages, PlanNotRunnableError, unmakeableNodes, type PlanRunner } from "../../studio/plan-runner";
import type { FormatRegistry } from "../../studio/registry";
import type { Message, Plan, PlanNode, Session, StudioRepositories } from "../../studio/repositories";
import { checkDraft, estimate, settingsOf, settle, type DraftItem, type DraftPlan, type DraftServices, type Settled } from "../planning/draft";
import { readItem, readSources } from "../planning/read";
import type { SourceMap } from "../planning/sources";
import { writeNewPlan } from "../planning/write";
import type { JsonObject } from "../../jobs/types";
import { pieceKinds, type MakePiece, type OtherPiece } from "../pieces";
import type { JsonValue } from "../../studio/types";

/** The key the one item of a direct plan has while it is a draft in memory. */
const ONE = "one";
const MAX_TITLE = 200;

export interface MakeContext {
  repos: StudioRepositories;
  registry: FormatRegistry;
  services: DraftServices;
  /** Starts it; without one nothing can be made here. */
  runner?: PlanRunner;
  owner: { ownerId: string; projectId: string; sessionId?: string };
  /** The made thing this is a remake of. */
  remakeOf?: Plan;
}

export type MakeOutcome =
  /** Saved and started. */
  | { plan: Plan; node: PlanNode; settled: Settled[] }
  /** The item has problems the one asking can fix; nothing was saved. */
  | { issues: string[] }
  /** Nothing can make it on this computer now (no maker ready, ...); nothing was saved. */
  | { cannot: string[] }
  /** Several providers could make it and none is picked: the person picks who (409 pick_needed); nothing was saved. */
  | { pickNeeded: string; scopes: string[] };

/** An item as a planner writes one (format, title, brief, settings, sources by label), as a draft. */
export function readOne(raw: unknown, map: SourceMap): { item?: DraftItem; issues: string[] } {
  const issues: string[] = [];
  const read = readItem(isRecord(raw) ? { ...raw, key: ONE } : raw, "the item", map, issues);
  if (!read) return { issues };
  if (!read.item.title) issues.push('the item needs a "title"');
  if (!read.item.prompt) issues.push('the item needs a "brief"');
  if (read.item.sources.length === 0) issues.push('the item needs its "sources": [{ "source": "S1" }] for a whole source');
  return { item: { ...read.item, level: 1, ord: 0 }, issues };
}

/** What a remake may change; everything left out stays as the old item has it. */
export interface Changes {
  format?: unknown;
  title?: unknown;
  brief?: unknown;
  settings?: unknown;
  sources?: unknown;
}

/**
 * The old item with the changes over it. Settings are merged over the old
 * ones, unless the format changes, when the old ones no longer apply.
 */
export async function remakeDraft(repos: StudioRepositories, node: PlanNode, changes: Changes, map: SourceMap): Promise<{ item: DraftItem; issues: string[] }> {
  const issues: string[] = [];
  const format = typeof changes.format === "string" && changes.format.trim() ? changes.format.trim() : node.type;
  const sameFormat = format === node.type;
  const sources =
    changes.sources === undefined
      ? (await repos.plans.listNodeSources(node.id)).map((source) => ({ sourceId: source.sourceId, ...(source.range ? { range: source.range } : {}) }))
      : (readSources(changes.sources, "the remake", map, issues) ?? []);
  const item: DraftItem = {
    key: ONE,
    existing: false,
    level: 1,
    ord: 0,
    type: format,
    title: typeof changes.title === "string" && changes.title.trim() ? changes.title.trim().slice(0, MAX_TITLE) : node.title,
    prompt: typeof changes.brief === "string" && changes.brief.trim() ? changes.brief.trim() : node.prompt,
    settings: sameFormat ? { ...node.settings, ...settingsOf(changes.settings) } : settingsOf(changes.settings),
    sources,
    enabled: true,
  };
  if (item.sources.length === 0) issues.push("the remake reads no source");
  return { item, issues };
}

/**
 * Settles what the item leaves open (as the maker would now) and prices it,
 * then answers its problems. Shared by making and by the Studio's form,
 * which shows the settled values before anything is made.
 */
export async function settleOne(item: DraftItem, services: DraftServices): Promise<{ draft: DraftPlan; settled: Settled[]; issues: string[] }> {
  const draft: DraftPlan = { ...(item.title ? { title: item.title } : {}), labels: new Map(), items: [item], edges: [] };
  const settled = await settle(draft, services);
  await estimate(draft, services);
  return { draft, settled, issues: checkDraft(draft, services) };
}

/** Saves the one item as a direct plan and starts it; nothing is kept when it can't start. */
export async function makeOne(item: DraftItem, context: MakeContext): Promise<MakeOutcome> {
  const { repos, registry, runner } = context;
  const { draft, settled, issues } = await settleOne(item, context.services);
  if (issues.length > 0) return { issues };
  if (!runner) return { cannot: ["Nothing can be made on this engine: it has no plan runner."] };
  const plan = await writeNewPlan(repos, registry, context.owner, draft, {
    direct: true,
    ...(context.remakeOf ? { supersedesPlanId: context.remakeOf.id } : {}),
  });
  const nodes = await repos.plans.listNodes(plan.id);
  const edges = await repos.plans.listEdges(plan.id);
  const refused = runner.startIssues(plan, nodes, edges, await runner.sourceCounts(nodes));
  if (refused.length > 0) {
    await repos.plans.delete(plan.id);
    return { cannot: refused.map((issue) => issue.short || issue.message) };
  }
  try {
    await repos.plans.transition(plan.id, ["draft"], "approved");
    await runner.kickOff(plan.id);
  } catch (error) {
    if (error instanceof PickNeededError) {
      await repos.plans.delete(plan.id);
      return { pickNeeded: error.message, scopes: error.scopes };
    }
    if (!(error instanceof PlanNotRunnableError)) throw error;
    await repos.plans.delete(plan.id);
    return { cannot: error.issues.length ? error.issues : issueMessages(error.details) };
  }
  return { plan: (await repos.plans.get(plan.id))!, node: nodes[0]!, settled };
}

/**
 * One thing asked for in the chat, as the make sheet the person opens:
 * settled and checked exactly as making it would be, saved nowhere. An item
 * with problems the one asking can fix comes back as them; what would stop
 * it on this computer now (no maker ready) goes in the piece's `issues`, so
 * the sheet says it and keeps its button off.
 */
export async function proposeOne(item: DraftItem, context: Pick<MakeContext, "registry" | "services"> & { remakes?: { planId: string; itemId: string } }): Promise<{ piece: MakePiece; settled: Settled[] } | { issues: string[] }> {
  const { draft, settled, issues } = await settleOne(item, context.services);
  if (issues.length > 0) return { issues };
  const settledItem = draft.items[0]!;
  const node = { type: settledItem.type, settings: settledItem.settings };
  // What Start would refuse it for on this computer now (no maker ready, a setting its maker can't take), as making it would say.
  const asNode = { id: ONE, planId: "", title: settledItem.title, enabled: true, ...node } as unknown as PlanNode;
  const cannot = unmakeableNodes([asNode], context.registry).map((issue) => issue.short || issue.message);
  return {
    piece: {
      kind: "make",
      format: settledItem.type,
      title: settledItem.title,
      about: settledItem.prompt,
      sources: [...new Set(settledItem.sources.map((source) => source.sourceId))],
      settings: settledItem.settings as JsonObject,
      plannedAs: thingWords(context.registry, node),
      notices: thingNotices(context.registry, node),
      issues: cannot,
      ...(context.remakes ? { remakes: context.remakes } : {}),
      state: "open",
    },
    settled,
  };
}

/** A make sheet a reply opened, found by its message and its place among the reply's pieces. */
export interface Proposal {
  message: Message;
  chat: Session;
  pieces: OtherPiece[];
  index: number;
  piece: MakePiece;
}

/**
 * The make piece at `index` of a reply in a chat of this owner and project.
 * Undefined when there is none: another owner's, another project's, or not
 * a make piece.
 */
export async function proposalOf(repos: StudioRepositories, scope: { ownerId: string; projectId?: string; chatId?: string }, messageId: string, index: number): Promise<Proposal | undefined> {
  const message = await repos.sessions.getMessage(messageId);
  if (!message || message.role !== "assistant" || (scope.chatId && message.sessionId !== scope.chatId)) return undefined;
  const chat = await repos.sessions.get(message.sessionId);
  if (!chat || chat.ownerId !== scope.ownerId || (scope.projectId && chat.projectId !== scope.projectId)) return undefined;
  const pieces = isRecord(message.content) && Array.isArray(message.content.pieces) ? (message.content.pieces as unknown as OtherPiece[]) : [];
  const piece = Number.isInteger(index) && index >= 0 ? pieces[index] : undefined;
  if (!piece || piece.kind !== "make") return undefined;
  return { message, chat, pieces, index, piece: piece as unknown as MakePiece };
}

/** Writes a make piece's new state into its reply (and the reply's plain text). */
export async function settleProposal(repos: StudioRepositories, proposal: Proposal, change: Pick<MakePiece, "state"> & { planId?: string }): Promise<Message> {
  const updated = await repos.sessions.updateContent(proposal.message.id, proposalContent(proposal, change));
  return updated ?? proposal.message;
}

/**
 * Marks an open make piece made or closed in one step: only while it is
 * still open, so of two presses only one wins. The reply when this call won,
 * undefined when the sheet was already used or closed.
 */
export async function claimProposal(repos: StudioRepositories, proposal: Proposal, change: Pick<MakePiece, "state"> & { planId?: string }): Promise<Message | undefined> {
  return repos.sessions.updateContentIf(proposal.message.id, proposalContent(proposal, change), `$.pieces[${proposal.index}].state`, "open");
}

/** Opens again a sheet this call marked made, when nothing was made from it after all. */
export async function reopenProposal(repos: StudioRepositories, proposal: Proposal): Promise<void> {
  await repos.sessions.updateContentIf(proposal.message.id, proposalContent(proposal, { state: "open" }), `$.pieces[${proposal.index}].state`, "made");
}

function proposalContent(proposal: Proposal, change: Pick<MakePiece, "state"> & { planId?: string }): JsonValue {
  const pieces = proposal.pieces.map((piece, index) => (index === proposal.index ? ({ ...proposal.piece, ...change } as unknown as OtherPiece) : piece));
  const content = isRecord(proposal.message.content) ? proposal.message.content : {};
  return { ...content, pieces: pieces as unknown as JsonValue, text: pieceKinds.replyText(pieces) };
}

/** A made thing as the chat and its tools name it. */
export interface MadeThing {
  plan: Plan;
  node: PlanNode;
}

/** The things made at once in a chat, newest first. */
export async function madeIn(repos: StudioRepositories, chatId: string): Promise<MadeThing[]> {
  const plans = (await repos.plans.listBySession(chatId)).filter((plan) => plan.direct);
  const out: MadeThing[] = [];
  for (const plan of plans) {
    const node = (await repos.plans.listNodes(plan.id))[0];
    if (node) out.push({ plan, node });
  }
  return out;
}

/**
 * A made thing by the id the person or the agent has for it: a direct plan's
 * id, or an item's id (of any plan in the project, so "this one but shorter"
 * works on an item of a bigger plan too).
 */
export async function thingOf(repos: StudioRepositories, scope: { ownerId: string; projectId: string }, ref: string): Promise<MadeThing | undefined> {
  const id = ref.trim();
  const plan = await repos.plans.get(id);
  if (plan) {
    if (plan.ownerId !== scope.ownerId || plan.projectId !== scope.projectId) return undefined;
    const nodes = await repos.plans.listNodes(plan.id);
    return nodes.length === 1 ? { plan, node: nodes[0]! } : undefined;
  }
  const node = await repos.plans.getNode(id);
  const owner = node ? await repos.plans.get(node.planId) : undefined;
  if (!node || !owner || owner.ownerId !== scope.ownerId || owner.projectId !== scope.projectId) return undefined;
  return { plan: owner, node };
}

/** Where a made thing is, in a few words. */
export function thingState(plan: Plan, node: PlanNode): string {
  if (plan.status === "cancelled") return "stopped before it was made";
  if (node.status === "done") return "made";
  if (node.status === "failed") return "could not be made";
  if (!plan.kickedOffAt) return "not started";
  return "being made now";
}

/** What an item is, in its format's own few words ("Drawn scenes · Chalkboard · about 2 min"). */
export function thingWords(registry: FormatRegistry, node: Pick<PlanNode, "type" | "settings">): string {
  const definition = registry.get(node.type);
  const parsed = definition?.parseSettings(node.settings);
  const words = definition?.describe && parsed?.ok ? definition.describe(parsed.settings) : [];
  const label = registry.descriptor(node.type)?.label ?? node.type;
  return [label, ...words].join(" · ");
}

/** What a person should know about an item before it is made, though it can be (a video with no sound, and how to give it one): the format's own lines. */
export function thingNotices(registry: FormatRegistry, node: Pick<PlanNode, "type" | "settings">): string[] {
  const definition = registry.get(node.type);
  const parsed = definition?.parseSettings(node.settings);
  return definition?.itemNotices && parsed?.ok ? definition.itemNotices(parsed.settings) : [];
}

/** The made things of a chat for a prompt, newest first: the one a follow-up is about is among them. */
export async function renderMade(repos: StudioRepositories, registry: FormatRegistry, chatId: string, opened?: string, limit = 8): Promise<string> {
  const things = await madeIn(repos, chatId);
  const open = opened ? await repos.plans.getNode(opened).catch(() => undefined) : undefined;
  const lines = things.slice(0, limit).map(({ plan, node }, index) => {
    const from = plan.supersedesPlanId ? things.find((other) => other.plan.id === plan.supersedesPlanId) : undefined;
    const marks = [index === 0 ? "the newest" : "", open?.id === node.id ? "open in front of the person now" : "", from ? `a remake of "${from.node.title}"` : ""].filter(Boolean);
    return `- "${node.title}" (thing ${plan.id}): ${thingWords(registry, node)}; ${thingState(plan, node)}${marks.length ? ` (${marks.join(", ")})` : ""}.`;
  });
  const openElsewhere = open && !things.some((thing) => thing.node.id === open.id) ? `\nOpen in front of the person now: "${open.title}" (item ${open.id}), from a plan.` : "";
  if (lines.length === 0) return openElsewhere.trim();
  return `Things made at once in this chat, newest first (remake_item takes the thing id):\n${lines.join("\n")}${openElsewhere}`;
}
