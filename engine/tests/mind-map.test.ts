/**
 * Mind map: the main ideas of the sources and how they connect, laid out as
 * a map in the chat's reply, each idea cited at the spot that says it
 * (docs/api.md, "Reply blocks"). The block is read and checked like any
 * other, the skill is a command and a route, and the person's agent is
 * told how to do the same.
 */
import { describe, expect, it } from "vitest";
import { ANSWER_SYSTEM_PROMPT, readAnswer } from "../src/chat/answer";
import { agentSystemPrompt } from "../src/chat/agent/prompt";
import { createDefaultTools } from "../src/chat/agent/default-tools";
import { MAX_MAP_NODES } from "../src/chat/blocks";
import { createDefaultSkills } from "../src/chat/default-skills";
import { createMindMapSkill, MIND_MAP_GUIDE } from "../src/chat/mind-map";
import { pieceKinds } from "../src/chat/pieces";
import { ROUTER_SYSTEM_PROMPT } from "../src/chat/router";
import { SkillRegistry } from "../src/chat/skills";
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

const MAP = {
  kind: "mindmap",
  nodes: [
    { id: "p", text: "Photosynthesis", detail: "Plants make glucose from carbon dioxide and water.", cites: [{ passage: "S1#1", quote: "Plants make glucose from carbon dioxide and water" }] },
    { id: "light", text: "Sunlight", cites: [{ passage: "S1#1", quote: "The energy comes from sunlight" }] },
    { id: "chl", text: "Chlorophyll", detail: "It catches the light.", cites: [{ passage: "S1#1", quote: "caught by chlorophyll" }] },
    { id: "o2", text: "Oxygen", cites: [{ passage: "S1#2", quote: "Oxygen is given off" }] },
  ],
  links: [
    { from: "light", to: "p", text: "powers" },
    { from: "chl", to: "light", text: "catches" },
    { from: "p", to: "o2", text: "gives off" },
  ],
};

describe("the mindmap block", () => {
  it("reads each idea with its cites and each link, the central idea first", () => {
    const read = readAnswer({ blocks: [{ kind: "paragraph", text: "Light drives it all." }, MAP] }, passages, [], { strict: true });
    expect(read.problems).toEqual([]);
    expect(read.badQuotes).toEqual([]);
    const block = read.reply.pieces[1] as unknown as Record<string, unknown>;
    expect(block).toMatchObject({
      kind: "mindmap",
      nodes: [
        { id: "p", text: "Photosynthesis", detail: "Plants make glucose from carbon dioxide and water.", cites: [0] },
        { id: "light", text: "Sunlight", cites: [1] },
        // Two quotes from one sentence are one spot, so one cite.
        { id: "chl", text: "Chlorophyll", detail: "It catches the light.", cites: [1] },
        { id: "o2", text: "Oxygen", cites: [2] },
      ],
      links: MAP.links,
      cites: [],
    });
    const text =
      "Mind map: Photosynthesis. Plants make glucose from carbon dioxide and water.\n\nIdeas:\n- Sunlight\n- Chlorophyll: It catches the light.\n- Oxygen\n\nHow they connect:\n- Sunlight powers Photosynthesis\n- Chlorophyll catches Sunlight\n- Photosynthesis gives off Oxygen";
    expect(block.text).toBe(text);
    // A client or a prompt that does not know the kind reads it in plain words.
    expect(pieceKinds.asText(block as never)).toBe(text);
  });

  it("marks an idea whose cite fails, and keeps one link per pair", () => {
    const read = readAnswer(
      {
        blocks: [
          {
            kind: "mind-map",
            nodes: [
              { id: "p", text: "Photosynthesis" },
              { id: "o2", text: "Oxygen", cites: [{ passage: "S1#2", quote: "oxygen is eaten" }] },
            ],
            links: [
              { from: "p", to: "o2", text: "gives off" },
              { from: "p", to: "o2", text: "makes" },
            ],
          },
        ],
      },
      passages,
      [],
      { strict: true },
    );
    expect(read.badQuotes).toEqual([{ passage: "S1#2", quote: "oxygen is eaten" }]);
    const block = read.reply.pieces[0] as unknown as { nodes: unknown[]; links: unknown[] };
    expect(block.nodes[1]).toEqual({ id: "o2", text: "Oxygen", cites: [], unchecked: true });
    expect(block.links).toEqual([{ from: "p", to: "o2", text: "gives off" }]);
  });

  it("sends back a map that is not one: too few ideas, a repeated id, a link to nowhere, an idea linked to nothing, too many ideas", () => {
    const problems = (block: Record<string, unknown>) => readAnswer({ blocks: [{ kind: "mindmap", ...block }] }, passages, [], { strict: true }).problems;
    expect(problems({ nodes: [{ id: "p", text: "Photosynthesis" }] })).toEqual([
      "Block 1 (mindmap): it needs `nodes`: the central idea and at least one more, each with an `id` and `text`.",
    ]);
    expect(problems({ nodes: [{ id: "p", text: "A" }, { id: "p", text: "B" }, { text: "C" }] })).toEqual(['Block 1 (mindmap): node id "p" is used twice; node 3 needs an `id` and `text`.']);
    expect(problems({ nodes: [{ id: "p", text: "A" }, { id: "q", text: "B" }], links: [{ from: "p", to: "z", text: "leads to" }] })).toEqual([
      'Block 1 (mindmap): link 1 names a node there is not ("z").',
    ]);
    expect(problems({ nodes: [{ id: "p", text: "A" }, { id: "q", text: "B" }, { id: "r", text: "C" }, { id: "s", text: "D" }], links: [{ from: "q", to: "p", text: "feeds" }, { from: "r", to: "s", text: "feeds" }] })).toEqual([
      'Block 1 (mindmap): every node must link, through others if need be, to the central "A"; not linked: "r", "s".',
    ]);
    const many = Array.from({ length: MAX_MAP_NODES + 1 }, (_, n) => ({ id: `n${n}`, text: `Idea ${n}` }));
    expect(problems({ nodes: many, links: many.slice(1).map((node) => ({ from: "n0", to: node.id, text: "has" })) })).toEqual([
      `Block 1 (mindmap): a map holds at most ${MAX_MAP_NODES} nodes; ${MAX_MAP_NODES + 1} were sent. Keep the main ideas.`,
    ]);
  });

  it("is described to every writer, and the reply tool takes its nodes and links", () => {
    expect(blockGuide()).toContain('- "mind-map": A map of the main ideas');
    const reply = createDefaultTools().get("reply")!;
    const block = (reply.inputSchema as { properties: { blocks: { items: { properties: Record<string, { enum?: string[]; items?: { required?: string[] } }> } } } }).properties.blocks.items.properties;
    expect(block.kind.enum).toEqual(expect.arrayContaining(["mindmap", "mind-map"]));
    expect(block.nodes.items!.required).toEqual(["id", "text"]);
    expect(block.links.items!.required).toEqual(["from", "to", "text"]);
  });
});

const PHOTOSYNTHESIS = "Plants make glucose from carbon dioxide and water. The energy comes from sunlight, caught by chlorophyll.";

async function setup(answer: ProviderAnswer, skills = new SkillRegistry().register(createMindMapSkill())) {
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

function mapFrom(request: StructuredGenerationRequest) {
  const label = labelOf(request, PHOTOSYNTHESIS);
  return {
    blocks: [
      { kind: "paragraph", text: "Sunlight powers it all." },
      {
        kind: "mindmap",
        nodes: [
          { id: "p", text: "Photosynthesis", cites: [{ passage: label, quote: "Plants make glucose" }] },
          { id: "light", text: "Sunlight", cites: [{ passage: label, quote: "The energy comes from sunlight" }] },
        ],
        links: [{ from: "light", to: "p", text: "powers" }],
      },
    ],
    covered: true,
  };
}

describe("the mind map skill", () => {
  it("is a command with its own button words, offered only in the chat", async () => {
    const t = await setup(() => ({}));
    const listed = (await t.call("/v1/skills")).body;
    expect(listed.commands).toEqual([
      {
        command: "mindmap",
        title: "Map the ideas",
        group: "chat",
        label: "mind map",
        action: "Map the ideas",
        chatOnly: true,
        about: "Lays out the main ideas in your sources and how they connect, as a map you can tap: each idea opens the spot in your sources that says it.",
        skill: "mindMap",
      },
    ]);
    const words = createDefaultSkills().commands().map((command) => command.word);
    expect(words).toEqual(expect.arrayContaining(["plan", "teachback", "mindmap"]));
  });

  it("alone, maps the whole of the sources, and answers with a cited mindmap block", async () => {
    const t = await setup((request) => (request.systemPrompt === ANSWER_SYSTEM_PROMPT ? mapFrom(request) : {}));
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/mindmap" })).body.messages[1];
    expect(reply.skill).toBe("mindMap");
    expect(reply.pieces[1]).toMatchObject({ kind: "mindmap", nodes: [{ id: "p", cites: [0] }, { id: "light", cites: [1] }], links: [{ from: "light", to: "p", text: "powers" }] });
    expect(reply.cites).toHaveLength(2);
    const prompt = t.engine.provider.calls.find((request) => request.systemPrompt === ANSWER_SYSTEM_PROMPT)!.userPrompt;
    expect(prompt).toContain("the main ideas across the sources");
    expect(prompt).toContain(MIND_MAP_GUIDE);
  });

  it("with a topic, finds the passages from the topic and says to map it", async () => {
    const t = await setup((request) => (request.systemPrompt === ANSWER_SYSTEM_PROMPT ? mapFrom(request) : {}));
    await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "/mindmap where the energy comes from" });
    const prompt = t.engine.provider.calls.find((request) => request.systemPrompt === ANSWER_SYSTEM_PROMPT)!.userPrompt;
    expect(prompt).toContain("a mind map of what the message names");
    expect(prompt.split("Message:\n").at(-1)).toBe("where the energy comes from");
  });

  it("is chosen by the router when the person asks plainly", async () => {
    const t = await setup((request) => (request.systemPrompt === ROUTER_SYSTEM_PROMPT ? { use: "mindMap" } : request.systemPrompt === ANSWER_SYSTEM_PROMPT ? mapFrom(request) : {}));
    const reply = (await t.call(`/v1/chats/${t.chat.id}/messages`, "POST", { text: "How does it all fit together?" })).body.messages[1];
    expect(reply.skill).toBe("mindMap");
    const router = t.engine.provider.calls.find((request) => request.systemPrompt === ROUTER_SYSTEM_PROMPT)!.userPrompt;
    expect(router).toContain("- mindMap: Lays out the main ideas");
  });
});

describe("the person's agent", () => {
  it("is told how to draw a mind map, and that the command exists", () => {
    const system = agentSystemPrompt(createDefaultRegistry(), createDefaultConditions(), createDefaultSkills().list());
    expect(system).toContain("- A mind map: the person asks to see the main ideas laid out");
    expect(system).toContain(MIND_MAP_GUIDE);
    expect(system).toContain("- /mindmap: Lays out the main ideas");
  });
});
