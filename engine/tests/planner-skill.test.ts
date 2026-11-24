/**
 * The planner's skill and what it changed (skills/planner): the skill is
 * given whole on every agent turn and to Open Sourcebook's own planner, the facts about
 * what can be made come from the registries, a planned item always says what
 * it will be (what the planner left open is settled the way it would be
 * made), the plan's state is said in plain words everywhere, and a big plan
 * can be written in parts and read back a stage at a time.
 */
import { describe, expect, it } from "vitest";
import { agentPrompt, agentSystemPrompt } from "../src/chat/agent/prompt";
import { createDefaultSkills } from "../src/chat/default-skills";
import { plannerGuide, plannerReferences } from "../src/chat/planning/guide";
import { catalog, PLANNER_SYSTEM_PROMPT } from "../src/chat/planning/prompts";
import { duration, planSize } from "../src/chat/planning/size";
import { planState } from "../src/chat/planning/state";
import { videoDefinitionFor } from "../src/engines/video/definition";
import { VideoMakerRegistry, type VideoMaker } from "../src/engines/video/makers";
import { handleRequest } from "../src/index";
import { createDefaultConditions } from "../src/studio/conditions";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { FormatRegistry } from "../src/studio/registry";
import type { Plan } from "../src/studio/repositories";
import type { FetchLike } from "../src/types";
import { VIDEO_SCHEMA_VERSION } from "../src/video/contract";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const PRICE = { inputPerMillion: 0.1, outputPerMillion: 0.4 };
const NOTES = Array.from({ length: 12 }, (_, k) => `Part ${k + 1} of the notes explains one idea about tides and the moon, with an example worked through.`).join("\n\n");

/** A video maker with looks, which says it can't make anything while `down`. */
function styledMaker(state: { down: boolean } = { down: false }): VideoMaker {
  return {
    id: "drawn",
    label: "Drawn",
    description: "Draws scenes. Takes about 10 minutes.",
    about: "drawn scenes",
    maxRepairRounds: 0,
    styles: () => [
      { id: "chalk", label: "Chalk", description: "White chalk on a dark board." },
      { id: "ink", label: "Ink", description: "Black ink on paper." },
    ],
    defaultStyle: () => "ink",
    issues: () => (state.down ? ["Drawn needs its service running: start it, or pick another maker"] : []),
    estimateCost: () => ({ usd: 0, basis: "drawn" }),
    engine: {
      type: "video",
      schemaVersion: VIDEO_SCHEMA_VERSION,
      plan: async () => ({}),
      generate: async () => ({ title: "", summary: "", payload: { schemaVersion: VIDEO_SCHEMA_VERSION, title: "", idea: "", aspect: { width: 9, height: 16, name: "portrait" }, scenes: [] } as never, citations: [] }),
      validate: async () => ({ valid: true, issues: [] }),
      repair: async (_ctx, output) => output,
    },
  };
}

function plan(fields: Partial<Plan>): Plan {
  return { id: "p1", ownerId: "o", projectId: "pr", version: 1, status: "draft", createdAt: "", updatedAt: "", ...fields };
}

describe("the planner's skill", () => {
  it("is given whole to the person's agent on every turn and to Open Sourcebook's own planner, with its references to open", () => {
    const guide = plannerGuide();
    expect(guide).toContain("# Planning in Open Sourcebook");
    expect(guide).not.toContain("name: planner");
    expect(plannerReferences()).toEqual(expect.arrayContaining(["references/briefs.md", "references/sizing.md"]));
    const system = agentSystemPrompt(createDefaultRegistry(), createDefaultConditions(), createDefaultSkills().list?.() ?? []);
    expect(system).toContain(guide);
    expect(system).toContain("read_skill opens its references/briefs.md");
    expect(PLANNER_SYSTEM_PROMPT).toContain(guide);
    // One thing made at once with no length asked is short; a longer one is asked for in words.
    expect(guide).toMatch(/When the person said nothing about length, one thing is short/);
    expect(guide).toMatch(/Longer is for when they ask in words/);
    // The old rules it replaced are not stacked on top.
    expect(system).not.toContain("Weigh every format you are given for every item");
    expect(system).not.toContain("Open Sourcebook is a study tool");
  });

  it("is told what can be made now from the registries, with a maker that can't run here now said as such", () => {
    const state = { down: false };
    const registry = new FormatRegistry().register(videoDefinitionFor(new VideoMakerRegistry().register(styledMaker(state))));
    expect(catalog(registry, createDefaultConditions())).toContain("ink (Black ink on paper.)");
    expect(catalog(registry, createDefaultConditions())).not.toContain("Not ready on this computer now");
    state.down = true;
    expect(catalog(registry, createDefaultConditions())).toContain("Not ready on this computer now: Drawn needs its service running");
  });
});

describe("what a planned item will be", () => {
  it("settles a video left open: the maker it gets, that maker's default look, and a length from its sources", () => {
    const definition = videoDefinitionFor(new VideoMakerRegistry().register(styledMaker()));
    const open = definition.parseSettings({});
    if (!open.ok) throw new Error("settings");
    // Nothing said about length: a short explainer, a little longer for a longer source, never past three minutes.
    expect(definition.settle!(open.settings, { sourceChars: 24_000, sourceCount: 1 })).toEqual({ maker: "drawn", style: "ink", minutes: 1.5 });
    expect(definition.settle!(open.settings, { sourceChars: 9_000, sourceCount: 1 }).minutes).toBe(1.5);
    expect(definition.settle!(open.settings, { sourceChars: 2_000, sourceCount: 1 }).minutes).toBe(1);
    expect(definition.settle!(open.settings, { sourceChars: 400_000, sourceCount: 3 }).minutes).toBe(3);
    // What the planner set stays as it set it.
    const set = definition.parseSettings({ maker: "drawn", style: "chalk", minutes: 8 });
    if (!set.ok) throw new Error("settings");
    expect(definition.settle!(set.settings, { sourceChars: 24_000, sourceCount: 1 })).toEqual({});
    expect(definition.describe!(set.settings)).toEqual(["Drawn", "Chalk", "about 8 min"]);
    expect(definition.describe!({ ...set.settings, minutes: 90 })).toEqual(["Drawn", "Chalk", "about 1 h 30 min"]);
  });

  it("settles the maker of a set of flashcards and a quiz and their length, by each format's own rule", () => {
    const registry = createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } });
    const quiz = registry.get("quiz")!;
    const parsed = quiz.parseSettings({});
    if (!parsed.ok) throw new Error("settings");
    const settled = quiz.settle!(parsed.settings, { sourceChars: 24_000, sourceCount: 1 });
    expect(settled).toMatchObject({ questions: 10 });
    expect(quiz.describe!({ ...(parsed.settings as object), questions: 12 } as never)).toEqual(expect.arrayContaining(["12 questions", "pass at 70%"]));
    const cards = registry.get("flashcards")!;
    const open = cards.parseSettings({});
    if (!open.ok) throw new Error("settings");
    expect(cards.settle!(open.settings, { sourceChars: 5_000, sourceCount: 1 })).toMatchObject({ cards: 18 });
    expect(cards.describe!({ ...(open.settings as object), cards: 12 } as never)).toEqual(expect.arrayContaining(["12 cards"]));
  });

  it("names the leave-it-open choices by what they do, never by who decides", () => {
    const registry = new FormatRegistry().register(videoDefinitionFor(new VideoMakerRegistry().register(styledMaker()).register({ ...styledMaker(), id: "other", label: "Other" })));
    const words = JSON.stringify(registry.descriptor("video"));
    expect(words).not.toMatch(/(Re|Open Sourcebook) decides/);
    expect(words).toContain("Whichever is ready");
    expect(words).toContain("Fit to the brief");
    expect(JSON.stringify(createDefaultRegistry().views())).not.toMatch(/(Re|Open Sourcebook) decides/);
  });
});

describe("a plan's state and size, in plain words", () => {
  it("never says a raw status, and tells a started plan from one that is not", () => {
    expect(planState(plan({ status: "draft" }))).toMatch(/^not started/);
    // An approved plan whose Start did not go through is still not started.
    expect(planState(plan({ status: "approved" }))).toMatch(/^not started/);
    expect(planState(plan({ status: "running", kickedOffAt: "t" }))).toMatch(/^started/);
    expect(planState(plan({ status: "cancelled", kickedOffAt: "t" }))).toContain("stopped part way");
    expect(planState(plan({ status: "discarded" }))).toContain("discarded");
    const prompt = agentPrompt({ sources: [], ticked: undefined, plans: [plan({ title: "Tides", status: "running", kickedOffAt: "t" })], history: [], request: { text: "is it ready?", mentions: [] } });
    expect(prompt).toContain('"Tides" (id p1): started');
    expect(prompt).toContain("go by these states, not by earlier words");
  });

  it("counts a plan by shape, with the length of what is timed", () => {
    const registry = new FormatRegistry().register(videoDefinitionFor(new VideoMakerRegistry().register(styledMaker())));
    const item = (key: string, minutes: number, level = 1) => ({ key, existing: false, level, ord: 0, type: "video", title: key, prompt: "", settings: { minutes }, sources: [], enabled: true });
    const draft = { labels: new Map(), edges: [], items: [item("a", 60), item("b", 5, 2), item("c", 0, 2)] };
    expect(planSize(draft, registry)).toBe("3 videos (about 1 h 5 min for 2 of them); 3 items in 2 stages");
    expect(duration(125)).toBe("2 h 5 min");
  });
});

// ── Over the routes, with a fake connector ──────────────────────────────────

interface Started {
  turnId: string;
  systemPrompt: string;
  prompt: string;
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  callback: { url: string; token: string };
}

async function setup() {
  const started: Started[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/status") return Response.json({ agent: "claude", model: "haiku", agents: [{ id: "claude", label: "Claude Code", installed: true, signedIn: true }] });
    if (url.pathname === "/turns") {
      started.push(JSON.parse(String(init?.body)) as Started);
      return Response.json({ turnId: started.at(-1)!.turnId }, { status: 202 });
    }
    return new Response(null, { status: 404 });
  };
  const engine = createTestEngine({ agent: { fetch }, skills: createDefaultSkills(), registry: createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } }) });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Tides" })).body.project;
  await call("/v1/sources", "POST", { text: NOTES, projectId: project.id });
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
  const tool = async (turn: Started, name: string, args: unknown = {}) => {
    const response = await handleRequest(
      new Request(`${turn.callback.url}/tools`, { method: "POST", headers: { authorization: `Bearer ${turn.callback.token}`, "content-type": "application/json" }, body: JSON.stringify({ name, arguments: args }) }),
      engine.deps,
    );
    return (await bodyOf(response)) as { text: string; isError: boolean };
  };
  return { engine, call, chat, started, tool };
}

/** `count` flashcards items in one stage, keys starting with `prefix`. */
function stage(prefix: string, count: number, label?: string) {
  return {
    ...(label ? { label } : {}),
    items: Array.from({ length: count }, (_, k) => ({ key: `${prefix}${k}`, format: "flashcards", title: `${prefix} part ${k + 1}`, brief: `Teaches part ${k + 1} from nothing.`, settings: { cards: 8 }, sources: [{ source: "S1" }] })),
  };
}

describe("a big plan, written in parts", () => {
  it("takes well over a hundred items over several calls, links a later part to an earlier item, and reads back a stage at a time", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan the whole term" });
    const [turn] = t.started;
    expect(turn.systemPrompt).toContain("A big plan in parts");
    const first = await t.tool(turn, "make_plan", { title: "The whole term", stages: [stage("a", 20, "Week 1"), stage("b", 20, "Week 2")] });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("not started");
    expect(first.text).toContain("40 sets of flashcards");
    const id = /plan id ([\w-]+)/.exec(first.text)![1]!;
    for (const [k, prefix] of ["c", "d", "e"].entries()) {
      const part = await t.tool(turn, "make_plan", { plan: id, stages: [stage(prefix, 25, `Week ${k + 3}`)] });
      expect(part.isError).toBe(false);
      expect(part.text).toContain(`Size now: ${40 + (k + 1) * 25} sets of flashcards`);
    }
    // A quiz after it all, gated on nothing, that builds on the first item by its ref.
    const last = await t.tool(turn, "make_plan", { plan: id, stages: [{ items: [{ key: "mock", format: "quiz", title: "Mock exam", brief: "A full practice run.", settings: { questions: 40 }, sources: [{ source: "S1" }], assumes: ["I1"] }] }] });
    expect(last.isError).toBe(false);
    const view = (await t.call(`/v1/plans/${id}`)).body;
    expect(view.items).toHaveLength(116);
    expect(new Set(view.items.map((item: { level: number }) => item.level)).size).toBe(6);
    expect(view.edges).toEqual([{ from: view.items[0].id, to: view.items.at(-1).id, kind: "assumes" }]);
    // Every item says what it will be, including what was left open (the maker).
    expect(view.items.every((item: { plannedAs?: string[] }) => Array.isArray(item.plannedAs) && item.plannedAs.length > 0)).toBe(true);
    // Read back: briefs left out for a plan this big, one stage in full on asking.
    const whole = await t.tool(turn, "read_plan", {});
    expect(whole.text).toContain("Briefs are left out");
    expect(whole.text).not.toContain("brief:");
    const one = await t.tool(turn, "read_plan", { stage: 2 });
    expect(one.text).toContain("brief: Teaches part 1 from nothing.");
    expect(one.text).not.toContain("a part 1");
  });

  it("refuses a part with a taken key or a link to nothing, saving nothing, and refuses a started plan", async () => {
    const t = await setup();
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/plan" });
    const [turn] = t.started;
    const first = await t.tool(turn, "make_plan", { title: "Short", stages: [stage("a", 2)] });
    const id = /plan id ([\w-]+)/.exec(first.text)![1]!;
    const bad = await t.tool(turn, "make_plan", { plan: id, stages: [{ items: [{ ...stage("x", 1).items[0], key: "x0", assumes: ["I9"] }] }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('"I9" is not an item');
    expect((await t.call(`/v1/plans/${id}`)).body.items).toHaveLength(2);
    // Started as Start starts it (this test engine runs no plans).
    await t.engine.deps.repos.plans.setStatus(id, "running");
    const late = await t.tool(turn, "make_plan", { plan: id, stages: [stage("z", 1)] });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("started");
    const changed = await t.tool(turn, "change_plan", { plan: id, ops: [{ op: "title", title: "New" }] });
    expect(changed.text).toMatch(/is started/);
    const read = await t.tool(turn, "read_plan", { plan: id });
    expect(read.text).toContain(": started");
  });
});
