/**
 * Teach-back: the person explains an idea in their own words and Open Sourcebook answers
 * with what was right, what was left out and what was wrong, each cited at
 * the spot in their sources (docs/api.md, "Reply blocks"). The block is read
 * and checked like any other, the skill is a command and a route, and the
 * person's agent is told how to do the same.
 */
import { describe, expect, it } from "vitest";
import { ANSWER_SYSTEM_PROMPT, readAnswer } from "../src/chat/answer";
import { agentSystemPrompt } from "../src/chat/agent/prompt";
import { createDefaultTools } from "../src/chat/agent/default-tools";
import { createDefaultSkills } from "../src/chat/default-skills";
import { pieceKinds } from "../src/chat/pieces";
import { ROUTER_SYSTEM_PROMPT } from "../src/chat/router";
import { SkillRegistry } from "../src/chat/skills";
import { createTeachBackSkill, TEACH_BACK_GUIDE, TEACH_BACK_START } from "../src/chat/teach-back";
import { blockGuide } from "../src/chat/writing";
import { handleRequest } from "../src/index";
import type { Passage } from "../src/sources/passages";
import { createDefaultConditions } from "../src/studio/conditions";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { StructuredGenerationRequest } from "../src/types";
import { authed, bodyOf, createTestEngine, type ProviderAnswer } from "./support/engine-harness";

const passages: Passage[] = [
  { id: "c1", label: "S1#1", sourceId: "s1", text: "Plants make glucose from carbon dioxide and water. The energy comes from sunlight, caught by chlorophyll." },
  { id: "c2", label: "S1#2", sourceId: "s1", text: "Oxygen is given off as a by-product." },
];

describe("the teachback block", () => {
  it("reads each point with its verdict and cites, grouped right, missing, wrong", () => {
    const read = readAnswer(
      {
        blocks: [
          { kind: "paragraph", text: "Close: you have the inputs, but not where the energy comes from." },
          {
            kind: "teachback",
            items: [
              { verdict: "wrong", text: "The energy comes from sunlight, not from the soil.", cites: [{ passage: "S1#1", quote: "The energy comes from sunlight" }] },
              { verdict: "right", text: "Plants make glucose from carbon dioxide and water.", cites: [{ passage: "S1#1", quote: "make glucose from carbon dioxide and water" }] },
              { verdict: "Missing", text: "Oxygen is given off.", cites: [{ passage: "S1#2", quote: "Oxygen is given off" }] },
            ],
          },
        ],
      },
      passages,
      [],
      { strict: true },
    );
    expect(read.problems).toEqual([]);
    expect(read.badQuotes).toEqual([]);
    const block = read.reply.pieces[1] as unknown as Record<string, unknown>;
    expect(block).toMatchObject({
      kind: "teachback",
      items: [
        // Cites keep the order they were written in; the client numbers its chips in reading order.
        { verdict: "right", text: "Plants make glucose from carbon dioxide and water.", cites: [1] },
        { verdict: "missing", text: "Oxygen is given off.", cites: [2] },
        { verdict: "wrong", text: "The energy comes from sunlight, not from the soil.", cites: [0] },
      ],
      cites: [],
    });
    const text = "What you got right:\n- Plants make glucose from carbon dioxide and water.\n\nWhat you left out:\n- Oxygen is given off.\n\nWhat the sources say differently:\n- The energy comes from sunlight, not from the soil.";
    expect(block.text).toBe(text);
    // A client or a prompt that does not know the kind reads it grouped, in plain words.
    expect(pieceKinds.asText(block as never)).toBe(text);
  });

  it("marks an item whose cite fails, and sends back an item with no verdict or a block with no items", () => {
    const read = readAnswer({ blocks: [{ kind: "teach-back", items: [{ verdict: "right", text: "Leaves eat light.", cites: [{ passage: "S1#1", quote: "leaves eat light" }] }] }] }, passages, [], { strict: true });
    expect(read.badQuotes).toEqual([{ passage: "S1#1", quote: "leaves eat light" }]);
    expect((read.reply.pieces[0] as unknown as { items: unknown[] }).items).toEqual([{ verdict: "right", text: "Leaves eat light.", cites: [], unchecked: true }]);

    const unsure = readAnswer({ blocks: [{ kind: "teachback", items: [{ verdict: "partly", text: "Something." }] }] }, passages, [], { strict: true });
    expect(unsure.problems).toEqual(['Block 1 (teachback): item 1 needs a `verdict` of "right", "missing", "wrong".']);
    const empty = readAnswer({ blocks: [{ kind: "teachback", items: [] }] }, passages, [], { strict: true });
    expect(empty.problems).toEqual(["Block 1 (teachback): it needs `items`, each with a `verdict` and `text`."]);
  });

  it("is described to every writer, and the reply tool takes a verdict on an item", () => {
    expect(blockGuide()).toContain('- "teach-back": Feedback on the person');
    const reply = createDefaultTools().get("reply")!;
    const block = (reply.inputSchema as { properties: { blocks: { items: { properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }> } } } }).properties.blocks.items.properties;
    expect(block.kind.enum).toEqual(expect.arrayContaining(["teachback", "teach-back"]));
    expect(block.items.items!.properties.verdict.enum).toEqual(["right", "missing", "wrong"]);
  });
});

const PHOTOSYNTHESIS = "Plants make glucose from carbon dioxide and water. The energy comes from sunlight, caught by chlorophyll.";

async function setup(answer: ProviderAnswer, skills = new SkillRegistry().register(createTeachBackSkill())) {
  const engine = createTestEngine({ answer, skills });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await handleRequest(authed(path, { method, ...(body === undefined ? {} : { body }) }), engine.deps);
    return { status: response.status, body: await bodyOf(response) };
  };
  const project = (await call("/v1/projects", "POST", { title: "Biology" })).body.project;
  await call("/v1/sources", "POST", { text: PHOTOSYNTHESIS, projectId: project.id });
  const chat = (await call(`/v1/projects/${project.id}/chats`, "POST", {})).body.chat;
  return { engine, call, chat };
}

/** The label the prompt gave the passage starting with `text`. */
function labelOf(request: StructuredGenerationRequest, text: string): string {
  const match = new RegExp(`\\[(P\\d+)\\][^\\n]*\\n${text.slice(0, 20)}`).exec(request.userPrompt);
  if (!match) throw new Error(`no passage starting "${text.slice(0, 20)}" in the prompt`);
  return match[1];
}

describe("the teach-back skill", () => {
  it("is a command with its own button words", async () => {
    const t = await setup(() => ({}));
    const listed = (await t.call("/v1/skills")).body;
    expect(listed.commands).toEqual([
      {
        command: "teachback",
        title: "Explain it back",
        group: "chat",
        label: "teach-back",
        action: "Explain it back",
        chatOnly: true,
        about: "Checks your own explanation of an idea against your sources: what you got right, what you left out and what you got wrong, each with the spot in your sources.",
        skill: "teachBack",
      },
    ]);
    // Among the default skills, beside the plan's.
    const words = createDefaultSkills().commands().map((command) => command.word);
    expect(words).toEqual(expect.arrayContaining(["plan", "teachback"]));
  });

  it("alone, asks for an explanation without calling a model", async () => {
    const t = await setup(() => {
      throw new Error("no model call expected");
    });
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/teachback" })).body.messages[1];
    expect(reply).toMatchObject({ skill: "teachBack", pieces: [{ kind: "text", text: TEACH_BACK_START }] });
    expect(t.engine.provider.calls).toHaveLength(0);
  });

  it("checks an explanation against the passages found from the person's own words, and answers with a cited teachback block", async () => {
    const t = await setup((request) =>
      request.systemPrompt === ANSWER_SYSTEM_PROMPT
        ? {
            blocks: [
              { kind: "paragraph", text: "Nearly: the inputs are right, the energy is not from the soil." },
              {
                kind: "teachback",
                items: [
                  { verdict: "right", text: "Glucose is made from carbon dioxide and water.", cites: [{ passage: labelOf(request, PHOTOSYNTHESIS), quote: "make glucose from carbon dioxide and water" }] },
                  { verdict: "wrong", text: "The energy comes from sunlight.", cites: [{ passage: labelOf(request, PHOTOSYNTHESIS), quote: "The energy comes from sunlight" }] },
                ],
              },
            ],
            covered: true,
          }
        : {},
    );
    const explanation = "Plants turn carbon dioxide and water into glucose, using energy from the soil.";
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: `/teachback ${explanation}` })).body.messages[1];
    expect(reply.skill).toBe("teachBack");
    expect(reply.pieces[1]).toMatchObject({ kind: "teachback", items: [{ verdict: "right", cites: [0] }, { verdict: "wrong", cites: [1] }] });
    expect(reply.cites).toHaveLength(2);
    const prompt = t.engine.provider.calls.find((request) => request.systemPrompt === ANSWER_SYSTEM_PROMPT)!.userPrompt;
    expect(prompt).toContain(TEACH_BACK_GUIDE);
    expect(prompt.split("Message:\n").at(-1)).toBe(explanation);
  });

  it("is chosen by the router for an explanation the person gives unasked", async () => {
    const t = await setup((request) =>
      request.systemPrompt === ROUTER_SYSTEM_PROMPT ? { use: "teachBack" } : { blocks: [{ kind: "teachback", items: [{ verdict: "missing", text: "Chlorophyll catches the light." }] }] },
    );
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "Let me explain it back: plants eat sunlight." })).body.messages[1];
    expect(reply.skill).toBe("teachBack");
    const router = t.engine.provider.calls.find((request) => request.systemPrompt === ROUTER_SYSTEM_PROMPT)!.userPrompt;
    expect(router).toContain("- teachBack: Checks your own explanation");
  });
});

describe("the person's agent", () => {
  it("is told how to answer a teach-back, and that the command exists", () => {
    const system = agentSystemPrompt(createDefaultRegistry(), createDefaultConditions(), createDefaultSkills().list());
    expect(system).toContain(`- A teach-back: the person explains an idea from their sources in their own words`);
    expect(system).toContain(TEACH_BACK_GUIDE);
    expect(system).toContain("- /teachback: Checks your own explanation");
  });
});
