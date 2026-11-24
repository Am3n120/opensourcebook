/**
 * The August /v1/jobs API as a wrapper over sources and generation jobs.
 * Requests are built the way the iOS GenerationService builds them, and
 * responses are checked against what its RemoteJob decoder requires: an
 * August stage, a status, a numeric progress, and on success a `result`
 * whose `id` equals `resultByteID` (a UUID). `result` stays the version 1
 * page for that build; `cards` carries the set of flashcards for builds that read it.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { LEGACY_STAGES, legacyStage } from "../src/routes/jobs";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { StructuredGenerationRequest } from "../src/types";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine, type TestEngine } from "./support/engine-harness";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Answers Open Sourcebook's own writer's plan and section prompts with one valid section. */
function setAnswer(request: StructuredGenerationRequest): unknown {
  if (request.userPrompt.includes("Plan sections")) {
    return {
      type: "note",
      title: "Evidence note",
      subtitle: "Source",
      tags: ["test"],
      sections: [{ id: "main", title: "Main", purpose: "Teach it", suggestedBlocks: ["text"] }],
    };
  }
  if (request.userPrompt.includes("Write only section")) {
    return { sectionID: "main", cards: [{ kind: "recall", front: [{ type: "text", text: "What does the note explain?" }], back: [{ type: "text", text: "Supported explanation" }] }] };
  }
  throw new Error(`unexpected prompt for ${request.task}`);
}

function setup(options: { queue?: boolean } = {}) {
  const registry = createDefaultRegistry({
    flashcards: {
      sleep: async () => undefined,
      verify: async () => ({ checked: [], failures: [], warnings: [], mediaChecked: 0, chartErrors: [], valid: true }),
      research: async () => ({ summary: "", claims: [], references: [], limitations: [] }),
    },
  });
  return createTestEngine({ registry, answer: setAnswer, ...options });
}

/** The body iOS's CreateJobRequest encodes: nil optionals are left out. */
function iosBody(fields: { sourceText: string; sourceURL?: string; sourceKind?: string; projectId?: string; uploadId?: string }) {
  return { sourceKind: "note", requestedDepth: "auto", ...fields };
}

async function post(engine: TestEngine, body: unknown, key = "11111111-2222-4333-8444-555555555555") {
  return handleRequest(authed("/v1/jobs", { method: "POST", body, headers: { "idempotency-key": key } }), engine.deps, engine.ctx);
}

async function getJob(engine: TestEngine, id: string) {
  return bodyOf(await handleRequest(authed(`/v1/jobs/${id}`), engine.deps, engine.ctx));
}

describe("POST /v1/jobs", () => {
  it("queues a flashcards job for a pasted note and delivers a page the phone can decode, with the set beside it", async () => {
    const engine = setup();
    const created = await post(engine, iosBody({ sourceText: "A short note about one compact concept, with enough evidence to teach it." }));
    expect(created.status).toBe(202);
    const { job } = await bodyOf(created);
    expect(job).toMatchObject({ stage: "queued", status: "queued", progress: 0, retryable: false, sourceKind: "note", requestedDepth: "auto" });
    expect(job.resultByteID).toBeUndefined();

    const row = (await engine.deps.jobs.get(job.id))!;
    expect(row).toMatchObject({ kind: "output", type: "flashcards", ownerId: await ownerIdForToken(CLIENT_TOKEN) });
    expect(row.input.settings).toEqual({ depth: "auto" });
    const source = (await engine.deps.repos.sources.get(row.sourceId!))!;
    expect(source).toMatchObject({ kind: "note", origin: "share" });
    expect(source.projectId).toBeUndefined();

    await engine.settle();
    const { job: done } = await getJob(engine, job.id);
    expect(done).toMatchObject({ stage: "done", status: "done", progress: 1, retryable: false });
    expect(done.resultByteID).toMatch(UUID);
    expect(done.result.id).toBe(done.resultByteID);
    expect(done.result).toMatchObject({ title: "Evidence note", type: "note" });
    expect(done.result.blocks.length).toBeGreaterThan(0);
    expect(typeof done.result.byteDepth).toBe("string");
    expect(done.result.bits).toBeUndefined();
    expect(done.cards).toMatchObject({ schemaVersion: 3, id: done.resultByteID, title: "Evidence note", sourceKind: "note" });
    expect(done.cards.cards.length).toBeGreaterThan(0);
    expect(done.result.blocks).toEqual(done.cards.cards.flatMap((card: { front: unknown[]; back?: unknown[] }) => [...card.front, ...(card.back ?? [])]));
    const output = (await engine.deps.repos.outputs.get((await engine.deps.jobs.get(job.id))!.outputId!))!;
    expect(output).toMatchObject({ type: "flashcards", schemaVersion: 3, sources: [{ sourceId: source.id }] });
    expect(output.payload).toEqual(done.cards);
  });

  it("returns the first job for a repeated idempotency key, without a second source or run", async () => {
    const engine = setup({ queue: true });
    const first = await bodyOf(await post(engine, iosBody({ sourceText: "Same note" })));
    const again = await post(engine, iosBody({ sourceText: "Same note" }));
    expect(again.status).toBe(202);
    expect((await bodyOf(again)).job.id).toBe(first.job.id);
    expect(engine.sent).toEqual([first.job.id]);
    expect(await engine.deps.repos.sources.listInbox(await ownerIdForToken(CLIENT_TOKEN))).toHaveLength(1);
  });

  it("promotes a link shared as text and keeps the caption as extraction context", async () => {
    const engine = setup();
    const { job } = await bodyOf(await post(engine, iosBody({ sourceText: "look at this https://example.com/article.", sourceKind: "link" })));
    expect(job).toMatchObject({ sourceURL: "https://example.com/article", sourceText: "look at this", sourceKind: "link" });
    await engine.settle();
    expect(engine.extractor.calls).toHaveLength(1);
    expect(engine.extractor.calls[0]).toMatchObject({ sourceURL: "https://example.com/article", sourceText: "look at this" });
    expect((await getJob(engine, job.id)).job.status).toBe("done");
  });

  it("keeps the phone's project id on the job, and files the source when the engine knows the project", async () => {
    const engine = setup({ queue: true });
    const local = await bodyOf(await post(engine, iosBody({ sourceText: "Note", projectId: "8F0C6E9A-1111-4222-8333-444455556666" }), "key-local-project"));
    expect(local.job.projectId).toBe("8F0C6E9A-1111-4222-8333-444455556666");
    const localSource = (await engine.deps.repos.sources.get((await engine.deps.jobs.get(local.job.id))!.sourceId!))!;
    expect(localSource.projectId).toBeUndefined();

    const project = await engine.deps.repos.projects.create({ ownerId: await ownerIdForToken(CLIENT_TOKEN), title: "Known" });
    const known = await bodyOf(await post(engine, iosBody({ sourceText: "Other note", projectId: project.id }), "key-known-project"));
    const knownSource = (await engine.deps.repos.sources.get((await engine.deps.jobs.get(known.job.id))!.sourceId!))!;
    expect(knownSource.projectId).toBe(project.id);
  });

  it("reads an uploaded attachment by its upload id", async () => {
    const engine = setup();
    const upload = (await engine.deps.uploads.putUpload(new TextEncoder().encode("Lecture notes on one compact concept."), "text/plain", "notes.txt"))!;
    const { job } = await bodyOf(await post(engine, iosBody({ sourceText: "", uploadId: upload.id })));
    expect(job.uploadId).toBe(upload.id);
    await engine.settle();
    expect(engine.extractor.calls[0].uploadBytes?.contentType).toBe("text/plain");
    expect((await getJob(engine, job.id)).job.status).toBe("done");
  });

  it("answers August's error codes", async () => {
    const engine = setup();
    const noKey = await handleRequest(authed("/v1/jobs", { method: "POST", body: iosBody({ sourceText: "x" }) }), engine.deps);
    expect(noKey.status).toBe(401);
    expect(await bodyOf(noKey)).toMatchObject({ error: "idempotency_required" });
    const noToken = await handleRequest(
      new Request("https://engine.test/v1/jobs", { method: "POST", body: JSON.stringify(iosBody({ sourceText: "x" })), headers: { "idempotency-key": "k-12345678" } }),
      engine.deps,
    );
    expect(noToken.status).toBe(401);
    expect(await bodyOf(await post(engine, iosBody({ sourceText: "" }), "k-empty-01"))).toMatchObject({ error: "source_required" });
    expect(await bodyOf(await post(engine, { ...iosBody({ sourceText: "x" }), requestedDepth: "huge" }, "k-depth-01"))).toMatchObject({ error: "invalid_depth" });
    expect(await bodyOf(await post(engine, iosBody({ sourceText: "x", sourceKind: "nonsense" }), "k-kind-001"))).toMatchObject({ error: "invalid_source_kind" });
    expect((await handleRequest(authed("/v1/jobs/nope"), engine.deps)).status).toBe(404);
  });
});

describe("job status as the phone sees it", () => {
  it("maps every engine stage onto one of August's", () => {
    for (const stage of ["queued", "starting", "extracting", "researching", "structuring", "writing", "verifying", "repairing", "done", "something-new"]) {
      expect(LEGACY_STAGES).toContain(legacyStage(stage));
    }
    expect(legacyStage("starting")).toBe("extracting");
    expect(legacyStage("repairing")).toBe("verifying");
  });

  it("shows a retryable failure as still running while a queue will redeliver it", async () => {
    const engine = setup({ queue: true });
    const { job } = await bodyOf(await post(engine, iosBody({ sourceText: "Note" })));
    const claimed = (await engine.deps.jobs.get(job.id))!;
    const failed = await engine.deps.jobs.compareAndSet(job.id, claimed.version, {
      status: "failed",
      stage: "writing",
      progress: 0.4,
      retryable: true,
      errorMessage: "provider timed out",
    });
    expect(failed.ok).toBe(true);
    const view = (await getJob(engine, job.id)).job;
    expect(view).toMatchObject({ status: "running", stage: "writing", progress: 0.4 });
    expect(view.errorMessage).toBeUndefined();

    const inline = setup();
    const local = await bodyOf(await post(inline, iosBody({ sourceText: "Note" })));
    const row = (await inline.deps.jobs.get(local.job.id))!;
    await inline.deps.jobs.compareAndSet(row.id, row.version, { status: "failed", retryable: true, errorMessage: "provider timed out" });
    expect((await getJob(inline, local.job.id)).job).toMatchObject({
      status: "failed",
      stage: "failed",
      retryable: true,
      errorMessage: "Something went wrong while making this set of flashcards. Try again.",
      errorDetail: "provider timed out",
    });
  });
});

describe("cancel and retry", () => {
  it("cancels a queued job as August did, idempotently, and refuses a finished one", async () => {
    const engine = setup({ queue: true });
    const { job } = await bodyOf(await post(engine, iosBody({ sourceText: "Note" })));
    const cancelled = await handleRequest(authed(`/v1/jobs/${job.id}/cancel`, { method: "POST" }), engine.deps);
    expect(cancelled.status).toBe(200);
    expect((await bodyOf(cancelled)).job).toMatchObject({ status: "failed", stage: "failed", retryable: false, errorMessage: "Cancelled by user" });
    expect((await engine.deps.jobs.get(job.id))!.status).toBe("cancelled");
    expect((await handleRequest(authed(`/v1/jobs/${job.id}/cancel`, { method: "POST" }), engine.deps)).status).toBe(200);
    // The cancelled job's message is still in the queue; delivering it runs nothing.
    expect(await engine.deliver(job.id)).toBe("ack");
    expect(engine.provider.calls).toHaveLength(0);

    const other = await bodyOf(await post(engine, iosBody({ sourceText: "Other" }), "key-finished"));
    await engine.deliver(other.job.id);
    const refused = await handleRequest(authed(`/v1/jobs/${other.job.id}/cancel`, { method: "POST" }), engine.deps);
    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toMatchObject({ error: "already_done" });
  });

  it("retries a job the queue gave up on, and refuses one that failed for good", async () => {
    const engine = setup({ queue: true });
    const { job } = await bodyOf(await post(engine, iosBody({ sourceText: "Note" })));
    const row = (await engine.deps.jobs.get(job.id))!;
    await engine.deps.jobs.compareAndSet(job.id, row.version, { status: "dead", errorMessage: "The queue gave up after 4 attempts." });
    expect((await getJob(engine, job.id)).job).toMatchObject({ status: "failed", retryable: true });

    const retried = await handleRequest(authed(`/v1/jobs/${job.id}/retry`, { method: "POST" }), engine.deps, engine.ctx);
    expect(retried.status).toBe(202);
    expect((await bodyOf(retried)).job).toMatchObject({ status: "queued", stage: "queued" });
    await engine.settle();
    expect(engine.sent).toEqual([job.id, job.id]);
    await engine.deliver(job.id);
    expect((await getJob(engine, job.id)).job.status).toBe("done");

    const final = await bodyOf(await post(engine, iosBody({ sourceText: "Other" }), "key-final-failure"));
    const finalRow = (await engine.deps.jobs.get(final.job.id))!;
    await engine.deps.jobs.compareAndSet(final.job.id, finalRow.version, { status: "failed", retryable: false, errorMessage: "invalid" });
    const refused = await handleRequest(authed(`/v1/jobs/${final.job.id}/retry`, { method: "POST" }), engine.deps, engine.ctx);
    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toMatchObject({ error: "not_retryable" });
  });

  it("hides one client's jobs from another token", async () => {
    const engine = setup({ queue: true });
    const { job } = await bodyOf(await post(engine, iosBody({ sourceText: "Note" })));
    await engine.deps.jobs.create({ ownerId: "someone-else", idempotencyKey: "k-other-1", kind: "output", type: "read", input: {} });
    const theirs = (await engine.deps.jobs.findByKey("someone-else", "k-other-1"))!;
    expect((await handleRequest(authed(`/v1/jobs/${theirs.id}`), engine.deps)).status).toBe(404);
    expect((await handleRequest(authed(`/v1/jobs/${theirs.id}/cancel`, { method: "POST" }), engine.deps)).status).toBe(404);
    expect((await handleRequest(authed(`/v1/jobs/${job.id}`), engine.deps)).status).toBe(200);
  });
});
