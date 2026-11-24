/**
 * The guide, the fifth shape (engines/guide, engine/docs/guide.md): it
 * registers and everything read from the registry picks it up (its command,
 * its tile's settings, plan sizes); it is not ready, and says why, with no
 * agent; the person's agent writes it section by section through tools that
 * answer (a bad cite refused, a list inside a point refused, the pages told,
 * background never cited); a spot of it is said in words; and the person's
 * changes by hand are laid over it, through the one route any format that
 * takes them shares.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { AssetStore } from "../src/assets";
import { forgetAgentStatus, AgentWork } from "../src/chat/agent/work";
import { createDefaultSkills } from "../src/chat/default-skills";
import type { DraftPlan } from "../src/chat/planning/draft";
import { planSize } from "../src/chat/planning/size";
import { createAgentGuideMaker } from "../src/engines/guide/agent-maker";
import { guideAnchor } from "../src/engines/guide/anchor";
import type { GuidePayload } from "../src/engines/guide/contract";
import { createGuideDefinition } from "../src/engines/guide/definition";
import { editGuide } from "../src/engines/guide/edit";
import { parseGuideSettings, type GuideSettings } from "../src/engines/guide/settings";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { InMemoryUsageSink } from "../src/providers/usage";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { FormatRegistry, runEngine } from "../src/studio/registry";
import type { EngineCheckpoint, EngineContext, JsonValue, NodeSource } from "../src/studio/types";
import type { SourceEnvelope } from "../src/types";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { FAKE_CONNECTOR_TOKEN, FAKE_CONNECTOR_URL, FAKE_ENGINE_URL, FakeConnector } from "./support/fake-connector";
import { emptyLog, fakeDefinition } from "./support/fake-engine";
import { FakeR2Bucket } from "./support/fake-r2";

const P1 = "Mitosis is the division of one cell nucleus into two identical nuclei. It has four stages: prophase, metaphase, anaphase and telophase.";
const P2 = "In metaphase the chromosomes line up along the middle of the cell, and in anaphase the sister chromatids are pulled to opposite poles.";

function envelope(text: string): SourceEnvelope {
  return { originalText: text, kind: "text", title: "Cell biology notes", text, references: [], metadata: {}, accessLevel: "full", depthCap: "light", limitations: [], fetchedAt: "2026-11-20T09:00:00.000Z" };
}

function source(): NodeSource {
  let at = 0;
  const chunks = [P1, P2].map((text, index) => {
    const chunk = { id: `chunk-${index + 1}`, ord: index, text, locator: { charStart: at, charEnd: at + text.length } };
    at += text.length + 2;
    return chunk;
  });
  return { sourceId: "src-1", title: "Cell biology notes", envelope: envelope([P1, P2].join("\n\n")), chunks };
}

function memoryCheckpoint(): EngineCheckpoint & { entries: Map<string, JsonValue> } {
  const entries = new Map<string, JsonValue>();
  return { entries, get: (key) => entries.get(key), put: async (key, value) => void entries.set(key, JSON.parse(JSON.stringify(value)) as JsonValue) };
}

function work(connector: FakeConnector): AgentWork {
  return new AgentWork({ url: FAKE_CONNECTOR_URL, token: FAKE_CONNECTOR_TOKEN, agent: "claude", callbackUrl: FAKE_ENGINE_URL, timeoutMs: 180_000 }, connector.fetch, {
    pollMs: 20,
    graceMs: 0,
    settleMs: 300,
    maxMissedReads: 2,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  });
}

function definition(connector: FakeConnector) {
  return createGuideDefinition({ makers: [createAgentGuideMaker({ work: work(connector) })] });
}

function settings(raw: Record<string, unknown> = { pages: 1 }): GuideSettings {
  const parsed = parseGuideSettings(raw);
  if (!parsed.ok) throw new Error("bad settings");
  return parsed.settings;
}

function context(guideSettings: GuideSettings): EngineContext<GuideSettings> {
  return {
    jobId: "job-guide-1",
    node: { id: "node-1", type: "guide", title: "Mitosis", prompt: "One page to revise mitosis from before the exam.", settings: guideSettings },
    sources: [source()],
    assumes: [],
    inputs: [],
    services: {
      provider: { name: "none", generateJSON: async () => { throw new Error("no model is called"); } },
      assets: new AssetStore(new FakeR2Bucket()),
      usage: new InMemoryUsageSink(),
      fetch: async () => new Response(null),
      now: () => "2026-11-20T09:00:00.000Z",
      checkpoint: memoryCheckpoint(),
      progress: () => undefined,
    },
  };
}

const definitionPoint = { term: "Mitosis", text: "The division of one nucleus into two identical nuclei.", cites: [{ passage: "P1", quote: "the division of one cell nucleus into two identical nuclei" }] };
const stages = {
  title: "The stages, in order",
  points: [
    { term: "Metaphase", text: "Chromosomes line up along the middle of the cell.", cites: [{ passage: "P2", quote: "the chromosomes line up along the middle of the cell" }] },
    { term: "Anaphase", text: "Sister chromatids are pulled to opposite poles.", cites: [{ passage: "P2", quote: "the sister chromatids are pulled to opposite poles" }] },
  ],
};

beforeEach(() => forgetAgentStatus());

describe("the guide shape in the registry", () => {
  it("registers, and its command, its settings and its plan words come from the registry", () => {
    const registry = createDefaultRegistry({ guide: { makers: [createAgentGuideMaker({ work: work(new FakeConnector(async () => ({ ok: true }))) })] } });
    const view = registry.views().find((format) => format.id === "guide")!;
    expect(view).toMatchObject({ label: "guide", singular: "guide", plural: "guides", icon: "book", colorSlot: 5, defaults: { pages: 0 } });
    expect(view.settings.map((field) => field.key)).toEqual(["pages", "agent"]);
    const command = createDefaultSkills().commands(registry).find((known) => known.word === "guide");
    expect(command).toMatchObject({ label: "guide", format: "guide", skill: "make" });
    const guide = registry.get("guide")!;
    expect(guide.settle!(settings({ pages: 0 }), { sourceChars: 50_000, sourceCount: 1 })).toEqual({ maker: "agent", pages: 3 });
    expect(guide.settle!(settings({ pages: 0 }), { sourceChars: 3_000, sourceCount: 1 })).toEqual({ maker: "agent", pages: 1 });
    expect(guide.describe!(settings({ pages: 2 }))).toEqual(["Your agent", "about 2 pages"]);
    const item = (key: string, type: string, raw: Record<string, number>) => ({ key, type, title: key, prompt: "", settings: raw, sources: [], enabled: true, level: 0 });
    const size = planSize({ title: "Revision", items: [item("a", "guide", { pages: 1 }), item("b", "quiz", {})], edges: [] } as unknown as DraftPlan, registry);
    expect(size).toContain("1 guide");
  });

  it("is not ready, and says why, when no agent is connected", () => {
    const registry = createDefaultRegistry();
    expect(registry.ready()).not.toContain("guide");
    expect(registry.problem("guide")).toMatch(/your own agent/);
  });
});

describe("a guide written by the person's agent", () => {
  it("is written section by section through tools that answer, and kept with a cite at every claim", async () => {
    const answers: Record<string, string> = {};
    const connector = new FakeConnector(async (agent) => {
      expect((await agent.call("read_skill", { path: "guide" })).text).toContain("reference");
      await agent.call("plan_guide", { title: "Mitosis on one page", about: "What mitosis is and its stages.", sections: 3 });
      answers.badQuote = (await agent.call("write_section", { title: "What it is", points: [{ ...definitionPoint, cites: [{ passage: "P1", quote: "cells split in half" }] }] })).text;
      answers.noCite = (await agent.call("write_section", { title: "What it is", points: [{ ...definitionPoint, cites: [] }] })).text;
      answers.list = (await agent.call("write_section", { title: "What it is", points: [{ ...definitionPoint, text: "- prophase\n- metaphase" }] })).text;
      answers.citedBackground = (await agent.call("write_section", { title: "What it is", points: [{ ...definitionPoint, background: true }] })).text;
      answers.first = (await agent.call("write_section", { title: "What it is", points: [definitionPoint] })).text;
      answers.stages = (await agent.call("write_section", stages)).text;
      answers.beyond = (await agent.call("write_section", { title: "Remember", points: [{ text: "It takes about 80 minutes in a human cell.", cites: [{ passage: "P1", quote: "It has four stages" }] }, { text: "A way to remember the order: PMAT.", background: true }] })).text;
      answers.read = (await agent.call("read_guide")).text;
      answers.finish = (await agent.call("finish_guide", { note: "Your notes hold only two short passages on mitosis, so it fills well under a page." })).text;
      return { ok: true };
    });
    const result = await runEngine(definition(connector), context(settings({ pages: 1 })));

    expect(answers.badQuote).toContain("not word for word in P1");
    expect(answers.noCite).toContain("set background to true");
    expect(answers.list).toContain("no headings, list marks or line breaks");
    expect(answers.citedBackground).toContain("a background point is your own explanation, so it cites nothing");
    expect(answers.first).toMatch(/^Kept as s1, section 1 of 1 \(3 planned\): 1 point, \d+ words\. The guide so far fills about half a page/);
    expect(answers.beyond).toContain("your sources do not contain 80");
    expect(answers.read).toContain("## s2 · The stages, in order");
    expect(answers.read).toContain("(background): A way to remember the order: PMAT.");
    expect(answers.finish).toContain("The guide is finished and kept");

    expect(result.report.valid).toBe(true);
    const guide = result.output.payload;
    expect(guide.title).toBe("Mitosis on one page");
    expect(guide.lengthNote).toContain("well under a page");
    expect(guide.sections.map((section) => [section.id, section.title, section.points.map((point) => point.id)])).toEqual([
      ["s1", "What it is", ["p1"]],
      ["s2", "The stages, in order", ["p2", "p3"]],
      ["s3", "Remember", ["p4", "p5"]],
    ]);
    expect(guide.sections[0]!.points[0]).toMatchObject({ term: "Mitosis", background: false, cites: [{ sourceId: "src-1", chunkId: "chunk-1" }] });
    expect(guide.sections[2]!.points[1]).toMatchObject({ background: true, cites: [] });
    expect(result.output.citations.map((cite) => cite.anchor)).toEqual(["sections[0].points[0]", "sections[1].points[0]", "sections[1].points[1]", "sections[2].points[0]"]);
  });

  it("asks for a word to the person when it runs far from the pages asked", async () => {
    let first = "";
    const connector = new FakeConnector(async (agent) => {
      await agent.call("write_section", { title: "What it is", points: [definitionPoint] });
      first = (await agent.call("finish_guide", { title: "Short" })).text;
      await agent.call("finish_guide", { note: "Your notes hold only a few lines on mitosis." });
      return { ok: true };
    });
    const result = await runEngine(definition(connector), context(settings({ pages: 4 })));
    expect(first).toContain("call finish_guide again with `note`");
    expect(result.output.payload.lengthNote).toContain("a few lines");
  });

  it("an agent that ends in an error of its own before writing anything fails as that, with its own words", async () => {
    const said = "The 'some-model' model is not supported on this account.";
    const connector = new FakeConnector(async () => ({ ok: false, problem: "error", said }));
    const failure = await runEngine(definition(connector), context(settings())).catch((error: unknown) => error);
    expect(failure).toMatchObject({ failureCode: "agent_error", said, retryable: false });
  });
});

const made: GuidePayload = {
  schemaVersion: 1,
  title: "Mitosis",
  about: "What mitosis is.",
  sections: [
    {
      id: "s1",
      title: "What it is",
      points: [
        { id: "p1", term: "Mitosis", text: "One nucleus into two.", background: false, cites: [{ sourceId: "src-1", quote: "the division of one cell nucleus" }] },
        { id: "p2", text: "My own reminder.", background: true, cites: [] },
      ],
    },
    { id: "s2", title: "Stages", points: [{ id: "p3", term: "Anaphase", text: "Chromatids pulled apart.", background: false, cites: [{ sourceId: "src-1", quote: "pulled to opposite poles" }] }] },
  ],
};

describe("a spot of a guide in words", () => {
  it("is the section, the point pointed at, and whose words each point is", () => {
    const words = guideAnchor(made, { section: "s1", point: "p1" })!;
    expect(words.label).toBe('at "Mitosis"');
    expect(words.facts[0]).toBe('In section 1 of 2: "What it is".');
    expect(words.facts[1]).toContain('pointing at this point: "Mitosis: One nucleus into two." It cites: "the division of one cell nucleus".');
    expect(words.facts.join("\n")).toContain("the maker's own explanation");
    expect(guideAnchor(made, { section: "s2" })!.label).toBe('in "Stages"');
    expect(guideAnchor(made, { time: 3 })).toBeUndefined();
  });
});

describe("a guide changed by hand", () => {
  const sent = (sections: unknown, title = "Mitosis") => ({ title, sections });

  it("keeps what was not touched, marks a changed point as theirs with the maker's words kept, and adds their own points with no cites", () => {
    const change = editGuide(
      made,
      sent([
        { id: "s2", title: "Stages, in order", points: [{ id: "p3", term: "Anaphase", text: "Chromatids pulled to the poles." }] },
        { id: "s1", title: "What it is", points: [{ id: "p1", term: "Mitosis", text: "One nucleus into two." }, { text: "Ask about this in class." }] },
        { title: "My questions", points: [{ text: "Why four stages?" }] },
      ]),
      "2026-11-20T10:00:00.000Z",
    );
    if (!change.ok) throw new Error(change.problems.join(" "));
    const { payload } = change;
    expect(payload.editedAt).toBe("2026-11-20T10:00:00.000Z");
    expect(payload.sections.map((section) => [section.id, section.title])).toEqual([
      ["s2", "Stages, in order"],
      ["s1", "What it is"],
      ["s3", "My questions"],
    ]);
    expect(payload.sections[1]!.points[0]).toEqual(made.sections[0]!.points[0]);
    expect(payload.sections[0]!.points[0]).toMatchObject({ id: "p3", text: "Chromatids pulled to the poles.", yours: true, made: { term: "Anaphase", text: "Chromatids pulled apart." }, cites: [{ quote: "pulled to opposite poles" }] });
    expect(payload.sections[1]!.points[1]).toEqual({ id: "p4", text: "Ask about this in class.", background: false, cites: [], yours: true });
    expect(payload.sections[2]!.points[0]!.id).toBe("p5");
    // The background point left out is removed; the cites follow their points.
    expect(payload.sections.flatMap((section) => section.points.map((point) => point.id))).not.toContain("p2");
    expect(change.citations.map((cite) => cite.anchor)).toEqual(["sections[0].points[0]", "sections[1].points[0]"]);
  });

  it("makes a point the maker's again when its words are put back, and drops a point emptied by hand", () => {
    const first = editGuide(made, sent([{ id: "s1", title: "What it is", points: [{ id: "p1", term: "Mitosis", text: "Changed." }, { id: "p2", text: "" }] }]), "t1");
    if (!first.ok) throw new Error("refused");
    expect(first.payload.sections[0]!.points).toHaveLength(1);
    const back = editGuide(first.payload, sent([{ id: "s1", title: "What it is", points: [{ id: "p1", term: "Mitosis", text: "One nucleus into two." }] }]), "t2");
    if (!back.ok) throw new Error("refused");
    expect(back.payload.sections[0]!.points[0]).toEqual(made.sections[0]!.points[0]);
  });

  it("refuses what it cannot keep, in plain sentences", () => {
    const refused = editGuide(made, sent([{ id: "s1", title: "", points: [{ term: "A term", text: "" }, { text: "x".repeat(2_000) }] }]), "t");
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.problems).toEqual(["Section 1 needs a heading.", "Section 1, point 1 has a term but no words.", "Section 1, point 2 is longer than 1200 characters; split it into points."]);
    expect(editGuide(made, "nonsense", "t").ok).toBe(false);
  });
});

describe("PUT /v1/outputs/:id/payload", () => {
  async function setup() {
    const registry = new FormatRegistry().register(createGuideDefinition()).register(fakeDefinition("quiz", emptyLog()));
    const engine = createTestEngine({ registry });
    const ownerId = await ownerIdForToken(CLIENT_TOKEN);
    const guide = await engine.deps.repos.outputs.create({ ownerId, type: "guide", schemaVersion: 1, title: "Mitosis", payload: made, citations: [] });
    const quiz = await engine.deps.repos.outputs.create({ ownerId, type: "quiz", schemaVersion: 1, title: "Quiz", payload: {} });
    const theirs = await engine.deps.repos.outputs.create({ ownerId: "client:someone-else", type: "guide", schemaVersion: 1, title: "Theirs", payload: made });
    const put = async (id: string, body: unknown) => {
      const response = await handleRequest(authed(`/v1/outputs/${id}/payload`, { method: "PUT", body }), engine.deps);
      return { status: response.status, body: await bodyOf(response) };
    };
    return { guide, quiz, theirs, put };
  }

  it("keeps the guide as the person changed it, with its title and cites again", async () => {
    const t = await setup();
    const answer = await t.put(t.guide.id, { title: "Mitosis, my notes", sections: [{ id: "s1", title: "What it is", points: [{ id: "p1", term: "Mitosis", text: "One nucleus into two." }, { text: "Mine." }] }] });
    expect(answer.status).toBe(200);
    expect(answer.body.output).toMatchObject({ id: t.guide.id, type: "guide", title: "Mitosis, my notes" });
    expect(answer.body.output.payload.sections[0].points[1]).toMatchObject({ text: "Mine.", yours: true });
    expect(answer.body.output.citations).toHaveLength(1);
  });

  it("refuses a bad change, a format not changed by hand, and another person's output", async () => {
    const t = await setup();
    const bad = await t.put(t.guide.id, { sections: [{ title: "" }] });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_edit" } });
    expect(bad.body.message).toContain("needs a heading");
    expect(await t.put(t.quiz.id, { sections: [] })).toMatchObject({ status: 409, body: { error: "not_editable" } });
    expect((await t.put(t.theirs.id, { sections: [] })).status).toBe(404);
  });
});

describe("a guide's own agent, model and effort", () => {
  it("reach the connector", async () => {
    const connector = new FakeConnector(async () => ({ ok: false, problem: "error", said: "stop here" }));
    await runEngine(definition(connector), context(settings({ pages: 1, agent: "agent:codex:gpt-5", effort: "high" }))).catch(() => undefined);
    const body = connector.bodies[0] as unknown as Record<string, unknown>;
    expect([body.agent, body.model, body.effort]).toEqual(["codex", "gpt-5", "high"]);
  });
});
