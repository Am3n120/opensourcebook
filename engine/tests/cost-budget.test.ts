/**
 * Cost and budgets end to end: a real provider adapter with the shipped price
 * table writes usage rows, the output's cost is their sum, an unpriced model
 * is flagged, a job stops at its budget, and Start refuses an over-budget plan.
 */
import { describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import { BudgetExceededError, BudgetGuard } from "../src/providers/budget";
import { DeepSeekProvider } from "../src/providers/deepseek";
import { MODEL_PRICES } from "../src/providers/prices";
import { priceFor } from "../src/providers/usage";
import { OutputJobRunner } from "../src/studio/output-runner";
import { PlanNotRunnableError, PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import type { StructuredGenerationRequest, StructuredProvider, UsageSink } from "../src/types";
import { createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition } from "./support/fake-engine";

const TOKENS_IN = 1_000;
const TOKENS_OUT = 500;

/** A real DeepSeek adapter over a scripted upstream: every call reports 1000 tokens in, 500 out. */
function deepseekFactory(model: string, calls: { count: number }) {
  return (usage: UsageSink): StructuredProvider =>
    new DeepSeekProvider({
      apiKey: "k",
      model,
      prices: MODEL_PRICES,
      usageSink: usage,
      fetchImpl: async () => {
        calls.count += 1;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: TOKENS_IN, completion_tokens: TOKENS_OUT } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
}

async function setup(provider: (usage: UsageSink) => StructuredProvider) {
  const registry = new FormatRegistry().register(fakeDefinition("byte", emptyLog()));
  const engine = createTestEngine({ registry });
  const { repos, sources } = engine.deps;
  engine.deps.runners.output = new OutputJobRunner({
    repos,
    registry,
    sources,
    provider,
    assets: new AssetStore(engine.bucket),
    fetch: async () => new Response(null, { status: 200 }),
    now: engine.clock.iso,
  });
  const { source } = await sources.add({ ownerId: "owner", url: "https://example.com/a" });
  const queue = async (extra: Record<string, unknown> = {}) =>
    (
      await engine.deps.jobs.create({
        ownerId: "owner",
        idempotencyKey: "key-1",
        kind: "output",
        type: "byte",
        sourceId: source.id,
        input: { sources: [{ sourceId: source.id }], ...extra },
      })
    ).job;
  return { engine, queue };
}

describe("price table", () => {
  it("prices every model configured in wrangler.toml", () => {
    for (const model of ["gemini-3.6-flash", "deepseek-v4-flash", "google/gemini-3.6-flash"]) {
      expect(priceFor(MODEL_PRICES, model), model).toBeDefined();
    }
  });

  it("applies a scheduled price change on its date", () => {
    expect(priceFor(MODEL_PRICES, "gemini-3.6-flash", new Date("2026-12-31T12:00:00Z"))).toMatchObject({ inputPerMillion: 0.75 });
    expect(priceFor(MODEL_PRICES, "gemini-3.6-flash", new Date("2027-01-01T00:00:00Z"))).toMatchObject({ inputPerMillion: 1.5 });
    expect(priceFor(MODEL_PRICES, "no-such-model")).toBeUndefined();
  });
});

describe("cost", () => {
  it("a priced call writes a non-zero usd and the output's cost is the sum of its calls", async () => {
    const calls = { count: 0 };
    const { engine, queue } = await setup(deepseekFactory("deepseek-v4-flash", calls));
    const job = await queue();
    await engine.deliver(job.id);

    const done = (await engine.deps.jobs.get(job.id))!;
    expect(done.status).toBe("done");
    const perCall = (TOKENS_IN * 0.3 + TOKENS_OUT * 1.2) / 1_000_000;
    const totals = await engine.deps.repos.usage.totals("job", job.id);
    expect(totals.calls).toBe(2);
    expect(totals.usd).toBeCloseTo(2 * perCall, 9);
    expect(totals.unpricedCalls).toBe(0);
    const output = (await engine.deps.repos.outputs.get(done.outputId!))!;
    expect(output.costUsd).toBeGreaterThan(0);
    expect(output.costUsd).toBeCloseTo(totals.usd, 9);
  });

  it("flags a call to a model with no price instead of recording it as $0", async () => {
    const calls = { count: 0 };
    const { engine, queue } = await setup(deepseekFactory("some-unlisted-model", calls));
    const job = await queue();
    await engine.deliver(job.id);

    const done = (await engine.deps.jobs.get(job.id))!;
    expect(done.status).toBe("done");
    // The rows carry no usd (NULL, not 0) and the totals count them as unpriced.
    const rows = engine.db.raw.prepare("SELECT usd FROM usage WHERE job_id = ?").all(job.id) as Array<{ usd: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.usd === null)).toBe(true);
    expect(await engine.deps.repos.usage.totals("job", job.id)).toMatchObject({ calls: 2, unpricedCalls: 2, usd: 0 });
    expect(done.state.unpricedCalls).toBe(2);
  });
});

describe("job budget", () => {
  /** Each call spends $0.01 and is counted. */
  function spender(calls: { count: number }, usdPerCall = 0.01) {
    return (usage: UsageSink): StructuredProvider => ({
      name: "scripted",
      async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
        calls.count += 1;
        await usage.record({ provider: "scripted", model: "m", task: request.task, tokensIn: 1, tokensOut: 1, usd: usdPerCall, latencyMs: 1, ok: true });
        return {} as T;
      },
    });
  }

  it("ends the job with a budget failure and makes no further calls once the budget is reached", async () => {
    const calls = { count: 0 };
    const { engine, queue } = await setup(spender(calls));
    const job = await queue({ budgetUSD: 0.01 });
    expect(await engine.deliver(job.id)).toBe("ack");

    const failed = (await engine.deps.jobs.get(job.id))!;
    expect(failed).toMatchObject({ status: "failed", retryable: false });
    expect(failed.errorMessage).toMatch(/^Budget exceeded/);
    expect(calls.count).toBe(1);
    expect(failed.outputId).toBeUndefined();
    expect((await engine.deps.repos.usage.totals("job", job.id)).calls).toBe(1);
  });

  it("lets a job under its budget finish", async () => {
    const calls = { count: 0 };
    const { engine, queue } = await setup(spender(calls));
    const job = await queue({ budgetUSD: 0.05 });
    await engine.deliver(job.id);
    expect((await engine.deps.jobs.get(job.id))!.status).toBe("done");
    expect(calls.count).toBe(2);
  });

  it("does not reset the budget when a job is retried: earlier spend counts", async () => {
    const calls = { count: 0 };
    const { engine, queue } = await setup(spender(calls));
    const job = await queue({ budgetUSD: 0.015 });
    // An earlier attempt already spent $0.01 on this job.
    await engine.deps.repos.usage.record({ ownerId: "owner", jobId: job.id }, { provider: "scripted", model: "m", usd: 0.01, latencyMs: 1, ok: true });
    await engine.deliver(job.id);
    // One more call fits ($0.02 > $0.015 after it), then the next is refused.
    expect(calls.count).toBe(1);
    expect((await engine.deps.jobs.get(job.id))!.errorMessage).toMatch(/^Budget exceeded/);
  });

  it("applies to optional capabilities too, so no engine path skips it", () => {
    const calls = { count: 0 };
    const base = spender(calls)({ record() {} });
    const provider = {
      ...base,
      async describeImage() {
        calls.count += 1;
        return { title: "x" };
      },
    };
    const guard = new BudgetGuard({ record() {} }, 0.01, 0.01);
    expect(() => guard.guard(provider).describeImage()).toThrow(/Budget exceeded/);
    expect(calls.count).toBe(0);
    expect(guard.exceeded).toBeInstanceOf(BudgetExceededError);
  });
});

describe("plan budget", () => {
  async function planSetup(budgetUsd: number | undefined, estimates: number[]) {
    const registry = new FormatRegistry().register(fakeDefinition("byte", emptyLog()));
    const engine = createTestEngine({ registry });
    const { repos } = engine.deps;
    const project = await repos.projects.create({ ownerId: "owner", title: "P" });
    const { source } = await engine.deps.sources.add({ ownerId: "owner", projectId: project.id, text: "Text." });
    const plan = await repos.plans.create({ ownerId: "owner", projectId: project.id, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    for (const [index, estCostUsd] of estimates.entries()) {
      const node = await repos.plans.addNode({ planId: plan.id, level: 0, ord: index, type: "byte", title: `Item ${index}`, estCostUsd });
      await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
    }
    await repos.plans.setStatus(plan.id, "approved");
    const queued: string[] = [];
    const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (id) => void queued.push(id) });
    return { engine, plan, runner, queued };
  }

  it("Start refuses a plan whose estimate is over its budget, and nothing is queued", async () => {
    const t = await planSetup(0.5, [0.3, 0.3]);
    await expect(t.runner.kickOff(t.plan.id)).rejects.toThrow(PlanNotRunnableError);
    await expect(t.runner.kickOff(t.plan.id)).rejects.toThrow(/estimated cost \$0\.60 is over the plan budget \$0\.50/);
    expect((await t.engine.deps.repos.plans.get(t.plan.id))!.status).toBe("approved");
    expect(t.queued).toEqual([]);
  });

  it("starts a plan within its budget and caps each job at what the plan has left", async () => {
    const t = await planSetup(0.5, [0.2, 0.2]);
    await t.runner.kickOff(t.plan.id);
    expect(t.queued).toHaveLength(2);
    const job = (await t.engine.deps.jobs.get(t.queued[0]))!;
    expect(job.input.budgetUSD).toBe(0.5);
  });

  it("starts a plan with no budget as before", async () => {
    const t = await planSetup(undefined, [100]);
    await t.runner.kickOff(t.plan.id);
    expect((await t.engine.deps.jobs.get(t.queued[0]))!.input.budgetUSD).toBeUndefined();
  });
});
