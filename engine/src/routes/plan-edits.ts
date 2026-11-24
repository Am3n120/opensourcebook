/**
 * Plans in a project: create, read, edit items, stages and edges, approve,
 * Start and cancel (docs/api.md, "Plans"). Progress, done ticks and answers
 * are in plans.ts.
 *
 *   GET    /v1/projects/:id/plans          → 200 { plans: [{ ...plan, counts }] }
 *   POST   /v1/projects/:id/plans          → 201 plan view                 { title?, budgetUsd? }
 *   GET    /v1/plans/:id                   → 200 plan view
 *   PATCH  /v1/plans/:id                   → 200 plan view                 { title?, budgetUsd? }
 *   DELETE /v1/plans/:id                   → 200 { planId, deleted: { items, outputs, jobs, files } }
 *   PUT    /v1/plans/:id/stages/:level     → 200 plan view                 { label?, dueOn? }
 *   POST   /v1/plans/:id/catch-up          → 200 plan view                 { today }
 *   POST   /v1/plans/:id/items             → 201 plan view
 *   PATCH  /v1/plans/:id/items/:itemId     → 200 plan view
 *   DELETE /v1/plans/:id/items/:itemId     → 200 plan view
 *   POST   /v1/plans/:id/reorder           → 200 plan view                 { items: [{ id, level, ord }] }
 *   POST   /v1/plans/:id/edges             → 200 plan view                 { from, to, kind }
 *   DELETE /v1/plans/:id/edges?from&to&kind → 200 plan view
 *   POST   /v1/plans/:id/approve | start | cancel | resume → 200 plan view
 *
 * Items, edges and order change only before Start (409 plan_locked), and
 * any such edit sends an approved plan back to draft. An edit is checked
 * against the plan as it would be afterwards, with the structural checks
 * Start runs; one that adds a problem is refused (422 plan_invalid) before
 * anything is written. Approve and Start run every Start check.
 */
import { errorResponse, issuesResponse, json, notFound, readJsonObject } from "../http";
import { isRecord } from "../net";
import {
  PlanNotRunnableError,
  countSources,
  issueMessages,
  overBudget,
  sourcelessNodes,
  unmakeableNodes,
  validatePlan,
  type PlanIssue,
} from "../studio/plan-runner";
import { planIssue } from "../studio/plan-issues";
import { isEdgeKind, isPlanFinished, type Plan, type PlanEdge, type PlanNode, type PlanNodePatch, type Settings } from "../studio/repositories";
import type { JsonValue, SourceLocator } from "../studio/types";
import type { EngineDeps } from "../wiring";
import {
  FieldError,
  boolean,
  clearableId,
  clearableNumber,
  clearableObject,
  clearableText,
  id,
  day,
  integer,
  longText,
  object,
  readFields,
  required,
  text,
} from "./fields";
import { charsIn } from "../chat/planning/sources";
import { movedDays, stageProgress } from "../studio/schedule";
import { ownedPlan, progressView } from "./plans";
import { deletePlan as deletePlanAndContents, planBusy } from "../studio/removal";
import { ownedProject } from "./projects";

const MAX_TITLE = 200;
const MAX_PROMPT = 20_000;
const MAX_SETTINGS_CHARS = 16_000;
const MAX_CONDITION_CHARS = 4_000;
const MAX_ITEM_SOURCES = 100;
const LOCATOR_KEYS = ["page", "endPage", "slide", "endSlide", "startMs", "endMs", "charStart", "charEnd"] as const;

// ── Plans in a project ──────────────────────────────────────────────────────

export async function listProjectPlans(request: Request, projectId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  const plans = await deps.repos.plans.listByProject(projectId);
  const views = [];
  for (const plan of plans) {
    const [nodes, results] = await Promise.all([deps.repos.plans.listNodes(plan.id), deps.repos.results.listByPlan(plan.id)]);
    const doneIds = new Set(results.filter((result) => result.doneAt).map((result) => result.nodeId));
    const countable = nodes.filter((node) => node.enabled && node.status !== "skipped");
    views.push({ ...planFields(plan), counts: { total: countable.length, done: countable.filter((node) => doneIds.has(node.id)).length } });
  }
  return json({ plans: views });
}

export async function createPlan(request: Request, projectId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedProject(request, projectId, deps);
  if ("response" in owned) return owned.response;
  const read = await readJsonObject(request);
  if ("response" in read) return read.response;
  const fields = readFields(() => ({ title: text(read.body, "title", MAX_TITLE), budgetUsd: clearableNumber(read.body, "budgetUsd", 0) }));
  if ("response" in fields) return fields.response;
  if (owned.project.archivedAt) return errorResponse("project_archived", "An archived project takes no new plans", 409);
  const { title, budgetUsd } = fields.value;
  const plan = await deps.repos.plans.create({
    ownerId: owned.ownerId,
    projectId,
    ...(title ? { title } : {}),
    ...(typeof budgetUsd === "number" ? { budgetUsd } : {}),
  });
  return json(await planView(deps, plan), 201);
}

export async function getPlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  return json(await planView(deps, owned.plan));
}

/**
 * The title and budget, in any status; an approval stands (Start checks
 * the budget again, and a running plan's next jobs are capped by it).
 */
export async function updatePlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const target = await ownedPlanWithBody(request, planId, deps);
  if ("response" in target) return target.response;
  const fields = readFields(() => {
    const title = "title" in target.body ? clearableText(target.body, "title", MAX_TITLE) : undefined;
    const budgetUsd = clearableNumber(target.body, "budgetUsd", 0);
    if (title === undefined && budgetUsd === undefined) throw new FieldError("Send title or budgetUsd; null clears either");
    return { title, budgetUsd };
  });
  if ("response" in fields) return fields.response;
  const { title, budgetUsd } = fields.value;
  if (title !== undefined) await deps.repos.plans.rename(planId, title);
  if (budgetUsd !== undefined) await deps.repos.plans.setBudget(planId, budgetUsd ?? undefined);
  return json(await planView(deps, (await deps.repos.plans.get(planId))!));
}

/**
 * A stage's label and the day it is meant for, either or both; null clears
 * one. Both are display and reminders only, like the title, so they may
 * change in any status.
 */
export async function setStage(request: Request, planId: string, rawLevel: string, deps: EngineDeps): Promise<Response> {
  const target = await ownedPlanWithBody(request, planId, deps);
  if ("response" in target) return target.response;
  const level = /^\d{1,9}$/.test(rawLevel) ? Number(rawLevel) : undefined;
  if (level === undefined) return errorResponse("invalid_request", "level must be a non-negative integer", 400);
  const fields = readFields(() => {
    if (!("label" in target.body) && !("dueOn" in target.body)) throw new FieldError("Send label or dueOn; null clears either");
    const label = "label" in target.body ? clearableText(target.body, "label", MAX_TITLE) : undefined;
    const dueOn = "dueOn" in target.body ? day(target.body, "dueOn", true) : undefined;
    return { label, dueOn };
  });
  if ("response" in fields) return fields.response;
  if (fields.value.label !== undefined) await deps.repos.plans.setStageLabel(planId, level, fields.value.label);
  if (fields.value.dueOn !== undefined) await deps.repos.plans.setStageDate(planId, level, fields.value.dueOn);
  return json(await planView(deps, target.plan));
}

/**
 * Moves missed days on: the first stage with something left whose day is
 * before `today` (the person's, from their app) moves to today, and the
 * later dated stages with something left move by as many days.
 */
export async function catchUpPlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const target = await ownedPlanWithBody(request, planId, deps);
  if ("response" in target) return target.response;
  const fields = readFields(() => ({ today: day(target.body, "today", false)! }));
  if ("response" in fields) return fields.response;
  const [nodes, results, dates] = await Promise.all([
    deps.repos.plans.listNodes(planId),
    deps.repos.results.listByPlan(planId),
    deps.repos.plans.listStageDates(planId),
  ]);
  const done = new Set(results.filter((result) => result.doneAt).map((result) => result.nodeId));
  const moved = movedDays(dates, (level) => stageProgress(nodes, done, level).left, fields.value.today);
  for (const [level, dueOn] of moved) await deps.repos.plans.setStageDate(planId, level, dueOn);
  return json(await planView(deps, target.plan));
}

// ── Items ───────────────────────────────────────────────────────────────────

interface ItemFields extends PlanNodePatch {
  sources?: Array<{ sourceId: string; range?: SourceLocator }>;
}

export async function addItem(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const target = await editablePlan(request, planId, deps);
  if ("response" in target) return target.response;
  const { plan, body } = target;
  const fields = readFields(() => {
    const read = itemFields(body);
    return { ...read, type: required(read.type, "type"), title: required(read.title, "title"), level: required(read.level, "level") };
  });
  if ("response" in fields) return fields.response;
  const item = fields.value;
  const { nodes, edges } = await graph(deps, plan.id);

  const ord = item.ord ?? Math.max(-1, ...nodes.filter((node) => node.level === item.level).map((node) => node.ord)) + 1;
  const settings = item.settings ?? {};
  const refused = (await checkFormat(deps, item.type, settings)) ?? (await checkSources(deps, plan, item.sources));
  if (refused) return refused;
  const candidate: PlanNode = {
    id: "(new item)",
    planId: plan.id,
    level: item.level,
    ord,
    type: item.type,
    title: item.title,
    prompt: item.prompt ?? "",
    settings,
    enabled: item.enabled ?? true,
    status: "pending",
    createdAt: "",
    updatedAt: "",
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ...(item.condition !== undefined && item.condition !== null ? { condition: item.condition } : {}),
  };
  const invalid = refuseNewIssues(deps, { nodes, edges }, { nodes: [...nodes, candidate], edges });
  if (invalid) return invalid;

  const node = await deps.repos.plans.addNode({
    planId: plan.id,
    level: item.level,
    ord,
    // An old id is accepted and stored as the format's current one.
    type: deps.registry.servedType(item.type),
    title: item.title,
    prompt: candidate.prompt,
    settings,
    enabled: candidate.enabled,
    ...(item.parentId ? { parentId: item.parentId } : {}),
    ...(candidate.condition !== undefined ? { condition: candidate.condition } : {}),
    // A cost the client sends is kept; otherwise the format prices the item.
    ...(await chosenOrEstimated(deps, item.estCostUsd, item.type, settings, item.sources ?? [])),
  });
  if (item.sources?.length) await deps.repos.plans.setNodeSources(node.id, item.sources);
  return json(await afterEdit(deps, plan), 201);
}

export async function updateItem(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const target = await editablePlan(request, planId, deps);
  if ("response" in target) return target.response;
  const { plan, body } = target;
  const fields = readFields(() => itemFields(body));
  if ("response" in fields) return fields.response;
  const { sources, ...patch } = fields.value;
  const { nodes, edges } = await graph(deps, plan.id);
  const node = nodes.find((candidate) => candidate.id === itemId);
  if (!node) return notFound("Item not found");

  if (patch.type !== undefined || patch.settings !== undefined) {
    const refused = await checkFormat(deps, patch.type ?? node.type, patch.settings ?? node.settings);
    if (refused) return refused;
  }
  const refused = await checkSources(deps, plan, sources);
  if (refused) return refused;
  const changed = applyPatch(node, patch);
  const invalid = refuseNewIssues(deps, { nodes, edges }, { nodes: nodes.map((candidate) => (candidate.id === itemId ? changed : candidate)), edges });
  if (invalid) return invalid;

  if (patch.type !== undefined) patch.type = deps.registry.servedType(patch.type);
  // What the item costs changes with its format, settings and sources; it is priced again unless the client set a cost.
  if (patch.estCostUsd === undefined && (patch.type !== undefined || patch.settings !== undefined || sources !== undefined)) {
    const uses = sources ?? (await deps.repos.plans.listNodeSources(itemId));
    patch.estCostUsd = (await estimateItem(deps, changed.type, changed.settings, uses)) ?? null;
  }
  if (Object.values(patch).some((value) => value !== undefined)) await deps.repos.plans.updateNode(itemId, patch);
  if (sources) await deps.repos.plans.setNodeSources(itemId, sources);
  return json(await afterEdit(deps, plan));
}

/** Its branches, edges, source links and recorded result go with it (0004/0005 cascades). */
export async function deleteItem(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const target = await editablePlan(request, planId, deps, false);
  if ("response" in target) return target.response;
  const node = await deps.repos.plans.getNode(itemId);
  if (!node || node.planId !== planId) return notFound("Item not found");
  await deps.repos.plans.deleteNode(itemId);
  return json(await afterEdit(deps, target.plan));
}

export async function reorderItems(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const target = await editablePlan(request, planId, deps);
  if ("response" in target) return target.response;
  const { plan, body } = target;
  const fields = readFields(() => {
    if (!Array.isArray(body.items) || body.items.length === 0) throw new FieldError("items must be a non-empty list of { id, level, ord }");
    return body.items.map((entry: unknown, index: number) => {
      if (!isRecord(entry)) throw new FieldError(`items[${index}] must be an object`);
      return { id: required(id(entry, "id"), `items[${index}].id`), level: required(integer(entry, "level", 0), `items[${index}].level`), ord: required(integer(entry, "ord", Number.MIN_SAFE_INTEGER), `items[${index}].ord`) };
    });
  });
  if ("response" in fields) return fields.response;
  const moves = new Map(fields.value.map((move) => [move.id, move]));
  if (moves.size !== fields.value.length) return errorResponse("invalid_request", "An item is listed twice", 400);
  const { nodes, edges } = await graph(deps, plan.id);
  const known = new Set(nodes.map((node) => node.id));
  const stranger = [...moves.keys()].find((itemId) => !known.has(itemId));
  if (stranger) return errorResponse("invalid_request", `${stranger} is not an item of this plan`, 400);
  const moved = nodes.map((node) => {
    const move = moves.get(node.id);
    return move ? { ...node, level: move.level, ord: move.ord } : node;
  });
  const invalid = refuseNewIssues(deps, { nodes, edges }, { nodes: moved, edges });
  if (invalid) return invalid;
  await deps.repos.plans.moveNodes(plan.id, [...moves.values()]);
  return json(await afterEdit(deps, plan));
}

// ── Edges ───────────────────────────────────────────────────────────────────

export async function addEdge(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const target = await editablePlan(request, planId, deps);
  if ("response" in target) return target.response;
  const { plan, body } = target;
  const fields = readFields(() => edgeFields((key) => body[key]));
  if ("response" in fields) return fields.response;
  const edge = fields.value;
  const { nodes, edges } = await graph(deps, plan.id);
  const known = new Set(nodes.map((node) => node.id));
  if (!known.has(edge.fromNode) || !known.has(edge.toNode)) return errorResponse("invalid_request", "from and to must be items of this plan", 400);
  const exists = edges.some((other) => other.fromNode === edge.fromNode && other.toNode === edge.toNode && other.kind === edge.kind);
  if (!exists) {
    const invalid = refuseNewIssues(deps, { nodes, edges }, { nodes, edges: [...edges, edge] });
    if (invalid) return invalid;
    await deps.repos.plans.addEdge(edge);
  }
  return json(await afterEdit(deps, plan, !exists));
}

export async function removeEdge(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const target = await editablePlan(request, planId, deps, false);
  if ("response" in target) return target.response;
  const params = new URL(request.url).searchParams;
  const fields = readFields(() => edgeFields((key) => params.get(key) ?? undefined));
  if ("response" in fields) return fields.response;
  const edge = fields.value;
  const { edges } = await graph(deps, planId);
  if (!edges.some((other) => other.fromNode === edge.fromNode && other.toNode === edge.toNode && other.kind === edge.kind)) {
    return notFound("Edge not found");
  }
  await deps.repos.plans.removeEdge(edge);
  return json(await afterEdit(deps, target.plan));
}

// ── Approve, Start, cancel ──────────────────────────────────────────────────

export async function approvePlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const approved = await approve(deps, owned.plan);
  if ("issues" in approved) return planIssuesResponse("The plan cannot be approved as it is", approved.issues);
  if ("refused" in approved) return errorResponse(approved.refused, approved.message, 409);
  return json(await planView(deps, approved.plan));
}

/**
 * Approves a draft plan after every Start check, as the approve route and
 * the chat's agent do. An approved plan is returned as it is.
 */
export async function approve(
  deps: EngineDeps,
  plan: Plan,
): Promise<{ plan: Plan } | { issues: PlanIssue[] } | { refused: "plan_locked" | "plan_finished"; message: string }> {
  if (plan.kickedOffAt) return { refused: "plan_locked", message: "The plan has been started" };
  if (plan.status === "discarded") return { refused: "plan_finished", message: "The plan was discarded" };
  if (plan.status === "approved") return { plan };
  const { nodes, edges } = await graph(deps, plan.id);
  // An item priced before its sources were read gets its estimate now, so the budget check has one.
  await fillEstimates(deps, nodes, true);
  const issues = startIssues(deps, plan, nodes, edges, await countSources(deps.repos, nodes));
  if (!nodes.some((node) => node.enabled)) issues.push(planIssue("no_enabled_items"));
  if (issues.length > 0) return { issues };
  const approved = (await deps.repos.plans.transition(plan.id, ["draft"], "approved"))!;
  // A cancel or Start that landed while the checks ran wins.
  if (approved.status === "discarded") return { refused: "plan_finished", message: "The plan was discarded" };
  if (approved.status !== "approved") return { refused: "plan_locked", message: "The plan has been started" };
  return { plan: approved };
}

/**
 * Hands an approved plan to the runner. Whatever the runner refuses at
 * Start (its checks, and a budget once one exists) comes back as
 * PlanNotRunnableError and is answered 422 with its issues.
 */
export async function startPlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const { plan } = owned;
  if (!deps.plans) return errorResponse("plans_unavailable", "Plans cannot be started on this Worker", 503);
  if (plan.status === "draft") return errorResponse("plan_not_approved", "Approve the plan before Start", 409);
  if (isPlanFinished(plan.status)) return errorResponse("plan_finished", `The plan is ${plan.status}`, 409);
  try {
    await deps.plans.kickOff(plan.id);
  } catch (error) {
    if (error instanceof PlanNotRunnableError) {
      // An edit sent it back to draft, or a cancel landed, after it was read here.
      const now = await deps.repos.plans.get(plan.id);
      if (now?.status === "draft") return errorResponse("plan_not_approved", "The plan changed since it was approved; approve it again", 409);
      if (now && isPlanFinished(now.status)) return errorResponse("plan_finished", `The plan is ${now.status}`, 409);
      return planIssuesResponse("The plan cannot start", error.details);
    }
    throw error;
  }
  return json(await planView(deps, (await deps.repos.plans.get(plan.id))!));
}

export async function cancelPlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const { plan } = owned;
  if (!deps.plans) return errorResponse("plans_unavailable", "Plans cannot be cancelled on this Worker", 503);
  if (isPlanFinished(plan.status)) return errorResponse("plan_finished", `The plan is ${plan.status}`, 409);
  await deps.plans.cancel(plan.id);
  return json(await planView(deps, (await deps.repos.plans.get(plan.id))!));
}

/**
 * Deletes a plan for good with everything it made (`DELETE /v1/plans/:id`;
 * studio/removal.ts). Refused while it is still being made: stop it first.
 */
export async function deletePlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const { plan } = owned;
  if (await planBusy(deps, plan)) return errorResponse("plan_running", "This is still being made; stop it first", 409);
  const deleted = await deletePlanAndContents(deps, plan);
  return json({ planId: plan.id, deleted });
}

/**
 * Starts a stopped plan again from what is not made yet
 * (`POST /v1/plans/:id/resume`). A running plan is answered as it is.
 */
export async function resumePlan(request: Request, planId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const { plan } = owned;
  if (!deps.plans) return errorResponse("plans_unavailable", "Plans cannot run on this Worker", 503);
  if (plan.status !== "cancelled" && plan.status !== "running") {
    return errorResponse("plan_not_stopped", `Only a stopped plan can be started again; this one is ${plan.status}`, 409);
  }
  try {
    await deps.plans.resume(plan.id);
  } catch (error) {
    if (!(error instanceof PlanNotRunnableError)) throw error;
    const now = await deps.repos.plans.get(plan.id);
    if (now && now.status !== "cancelled" && now.status !== "running") {
      return errorResponse("plan_not_stopped", `Only a stopped plan can be started again; this one is ${now.status}`, 409);
    }
    return planIssuesResponse("The plan cannot start again", error.details);
  }
  return json(await planView(deps, (await deps.repos.plans.get(plan.id))!));
}

/**
 * Stops one item of a running plan while the rest goes on
 * (`POST /v1/plans/:id/items/:itemId/stop`): its job, queued, running or
 * waiting, is cancelled with what its maker saved kept, and the item is
 * `cancelled`. What depends on it waits as on a failed item, without failing
 * the plan; `.../retry` carries it on. `404` for an unknown plan or item,
 * `409 item_not_running` when that item is not being made.
 */
export async function stopItem(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const { plan } = owned;
  if (!deps.plans) return errorResponse("plans_unavailable", "Plans cannot run on this Worker", 503);
  const node = await deps.repos.plans.getNode(itemId);
  if (!node || node.planId !== plan.id) return notFound("Item not found");
  if (plan.status !== "running" || (node.status !== "queued" && node.status !== "running")) {
    return errorResponse("item_not_running", `This item is not being made (it is ${node.status}, the plan ${plan.status})`, 409);
  }
  try {
    await deps.plans.stopItem(plan.id, node.id);
  } catch (error) {
    if (error instanceof PlanNotRunnableError) return issuesResponse("item_not_running", "This item is not being made", 409, error.issues, error.details);
    throw error;
  }
  return json(await planView(deps, (await deps.repos.plans.get(plan.id))!));
}

/**
 * Makes a failed item of a running or failed plan again, or carries on a
 * stopped one, also in a plan that stopped with it
 * (`POST /v1/plans/:id/items/:itemId/retry`). With `{ choice }`, the way on
 * its job offers while it waits, or after it waited (`job.choice` in the
 * item's view, such as finishing a video without sound): taken, and the
 * item carried on that way, waiting or failed.
 */
export async function retryItem(request: Request, planId: string, itemId: string, deps: EngineDeps): Promise<Response> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned.response;
  const { plan } = owned;
  if (!deps.plans) return errorResponse("plans_unavailable", "Plans cannot run on this Worker", 503);
  const raw = await request.text().catch(() => "");
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return errorResponse("invalid_request", "The body must be JSON", 400);
  }
  const choice = isRecord(body) && typeof body.choice === "string" && body.choice.trim() ? body.choice.trim() : undefined;
  const node = await deps.repos.plans.getNode(itemId);
  if (!node || node.planId !== plan.id) return notFound("Item not found");
  // A stopped item (`.../stop`) goes on from what it saved, also in a plan that stopped with it.
  const stopped = node.status === "cancelled" && !choice;
  if (plan.status !== "running" && plan.status !== "failed" && !(stopped && plan.status === "cancelled")) return errorResponse("plan_not_running", `The plan is ${plan.status}`, 409);
  if (node.status !== "failed" && !stopped && !choice) return errorResponse("item_not_failed", "Only a failed or stopped item can be made again", 409);
  try {
    await deps.plans.retryItem(plan.id, node.id, choice);
  } catch (error) {
    if (error instanceof PlanNotRunnableError) return issuesResponse("item_not_failed", "The item cannot be made again", 409, error.issues, error.details);
    throw error;
  }
  return json(await planView(deps, (await deps.repos.plans.get(plan.id))!));
}

// ── The plan view ───────────────────────────────────────────────────────────

/** What every plan read and edit returns (docs/api.md, "Plan view"). */
export async function planView(deps: EngineDeps, plan: Plan): Promise<Record<string, unknown>> {
  const progress = (await progressView(deps, plan)) as { stages: unknown; items: Array<{ id: string }>; counts: unknown };
  const { nodes, edges } = await graph(deps, plan.id);
  if (!plan.kickedOffAt) await fillEstimates(deps, nodes, false);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const items = [];
  const sourceCounts = new Map<string, number>();
  for (const state of progress.items) {
    const node = byId.get(state.id)!;
    const sources = await deps.repos.plans.listNodeSources(node.id);
    sourceCounts.set(node.id, sources.length);
    const plannedAs = plannedWords(deps, node.type, node.settings);
    const notices = await noticeWords(deps, node, (state as { outputId?: string }).outputId);
    const made = await madeWords(deps, node.type, node.settings, (state as { outputId?: string }).outputId);
    items.push({
      ...state,
      prompt: node.prompt,
      settings: node.settings,
      ...(plannedAs.length ? { plannedAs } : {}),
      ...(notices.length ? { notices } : {}),
      ...made,
      ...(node.condition !== undefined ? { condition: node.condition } : {}),
      ...(node.estCostUsd !== undefined ? { estCostUsd: node.estCostUsd } : {}),
      sources: sources.map((source) => ({ sourceId: source.sourceId, ...(source.range ? { range: source.range } : {}) })),
    });
  }
  const estimate = nodes.filter((node) => node.enabled && node.estCostUsd !== undefined).reduce((sum, node) => sum + node.estCostUsd!, 0);
  const issues = plan.kickedOffAt || plan.status === "discarded" ? [] : startIssues(deps, plan, nodes, edges, sourceCounts);
  return {
    plan: planFields(plan),
    stages: progress.stages,
    items,
    edges: edges.map((edge) => ({ from: edge.fromNode, to: edge.toNode, kind: edge.kind })),
    counts: progress.counts,
    estimateUsd: Math.round(estimate * 1_000_000) / 1_000_000,
    issues: issueMessages(issues),
    issueDetails: issues,
  };
}

/** What an item will be, in its format's own few words (`FormatDefinition.describe`); empty when the format has none or its settings do not parse. */
function plannedWords(deps: EngineDeps, type: string, settings: unknown): string[] {
  const definition = deps.registry.get(type);
  const parsed = definition?.parseSettings(settings);
  return definition?.describe && parsed?.ok ? definition.describe(parsed.settings) : [];
}

/**
 * What a person should know about an item: before it is made, what it will be like (`FormatDefinition.itemNotices`,
 * from what its maker says now); once made, what it is like (`madeNotices`, from the thing itself). Quiet lines.
 */
async function noticeWords(deps: EngineDeps, node: PlanNode, outputId: string | undefined): Promise<string[]> {
  const definition = deps.registry.get(node.type);
  if (!definition) return [];
  if (outputId) {
    if (!definition.madeNotices) return [];
    const output = await deps.repos.outputs.get(outputId);
    if (!output) return [];
    const payload = definition.upgrade?.(output.payload, output.schemaVersion)?.payload ?? output.payload;
    return definition.madeNotices(payload as never);
  }
  if (node.status === "failed" || node.status === "skipped") return [];
  const parsed = definition.parseSettings(node.settings);
  return definition.itemNotices && parsed.ok ? definition.itemNotices(parsed.settings) : [];
}

/**
 * What a made item is, in its format's own few words (`FormatDefinition.describeMade`), and its notes: the maker's
 * note on why its size differs from the plan's, and what Open Sourcebook's checks found in a thing kept over them (a video's
 * `notes`). Empty when nothing is made or neither says anything.
 */
async function madeWords(deps: EngineDeps, type: string, settings: unknown, outputId: string | undefined): Promise<{ madeAs?: string[]; madeNote?: string }> {
  if (!outputId) return {};
  const definition = deps.registry.get(type);
  if (!definition) return {};
  const parsed = definition.parseSettings(settings);
  const output = await deps.repos.outputs.get(outputId);
  if (!output) return {};
  const payload = definition.upgrade?.(output.payload, output.schemaVersion)?.payload ?? output.payload;
  const madeAs = definition.describeMade && parsed.ok ? definition.describeMade(payload as never, parsed.settings) : [];
  // The maker's note on its size, then what Open Sourcebook's checks found in a thing kept over them (a video's `notes`).
  const fields = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as { sizeNote?: unknown; notes?: unknown }) : {};
  const notes = [fields.sizeNote, ...(Array.isArray(fields.notes) ? fields.notes : [])].filter((line): line is string => typeof line === "string" && line.trim() !== "").map((line) => line.trim());
  return { ...(madeAs.length ? { madeAs } : {}), ...(notes.length ? { madeNote: notes.join(" ") } : {}) };
}

/** A plan on the wire: no owner hash; the chat that made it as `chatId`. */
function planFields(plan: Plan): Record<string, unknown> {
  const { ownerId: _owner, sessionId, ...fields } = plan;
  return { ...fields, ...(sessionId ? { chatId: sessionId } : {}) };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function graph(deps: EngineDeps, planId: string): Promise<{ nodes: PlanNode[]; edges: PlanEdge[] }> {
  const [nodes, edges] = await Promise.all([deps.repos.plans.listNodes(planId), deps.repos.plans.listEdges(planId)]);
  return { nodes, edges };
}

/** The runner's checks; the same functions with the built-in conditions when no runner is wired. */
function structuralIssues(deps: EngineDeps, nodes: PlanNode[], edges: PlanEdge[]): PlanIssue[] {
  return deps.plans ? deps.plans.structuralIssues(nodes, edges) : validatePlan(nodes, edges);
}

function startIssues(deps: EngineDeps, plan: Plan, nodes: PlanNode[], edges: PlanEdge[], sourceCounts: Map<string, number>): PlanIssue[] {
  return deps.plans
    ? deps.plans.startIssues(plan, nodes, edges, sourceCounts)
    : [...validatePlan(nodes, edges), ...unmakeableNodes(nodes, deps.registry), ...sourcelessNodes(nodes, sourceCounts), ...overBudget(plan, nodes)];
}

/** 422 when `after` has a structural problem `before` did not. */
function refuseNewIssues(
  deps: EngineDeps,
  before: { nodes: PlanNode[]; edges: PlanEdge[] },
  after: { nodes: PlanNode[]; edges: PlanEdge[] },
): Response | undefined {
  const existing = new Set(issueMessages(structuralIssues(deps, before.nodes, before.edges)));
  const added = structuralIssues(deps, after.nodes, after.edges).filter((issue) => !existing.has(issue.message));
  return added.length > 0 ? planIssuesResponse("That edit would make the plan unable to start", added) : undefined;
}

/** 422 plan_invalid with the issues as messages and as `{ message, itemId? }`. */
function planIssuesResponse(message: string, issues: PlanIssue[]): Response {
  return issuesResponse("plan_invalid", message, 422, issueMessages(issues), issues);
}

/** Owner, a JSON body, and a plan not yet started. */
async function editablePlan(
  request: Request,
  planId: string,
  deps: EngineDeps,
  withBody = true,
): Promise<{ plan: Plan; body: Record<string, unknown> } | { response: Response }> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned;
  if (owned.plan.kickedOffAt) return { response: errorResponse("plan_locked", "A started plan's items cannot change", 409) };
  if (owned.plan.status === "discarded") return { response: errorResponse("plan_finished", "The plan was discarded", 409) };
  if (!withBody) return { plan: owned.plan, body: {} };
  const read = await readJsonObject(request);
  if ("response" in read) return read;
  return { plan: owned.plan, body: read.body };
}

async function ownedPlanWithBody(request: Request, planId: string, deps: EngineDeps): Promise<{ plan: Plan; body: Record<string, unknown> } | { response: Response }> {
  const owned = await ownedPlan(request, planId, deps);
  if ("response" in owned) return owned;
  const read = await readJsonObject(request);
  if ("response" in read) return read;
  return { plan: owned.plan, body: read.body };
}

/** An approved plan goes back to draft after any structural edit, then the view. */
async function afterEdit(deps: EngineDeps, plan: Plan, changed = true): Promise<Record<string, unknown>> {
  // Decided on the stored status, not `plan`: an approve may have landed since it was read.
  const current = changed ? await deps.repos.plans.transition(plan.id, ["approved"], "draft") : await deps.repos.plans.get(plan.id);
  return planView(deps, current!);
}

function itemFields(body: Record<string, unknown>): ItemFields {
  const fields: ItemFields = {};
  const type = body.type;
  if (type !== undefined) {
    if (typeof type !== "string" || !type.trim()) throw new FieldError("type must be a format id");
    fields.type = type.trim();
  }
  const title = text(body, "title", MAX_TITLE);
  if (title !== undefined) fields.title = title;
  const level = integer(body, "level", 0);
  if (level !== undefined) fields.level = level;
  const ord = integer(body, "ord", Number.MIN_SAFE_INTEGER);
  if (ord !== undefined) fields.ord = ord;
  const prompt = longText(body, "prompt", MAX_PROMPT);
  if (prompt !== undefined) fields.prompt = prompt;
  const settings = object(body, "settings", MAX_SETTINGS_CHARS);
  if (settings !== undefined) fields.settings = settings as Settings;
  const parentId = clearableId(body, "parentId");
  if (parentId !== undefined) fields.parentId = parentId;
  const condition = clearableObject(body, "condition", MAX_CONDITION_CHARS);
  if (condition !== undefined) fields.condition = condition as JsonValue | null;
  const enabled = boolean(body, "enabled");
  if (enabled !== undefined) fields.enabled = enabled;
  const estCostUsd = clearableNumber(body, "estCostUsd", 0);
  if (estCostUsd !== undefined) fields.estCostUsd = estCostUsd;
  if (body.sources !== undefined) fields.sources = itemSources(body.sources);
  return fields;
}

function itemSources(value: unknown): Array<{ sourceId: string; range?: SourceLocator }> {
  if (!Array.isArray(value)) throw new FieldError("sources must be a list of { sourceId, range? }");
  if (value.length > MAX_ITEM_SOURCES) throw new FieldError(`An item has at most ${MAX_ITEM_SOURCES} sources`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new FieldError(`sources[${index}] must be an object`);
    const sourceId = required(id(entry, "sourceId"), `sources[${index}].sourceId`);
    if (seen.has(sourceId)) throw new FieldError(`sources lists ${sourceId} twice`);
    seen.add(sourceId);
    if (entry.range === undefined) return { sourceId };
    return { sourceId, range: locator(entry.range, `sources[${index}].range`) };
  });
}

function locator(value: unknown, path: string): SourceLocator {
  if (!isRecord(value)) throw new FieldError(`${path} must be an object`);
  const range: SourceLocator = {};
  for (const key of LOCATOR_KEYS) {
    const part = value[key];
    if (part === undefined) continue;
    if (typeof part !== "number" || !Number.isInteger(part) || part < 0) throw new FieldError(`${path}.${key} must be a non-negative integer`);
    range[key] = part;
  }
  if (value.cell !== undefined) {
    if (typeof value.cell !== "string" || !value.cell.trim() || value.cell.length > 50) throw new FieldError(`${path}.cell must be short text`);
    range.cell = value.cell.trim();
  }
  return range;
}

function edgeFields(get: (key: string) => unknown): PlanEdge {
  const from = get("from");
  const to = get("to");
  const kind = get("kind");
  if (typeof from !== "string" || !from || typeof to !== "string" || !to) throw new FieldError("from and to must be item ids");
  if (from === to) throw new FieldError("An item cannot depend on itself");
  if (!isEdgeKind(kind)) throw new FieldError("kind must be lower snake or camel case, e.g. assumes or fix_of");
  return { fromNode: from, toNode: to, kind };
}

/** 400 when no format declares `type`, or its engine's settings parser refuses `settings`. */
/**
 * What an item will cost, from its format's `estimateCost` for its settings
 * and the text of its sources. Undefined when the format has no engine, its
 * model has no price, or a source has not been read yet: an unknown cost is
 * never shown as $0.
 */
async function estimateItem(
  deps: EngineDeps,
  type: string,
  settings: Settings,
  uses: Array<{ sourceId: string; range?: SourceLocator }>,
): Promise<number | undefined> {
  const definition = deps.registry.get(type);
  const parsed = definition?.parseSettings(settings);
  if (!definition || !parsed?.ok) return undefined;
  let sourceChars = 0;
  for (const use of uses) {
    const source = await deps.repos.sources.get(use.sourceId);
    const extraction = source ? await deps.repos.sources.getExtraction(source.contentHash) : undefined;
    if (!source || extraction?.status !== "ready" || !extraction.envelope) return undefined;
    const chunks = await deps.repos.sources.listChunks(source.contentHash);
    sourceChars += charsIn({ sourceId: source.id, envelope: extraction.envelope, chunks }, use.range);
  }
  return definition.estimateCost({ settings: parsed.settings, sourceChars, sourceCount: uses.length }).usd;
}

async function chosenOrEstimated(
  deps: EngineDeps,
  chosen: number | null | undefined,
  type: string,
  settings: Settings,
  uses: Array<{ sourceId: string; range?: SourceLocator }>,
): Promise<{ estCostUsd?: number }> {
  const value = typeof chosen === "number" ? chosen : await estimateItem(deps, type, settings, uses);
  return value === undefined ? {} : { estCostUsd: value };
}

/** Items with no estimate are priced; `persist` writes the new ones to the items. */
async function fillEstimates(deps: EngineDeps, nodes: PlanNode[], persist: boolean): Promise<void> {
  for (const node of nodes) {
    if (node.estCostUsd !== undefined) continue;
    const value = await estimateItem(deps, node.type, node.settings, await deps.repos.plans.listNodeSources(node.id));
    if (value === undefined) continue;
    node.estCostUsd = value;
    if (persist) await deps.repos.plans.updateNode(node.id, { estCostUsd: value });
  }
}

async function checkFormat(deps: EngineDeps, type: string, settings: Settings): Promise<Response | undefined> {
  if (!deps.registry.has(type)) return errorResponse("unknown_format", `No format "${type}" is declared (GET /v1/formats lists them)`, 400);
  const definition = deps.registry.get(type);
  if (!definition) return undefined;
  const parsed = definition.parseSettings(settings);
  if (parsed.ok) return undefined;
  return issuesResponse("invalid_settings", `Settings are not valid for ${type}`, 400, parsed.issues);
}

/** 400 unless every source is the caller's and in the plan's project. */
async function checkSources(deps: EngineDeps, plan: Plan, sources: ItemFields["sources"]): Promise<Response | undefined> {
  for (const { sourceId } of sources ?? []) {
    const source = await deps.repos.sources.get(sourceId);
    if (!source || source.ownerId !== plan.ownerId || source.projectId !== plan.projectId || source.removedAt) {
      return errorResponse("source_not_in_project", `Source ${sourceId} is not in this plan's project`, 400);
    }
  }
  return undefined;
}

function applyPatch(node: PlanNode, patch: PlanNodePatch): PlanNode {
  const next: PlanNode = { ...node };
  for (const [key, value] of Object.entries(patch) as Array<[keyof PlanNodePatch, unknown]>) {
    if (value === undefined) continue;
    if (value === null) delete (next as unknown as Record<string, unknown>)[key];
    else (next as unknown as Record<string, unknown>)[key] = value;
  }
  return next;
}
