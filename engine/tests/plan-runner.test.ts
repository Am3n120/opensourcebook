/**
 * The plan runner over fake engines, the real output runner, the real queue
 * consumer and the real SQL: level order, parallel levels, branches taken
 * and not, failure isolation, cancel mid-plan and repeated completions.
 */
import { describe, expect, it } from "vitest";
import { JobFailure } from "../src/jobs/lifecycle";
import { ConditionRegistry, createDefaultConditions } from "../src/studio/conditions";
import { PlanMakerChangeError, PlanNotRunnableError, PlanRunner } from "../src/studio/plan-runner";
import { agentField, reviewerField } from "../src/engines/agent-fields";
import { FormatRegistry } from "../src/studio/registry";
import type { NewPlanNode, PlanNode } from "../src/studio/repositories";
import type { EngineContext } from "../src/studio/types";
import { createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition, type FakeEngineScript } from "./support/fake-engine";
import { gate, until } from "./support/job-harness";

type Script = (ctx: EngineContext) => FakeEngineScript;

async function setup(options: { script?: Script; conditions?: ConditionRegistry } = {}) {
  const log = emptyLog();
  const script = options.script ?? (() => ({}));
  const agentic = fakeDefinition("guide", log, script);
  const registry = new FormatRegistry()
    .register(fakeDefinition("bits", log, script))
    .register(fakeDefinition("quiz", log, script))
    .register(fakeDefinition("read", log, script))
    // A format its maker's agent makes, with a reviewer: the agent fields of agent-fields.ts.
    .register({ ...agentic, descriptor: { ...agentic.descriptor, settings: [agentField("chat"), reviewerField()] } })
    .declare({ id: "video", label: "video", colorSlot: 1, icon: "play", settings: [], defaults: {} });
  const engine = createTestEngine({ registry });
  const { repos } = engine.deps;
  const project = await repos.projects.create({ ownerId: "owner", title: "Calculus" });
  const { source } = await engine.deps.sources.add({ ownerId: "owner", projectId: project.id, text: "Limits and continuity." });
  const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id, title: "Unit 1" });

  const queue: string[] = [];
  const runner = new PlanRunner({
    repos,
    jobs: engine.deps.jobs,
    registry,
    schedule: async (jobId) => void queue.push(jobId),
    ...(options.conditions ? { conditions: options.conditions } : {}),
  });
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };

  const add = async (title: string, fields: Partial<NewPlanNode> & { level: number }): Promise<PlanNode> => {
    const node = await repos.plans.addNode({ planId: plan.id, ord: 0, type: "bits", title, ...fields });
    await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
    return node;
  };
  const approve = () => repos.plans.setStatus(plan.id, "approved");
  const status = async () => Object.fromEntries((await repos.plans.listNodes(plan.id)).map((node) => [node.title, node.status]));
  const titlesQueued = async () => {
    const titles: string[] = [];
    for (const id of queue) titles.push(String((await engine.deps.jobs.get(id))!.input.title));
    return titles;
  };
  /** Delivers everything queued, including what each completion queues, in order. */
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  const contextOf = (title: string) => log.contexts.find((ctx) => ctx.node.title === title)!;
  const nodeNamed = async (title: string) => (await repos.plans.listNodes(plan.id)).find((node) => node.title === title)!;
  /** What a player would record when the person finishes an item, then the advance that follows. */
  const finish = async (title: string, result?: Parameters<typeof repos.results.set>[1]["result"]) => {
    await repos.results.set((await nodeNamed(title)).id, { done: true, ...(result === undefined ? {} : { result }) });
    return runner.advance(plan.id);
  };
  return { engine, log, runner, plan, source, queue, add, approve, status, titlesQueued, drain, contextOf, nodeNamed, finish };
}

describe("plan runner: order", () => {
  it("runs levels in order, a level's nodes side by side, and settles the plan", async () => {
    const t = await setup();
    await t.add("Intro video", { level: 0, ord: 0 });
    await t.add("Intro reading", { level: 0, ord: 1, type: "read" });
    await t.add("Deeper bits", { level: 1 });
    await t.approve();

    const started = await t.runner.kickOff(t.plan.id);
    expect(started.plan.status).toBe("running");
    expect(started.plan.kickedOffAt).toBeDefined();
    expect(await t.titlesQueued()).toEqual(["Intro video", "Intro reading"]);
    expect(await t.status()).toEqual({ "Intro video": "queued", "Intro reading": "queued", "Deeper bits": "pending" });

    // One of level 0 finishing is not enough to start level 1.
    await t.engine.deliver(t.queue.shift()!);
    expect(await t.status()).toEqual({ "Intro video": "done", "Intro reading": "queued", "Deeper bits": "pending" });
    expect(t.queue).toHaveLength(1);

    await t.engine.deliver(t.queue.shift()!);
    expect(await t.titlesQueued()).toEqual(["Deeper bits"]);
    await t.drain();

    expect(await t.status()).toEqual({ "Intro video": "done", "Intro reading": "done", "Deeper bits": "done" });
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("done");
    // Same level: nothing assumed. Next level: both earlier outputs.
    expect(t.contextOf("Intro video").assumes).toEqual([]);
    expect(t.contextOf("Intro reading").assumes).toEqual([]);
    expect(t.contextOf("Deeper bits").assumes.map((prior) => prior.title).sort()).toEqual(["Output for Intro reading", "Output for Intro video"]);
    const outputs = await t.engine.deps.repos.outputs.listByProject(t.plan.projectId);
    expect(outputs).toHaveLength(3);
    expect(outputs.every((output) => output.nodeId && output.costUsd! > 0)).toBe(true);
  });

  it("passes node sources, prompt and settings, explicit assumes edges and fix inputs", async () => {
    const t = await setup();
    const check = await t.add("Check 1", { level: 0, type: "quiz", prompt: "Ten questions.", settings: { questions: 10 } });
    const extra = await t.add("Background", { level: 0, ord: 1 });
    const fix = await t.add("Fix", { level: 1, enabled: true });
    await t.engine.deps.repos.plans.addEdge({ fromNode: check.id, toNode: fix.id, kind: "fix_of" });
    await t.engine.deps.repos.plans.addEdge({ fromNode: extra.id, toNode: fix.id, kind: "assumes" });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    await t.drain();

    const checkCtx = t.contextOf("Check 1");
    expect(checkCtx.node).toMatchObject({ id: check.id, prompt: "Ten questions.", settings: { questions: 10 } });
    expect(checkCtx.sources.map((source) => source.sourceId)).toEqual([t.source.id]);
    const fixCtx = t.contextOf("Fix");
    expect(new Set(fixCtx.assumes.map((prior) => prior.nodeId))).toEqual(new Set([check.id, extra.id]));
    const checkOutput = await t.engine.deps.repos.outputs.latestForNode(check.id);
    expect(fixCtx.inputs).toEqual([{ kind: "fix_of", nodeId: check.id, type: "quiz", outputId: checkOutput!.id }]);
  });

  it("makes every edge that is not assumes an input, with the person's result once recorded", async () => {
    const t = await setup();
    const check = await t.add("Check 1", { level: 0, type: "quiz" });
    const notes = await t.add("Notes", { level: 0, ord: 1, type: "read" });
    const fix = await t.add("Fix", { level: 1, parentId: check.id, condition: { kind: "metric", metric: "score", below: 0.7 } });
    const { repos } = t.engine.deps;
    await repos.plans.addEdge({ fromNode: check.id, toNode: fix.id, kind: "fix_of" });
    await repos.plans.addEdge({ fromNode: notes.id, toNode: fix.id, kind: "continuesFrom" });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    await t.drain();
    await t.finish("Check 1", { score: 0.4, missed: ["q3"] });
    await t.drain();

    const [checkOutput, notesOutput] = await Promise.all([repos.outputs.latestForNode(check.id), repos.outputs.latestForNode(notes.id)]);
    const inputs = t.contextOf("Fix").inputs;
    expect(inputs).toHaveLength(2);
    expect(inputs).toEqual(
      expect.arrayContaining([
        { kind: "fix_of", nodeId: check.id, type: "quiz", outputId: checkOutput!.id, result: { score: 0.4, missed: ["q3"] } },
        { kind: "continuesFrom", nodeId: notes.id, type: "read", outputId: notesOutput!.id },
      ]),
    );
  });

  it("skips an unchecked node and never offers it as something to assume", async () => {
    const t = await setup();
    await t.add("Kept", { level: 0 });
    await t.add("Unchecked", { level: 0, ord: 1, enabled: false });
    await t.add("Later", { level: 1 });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    expect(await t.titlesQueued()).toEqual(["Kept"]);
    await t.drain();
    expect(await t.status()).toEqual({ Kept: "done", Unchecked: "skipped", Later: "done" });
    expect(t.contextOf("Later").assumes.map((prior) => prior.title)).toEqual(["Output for Kept"]);
  });
});

describe("plan runner: branches", () => {
  async function branchPlan(condition: Record<string, unknown> = { metric: "score", below: 0.7 }, conditions?: ConditionRegistry) {
    const t = await setup({ ...(conditions ? { conditions } : {}) });
    const check = await t.add("Check", { level: 0, type: "quiz" });
    const fix = await t.add("Fix", { level: 1, parentId: check.id, condition: condition as never });
    await t.add("Retry", { level: 2, type: "quiz", parentId: fix.id });
    await t.add("Next topic", { level: 3 });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    await t.drain();
    return t;
  }

  it("waits on the person's result, then takes the branch when the score is below the threshold (shape written before kinds)", async () => {
    const t = await branchPlan();
    const fix = await t.nodeNamed("Fix");
    expect((await t.runner.advance(t.plan.id)).waitingOnResult).toEqual([fix.id]);
    expect(await t.status()).toEqual({ Check: "done", Fix: "pending", Retry: "pending", "Next topic": "pending" });

    // Done without a score: still waiting.
    expect((await t.finish("Check")).waitingOnResult).toEqual([fix.id]);
    await t.finish("Check", { score: 0.5 });
    await t.drain();
    expect(await t.status()).toEqual({ Check: "done", Fix: "done", Retry: "done", "Next topic": "done" });
  });

  it("skips the branch, and what hangs off it, when the score is at or above the threshold", async () => {
    const t = await branchPlan({ kind: "metric", metric: "score", below: 0.7 });
    await t.finish("Check", { score: 0.7 });
    await t.drain();
    expect(await t.status()).toEqual({ Check: "done", Fix: "skipped", Retry: "skipped", "Next topic": "done" });
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("done");
  });

  it("reads atLeast as the other side of the threshold", async () => {
    const t = await branchPlan({ kind: "metric", metric: "score", atLeast: 0.9 });
    await t.finish("Check", { score: 0.95 });
    await t.drain();
    expect(await t.status()).toMatchObject({ Fix: "done" });
  });

  it("asks the person: waits for the answer on the branch item, then runs or skips", async () => {
    const yes = await branchPlan({ kind: "ask", question: "More practice?" });
    await yes.finish("Check", { score: 0.9 });
    const fix = await yes.nodeNamed("Fix");
    expect((await yes.runner.advance(yes.plan.id)).waitingOnResult).toEqual([fix.id]);
    await yes.engine.deps.repos.results.set(fix.id, { result: { answer: true } });
    await yes.runner.advance(yes.plan.id);
    await yes.drain();
    expect(await yes.status()).toMatchObject({ Fix: "done", Retry: "done" });
    // The person's own result on the fix replaces the answer; the decision stands.
    await yes.finish("Fix", { score: 1 });
    await yes.drain();
    expect(await yes.status()).toMatchObject({ Fix: "done", Retry: "done" });

    const no = await branchPlan({ kind: "ask" });
    await no.engine.deps.repos.results.set((await no.nodeNamed("Fix")).id, { result: { answer: false } });
    await no.runner.advance(no.plan.id);
    await no.drain();
    expect(await no.status()).toMatchObject({ Fix: "skipped", Retry: "skipped", "Next topic": "done" });
  });

  it("decides a kind through whatever resolver is registered for it", async () => {
    const seen: string[] = [];
    const conditions = createDefaultConditions().register<{ kind: "always" }>({
      kind: "always",
      parse: () => ({ kind: "always" }),
      decide: (_condition, { node, parent, resultOf }) => {
        seen.push(`${node.title} on ${parent.title}, result ${JSON.stringify(resultOf(parent.id)?.result ?? null)}`);
        return "run";
      },
    });
    const t = await branchPlan({ kind: "always" }, conditions);
    await t.drain();
    expect(await t.status()).toMatchObject({ Fix: "done" });
    expect(seen).toEqual(["Fix on Check, result null"]);
  });
});

describe("branch conditions", () => {
  const conditions = createDefaultConditions();
  const issue = (value: unknown) => conditions.parse(value as never);

  it("reads each built-in kind strictly, and the old shape as metric", () => {
    expect(issue({ metric: "score", below: 0.7 })).toMatchObject({ kind: "metric", condition: { kind: "metric", metric: "score", below: 0.7 } });
    expect(issue({ kind: "metric", metric: "score", atLeast: 0.7 })).toMatchObject({ condition: { atLeast: 0.7 } });
    expect(issue({ kind: "ask" })).toMatchObject({ kind: "ask", condition: { kind: "ask" } });
    expect(issue({ metric: "score", above: 0.7 })).toMatch(/unknown field "above"/);
    expect(issue({ metric: "score", below: 0.5, atLeast: 0.7 })).toMatch(/exactly one/);
    expect(issue({ metric: "", below: 1 })).toMatch(/metric/);
    expect(issue({ metric: "score", below: "0.7" })).toMatch(/below/);
    expect(issue({ kind: "ask", question: "" })).toMatch(/question/);
    expect(issue("score < 0.7")).toMatch(/object/);
    expect(issue({ kind: "written", text: "if I struggled" })).toMatch(/no resolver/);
  });

  it("refuses a kind twice or a kind that is not an id", () => {
    expect(() => createDefaultConditions().register({ kind: "ask", parse: () => ({}), decide: () => "run" })).toThrow(/already/);
    expect(() => new ConditionRegistry().register({ kind: "Not ok", parse: () => ({}), decide: () => "run" })).toThrow(/not a condition kind/);
    expect(createDefaultConditions().kinds()).toEqual(["metric", "ask"]);
  });
});

describe("plan runner: failure and cancel", () => {
  it("keeps going around a failed node, skipping only what depends on it", async () => {
    const t = await setup({ script: (ctx) => (ctx.node.title === "Broken" ? { failWith: new JobFailure("engine gave up", false) } : {}) });
    const broken = await t.add("Broken", { level: 0 });
    await t.add("Fine", { level: 0, ord: 1 });
    const dependent = await t.add("Needs broken", { level: 1 });
    await t.engine.deps.repos.plans.addEdge({ fromNode: broken.id, toNode: dependent.id, kind: "assumes" });
    await t.add("Independent", { level: 1, ord: 1 });
    await t.add("Child of broken", { level: 2, parentId: broken.id });
    await t.approve();

    await t.runner.kickOff(t.plan.id);
    await t.drain();
    expect(await t.status()).toEqual({
      Broken: "failed",
      Fine: "done",
      "Needs broken": "skipped",
      Independent: "done",
      "Child of broken": "skipped",
    });
    expect(t.contextOf("Independent").assumes.map((prior) => prior.title)).toEqual(["Output for Fine"]);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("failed");
  });

  it("makes a failed item again on request: the plan runs again and what waited on it is decided again", async () => {
    let broken = true;
    const t = await setup({ script: (ctx) => (ctx.node.title === "Broken" && broken ? { failWith: new JobFailure("engine gave up", false) } : {}) });
    const first = await t.add("Broken", { level: 0 });
    const dependent = await t.add("Needs broken", { level: 1 });
    await t.engine.deps.repos.plans.addEdge({ fromNode: first.id, toNode: dependent.id, kind: "assumes" });
    await t.add("Done already", { level: 0, ord: 1 });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    await t.drain();
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("failed");
    // Only a failed item can be made again.
    await expect(t.runner.retryItem(t.plan.id, (await t.nodeNamed("Done already")).id)).rejects.toBeInstanceOf(PlanNotRunnableError);

    broken = false;
    await t.runner.retryItem(t.plan.id, first.id);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("running");
    expect(await t.status()).toMatchObject({ Broken: "queued", "Needs broken": "pending", "Done already": "done" });
    await t.drain();
    expect(await t.status()).toEqual({ Broken: "done", "Needs broken": "done", "Done already": "done" });
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("done");
  });

  it("holds a node whose job will be redelivered as running, then fails it when the queue gives up", async () => {
    const t = await setup({ script: (ctx) => (ctx.node.title === "Flaky" ? { failWith: new Error("timeout") } : {}) });
    await t.add("Flaky", { level: 0 });
    await t.add("Later", { level: 1 });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    const jobId = t.queue.shift()!;
    expect(await t.engine.deliver(jobId)).toBe("retry");
    await t.runner.advance(t.plan.id);
    expect(await t.status()).toEqual({ Flaky: "running", Later: "pending" });

    const job = (await t.engine.deps.jobs.get(jobId))!;
    await t.engine.deps.jobs.compareAndSet(jobId, job.version, { status: "dead", retryable: false });
    await t.runner.onJobFinished((await t.engine.deps.jobs.get(jobId))!);
    await t.drain();
    expect(await t.status()).toEqual({ Flaky: "failed", Later: "done" });
  });

  it("cancels its queued and running jobs mid-plan and starts nothing after", async () => {
    const hold = gate();
    let holding = false;
    const t = await setup({
      script: (ctx) => (ctx.node.title === "Slow" ? { holdGenerate: async () => void ((holding = true), await hold.promise) } : {}),
    });
    await t.add("Slow", { level: 0 });
    await t.add("Waiting", { level: 0, ord: 1 });
    await t.add("Later", { level: 1 });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    const [slowJob, waitingJob] = t.queue.splice(0);

    const running = t.engine.deliver(slowJob);
    await until(() => holding, "the slow node to start generating");
    const cancelled = await t.runner.cancel(t.plan.id);
    expect(cancelled.plan.status).toBe("cancelled");
    expect(await t.status()).toEqual({ Slow: "cancelled", Waiting: "cancelled", Later: "cancelled" });
    expect((await t.engine.deps.jobs.get(slowJob))!.status).toBe("cancelled");
    expect((await t.engine.deps.jobs.get(waitingJob))!.status).toBe("cancelled");

    hold.open();
    expect(await running).toBe("ack");
    expect(await t.engine.deliver(waitingJob)).toBe("ack");
    expect(t.queue).toEqual([]);
    expect(await t.engine.deps.repos.outputs.listByProject(t.plan.projectId)).toEqual([]);
    expect(await t.status()).toEqual({ Slow: "cancelled", Waiting: "cancelled", Later: "cancelled" });
  });

  it("queues nothing twice when a completion is delivered twice", async () => {
    const t = await setup();
    await t.add("First", { level: 0 });
    await t.add("Second", { level: 1 });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    const first = t.queue.shift()!;
    await t.engine.deliver(first);
    expect(await t.titlesQueued()).toEqual(["Second"]);

    // The same completion again: a duplicate queue message, then the listener directly.
    await t.engine.deliver(first);
    await t.runner.onJobFinished((await t.engine.deps.jobs.get(first))!);
    await t.runner.kickOff(t.plan.id);
    expect(await t.titlesQueued()).toEqual(["Second"]);
    await t.drain();
    expect(t.log.generates).toBe(2);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("done");
  });
});

describe("plan runner: what it refuses", () => {
  it("only kicks off an approved plan", async () => {
    const t = await setup();
    await t.add("Only", { level: 0 });
    await expect(t.runner.kickOff(t.plan.id)).rejects.toBeInstanceOf(PlanNotRunnableError);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.kickedOffAt).toBeUndefined();
  });

  it("refuses edges and parents that are not on a lower level, and malformed conditions", async () => {
    const t = await setup();
    const a = await t.add("A", { level: 0 });
    const b = await t.add("B", { level: 0, ord: 1 });
    await t.add("C", { level: 1, parentId: a.id, condition: { metric: "score", over: 0.5 } });
    await t.add("D", { level: 1, ord: 1, condition: { metric: "score", below: 0.5 } });
    await t.add("E", { level: 1, ord: 2, parentId: a.id, condition: { kind: "written", text: "if I struggled" } });
    await t.engine.deps.repos.plans.addEdge({ fromNode: a.id, toNode: b.id, kind: "assumes" });
    await t.approve();
    const error = await t.runner.kickOff(t.plan.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanNotRunnableError);
    const issues = (error as PlanNotRunnableError).issues;
    expect(issues).toEqual(
      expect.arrayContaining([
        '"B" must be in a later stage than "A", which it uses',
        expect.stringMatching(/^"C": .*unknown field "over"/),
        expect.stringMatching(/^"E": .*no resolver decides condition kind "written"/),
        '"D" has a condition but no earlier item to test it on',
      ]),
    );
    // Each names its item by title in words and carries the item's id beside it.
    expect(issues.join(" ")).not.toMatch(/node |[0-9a-f]{8}-[0-9a-f]{4}/);
    const details = (error as PlanNotRunnableError).details;
    expect(details).toContainEqual({
      code: "edge_source_not_earlier",
      message: '"B" must be in a later stage than "A", which it uses',
      short: 'Must be in a later stage than "A", which it uses',
      itemId: b.id,
    });
    // Each kind of issue has its own code, and the short words never repeat the item's own title.
    expect(details.map((issue) => issue.code).sort()).toEqual(["condition_invalid", "condition_invalid", "condition_without_parent", "edge_source_not_earlier"]);
    for (const issue of details) expect(issue.short).not.toContain(`"${issue.message.match(/^"([^"]+)"/)![1]}"`);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("approved");
    expect(t.queue).toEqual([]);
  });

  it("refuses at Start an enabled node whose format no engine makes, declared or unknown", async () => {
    const t = await setup();
    await t.add("Made", { level: 0 });
    const declared = await t.add("Declared only", { level: 0, ord: 1, type: "video" });
    const unknown = await t.add("Unknown", { level: 1, type: "slides" });
    await t.approve();
    const error = await t.runner.kickOff(t.plan.id).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlanNotRunnableError);
    expect((error as PlanNotRunnableError).details).toEqual([
      { code: "format_not_ready", message: `"Declared only": Open Sourcebook can't make a video yet`, short: "Open Sourcebook can't make a video yet", itemId: declared.id },
      { code: "format_not_ready", message: `"Unknown": Open Sourcebook can't make a slides yet`, short: "Open Sourcebook can't make a slides yet", itemId: unknown.id },
    ]);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("approved");
    expect(t.queue).toEqual([]);
  });

  it("starts a plan whose only unmakeable node is unchecked", async () => {
    const t = await setup();
    await t.add("Made", { level: 0 });
    await t.add("Unchecked", { level: 0, ord: 1, type: "slides", enabled: false });
    await t.approve();
    const started = await t.runner.kickOff(t.plan.id);
    expect(started.plan.status).toBe("running");
    expect(await t.titlesQueued()).toEqual(["Made"]);
  });

  it("settles an empty plan at once", async () => {
    const t = await setup();
    await t.approve();
    expect((await t.runner.kickOff(t.plan.id)).plan.status).toBe("done");
  });
});

describe("plan runner: askOf", () => {
  it("names the question of an undecided ask branch and nothing else", async () => {
    const t = await setup();
    const parent = await t.add("Check", { level: 0, type: "quiz" });
    await t.add("Plain", { level: 0, ord: 1 });
    await t.add("More?", { level: 1, parentId: parent.id, condition: { kind: "ask", question: "More practice?" } });
    await t.add("Worded by client", { level: 1, ord: 1, parentId: parent.id, condition: { kind: "ask" } });
    await t.add("Low score", { level: 1, ord: 2, parentId: parent.id, condition: { kind: "metric", metric: "score", below: 0.5 } });
    const [check, plain, more, worded, low] = await Promise.all(["Check", "Plain", "More?", "Worded by client", "Low score"].map(t.nodeNamed));
    expect(t.runner.askOf(more)).toEqual({ question: "More practice?" });
    expect(t.runner.askOf(worded)).toEqual({});
    expect(t.runner.askOf(low)).toBeUndefined();
    expect(t.runner.askOf(check)).toBeUndefined();
    expect(t.runner.askOf(plain)).toBeUndefined();
    expect(t.runner.askOf({ ...more, status: "done" })).toBeUndefined();
  });
});

describe("plan runner: changing who makes what is left", () => {
  it("gives a stopped plan's items not made yet the new maker, clears their old steps, and Resume makes them with it", async () => {
    const hold = gate();
    let holding = false;
    const t = await setup({
      script: (ctx) => (ctx.node.title === "Stopped" && !ctx.node.settings ? {} : ctx.node.title === "Stopped" && !(ctx.node.settings as Record<string, unknown>).agent ? { holdGenerate: async () => void ((holding = true), await hold.promise) } : {}),
    });
    await t.add("Made", { level: 0, type: "guide", settings: { agent: "agent:claude", effort: "max" } });
    await t.add("Stopped", { level: 0, ord: 1, type: "guide", settings: { effort: "max" } });
    await t.add("Plain", { level: 0, ord: 2 });
    await t.add("Later", { level: 1, type: "guide" });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    const [madeJob, stoppedJob, plainJob] = t.queue.splice(0);
    await t.engine.deliver(madeJob!);
    const running = t.engine.deliver(stoppedJob!);
    await until(() => holding, "the stopped item to start");
    await t.runner.cancel(t.plan.id);
    hold.open();
    await running;
    await t.engine.deliver(plainJob!);
    // Steps the old maker saved.
    const before = (await t.engine.deps.jobs.get(stoppedJob!))!;
    await t.engine.deps.jobs.compareAndSet(before.id, before.version, { state: { kept: "old maker's steps" } });

    const result = await t.runner.changeMaker(t.plan.id, { agent: "agent:codex:gpt-5", effort: "high", reviewer: "off" });
    expect(result.changed.sort()).toEqual([(await t.nodeNamed("Stopped")).id, (await t.nodeNamed("Later")).id].sort());
    expect(result.unchanged).toEqual([{ itemId: (await t.nodeNamed("Plain")).id, why: "Made without your agent" }]);
    expect((await t.nodeNamed("Made")).settings).toEqual({ agent: "agent:claude", effort: "max" });
    expect((await t.nodeNamed("Stopped")).settings).toEqual({ agent: "agent:codex:gpt-5", effort: "high", reviewer: "off" });
    const job = (await t.engine.deps.jobs.get(stoppedJob!))!;
    expect(job.status).toBe("cancelled");
    expect(job.state).toEqual({});
    expect(job.attempt).toBe(0);
    expect((job.input.settings as Record<string, unknown>).agent).toBe("agent:codex:gpt-5");
    expect(t.queue).toEqual([]);

    await t.runner.resume(t.plan.id);
    await t.drain();
    expect((t.log.contexts.filter((ctx) => ctx.node.title === "Stopped").at(-1)!.node.settings as Record<string, unknown>).agent).toBe("agent:codex:gpt-5");
    expect((t.contextOf("Later").node.settings as Record<string, unknown>).agent).toBe("agent:codex:gpt-5");
  });

  it("refuses a running plan and a finished one", async () => {
    const t = await setup();
    await t.add("One", { level: 0, type: "guide" });
    await t.approve();
    await t.runner.kickOff(t.plan.id);
    await expect(t.runner.changeMaker(t.plan.id, { agent: "agent:codex" })).rejects.toMatchObject({ code: "plan_running" });
    await t.drain();
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("done");
    await expect(t.runner.changeMaker(t.plan.id, { agent: "agent:codex" })).rejects.toBeInstanceOf(PlanMakerChangeError);
  });

  it("works before Start, sending an approved plan back to draft, and back to the defaults with null", async () => {
    const t = await setup();
    await t.add("One", { level: 0, type: "guide", settings: { agent: "agent:claude", effort: "max", reviewer: "agent:claude" } });
    await t.add("Two", { level: 0, ord: 1, type: "guide" });
    const draft = await t.runner.changeMaker(t.plan.id, { agent: "agent:codex", items: [(await t.nodeNamed("Two")).id] });
    expect(draft.changed).toEqual([(await t.nodeNamed("Two")).id]);
    expect((await t.nodeNamed("One")).settings).toMatchObject({ agent: "agent:claude" });
    await t.approve();
    await t.runner.changeMaker(t.plan.id, { agent: null });
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("draft");
    // The reviewer is left as it was when the change does not name it.
    expect((await t.nodeNamed("One")).settings).toEqual({ reviewer: "agent:claude" });
  });

  it("refuses settings the format does not take, changing nothing", async () => {
    const t = await setup();
    const strict = await t.add("One", { level: 0, type: "guide" });
    const definition = (t.runner as unknown as { options: { registry: FormatRegistry } }).options.registry.get("guide")!;
    const parse = definition.parseSettings;
    (definition as { parseSettings: typeof parse }).parseSettings = (raw) =>
      (raw as Record<string, unknown>).agent === "agent:nobody" ? { ok: false, issues: [{ path: "$.agent", code: "format", message: "no such agent", severity: "error" }] } : parse(raw);
    await expect(t.runner.changeMaker(t.plan.id, { agent: "agent:nobody" })).rejects.toMatchObject({ code: "invalid_settings" });
    expect((await t.nodeNamed("One")).settings).toEqual(strict.settings);
    await expect(t.runner.changeMaker(t.plan.id, { agent: null, items: ["nope"] })).rejects.toMatchObject({ code: "invalid_request" });
  });
});
