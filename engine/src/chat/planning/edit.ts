/**
 * Changing a plan from the chat. The model sees the plan as it is (items
 * as I1, I2, ..., stages by number) and answers with changes to named
 * items and stages, never a whole plan. The changes are applied to the
 * plan as it is when they come back, not as it was shown: an item the
 * person edited by hand meanwhile (its `updatedAt` moved) or deleted is
 * left as the person has it, and the reply says so. Everything not named
 * stays as it is. An item the person made or changed by hand since the
 * chat last wrote the plan is theirs: an op on it holds only when the
 * person's message names it.
 */
import { isRecord } from "../../net";
import { isDay } from "../../studio/days";
import type { Plan, StudioRepositories } from "../../studio/repositories";
import { edgeKind, settingsOf, type DraftItem, type DraftPlan } from "./draft";
import { applyLinks, readBranch, readItem, readSources, type ItemLinks } from "./read";
import type { SourceMap } from "./sources";

/** A plan read for editing, with what the model is shown and what it may refer to. */
export interface PlanSnapshot {
  plan: Plan;
  draft: DraftPlan;
  /** Item id → `updatedAt` when read. */
  stamps: Map<string, string>;
  /** "I1" → item id. */
  itemRefs: Map<string, string>;
  /** Stage number → level. */
  stageRefs: Map<number, number>;
}

export async function readPlan(repos: StudioRepositories, plan: Plan): Promise<PlanSnapshot> {
  const [nodes, edges, stages, dates] = await Promise.all([
    repos.plans.listNodes(plan.id),
    repos.plans.listEdges(plan.id),
    repos.plans.listStages(plan.id),
    repos.plans.listStageDates(plan.id),
  ]);
  const items: DraftItem[] = [];
  for (const node of nodes) {
    const sources = await repos.plans.listNodeSources(node.id);
    items.push({
      key: node.id,
      existing: true,
      level: node.level,
      ord: node.ord,
      type: node.type,
      title: node.title,
      prompt: node.prompt,
      settings: node.settings,
      sources: sources.map((source) => ({ sourceId: source.sourceId, ...(source.range ? { range: source.range } : {}) })),
      enabled: node.enabled,
      ...(node.parentId ? { parentKey: node.parentId } : {}),
      ...(node.condition !== undefined ? { condition: node.condition } : {}),
      ...(node.estCostUsd !== undefined ? { estCostUsd: node.estCostUsd } : {}),
    });
  }
  const draft: DraftPlan = {
    ...(plan.title ? { title: plan.title } : {}),
    ...(plan.budgetUsd !== undefined ? { budgetUsd: plan.budgetUsd } : {}),
    labels: new Map(stages.map((stage) => [stage.level, stage.label])),
    dates: new Map(dates.map((date) => [date.level, date.dueOn])),
    items,
    edges: edges.map((edge) => ({ from: edge.fromNode, to: edge.toNode, kind: edge.kind })),
  };
  const levels = [...new Set(items.map((item) => item.level))].sort((a, b) => a - b);
  return {
    plan,
    draft,
    stamps: new Map(nodes.map((node) => [node.id, node.updatedAt])),
    itemRefs: new Map(items.map((item, index) => [`I${index + 1}`, item.key])),
    stageRefs: new Map(levels.map((level, index) => [index + 1, level])),
  };
}

/** What of a plan `renderPlan` shows. */
export interface RenderOptions {
  /** Leave briefs out (the planner just wrote them), for a short answer about a big plan. */
  briefs?: boolean;
  /** Only these stage numbers (as the plan numbers them, from 1); all when absent. */
  stages?: ReadonlySet<number>;
  /** Only these items, by id; all when absent. */
  items?: ReadonlySet<string>;
}

/** The plan as the model is shown it. */
export function renderPlan(snapshot: PlanSnapshot, map: SourceMap, byHand: ReadonlySet<string> = new Set(), options: RenderOptions = {}): string {
  const { draft } = snapshot;
  const refOf = new Map([...snapshot.itemRefs].map(([ref, id]) => [id, ref]));
  const lines = [`Plan "${draft.title ?? "Untitled plan"}", ${draft.budgetUsd !== undefined ? `budget $${draft.budgetUsd}` : "no budget"}.`];
  for (const [number, level] of snapshot.stageRefs) {
    if (options.stages && !options.stages.has(number)) continue;
    const items = draft.items.filter((candidate) => candidate.level === level && (!options.items || options.items.has(candidate.key)));
    if (items.length === 0) continue;
    const label = draft.labels.get(level);
    const dueOn = draft.dates?.get(level);
    lines.push(`Stage ${number}${label ? ` "${label}"` : ""}${dueOn ? `, for ${dueOn}` : ""}:`);
    for (const item of items) {
      const parts = [
        `  ${refOf.get(item.key)} [${item.type}] "${item.title}"${item.enabled ? "" : " (left out)"}${byHand.has(item.key) ? " (made or changed by the person by hand: leave it unless they ask about it)" : ""}`,
      ];
      if (item.prompt && options.briefs !== false) parts.push(`brief: ${item.prompt}`);
      if (Object.keys(item.settings).length > 0) parts.push(`settings: ${JSON.stringify(item.settings)}`);
      parts.push(`sources: ${item.sources.map((source) => map.passagesOf(source.sourceId, source.range)).join(", ") || "none"}`);
      if (item.parentKey) parts.push(`branch of ${refOf.get(item.parentKey) ?? "?"} when ${JSON.stringify(item.condition)}`);
      const edges = draft.edges.filter((edge) => edge.to === item.key).map((edge) => `${edge.kind} ${refOf.get(edge.from) ?? "?"}`);
      if (edges.length > 0) parts.push(`links: ${edges.join(", ")}`);
      lines.push(parts.join("; "));
    }
  }
  return lines.join("\n");
}

export interface AppliedEdit {
  draft: DraftPlan;
  /** Keys of items added or changed: their format, settings and sources are checked and priced again. */
  touched: Set<string>;
  /**
   * In words, what changed, one line per change: the plan card lists these,
   * so the reply above it does not repeat them.
   */
  changes: string[];
  /** In words, what was left as the person had it. */
  kept: string[];
  issues: string[];
}

interface Stage {
  /** The level it had, for a stage that exists. */
  level?: number;
  key?: string;
  items: string[];
}

/**
 * Applies the model's ops to `current` (the plan re-read just now).
 * `shown` is what the model saw: its refs, and the stamps that tell a hand
 * edit since.
 */
export interface HandItems {
  /** Items the person made or changed by hand since the chat last wrote the plan. */
  byHand: ReadonlySet<string>;
  /** Whether the person's message names this item. */
  named(item: DraftItem): boolean;
}

export function applyOps(raw: unknown, shown: PlanSnapshot, current: PlanSnapshot, map: SourceMap, hand: HandItems = { byHand: new Set(), named: () => false }): AppliedEdit {
  const draft: DraftPlan = {
    ...current.draft,
    labels: new Map(current.draft.labels),
    dates: new Map(current.draft.dates ?? []),
    items: current.draft.items.map((item) => ({ ...item, sources: [...item.sources] })),
    edges: [...current.draft.edges],
  };
  const touched = new Set<string>();
  /** In op order; an item added or moved is put in words once its stage is known, at the end. */
  const lines: Array<string | Placed> = [];
  const kept: string[] = [];
  const issues: string[] = [];
  const ops = isRecord(raw) && Array.isArray(raw.ops) ? raw.ops : undefined;
  if (!ops) return { draft, touched, changes: [], kept, issues: ['"ops" must be a list of changes'] };

  const byKey = () => new Map(draft.items.map((item) => [item.key, item]));
  const stages: Stage[] = [...new Set(draft.items.map((item) => item.level))]
    .sort((a, b) => a - b)
    .map((level) => ({ level, items: draft.items.filter((item) => item.level === level).sort((a, b) => a.ord - b.ord).map((item) => item.key) }));
  const newKeys = new Set<string>();
  /** Labels set by this edit; `null` clears one. */
  const labelsByStage = new Map<Stage, string | null>();
  /** Days set by this edit; `null` clears one. */
  const datesByStage = new Map<Stage, string | null>();
  const pendingLinks: Array<{ key: string; links: ItemLinks }> = [];

  /** An item the model named, as long as the person has not changed it since it was shown. */
  const editable = (ref: unknown, what: string): DraftItem | undefined => {
    if (typeof ref !== "string") {
      issues.push(`${what}: "item" must name an item such as I1`);
      return undefined;
    }
    const id = shown.itemRefs.get(ref.trim()) ?? (newKeys.has(ref.trim()) ? ref.trim() : undefined);
    if (!id) {
      issues.push(`${what}: ${ref} is not an item of the plan`);
      return undefined;
    }
    const item = byKey().get(id);
    const title = shown.draft.items.find((candidate) => candidate.key === id)?.title ?? id;
    if (!item) {
      kept.push(`"${title}" was removed by hand, so I left it out.`);
      return undefined;
    }
    if (item.existing && shown.stamps.get(id) !== current.stamps.get(id)) {
      kept.push(`You changed "${item.title}" while I was working, so I left it as you have it.`);
      return undefined;
    }
    if (mine(item)) return undefined;
    return item;
  };
  /** True, and says so, for an item made by hand that the message did not name. */
  const mine = (item: DraftItem): boolean => {
    if (!hand.byHand.has(item.key) || hand.named(item)) return false;
    const note = `"${item.title}" (${item.type}) is one you made or changed by hand, and your message didn't name it, so I left it as it is.`;
    if (!kept.includes(note)) kept.push(note);
    return true;
  };
  const resolveRef = (ref: string) => {
    const id = shown.itemRefs.get(ref) ?? (newKeys.has(ref) ? ref : undefined);
    return id && byKey().has(id) ? id : undefined;
  };
  const stageOf = (ref: unknown, what: string): Stage | undefined => {
    if (typeof ref === "number") {
      const level = shown.stageRefs.get(ref);
      if (level === undefined) {
        issues.push(`${what}: there is no stage ${ref} (the plan has ${shown.stageRefs.size})`);
        return undefined;
      }
      let stage = stages.find((candidate) => candidate.level === level);
      if (!stage) {
        // Every item of that stage was moved or removed by hand: it comes back at its place.
        stage = { level, items: [] };
        const at = stages.findIndex((candidate) => candidate.level !== undefined && candidate.level > level);
        stages.splice(at < 0 ? stages.length : at, 0, stage);
      }
      return stage;
    }
    const stage = typeof ref === "string" ? stages.find((candidate) => candidate.key === ref.trim()) : undefined;
    if (!stage) issues.push(`${what}: "stage" must be a stage number or the key of a stage added with addStage`);
    return stage;
  };
  const place = (key: string, stage: Stage, position: unknown) => {
    for (const other of stages) other.items = other.items.filter((candidate) => candidate !== key);
    const at = typeof position === "number" && Number.isInteger(position) ? Math.max(0, Math.min(position, stage.items.length)) : stage.items.length;
    stage.items.splice(at, 0, key);
  };

  ops.forEach((op, index) => {
    const what = `op ${index + 1}`;
    if (!isRecord(op) || typeof op.op !== "string") {
      issues.push(`${what} must be an object with "op"`);
      return;
    }
    switch (op.op) {
      case "change": {
        const item = editable(op.item, what);
        if (!item) return;
        const fields: string[] = [];
        if (typeof op.title === "string") (item.title = op.title.trim()), fields.push("title");
        if (typeof op.brief === "string") (item.prompt = op.brief.trim()), fields.push("brief");
        if (typeof op.format === "string") (item.type = op.format.trim()), fields.push("format");
        if (op.settings !== undefined) (item.settings = settingsOf(op.settings)), fields.push("settings");
        if (op.sources !== undefined) {
          const sources = readSources(op.sources, what, map, issues);
          if (sources) (item.sources = sources), fields.push("sources");
        }
        if (typeof op.enabled === "boolean") (item.enabled = op.enabled), fields.push(op.enabled ? "included" : "left out");
        if (op.branchOf === null) {
          delete item.parentKey;
          delete item.condition;
          fields.push("no longer a branch");
        } else if (op.branchOf !== undefined) {
          const branch = readBranch(op.branchOf, what, issues);
          const parent = branch ? resolveRef(branch.item) : undefined;
          if (branch && !parent) issues.push(`${what}: branchOf names ${branch.item}, which is not an item`);
          if (branch && parent) (item.parentKey = parent), (item.condition = branch.condition), fields.push("branch");
        }
        if (fields.length === 0) return;
        touched.add(item.key);
        lines.push(`Changed "${item.title}" (${item.type}): ${fields.join(", ")}.`);
        return;
      }
      case "add": {
        const read = readItem(op, what, map, issues);
        const stage = stageOf(op.stage, what);
        if (!read || !stage) return;
        if (byKey().has(read.item.key) || shown.itemRefs.has(read.item.key)) {
          issues.push(`${what}: the key "${read.item.key}" is taken; choose a new one`);
          return;
        }
        draft.items.push({ ...read.item, level: 0, ord: 0 });
        newKeys.add(read.item.key);
        touched.add(read.item.key);
        place(read.item.key, stage, op.position);
        pendingLinks.push({ key: read.item.key, links: read.links });
        lines.push({ verb: "Added", key: read.item.key, title: read.item.title, type: read.item.type });
        return;
      }
      case "remove": {
        const item = editable(op.item, what);
        if (!item) return;
        // Its branches go with it, as when an item is deleted by hand.
        const gone = new Set([item.key]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const other of draft.items) if (other.parentKey && gone.has(other.parentKey) && !gone.has(other.key)) (gone.add(other.key), (grew = true));
        }
        // A branch the person made by hand and did not name keeps the whole removal from happening.
        if (draft.items.some((other) => gone.has(other.key) && other.key !== item.key && mine(other))) return;
        draft.items = draft.items.filter((other) => !gone.has(other.key));
        draft.edges = draft.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to));
        for (const stage of stages) stage.items = stage.items.filter((key) => !gone.has(key));
        lines.push(`Removed "${item.title}" (${item.type})${gone.size > 1 ? ` and its ${gone.size - 1} branch item${gone.size > 2 ? "s" : ""}` : ""}.`);
        return;
      }
      case "move": {
        const item = editable(op.item, what);
        const stage = stageOf(op.stage, what);
        if (!item || !stage) return;
        place(item.key, stage, op.position);
        lines.push({ verb: "Moved", key: item.key, title: item.title, type: item.type });
        return;
      }
      case "addStage": {
        if (typeof op.key !== "string" || !op.key.trim() || stages.some((stage) => stage.key === op.key)) {
          issues.push(`${what}: addStage needs a new "key"`);
          return;
        }
        const stage: Stage = { key: op.key.trim(), items: [] };
        if (op.after === null || op.after === undefined || op.after === 0) stages.unshift(stage);
        else {
          const after = stageOf(op.after, what);
          if (!after) return;
          stages.splice(stages.indexOf(after) + 1, 0, stage);
        }
        if (typeof op.label === "string" && op.label.trim()) labelsByStage.set(stage, op.label.trim().slice(0, 200));
        if (op.dueOn !== undefined && op.dueOn !== null) {
          if (isDay(op.dueOn)) datesByStage.set(stage, op.dueOn);
          else issues.push(`${what}: "dueOn" must be a day written YYYY-MM-DD`);
        }
        // A stage is there only for the items put in it; their lines say so.
        return;
      }
      case "label": {
        const stage = stageOf(op.stage, what);
        if (!stage) return;
        if (stage.level !== undefined && shown.draft.labels.get(stage.level) !== current.draft.labels.get(stage.level)) {
          kept.push("You relabelled a stage while I was working, so I kept your label.");
          return;
        }
        labelsByStage.set(stage, typeof op.label === "string" && op.label.trim() ? op.label.trim().slice(0, 200) : null);
        // A new stage's label is said with the items put in it.
        if (stage.level === undefined) return;
        lines.push(typeof op.label === "string" && op.label.trim() ? `Labelled a stage "${op.label.trim()}".` : "Cleared a stage label.");
        return;
      }
      case "date": {
        const stage = stageOf(op.stage, what);
        if (!stage) return;
        if (op.dueOn !== null && !isDay(op.dueOn)) return void issues.push(`${what}: "dueOn" must be a day written YYYY-MM-DD, or null to clear it`);
        if (stage.level !== undefined && shown.draft.dates?.get(stage.level) !== current.draft.dates?.get(stage.level)) {
          kept.push("You changed a stage's day while I was working, so I kept your day.");
          return;
        }
        datesByStage.set(stage, op.dueOn);
        if (stage.level === undefined) return;
        lines.push(op.dueOn ? `Set a stage for ${op.dueOn}.` : "Cleared a stage's day.");
        return;
      }
      case "link":
      case "unlink": {
        const from = typeof op.from === "string" ? resolveRef(op.from.trim()) : undefined;
        const to = typeof op.to === "string" ? resolveRef(op.to.trim()) : undefined;
        const kind = edgeKind(op.kind);
        if (!from || !to || !kind) {
          issues.push(`${what}: ${op.op} needs "from" and "to" items and a lower_snake "kind"`);
          return;
        }
        const same = (edge: { from: string; to: string; kind: string }) => edge.from === from && edge.to === to && edge.kind === kind;
        if (op.op === "link" && !draft.edges.some(same)) draft.edges.push({ from, to, kind });
        if (op.op === "unlink") draft.edges = draft.edges.filter((edge) => !same(edge));
        lines.push(op.op === "link" ? "Linked two items." : "Unlinked two items.");
        return;
      }
      case "title": {
        if (shown.draft.title !== current.draft.title) return void kept.push("You renamed the plan while I was working, so I kept your title.");
        if (typeof op.title !== "string" || !op.title.trim()) return void issues.push(`${what}: title must be text`);
        draft.title = op.title.trim().slice(0, 200);
        lines.push(`Renamed the plan "${draft.title}".`);
        return;
      }
      case "budget": {
        if (shown.draft.budgetUsd !== current.draft.budgetUsd) return void kept.push("You changed the budget while I was working, so I kept yours.");
        if (op.usd === null) delete draft.budgetUsd;
        else if (typeof op.usd === "number" && Number.isFinite(op.usd) && op.usd >= 0) draft.budgetUsd = op.usd;
        else return void issues.push(`${what}: usd must be a number of dollars or null`);
        lines.push(op.usd === null ? "Removed the budget." : `Set the budget to $${op.usd}.`);
        return;
      }
      default:
        issues.push(`${what}: "${op.op}" is not an op`);
    }
  });

  for (const { key, links } of pendingLinks) applyLinks(draft, key, links, resolveRef, issues);

  // Levels follow the stage order; a stage keeps its level unless one was
  // inserted before it with no room, then it and those after move up one.
  const labels = new Map<number, string>();
  const dates = new Map<number, string>();
  let previous = 0;
  for (const stage of stages) {
    if (stage.items.length === 0) continue;
    const level = stage.level !== undefined && stage.level > previous ? stage.level : previous + 1;
    previous = level;
    const label = labelsByStage.has(stage) ? labelsByStage.get(stage) : stage.level !== undefined ? current.draft.labels.get(stage.level) : undefined;
    if (label) labels.set(level, label);
    const dueOn = datesByStage.has(stage) ? datesByStage.get(stage) : stage.level !== undefined ? current.draft.dates?.get(stage.level) : undefined;
    if (dueOn) dates.set(level, dueOn);
    stage.items.forEach((key, ord) => {
      const item = draft.items.find((candidate) => candidate.key === key);
      if (item) Object.assign(item, { level, ord });
    });
  }
  draft.labels = labels;
  draft.dates = dates;
  return { draft, touched, changes: inWords(lines, stages, labelsByStage, draft), kept, issues };
}

/** An item added or moved by this edit, said once its stage is known. */
interface Placed {
  verb: "Added" | "Moved";
  key: string;
  title: string;
  type: string;
}

/**
 * The edit's lines in words. A new stage is never a line of its own: the
 * first item put in it says "in a new stage" (with its label), the others
 * put there say they sit beside that one. A new stage nothing ended up in
 * is dropped, so it is not mentioned.
 */
function inWords(lines: Array<string | Placed>, stages: Stage[], labels: Map<Stage, string | null>, draft: DraftPlan): string[] {
  const firstIn = new Map<Stage, string>();
  return lines.map((line) => {
    if (typeof line === "string") return line;
    const base = `${line.verb} "${line.title}" (${line.type})`;
    const stage = stages.find((candidate) => candidate.items.includes(line.key));
    if (!stage || stage.level !== undefined) return `${base}.`;
    const first = firstIn.get(stage);
    if (first === undefined) {
      firstIn.set(stage, line.key);
      const label = labels.get(stage);
      return `${base} ${line.verb === "Added" ? "in" : "to"} a new stage${label ? ` "${label}"` : ""}.`;
    }
    if (first === line.key) return `${base}.`;
    const title = draft.items.find((item) => item.key === first)?.title;
    return title ? `${base} beside "${title}".` : `${base}.`;
  });
}
