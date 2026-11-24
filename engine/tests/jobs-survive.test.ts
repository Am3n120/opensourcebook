/**
 * A job survives a restart and the agent's usage limit: nothing stays
 * running for ever, a job is carried on from what it made, a limit is a
 * wait and not a failure, and every wait ends. Fakes only: a store per
 * kind (D1 on SQLite, in memory), a hand-moved clock, runners that stand in
 * for makers.
 */
import { describe, expect, it } from "vitest";
import { AgentWork } from "../src/chat/agent/work";
import { handleJobBatch, type JobRunner } from "../src/jobs/consumer";
import { failureWords, waitingWords } from "../src/jobs/failure-words";
import { keepJobs, QUIET_MS, type AgentCheck, type VoiceCheck } from "../src/jobs/keeper";
import { cancelJob, choiceOf, chooseWayOn, claimJob, requeueFailedJob, wakeJob, type JobRun } from "../src/jobs/lifecycle";
import { WITHOUT_SOUND } from "../src/engines/video/scenes/maker";
import type { GenerationJob, GenerationJobStore } from "../src/jobs/types";
import { JobWait, LIMIT_PATIENCE_MS, RESTART_WAITS_MS, waitOf } from "../src/jobs/waits";
import { ManualClock, STORE_FACTORIES } from "./support/job-harness";

function setup(make: (clock: ManualClock) => GenerationJobStore, runner: JobRunner) {
  const clock = new ManualClock();
  const store = make(clock);
  const scheduled: string[] = [];
  const finished: GenerationJob[] = [];
  const deliver = (jobId: string) =>
    handleJobBatch(
      { queue: "jobs", messages: [{ body: { jobId }, attempts: 1, ack: () => undefined, retry: () => undefined }] },
      { store, runners: { output: runner }, now: clock.now, heartbeatMs: 0, log: () => undefined, onFinished: async (job) => void finished.push(job) },
    );
  const checks: number[] = [];
  const voiceChecks: number[] = [];
  const keep = (check?: () => AgentCheck, voice?: () => VoiceCheck) =>
    keepJobs({
      store,
      now: clock.now,
      log: () => undefined,
      schedule: async (id) => void scheduled.push(id),
      onFinished: async (job) => void finished.push(job),
      ...(check ? { checkAgent: async () => (checks.push(clock.now()), check()) } : {}),
      ...(voice ? { checkVoice: async () => (voiceChecks.push(clock.now()), voice()) } : {}),
    });
  const create = async (key = "k") => (await store.create({ ownerId: "o", idempotencyKey: key, type: "quiz" })).job.id;
  return { clock, store, scheduled, finished, deliver, keep, checks, voiceChecks, create };
}

/** Writes a "checkpoint" once, as a maker keeps what it wrote, then does what `then` says. */
function maker(then: (run: JobRun, kept: unknown) => Promise<void>): JobRunner & { attempts: Array<{ attempt: number; kept: unknown }> } {
  const attempts: Array<{ attempt: number; kept: unknown }> = [];
  return {
    attempts,
    async run(run) {
      const kept = run.job.state.checkpoints;
      attempts.push({ attempt: run.attempt, kept });
      if (!kept) await run.saveState("checkpoints", { draft: ["q1", "q2"] });
      await then(run, kept);
      return { outputId: "out-1" };
    },
  };
}

describe.each(STORE_FACTORIES)("jobs survive: $name", ({ make }) => {
  it("a job the engine left running when it restarted is found by itself and carried on from what it made", async () => {
    // The first engine: it claims the job, the maker keeps two questions, and then the engine is gone mid-turn.
    const t = setup(make, maker(async () => undefined));
    const id = await t.create();
    const claimed = await claimJob(t.store, id, { now: t.clock.now, staleAfterMs: 120_000 });
    if (claimed.kind !== "claimed") throw new Error("not claimed");
    await claimed.run.saveState("checkpoints", { draft: ["q1", "q2"] });
    await claimed.run.progress("writing", 0.4);

    // The new engine: not yet quiet long enough, nothing happens; then it is carried on at once.
    t.clock.advance(QUIET_MS - 1_000);
    expect((await t.keep()).orphaned).toEqual([]);
    t.clock.advance(2_000);
    const pass = await t.keep();
    expect(pass.orphaned).toEqual([id]);
    expect(t.scheduled).toEqual([id]);
    const waiting = (await t.store.get(id))!;
    expect(waiting.status).toBe("waiting");
    expect(waitingWords(waiting, "quiz")).toMatchObject({ reason: "restart", step: "Carrying on after a restart…" });

    await t.deliver(id);
    const done = (await t.store.get(id))!;
    expect(done).toMatchObject({ status: "done", attempt: 2, outputId: "out-1" });
    expect(done.state.checkpoints).toEqual({ draft: ["q1", "q2"] });
    expect(waitOf(done)).toBeUndefined();
  });

  it("a maker that went quiet (the connector forgot the turn) waits, is carried on with what it kept, and finishes", async () => {
    let calls = 0;
    const runner = maker(async () => {
      calls += 1;
      if (calls === 1) throw new JobWait("The connector no longer runs this turn.", "restart", "agent_dropped");
    });
    const t = setup(make, runner);
    const id = await t.create();
    await t.deliver(id);
    expect((await t.store.get(id))!.status).toBe("waiting");
    expect(t.finished).toEqual([]);
    // Not due yet: a delivery now changes nothing, and the keeper leaves it.
    await t.deliver(id);
    expect(runner.attempts).toHaveLength(1);
    expect((await t.keep()).carriedOn).toEqual([]);
    t.clock.advance(RESTART_WAITS_MS[0]);
    expect((await t.keep()).carriedOn).toEqual([id]);
    await t.deliver(id);
    expect(runner.attempts.map((a) => a.kept)).toEqual([undefined, { draft: ["q1", "q2"] }]);
    expect((await t.store.get(id))!.status).toBe("done");
  });

  it("is carried on after restarts a few times with growing waits, then fails plainly, keeping what was made", async () => {
    const runner = maker(async () => {
      throw new JobWait("Gone again.", "restart", "agent_dropped");
    });
    const t = setup(make, runner);
    const id = await t.create();
    const waits: number[] = [];
    for (let round = 0; round <= RESTART_WAITS_MS.length; round += 1) {
      await t.deliver(id);
      const job = (await t.store.get(id))!;
      if (job.status !== "waiting") break;
      const wait = waitOf(job)!;
      waits.push(Date.parse(wait.nextAt) - t.clock.now());
      t.clock.advanceTo(Date.parse(wait.nextAt));
    }
    expect(waits).toEqual([...RESTART_WAITS_MS]);
    const failed = (await t.store.get(id))!;
    expect(failed).toMatchObject({ status: "failed", retryable: false });
    expect(failed.state.checkpoints).toEqual({ draft: ["q1", "q2"] });
    expect(failureWords(failed, "quiz")).toContain("What was made is kept: try again to carry on from there.");
    expect(t.finished.map((job) => job.status)).toEqual(["failed"]);
  });

  it("the agent's plan limit is a wait with the agent's own words, checked cheaply, and carried on when the plan is free", async () => {
    let limited = true;
    const runner = maker(async () => {
      if (limited) throw new JobWait("Usage limit reached.", "agent_limit", "agent_limit", { resets: "3pm (Europe/Berlin)" });
    });
    const t = setup(make, runner);
    const id = await t.create();
    await t.deliver(id);
    const waiting = (await t.store.get(id))!;
    expect(waiting.status).toBe("waiting");
    const words = waitingWords(waiting, "quiz")!;
    expect(words.step).toBe("Waiting for your agent's plan…");
    expect(words.words).toBe(
      "Your agent's plan has reached its limit. Open Sourcebook will carry on when it is available again. It said it resets 3pm (Europe/Berlin). What was made of this quiz so far is kept.",
    );

    // Still limited at the check: it waits longer, and no turn is started.
    t.clock.advanceTo(Date.parse(waitOf(waiting)!.nextAt));
    const still = await t.keep(() => ({ free: false, limit: {} }));
    expect(still.stillWaiting).toEqual([id]);
    expect(t.scheduled).toEqual([]);
    const longer = waitOf((await t.store.get(id))!)!;
    expect(longer.tries).toBe(2);
    expect(Date.parse(longer.nextAt) - t.clock.now()).toBeGreaterThan(120_000);
    expect(longer.resets).toBe("3pm (Europe/Berlin)");

    // Free again: carried on from what it made.
    limited = false;
    t.clock.advanceTo(Date.parse(longer.nextAt));
    expect((await t.keep(() => ({ free: true }))).carriedOn).toEqual([id]);
    await t.deliver(id);
    expect((await t.store.get(id))!).toMatchObject({ status: "done" });
    expect(runner.attempts[1]!.kept).toEqual({ draft: ["q1", "q2"] });
  });

  it("a known reset time is waited for, not probed before it", async () => {
    const t = setup(make, maker(async () => {
      throw new JobWait("Limit.", "agent_limit", "agent_limit", { resetsAt: new Date(Date.parse("2026-11-10T12:00:00.000Z")).toISOString() });
    }));
    const id = await t.create();
    await t.deliver(id);
    const wait = waitOf((await t.store.get(id))!)!;
    expect(wait.resetsAt).toBe("2026-11-10T12:00:00.000Z");
    expect(Date.parse(wait.nextAt)).toBe(Date.parse("2026-11-10T12:00:30.000Z"));
    t.clock.advance(60 * 60_000);
    await t.keep(() => ({ free: true }));
    expect(t.checks).toEqual([]);
  });

  it("a limit that never lifts is given up on after a day, plainly, keeping what was made", async () => {
    const t = setup(make, maker(async () => {
      throw new JobWait("Limit.", "agent_limit", "agent_limit");
    }));
    const id = await t.create();
    await t.deliver(id);
    const started = t.clock.now();
    for (let guard = 0; guard < 200; guard += 1) {
      const job = (await t.store.get(id))!;
      if (job.status !== "waiting") break;
      t.clock.advanceTo(Date.parse(waitOf(job)!.nextAt));
      await t.keep(() => ({ free: false, limit: {} }));
    }
    const failed = (await t.store.get(id))!;
    expect(failed.status).toBe("failed");
    expect(t.clock.now() - started).toBeGreaterThanOrEqual(LIMIT_PATIENCE_MS);
    expect(t.clock.now() - started).toBeLessThan(LIMIT_PATIENCE_MS + 31 * 60_000);
    expect(failureWords(failed, "quiz")).toBe(
      "Your agent's plan was still at its limit, so Open Sourcebook stopped waiting for it. What was made of this quiz is kept: try again once it resets to carry on from there.",
    );
    expect(failed.state.checkpoints).toEqual({ draft: ["q1", "q2"] });
    expect(t.finished.map((job) => job.id)).toEqual([id]);
  });

  it("several items waiting on one limit cost one check, and all go on together", async () => {
    const t = setup(make, maker(async () => {
      throw new JobWait("Limit.", "agent_limit", "agent_limit");
    }));
    const ids = [await t.create("a"), await t.create("b"), await t.create("c")];
    for (const id of ids) await t.deliver(id);
    t.clock.advance(10 * 60_000);
    await t.keep(() => ({ free: false, limit: {} }));
    expect(t.checks).toHaveLength(1);
    const later = Math.max(...(await Promise.all(ids.map(async (id) => Date.parse(waitOf((await t.store.get(id))!)!.nextAt)))));
    t.clock.advanceTo(later);
    const pass = await t.keep(() => ({ free: true }));
    expect(t.checks).toHaveLength(2);
    expect(pass.carriedOn.sort()).toEqual([...ids].sort());
  });

  it("Stop works in every state: waiting after a restart, waiting on the limit, and while it is carried on", async () => {
    for (const reason of ["restart", "agent_limit"] as const) {
      const t = setup(make, maker(async () => {
        throw new JobWait("Waits.", reason, reason === "restart" ? "agent_dropped" : "agent_limit");
      }));
      const id = await t.create(reason);
      await t.deliver(id);
      expect((await t.store.get(id))!.status).toBe("waiting");
      expect((await cancelJob(t.store, id, t.clock.now)).kind).toBe("cancelled");
      t.clock.advance(24 * 3_600_000);
      const pass = await t.keep(() => ({ free: true }));
      expect(pass.carriedOn).toEqual([]);
      await t.deliver(id);
      expect((await t.store.get(id))!.status).toBe("cancelled");
    }
    // Stopped while a carried-on attempt runs: the run loses the job and writes nothing more.
    let cancel: (() => Promise<unknown>) | undefined;
    const t = setup(make, maker(async (run) => {
      await cancel?.();
      await run.progress("writing", 0.9);
    }));
    const id = await t.create();
    cancel = () => cancelJob(t.store, id, t.clock.now);
    await t.deliver(id);
    expect((await t.store.get(id))!.status).toBe("cancelled");
  });

  it("a voice that cannot speak is a wait: checked for free, carried on once it can speak, with what was made kept", async () => {
    let down = true;
    const runner = maker(async () => {
      if (down) throw new JobWait("The voice could not speak.", "voice", "voice_down", {}, { trouble: "credits", choice: WITHOUT_SOUND });
    });
    const t = setup(make, runner);
    const id = await t.create();
    await t.deliver(id);
    const waiting = (await t.store.get(id))!;
    expect(waiting.status).toBe("waiting");
    expect(waitingWords(waiting, "video")).toEqual({
      reason: "voice",
      step: "Waiting for the voice…",
      words: "The voice account is out of credits, so the voice cannot speak. What was made of this video so far is kept. Add credits to the voice account and Open Sourcebook carries on by itself, or finish it now without sound, with the captions carrying the words.",
    });
    expect(choiceOf(waiting)).toEqual(WITHOUT_SOUND);

    // Still out at the check: it waits longer, and nothing is started; an agent check is never spent on it.
    t.clock.advanceTo(Date.parse(waitOf(waiting)!.nextAt));
    const still = await t.keep(() => ({ free: true }), () => ({ free: false }));
    expect(still.stillWaiting).toEqual([id]);
    expect(t.scheduled).toEqual([]);
    expect(t.checks).toEqual([]);
    expect(t.voiceChecks).toHaveLength(1);
    const longer = waitOf((await t.store.get(id))!)!;
    expect(longer).toMatchObject({ reason: "voice", tries: 2, trouble: "credits", choice: WITHOUT_SOUND });

    // The voice can speak again: carried on from what it made.
    down = false;
    t.clock.advanceTo(Date.parse(longer.nextAt));
    expect((await t.keep(undefined, () => ({ free: true }))).carriedOn).toEqual([id]);
    await t.deliver(id);
    expect((await t.store.get(id))!).toMatchObject({ status: "done" });
    expect(runner.attempts[1]!.kept).toEqual({ draft: ["q1", "q2"] });
  });

  it("the way on a wait offers is the person's to take, waiting or after it was given up on; one it does not offer is not taken", async () => {
    const chosen: unknown[] = [];
    const runner = maker(async (run) => {
      chosen.push(run.job.state.chosen);
      if (run.job.state.chosen !== WITHOUT_SOUND.id) throw new JobWait("The voice could not speak.", "voice", "voice_down", {}, { trouble: "unreachable", choice: WITHOUT_SOUND });
    });
    const t = setup(make, runner);
    // Waiting: taken at once, and due now.
    const id = await t.create("waiting");
    await t.deliver(id);
    expect((await chooseWayOn(t.store, id, "something else", t.clock.now)).kind).toBe("unchanged");
    expect((await chooseWayOn(t.store, id, WITHOUT_SOUND.id, t.clock.now)).kind).toBe("moved");
    await t.deliver(id);
    expect((await t.store.get(id))!.status).toBe("done");
    expect(chosen).toEqual([undefined, WITHOUT_SOUND.id]);

    // Given up on after a day: the failure says so, offers the same way on, and taking it makes the item.
    const late = await t.create("late");
    await t.deliver(late);
    for (let guard = 0; guard < 200; guard += 1) {
      const job = (await t.store.get(late))!;
      if (job.status !== "waiting") break;
      t.clock.advanceTo(Date.parse(waitOf(job)!.nextAt));
      await t.keep(undefined, () => ({ free: false }));
    }
    const failed = (await t.store.get(late))!;
    expect(failed.status).toBe("failed");
    expect(failureWords(failed, "video")).toBe(
      "Open Sourcebook waited a day for the voice, and it still could not speak (the voice service could not be reached). What was made of this video is kept: check this computer's connection, then try again to carry on, or finish it now without sound, with the captions carrying the words.",
    );
    expect(choiceOf(failed)).toEqual(WITHOUT_SOUND);
    expect((await chooseWayOn(t.store, late, WITHOUT_SOUND.id, t.clock.now)).kind).toBe("moved");
    expect((await requeueFailedJob(t.store, late)).kind).toBe("queued");
    await t.deliver(late);
    expect((await t.store.get(late))!).toMatchObject({ status: "done" });
  });

  it("the person's try now carries a waiting item on at once", async () => {
    const t = setup(make, maker(async () => {
      throw new JobWait("Limit.", "agent_limit", "agent_limit");
    }));
    const id = await t.create();
    await t.deliver(id);
    expect((await claimJob(t.store, id, { now: t.clock.now, staleAfterMs: 120_000 })).kind).toBe("waiting");
    await wakeJob(t.store, id, t.clock.now);
    expect((await claimJob(t.store, id, { now: t.clock.now, staleAfterMs: 120_000 })).kind).toBe("claimed");
  });
});

describe("jobs survive: a sleep", () => {
  it("a job this engine is still running is never taken for orphaned, however old its last write looks after a sleep", async () => {
    const t = setup(STORE_FACTORIES[0]!.make, {
      async run() {
        // The computer sleeps for two hours mid-turn; the keeper runs on wake before the run writes again.
        t.clock.advance(2 * 3_600_000);
        const pass = await t.keep();
        expect(pass.orphaned).toEqual([]);
        return { outputId: "out-1" };
      },
    });
    const id = await t.create();
    await t.deliver(id);
    expect((await t.store.get(id))!.status).toBe("done");
  });
});

describe("jobs survive: the cheapest honest check of the agent's plan", () => {
  const config = { url: "http://127.0.0.1:9", token: "t", agent: "claude", timeoutMs: 60_000 };
  function connector(status: Record<string, unknown>, probe?: Record<string, unknown>) {
    const calls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/status") return Response.json({ agent: "claude", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true, ...status }] });
      if (path === "/agents/claude/probe" && probe) return Response.json(probe);
      return Response.json({ error: "not_found" }, { status: 404 });
    };
    return { calls, work: new AgentWork(config, fetchImpl) };
  }

  it("a reset the connector knows is still ahead: no turn at all", async () => {
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const t = connector({ limit: { since: new Date().toISOString(), resetsAt, resets: "in 1 hour" } });
    expect(await t.work.check()).toEqual({ free: false, limit: { resetsAt, resets: "in 1 hour" } });
    expect(t.calls).toEqual(["GET /status"]);
  });

  it("otherwise the connector's smallest turn says", async () => {
    const free = connector({}, { ok: true });
    expect(await free.work.check()).toEqual({ free: true });
    expect(free.calls).toEqual(["GET /status", "POST /agents/claude/probe"]);
    const still = connector({ limit: { since: new Date().toISOString() } }, { ok: false, problem: "agentLimit", limit: { since: new Date().toISOString(), resets: "3pm" } });
    expect(await still.work.check()).toEqual({ free: false, limit: { resets: "3pm" } });
    const older = connector({});
    expect(await older.work.check()).toEqual({});
  });
});
