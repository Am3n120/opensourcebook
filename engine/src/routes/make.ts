/**
 * Making one thing without the chat (engine/docs/api.md, "Making one
 * thing"): the Studio's make tiles. The person picks a format, says what it
 * is about if they want, and sets its settings with the format's own form;
 * Open Sourcebook settles what is left open the way a plan does and makes it at once,
 * as a plan of one item that starts itself (chat/making/direct.ts).
 *
 *   POST /v1/projects/:id/make            { format, about?, sources?, settings?, chatId?, remakes?, proposal? } → 200 PlanView
 *   POST /v1/projects/:id/make/settle     { format, about?, sources?, settings? }          → 200 { settings, plannedAs, issues, notices }
 *
 * `sources` are source ids of the project; without them every readable one.
 * The chat's make sheet sends `proposal: { messageId, piece }`, the make
 * piece it was opened from, which is marked made so it never opens again;
 * a remake sends `remakes: { planId, itemId }`, the thing it remakes.
 * Nothing names a format: what an item may be comes from the registry.
 */
import { claimProposal, makeOne, proposalOf, reopenProposal, settleOne, settleProposal, thingNotices, thingWords, type MakeOutcome, type Proposal } from "../chat/making/direct";
import { picksByScope } from "../chat/planning/commit";
import { PickNeededError, pickNeededResponse } from "../chat/providers";
import type { DraftItem } from "../chat/planning/draft";
import { draftServicesFor } from "../chat/planning/commit";
import { errorResponse, json, readJsonObject } from "../http";
import { isRecord } from "../net";
import { createDefaultConditions } from "../studio/conditions";
import type { Plan, Project } from "../studio/repositories";
import type { EngineDeps } from "../wiring";
import { planView } from "./plan-edits";
import { ownedProject } from "./projects";

const MAX_ABOUT = 4_000;
const TITLE_CHARS = 80;
const MAX_TITLE = 200;

export async function makeInProject(request: Request, projectId: string, deps: EngineDeps, preview: boolean): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  if (owned.project.archivedAt) return errorResponse("project_archived", "An archived project makes nothing new", 409);
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const proposal = preview ? undefined : await proposalIn(read.body, owned.ownerId, projectId, deps);
  if (proposal && "response" in proposal) return proposal.response;
  const asked = await itemFrom(read.body, owned.project, deps, proposal?.proposal);
  if ("response" in asked) return asked.response;
  const picks = await picksByScope(deps.repos, owned.ownerId);
  const services = draftServicesFor({
    repos: deps.repos,
    registry: deps.registry,
    conditions: deps.plans?.conditions ?? createDefaultConditions(),
    projectSources: asked.projectSources,
    sources: [],
    ...(picks ? { picks } : {}),
  });
  if (preview) {
    const { draft, issues } = await settleOne(asked.item, services);
    const item = draft.items[0]!;
    return json({ settings: item.settings, plannedAs: thingWords(deps.registry, { type: item.type, settings: item.settings }), issues, notices: thingNotices(deps.registry, { type: item.type, settings: item.settings }) });
  }
  const chatId = typeof read.body.chatId === "string" ? read.body.chatId : undefined;
  const chat = chatId ? await deps.repos.sessions.get(chatId) : proposal?.proposal.chat;
  if (chatId && chat?.projectId !== projectId) return errorResponse("chat_not_in_project", "That chat is not in this project", 400);
  const remakes = await remakeIn(read.body, owned.ownerId, projectId, deps);
  if (remakes && "response" in remakes) return remakes.response;
  // The sheet is marked used in one step before anything is made, so of two presses only one makes it.
  if (proposal && !(await claimProposal(deps.repos, proposal.proposal, { state: "made" }))) return usedResponse(deps, proposal.proposal);
  let made: MakeOutcome | undefined;
  try {
    made = await makeOne(asked.item, {
      repos: deps.repos,
      registry: deps.registry,
      services,
      ...(deps.plans ? { runner: deps.plans } : {}),
      owner: { ownerId: owned.ownerId, projectId, ...(chat ? { sessionId: chat.id } : {}) },
      ...(remakes?.plan.direct ? { remakeOf: remakes.plan } : {}),
    });
  } finally {
    // Nothing was made: the sheet is open again, as it was.
    if (proposal && !(made && "plan" in made)) await reopenProposal(deps.repos, proposal.proposal);
  }
  if ("issues" in made) return json({ error: "invalid_item", message: "It can't be made as it is", issues: made.issues }, 422);
  if ("cannot" in made) return json({ error: "cannot_make_now", message: made.cannot.join(" "), issues: made.cannot }, 409);
  if ("pickNeeded" in made) return pickNeededResponse(new PickNeededError(made.scopes[0] ?? asked.item.type, made.scopes.slice(1)));
  if (proposal) await settleProposal(deps.repos, proposal.proposal, { state: "made", planId: made.plan.id });
  return json(await planView(deps, made.plan));
}

/** A sheet another press used or closed first: `409 proposal_used`, saying which. */
async function usedResponse(deps: EngineDeps, proposal: Proposal): Promise<Response> {
  const now = await proposalOf(deps.repos, { ownerId: proposal.chat.ownerId }, proposal.message.id, proposal.index);
  return errorResponse("proposal_used", now?.piece.state === "closed" ? "This sheet was closed" : "Something was already made from this sheet", 409);
}

/** The make piece the sheet was opened from, checked: in this project, and not made or closed yet. */
async function proposalIn(body: Record<string, unknown>, ownerId: string, projectId: string, deps: EngineDeps): Promise<{ proposal: Proposal } | { response: Response } | undefined> {
  if (body.proposal === undefined) return undefined;
  const raw = isRecord(body.proposal) ? body.proposal : undefined;
  if (!raw || typeof raw.messageId !== "string" || !raw.messageId || typeof raw.piece !== "number") {
    return { response: errorResponse("invalid_proposal", "proposal must be { messageId, piece }, the make piece the sheet was opened from", 400) };
  }
  const proposal = await proposalOf(deps.repos, { ownerId, projectId }, raw.messageId, raw.piece);
  if (!proposal) return { response: errorResponse("invalid_proposal", "That reply has no make sheet at that place in this project", 400) };
  if (proposal.piece.state !== "open") return { response: errorResponse("proposal_used", proposal.piece.state === "made" ? "Something was already made from this sheet" : "This sheet was closed", 409) };
  return { proposal };
}

/** The thing a remake remakes, checked: a plan of this project with that item. */
async function remakeIn(body: Record<string, unknown>, ownerId: string, projectId: string, deps: EngineDeps): Promise<{ plan: Plan } | { response: Response } | undefined> {
  if (body.remakes === undefined) return undefined;
  const raw = isRecord(body.remakes) ? body.remakes : undefined;
  const refused = { response: errorResponse("invalid_request", "remakes must be { planId, itemId } of a thing made in this project", 400) };
  if (!raw || typeof raw.planId !== "string" || typeof raw.itemId !== "string") return refused;
  const plan = await deps.repos.plans.get(raw.planId);
  const node = plan ? await deps.repos.plans.getNode(raw.itemId) : undefined;
  if (!plan || plan.ownerId !== ownerId || plan.projectId !== projectId || node?.planId !== plan.id) return refused;
  return { plan };
}

/** The item the form asks for: its format, a title and brief from the person's words, its sources and settings. */
async function itemFrom(body: Record<string, unknown>, project: Project, deps: EngineDeps, proposal?: Proposal): Promise<{ item: DraftItem; projectSources: Awaited<ReturnType<typeof deps.repos.sources.listByProject>> } | { response: Response }> {
  const format = typeof body.format === "string" ? body.format.trim() : "";
  if (!format || !deps.registry.has(format)) return { response: errorResponse("unknown_format", `No format "${format}" (GET /v1/formats lists them)`, 400) };
  const about = typeof body.about === "string" ? body.about.trim().slice(0, MAX_ABOUT) : "";
  const projectSources = (await deps.repos.sources.listByProject(project.id)).filter((source) => !source.removedAt);
  const wanted = Array.isArray(body.sources) ? body.sources.filter((id): id is string => typeof id === "string") : undefined;
  const picked = wanted?.length ? projectSources.filter((source) => wanted.includes(source.id)) : projectSources;
  if (wanted?.length && picked.length !== new Set(wanted).size) return { response: errorResponse("source_not_in_project", "A source is not in this project", 400) };
  const label = deps.registry.descriptor(format)?.label ?? format;
  const titles = picked.map((source) => source.title?.trim()).filter((title): title is string => Boolean(title));
  const from = titles.length ? `From ${titles.length > 3 ? `${titles.slice(0, 3).join(", ")} and ${titles.length - 3} more` : titles.join(", ")}.` : "";
  // From the chat's sheet, its title stays, and its brief too while "What it covers" was left as it was written.
  const sheet = proposal && proposal.piece.format === format ? proposal.piece : undefined;
  const asWritten = sheet !== undefined && about === sheet.about.trim().slice(0, MAX_ABOUT);
  const title = sheet ? clip(sheet.title, MAX_TITLE) : about ? clip(about.split("\n")[0]!, TITLE_CHARS) : titles.length === 1 ? `${capital(label)}: ${clip(titles[0]!, TITLE_CHARS)}` : capital(label);
  const prompt = asWritten
    ? sheet.about
    : about
      ? `Made for the person's own words, which say what it is about and how: ${about}\n${from}`
      : `Covers what the sources hold, as this ${label} best can, for someone meeting it for the first time. ${from}`;
  return {
    item: {
      key: "one",
      existing: false,
      level: 1,
      ord: 0,
      type: deps.registry.resolve(format) ?? format,
      title,
      prompt: prompt.trim(),
      settings: isRecord(body.settings) ? (body.settings as DraftItem["settings"]) : {},
      sources: picked.map((source) => ({ sourceId: source.id })),
      enabled: true,
    },
    projectSources,
  };
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
