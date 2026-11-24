/**
 * Days on plan stages (migrations/0017): setting and clearing one by hand,
 * what is due across plans (GET /v1/due) and moving missed days on
 * (POST /v1/plans/:id/catch-up). Today always comes from the request.
 */
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { addDays, daysBetween, isDay } from "../src/studio/days";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import { movedDays } from "../src/studio/schedule";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { emptyLog, fakeDefinition } from "./support/fake-engine";

describe("calendar days", () => {
  it("knows a real day from anything else", () => {
    expect(isDay("2026-11-20")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    for (const wrong of ["2026-02-29", "2026-13-01", "2026-11-31", "2026-1-5", "Friday", "2026-11-20T10:00", 20261120, null, undefined]) expect(isDay(wrong)).toBe(false);
  });

  it("counts across months and years", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-11-20", "2026-12-01")).toBe(11);
    expect(daysBetween("2026-12-01", "2026-11-20")).toBe(-11);
  });
});

describe("moving missed days on", () => {
  const dates = [
    { planId: "p", level: 1, dueOn: "2026-11-10" },
    { planId: "p", level: 2, dueOn: "2026-11-15" },
    { planId: "p", level: 3, dueOn: "2026-11-17" },
    { planId: "p", level: 4, dueOn: "2026-11-24" },
  ];

  it("moves the first missed stage with something left to today and the later ones by as much, keeping their gaps", () => {
    const left = (level: number) => (level === 1 ? 0 : 2);
    expect(movedDays(dates, left, "2026-11-20")).toEqual(
      new Map([
        [2, "2026-11-20"],
        [3, "2026-11-22"],
        [4, "2026-11-29"],
      ]),
    );
  });

  it("leaves a stage already gone through, and moves nothing when nothing was missed", () => {
    expect(movedDays(dates, (level) => (level === 3 ? 0 : 1), "2026-11-12")).toEqual(
      new Map([
        [1, "2026-11-12"],
        [2, "2026-11-17"],
        [4, "2026-11-26"],
      ]),
    );
    expect(movedDays(dates, () => 1, "2026-11-10").size).toBe(0);
    expect(movedDays(dates, () => 0, "2026-12-31").size).toBe(0);
  });
});

async function setup() {
  const log = emptyLog();
  const registry = new FormatRegistry().register(fakeDefinition("byte", log));
  const engine = createTestEngine({ registry });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos: engine.deps.repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: response.status === 204 ? null : await bodyOf(response) };
  };
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  const project = (await call("/v1/projects", "POST", { title: "Calculus" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: "Limits and continuity.", projectId: project.id })).body.source;
  /** A plan with one item in each of `stages` stages, levels 1, 2, ... */
  const plan = async (title: string, stages: number, projectId = project.id) => {
    const made = (await call(`/v1/projects/${projectId}/plans`, "POST", { title })).body.plan;
    const from = projectId === project.id ? source : (await call("/v1/sources", "POST", { text: `${title}: the notes.`, projectId })).body.source;
    for (let level = 1; level <= stages; level++) {
      const added = await call(`/v1/plans/${made.id}/items`, "POST", { type: "byte", title: `${title} ${level}`, level, sources: [{ sourceId: from.id }] });
      if (added.status !== 201) throw new Error(JSON.stringify(added.body));
    }
    return made.id as string;
  };
  const start = async (planId: string) => {
    await call(`/v1/plans/${planId}/approve`, "POST");
    expect((await call(`/v1/plans/${planId}/start`, "POST")).status).toBe(200);
  };
  const date = (planId: string, level: number, dueOn: string | null) => call(`/v1/plans/${planId}/stages/${level}`, "PUT", { dueOn });
  const due = async (today: string, ahead?: number) => (await call(`/v1/due?today=${today}${ahead === undefined ? "" : `&ahead=${ahead}`}`)).body;
  return { engine, call, drain, project, source, plan, start, date, due };
}

describe("a stage's day by hand", () => {
  it("sets, shows and clears a day apart from the label, in any status", async () => {
    const t = await setup();
    const id = await t.plan("Unit 1", 2);
    await t.call(`/v1/plans/${id}/approve`, "POST");
    const dated = await t.call(`/v1/plans/${id}/stages/2`, "PUT", { dueOn: "2026-11-24" });
    expect(dated.status).toBe(200);
    expect(dated.body.stages).toEqual([{ level: 2, dueOn: "2026-11-24" }]);
    expect(dated.body.plan.status).toBe("approved");
    const both = await t.call(`/v1/plans/${id}/stages/2`, "PUT", { label: "Practice", dueOn: "2026-11-25" });
    expect(both.body.stages).toEqual([{ level: 2, label: "Practice", dueOn: "2026-11-25" }]);
    expect((await t.call(`/v1/plans/${id}/stages/2`, "PUT", { label: null })).body.stages).toEqual([{ level: 2, dueOn: "2026-11-25" }]);

    // After Start, when items can no longer change, the day still can.
    await t.call(`/v1/plans/${id}/start`, "POST");
    expect((await t.date(id, 2, "2026-11-27")).body.stages).toEqual([{ level: 2, dueOn: "2026-11-27" }]);
    expect((await t.date(id, 2, null)).body.stages).toEqual([]);
  });

  it("refuses a day that is not one, and a plan that is not theirs", async () => {
    const t = await setup();
    const id = await t.plan("Unit 1", 1);
    for (const dueOn of ["Monday", "2026-02-30", 5]) {
      expect(await t.call(`/v1/plans/${id}/stages/1`, "PUT", { dueOn })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    }
    const theirs = await t.engine.deps.repos.projects.create({ ownerId: "client:someone-else", title: "Theirs" });
    const theirPlan = await t.engine.deps.repos.plans.create({ ownerId: "client:someone-else", projectId: theirs.id });
    expect((await t.date(theirPlan.id, 1, "2026-11-24")).status).toBe(404);
    expect((await t.call(`/v1/plans/${theirPlan.id}/catch-up`, "POST", { today: "2026-11-24" })).status).toBe(404);
  });
});

describe("GET /v1/due", () => {
  it("lists missed, today's and coming stages with something left, across plans, earliest first", async () => {
    const t = await setup();
    const unit = await t.plan("Unit 1", 3);
    await t.call(`/v1/plans/${unit}/stages/1`, "PUT", { label: "Limits", dueOn: "2026-11-18" });
    await t.date(unit, 2, "2026-11-20");
    await t.date(unit, 3, "2026-12-20");
    const other = (await t.call("/v1/projects", "POST", { title: "Physics" })).body.project;
    const review = await t.plan("Review", 1, other.id);
    await t.date(review, 1, "2026-11-23");

    const listed = await t.due("2026-11-20");
    expect(listed.today).toBe("2026-11-20");
    expect(listed.stages).toEqual([
      { planId: unit, planTitle: "Unit 1", projectId: t.project.id, projectTitle: "Calculus", level: 1, number: 1, label: "Limits", dueOn: "2026-11-18", when: "missed", left: 1, total: 1, started: false },
      { planId: unit, planTitle: "Unit 1", projectId: t.project.id, projectTitle: "Calculus", level: 2, number: 2, dueOn: "2026-11-20", when: "today", left: 1, total: 1, started: false },
      { planId: review, planTitle: "Review", projectId: other.id, projectTitle: "Physics", level: 1, number: 1, dueOn: "2026-11-23", when: "soon", left: 1, total: 1, started: false },
    ]);
    // Looking further ahead brings in the later stage; none ahead keeps only what is missed or due today.
    expect((await t.due("2026-11-20", 30)).stages.map((stage: any) => stage.dueOn)).toContain("2026-12-20");
    expect((await t.due("2026-11-20", 0)).stages.map((stage: any) => stage.when)).toEqual(["missed", "today"]);
  });

  it("drops a stage once gone through, and plans thrown away or in an archived project", async () => {
    const t = await setup();
    const unit = await t.plan("Unit 1", 2);
    await t.date(unit, 1, "2026-11-19");
    await t.date(unit, 2, "2026-11-20");
    await t.start(unit);
    await t.drain();
    const view = (await t.call(`/v1/plans/${unit}`)).body;
    await t.call(`/v1/plans/${unit}/items/${view.items[0].id}/done`, "POST", {});
    expect((await t.due("2026-11-20")).stages.map((stage: any) => [stage.level, stage.started])).toEqual([[2, true]]);

    const dropped = await t.plan("Dropped", 1);
    await t.date(dropped, 1, "2026-11-20");
    await t.call(`/v1/plans/${dropped}/cancel`, "POST");
    const other = (await t.call("/v1/projects", "POST", { title: "Old" })).body.project;
    const old = await t.plan("Old", 1, other.id);
    await t.date(old, 1, "2026-11-20");
    await t.call(`/v1/projects/${other.id}/archive`, "POST");
    expect((await t.due("2026-11-20")).stages.map((stage: any) => stage.planId)).toEqual([unit]);
  });

  it("needs the person's day, and a sensible look ahead", async () => {
    const t = await setup();
    for (const query of ["", "?today=Friday", "?today=2026-11-20&ahead=-1", "?today=2026-11-20&ahead=365"]) {
      expect((await t.call(`/v1/due${query}`)).status).toBe(400);
    }
  });
});

describe("POST /v1/plans/:id/catch-up", () => {
  it("moves the missed days on from today and leaves the rest", async () => {
    const t = await setup();
    const unit = await t.plan("Unit 1", 3);
    await t.date(unit, 1, "2026-11-16");
    await t.date(unit, 2, "2026-11-18");
    await t.date(unit, 3, "2026-11-25");
    const moved = await t.call(`/v1/plans/${unit}/catch-up`, "POST", { today: "2026-11-20" });
    expect(moved.status).toBe(200);
    expect(moved.body.stages).toEqual([
      { level: 1, dueOn: "2026-11-20" },
      { level: 2, dueOn: "2026-11-22" },
      { level: 3, dueOn: "2026-11-29" },
    ]);
    // Nothing missed now: a second press changes nothing.
    expect((await t.call(`/v1/plans/${unit}/catch-up`, "POST", { today: "2026-11-20" })).body.stages).toEqual(moved.body.stages);
    expect((await t.call(`/v1/plans/${unit}/catch-up`, "POST", {})).status).toBe(400);
  });
});
