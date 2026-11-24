/**
 * The runner for `kind = 'output'` jobs, driven through the real queue
 * consumer and job store, with a fake engine and real SQL.
 */
import { describe, expect, it } from "vitest";
import { PipelineError } from "../src/engines/retry";
import { failureWords } from "../src/jobs/failure-words";
import { summarizeReport } from "../src/studio/output-runner";
import { FormatRegistry } from "../src/studio/registry";
import type { FormatDescriptor } from "../src/studio/types";
import type { JsonObject } from "../src/jobs/types";
import { CLIENT_TOKEN, PROVIDER_CALL_USD, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { settle, type DraftPlan } from "../src/chat/planning/draft";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { timeBucket } from "../src/studio/timing";
import { parseVideoSettings } from "../src/engines/video/definition";
import { parseAudioSettings } from "../src/engines/audio/settings";
import { emptyLog, fakeDefinition, type FakeEngineScript } from "./support/fake-engine";

async function setup(script?: (ctx: never) => FakeEngineScript, descriptor?: Partial<FormatDescriptor>) {
  const log = emptyLog();
  const registry = new FormatRegistry().register(fakeDefinition("byte", log, script as never, descriptor));
  const engine = createTestEngine({ registry });
  const { source } = await engine.deps.sources.add({ ownerId: "owner", url: "https://example.com/a" });
  const queue = async (input: JsonObject = {}, extra: { projectId?: string; key?: string } = {}) =>
    (
      await engine.deps.jobs.create({
        ownerId: "owner",
        idempotencyKey: extra.key ?? "key-1",
        kind: "output",
        type: "byte",
        ...(extra.projectId ? { projectId: extra.projectId } : {}),
        sourceId: source.id,
        input: { sources: [{ sourceId: source.id }], ...input },
      })
    ).job;
  return { engine, log, source, queue };
}

describe("output job runner", () => {
  it("extracts the sources, runs the engine and writes the output with its cost", async () => {
    const { engine, log, source, queue } = await setup();
    const project = await engine.deps.repos.projects.create({ ownerId: "owner", title: "Calculus" });
    const job = await queue(
      { title: "Limits", prompt: "Start from the definition.", settings: { depth: "light" }, contextText: "shared caption" },
      { projectId: project.id },
    );

    expect(await engine.deliver(job.id)).toBe("ack");

    const done = (await engine.deps.jobs.get(job.id))!;
    expect(done).toMatchObject({ status: "done", stage: "done", progress: 1 });
    expect(engine.extractor.calls).toHaveLength(1);
    expect(engine.extractor.calls[0].sourceText).toBe("shared caption");

    const [ctx] = log.contexts;
    expect(ctx.node).toMatchObject({ id: job.id, type: "byte", title: "Limits", prompt: "Start from the definition.", settings: { depth: "light" } });
    expect(ctx.sources[0]).toMatchObject({ sourceId: source.id, envelope: { text: "Text of https://example.com/a" } });
    expect(ctx.sources[0].chunks).toHaveLength(1);
    expect(ctx.project).toEqual({ id: project.id, title: "Calculus" });

    const output = (await engine.deps.repos.outputs.get(done.outputId!))!;
    expect(output).toMatchObject({
      ownerId: "owner",
      projectId: project.id,
      type: "byte",
      schemaVersion: 1,
      title: "Output for Limits",
      summary: "Covers Limits.",
      prompt: "Start from the definition.",
      settings: { depth: "light" },
      sources: [{ sourceId: source.id }],
      citations: [{ sourceId: source.id }],
      costUsd: 2 * PROVIDER_CALL_USD,
    });
    expect(output.payload).toMatchObject({ sourceTexts: ["Text of https://example.com/a"] });
    const usage = await engine.deps.repos.usage.totals("job", job.id);
    expect(usage).toMatchObject({ calls: 2, tokensIn: 200, tokensOut: 100 });
    expect(usage.usd).toBeCloseTo(2 * PROVIDER_CALL_USD);
  });

  it("keeps the step an engine says in plain words on the job while it runs", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reported!: () => void;
    const said = new Promise<void>((resolve) => (reported = resolve));
    const { engine, queue } = await setup(() => ({
      holdGenerate: async (ctx) => {
        await ctx.services.progress({ stage: "writing", progress: 0.5, step: "Writing scene 2 of 5" });
        await ctx.services.progress({ stage: "writing", progress: 0.6, step: "Writing scene 2 of 5" });
        reported();
        await held;
      },
    }));
    const job = await queue();
    const delivery = engine.deliver(job.id);
    await said;
    const running = (await engine.deps.jobs.get(job.id))!;
    expect(running.state.step).toBe("Writing scene 2 of 5");
    expect(running.stage).toBe("writing");
    release();
    expect(await delivery).toBe("ack");
  });

  it("leaves an unknown project off the output but keeps it on the job", async () => {
    const { engine, queue } = await setup();
    const job = await queue({}, { projectId: "phone-local-project" });
    await engine.deliver(job.id);
    const done = (await engine.deps.jobs.get(job.id))!;
    expect(done.projectId).toBe("phone-local-project");
    expect((await engine.deps.repos.outputs.get(done.outputId!))!.projectId).toBeUndefined();
  });

  it("fails for good, with the report summarized, when the output is still invalid after the last repair", async () => {
    const { engine, queue } = await setup(() => ({ alwaysInvalid: true }));
    const job = await queue();
    expect(await engine.deliver(job.id)).toBe("ack");
    const failed = (await engine.deps.jobs.get(job.id))!;
    expect(failed).toMatchObject({ status: "failed", retryable: false });
    expect(failed.errorMessage).toBe("Output failed validation after 1 repair round: $.lines: no lines (empty)");
    expect(failed.outputId).toBeUndefined();
  });

  it("resumes a redelivered job from its saved blueprint, without planning again", async () => {
    let attempts = 0;
    const { engine, log, queue } = await setup(() => (attempts++ === 0 ? { failWith: new Error("provider timed out") } : {}));
    const job = await queue();
    expect(await engine.deliver(job.id)).toBe("retry");
    expect((await engine.deps.jobs.get(job.id))!).toMatchObject({ status: "failed", retryable: true, errorMessage: "provider timed out" });
    expect((await engine.deps.jobs.get(job.id))!.state.blueprint).toBeDefined();

    expect(await engine.deliver(job.id)).toBe("ack");
    expect((await engine.deps.jobs.get(job.id))!.status).toBe("done");
    expect(log.plans).toBe(1);
    expect(log.generates).toBe(2);
    expect(engine.extractor.calls).toHaveLength(1);
  });

  it("plans again a job a stand-in Open Sourcebook no longer has started, and one whose saved blueprint its format no longer reads", async () => {
    for (const mark of [{ mode: "mock" }, { stale: true }]) {
      const log = emptyLog();
      const definition = { ...fakeDefinition("byte", log), keepsBlueprint: (blueprint: unknown) => !(blueprint as { stale?: boolean }).stale };
      const engine = createTestEngine({ registry: new FormatRegistry().register(definition) });
      const { source } = await engine.deps.sources.add({ ownerId: "owner", url: "https://example.com/a" });
      const { job } = await engine.deps.jobs.create({ ownerId: "owner", idempotencyKey: "old", kind: "output", type: "byte", sourceId: source.id, input: { sources: [{ sourceId: source.id }] } });
      // What an old attempt left: a blueprint (from the stand-in, or a maker taken out) and a draft built on it.
      const blueprint: JsonObject = "mode" in mark ? { scene: "one page" } : { stale: true };
      const state: JsonObject = { blueprint, checkpoints: { draft: { output: { title: "old" }, repairRounds: 0 } }, ...("mode" in mark ? { mode: mark.mode } : {}) };
      expect((await engine.deps.jobs.compareAndSet(job.id, job.version, { state })).ok).toBe(true);

      expect(await engine.deliver(job.id)).toBe("ack");
      const done = (await engine.deps.jobs.get(job.id))!;
      expect(done.status, JSON.stringify(mark)).toBe("done");
      expect(log.plans).toBe(1);
      expect(log.generates).toBe(1);
      expect(done.state.blueprint).toEqual({ outline: [source.id] });
      expect(done.state.mode ?? null).toBeNull();
      expect((await engine.deps.repos.outputs.get(done.outputId!))!.title).not.toBe("old");
    }
  });

  it("continues a retried job from its last whole output: no second generate, then drops what it kept", async () => {
    const box: { log?: { repairs: number } } = {};
    const { engine, log, queue } = await setup(() => ({ invalidUntilRepaired: true, ...(box.log?.repairs === 1 ? { failRepair: new Error("provider timed out") } : {}) }));
    box.log = log;
    const job = await queue();
    expect(await engine.deliver(job.id)).toBe("retry");
    const failed = (await engine.deps.jobs.get(job.id))!;
    expect(failed.state.checkpoints).toMatchObject({ draft: { repairRounds: 0, output: { payload: { sourceTexts: ["Text of https://example.com/a"] } } } });

    expect(await engine.deliver(job.id)).toBe("ack");
    const done = (await engine.deps.jobs.get(job.id))!;
    expect(done.status).toBe("done");
    expect(log.generates).toBe(1);
    expect(log.repairs).toBe(2);
    expect(done.state.checkpoints).toBeNull();
  });

  it("keeps what each validation found on the job, so repair reasons can be counted", async () => {
    const { engine, queue } = await setup(() => ({ invalidUntilRepaired: true }));
    const job = await queue();
    expect(await engine.deliver(job.id)).toBe("ack");
    const done = (await engine.deps.jobs.get(job.id))!;
    expect(done.state.validation).toEqual([
      { attempt: 1, round: 0, valid: false, errors: 1, warnings: 0, codes: { empty: 1 }, issues: [{ path: "$.lines", code: "empty", message: "no lines" }] },
      { attempt: 1, round: 1, valid: true, errors: 0, warnings: 0, codes: {}, issues: [] },
    ]);
  });

  it("ends a job at once on an engine error a retry cannot change, such as no source text", async () => {
    const { engine, queue } = await setup(() => ({ failWith: new PipelineError("Only the title and details of this item's sources could be read.", "NO_SOURCE_TEXT") }));
    const job = await queue();
    expect(await engine.deliver(job.id)).toBe("ack");
    expect((await engine.deps.jobs.get(job.id))!).toMatchObject({ status: "failed", retryable: false, errorMessage: "Only the title and details of this item's sources could be read." });
  });

  it("does not write a second output when the job is run again after its output was written", async () => {
    const { engine, queue } = await setup();
    const job = await queue();
    await engine.deliver(job.id);
    const first = (await engine.deps.jobs.get(job.id))!;
    // As if the completion write had been lost: the row goes back to queued with its state.
    await engine.deps.jobs.compareAndSet(job.id, first.version, { status: "queued", outputId: null });
    await engine.deliver(job.id);
    const again = (await engine.deps.jobs.get(job.id))!;
    expect(again.outputId).toBe(first.outputId);
    expect(await engine.deps.repos.outputs.listByOwner("owner")).toHaveLength(1);
  });

  it("fails for good on a missing source, a format with no engine or unusable settings", async () => {
    const { engine, queue } = await setup();
    const missing = await queue({ sources: [{ sourceId: "nope" }] }, { key: "k-missing" });
    const badSettings = await queue({ settings: "loud" }, { key: "k-settings" });
    const unknownType = (
      await engine.deps.jobs.create({ ownerId: "owner", idempotencyKey: "k-type", kind: "output", type: "video", input: { sources: [] } })
    ).job;
    for (const job of [missing, badSettings, unknownType]) await engine.deliver(job.id);
    expect(await engine.deps.jobs.get(missing.id)).toMatchObject({ status: "failed", retryable: false, errorMessage: "Source nope does not exist." });
    expect((await engine.deps.jobs.get(badSettings.id))!.errorMessage).toMatch(/^Invalid settings/);
    expect((await engine.deps.jobs.get(unknownType.id))!.errorMessage).toBe('No engine is registered for format "video".');
    // Each says what happened in words for the person; the technical text stays on the job.
    const words = async (id: string, thing: string) => failureWords((await engine.deps.jobs.get(id))!, thing);
    expect(await words(missing.id, "byte")).toBe("A source this byte reads is gone or could not be read. Pick its sources again, then try again.");
    expect(await words(badSettings.id, "byte")).toMatch(/^(The settings on this byte could not be used|Something in how this byte was set up could not be read)/);
    expect(await words(unknownType.id, "video")).toBe("This kind of item can't be made here yet. Change its format, or try again later.");
  });

  it("says an engine error's cause in words: no source text", async () => {
    const { engine, queue } = await setup(() => ({ failWith: new PipelineError("A byte needs source text to plan from.", "NO_SOURCE_TEXT") }));
    const job = await queue();
    await engine.deliver(job.id);
    expect(failureWords((await engine.deps.jobs.get(job.id))!, "byte")).toBe(
      "The sources of this byte have no text that could be read, so there was nothing to make it from. Pick a source with text, then try again.",
    );
  });

  it("retries while another request holds the source's extraction", async () => {
    const { engine, source, queue } = await setup();
    await engine.deps.repos.sources.claimExtraction(source.contentHash, engine.clock.iso());
    const job = await queue();
    expect(await engine.deliver(job.id)).toBe("retry");
    expect((await engine.deps.jobs.get(job.id))!).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("summarizeReport", () => {
  it("keeps one making time for a done job, under the pick the maker named, and none for a job with no timing", async () => {
    const timing = { seconds: 42, agent: "claude", model: "opus", effort: "high" };
    const { engine, queue } = await setup((ctx: { node: { title: string } }) => (ctx.node.title === "timed" ? { timing } : {}));
    const timed = await queue({ title: "timed" }, { key: "k-timed" });
    const untimed = await queue({ title: "untimed" }, { key: "k-untimed" });
    expect(await engine.deliver(timed.id)).toBe("ack");
    expect(await engine.deliver(untimed.id)).toBe("ack");
    expect(await engine.deps.repos.makeTimes.summary("owner")).toEqual([
      { scope: "byte", agent: "claude", model: "opus", effort: "high", runs: 1, seconds: 42, lastAt: expect.any(String) },
    ]);
  });

  it("keeps no time for a job that failed", async () => {
    const { engine, queue } = await setup(() => ({ alwaysInvalid: true, timing: { seconds: 9, agent: "claude" } }));
    const job = await queue();
    await engine.deliver(job.id);
    expect((await engine.deps.jobs.get(job.id))!.status).toBe("failed");
    expect(await engine.deps.repos.makeTimes.summary("owner")).toEqual([]);
  });

  it("keeps a review's time under the review's own scope and pick, and a length under its bucket", async () => {
    const timing = { seconds: 100, agent: "claude", model: "opus", review: { seconds: 20, agent: "codex", model: "gpt-5" } };
    const { engine, queue } = await setup(() => ({ timing }), {
      timing: { setting: "minutes", edges: [2, 4] },
      defaults: { minutes: 3 },
    });
    const job = await queue({ settings: { minutes: 3 } });
    await engine.deliver(job.id);
    const times = await engine.deps.repos.makeTimes.summary("owner");
    expect(times).toEqual([
      { scope: "byte", agent: "claude", model: "opus", bucket: "le4", runs: 1, seconds: 100, lastAt: expect.any(String) },
      { scope: "byte.review", agent: "codex", model: "gpt-5", bucket: "le4", runs: 1, seconds: 20, lastAt: expect.any(String) },
    ]);
  });

  it("keeps a length left on Auto under \"auto\" after settle fills it in, where the web looks it up, and a Custom length under its number", async () => {
    const shape = { timing: { setting: "minutes", edges: [2, 4] }, defaults: { minutes: 0 } };
    const log = emptyLog();
    const definition = { ...fakeDefinition("byte", log, (() => ({ timing: { seconds: 60, agent: "claude" } })) as never, shape), settle: (settings: Record<string, unknown>) => (settings.minutes === 0 ? { minutes: 3 } : {}) };
    const registry = new FormatRegistry().register(definition as never);
    const engine = createTestEngine({ registry });
    const owner = await ownerIdForToken(CLIENT_TOKEN);
    const { source } = await engine.deps.sources.add({ ownerId: owner, url: "https://example.com/a" });
    const item = (key: string, minutes: number) => ({ key, existing: false, level: 0, ord: 0, type: "byte", title: key, prompt: "", settings: { minutes }, sources: [], enabled: true });
    const draft = { labels: new Map(), items: [item("auto", 0), item("custom", 5)], edges: [] } as unknown as DraftPlan;
    const services = { registry, conditions: {} as never, projectSources: new Set<string>(), loadSource: async () => undefined };
    const settled = await settle(draft, services);
    // What the plan shows is the filled-in length, as before.
    expect(settled).toEqual([{ key: "auto", title: "auto", values: { minutes: 3 } }]);
    expect(draft.items[0]!.settings.minutes).toBe(3);
    // Settling again keeps the marker.
    await settle(draft, services);
    for (const it of draft.items) {
      const job = (await engine.deps.jobs.create({ ownerId: owner, idempotencyKey: it.key, kind: "output", type: "byte", sourceId: source.id, input: { sources: [{ sourceId: source.id }], settings: it.settings as JsonObject } })).job;
      expect(await engine.deliver(job.id)).toBe("ack");
    }
    const body = await bodyOf(await handleRequest(authed("/v1/make-times?scope=byte"), engine.deps));
    const buckets = body.times.map((time: { bucket: string }) => time.bucket).sort();
    expect(buckets).toEqual(["auto", "gt4"]);
    // The key the web asks for when the length is on Auto finds that run.
    const asked = timeBucket(shape, { minutes: 0 });
    expect(body.times.find((time: { bucket: string }) => time.bucket === asked)).toMatchObject({ agent: "claude", runs: 1, seconds: 60 });
    // A length changed since settling is its own, not Auto.
    expect(timeBucket(shape, { ...draft.items[0]!.settings, minutes: 2 })).toBe("le2");
    // Video and audio settings keep the marker, so their jobs record under "auto" too.
    expect(parseVideoSettings({ minutes: 1.5, autoLength: 1.5 })).toMatchObject({ ok: true, settings: { minutes: 1.5, autoLength: 1.5 } });
    expect(parseAudioSettings({ minutes: 6, autoLength: 6 })).toMatchObject({ ok: true, settings: { minutes: 6, autoLength: 6 } });
  });

  it("does not keep a time for a length-bucketed shape whose length is unknown", async () => {
    const { engine, queue } = await setup(() => ({ timing: { seconds: 5, agent: "claude" } }), { timing: { setting: "minutes", edges: [2, 4] } });
    const job = await queue({ settings: {} });
    await engine.deliver(job.id);
    expect(await engine.deps.repos.makeTimes.summary("owner")).toEqual([]);
  });

  it("lists the first errors and counts the rest; warnings are left out", () => {
    const issues = Array.from({ length: 7 }, (_, index) => ({ path: `$.b[${index}]`, code: "x", message: "bad", severity: "error" as const }));
    const summary = summarizeReport({ valid: false, issues: [...issues, { path: "$", code: "w", message: "meh", severity: "warning" }] }, 2);
    expect(summary).toBe(
      "Output failed validation after 2 repair rounds: $.b[0]: bad (x); $.b[1]: bad (x); $.b[2]: bad (x); $.b[3]: bad (x); $.b[4]: bad (x); and 2 more",
    );
  });
});
