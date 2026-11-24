/**
 * The planning skill through the chat routes, over the real repositories,
 * the real format registry and condition kinds, with a scripted model: a
 * plan is written through the plan model, checked and repaired, never
 * stored invalid, changed by later messages, and never fights a hand edit.
 */
import { describe, expect, it } from "vitest";
import { createDefaultSkills } from "../src/chat/default-skills";
import { ASK_SHAPE, EDIT_SHAPE, FORCED_NOTE, PLANNER_SYSTEM_PROMPT, catalog } from "../src/chat/planning/prompts";
import { createDefaultEdgeKinds } from "../src/studio/edge-kinds";
import { ROUTER_SYSTEM_PROMPT } from "../src/chat/router";
import { handleRequest } from "../src/index";
import { createDefaultConditions } from "../src/studio/conditions";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { StructuredGenerationRequest } from "../src/types";
import { authed, bodyOf, createTestEngine } from "./support/engine-harness";

const PRICE = { inputPerMillion: 1, outputPerMillion: 2 };
const NOTES = Array.from({ length: 6 }, (_, index) => `Part ${index + 1}. ${"Some material about this part of the notes. ".repeat(40)}`).join("\n\n");

type Script = (request: StructuredGenerationRequest, round: number) => unknown | Promise<unknown>;

async function setup(plan: Script, route: (text: string) => string = () => "planning") {
  let round = 0;
  const engine = createTestEngine({
    registry: createDefaultRegistry({ flashcards: { price: PRICE }, quiz: { price: PRICE } }),
    skills: createDefaultSkills(),
    answer: (request) => {
      if (request.systemPrompt === ROUTER_SYSTEM_PROMPT) return { use: route(request.userPrompt.split("Message:\n").at(-1)!) };
      if (request.systemPrompt === PLANNER_SYSTEM_PROMPT) return plan(request, round++);
      return { parts: [{ text: "an answer" }] };
    },
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Notes" })).body.project;
  const source = (await call("/v1/sources", "POST", { text: NOTES, projectId: project.id })).body.source;
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
  const say = async (text: string, extra: Record<string, unknown> = {}) => call(`/v1/chats/${chat.id}/messages`, "POST", { text, ...extra });
  const planPrompts = () => engine.provider.calls.filter((request) => request.systemPrompt === PLANNER_SYSTEM_PROMPT);
  return { engine, call, project, source, chat, say, planPrompts };
}

/** The plan piece of a reply, when it has one. */
function planOf(message: { pieces?: Array<Record<string, any>> }): Record<string, any> | undefined {
  return message.pieces?.find((piece) => piece.kind === "plan");
}

const TWO_STAGES = {
  reply: "Start with a quick check, then fill the gaps.",
  title: "Through the notes",
  stages: [
    { label: "Find the gaps", items: [{ key: "check", format: "quiz", title: "Quick check", brief: "Find what is not known yet.", settings: { questions: 5 }, sources: [{ source: "S1" }] }] },
    {
      items: [
        {
          key: "fix",
          format: "flashcards",
          title: "The first parts again",
          brief: "Go over what the check showed was missed.",
          sources: [{ source: "S1", from: 1, to: 2 }],
          branchOf: { item: "check", condition: { kind: "metric", metric: "score", below: 0.6 } },
          inputs: [{ item: "check", kind: "fix_of" }],
        },
        { key: "rest", format: "flashcards", title: "The rest", brief: "Parts three on.", sources: [{ source: "S1", from: 3 }], assumes: ["check"] },
      ],
    },
  ],
};

describe("making a plan in the chat", () => {
  it("/plan writes a checked, priced draft through the plan model and replies with it", async () => {
    const t = await setup(() => TWO_STAGES);
    const sent = await t.say("/plan");
    expect(sent.status).toBe(200);
    const reply = sent.body.messages[1];
    expect(reply).toMatchObject({ role: "assistant", skill: "planning", pieces: [{ kind: "text", text: TWO_STAGES.reply }, { kind: "plan", action: "created" }] });
    // Spend is not said in the chat; the plan card shows the estimate.
    expect(reply.text).not.toMatch(/\$/);

    const view = sent.body.plans[0];
    expect(view.plan).toMatchObject({ id: planOf(reply)!.planId, title: "Through the notes", status: "draft", projectId: t.project.id });
    expect(view.plan.chatId).toBe(t.chat.id);
    expect(view.stages).toEqual([{ level: 1, label: "Find the gaps" }]);
    const [check, fix, rest] = view.items;
    expect(check).toMatchObject({ level: 1, type: "quiz", title: "Quick check", prompt: "Find what is not known yet.", settings: { questions: 5 }, sources: [{ sourceId: t.source.id }] });
    expect(fix).toMatchObject({ level: 2, ord: 0, parentId: check.id, condition: { kind: "metric", metric: "score", below: 0.6 } });
    // A run of passages becomes the range those passages cover.
    expect(fix.sources[0].range).toMatchObject({ charStart: 0 });
    expect(rest.sources[0].range.charEnd).toBe(NOTES.trimEnd().length);
    expect(view.edges).toEqual(expect.arrayContaining([{ from: check.id, to: fix.id, kind: "fix_of" }, { from: check.id, to: rest.id, kind: "assumes" }]));
    for (const item of view.items) expect(item.estCostUsd).toBeGreaterThan(0);
    expect(view.issues).toEqual([]);

    // The planner was told what exists from the registries, not from a list of its own.
    const prompt = t.planPrompts()[0].userPrompt;
    expect(prompt).toContain("- flashcards (");
    expect(prompt).toContain("- quiz (");
    // A declared format is named as one that can't be made yet, never among the usable ones.
    const usable = prompt.slice(prompt.indexOf("Formats that can be made now"), prompt.indexOf("Formats Open Sourcebook can't make yet"));
    expect(usable).not.toContain("- video (");
    expect(prompt).toMatch(/Formats Open Sourcebook can't make yet \(never in a plan\):\n(?:- .*\n)*- video \("video"\): .*Open Sourcebook can't make it yet/);
    expect(prompt).toContain(FORCED_NOTE);
    expect(prompt).toContain("- metric:");
    expect(prompt).toContain("- ask:");
    expect(prompt).toContain("score (share of the points earned");
    expect(prompt).toMatch(/S1: .*6 passages|S1: .*passages/);
    // It never routes a forced /plan.
    expect(t.engine.provider.calls.some((request) => request.systemPrompt === ROUTER_SYSTEM_PROMPT)).toBe(false);
  });

  it("sends a plan with problems back with them, and stores only the fixed one", async () => {
    const t = await setup((_, round) =>
      round === 0
        ? {
            title: "Bad",
            stages: [
              { items: [{ key: "a", format: "video", title: "Watch", sources: [{ source: "S1" }] }] },
              { items: [{ key: "b", format: "quiz", title: "Q", settings: { questions: 9999 }, sources: [{ source: "S9" }], branchOf: { item: "b", condition: { kind: "never" } } }] },
            ],
          }
        : TWO_STAGES,
    );
    const sent = await t.say("/plan");
    expect(planOf(sent.body.messages[1])!.action).toBe("created");
    const second = t.planPrompts()[1].userPrompt;
    expect(second).toContain('"video" is not a format that can be made now');
    expect(second).toContain("questions must be a whole number");
    expect(second).toContain('source "S9" is not one of S1');
    expect(second).toContain('no resolver decides condition kind "never"');
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toHaveLength(1);
  });

  it("stores nothing when the plan never holds together, and says why", async () => {
    const t = await setup(() => ({ stages: [] }));
    const reply = (await t.say("/plan")).body.messages[1];
    expect(reply.text).toMatch(/nothing was saved/);
    expect(planOf(reply)).toBeUndefined();
    expect(t.planPrompts()).toHaveLength(3);
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toEqual([]);
  });

  it("keeps the estimate within a budget the person gave", async () => {
    const t = await setup((_, round) => ({ ...TWO_STAGES, budgetUsd: round === 0 ? 0.000001 : 10 }));
    const view = (await t.say("/plan under ten dollars")).body.plans[0];
    expect(t.planPrompts()[1].userPrompt).toContain("is over the plan budget");
    expect(view.plan.budgetUsd).toBe(10);
  });

  it("is chosen by the router for a plain request, and says so when there is nothing to plan from", async () => {
    const t = await setup(() => TWO_STAGES, (text) => (text.includes("plan") ? "planning" : "answer"));
    expect(planOf((await t.say("make me a plan for these notes")).body.messages[1])!.action).toBe("created");
    const empty = (await t.call(`/v1/projects/${t.project.id}/chats`, "POST", { sources: [] })).body.chat;
    const reply = (await t.call(`/v1/chats/${empty.id}/messages`, "POST", { text: "/plan" })).body.messages[1];
    expect(reply.text).toMatch(/no sources to plan from/);
  });
});

describe("changing the plan from the chat", () => {
  async function planned(edit: Script) {
    const t = await setup((request, round) => (round === 0 ? TWO_STAGES : edit(request, round)));
    const view = (await t.say("/plan")).body.plans[0];
    return { ...t, view };
  }

  it("changes named items and stages and leaves the rest", async () => {
    const t = await planned(() => ({
      reply: "Shorter check, and a closing quiz.",
      ops: [
        { op: "change", item: "I1", settings: { questions: 3 } },
        { op: "addStage", key: "end", after: 2, label: "Wrap up" },
        { op: "add", key: "final", stage: "end", format: "quiz", title: "Last quiz", brief: "Everything.", sources: [{ source: "S1" }], assumes: ["I3"] },
        { op: "label", stage: 1, label: "Start" },
      ],
    }));
    const sent = await t.say("make the check shorter and add a quiz at the end");
    const reply = sent.body.messages[1];
    expect(planOf(reply)!).toMatchObject({ planId: t.view.plan.id, action: "edited" });
    // The new stage is said with the item put in it, not as a line of its own.
    expect(planOf(reply)!.changes).toEqual(['Changed "Quick check" (quiz): settings.', 'Added "Last quiz" (quiz) in a new stage "Wrap up".', 'Labelled a stage "Start".']);
    const view = sent.body.plans[0];
    expect(view.items.map((item: any) => [item.title, item.level])).toEqual([
      ["Quick check", 1],
      ["The first parts again", 2],
      ["The rest", 2],
      ["Last quiz", 3],
    ]);
    // What the change left open (the maker) is set as it would be made now.
    expect(view.items[0].settings).toEqual({ questions: 3, maker: "api" });
    expect(view.items[1]).toMatchObject({ id: t.view.items[1].id, prompt: t.view.items[1].prompt });
    expect(view.stages).toEqual([
      { level: 1, label: "Start" },
      { level: 3, label: "Wrap up" },
    ]);
    expect(view.edges).toContainEqual({ from: view.items[2].id, to: view.items[3].id, kind: "assumes" });
    // The model was shown the plan as it was, by reference.
    expect(t.planPrompts()[1].userPrompt).toContain('I1 [quiz] "Quick check"');
  });

  it("says each change once: a new stage with the items put in it, and nothing for a new stage left empty", async () => {
    const t = await planned(() => ({
      reply: "The plan now ends with a pair of quizzes.",
      ops: [
        { op: "addStage", key: "end", after: 2 },
        { op: "label", stage: "end", label: "Wrap up" },
        { op: "add", key: "a", stage: "end", format: "quiz", title: "Recall", brief: "Recall.", sources: [{ source: "S1" }] },
        { op: "add", key: "b", stage: "end", format: "quiz", title: "Apply", brief: "Apply.", sources: [{ source: "S1" }] },
        { op: "addStage", key: "unused", after: "end", label: "Never filled" },
        { op: "addStage", key: "mid", after: 1 },
        { op: "move", item: "I3", stage: "mid" },
      ],
    }));
    const sent = await t.say("end with two quizzes side by side, and give the rest its own stage");
    const reply = sent.body.messages[1];
    expect(planOf(reply)!.changes).toEqual([
      'Added "Recall" (quiz) in a new stage "Wrap up".',
      'Added "Apply" (quiz) beside "Recall".',
      'Moved "The rest" (flashcards) to a new stage.',
    ]);
    expect(reply.text.startsWith("The plan now ends with a pair of quizzes.")).toBe(true);
    expect(sent.body.plans[0].stages).toContainEqual({ level: 4, label: "Wrap up" });
    expect(JSON.stringify(sent.body.plans[0].stages)).not.toContain("Never filled");
  });

  it("tells the planner the card lists the changes, so its reply gives the gist", () => {
    expect(EDIT_SHAPE).toContain("so your reply never lists them again");
    expect(EDIT_SHAPE).not.toContain("Your reply says exactly what your ops change");
  });

  it("shifts later stages when a stage is put between two", async () => {
    const t = await planned(() => ({ ops: [{ op: "addStage", key: "mid", after: 1 }, { op: "move", item: "I3", stage: "mid" }] }));
    const view = (await t.say("put the rest in its own stage before the fix")).body.plans[0];
    expect(view.items.map((item: any) => [item.title, item.level])).toEqual([
      ["Quick check", 1],
      ["The rest", 2],
      ["The first parts again", 3],
    ]);
    expect(view.issues).toEqual([]);
  });

  it("leaves an item the person edited by hand meanwhile as they have it", async () => {
    let engineRef: any;
    const t = await planned(async () => {
      // The person edits the check in the card while the model is writing.
      const check = (await engineRef.deps.repos.plans.listNodes(planId))[0];
      engineRef.clock.advance(1000);
      await engineRef.deps.repos.plans.updateNode(check.id, { title: "My own title" });
      return { reply: "Done.", ops: [{ op: "change", item: "I1", title: "Model title" }, { op: "change", item: "I2", brief: "New brief." }] };
    });
    engineRef = t.engine;
    const planId = t.view.plan.id;
    const sent = await t.say("rename the check and rewrite the fix brief");
    const view = sent.body.plans[0];
    expect(view.items[0].title).toBe("My own title");
    expect(view.items[1].prompt).toBe("New brief.");
    expect(planOf(sent.body.messages[1])!.changes).toContain('You changed "My own title" while I was working, so I left it as you have it.');
    expect(sent.body.messages[1].text).toContain("so I left it as you have it");
  });

  it("removes an item with its branches, and sends an approved plan back to draft", async () => {
    const t = await planned(() => ({ ops: [{ op: "remove", item: "I1" }] }));
    expect((await t.call(`/v1/plans/${t.view.plan.id}/approve`, "POST")).body.plan.status).toBe("approved");
    const sent = await t.say("drop the check");
    expect(planOf(sent.body.messages[1])!.changes).toEqual(['Removed "Quick check" (quiz) and its 1 branch item.']);
    expect(sent.body.plans[0].items.map((item: any) => item.title)).toEqual(["The rest"]);
    expect(sent.body.plans[0].plan.status).toBe("draft");
  });

  it("refuses a change that breaks the plan, after asking for a fix", async () => {
    const t = await planned(() => ({ ops: [{ op: "move", item: "I1", stage: 2 }] }));
    const sent = await t.say("move the check next to the fix");
    expect(sent.body.messages[1].text).toMatch(/nothing was saved/);
    expect(t.planPrompts()[2].userPrompt).toMatch(/must be in a later stage than "[^"]+"/);
    expect((await t.call(`/v1/plans/${t.view.plan.id}`)).body.items.map((item: any) => item.level)).toEqual([1, 2, 2]);
  });

  it("makes a new plan when the model says a different one was asked for, and after Start", async () => {
    const t = await planned((_, round) => (round === 1 ? { newPlan: true } : TWO_STAGES));
    expect(planOf((await t.say("now a separate plan for something else")).body.messages[1])!.action).toBe("created");
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toHaveLength(2);
  });

  it("will not change a started plan it is pointed at", async () => {
    const t = await planned(() => ({ ops: [] }));
    await t.engine.deps.repos.plans.transition(t.view.plan.id, ["draft"], "running");
    const reply = (await t.say("@Through the notes shorter", { mentions: [{ kind: "plan", id: t.view.plan.id }] })).body.messages[1];
    expect(reply.text).toMatch(/has started, so it can't change/);
    expect(planOf(reply)).toBeUndefined();
  });
});

describe("asking before planning", () => {
  const ASK = { ask: { reply: "Two things first.", questions: [{ text: "What is it for?", options: ["An exam", "Just to understand it"] }, { text: "Anything you already know well?" }] } };

  it("may ask first when Open Sourcebook chose to plan, and plans once a picked option comes back", async () => {
    const t = await setup((_, round) => (round === 0 ? ASK : TWO_STAGES));
    const reply = (await t.say("make me a plan")).body.messages[1];
    expect(t.planPrompts()[0].userPrompt).toContain(ASK_SHAPE);
    expect(reply.pieces).toEqual([
      { kind: "text", text: "Two things first.", cites: [] },
      { kind: "question", id: "q1", text: "What is it for?", options: [{ id: "o1", label: "An exam", skill: "planning" }, { id: "o2", label: "Just to understand it", skill: "planning" }], multiple: false },
      { kind: "question", id: "q2", text: "Anything you already know well?", options: [], multiple: false },
    ]);
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toEqual([]);

    const sent = await t.say("An exam", { answer: { messageId: reply.id, picks: [{ questionId: "q1", optionIds: ["o1"] }] } });
    expect(planOf(sent.body.messages[1])!.action).toBe("created");
    // The answer reached the planner as part of the conversation.
    expect(t.planPrompts()[1].userPrompt).toContain("What is it for?\n(options: An exam / Just to understand it)");
    expect(t.planPrompts()[1].userPrompt).toContain("What the person asked: An exam");
  });

  it("/plan plans at once and is never told it may ask", async () => {
    const t = await setup((_, round) => (round === 0 ? ASK : TWO_STAGES));
    const sent = await t.say("/plan");
    expect(t.planPrompts()[0].userPrompt).not.toContain(ASK_SHAPE);
    // An ask in answer to /plan is a plan with problems, sent back to be fixed.
    expect(t.planPrompts()).toHaveLength(2);
    expect(planOf(sent.body.messages[1])!.action).toBe("created");
  });

  it("says more below the plan when the planner has more to say", async () => {
    const t = await setup(() => ({ ...TWO_STAGES, after: "Start it when you're ready." }));
    const reply = (await t.say("/plan")).body.messages[1];
    expect(reply.pieces.map((piece: any) => piece.kind)).toEqual(["text", "plan", "text"]);
    expect(reply.pieces[2].text).toBe("Start it when you're ready.");
  });
});

describe("talking about a plan", () => {
  it("answers a remark about the plan without changing it or drawing the card again", async () => {
    const t = await setup((_, round) => (round === 0 ? TWO_STAGES : { reply: "You're right: these are bytes and a quiz. Open Sourcebook can't make videos yet.", ops: [] }));
    const made = (await t.say("/plan")).body;
    const remark = (await t.say("these are not what I asked for")).body;
    expect(remark.messages[1]).toMatchObject({ skill: "planning", pieces: [{ kind: "text", text: "You're right: these are bytes and a quiz. Open Sourcebook can't make videos yet." }] });
    expect(planOf(remark.messages[1])).toBeUndefined();
    expect(remark.plans).toEqual([]);
    const prompt = t.planPrompts()[1].userPrompt;
    expect(prompt).toContain("What the person said: these are not what I asked for");
    expect(prompt).toContain("If the message is a remark or a question about the plan");
    expect((await t.call(`/v1/plans/${made.plans[0].plan.id}`)).body.items).toHaveLength(3);
  });

  it("may ask back before changing a plan", async () => {
    const t = await setup((_, round) => (round === 0 ? TWO_STAGES : { ask: { reply: "Which do you mean?", questions: [{ text: "Change what?", options: ["The check", "The rest"] }] } }));
    await t.say("/plan");
    const reply = (await t.say("change it")).body.messages[1];
    expect(reply.pieces.map((piece: any) => piece.kind)).toEqual(["text", "question"]);
    expect(reply.pieces[1].options[0].skill).toBe("planning");
  });
});

describe("items made by hand", () => {
  async function withHandItem(edit: Script) {
    const t = await setup((request, round) => (round === 0 ? TWO_STAGES : edit(request, round)));
    const view = (await t.say("/plan")).body.plans[0];
    t.engine.clock.advance(1_000);
    const added = await t.call(`/v1/plans/${view.plan.id}/items`, "POST", { type: "video", title: "yo", level: 3 });
    expect(added.status).toBe(201);
    t.engine.clock.advance(1_000);
    return { ...t, view };
  }
  const removeAll = () => ({ reply: "Took out the stray item and shortened the check.", ops: [{ op: "remove", item: "I4" }, { op: "change", item: "I1", settings: { questions: 3 } }] });

  it("is marked for the planner and left alone when the message does not name it", async () => {
    const t = await withHandItem(removeAll);
    const sent = await t.say("make the check shorter");
    expect(t.planPrompts()[1].userPrompt).toMatch(/I4 \[video\] "yo" \(made or changed by the person by hand: leave it unless they ask about it\)/);
    expect(t.planPrompts()[1].userPrompt).not.toMatch(/I1 \[quiz\] "Quick check" \(made or changed/);
    expect(planOf(sent.body.messages[1])!.changes).toEqual([
      'Changed "Quick check" (quiz): settings.',
      '"yo" (video) is one you made or changed by hand, and your message didn\'t name it, so I left it as it is.',
    ]);
    expect(sent.body.plans[0].items.map((item: any) => item.title)).toContain("yo");
  });

  it("is changed when the message names it by its title", async () => {
    const t = await withHandItem(() => ({ reply: 'Removed "yo" (video).', ops: [{ op: "remove", item: "I4" }] }));
    const sent = await t.say("take yo out");
    expect(planOf(sent.body.messages[1])!.changes).toEqual(['Removed "yo" (video).']);
    expect(sent.body.plans[0].items.map((item: any) => item.title)).not.toContain("yo");
    // A title inside another word does not name it.
    const again = await withHandItem(removeAll);
    expect(planOf((await again.say("can you shorten it")).body.messages[1])!.changes).toContain('"yo" (video) is one you made or changed by hand, and your message didn\'t name it, so I left it as it is.');
  });
});

describe("a second plan in one chat", () => {
  it("is told it is new, not a change to the earlier plan", async () => {
    const t = await setup(() => TWO_STAGES);
    await t.say("/plan");
    expect(planOf((await t.say("/plan")).body.messages[1])!.action).toBe("created");
    expect(t.planPrompts()[1].userPrompt).toContain("This is a new, separate plan");
    expect(t.planPrompts()[0].userPrompt).not.toContain("This is a new, separate plan");
    expect((await t.call(`/v1/projects/${t.project.id}/plans`)).body.plans).toHaveLength(2);
  });
});

describe("what the planner is told about settings", () => {
  it("names each option by the value it writes, with what picking it does, read from the descriptors", () => {
    const text = catalog(createDefaultRegistry(), createDefaultConditions());
    expect(text).toContain("cards: number from 0 to 200 (How many cards the set has, which is how far it goes");
    expect(text).toContain("kinds (Which kinds of card it may use; the maker picks among them for each thing to remember.): a list of at least 1 of recall (");
    expect(text).toContain("kinds (Which kinds of question it may use.): a list of at least 1 of choice (Pick the one right answer from a few options.) | worked (");
    expect(text).toContain("feedback: one of afterEach (");
    // "Save only" makes nothing, so it is not offered.
    expect(text).not.toContain("saveOnly (");
  });

  it("lists the kinds of link between items from the edge kind registry, including one just registered", () => {
    const kinds = createDefaultEdgeKinds();
    const text = catalog(createDefaultRegistry(), createDefaultConditions(), kinds);
    for (const kind of kinds.list()) expect(text).toContain(`- ${kind.id}: ${kind.about}`);
    kinds.register({ id: "recaps", label: "Recaps", about: "Goes over what the earlier item made, briefly.", reads: "input" });
    expect(catalog(createDefaultRegistry(), createDefaultConditions(), kinds)).toContain("- recaps: Goes over what the earlier item made, briefly.");
    expect(PLANNER_SYSTEM_PROMPT).not.toContain("relation word");
    expect(EDIT_SHAPE).toContain('"kind": "<a link kind>"');
  });
});
