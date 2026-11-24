/**
 * The tools Open Sourcebook gives the person's agent (engine/docs/api.md, "Your agent").
 * Where a tool does what a skill or the plain answer already does, it calls
 * the same code: passages are ranked by the chat's retrieval, a plan is
 * read, priced, checked and written by planning/commit.ts, cites are
 * checked by the answer's own reader. Nothing here names a format, a
 * subject or a plan shape.
 */
import { isRecord } from "../../net";
import { progressView } from "../../routes/plans";
import { approve } from "../../routes/plan-edits";
import { renderPassages, type Passage } from "../../sources/passages";
import { createDefaultConditions } from "../../studio/conditions";
import { PlanNotRunnableError } from "../../studio/plan-runner";
import { PickNeededError } from "../providers";
import type { Plan } from "../../studio/repositories";
import type { Cite } from "../../cards/contract";
import { readAnswer } from "../answer";
import { blockKinds, VERDICTS } from "../blocks";
import { pieceKinds, question, say, type OtherPiece } from "../pieces";
import { blockGuide } from "../writing";
import { commitAppend, commitEdit, commitNewPlan, draftServicesFor, picksByScope } from "../planning/commit";
import type { Settled } from "../planning/draft";
import { planSize } from "../planning/size";
import { isOpen, planState } from "../planning/state";
import { readSkillFile, skillFiles, skillIndex } from "./work-skills";
import { makeOne, proposeOne, readOne, remakeDraft, thingNotices, thingOf, thingState, thingWords, type MakeOutcome } from "../making/direct";
import { projectPacks } from "../planning/guide";
import { readPlan, renderPlan } from "../planning/edit";
import { handItemsIn } from "../planning/skill";
import { where, type MappedSource } from "../planning/sources";
import { rankPassages } from "../retrieval";
import { AgentToolRegistry, type AgentTool, type JsonSchema, type StepNote, type ToolOutcome, type ToolTurn, type TurnSources } from "./tools";

/** Most passages one search returns. */
const SEARCH_MAX = 12;
const SEARCH_DEFAULT = 6;
/** Most characters one read returns. */
const READ_MAX_CHARS = 16_000;
const OUTLINE_BUDGET_CHARS = 24_000;
/** Times the reply may come back with cites that fail the check before it is kept with them dropped. */
const REPLY_REPAIRS = 2;
/** Tools whose turn is about a plan or a question back, not an answer from the sources. */
const PLANNING_TOOLS = new Set(["make_plan", "change_plan", "start_plan", "make_item", "remake_item", "stop_making", "ask"]);
/** Items past which a plan is shown to the agent without its briefs. */
const BIG_PLAN_ITEMS = 40;
/** About how many items one make_plan call carries well; a bigger plan is written in parts. */
const PART_ITEMS = 25;
/** Items named one by one when Open Sourcebook says what it set on them. */
const SETTLED_SHOWN = 12;

export function createDefaultTools(): AgentToolRegistry {
  return new AgentToolRegistry()
    .register(listSources)
    .register(outlineSources)
    .register(searchPassages)
    .register(readPassages)
    .register(tickSource)
    .register(readPlanTool)
    .register(makePlan)
    .register(changePlan)
    .register(startPlan)
    .register(planProgress)
    .register(makeItem)
    .register(remakeItem)
    .register(stopMaking)
    .register(readSkill)
    .register(ask)
    .register(reply);
}

// ── Sources ─────────────────────────────────────────────────────────────────

const listSources: AgentTool = {
  name: "list_sources",
  description:
    "Lists the project's sources: each one's label (S1, S2, ...), title, kind, how many passages it has, and whether it is ticked for this chat. Only ticked sources may be read, searched, cited or planned from.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  label: () => "Looking at your sources",
  async run(_input, turn) {
    const sources = await turn.sources();
    const lines = sources.map.entries.map((entry) => `${entry.label} "${title(entry)}" (${entry.source.kind}, ${entry.chunks.length} passages)${sources.inScope(entry) ? ", ticked" : ", not ticked"}`);
    if (sources.unread.length > 0) lines.push(`Still being read, not readable yet: ${sources.unread.map((source) => `"${source.title}"`).join(", ")}.`);
    return { text: lines.length ? lines.join("\n") : "The project has no sources yet." };
  },
  said: () => "Looked at your sources",
};

const outlineSources: AgentTool = {
  name: "outline_sources",
  description:
    "An outline of ticked sources, passage by passage (#1, #2, ...) with the start of each, so you can see what they cover and cut them into items for a plan. Leave out `sources` for every ticked source.",
  inputSchema: {
    type: "object",
    properties: { sources: { type: "array", items: { type: "string" }, description: "Source labels such as S1." } },
    additionalProperties: false,
  },
  async label(input, turn) {
    const picked = pickEntries(await turn.sources(), input.sources);
    return "entries" in picked && picked.entries.length === 1 ? `Looking through ${title(picked.entries[0])}` : "Looking through your sources";
  },
  async run(input, turn) {
    const sources = await turn.sources();
    const picked = pickEntries(sources, input.sources);
    if ("problem" in picked) return refuse(picked.problem);
    const labels = new Set(picked.entries.map((entry) => entry.label));
    const titles = picked.entries.map(title);
    return {
      text: sources.map.render(OUTLINE_BUDGET_CHARS, (entry) => labels.has(entry.label)) || "No ticked source has any passages.",
      note: { group: "outline", titles: titles.length === 1 ? titles : [] },
    };
  },
  said(steps) {
    const titles = [...new Set(steps.flatMap((step) => (Array.isArray(step.note.titles) ? step.note.titles.map(String) : [])))];
    const all = steps.some((step) => Array.isArray(step.note.titles) && step.note.titles.length === 0);
    return `Looked through ${all || titles.length === 0 ? "your sources" : joinWords(titles)}`;
  },
};

const searchPassages: AgentTool = {
  name: "search_passages",
  description:
    "Searches the ticked sources for passages about something, best matches first. Each passage comes with its label (S1#4: source S1, passage 4) and its full words, which is what you cite and quote. Search with the words the sources would use. Leave out `sources` to search every ticked source.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for." },
      sources: { type: "array", items: { type: "string" }, description: "Source labels such as S1, to search only those." },
      limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX, description: `How many passages, ${SEARCH_DEFAULT} if left out.` },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async label(input, turn) {
    const picked = pickEntries(await turn.sources(), input.sources);
    if ("entries" in picked && picked.entries.length === 1) return `Searching ${title(picked.entries[0])}`;
    return typeof input.query === "string" && input.query.trim() ? `Searching your sources for “${clip(input.query.trim(), 60)}”` : "Searching your sources";
  },
  async run(input, turn) {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query) return refuse("`query` must say what to look for.");
    const sources = await turn.sources();
    const picked = pickEntries(sources, input.sources);
    if ("problem" in picked) return refuse(picked.problem);
    const labels = new Set(picked.entries.map((entry) => entry.label));
    const pool = sources.passages().filter((passage) => labels.has(passage.label.split("#")[0]));
    const limit = typeof input.limit === "number" && Number.isInteger(input.limit) ? Math.min(SEARCH_MAX, Math.max(1, input.limit)) : SEARCH_DEFAULT;
    const found = rankPassages(pool, query)
      .filter((entry) => entry.score > 0)
      .slice(0, limit)
      .map((entry) => entry.passage);
    const scope = picked.entries.length === 1 ? title(picked.entries[0]) : "";
    const note = { group: `search:${scope}`, scope, query: clip(query, 60), found: found.length };
    if (found.length === 0) return { text: `No passage of ${scope || "the ticked sources"} matches "${query}". Try other words, or read the outline.`, note };
    return { text: showPassages(found), note };
  },
  said(steps) {
    const queries = [...new Set(steps.map((step) => String(step.note.query ?? "")).filter(Boolean))];
    if (queries.length === 0) return steps[0]?.label ?? "Searched your sources";
    const scope = String(steps[0]?.note.scope ?? "") || "your sources";
    const quoted = queries.map((query) => `“${query}”`);
    const named = quoted.length > 3 ? `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more` : joinWords(quoted);
    const found = steps.reduce((sum, step) => sum + (typeof step.note.found === "number" ? step.note.found : 0), 0);
    return `Searched ${scope} for ${named}${found === 0 ? ": nothing matched" : ""}`;
  },
};

const readPassages: AgentTool = {
  name: "read_passages",
  description: `Reads passages of one ticked source word for word, from passage \`from\` to passage \`to\` (numbers from the outline or a search). Up to about ${READ_MAX_CHARS} characters at a time.`,
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "A source label such as S1." },
      from: { type: "integer", minimum: 1 },
      to: { type: "integer", minimum: 1 },
    },
    required: ["source"],
    additionalProperties: false,
  },
  async label(input, turn) {
    const entry = typeof input.source === "string" ? (await turn.sources()).map.get(input.source) : undefined;
    return entry ? `Reading ${title(entry)}` : "Reading a source";
  },
  async run(input, turn) {
    const sources = await turn.sources();
    const entry = typeof input.source === "string" ? sources.map.get(input.source) : undefined;
    if (!entry) return refuse(`"${String(input.source)}" is not a source label. list_sources gives them.`);
    if (!sources.inScope(entry)) return refuse(`${entry.label} is not ticked for this chat. Tick it with tick_source first if the person wants it read.`);
    const count = entry.chunks.length;
    const from = typeof input.from === "number" ? input.from : 1;
    const to = typeof input.to === "number" ? input.to : count;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || from > count) return refuse(`${entry.label} has passages 1 to ${count}; from must be ≤ to.`);
    const end = Math.min(to, count);
    const wanted = sources.passages().filter((passage) => {
      const [label, number] = passage.label.split("#");
      return label === entry.label && Number(number) >= from && Number(number) <= end;
    });
    const shown: Passage[] = [];
    let used = 0;
    for (const passage of wanted) {
      if (shown.length > 0 && used + passage.text.length > READ_MAX_CHARS) break;
      shown.push(passage);
      used += passage.text.length;
    }
    const last = Number(shown.at(-1)?.label.split("#")[1] ?? end);
    const more = last < end ? `\n\n(Stopped at #${last}; read on from #${last + 1}.)` : "";
    return { text: shown.length ? `${showPassages(shown)}${more}` : `${entry.label} has no text in passages ${from}–${end}.`, note: { group: `read:${entry.label}`, title: title(entry), passages: shown.map((passage) => Number(passage.label.split("#")[1])) } };
  },
  said(steps) {
    // A passage read twice counts once.
    const read = new Set(steps.flatMap((step) => (Array.isArray(step.note.passages) ? step.note.passages : []))).size;
    const name = String(steps[0]?.note.title ?? "a source");
    return read > 0 ? `Read ${read} passage${read === 1 ? "" : "s"} of ${name}` : `Read ${name}`;
  },
};

const tickSource: AgentTool = {
  name: "tick_source",
  description: "Ticks a source of the project for this chat, so it can be read, cited and planned from. Use it only when the person asks for that source, or agrees to it.",
  inputSchema: { type: "object", properties: { source: { type: "string", description: "A source label such as S2." } }, required: ["source"], additionalProperties: false },
  async label(input, turn) {
    const entry = typeof input.source === "string" ? (await turn.sources()).map.get(input.source) : undefined;
    return entry ? `Ticking ${title(entry)}` : "Ticking a source";
  },
  async run(input, turn) {
    const sources = await turn.sources();
    const entry = typeof input.source === "string" ? sources.map.get(input.source) : undefined;
    if (!entry) return refuse(`"${String(input.source)}" is not a source label. list_sources gives them.`);
    if (sources.inScope(entry)) return { text: `${entry.label} is already ticked.` };
    const ticked = [...sources.ticked, entry.source.sourceId];
    await turn.deps.repos.sessions.update(turn.chat.id, { settings: { ...turn.chat.settings, sources: ticked } });
    return { text: `${entry.label} "${title(entry)}" is ticked for this chat now.` };
  },
};

// ── Plans ───────────────────────────────────────────────────────────────────

const planInput = { plan: { type: "string", description: "A plan id from read_plan; the newest plan of this chat if left out." } } satisfies JsonSchema;

const readPlanTool: AgentTool = {
  name: "read_plan",
  description:
    "Shows a plan of this chat: whether it has started, its size, and its items as I1, I2, ... with their format, title, brief, settings and sources, by stage. Read a plan before changing it. With no plan id it shows the newest one and lists the others. A big plan comes without its briefs; `stage` shows one stage in full.",
  inputSchema: { type: "object", properties: { ...planInput, stage: { type: "integer", minimum: 1, description: "Only this stage, by its number, with its briefs." } }, additionalProperties: false },
  label: () => "Reading the plan",
  async run(input, turn) {
    const target = await planOf(turn, input.plan);
    if ("problem" in target) return refuse(target.problem);
    const { plan } = target;
    const sources = await turn.sources();
    const shown = await readPlan(turn.deps.repos, plan);
    const others = (await turn.deps.repos.plans.listBySession(turn.chat.id)).filter((other) => other.id !== plan.id);
    const stage = typeof input.stage === "number" && Number.isInteger(input.stage) ? input.stage : undefined;
    if (stage !== undefined && !shown.stageRefs.has(stage)) return refuse(`The plan has stages 1 to ${shown.stageRefs.size}.`);
    // A big plan is shown without its briefs, a stage at a time in full.
    const big = stage === undefined && shown.draft.items.length > BIG_PLAN_ITEMS;
    const lines = [
      `Plan id ${plan.id}: ${planState(plan)}.`,
      `Size: ${planSize(shown.draft, turn.deps.registry)}.`,
      renderPlan(shown, sources.map, undefined, { ...(stage !== undefined ? { stages: new Set([stage]) } : {}), ...(big ? { briefs: false } : {}) }),
    ];
    if (big) lines.push(`Briefs are left out for a plan this big; read_plan with \`stage\` shows one stage in full.`);
    if (others.length) lines.push(`Other plans in this chat: ${others.map((other) => `"${other.title ?? "Untitled plan"}" (${other.id}, ${isOpen(other) ? "not started" : other.kickedOffAt ? "started" : "discarded"})`).join(", ")}.`);
    return { text: lines.join("\n") };
  },
};

const makePlan: AgentTool = {
  name: "make_plan",
  description: [
    "Makes a new plan in this chat from ticked sources and shows it to the person as a plan card. It is not started: nothing is made until they press Start.",
    "Input: the plan's `title`, optional `budgetUsd` (only when the person named a spending limit) and its `stages` in order. Each stage has an optional `label`, an optional `dueOn` (a day, YYYY-MM-DD, only when the person gave one) and its `items`. Each item has a `key` you choose, a `format` id from the formats Open Sourcebook can make now, a `title`, a `brief`, `settings` from that format's settings (set every one you can), and its `sources`: [{source: \"S1\"}] for a whole source or with `from`/`to` passage numbers for a run of it.",
    "Optional per item: `branchOf` {item: <key of an item in an earlier stage>, condition: <a branch condition>}, `assumes` [keys of earlier items it builds on], `inputs` [{item: <key>, kind: <a kind of link from your instructions>}], `enabled`.",
    `A plan too big for one call (more than about ${PART_ITEMS} items) is written in parts: the first call makes it; each next call sets \`plan\` to its id and gives the next \`stages\`, which go after the plan's last stage. Their items may link to the plan's items by I1, I2, ... as this tool shows them. Write every part in the same turn.`,
    "If the plan has problems nothing is saved and you get every problem back: fix them all and call again.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "Only to add the next part of a plan you are writing in parts: its id. The stages go after its last stage." },
      title: { type: "string" },
      budgetUsd: { type: "number", minimum: 0 },
      stages: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            dueOn: { type: "string", description: "The day the person means to go through this stage by, YYYY-MM-DD, worked out from what they said and today's date. Only when they gave a day or a deadline." },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  format: { type: "string" },
                  title: { type: "string" },
                  brief: { type: "string" },
                  settings: { type: "object" },
                  sources: {
                    type: "array",
                    items: { type: "object", properties: { source: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["source"] },
                  },
                  branchOf: { type: "object", properties: { item: { type: "string" }, condition: { type: "object" } }, required: ["item", "condition"] },
                  assumes: { type: "array", items: { type: "string" } },
                  inputs: { type: "array", items: { type: "object", properties: { item: { type: "string" }, kind: { type: "string" } }, required: ["item", "kind"] } },
                  enabled: { type: "boolean" },
                },
                required: ["key", "format", "title", "brief", "sources"],
              },
            },
          },
          required: ["items"],
        },
      },
    },
    required: ["stages"],
  },
  label: (input) => (typeof input.plan === "string" && input.plan.trim() ? "Writing more of the plan" : "Making a plan"),
  async run(input, turn) {
    const sources = await turn.sources();
    const unticked = untickedLabels(input, sources);
    if (unticked.length) return refuse(`${unticked.join(", ")} ${unticked.length === 1 ? "is" : "are"} not ticked for this chat: plan only from ticked sources, or tick one first if the person wants it.`);
    if (typeof input.plan === "string" && input.plan.trim()) return appendPart(input, turn, sources);
    if (typeof input.title !== "string" || !input.title.trim()) return refuse("A new plan needs a `title`.");
    const committed = await commitNewPlan(input, sources.map, await draftServices(turn, sources), {
      repos: turn.deps.repos,
      registry: turn.deps.registry,
      owner: { ownerId: turn.turn.ownerId, projectId: turn.project.id, sessionId: turn.chat.id },
    });
    if ("issues" in committed) return refuse(`Nothing was saved. Fix all of these and call make_plan again:\n${committed.issues.map((issue) => `- ${issue}`).join("\n")}`);
    const shown = await readPlan(turn.deps.repos, committed.plan);
    // A plan in one format, where more could be made, needs its reason said.
    const formats = new Set(shown.draft.items.map((item) => item.type));
    const one = formats.size === 1 && shown.draft.items.length > 1 && turn.deps.registry.ready().length > 1;
    const label = one ? (turn.deps.registry.descriptor([...formats][0]!)?.singular ?? turn.deps.registry.descriptor([...formats][0]!)?.label ?? [...formats][0]) : "";
    return {
      text: [
        `Saved plan id ${committed.plan.id}, ${planState(committed.plan)}. The person sees it as a card under your reply.`,
        `Size: ${planSize(shown.draft, turn.deps.registry)}.`,
        one ? `Every item is a ${label}: your reply must say why in a sentence (what the person said, or what the content needs).` : "",
        settledNote(committed.settled),
        renderPlan(shown, sources.map, undefined, { briefs: false }),
      ]
        .filter(Boolean)
        .join("\n"),
      result: { pieces: [{ kind: "plan", planId: committed.plan.id, action: "created" }] },
    };
  },
};

/** make_plan with `plan`: the next part of a plan written in parts, after its last stage. */
async function appendPart(input: Record<string, unknown>, turn: ToolTurn, sources: TurnSources): Promise<ToolOutcome> {
  const target = await planOf(turn, input.plan);
  if ("problem" in target) return refuse(target.problem);
  const { plan } = target;
  if (!isOpen(plan)) return refuse(`"${plan.title ?? "That plan"}" is ${planState(plan)}, so nothing can be added to it. Make a new plan if the person wants one.`);
  const before = await readPlan(turn.deps.repos, plan);
  const outcome = await commitAppend(input, plan, sources.map, await draftServices(turn, sources), { repos: turn.deps.repos, registry: turn.deps.registry });
  if ("closed" in outcome) return refuse(outcome.closed);
  if ("issues" in outcome) return refuse(`Nothing of this part was saved. Fix all of these and call make_plan again with the same \`plan\`:\n${outcome.issues.map((issue) => `- ${issue}`).join("\n")}`);
  const fresh = (await turn.deps.repos.plans.get(plan.id)) ?? plan;
  const now = await readPlan(turn.deps.repos, fresh);
  const had = new Set(before.draft.items.map((item) => item.key));
  const added = new Set(now.draft.items.filter((item) => !had.has(item.key)).map((item) => item.key));
  // The card this turn already showed grows by itself; a part written in a later turn says what it added.
  const shownThisTurn = turn.steps.some((step) => isRecord(step.result) && Array.isArray(step.result.pieces) && step.result.pieces.some((piece) => isRecord(piece) && piece.kind === "plan" && piece.planId === plan.id));
  const change = `Added ${outcome.added} item${outcome.added === 1 ? "" : "s"} in ${outcome.stages} stage${outcome.stages === 1 ? "" : "s"}`;
  return {
    text: [
      `Added to plan id ${plan.id}, ${planState(fresh)}.`,
      `Size now: ${planSize(now.draft, turn.deps.registry)}.`,
      settledNote(outcome.settled),
      `This part:\n${renderPlan(now, sources.map, undefined, { briefs: false, items: added })}`,
    ]
      .filter(Boolean)
      .join("\n"),
    ...(shownThisTurn ? {} : { result: { pieces: [{ kind: "plan", planId: plan.id, action: "edited", changes: [change] } as OtherPiece] } }),
  };
}

/** What Open Sourcebook set on items whose settings the planner left open, so it can change them. */
function settledNote(settled: Settled[]): string {
  if (settled.length === 0) return "";
  const shown = settled.slice(0, SETTLED_SHOWN).map((entry) => `"${entry.title}": ${Object.entries(entry.values).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(", ")}`);
  const more = settled.length > SETTLED_SHOWN ? `; and ${settled.length - SETTLED_SHOWN} more items` : "";
  return `Settings you left open were set as each maker would set them now: ${shown.join("; ")}${more}. If one does not suit the item, change it with change_plan.`;
}

const changePlan: AgentTool = {
  name: "change_plan",
  description: [
    "Changes a plan of this chat that has not started. Read it with read_plan first; refer to items as I1, I2, ... and to stages by number, as read_plan shows them. Change only what was asked.",
    "`ops`, applied in order:",
    '{"op": "change", "item": "I2", "title"?, "brief"?, "format"?, "settings"?, "sources"?: [{"source": "S1", "from"?, "to"?}], "enabled"?, "branchOf"?: {"item": "I1", "condition": {}} | null}',
    '{"op": "add", "key": "<new key>", "stage": <stage number or a new stage key>, "position"?: <0-based>, "format", "title", "brief", "settings"?, "sources", "branchOf"?, "assumes"?, "inputs"?}',
    '{"op": "remove", "item": "I3"}',
    '{"op": "move", "item": "I3", "stage": <stage number or new stage key>, "position"?}',
    '{"op": "addStage", "key": "<new stage key>", "after": <stage number, or null for first>, "label"?, "dueOn"?}',
    '{"op": "label", "stage": <stage>, "label": "..." | null}',
    '{"op": "date", "stage": <stage>, "dueOn": "YYYY-MM-DD" | null}',
    '{"op": "link" | "unlink", "from": "I1", "to": "I4", "kind": "<a kind of link from your instructions>"}',
    '{"op": "title", "title": "..."}',
    '{"op": "budget", "usd": <dollars> | null}',
    "An item the person changed by hand stays as they have it unless their message names it. If the ops have problems nothing is saved and you get every problem back.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: { ...planInput, ops: { type: "array", minItems: 1, items: { type: "object" } } },
    required: ["ops"],
  },
  label: () => "Changing the plan",
  async run(input, turn) {
    const target = await planOf(turn, input.plan);
    if ("problem" in target) return refuse(target.problem);
    const { plan } = target;
    if (!isOpen(plan)) return refuse(`"${plan.title ?? "That plan"}" is ${planState(plan)}. Say so once, and make a new plan with what was asked if that is what the person wants.`);
    const sources = await turn.sources();
    const unticked = untickedLabels({ stages: [{ items: Array.isArray(input.ops) ? input.ops : [] }] }, sources);
    if (unticked.length) return refuse(`${unticked.join(", ")} ${unticked.length === 1 ? "is" : "are"} not ticked for this chat.`);
    const shown = await readPlan(turn.deps.repos, plan);
    const mentioned = turn.request.mentions.filter((mention) => mention.kind === "item").map((mention) => mention.id);
    // An agent's reply is stored when its turn starts and written when it ends: the end is when it wrote the plan.
    const hand = await handItemsIn(turn.deps.repos, turn.chat.id, plan, shown, mentioned, turn.request.text, {
      wroteAt: async (message) => (await turn.deps.repos.agentTurns.byMessage(message.id))?.finishedAt ?? message.createdAt,
      until: turn.turn.startedAt,
    });
    const outcome = await commitEdit({ ops: input.ops }, plan, shown, sources.map, await draftServices(turn, sources), { repos: turn.deps.repos, registry: turn.deps.registry }, hand);
    if ("closed" in outcome) return refuse(outcome.closed);
    if ("issues" in outcome) return refuse(`Nothing was saved. Fix all of these and call change_plan again:\n${outcome.issues.map((issue) => `- ${issue}`).join("\n")}`);
    const changes = [...outcome.changes, ...outcome.kept];
    if (changes.length === 0) return { text: "Nothing changed." };
    const now = await readPlan(turn.deps.repos, (await turn.deps.repos.plans.get(plan.id))!);
    return {
      text: [
        `Done, and the plan is ${planState(now.plan)}:`,
        changes.map((change) => `- ${change}`).join("\n"),
        `Size now: ${planSize(now.draft, turn.deps.registry)}.`,
        settledNote(outcome.settled),
        `The plan now:\n${renderPlan(now, sources.map, undefined, now.draft.items.length > BIG_PLAN_ITEMS ? { briefs: false } : {})}`,
      ]
        .filter(Boolean)
        .join("\n"),
      result: { pieces: [{ kind: "plan", planId: plan.id, action: "edited", changes }] },
    };
  },
};

const startPlan: AgentTool = {
  name: "start_plan",
  description:
    "Starts a plan: Open Sourcebook begins making its items, which takes time and may cost money. Use it only when the person clearly asks to start or make the plan now; otherwise they press Start on the plan card themselves.",
  inputSchema: { type: "object", properties: planInput, additionalProperties: false },
  async label(input, turn) {
    const target = await planOf(turn, input.plan);
    return "plan" in target ? `Starting “${clip(target.plan.title ?? "the plan", 60)}”` : "Starting the plan";
  },
  async run(input, turn) {
    const target = await planOf(turn, input.plan);
    if ("problem" in target) return refuse(target.problem);
    if (!turn.deps.plans) return refuse("Plans cannot be started here.");
    const approved = await approve(turn.deps, target.plan);
    if ("refused" in approved) return refuse(`${approved.message}.`);
    if ("issues" in approved) return refuse(`The plan can't start yet:\n${approved.issues.map((issue) => `- ${issue.message}`).join("\n")}\nTell the person, or fix it with change_plan if they asked you to.`);
    try {
      await turn.deps.plans.kickOff(target.plan.id);
    } catch (error) {
      if (error instanceof PlanNotRunnableError) return refuse(`The plan can't start:\n${error.issues.map((issue) => `- ${issue}`).join("\n")}`);
      if (error instanceof PickNeededError) return refuse(`The plan can't start: more than one of the person's providers could make its items and none is picked. ${error.message} Tell the person that in one line; don't pick for them.`);
      throw error;
    }
    return { text: `Started: it is no longer a draft. Open Sourcebook is making its items stage by stage, and they can't change now; plan_progress shows how far it is.`, result: { pieces: [{ kind: "plan", planId: target.plan.id, action: "edited", changes: ["Started"] }] } };
  },
};

const planProgress: AgentTool = {
  name: "plan_progress",
  description: "How far a started plan is: each item's status (waiting, being made, ready, failed, skipped) and whether the person has done it.",
  inputSchema: { type: "object", properties: planInput, additionalProperties: false },
  label: () => "Checking the plan's progress",
  async run(input, turn) {
    const target = await planOf(turn, input.plan);
    if ("problem" in target) return refuse(target.problem);
    const view = (await progressView(turn.deps, target.plan)) as {
      plan: { status: string };
      items: Array<{ title: string; type: string; status: string; done: boolean; enabled: boolean }>;
      counts: { total: number; done: number };
    };
    const lines = [`"${target.plan.title ?? "Untitled plan"}" is ${planState(target.plan)}; ${view.counts.done} of ${view.counts.total} items done by the person.`];
    for (const item of view.items) lines.push(`- "${item.title}" (${item.type}): ${item.enabled ? item.status : "left out"}${item.done ? ", done" : ""}`);
    return { text: lines.join("\n") };
  },
};

// ── One thing at once ───────────────────────────────────────────────────────

const ITEM_SCHEMA = {
  format: { type: "string", description: "A format id from the formats Open Sourcebook can make now." },
  title: { type: "string" },
  brief: { type: "string", description: "Written as a plan item's brief: what it does for the person, what it covers from where, the approach, what they asked for." },
  settings: { type: "object", description: "That format's settings; set every one you can." },
  sources: {
    type: "array",
    items: { type: "object", properties: { source: { type: "string" }, from: { type: "integer" }, to: { type: "integer" } }, required: ["source"] },
  },
} satisfies JsonSchema;

const makeItem: AgentTool = {
  name: "make_item",
  description: [
    "Opens the make sheet for ONE thing, filled in: the person looks it over, may change it, and presses its button to make it. Nothing is made until they do. Use it when the person asks for one thing (a /<format> command, \"make me a quiz on chapter 3\", \"a short video about X\"), not a path through the material: that is make_plan.",
    "Settle it as you would one plan item: format, a title, a brief another agent makes it from, settings with real values (maker, look, length), and its sources. With no length asked, it is short, as your planner's guide says under \"One thing, or a plan\"; longer only when the person asks for it in words.",
    "End with reply: one line saying what the sheet holds, such as \"Here is a 90-second chalkboard video on how the heart pumps, from Lecture 4: press Make when it looks right.\"",
    "If the item has problems nothing is opened and you get them back to fix. If nothing can make it on this computer now, the sheet says why; tell the person plainly what is missing; don't make a plan instead.",
  ].join("\n"),
  inputSchema: { type: "object", properties: ITEM_SCHEMA, required: ["format", "title", "brief", "sources"] },
  label: (input) => (typeof input.title === "string" && input.title.trim() ? `Filling in “${clip(input.title.trim(), 60)}”` : "Filling in the sheet"),
  async run(input, turn) {
    const sources = await turn.sources();
    const unticked = untickedLabels({ stages: [{ items: [input] }] }, sources);
    if (unticked.length) return refuse(`${unticked.join(", ")} ${unticked.length === 1 ? "is" : "are"} not ticked for this chat: use only ticked sources, or tick one first if the person wants it.`);
    const read = readOne(input, sources.map);
    if (!read.item || read.issues.length) return refuse(`Nothing was opened. Fix these and call make_item again:\n${read.issues.map((issue) => `- ${issue}`).join("\n")}`);
    const context = await makeContext(turn, sources);
    // In a terminal there is no sheet to press: it is made at once.
    if (turn.request.from === "terminal") return made(await makeOne(read.item, context), turn, "made");
    return proposed(await proposeOne(read.item, context), turn);
  },
};

const remakeItem: AgentTool = {
  name: "remake_item",
  description: [
    "Opens the make sheet for a thing already made, again with a change, filled in: the person presses its button to make it. People ask for this in plain words about what they just made or have open: \"make it shorter\", \"simpler\", \"redo it in ink\", \"more questions\", \"this one but about chapter 5\", \"again\".",
    "`thing`: the thing id from \"Things made at once in this chat\" in your instructions (the one the person names; else the one open in front of them; else the newest), or an item id from read_plan for an item of a plan.",
    "It keeps that thing's format, title, brief, settings and sources; give only what changes: `settings` (only the keys that change), `brief` (the whole new brief, when what it covers or how it is told changes), `title`, `sources`, or `format` when they ask for another shape.",
    "The old one stays as it is; once made, the new one is linked to it. End with reply: one line saying what the sheet would remake and how.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: { thing: { type: "string" }, ...ITEM_SCHEMA },
    required: ["thing"],
  },
  label: () => "Filling in the sheet to make it again",
  async run(input, turn) {
    const ref = typeof input.thing === "string" ? input.thing : "";
    const old = ref ? await thingOf(turn.deps.repos, { ownerId: turn.turn.ownerId, projectId: turn.project.id }, ref) : undefined;
    if (!old) return refuse(`"${ref}" is not a thing made in this project. Use a thing id from your instructions, or an item id from read_plan.`);
    const sources = await turn.sources();
    const unticked = input.sources === undefined ? [] : untickedLabels({ stages: [{ items: [input] }] }, sources);
    if (unticked.length) return refuse(`${unticked.join(", ")} ${unticked.length === 1 ? "is" : "are"} not ticked for this chat.`);
    const { item, issues } = await remakeDraft(turn.deps.repos, old.node, input, sources.map);
    if (issues.length) return refuse(`Nothing was opened. Fix these and call remake_item again:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    const context = await makeContext(turn, sources);
    if (turn.request.from === "terminal") return made(await makeOne(item, { ...context, ...(old.plan.direct ? { remakeOf: old.plan } : {}) }), turn, "remade");
    return proposed(await proposeOne(item, { ...context, remakes: { planId: old.plan.id, itemId: old.node.id } }), turn);
  },
};

const stopMaking: AgentTool = {
  name: "stop_making",
  description: "Stops a thing that is being made at once, when the person asks to stop it. `thing` is its thing id. What was not made is not made; it can be remade later.",
  inputSchema: { type: "object", properties: { thing: { type: "string" } }, required: ["thing"], additionalProperties: false },
  label: () => "Stopping it",
  async run(input, turn) {
    const old = typeof input.thing === "string" ? await thingOf(turn.deps.repos, { ownerId: turn.turn.ownerId, projectId: turn.project.id }, input.thing) : undefined;
    if (!old || !old.plan.direct) return refuse(`"${String(input.thing)}" is not a thing made at once in this project.`);
    if (!turn.deps.plans) return refuse("Nothing can be stopped here.");
    if (old.plan.status !== "running") return { text: `"${old.node.title}" is ${thingState(old.plan, old.node)}; there is nothing to stop.` };
    await turn.deps.plans.cancel(old.plan.id);
    return { text: `Stopped "${old.node.title}".`, result: { pieces: [{ kind: "plan", planId: old.plan.id, action: "edited", made: "made", changes: ["Stopped"] } as OtherPiece] } };
  },
};

async function makeContext(turn: ToolTurn, sources: TurnSources) {
  return {
    repos: turn.deps.repos,
    registry: turn.deps.registry,
    services: await draftServices(turn, sources),
    ...(turn.deps.plans ? { runner: turn.deps.plans } : {}),
    owner: { ownerId: turn.turn.ownerId, projectId: turn.project.id, sessionId: turn.chat.id },
  };
}

/** What opening the sheet answers the agent, and the sheet it adds to the reply. */
function proposed(outcome: Awaited<ReturnType<typeof proposeOne>>, turn: ToolTurn): ToolOutcome {
  if ("issues" in outcome) return refuse(`Nothing was opened. Fix all of these and call again:\n${outcome.issues.map((issue) => `- ${issue}`).join("\n")}`);
  const { piece, settled } = outcome;
  return {
    text: [
      `The make sheet is open for the person, filled in: "${piece.title}", ${piece.plannedAs}. Nothing is made until they press its button; they may change it first.`,
      piece.issues.length ? `It can't be made on this computer now, and the sheet says so:\n${piece.issues.map((issue) => `- ${issue}`).join("\n")}\nTell the person plainly what is missing and what to do; don't make a plan instead.` : "",
      piece.notices.length ? `Worth telling the person in that line, from what its maker says now: ${piece.notices.join(" ")}` : "",
      settled.length ? `Settings you left open were set as the maker would set them now: ${Object.entries(settled[0]!.values).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(", ")}.` : "",
      `Now end with reply: one line saying what the sheet holds (its shape, length, look and source, in plain words)${piece.remakes ? " and what changes from the one made before" : ""}, and that they make it with the sheet's button. Don't say it is being made.`,
    ]
      .filter(Boolean)
      .join("\n"),
    result: { pieces: [piece as unknown as OtherPiece] },
  };
}

/** What making one thing at once (from a terminal) answers the agent, and the row it adds to the reply. */
function made(outcome: MakeOutcome, turn: ToolTurn, how: "made" | "remade"): ToolOutcome {
  if ("issues" in outcome) return refuse(`Nothing was made. Fix all of these and call again:\n${outcome.issues.map((issue) => `- ${issue}`).join("\n")}`);
  if ("cannot" in outcome) return refuse(`Nothing was made: it can't be made on this computer now.\n${outcome.cannot.map((issue) => `- ${issue}`).join("\n")}\nTell the person plainly what is missing and what to do; don't make a plan instead.`);
  if ("pickNeeded" in outcome) return refuse(`Nothing was made: more than one of the person's providers could make it and none is picked. ${outcome.pickNeeded} Tell the person that in one line; don't pick for them.`);
  const { plan, node } = outcome;
  return {
    text: [
      `${how === "remade" ? "Remade" : "Made"} and started: thing ${plan.id}, "${node.title}", ${thingWords(turn.deps.registry, node)}. It is being made now; the person sees it as one row with its live step.`,
      thingNotices(turn.deps.registry, node).length ? `Worth telling the person in that line, from what its maker says now: ${thingNotices(turn.deps.registry, node).join(" ")}` : "",
      outcome.settled.length ? `Settings you left open were set as the maker would set them now: ${Object.entries(outcome.settled[0]!.values).map(([key, value]) => `${key} ${JSON.stringify(value)}`).join(", ")}.` : "",
      "Now end with reply: one line saying what is being made (its shape, length, look and source, in plain words). Don't ask them to press anything.",
    ]
      .filter(Boolean)
      .join("\n"),
    result: { pieces: [{ kind: "plan", planId: plan.id, action: "created", made: how } as OtherPiece] },
  };
}

// ── Skills ──────────────────────────────────────────────────────────────────

const readSkill: AgentTool = {
  name: "read_skill",
  description: `Reads one of Open Sourcebook's skills, or a file it points to, when it would help: the planner's guide is already in your instructions, and its references hold more on briefs and on sizing a plan. The skills:\n${skillIndex()}`,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: `A skill's name, or a file inside it, such as ${skillFiles().filter((file) => !file.endsWith("SKILL.md")).slice(0, 2).map((file) => `"${file}"`).join(" or ")}.` } },
    required: ["path"],
    additionalProperties: false,
  },
  label: () => "Reading how to plan this well",
  async run(input, turn) {
    const text = typeof input.path === "string" ? readSkillFile(input.path, projectPacks(turn.project.settings)) : undefined;
    return text ? { text } : refuse(`There is no such skill file. The files: ${skillFiles().join(", ")}.`);
  },
  said: () => "Read how to plan this well",
};

// ── Talking to the person ───────────────────────────────────────────────────

const ask: AgentTool = {
  name: "ask",
  description:
    "Asks the person one or more questions, each with short options to pick (they can always type their own answer). Use it when what they want is unclear and the answer would change what you do, for example before a plan when nothing says what it is for. Their answer comes as their next message. Then end the turn with reply: a short lead-in, with no cites.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 6,
        items: {
          type: "object",
          properties: { text: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 12 }, multiple: { type: "boolean", description: "True if more than one option may be picked." } },
          required: ["text"],
        },
      },
    },
    required: ["questions"],
  },
  label: () => "Asking you",
  async run(input, turn) {
    const asked = turn.steps.flatMap((step) => (isRecord(step.result) && Array.isArray(step.result.pieces) ? step.result.pieces : [])).filter((piece) => isRecord(piece) && piece.kind === "question").length;
    const pieces = (Array.isArray(input.questions) ? input.questions : [])
      .map((entry, index) => question(`q${asked + index + 1}`, entry, () => undefined))
      .filter((piece) => piece !== undefined);
    if (pieces.length === 0) return refuse("Each question needs `text`.");
    return { text: `The person will see ${pieces.length === 1 ? "the question" : `${pieces.length} questions`} under your reply. Now call reply with a short lead-in.`, result: { pieces } };
  },
};

const CITES_SCHEMA: JsonSchema = {
  type: "array",
  description: "The passages this says, each {passage: \"S1#4\", quote: \"<a few words copied exactly from that passage>\"}.",
  items: { type: "object", properties: { passage: { type: "string" }, quote: { type: "string" } }, required: ["passage", "quote"] },
};

const reply: AgentTool = {
  name: "reply",
  description: [
    "Shows the person your reply. Every turn ends with it.",
    "`blocks` are the reply in order, each {kind, ...}:",
    blockGuide(),
    "Every block, list item or table row that says something from the sources carries its own `cites`, using passages you searched or read this turn. A block that only greets, asks back or connects ideas has none.",
    "Call it once, with the whole reply: the person sees it as you write it.",
    "Plan cards and questions from this turn are shown after the reply's blocks; `after` is optional text shown below them, on the last call.",
    "Set `covered` to false when the sources do not hold what was asked (and say so in the reply); leave it out when the message was not a question about the sources.",
    "Every quote is checked word for word against its passage. If any fails, that call shows nothing and you get them back to fix: copy the words exactly, cite a passage that does say it, or drop the claim.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: blockKinds.names().filter((name) => name !== "text") },
            text: { type: "string", description: "The words of a paragraph, heading or note; the LaTeX of math; the code of code." },
            items: {
              type: "array",
              description: "bullets, numbered and teachback: one entry per item.",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  verdict: { type: "string", enum: VERDICTS.map((known) => known.verdict), description: "teachback only: how this point stands against the sources." },
                  cites: CITES_SCHEMA,
                },
                required: ["text"],
              },
            },
            header: { type: "array", description: "table: the column names.", items: { type: "string" } },
            rows: { type: "array", description: "table: one entry per row, as many cells as the header.", items: { type: "object", properties: { cells: { type: "array", items: { type: "string" } }, cites: CITES_SCHEMA }, required: ["cells"] } },
            lang: { type: "string", description: "code: its language." },
            nodes: {
              type: "array",
              description: "mind-map: the ideas, the central one first.",
              items: {
                type: "object",
                properties: { id: { type: "string" }, text: { type: "string", description: "The idea's name, a few words." }, detail: { type: "string", description: "The idea in one sentence." }, cites: CITES_SCHEMA },
                required: ["id", "text"],
              },
            },
            links: {
              type: "array",
              description: "mind-map: how two ideas connect, read from one to the other.",
              items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, text: { type: "string", description: 'A few words, such as "causes" or "is part of".' } }, required: ["from", "to", "text"] },
            },
            cites: CITES_SCHEMA,
          },
          required: ["kind"],
        },
      },
      more: { type: "boolean", description: "Only to show the start of a reply before the rest is ready: true on every call but the last, each call adding blocks after those shown. Leave it out otherwise." },
      after: { type: "string" },
      covered: { type: "boolean" },
    },
    required: ["blocks"],
  },
  label(_input, turn) {
    const last = turn.steps.filter((step) => step.tool === "reply").at(-1);
    return last?.state === "failed" ? "Fixing the reply" : last?.state === "done" ? "Writing more of the reply" : "Writing the reply";
  },
  async run(input, turn) {
    const { read, blocks, shown } = await readReply(input, turn);
    const earlier = turn.steps.filter((step) => step.tool === "reply");
    // Tries since the last call that was shown: each call gets its own repairs.
    const lastShown = earlier.map((step) => step.state).lastIndexOf("done");
    const tries = earlier.slice(lastShown + 1).filter((step) => step.state === "failed").length;
    const more = input.more === true;
    // The reply was already shown whole: a second one would only repeat it.
    if (shown.length > 0 && shown.at(-1)!.more !== true) return refuse("Your reply is already shown in full. Your turn is over: stop now.", { group: "reply", fixed: "again" });
    const closing = !more && shown.length > 0;
    if (read.problems.length > 0 && tries < REPLY_REPAIRS) {
      return refuse(`Nothing of this call was shown${shown.length ? " (what earlier calls showed stays)" : ""}. These blocks can't be shown:\n${read.problems.map((problem) => `- ${problem}`).join("\n")}\nCall reply again with this call's blocks fixed.`, { group: "reply", fixed: "shape" });
    }
    if (blocks.length === 0 && !closing) return refuse("`blocks` must hold at least one block with words.", { group: "reply", fixed: "shape" });
    if (read.badQuotes.length > 0 && tries < REPLY_REPAIRS) {
      return refuse(
        `Nothing of this call was shown${shown.length ? " (what earlier calls showed stays)" : ""}. These cites fail the check:\n${read.badQuotes
          .map((bad) => (bad.unknown ? `- ${bad.passage}: there is no such passage among the ticked sources` : bad.quote ? `- ${bad.passage}: "${bad.quote}" is not word for word in that passage` : `- ${bad.passage}: the cite has no quote`))
          .join("\n")}\nCall reply again with this call's blocks: copy each quote exactly from its passage (read it again if needed), cite a passage that does say it, or drop the claim.`,
        { group: "reply", fixed: "quotes" },
      );
    }
    // A turn that read the sources and answers from them cites them; a reply that cites nothing is sent back, then marked.
    // A turn that planned or asked read the sources to plan, not to answer from them: its reply needs no cites.
    // Judged on the last call, over the whole reply.
    const done = turn.steps.filter((step) => step.state === "done").map((step) => step.tool);
    const answering = done.some((tool) => tool === "search_passages" || tool === "read_passages") && !done.some((tool) => PLANNING_TOOLS.has(tool));
    const uncited = !more && answering && input.covered !== false && !read.reply.cites?.length;
    if (uncited && tries < REPLY_REPAIRS) {
      return refuse(
        `Nothing of this call was shown. You read the sources but your reply cites none of them. Every block, list item or table row that says something from the sources has its own cites: {passage: "S1#4", quote: "<words copied exactly>"}. Call reply again with ${shown.length ? "this call's blocks and" : "the reply and"} its cites; only a block that greets or connects ideas has none. If the sources do not hold the answer, say so and set covered to false.`,
        { group: "reply", fixed: "uncited" },
      );
    }
    const after = !more && typeof input.after === "string" && input.after.trim() ? [say(input.after.trim())] : [];
    const kept = read.badQuotes.length > 0 ? ` ${read.badQuotes.length} cite${read.badQuotes.length === 1 ? "" : "s"} still failed the check and ${read.badQuotes.length === 1 ? "was" : "were"} left out; blocks left with none are marked as not checked.` : "";
    return {
      text: more ? `Shown to the person.${kept} Now call reply with the next blocks; leave out \`more\` on the last call.` : `Shown to the person.${kept} Your turn is over: stop now.`,
      result: {
        final: true,
        pieces: blocks as OtherPiece[],
        after,
        ...(more ? { more: true } : {}),
        ...(uncited ? { uncited: true } : {}),
        ...(read.reply.cites ? { cites: read.reply.cites } : {}),
        ...(typeof input.covered === "boolean" ? { covered: input.covered } : {}),
      },
      note: { group: "reply", blocks: blocks.length },
    };
  },
  // While it is written: the blocks so far, the last one perhaps part way, with the cites
  // that already hold. A cite still being written is not a failed one, so nothing is marked.
  async draft(input, turn) {
    const { read, blocks, shown } = await readReply(input, turn);
    // A reply already shown whole is not added to (run sends a second one back).
    if (blocks.length === 0 || (shown.length > 0 && shown.at(-1)!.more !== true)) return undefined;
    return { final: true, pieces: blocks.map(unmarked) as OtherPiece[], ...(read.reply.cites ? { cites: read.reply.cites } : {}) };
  },
  said(steps) {
    const fixed = new Set(steps.filter((step) => step.failed).map((step) => String(step.note.fixed ?? "")));
    // A second reply sent back as already shown is not worth a word.
    fixed.delete("again");
    const parts = [
      fixed.has("quotes") ? "fixing quotes that weren't word for word" : "",
      fixed.has("uncited") ? "adding the passages it came from" : "",
      fixed.has("shape") ? "fixing its layout" : "",
    ].filter(Boolean);
    const wrote = steps.some((step) => !step.failed) ? "Wrote the reply" : "Tried to write the reply";
    return parts.length ? `${wrote}, after ${parts.join(" and ")}` : wrote;
  },
};

/**
 * A call of the reply tool read against the reply so far: its blocks checked
 * with the cites earlier calls already use (so their numbers hold), less any
 * block an earlier call already showed.
 */
async function readReply(input: Record<string, unknown>, turn: ToolTurn) {
  const sources = await turn.sources();
  const shown = turn.steps
    .filter((step) => step.tool === "reply" && step.state === "done" && isRecord(step.result) && step.result.final === true)
    .map((step) => step.result as Record<string, unknown>);
  const seed = (shown.at(-1)?.cites ?? []) as Cite[];
  // `parts`, the reply's older shape, still reads as paragraphs.
  const read = readAnswer(Array.isArray(input.blocks) ? { blocks: input.blocks } : { parts: input.parts }, sources.passages(), [], { strict: true, cites: seed });
  // A block sent again is shown once.
  const already = new Set(shown.flatMap((result) => (Array.isArray(result.pieces) ? result.pieces : [])).map((piece) => pieceKinds.asText(piece as OtherPiece).trim()));
  const blocks = read.reply.pieces.filter((piece) => {
    const words = pieceKinds.asText(piece).trim();
    return !(words.length > 24 && already.has(words));
  });
  return { read, blocks, shown };
}

/** A block with no "not checked" marks, on it or on its items and rows. */
function unmarked<T extends object>(piece: T): T {
  const { unchecked: _block, ...rest } = piece as T & { unchecked?: boolean; items?: unknown; rows?: unknown };
  const clean = (list: unknown) => (Array.isArray(list) ? list.map((entry) => (isRecord(entry) ? (({ unchecked: _entry, ...kept }) => kept)(entry) : entry)) : list);
  return { ...rest, ...("items" in rest ? { items: clean(rest.items) } : {}), ...("rows" in rest ? { rows: clean(rest.rows) } : {}) } as T;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function refuse(text: string, note?: StepNote): ToolOutcome {
  return { text, isError: true, ...(note ? { note } : {}) };
}

/** "a", "a and b", "a, b and c". */
function joinWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function title(entry: MappedSource): string {
  return entry.source.title?.trim() || "an untitled source";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The ticked sources named by `labels`, or every ticked one when none are named. */
function pickEntries(sources: TurnSources, labels: unknown): { entries: MappedSource[] } | { problem: string } {
  const ticked = sources.map.entries.filter((entry) => sources.inScope(entry));
  if (labels === undefined || (Array.isArray(labels) && labels.length === 0)) {
    return ticked.length ? { entries: ticked } : { problem: "No source is ticked and readable in this chat." };
  }
  if (!Array.isArray(labels)) return { problem: "`sources` must be a list of labels such as S1." };
  const entries: MappedSource[] = [];
  for (const label of labels) {
    const entry = typeof label === "string" ? sources.map.get(label) : undefined;
    if (!entry) return { problem: `"${String(label)}" is not a source label. list_sources gives them.` };
    if (!sources.inScope(entry)) return { problem: `${entry.label} is not ticked for this chat. Tick it with tick_source first if the person wants it.` };
    entries.push(entry);
  }
  return { entries };
}

/** Passages for the agent: label, place and words. */
function showPassages(passages: Passage[]): string {
  return renderPassages(passages.map((passage) => ({ ...passage, label: `${passage.label}${where(passage.locator) ? `, ${where(passage.locator)}` : ""}` })));
}

/** The plan a tool is about: the one named (in this chat's project), else the newest this chat made. */
async function planOf(turn: ToolTurn, id: unknown): Promise<{ plan: Plan } | { problem: string }> {
  const { repos } = turn.deps;
  if (typeof id === "string" && id.trim()) {
    const plan = await repos.plans.get(id.trim());
    if (!plan || plan.projectId !== turn.project.id || plan.ownerId !== turn.turn.ownerId) return { problem: `No plan "${id}" in this project.` };
    return { plan };
  }
  // A thing made at once is not what "the plan" means.
  const newest = (await repos.plans.listBySession(turn.chat.id)).find((plan) => !plan.direct);
  return newest ? { plan: newest } : { problem: "This chat has no plan yet. make_plan makes one." };
}

/** Source labels in items or ops that are not ticked. */
function untickedLabels(input: Record<string, unknown>, sources: TurnSources): string[] {
  const out = new Set<string>();
  for (const stage of Array.isArray(input.stages) ? input.stages : []) {
    for (const item of isRecord(stage) && Array.isArray(stage.items) ? stage.items : []) {
      for (const ref of isRecord(item) && Array.isArray(item.sources) ? item.sources : []) {
        const entry = isRecord(ref) && typeof ref.source === "string" ? sources.map.get(ref.source) : undefined;
        if (entry && !sources.inScope(entry)) out.add(entry.label);
      }
    }
  }
  return [...out];
}

async function draftServices(turn: ToolTurn, sources: TurnSources) {
  const picks = await picksByScope(turn.deps.repos, turn.turn.ownerId);
  return draftServicesFor({
    repos: turn.deps.repos,
    registry: turn.deps.registry,
    conditions: turn.deps.plans?.conditions ?? createDefaultConditions(),
    projectSources: sources.projectSources,
    sources: sources.map.entries.map((entry) => entry.source),
    ...(picks ? { picks } : {}),
  });
}
