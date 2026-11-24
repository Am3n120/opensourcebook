/**
 * A video as a plan item, end to end through the Studio API, made by its
 * real maker (the scenes maker) over a fake scenes service: the format is
 * served as ready only when a maker is set up, the item runs through the
 * plan runner, ticks done, shows in the plan's outputs with its file, and
 * the file is served in byte ranges. A retried item the storyboard maker
 * (taken out of Open Sourcebook) once planned is made by the maker Open Sourcebook picks now.
 */
import { afterEach, describe, expect, it } from "vitest";
import { forgetScenesStatus, refreshScenesStatus, ScenesClient } from "../src/engines/video/scenes/client";
import { createScenesMaker } from "../src/engines/video/scenes/maker";
import { handleRequest } from "../src/index";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { PlanRunner } from "../src/studio/plan-runner";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { FakeScenesService } from "./support/fake-scenes";
import { V1, V2 } from "./support/sky-text";

const SERVICE = "http://127.0.0.1:8660";

async function setup(options: { video?: boolean } = {}) {
  const service = new FakeScenesService({ stepsPerRead: 20 });
  const client = new ScenesClient({ url: SERVICE, token: service.token }, service.fetch);
  await refreshScenesStatus(client);
  const maker = createScenesMaker({ client, pollMs: 0, sleep: async () => undefined });
  const registry = options.video === false ? createDefaultRegistry() : createDefaultRegistry({ video: { makers: [maker] } });
  const engine = createTestEngine({ registry });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const call = async (path: string, method = "GET", body?: unknown, headers?: Record<string, string>) =>
    handleRequest(authed(path, { method, ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body }) }), engine.deps);
  const json = async (path: string, method = "GET", body?: unknown) => bodyOf(await call(path, method, body));
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  const project = (await json("/v1/projects", "POST", { title: "Physics" })).project;
  const source = (await json("/v1/sources", "POST", { text: `${V1}\n\n${V2}`, projectId: project.id })).source;
  const plan = (await json(`/v1/projects/${project.id}/plans`, "POST", { title: "Light" })).plan;
  return { engine, service, call, json, drain, queue, project, source, plan };
}

afterEach(() => forgetScenesStatus());

describe("a video plan item", () => {
  it("is served as ready with its settings when a maker is set up, and not otherwise", async () => {
    const on = await setup();
    const formats = (await on.json("/v1/formats")).formats;
    expect(formats.find((format: { id: string }) => format.id === "video")).toMatchObject({ ready: true, defaults: { minutes: 0, aspect: "portrait" } });

    const off = await setup({ video: false });
    expect((await off.json("/v1/formats")).formats.find((format: { id: string }) => format.id === "video")).toMatchObject({ ready: false, settings: [] });
  });

  it("is run by the plan runner, ticked done and listed with its file, served in byte ranges", async () => {
    const t = await setup();
    const added = await t.json(`/v1/plans/${t.plan.id}/items`, "POST", {
      type: "video", title: "Why blue", level: 0, prompt: "Explain why the sky is blue.", settings: { minutes: 0.5 }, sources: [{ sourceId: t.source.id }],
    });
    const item = added.items[0];

    expect((await t.call(`/v1/plans/${t.plan.id}/approve`, "POST")).status).toBe(200);
    expect((await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).status).toBe(200);
    await t.drain();

    const view = await t.json(`/v1/plans/${t.plan.id}`);
    const ran = view.items.find((entry: { id: string }) => entry.id === item.id);
    expect(ran.status).toBe("done");
    expect(ran.outputId).toBeTruthy();

    const listed = (await t.json(`/v1/plans/${t.plan.id}/outputs`)).outputs;
    expect(listed.map((output: { type: string }) => output.type)).toEqual(["video"]);

    const { output } = await t.json(`/v1/outputs/${ran.outputId}`);
    expect(output.schemaVersion).toBe(1);
    expect(output.payload.render).toMatchObject({ by: "scenes", storyboard: false, contentType: "video/mp4" });

    const done = await t.call(`/v1/plans/${t.plan.id}/items/${item.id}/done`, "POST", { done: true, outputId: output.id });
    expect(done.status).toBe(200);

    const whole = await t.call(output.payload.render.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    const size = (await whole.arrayBuffer()).byteLength;
    const part = await t.call(output.payload.render.url, "GET", undefined, { range: "bytes=2-5" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 2-5/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(4);
    expect((await t.call(output.payload.render.url, "GET", undefined, { range: `bytes=${size}-` })).status).toBe(416);
  });

  it("asked of the storyboard maker, which Open Sourcebook took out, is made by the real maker, and so is a retry of a job it planned", async () => {
    const t = await setup();
    const added = await t.json(`/v1/plans/${t.plan.id}/items`, "POST", {
      type: "video", title: "Why blue", level: 0, prompt: "Explain why the sky is blue.", settings: { maker: "storyboard" }, sources: [{ sourceId: t.source.id }],
    });
    const item = added.items[0];
    expect((await t.call(`/v1/plans/${t.plan.id}/approve`, "POST")).status).toBe(200);
    expect((await t.call(`/v1/plans/${t.plan.id}/start`, "POST")).status).toBe(200);
    // What an old attempt left on the job: the storyboard maker's blueprint, then a failure.
    const jobId = t.queue[0]!;
    const job = (await t.engine.deps.jobs.get(jobId))!;
    const saved = await t.engine.deps.jobs.compareAndSet(job.id, job.version, { state: { ...job.state, blueprint: { maker: "storyboard", made: { title: "Old", idea: "", scenes: [], minutes: 0, omittedPassages: 0 } } } });
    expect(saved.ok).toBe(true);
    await t.drain();

    const view = await t.json(`/v1/plans/${t.plan.id}`);
    const ran = view.items.find((entry: { id: string }) => entry.id === item.id);
    expect(ran.status).toBe("done");
    const { output } = await t.json(`/v1/outputs/${ran.outputId}`);
    expect(output.payload.render).toMatchObject({ by: "scenes", storyboard: false });
    expect((await t.engine.deps.jobs.get(jobId))!.state.blueprint).toMatchObject({ maker: "scenes" });
    expect(t.service.videos.size).toBe(1);
  });
});
