/**
 * What the person's agents are doing and what each run took, on this computer (docs/api.md, "Activity").
 *
 *   GET /v1/activity[?limit=&cursor=&shape=&project=&dayStart=]
 *     → 200 { connector, log?, making, turns, nextCursor?, totals?, shapes, projects }
 *
 * It joins what is being made now (the jobs running, waiting or queued, with their live step) and the finished turns
 * the connector keeps in its usage log (`GET /usage` on the connector: the engine cannot read files). Each turn is
 * placed by the target it named: the chat, the plan item or the job it was for, with a link the web can open. Turns
 * for something another owner holds are left out, as everything of theirs is. No money: the log's cost is never read.
 */
import type { UsageTurn } from "../chat/agent/connector";
import { parsePick } from "../chat/providers";
import { authenticate, errorResponse, json } from "../http";
import type { GenerationJob } from "../jobs/types";
import type { EngineDeps } from "../wiring";
import { jobView } from "./plans";

const PAGE = 50;
const PAGE_MAX = 200;
/** Turns read from the connector in one call. */
const CONNECTOR_PAGE = 200;
/** At most this many turns are looked through for one page of a filtered list; the cursor then carries on from there. */
const SCAN_MAX = 2_000;
/** At most this many turns count towards the totals (a week of very busy days). */
const WEEK_MAX = 10_000;
const LIVE = ["running", "waiting", "queued"] as const;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const DAY_MS = 86_400_000;

/** Where a link opens: a project's chat, its plan (where an item is), or the thing made. */
interface Open {
  projectId: string;
  chatId?: string;
  planId?: string;
  outputId?: string;
}

/** What a turn or a job was for, once found. */
interface Place {
  title?: string;
  projectId?: string;
  open?: Open;
}

interface Totals {
  turns: number;
  seconds: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function getActivity(request: Request, deps: EngineDeps): Promise<Response> {
  const auth = await authenticate(request, deps.clientToken);
  if ("response" in auth) return auth.response;
  const query = new URL(request.url).searchParams;
  const limit = query.has("limit") ? Number(query.get("limit")) : PAGE;
  const cursor = query.get("cursor") ?? undefined;
  const shape = query.get("shape") ?? undefined;
  const project = query.get("project") ?? undefined;
  const dayStart = query.get("dayStart") ?? undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) return errorResponse("invalid_request", `limit is 1 to ${PAGE_MAX}`, 400);
  if (cursor !== undefined && !/^[1-9]\d{0,8}$/.test(cursor)) return errorResponse("invalid_request", "cursor is the nextCursor of an earlier answer", 400);
  if ((shape !== undefined && !ID.test(shape)) || (project !== undefined && !ID.test(project))) return errorResponse("invalid_request", "shape and project are ids", 400);
  if (dayStart !== undefined && !Number.isFinite(Date.parse(dayStart))) return errorResponse("invalid_request", "dayStart is the start of the person's today, as an ISO time", 400);

  const owner = auth.ownerId;
  const now = Date.now();
  const today = dayStart !== undefined ? Date.parse(dayStart) : Math.floor(now / DAY_MS) * DAY_MS;
  const weekStart = today - 6 * DAY_MS;
  const places = placer(deps, owner);
  const projectTitles = new Map<string, Promise<string | undefined>>();
  const titleOf = (id: string) => {
    if (!projectTitles.has(id)) projectTitles.set(id, deps.repos.projects.get(id).then((found) => (found && found.ownerId === owner ? found.title : undefined)));
    return projectTitles.get(id)!;
  };
  const shapes = new Map<string, string>();
  const projects = new Set<string>();
  const seen = (shapeId: string | undefined, projectId: string | undefined) => {
    if (shapeId) shapes.set(shapeId, shapeLabel(deps, shapeId));
    if (projectId) projects.add(projectId);
  };
  const wanted = (shapeId: string | undefined, projectId: string | undefined) => (!shape || shapeId === shape) && (!project || projectId === project);

  // What is being made now: running first, then waiting, then queued, each oldest first.
  const live = ((await deps.jobs.listByStatus?.(LIVE, 200)) ?? []).filter((job) => job.ownerId === owner && job.type);
  live.sort((a, b) => LIVE.indexOf(a.status as (typeof LIVE)[number]) - LIVE.indexOf(b.status as (typeof LIVE)[number]) || Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt));
  const making = [];
  for (const job of live) {
    const shapeId = deps.registry.has(job.type!) ? deps.registry.servedType(deps.registry.resolve(job.type!)!) : job.type!;
    const found = await places.ofJob(job);
    const place = found === "other" ? undefined : found;
    seen(shapeId, place?.projectId);
    if (!wanted(shapeId, place?.projectId)) continue;
    making.push(await makingView(deps, job, shapeId, place, now, titleOf));
  }

  const agent = deps.chat?.agent;
  const base = { making, shapes: [] as Array<{ id: string; label: string }>, projects: [] as Array<{ id: string; title: string }> };
  const lists = async () => ({
    shapes: [...shapes].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label)),
    projects: (await Promise.all([...projects].map(async (id) => ({ id, title: await titleOf(id) }))))
      .filter((entry): entry is { id: string; title: string } => entry.title !== undefined)
      .sort((a, b) => a.title.localeCompare(b.title)),
  });
  if (!agent) return json({ ...base, ...(await lists()), connector: "notSetUp", turns: [] });

  // The connector's log, read a page at a time and each page once per request.
  const pages = new Map<number | undefined, Promise<Awaited<ReturnType<typeof agent.connector.usage>>>>();
  const page = (before?: number) => {
    if (!pages.has(before)) pages.set(before, agent.connector.usage({ limit: CONNECTOR_PAGE, ...(before ? { before } : {}) }));
    return pages.get(before)!;
  };
  let unreachable = false;
  let off = false;
  async function* walk(before?: number): AsyncGenerator<UsageTurn> {
    let at = before;
    for (;;) {
      const read = await page(at);
      if (!read.reachable) {
        unreachable = true;
        return;
      }
      if (read.off) off = true;
      yield* read.turns;
      if (!read.next) return;
      at = read.next;
    }
  }

  // Totals for today and the last 7 days (today and the 6 before it), of what the filter keeps.
  const totals = { today: zero(), week: zero() };
  let counted = 0;
  for await (const turn of walk()) {
    const at = Date.parse(turn.time);
    if (at < weekStart || ++counted > WEEK_MAX) break;
    const { shape: shapeId } = shapeOf(deps, turn.type);
    const place = await places.ofTurn(turn);
    if (place === "other") continue;
    seen(shapeId, place?.projectId);
    if (!wanted(shapeId, place?.projectId)) continue;
    add(totals.week, turn);
    if (at >= today) add(totals.today, turn);
  }
  if (unreachable) return json({ ...base, ...(await lists()), connector: "unreachable", turns: [] });

  // The agents' names, from the connector's own list (it keeps it 30 seconds).
  let labels: Promise<Map<string, string>> | undefined;
  const agentLabels = async (id: string) => {
    labels ??= agent.status().then((status) => new Map((status.agents ?? []).map((one) => [one.id, one.label])));
    return (await labels).get(id);
  };

  // One page of turns, newest first, from the cursor on.
  const turns = [];
  let scanned = 0;
  let last: number | undefined;
  let more = false;
  for await (const turn of walk(cursor ? Number(cursor) : undefined)) {
    if (turns.length >= limit || scanned >= SCAN_MAX) {
      more = true;
      break;
    }
    scanned++;
    last = turn.line;
    const { shape: shapeId, review } = shapeOf(deps, turn.type);
    const place = await places.ofTurn(turn);
    if (place === "other" || !wanted(shapeId, place?.projectId)) continue;
    turns.push(await turnView(turn, shapeId, review, place, titleOf, agentLabels));
  }
  if (unreachable) return json({ ...base, ...(await lists()), connector: "unreachable", turns: [] });
  return json({
    ...base,
    ...(await lists()),
    connector: "ready",
    ...(off ? { log: "off" } : {}),
    turns,
    ...(more && last ? { nextCursor: String(last) } : {}),
    totals,
  });
}

/** The shape a turn's target type names: a format (served under its id now), a format's fresh read (`<format>-review`), or the type itself (`chat`). */
function shapeOf(deps: EngineDeps, type: string | undefined): { shape?: string; review?: true } {
  if (!type) return {};
  if (deps.registry.has(type)) return { shape: deps.registry.servedType(deps.registry.resolve(type)!) };
  const read = /^(.+)-review$/.exec(type);
  if (read && deps.registry.has(read[1]!)) return { shape: deps.registry.servedType(deps.registry.resolve(read[1]!)!), review: true };
  return { shape: type };
}

function shapeLabel(deps: EngineDeps, shape: string): string {
  return deps.registry.descriptor(shape)?.label ?? shape;
}

/** Finds what a turn or a job was for, each target once per request. `"other"`: another owner's. */
function placer(deps: EngineDeps, owner: string) {
  const found = new Map<string, Promise<Place | "other" | undefined>>();
  const once = (key: string, find: () => Promise<Place | "other" | undefined>) => {
    if (!found.has(key)) found.set(key, find().catch(() => undefined));
    return found.get(key)!;
  };

  async function ofNode(nodeId: string): Promise<Place | "other" | undefined> {
    const node = await deps.repos.plans.getNode(nodeId);
    if (!node) return undefined;
    const plan = await deps.repos.plans.get(node.planId);
    if (!plan) return undefined;
    if (plan.ownerId !== owner) return "other";
    const output = node.status === "done" ? await deps.repos.outputs.latestForNode(node.id) : undefined;
    return { title: node.title, projectId: plan.projectId, open: { projectId: plan.projectId, planId: plan.id, ...(output ? { outputId: output.id } : {}) } };
  }

  async function ofJobRow(job: GenerationJob): Promise<Place | "other" | undefined> {
    if (job.ownerId !== owner) return "other";
    const fromNode = job.nodeId ? await ofNode(job.nodeId) : undefined;
    if (fromNode) return fromNode;
    const title = typeof job.input.title === "string" && job.input.title.trim() ? job.input.title.trim() : undefined;
    const open = job.projectId ? { projectId: job.projectId, ...(job.planId ? { planId: job.planId } : {}), ...(job.outputId ? { outputId: job.outputId } : {}) } : undefined;
    return { ...(title ? { title } : {}), ...(job.projectId ? { projectId: job.projectId } : {}), ...(open ? { open } : {}) };
  }

  return {
    ofJob: (job: GenerationJob) => once(`job:${job.id}`, () => ofJobRow(job)),
    /** A chat by its id; anything else by the item, or the job (a maker's own run of a job: `<job>` or `<job>-<n>`) it names. */
    ofTurn: (turn: UsageTurn) => {
      const id = turn.targetId;
      if (!id) return Promise.resolve(undefined);
      if (turn.type === "chat") {
        return once(`chat:${id}`, async () => {
          const chat = await deps.repos.sessions.get(id);
          if (!chat) return undefined;
          if (chat.ownerId !== owner) return "other";
          return { ...(chat.title ? { title: chat.title } : {}), ...(chat.projectId ? { projectId: chat.projectId, open: { projectId: chat.projectId, chatId: chat.id } } : {}) };
        });
      }
      return once(`target:${id}`, async () => {
        const node = await ofNode(id);
        if (node) return node;
        const job = (await deps.jobs.get(id)) ?? (/-\d+$/.test(id) ? await deps.jobs.get(id.replace(/-\d+$/, "")) : undefined);
        return job ? ofJobRow(job) : undefined;
      });
    },
  };
}

async function makingView(deps: EngineDeps, job: GenerationJob, shape: string, place: Place | undefined, now: number, titleOf: (id: string) => Promise<string | undefined>) {
  const thing = deps.registry.descriptor(shape)?.singular ?? deps.registry.descriptor(shape)?.label ?? "item";
  const view = jobView(job, thing) as { step?: string; waiting?: { reason: string; words: string }; doneBy?: string };
  const known = place;
  const since = job.startedAt ?? job.createdAt;
  const settings = job.input.settings && typeof job.input.settings === "object" && !Array.isArray(job.input.settings) ? (job.input.settings as Record<string, unknown>) : {};
  const pick = typeof settings.agent === "string" && settings.agent !== "auto" ? parsePick(settings.agent) : undefined;
  const effort = typeof settings.effort === "string" && settings.effort !== "auto" ? settings.effort : undefined;
  const projectTitle = known?.projectId ? await titleOf(known.projectId) : undefined;
  return {
    jobId: job.id,
    shape,
    ...(known?.title ? { title: known.title } : {}),
    ...(known?.projectId && projectTitle !== undefined ? { project: { id: known.projectId, title: projectTitle } } : {}),
    ...(known?.open && projectTitle !== undefined ? { open: known.open } : {}),
    status: job.status,
    ...(view.step ? { step: view.step } : {}),
    ...(view.waiting ? { waiting: { reason: view.waiting.reason, words: view.waiting.words } } : {}),
    progress: job.progress,
    since,
    seconds: Math.max(0, Math.round((now - Date.parse(since)) / 1000)),
    ...(view.doneBy ? { doneBy: view.doneBy } : {}),
    // The maker the person picked for it; none when it was left to Open Sourcebook.
    ...(pick?.agent || effort ? { maker: { ...(pick?.agent ? { agent: pick.agent } : {}), ...(pick?.model ? { model: pick.model } : {}), ...(effort ? { effort } : {}) } } : {}),
  };
}

async function turnView(turn: UsageTurn, shape: string | undefined, review: true | undefined, place: Place | undefined, titleOf: (id: string) => Promise<string | undefined>, labelOf: (id: string) => Promise<string | undefined>) {
  const projectTitle = place?.projectId ? await titleOf(place.projectId) : undefined;
  const agentLabel = await labelOf(turn.agent);
  return {
    turnId: turn.turnId,
    at: turn.time,
    ...(shape ? { shape } : {}),
    ...(review ? { review } : {}),
    ...(place?.title ? { title: place.title } : {}),
    ...(place?.projectId && projectTitle !== undefined ? { project: { id: place.projectId, title: projectTitle } } : {}),
    ...(place?.open && projectTitle !== undefined ? { open: place.open } : {}),
    agent: turn.agent,
    ...(agentLabel ? { agentLabel } : {}),
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.effort ? { effort: turn.effort } : {}),
    seconds: Math.round(turn.durationMs / 100) / 10,
    ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(turn.cacheReadTokens !== undefined ? { cacheReadTokens: turn.cacheReadTokens } : {}),
    ...(turn.cacheWriteTokens !== undefined ? { cacheWriteTokens: turn.cacheWriteTokens } : {}),
    toolCalls: turn.toolCalls,
    outcome: turn.outcome,
  };
}

function zero(): Totals {
  return { turns: 0, seconds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function add(totals: Totals, turn: UsageTurn): void {
  totals.turns++;
  totals.seconds = Math.round((totals.seconds + turn.durationMs / 1000) * 10) / 10;
  totals.inputTokens += turn.inputTokens ?? 0;
  totals.outputTokens += turn.outputTokens ?? 0;
  totals.cacheReadTokens += turn.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += turn.cacheWriteTokens ?? 0;
}
