/**
 * Writes a checked draft through the plan repository: a new plan whole, or
 * an edit as the difference between the plan as read and the draft. Only
 * drafts that passed `checkDraft` reach here.
 */
import type { FormatRegistry } from "../../studio/registry";
import type { Plan, PlanNodePatch, StudioRepositories } from "../../studio/repositories";
import type { DraftItem, DraftPlan, DraftSource } from "./draft";

/** Creates the plan as a draft in the chat. A failure part way removes what was written. */
export async function writeNewPlan(
  repos: StudioRepositories,
  registry: FormatRegistry,
  owner: { ownerId: string; projectId: string; sessionId?: string },
  draft: DraftPlan,
  /** A plan for one thing made at once, and the one it is a remake of. */
  extra: { direct?: boolean; supersedesPlanId?: string } = {},
): Promise<Plan> {
  const plan = await repos.plans.create({
    ...owner,
    ...(extra.direct ? { direct: true } : {}),
    ...(extra.supersedesPlanId ? { supersedesPlanId: extra.supersedesPlanId } : {}),
    ...(draft.title ? { title: draft.title } : {}),
    ...(draft.budgetUsd !== undefined ? { budgetUsd: draft.budgetUsd } : {}),
  });
  try {
    for (const [level, label] of draft.labels) await repos.plans.setStageLabel(plan.id, level, label);
    for (const [level, dueOn] of draft.dates ?? []) await repos.plans.setStageDate(plan.id, level, dueOn);
    const ids = await addItems(repos, registry, plan.id, draft.items, new Map());
    for (const edge of draft.edges) await repos.plans.addEdge({ fromNode: ids.get(edge.from)!, toNode: ids.get(edge.to)!, kind: edge.kind });
    return plan;
  } catch (error) {
    await repos.plans.delete(plan.id);
    throw error;
  }
}

/** Writes what changed between `before` (the plan as read) and `after`. Answers whether anything did. */
export async function writeEdit(repos: StudioRepositories, registry: FormatRegistry, plan: Plan, before: DraftPlan, after: DraftPlan): Promise<boolean> {
  let changed = false;
  const was = new Map(before.items.map((item) => [item.key, item]));
  const stays = new Set(after.items.map((item) => item.key));

  if ((after.title ?? null) !== (before.title ?? null)) await repos.plans.rename(plan.id, after.title ?? null);
  if (after.budgetUsd !== before.budgetUsd) await repos.plans.setBudget(plan.id, after.budgetUsd);

  // Deleting an item deletes its branches in the database too.
  for (const item of before.items) {
    if (!stays.has(item.key) && (await repos.plans.getNode(item.key))) {
      await repos.plans.deleteNode(item.key);
      changed = true;
    }
  }

  const ids = new Map(after.items.filter((item) => item.existing).map((item) => [item.key, item.key]));
  const added = after.items.filter((item) => !item.existing);
  if (added.length > 0) {
    await addItems(repos, registry, plan.id, added, ids);
    changed = true;
  }

  const moves: Array<{ id: string; level: number; ord: number }> = [];
  for (const item of after.items.filter((candidate) => candidate.existing)) {
    const old = was.get(item.key)!;
    if (old.level !== item.level || old.ord !== item.ord) moves.push({ id: item.key, level: item.level, ord: item.ord });
    const patch = patchOf(old, item, ids, registry);
    if (Object.keys(patch).length > 0) {
      await repos.plans.updateNode(item.key, patch);
      changed = true;
    }
    if (JSON.stringify(old.sources) !== JSON.stringify(item.sources)) {
      await repos.plans.setNodeSources(item.key, item.sources);
      changed = true;
    }
  }
  if (moves.length > 0) {
    await repos.plans.moveNodes(plan.id, moves);
    changed = true;
  }

  const key = (edge: { from: string; to: string; kind: string }) => `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
  const resolved = after.edges.map((edge) => ({ from: ids.get(edge.from) ?? edge.from, to: ids.get(edge.to) ?? edge.to, kind: edge.kind }));
  const oldEdges = new Set(before.edges.filter((edge) => stays.has(edge.from) && stays.has(edge.to)).map(key));
  const newEdges = new Set(resolved.map(key));
  for (const edge of before.edges) {
    if (stays.has(edge.from) && stays.has(edge.to) && !newEdges.has(key(edge))) {
      await repos.plans.removeEdge({ fromNode: edge.from, toNode: edge.to, kind: edge.kind });
      changed = true;
    }
  }
  for (const edge of resolved) {
    if (!oldEdges.has(key(edge))) {
      await repos.plans.addEdge({ fromNode: edge.from, toNode: edge.to, kind: edge.kind });
      changed = true;
    }
  }

  for (const level of new Set([...before.labels.keys(), ...after.labels.keys()])) {
    const label = after.labels.get(level) ?? null;
    if (label !== (before.labels.get(level) ?? null)) await repos.plans.setStageLabel(plan.id, level, label);
  }
  const [datesBefore, datesAfter] = [before.dates ?? new Map<number, string>(), after.dates ?? new Map<number, string>()];
  for (const level of new Set([...datesBefore.keys(), ...datesAfter.keys()])) {
    const dueOn = datesAfter.get(level) ?? null;
    if (dueOn !== (datesBefore.get(level) ?? null)) await repos.plans.setStageDate(plan.id, level, dueOn);
  }

  // Any change to items, edges or order sends an approved plan back to draft (docs/api.md).
  if (changed) await repos.plans.transition(plan.id, ["approved"], "draft");
  return changed;
}

/** Adds items in run order, so a parent exists before its branch. `ids` maps keys to stored ids and grows. */
async function addItems(repos: StudioRepositories, registry: FormatRegistry, planId: string, items: DraftItem[], ids: Map<string, string>): Promise<Map<string, string>> {
  const pending = [...items].sort((a, b) => a.level - b.level || a.ord - b.ord);
  for (const item of pending) {
    const node = await repos.plans.addNode({
      planId,
      level: item.level,
      ord: item.ord,
      type: registry.servedType(item.type),
      title: item.title,
      prompt: item.prompt,
      settings: item.settings,
      enabled: item.enabled,
      ...(item.parentKey ? { parentId: ids.get(item.parentKey) ?? item.parentKey } : {}),
      ...(item.condition !== undefined ? { condition: item.condition } : {}),
      ...(item.estCostUsd !== undefined ? { estCostUsd: item.estCostUsd } : {}),
    });
    ids.set(item.key, node.id);
    if (item.sources.length > 0) await repos.plans.setNodeSources(node.id, item.sources as DraftSource[]);
  }
  return ids;
}

function patchOf(old: DraftItem, item: DraftItem, ids: Map<string, string>, registry: FormatRegistry): PlanNodePatch {
  const patch: PlanNodePatch = {};
  if (old.type !== item.type) patch.type = registry.servedType(item.type);
  if (old.title !== item.title) patch.title = item.title;
  if (old.prompt !== item.prompt) patch.prompt = item.prompt;
  if (JSON.stringify(old.settings) !== JSON.stringify(item.settings)) patch.settings = item.settings;
  if (old.enabled !== item.enabled) patch.enabled = item.enabled;
  const parent = item.parentKey ? (ids.get(item.parentKey) ?? item.parentKey) : undefined;
  if ((old.parentKey ?? null) !== (parent ?? null)) patch.parentId = parent ?? null;
  if (JSON.stringify(old.condition ?? null) !== JSON.stringify(item.condition ?? null)) patch.condition = item.condition ?? null;
  if ((old.estCostUsd ?? null) !== (item.estCostUsd ?? null)) patch.estCostUsd = item.estCostUsd ?? null;
  return patch;
}
