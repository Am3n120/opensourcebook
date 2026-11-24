/**
 * Dated stages across plans (migrations/0017): what is due, and moving the
 * days on when some were missed. Today is the person's day, sent by their
 * app (studio/days.ts); nothing here reads this computer's clock.
 */
import { addDays, daysBetween } from "./days";
import type { PlanNode, PlanStageDate, StudioRepositories } from "./repositories";

/** When a dated stage falls, from today: before it, on it, or within the days looked ahead. */
export type DueWhen = "missed" | "today" | "soon";

export interface DueStage {
  planId: string;
  planTitle?: string;
  projectId: string;
  projectTitle?: string;
  level: number;
  /** 1-based place among the plan's stages, for "Stage 2". */
  number: number;
  label?: string;
  dueOn: string;
  when: DueWhen;
  /** Items in the stage still to go through, and all it has. */
  left: number;
  total: number;
  /** False while the plan waits for Start: nothing in it is made yet. */
  started: boolean;
}

/** An item that counts toward a stage: in the plan, and not skipped by a branch. */
function counts(node: PlanNode): boolean {
  return node.enabled && node.status !== "skipped";
}

/** The stage's place in the plan, with its items still to go through. */
export function stageProgress(nodes: readonly PlanNode[], done: ReadonlySet<string>, level: number): { number: number; left: number; total: number } {
  const levels = [...new Set(nodes.map((node) => node.level))].sort((a, b) => a - b);
  const items = nodes.filter((node) => node.level === level && counts(node));
  return { number: levels.indexOf(level) + 1, left: items.filter((node) => !done.has(node.id)).length, total: items.length };
}

/**
 * Stages with something left that fell before today, fall today, or fall
 * within `ahead` days after it, earliest first. A stage gone through, or
 * one with no items left in the plan, is not due.
 */
export async function dueStages(repos: StudioRepositories, ownerId: string, today: string, ahead: number): Promise<DueStage[]> {
  const dated = (await repos.plans.listDatedStages(ownerId)).filter((stage) => daysBetween(today, stage.dueOn) <= ahead);
  const plans = new Map<string, Promise<Awaited<ReturnType<typeof planFacts>>>>();
  const projects = new Map<string, Promise<string | undefined>>();
  const due: DueStage[] = [];
  for (const stage of dated) {
    if (!plans.has(stage.planId)) plans.set(stage.planId, planFacts(repos, stage.planId));
    if (!projects.has(stage.projectId)) projects.set(stage.projectId, repos.projects.get(stage.projectId).then((project) => project?.title));
    const facts = await plans.get(stage.planId)!;
    if (!facts) continue;
    const progress = stageProgress(facts.nodes, facts.done, stage.level);
    if (progress.number === 0 || progress.left === 0) continue;
    const projectTitle = await projects.get(stage.projectId)!;
    const label = facts.labels.get(stage.level);
    const gap = daysBetween(today, stage.dueOn);
    due.push({
      planId: stage.planId,
      ...(facts.title ? { planTitle: facts.title } : {}),
      projectId: stage.projectId,
      ...(projectTitle ? { projectTitle } : {}),
      level: stage.level,
      ...progress,
      ...(label ? { label } : {}),
      dueOn: stage.dueOn,
      when: gap < 0 ? "missed" : gap === 0 ? "today" : "soon",
      started: facts.started,
    });
  }
  return due;
}

async function planFacts(repos: StudioRepositories, planId: string) {
  const plan = await repos.plans.get(planId);
  if (!plan) return undefined;
  const [nodes, results, stages] = await Promise.all([repos.plans.listNodes(planId), repos.results.listByPlan(planId), repos.plans.listStages(planId)]);
  return {
    title: plan.title,
    started: Boolean(plan.kickedOffAt),
    nodes,
    done: new Set(results.filter((result) => result.doneAt).map((result) => result.nodeId)),
    labels: new Map(stages.map((stage) => [stage.level, stage.label])),
  };
}

/**
 * The new days when some were missed: the first stage with something left
 * whose day is before today moves to today, and every later stage with
 * something left moves by as many days, so the gaps the person set stay.
 * A stage already gone through keeps its day. Empty when nothing was missed.
 */
export function movedDays(dates: readonly PlanStageDate[], left: (level: number) => number, today: string): Map<number, string> {
  const open = [...dates].filter((date) => left(date.level) > 0).sort((a, b) => a.level - b.level);
  const first = open.find((date) => daysBetween(date.dueOn, today) > 0);
  const moved = new Map<number, string>();
  if (!first) return moved;
  const by = daysBetween(first.dueOn, today);
  for (const date of open) if (date.level >= first.level) moved.set(date.level, addDays(date.dueOn, by));
  return moved;
}
