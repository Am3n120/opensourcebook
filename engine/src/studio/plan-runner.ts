/**
 * The plan runner: turns an approved plan into output jobs, in plan order
 * (docs/VISION.md, "A plan, when a path is wanted").
 *
 *   - Levels run in order. A level starts once every item on the levels
 *     below it has settled; within a level each enabled item gets its own
 *     job, all queued at once.
 *   - An item is told what it may assume: the outputs of the enabled items
 *     on lower levels that finished (never its own level), and the sources
 *     of its explicit `assumes` edges. Every other edge (`fix_of`, or any
 *     kind; edge-kinds.ts) becomes an input: the earlier item's output and, when the person
 *     has recorded one, its result (item_results).
 *   - An item with `condition_json` is a branch: it runs only when the
 *     condition holds on an earlier item's result (conditions.ts). Otherwise
 *     it is `skipped`; while the result it needs is not recorded, it waits.
 *   - An item runs only if everything it explicitly depends on (its parent
 *     and the sources of its edges) is `done`; when one of those failed or
 *     was skipped, it is skipped too. Items that do not depend on a failure
 *     carry on. A plan that ran to the end with a failed item is `failed`.
 *   - Cancelling the plan cancels its queued and running jobs.
 *   - Stopping one item (`stopItem`) cancels only its job and marks it
 *     `cancelled`; the rest of the plan goes on. What depends on it is
 *     skipped as it would be for a failed item, and a plan that runs to the
 *     end with a stopped item and none failed is stopped (`cancelled`), not
 *     failed, so Resume or the item's retry carries it on.
 *   - Start refuses a plan with an enabled item whose format no engine makes
 *     (unknown, or declared only), or a condition no resolver decides, so
 *     nothing is spent on a plan that would fail part way. A disabled item
 *     may name any format.
 *
 * A branch waiting on the person's result moves on at the next advance, so
 * whatever records a result (item_results) should call `advance` after.
 *
 * It advances when a job finishes (the consumer's `onFinished`), not by
 * polling. Every advance re-reads the plan from the database and is safe to
 * repeat: an item's job is created under an idempotency key derived from the
 * item, so a completion delivered twice queues nothing twice.
 */
import { cancelJob, chooseWayOn, requeueCancelledJob, requeueFailedJob, resetJobForNewMaker, wakeJob } from "../jobs/lifecycle";
import { AGENT_KEY, EFFORT_KEY, REVIEW_EFFORT_KEY, REVIEWER_KEY, agentPickOf } from "../engines/agent-fields";
import type { GenerationJob, GenerationJobStore, JsonObject } from "../jobs/types";
import type { StudioRepositories } from "./repositories";
import { isPlanFinished, type NodeStatus, type Plan, type PlanEdge, type PlanNode } from "./repositories/plans";
import { createDefaultConditions, type ConditionRegistry } from "./conditions";
import { createDefaultEdgeKinds, type EdgeKindRegistry } from "./edge-kinds";
import type { ItemResult } from "./repositories/results";
import type { FormatRegistry } from "./registry";
import type { JsonValue, NodeInput, PriorOutput } from "./types";
import { itemIssue, named, planIssue, type PlanIssue } from "./plan-issues";

export { issueMessages, type PlanIssue } from "./plan-issues";

export class PlanNotRunnableError extends Error {
  /** The messages, as `issues` on the wire. */
  readonly issues: string[];
  readonly details: PlanIssue[];

  constructor(
    readonly planId: string,
    issues: Array<string | PlanIssue>,
  ) {
    const details = issues.map((issue) => (typeof issue === "string" ? planIssue("plan_status", issue) : issue));
    super(`Plan ${planId} cannot run: ${details.map((issue) => issue.message).join("; ")}`);
    this.name = "PlanNotRunnableError";
    this.details = details;
    this.issues = details.map((issue) => issue.message);
  }
}

/** "Change for all" or "Change maker for what's left" (`POST /v1/plans/:id/maker`). */
export interface PlanMakerChange {
  /** A pick id; null for "auto" (back to the defaults). */
  agent: string | null;
  effort?: string | null;
  /** A pick id, "off", or null for "auto". */
  reviewer?: string | null;
  reviewEffort?: string | null;
  /** Only these items; absent: every item not made yet. */
  items?: string[];
}

/** Why a maker change is refused, with the code the route answers. */
export class PlanMakerChangeError extends Error {
  constructor(
    readonly code: "plan_running" | "plan_finished" | "invalid_request" | "invalid_settings",
    message: string,
  ) {
    super(message);
    this.name = "PlanMakerChangeError";
  }
}

/**
 * The setting keys a maker change writes: the maker's agent always (its
 * effort cleared when not sent, since it was the old agent's), and the
 * reviewer's only where the format has one and the change names it.
 */
function makerKeys(change: PlanMakerChange, reviewed: boolean): Record<string, JsonValue | null> {
  const keys: Record<string, JsonValue | null> = { [AGENT_KEY]: change.agent, [EFFORT_KEY]: change.effort ?? null };
  if (reviewed && change.reviewer !== undefined) {
    keys[REVIEWER_KEY] = change.reviewer;
    keys[REVIEW_EFFORT_KEY] = change.reviewEffort ?? null;
  }
  return keys;
}

export interface PlanRunnerOptions {
  repos: StudioRepositories;
  jobs: GenerationJobStore;
  /** Which formats an engine can make; checked at Start. */
  registry: Pick<FormatRegistry, "get" | "servedType">;
  /** Puts a job on the queue. Called again for a job that exists but may never have been sent. */
  schedule(jobId: string): Promise<void>;
  /** Decides branch conditions; the built-in kinds when absent. */
  conditions?: ConditionRegistry;
  /** How each kind of edge is read; the built-in kinds when absent. */
  edgeKinds?: EdgeKindRegistry;
  /**
   * Checked at Start for each scope (a format id) whose items leave who
   * makes them open: throws `PickNeededError` when several providers could
   * and none is picked, so the person is asked (409 pick_needed) before
   * anything starts. Absent: nothing is checked.
   */
  checkPick?(ownerId: string, scope: string): Promise<void>;
}

export interface PlanProgress {
  plan: Plan;
  nodes: Array<{ id: string; level: number; status: NodeStatus }>;
  /** Branch items ready to decide but waiting for their parent's result. */
  waitingOnResult: string[];
}

const SETTLED: readonly NodeStatus[] = ["done", "failed", "skipped", "cancelled"];
const isSettled = (status: NodeStatus) => SETTLED.includes(status);

export class PlanRunner {
  /** The condition kinds this runner decides; the planner offers only these. */
  readonly conditions: ConditionRegistry;
  /** The kinds of link between items this runner reads (`GET /v1/edge-kinds`). */
  readonly edgeKinds: EdgeKindRegistry;

  constructor(private readonly options: PlanRunnerOptions) {
    this.conditions = options.conditions ?? createDefaultConditions();
    this.edgeKinds = options.edgeKinds ?? createDefaultEdgeKinds();
  }

  /**
   * The check Start makes, for one thing of this format not made yet (its settings as given, else the format's
   * defaults): throws `PickNeededError` when several providers could make it and none is picked. A thing made from
   * the terminal is checked before the chat turn that settles it, so the person is asked for the pick that blocks it.
   */
  async checkPickFor(ownerId: string, format: string, settings: PlanNode["settings"] = {}): Promise<void> {
    if (!this.options.checkPick) return;
    const node = { enabled: true, status: "pending", type: format, settings } as PlanNode;
    for (const scope of openAgentScopes([node], this.options.registry)) await this.options.checkPick(ownerId, scope);
  }

  /** Starts an approved plan (sets `kicked_off_at`); a plan already running is just advanced. */
  async kickOff(planId: string): Promise<PlanProgress> {
    const plan = await this.requirePlan(planId);
    if (plan.status === "running") return this.advance(planId);
    if (plan.status !== "approved") throw new PlanNotRunnableError(planId, [`it is ${plan.status}, not approved`]);

    const nodes = await this.options.repos.plans.listNodes(planId);
    const edges = await this.options.repos.plans.listEdges(planId);
    const issues = this.startIssues(plan, nodes, edges, await this.sourceCounts(nodes));
    if (issues.length > 0) throw new PlanNotRunnableError(planId, issues);
    // An item whose agent is open is made by the shape's default or the only provider that can; with several, ask first.
    if (this.options.checkPick) for (const scope of openAgentScopes(nodes, this.options.registry)) await this.options.checkPick(plan.ownerId, scope);

    // Only from approved: an edit that sent the plan back to draft since it was read wins.
    const started = await this.options.repos.plans.transition(planId, ["approved"], "running");
    if (started?.status !== "running") throw new PlanNotRunnableError(planId, [`it is ${started?.status ?? "gone"}, not approved`]);
    // An unchecked item is part of the plan but never runs.
    for (const node of nodes) if (!node.enabled && node.status === "pending") await this.setNode(node, "skipped");
    return this.advance(planId);
  }

  /** Problems in a plan's shape (levels, parents, edges, conditions), for items and edges as given. */
  structuralIssues(nodes: PlanNode[], edges: PlanEdge[]): PlanIssue[] {
    return validatePlan(nodes, edges, this.conditions);
  }

  /** Everything `kickOff` would refuse the plan for, so a client can be told before it tries. */
  startIssues(plan: Pick<Plan, "budgetUsd">, nodes: PlanNode[], edges: PlanEdge[], sourceCounts?: Map<string, number>): PlanIssue[] {
    return [
      ...this.structuralIssues(nodes, edges),
      ...unmakeableNodes(nodes, this.options.registry),
      ...(sourceCounts ? sourcelessNodes(nodes, sourceCounts) : []),
      ...overBudget(plan, nodes),
    ];
  }

  /** How many sources each item reads, for `startIssues`. */
  async sourceCounts(nodes: PlanNode[]): Promise<Map<string, number>> {
    return countSources(this.options.repos, nodes);
  }

  /** The listener for the job consumer: any settled job of a plan moves that plan on. */
  async onJobFinished(job: GenerationJob): Promise<void> {
    if (job.planId) await this.advance(job.planId);
  }

  /**
   * Brings item statuses in step with their jobs, decides and queues what
   * can start, and settles the plan when nothing is left. Idempotent.
   */
  async advance(planId: string): Promise<PlanProgress> {
    const plan = await this.requirePlan(planId);
    if (plan.status !== "running") return this.progress(plan, []);
    const { repos } = this.options;
    const nodes = await repos.plans.listNodes(planId);
    const edges = await repos.plans.listEdges(planId);
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const results = new Map((await repos.results.listByPlan(planId)).map((result) => [result.nodeId, result]));
    const waiting: string[] = [];

    const levels = [...new Set(nodes.map((node) => node.level))].sort((a, b) => a - b);
    for (const level of levels) {
      for (const node of nodes.filter((candidate) => candidate.level === level)) {
        if (isSettled(node.status)) continue;
        if (node.status === "queued" || node.status === "running") {
          await this.syncWithJob(plan, node);
          continue;
        }
        const decision = await this.decide(plan, node, byId, edges, results);
        if (decision === "wait") waiting.push(node.id);
        else if (decision === "run") await this.queueNode(plan, node, nodes, edges, byId, results);
        else await this.setNode(node, decision);
      }
      // Later levels may assume this one, so they wait until it has settled.
      if (!nodes.filter((node) => node.level === level).every((node) => isSettled(node.status))) break;
    }

    if (nodes.every((node) => isSettled(node.status))) {
      const failed = nodes.some((node) => node.status === "failed");
      // An item the person stopped (stopItem) leaves the plan stopped, so it can be carried on, never failed or done.
      const stopped = nodes.some((node) => node.enabled && node.status === "cancelled");
      // A cancel that landed while this advance ran stays.
      await repos.plans.transition(planId, ["running"], failed ? "failed" : stopped ? "cancelled" : "done");
    }
    return this.progress((await repos.plans.get(planId))!, waiting, nodes);
  }

  /**
   * The question an "ask me" branch puts to the person, when `node` is a
   * branch with an `ask` condition that has not been decided yet; undefined
   * for any other item. `{}` means the client words the question itself.
   */
  askOf(node: PlanNode): { question?: string } | undefined {
    if (node.status !== "pending" || node.condition === undefined) return undefined;
    const parsed = this.conditions.parse(node.condition);
    if (typeof parsed === "string" || parsed.kind !== "ask") return undefined;
    const question = (parsed.condition as { question?: string }).question;
    return question === undefined ? {} : { question };
  }

  /**
   * Stops one item of a running plan while the rest goes on: its job,
   * queued, running or waiting, is cancelled, keeping the steps its maker
   * saved, and the item is `cancelled`. Items that depend on it are skipped
   * as for a failed one, without failing the plan. `retryItem` (or Resume,
   * once nothing else is left) carries it on from what was saved. An item
   * that is not being made is refused with the reason.
   */
  async stopItem(planId: string, nodeId: string): Promise<PlanProgress> {
    const plan = await this.requirePlan(planId);
    if (plan.status !== "running") throw new PlanNotRunnableError(planId, [`it is ${plan.status}`]);
    const nodes = await this.options.repos.plans.listNodes(planId);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new PlanNotRunnableError(planId, ["no such item"]);
    if (node.status !== "queued" && node.status !== "running") throw new PlanNotRunnableError(planId, [itemIssue("item_status", node, "is not being made")]);
    const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
    const outcome = job ? await cancelJob(this.options.jobs, job.id) : undefined;
    // A job that finished a moment ago keeps its output.
    await this.setNode(node, outcome?.kind === "done" ? "done" : "cancelled");
    return this.advance(planId);
  }

  /**
   * Makes a failed or stopped item again: its job is queued once more
   * (a stopped one keeping its saved steps), a plan that had failed or
   * stopped runs again, and items skipped because they waited on this one
   * are decided again. Anything else is refused with the reason.
   */
  async retryItem(planId: string, nodeId: string, choice?: string): Promise<PlanProgress> {
    const plan = await this.requirePlan(planId);
    const nodeOf = async () => (await this.options.repos.plans.listNodes(planId)).find((candidate) => candidate.id === nodeId);
    // A stopped item goes on from what it saved, in a running plan or one that stopped (with it, or as a whole).
    const stopped = await nodeOf();
    if (stopped?.status === "cancelled" && choice === undefined) return this.goOn(plan, stopped);
    if (plan.status !== "running" && plan.status !== "failed") throw new PlanNotRunnableError(planId, [`it is ${plan.status}`]);
    const nodes = await this.options.repos.plans.listNodes(planId);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new PlanNotRunnableError(planId, ["no such item"]);
    // A way on its job offers (finishing a video without sound while it waits for the voice): kept for its maker first.
    if (choice !== undefined) {
      const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
      const chosen = job ? await chooseWayOn(this.options.jobs, job.id, choice) : undefined;
      if (chosen?.kind !== "moved") throw new PlanNotRunnableError(planId, [itemIssue("item_status", node, `offers no "${choice}" now`)]);
    }
    // A waiting item is tried now rather than when its wait is up.
    const waiting = node.status === "failed" ? undefined : await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
    if (waiting?.status === "waiting") {
      await wakeJob(this.options.jobs, waiting.id);
      await this.options.schedule(waiting.id);
      return this.advance(planId);
    }
    if (node.status !== "failed") throw new PlanNotRunnableError(planId, [itemIssue("item_status", node, "has not failed")]);
    const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
    if (job) {
      const outcome = await requeueFailedJob(this.options.jobs, job.id);
      if (outcome.kind !== "queued") throw new PlanNotRunnableError(planId, [itemIssue("item_status", node, `is ${outcome.job.status}`)]);
    }
    if (plan.status === "failed") await this.options.repos.plans.transition(planId, ["failed"], "running");
    // Later items skipped for want of this one (or anything) are decided again.
    for (const other of nodes) if (other.enabled && other.level > node.level && other.status === "skipped") await this.setNode(other, "pending");
    if (job) {
      await this.setNode(node, "queued");
      await this.options.schedule(job.id);
    } else {
      // Failed before a job was written (a condition it could not read): decide it again.
      await this.setNode(node, "pending");
    }
    return this.advance(planId);
  }

  /** A stopped item carried on: its cancelled job queued again with its saved steps, and its plan running. */
  private async goOn(plan: Plan, node: PlanNode): Promise<PlanProgress> {
    if (plan.status !== "running" && plan.status !== "failed" && plan.status !== "cancelled") throw new PlanNotRunnableError(plan.id, [`it is ${plan.status}`]);
    const issues = unmakeableNodes([node], this.options.registry);
    if (issues.length > 0) throw new PlanNotRunnableError(plan.id, issues);
    const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
    const again = job ? await requeueCancelledJob(this.options.jobs, job.id) : undefined;
    if (again && again.kind !== "queued") throw new PlanNotRunnableError(plan.id, [itemIssue("item_status", node, `is ${again.job.status}`)]);
    if (plan.status !== "running") await this.options.repos.plans.transition(plan.id, [plan.status], "running");
    const nodes = await this.options.repos.plans.listNodes(plan.id);
    // Later items skipped for want of this one are decided again.
    for (const other of nodes) if (other.enabled && other.level > node.level && other.status === "skipped") await this.setNode(other, "pending");
    if (job) {
      await this.setNode(node, "queued");
      await this.options.schedule(job.id);
    } else {
      await this.setNode(node, "pending");
    }
    return this.advance(plan.id);
  }

  /**
   * Cancels the plan and every job it has queued or running. A plan stopped
   * after Start is `cancelled` (it can be resumed); one cancelled before
   * Start is `discarded`.
   */
  async cancel(planId: string): Promise<PlanProgress> {
    const plan = await this.requirePlan(planId);
    if (isPlanFinished(plan.status)) return this.progress(plan, []);
    const { plans } = this.options.repos;
    let moved = plan.kickedOffAt ? undefined : await plans.transition(planId, ["draft", "approved"], "discarded");
    // Not discarded: it was started meanwhile (or before), so it is stopped.
    if (moved?.status !== "discarded") moved = await plans.transition(planId, ["running"], "cancelled");
    if (moved?.status !== "cancelled" && moved?.status !== "discarded") return this.progress(moved ?? plan, []);
    const nodes = await plans.listNodes(planId);
    for (const node of nodes) {
      if (isSettled(node.status)) continue;
      const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
      const outcome = job ? await cancelJob(this.options.jobs, job.id) : undefined;
      // A job that finished a moment ago keeps its output.
      await this.setNode(node, outcome?.kind === "done" ? "done" : "cancelled");
    }
    return this.progress((await plans.get(planId))!, [], nodes);
  }

  /**
   * Starts a stopped plan again from what is not made yet: items it
   * cancelled are decided again in plan order (a cancelled job is queued
   * once more, keeping its saved steps), later items skipped for want of
   * them too. Made items stay made; failed ones stay failed (retry them).
   * The items are the ones it started with. A plan that is running already
   * is just advanced.
   */
  async resume(planId: string): Promise<PlanProgress> {
    const plan = await this.requirePlan(planId);
    if (plan.status === "running") return this.advance(planId);
    if (plan.status !== "cancelled") throw new PlanNotRunnableError(planId, [`it is ${plan.status}, not stopped`]);
    const nodes = await this.options.repos.plans.listNodes(planId);
    const redo = nodes.filter((node) => node.enabled && (node.status === "cancelled" || node.status === "skipped"));
    const issues = unmakeableNodes(redo, this.options.registry);
    if (issues.length > 0) throw new PlanNotRunnableError(planId, issues);
    const resumed = await this.options.repos.plans.transition(planId, ["cancelled"], "running");
    if (resumed?.status !== "running") throw new PlanNotRunnableError(planId, [`it is ${resumed?.status ?? "gone"}, not stopped`]);
    for (const node of redo) await this.setNode(node, "pending");
    return this.advance(planId);
  }

  /**
   * Changes who makes the items not made yet (enabled and not done): before
   * Start ("Change for all", a draft or approved plan, which goes back to
   * draft as any edit), or while it is stopped or failed ("Change maker for
   * what's left"). Only the maker's agent and effort, and the reviewer's
   * where the format has one, change; items of a format its agent does
   * not make are left as they are. A changed item's job, when it has one,
   * takes the new settings and loses its saved steps, which were the old
   * maker's. Nothing starts: Resume or Start does.
   */
  async changeMaker(planId: string, change: PlanMakerChange): Promise<{ changed: string[]; unchanged: Array<{ itemId: string; why: string }> }> {
    const plan = await this.requirePlan(planId);
    if (plan.status === "running") throw new PlanMakerChangeError("plan_running", "The plan is being made: stop it first");
    if (plan.status === "done" || plan.status === "discarded") throw new PlanMakerChangeError("plan_finished", `The plan is ${plan.status}`);
    const started = plan.kickedOffAt !== undefined || plan.status === "cancelled" || plan.status === "failed";
    const { plans } = this.options.repos;
    const nodes = await plans.listNodes(planId);
    const wanted = change.items ? new Set(change.items) : undefined;
    const unknown = change.items?.filter((id) => !nodes.some((node) => node.id === id)) ?? [];
    if (unknown.length > 0) throw new PlanMakerChangeError("invalid_request", `Not items of this plan: ${unknown.join(", ")}`);

    const unchanged: Array<{ itemId: string; why: string }> = [];
    const planned: Array<{ node: PlanNode; keys: Record<string, JsonValue | null>; settings: Record<string, JsonValue> }> = [];
    const problems: string[] = [];
    for (const node of nodes) {
      if (wanted && !wanted.has(node.id)) continue;
      if (!node.enabled || node.status === "done") continue;
      const definition = this.options.registry.get(node.type);
      const agents = definition?.descriptor.settings.filter((field) => field.kind === "agent") ?? [];
      const maker = agents.find((field) => field.kind === "agent" && field.role !== "review");
      if (!definition || !maker) {
        unchanged.push({ itemId: node.id, why: "Made without your agent" });
        continue;
      }
      const keys = makerKeys(change, agents.some((field) => field.kind === "agent" && field.role === "review"));
      const settings = { ...(node.settings as Record<string, JsonValue>) };
      for (const [key, value] of Object.entries(keys)) {
        if (value === null) delete settings[key];
        else settings[key] = value;
      }
      const parsed = definition.parseSettings(settings);
      if (!parsed.ok) {
        problems.push(`${named(node)}: ${parsed.issues.map((issue) => issue.message).join("; ")}`);
        continue;
      }
      planned.push({ node, keys, settings });
    }
    if (problems.length > 0) throw new PlanMakerChangeError("invalid_settings", problems.join(". "));

    const changed: string[] = [];
    for (const { node, keys, settings } of planned) {
      if (!started) {
        await plans.updateNode(node.id, { settings });
        changed.push(node.id);
        continue;
      }
      const written = await plans.setMakerAfterStart(planId, node.id, keys);
      if (!written) {
        unchanged.push({ itemId: node.id, why: "It changed while this was asked: look again" });
        continue;
      }
      const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
      if (job && job.status !== "done") {
        const input = { ...job.input, settings: written.settings as JsonValue } as JsonObject;
        const reset = await resetJobForNewMaker(this.options.jobs, job.id, input);
        if (reset.kind === "refused") {
          unchanged.push({ itemId: node.id, why: "It started again before the change: stop it first" });
          continue;
        }
      }
      changed.push(node.id);
    }
    // An approved plan goes back to draft after the change, as after any edit: its approval no longer covers it.
    if (!started && changed.length > 0) await plans.transition(planId, ["approved"], "draft");
    return { changed, unchanged };
  }

  /** What a pending item should do now that every lower level has settled. */
  private async decide(
    plan: Plan,
    node: PlanNode,
    byId: Map<string, PlanNode>,
    edges: PlanEdge[],
    results: Map<string, ItemResult>,
  ): Promise<"run" | "wait" | "skipped" | "failed"> {
    if (!node.enabled) return "skipped";
    const dependsOn = [...(node.parentId ? [node.parentId] : []), ...edges.filter((edge) => edge.toNode === node.id).map((edge) => edge.fromNode)];
    if (dependsOn.some((id) => byId.get(id)?.status !== "done")) return "skipped";
    if (node.condition === undefined) return "run";

    const condition = this.conditions.parse(node.condition);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (typeof condition === "string" || !parent) return "failed";
    const decision = await this.conditions.decide(condition, { plan, node, parent, resultOf: (id) => results.get(id) });
    return decision === "skip" ? "skipped" : decision;
  }

  private async queueNode(
    plan: Plan,
    node: PlanNode,
    nodes: PlanNode[],
    edges: PlanEdge[],
    byId: Map<string, PlanNode>,
    results: Map<string, ItemResult>,
  ): Promise<void> {
    const { repos, jobs, registry } = this.options;
    const incoming = edges.filter((edge) => edge.toNode === node.id);

    // Lower-level enabled items that finished, plus explicit assumes edges.
    const assumedIds = new Set(nodes.filter((other) => other.enabled && other.level < node.level && other.status === "done").map((other) => other.id));
    for (const edge of incoming) if (this.edgeKinds.reads(edge.kind) === "assumes" && byId.get(edge.fromNode)?.status === "done") assumedIds.add(edge.fromNode);
    const assumes: PriorOutput[] = [];
    for (const id of assumedIds) {
      const prior = await priorOutput(repos, registry, byId.get(id)!);
      if (prior) assumes.push(prior);
    }
    const inputs: NodeInput[] = [];
    for (const edge of incoming.filter((candidate) => this.edgeKinds.reads(candidate.kind) === "input")) {
      const from = byId.get(edge.fromNode)!;
      const output = await repos.outputs.latestForNode(from.id);
      const result = results.get(from.id)?.result;
      inputs.push({
        kind: edge.kind,
        nodeId: from.id,
        type: registry.servedType(from.type),
        ...(output ? { outputId: output.id } : {}),
        ...(result === undefined ? {} : { result }),
      });
    }
    const sources = await repos.plans.listNodeSources(node.id);
    // With a plan budget, each job may spend only what the plan has left.
    const budgetUSD =
      plan.budgetUsd === undefined ? undefined : Math.max(0, plan.budgetUsd - (await repos.usage.totals("plan", plan.id)).usd);

    const { job, created } = await jobs.create({
      ownerId: plan.ownerId,
      idempotencyKey: jobKey(node),
      kind: "output",
      type: node.type,
      projectId: plan.projectId,
      planId: plan.id,
      nodeId: node.id,
      input: {
        sources: sources.map((source) => ({ sourceId: source.sourceId, ...(source.range ? { range: source.range } : {}) })),
        title: node.title,
        prompt: node.prompt,
        settings: node.settings,
        assumes,
        inputs,
        ...(budgetUSD !== undefined ? { budgetUSD } : {}),
      } as unknown as JsonObject,
    });
    // A job cancelled when the plan was stopped runs again now that it is resumed.
    const again = !created && job.status === "cancelled" ? await requeueCancelledJob(jobs, job.id) : undefined;
    // A job left queued by an advance that died before sending it is sent again.
    if (created || job.status === "queued" || again?.kind === "queued") await this.options.schedule(job.id);
    await this.setNode(node, "queued");
  }

  private async syncWithJob(plan: Plan, node: PlanNode): Promise<void> {
    const job = await this.options.jobs.findByKey(plan.ownerId, jobKey(node));
    if (!job) {
      // Marked queued but the job was never written: decide it again next time.
      await this.setNode(node, "pending");
      return;
    }
    const status = nodeStatusFor(job);
    if (status !== node.status) await this.setNode(node, status);
  }

  private async setNode(node: PlanNode, status: NodeStatus): Promise<void> {
    node.status = status;
    await this.options.repos.plans.updateNode(node.id, { status });
  }

  private async requirePlan(planId: string): Promise<Plan> {
    const plan = await this.options.repos.plans.get(planId);
    if (!plan) throw new PlanNotRunnableError(planId, ["no such plan"]);
    return plan;
  }

  private async progress(plan: Plan, waitingOnResult: string[], nodes?: PlanNode[]): Promise<PlanProgress> {
    const list = nodes ?? (await this.options.repos.plans.listNodes(plan.id));
    return { plan, nodes: list.map((node) => ({ id: node.id, level: node.level, status: node.status })), waitingOnResult };
  }
}

/** One job per item, whoever asks and however often. */
export function jobKey(node: PlanNode): string {
  return `plan:${node.planId}:node:${node.id}`;
}

/** An item's status from its job. A retryable failure will be redelivered, so the item is still running. */
export function nodeStatusFor(job: GenerationJob): NodeStatus {
  switch (job.status) {
    case "queued":
      return "queued";
    case "running":
    case "waiting":
      // Still being made, from the person's side: the job says why it waits.
      return "running";
    case "done":
      return "done";
    case "failed":
      return job.retryable ? "running" : "failed";
    case "dead":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** Structural problems that would stall or loop the walk, naming items by title. */
export function validatePlan(nodes: PlanNode[], edges: PlanEdge[], conditions: ConditionRegistry = createDefaultConditions()): PlanIssue[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const issues: PlanIssue[] = [];
  for (const node of nodes) {
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (!parent) issues.push(itemIssue("branch_parent_missing", node));
      else if (parent.level >= node.level) issues.push(itemIssue("branch_parent_not_earlier", node, named(parent)));
    }
    if (node.condition !== undefined) {
      const condition = conditions.parse(node.condition);
      if (typeof condition === "string") issues.push(itemIssue("condition_invalid", node, condition));
      if (!node.parentId) issues.push(itemIssue("condition_without_parent", node));
    }
  }
  for (const edge of edges) {
    const to = byId.get(edge.toNode);
    if (!to) continue;
    const from = byId.get(edge.fromNode);
    if (!from) issues.push(itemIssue("edge_source_missing", to));
    else if (from.level >= to.level) issues.push(itemIssue("edge_source_not_earlier", to, named(from)));
  }
  return issues;
}

/** The plan's estimate (enabled items' `estCostUsd`) over its budget, when it has one. */
export function overBudget(plan: Pick<Plan, "budgetUsd">, nodes: PlanNode[]): PlanIssue[] {
  if (plan.budgetUsd === undefined) return [];
  const estimate = nodes.filter((node) => node.enabled).reduce((sum, node) => sum + (node.estCostUsd ?? 0), 0);
  return estimate > plan.budgetUsd ? [planIssue("over_budget", estimate, plan.budgetUsd)] : [];
}

/**
 * Enabled items that read no source. Every format makes its output from the
 * item's sources, so such an item would only fail once it ran.
 */
export function sourcelessNodes(nodes: PlanNode[], sourceCounts: Map<string, number>): PlanIssue[] {
  return nodes
    .filter((node) => node.enabled && (sourceCounts.get(node.id) ?? 0) === 0)
    .map((node) => itemIssue("no_sources", node));
}

/** How many sources each item reads. */
export async function countSources(repos: Pick<StudioRepositories, "plans">, nodes: PlanNode[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.id, (await repos.plans.listNodeSources(node.id)).length);
  return counts;
}

/**
 * Enabled items whose format no engine in `registry` makes (aliases
 * resolve), and items it makes but cannot right now with their settings, in
 * the format's own words (a maker whose service is not running).
 */
export function unmakeableNodes(nodes: PlanNode[], registry: Pick<FormatRegistry, "get">): PlanIssue[] {
  const issues: PlanIssue[] = [];
  for (const node of nodes) {
    if (!node.enabled) continue;
    const definition = registry.get(node.type);
    if (!definition) {
      issues.push(itemIssue("format_not_ready", node, node.type));
      continue;
    }
    // Nothing of its format can be made here now (a voice not set up): its own words say what to do.
    const unavailable = definition.unavailable?.();
    if (unavailable) {
      issues.push(itemIssue("cannot_make_now", node, unavailable));
      continue;
    }
    if (!definition.itemIssues) continue;
    const parsed = definition.parseSettings(node.settings);
    if (parsed.ok) for (const why of definition.itemIssues(parsed.settings)) issues.push(itemIssue("cannot_make_now", node, why));
  }
  return issues;
}

async function priorOutput(repos: StudioRepositories, registry: Pick<FormatRegistry, "servedType">, node: PlanNode): Promise<PriorOutput | undefined> {
  const output = await repos.outputs.latestForNode(node.id);
  if (!output) return undefined;
  return { nodeId: node.id, outputId: output.id, type: registry.servedType(output.type), title: output.title, summary: output.summary };
}

/**
 * The formats of the items still to make whose maker runs the person's agent
 * (the format's maker agent field, shown for the item's maker) and whose
 * agent is left open, once each.
 */
export function openAgentScopes(nodes: PlanNode[], registry: Pick<FormatRegistry, "get">): string[] {
  const scopes = new Set<string>();
  for (const node of nodes) {
    if (!node.enabled || node.status !== "pending") continue;
    const definition = registry.get(node.type);
    const field = definition?.descriptor.settings.find((candidate) => candidate.kind === "agent" && candidate.role === "make");
    const parsed = definition?.parseSettings(node.settings);
    if (!definition || !field || !parsed?.ok) continue;
    const settings = parsed.settings as Record<string, unknown>;
    if (field.showWhen && !field.showWhen.in.includes(String(settings[field.showWhen.key] ?? (definition.descriptor.defaults as Record<string, unknown> | undefined)?.[field.showWhen.key] ?? ""))) continue;
    if (agentPickOf({ agent: typeof settings[field.key] === "string" ? (settings[field.key] as string) : undefined }).agent) continue;
    scopes.add(definition.descriptor.id);
  }
  return [...scopes];
}
