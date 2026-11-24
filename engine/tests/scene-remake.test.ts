/**
 * Making one scene of a made video again (docs/api.md, "Remaking one scene"): over HTTP, with the real plan runner,
 * output runner and scenes maker, and a fake scenes service. The remake is an ordinary job on the video's own item
 * that writes a new output there; the old one stays until it does, and is then archived in the new one's place.
 */
import { afterEach, describe, expect, it } from "vitest";
import { videoDefinitionFor } from "../src/engines/video/definition";
import { VideoMakerRegistry } from "../src/engines/video/makers";
import { forgetScenesStatus, refreshScenesStatus, ScenesClient } from "../src/engines/video/scenes/client";
import { createScenesMaker } from "../src/engines/video/scenes/maker";
import { handleRequest } from "../src/index";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { FakeScenesService } from "./support/fake-scenes";

const TEXT = "Sunlight scatters off the small molecules of the air, and blue light scatters the most because its waves are short.\n\nAt sunset the light crosses far more air, so the blue is scattered away before it reaches you and the reds remain.";
const DRAFT_GONE = "What this video was made from is no longer on this computer, so one scene of it can't be made again. Make the whole video again instead.";

afterEach(() => forgetScenesStatus());

async function setup() {
  const service = new FakeScenesService({ stepsPerRead: 50 });
  const client = new ScenesClient({ url: "http://127.0.0.1:8660", token: service.token }, service.fetch);
  const makers = new VideoMakerRegistry().register(createScenesMaker({ client, pollMs: 0, sleep: async () => undefined }));
  const registry = new FormatRegistry().register(videoDefinitionFor(makers));
  await refreshScenesStatus(client);
  const engine = createTestEngine({ registry, queue: true });
  engine.deps.videoMakers = makers;
  const runner = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void engine.sent.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps, engine.ctx);
    return { status: response.status, body: await bodyOf(response) };
  };
  const drain = async () => {
    for (let next = engine.sent.shift(); next; next = engine.sent.shift()) {
      engine.clock.advance(1000);
      await engine.deliver(next);
    }
  };
  const project = (await call("/v1/projects", "POST", { title: "Sky" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: TEXT, projectId: project.id })).body.source;
  const plan = (await call(`/v1/projects/${project.id}/plans`, "POST", {})).body.plan;
  const item = (await call(`/v1/plans/${plan.id}/items`, "POST", {
    type: "video",
    title: "Why the sky is blue",
    level: 0,
    prompt: "Explain the colours of the sky.",
    settings: { minutes: 1, aspect: "portrait", style: "chalkboard", agent: "agent:codex:gpt-6", effort: "high" },
    sources: [{ sourceId: source.id }],
  })).body.items[0];
  await call(`/v1/plans/${plan.id}/approve`, "POST");
  await call(`/v1/plans/${plan.id}/start`, "POST");
  await drain();
  const made = (await call(`/v1/plans/${plan.id}/progress`)).body.items.find((one: any) => one.id === item.id);
  return { service, engine, call, drain, plan, item, made };
}

describe("remaking one scene of a made video", () => {
  it("serves which scenes a made video has and that one can be made again", async () => {
    const t = await setup();
    expect(t.made.status).toBe("done");
    const output = (await t.call(`/v1/outputs/${t.made.outputId}`)).body.output;
    expect(output.remakesScene).toBe(true);
    expect(output.remakeOf).toBeUndefined();
    expect(output.payload.scenes.map((scene: any) => scene.id)).toEqual(["s1"]);
    // The job that made it kept the video's id on the service once its pieces were spent.
    const job = await t.engine.deps.jobs.findByOutput!(t.made.outputId);
    expect(job!.state.kept).toEqual({ "scenes:video": job!.id });
  });

  it("makes a new output on the same item from a copy on the service, in the person's words, with the pick it was made with", async () => {
    const t = await setup();
    const old = t.made.outputId;
    const asked = await t.call(`/v1/outputs/${old}/scenes/s1/remake`, "POST", { note: "show the reds, not a box" });
    expect(asked.status).toBe(202);
    expect(asked.body).toEqual({ job: { id: expect.any(String), status: "queued", stage: "queued", progress: 0 }, remakeOf: { outputId: old, scene: "s1" } });

    // While it is made: the item still shows the old video, and says a scene of it is being made again.
    const during = (await t.call(`/v1/plans/${t.plan.id}/progress`)).body.items[0];
    expect(during.outputId).toBe(old);
    expect(during.remaking).toMatchObject({ outputId: old, scene: "s1", note: "show the reds, not a box", job: { id: asked.body.job.id, status: "queued" } });
    expect((await t.call(`/v1/outputs/${old}/scenes/s1/remake`, "POST", {})).body.error).toBe("being_made");

    await t.drain();
    const madeBy = (await t.engine.deps.jobs.findByOutput!(old))!.id;
    const copy = t.service.videos.get(asked.body.job.id)!;
    expect(copy.remake).toEqual({ of: madeBy, beat: "s1", note: "show the reds, not a box" });
    expect(copy.body).toMatchObject({ agent: "codex", model: "gpt-6", effort: "high" });
    // The old video on the service is as it was.
    expect(t.service.videos.get(madeBy)!.state).toBe("done");

    const after = (await t.call(`/v1/plans/${t.plan.id}/progress`)).body.items[0];
    expect(after.remaking).toBeUndefined();
    expect(after.outputId).not.toBe(old);
    const remade = (await t.call(`/v1/outputs/${after.outputId}`)).body.output;
    expect(remade).toMatchObject({ itemId: t.item.id, planId: t.plan.id, remakeOf: { outputId: old, scene: "s1" }, remakesScene: true });
    expect(remade.payload.scenes[0].narration).toMatch(/Made again\.$/);
    expect((await t.call(`/v1/outputs/${old}`)).body.output.payload.scenes[0].narration).not.toMatch(/Made again/);
    // The old output stays.
    expect((await t.call(`/v1/outputs/${old}`)).status).toBe(200);
    // And the remake can be remade, through what its own job kept.
    expect((await t.call(`/v1/outputs/${after.outputId}/scenes/s1/remake`, "POST", { agent: "claude" })).status).toBe(202);
    await t.drain();
    const again = [...t.service.videos.values()].find((video) => video.remake?.of === asked.body.job.id)!;
    expect(again.remake?.beat).toBe("s1");
    expect(again.body.agent).toBe("claude");
    expect(again.body).not.toHaveProperty("model");
  });

  it("puts the new video in the old one's place once it is made: the old one is archived, lists show only the new one, and a done tick that named the old one names the new one", async () => {
    const t = await setup();
    const old = t.made.outputId;
    const projectId = (await t.engine.deps.repos.outputs.get(old))!.projectId!;
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${t.item.id}/done`, "POST", { outputId: old })).status).toBe(200);
    const asked = await t.call(`/v1/outputs/${old}/scenes/s1/remake`, "POST", {});
    // Until the new one is written, the old one is the item's and is in every list.
    expect((await t.call(`/v1/plans/${t.plan.id}/outputs`)).body.outputs.map((one: any) => one.id)).toEqual([old]);
    await t.drain();
    const item = (await t.call(`/v1/plans/${t.plan.id}/progress`)).body.items[0];
    const fresh = item.outputId;
    expect(fresh).not.toBe(old);
    expect((await t.engine.deps.jobs.findByOutput!(fresh))!.id).toBe(asked.body.job.id);
    // The done tick follows it.
    expect(item.done).toBe(true);
    expect((await t.engine.deps.repos.results.get(t.item.id))!.outputId).toBe(fresh);
    // Made here, the project's list and the Library show only the new one.
    expect((await t.call(`/v1/plans/${t.plan.id}/outputs`)).body.outputs.map((one: any) => one.id)).toEqual([fresh]);
    expect((await t.call(`/v1/projects/${projectId}/outputs`)).body.outputs.map((one: any) => one.id)).toEqual([fresh]);
    expect((await t.call(`/v1/outputs`)).body.outputs.map((one: any) => one.id)).toEqual([fresh]);
    expect((await t.call(`/v1/outputs`)).body.outputs[0].done).toBe(true);
    // The old one is archived, not gone: it still opens and plays for what points at it.
    const kept = await t.call(`/v1/outputs/${old}`);
    expect(kept.status).toBe(200);
    expect(kept.body.output.archivedAt).toEqual(expect.any(String));
    expect(kept.body.output.payload.render.url).toEqual(expect.any(String));
  });

  it("leaves a done tick that names no output as it is, and the new one, the newest left, is the item's and ticked", async () => {
    const t = await setup();
    const old = t.made.outputId;
    expect((await t.call(`/v1/plans/${t.plan.id}/items/${t.item.id}/done`, "POST", {})).status).toBe(200);
    expect((await t.engine.deps.repos.results.get(t.item.id))!.outputId).toBeUndefined();
    await t.call(`/v1/outputs/${old}/scenes/s1/remake`, "POST", {});
    await t.drain();
    const item = (await t.call(`/v1/plans/${t.plan.id}/progress`)).body.items[0];
    expect(item.outputId).not.toBe(old);
    expect(item.done).toBe(true);
    expect((await t.engine.deps.repos.results.get(t.item.id))!.outputId).toBeUndefined();
  });

  it("is stopped like any job, and the item then shows the old video with nothing being made", async () => {
    const t = await setup();
    const asked = await t.call(`/v1/outputs/${t.made.outputId}/scenes/s1/remake`, "POST", {});
    expect((await t.call(`/v1/jobs/${asked.body.job.id}/cancel`, "POST")).status).toBe(200);
    const item = (await t.call(`/v1/plans/${t.plan.id}/progress`)).body.items[0];
    expect(item.remaking).toBeUndefined();
    expect(item.outputId).toBe(t.made.outputId);
    expect((await t.call(`/v1/outputs/${t.made.outputId}/scenes/s1/remake`, "POST", {})).status).toBe(202);
  });

  it("answers 404 for an unknown output or scene, and refuses plainly when the draft is gone or the video cannot", async () => {
    const t = await setup();
    expect((await t.call(`/v1/outputs/nope/scenes/s1/remake`, "POST", {})).status).toBe(404);
    expect((await t.call(`/v1/outputs/${t.made.outputId}/scenes/s9/remake`, "POST", {})).status).toBe(404);
    expect((await t.call(`/v1/outputs/${t.made.outputId}/scenes/s1/remake`, "POST", { note: 5 })).status).toBe(400);

    t.service.options.draftGone = true;
    const gone = await t.call(`/v1/outputs/${t.made.outputId}/scenes/s1/remake`, "POST", {});
    expect(gone).toEqual({ status: 409, body: expect.objectContaining({ error: "cannot_remake", message: DRAFT_GONE }) });

    // A video made a way that cannot remake a part (an old storyboard): no scene can be made again, and it says so.
    const output = (await t.call(`/v1/outputs/${t.made.outputId}`)).body.output;
    const ownerId = (await t.engine.deps.repos.outputs.get(t.made.outputId))!.ownerId;
    const board = await t.engine.deps.repos.outputs.create({ ownerId, type: "video", schemaVersion: 1, title: "Board", payload: { ...output.payload, render: { ...output.payload.render, by: "storyboard", storyboard: true } } });
    expect((await t.call(`/v1/outputs/${board.id}`)).body.output.remakesScene).toBeUndefined();
    const refused = await t.call(`/v1/outputs/${board.id}/scenes/s1/remake`, "POST", {});
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("cannot_remake");
  });
});
