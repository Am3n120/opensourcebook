/**
 * A set of flashcards made by the person's own agent (docs/DECISIONS.md #53,
 * #54, #64, #66): one turn of their agent, through the connector on their
 * computer, with Open Sourcebook's tools for this item (chat/agent/work.ts). It reads the
 * sources with the source tools and writes the set card by card in the set's
 * own contract (cards/contract.ts, cards/kinds.ts, cards/validate.ts). Every
 * check a card has is the writing tool's answer: a quote not word for word in
 * its passage, a side that does not fit a screen, a block the card does not
 * take, or a card that does not do what its kind needs is refused with what
 * is wrong, and nothing is kept until it is right. What makes a good card is
 * a skill it reads (skills/notebook). Open Sourcebook pays nothing: the person's
 * subscription does.
 *
 *   plan      no call: the passages are checked and the size is decided.
 *   generate  one turn of the agent; each card it writes is kept on the job,
 *             so a retry carries on from what was written and checked.
 *   validate  the same checks in code, and the links and media looked up.
 *   repair    once: what failed goes back to the agent, which fixes it.
 */
import type { SchemaError } from "../../cards/blocks";
import { CARD_SET_SCHEMA_VERSION, MAX_BLOCKS_PER_SIDE, SIDE_BUDGET, cardBlocks, sideCost, type Card, type CardBlock, type CardSet, type Cite } from "../../cards/contract";
import { cardKinds, type CardKindRegistry } from "../../cards/kinds";
import { blockCatalog } from "../../cards/shapes";
import { workPickFor } from "../agent-fields";
import { agentProblemHeard, nextTurnNumber, recordWorkUsage, workFailure, workTurnId, type AgentWork, type WorkTool } from "../../chat/agent/work";
import { outlineOf, sourceTools, type SourceWork } from "../../chat/agent/work-tools";
import { packsNote } from "../../chat/agent/work-skills";
import type { JsonSchema } from "../../chat/agent/tools";
import { JobFailure } from "../../jobs/lifecycle";
import { mergeNodeSources } from "../../sources/node-sources";
import { beyondSources } from "../../sources/beyond";
import { buildPassages, cutNotes, type Passage } from "../../sources/passages";
import type { EngineContext, EngineOutput, JsonValue, NodeSource, OutputEngine, ValidationIssue, ValidationReport } from "../../studio/types";
import type { SourceEnvelope } from "../../types/source";
import type { URLVerificationReport } from "../../types/verification";
import { verifyPayloadURLs } from "../../verify";
import type { ItemMaker } from "../makers";
import { PipelineError } from "../retry";
import { setOutput, verificationIssues } from "./output";
import { allowedEvidenceURLs, inferSourceKind, nextCardNumber, prepareSet, validateCandidate, type ItemEvidence } from "./pipeline";
import { buildAssetManifestGuidance, buildMetadataFromSource } from "./prompts";
import { fitCardCount, offPlan, type FlashcardSettings } from "./settings";

export const AGENT_FLASHCARDS_MAKER_ID = "agent";

export interface AgentSetBlueprint {
  /** How many cards the item asks for (its setting, or the count fit to its sources). */
  cards: number;
}

export interface AgentFlashcardsMakerOptions {
  work: AgentWork;
  verify?: (set: CardSet, ctx: EngineContext<FlashcardSettings>, warningURLs: string[]) => Promise<URLVerificationReport>;
  /** The kinds of card; the ones Open Sourcebook ships when absent. */
  kinds?: CardKindRegistry;
}

/** What the agent has written so far, kept on the job after every change. */
export interface SetDraft {
  title?: string;
  subtitle?: string;
  parts?: Array<{ title: string; about?: string; cards?: number }>;
  cards: Card[];
  /** Why the set came out a different size from the one planned, in the agent's words for the person. */
  note?: string;
  finished: boolean;
}

/** One turn's view of the item: its passages, the draft and how to keep it. */
export interface SetWork extends SourceWork {
  item: ItemEvidence;
  source: SourceEnvelope;
  allowed: Set<string>;
  /** Cards the item asks for. */
  target: number;
  kinds: CardKindRegistry;
  /** The kinds this item's settings allow. */
  allowedKinds: string[];
  draft: SetDraft;
  save(): Promise<void>;
  /** Shows how far the writing is. */
  progress(): number;
}

const DRAFT_KEY = "agent:cards";
const TURNS_KEY = "agent:turns";

export function createAgentFlashcardsMaker(options: AgentFlashcardsMakerOptions): ItemMaker<FlashcardSettings, AgentSetBlueprint, CardSet> {
  const problem = () => agentProblemHeard(options.work.heard());
  return {
    id: AGENT_FLASHCARDS_MAKER_ID,
    label: "Your agent",
    usesAgent: true,
    description:
      "Your own agent writes the cards on this computer: it reads the sources and writes the set card by card, and Open Sourcebook checks every quote and that each side fits a screen. No model cost to Open Sourcebook. Needs the connector running on this computer.",
    engine: new AgentFlashcardsEngine(options),
    maxRepairRounds: 1,
    estimateCost: (input) =>
      input.sourceCount === 0 || input.sourceChars === 0 ? { usd: 0, basis: "no source text to make cards from" } : { usd: 0, basis: "written by your own agent on this computer: no model cost to Open Sourcebook" },
    ready: () => (options.work.heard() ? problem() === undefined : undefined),
    issues: () => {
      const why = problem();
      return why ? [`your agent makes it, and ${why}: start it, or pick another maker`] : [];
    },
    status: async () => {
      const status = await options.work.status();
      const why = agentProblemHeard(status);
      const agent = status.agent ? { id: status.agent.id, label: status.agent.label, ...(status.model ? { model: status.model } : {}) } : undefined;
      return why ? { available: false, problem: `Your agent makes it, and ${why}.`, ...(agent ? { agent } : {}) } : { available: true, ...(agent ? { agent } : {}) };
    },
  };
}

class AgentFlashcardsEngine implements OutputEngine<FlashcardSettings, AgentSetBlueprint, CardSet> {
  readonly type = "flashcards";
  readonly schemaVersion = CARD_SET_SCHEMA_VERSION;

  constructor(private readonly options: AgentFlashcardsMakerOptions) {}

  async plan(ctx: EngineContext<FlashcardSettings>): Promise<AgentSetBlueprint> {
    const passages = requirePassages(ctx);
    await ctx.services.progress({ stage: "planning", progress: 0.02, step: "Getting the sources ready for your agent" });
    const chars = passages.reduce((total, passage) => total + passage.text.length, 0);
    return { cards: ctx.node.settings.cards > 0 ? ctx.node.settings.cards : fitCardCount(chars) };
  }

  async generate(ctx: EngineContext<FlashcardSettings>, blueprint: AgentSetBlueprint): Promise<EngineOutput<CardSet>> {
    const work = this.workFor(ctx, blueprint);
    if (!work.draft.finished) await this.turn(ctx, work, writePrompt(ctx, work));
    return this.output(ctx, work);
  }

  async validate(ctx: EngineContext<FlashcardSettings>, output: EngineOutput<CardSet>, blueprint: AgentSetBlueprint): Promise<ValidationReport> {
    const work = this.workFor(ctx, blueprint);
    const local = validateCandidate(output.payload, work.allowed, work.item, { kinds: work.kinds, allowedKinds: work.allowedKinds });
    const warnings = local.warnings.map((entry) => issueOf(entry, "warning"));
    if (local.errors.length > 0) return report([...local.errors.map((entry) => issueOf(entry, "error")), ...warnings]);
    const warningURLs = work.source.originalURL ? [work.source.originalURL] : [];
    const verification = this.options.verify
      ? await this.options.verify(output.payload, ctx, warningURLs)
      : await verifyPayloadURLs(output.payload, { fetchImpl: ctx.services.sourceFetch ?? ctx.services.fetch, warningURLs });
    return report([...verificationIssues(verification), ...warnings]);
  }

  async repair(ctx: EngineContext<FlashcardSettings>, output: EngineOutput<CardSet>, validation: ValidationReport, blueprint: AgentSetBlueprint): Promise<EngineOutput<CardSet>> {
    const work = this.workFor(ctx, blueprint);
    const problems = validation.issues.filter((issue) => issue.severity === "error").map((issue) => problemLine(issue, output.payload, work.draft));
    work.draft.finished = false;
    await work.save();
    await this.turn(ctx, work, repairPrompt(ctx, work, problems));
    return this.output(ctx, work);
  }

  /** The item's evidence and the draft an earlier turn of this job kept. */
  private workFor(ctx: EngineContext<FlashcardSettings>, blueprint: AgentSetBlueprint): SetWork {
    const passages = requirePassages(ctx);
    const sources = readSources(ctx.sources);
    const source = mergeNodeSources(sources);
    const draft = readDraft(ctx.services.checkpoint?.get(DRAFT_KEY));
    const kinds = this.options.kinds ?? cardKinds;
    const chosen = (ctx.node.settings.kinds ?? []).filter((id) => kinds.get(id));
    const target = typeof blueprint?.cards === "number" && blueprint.cards > 0 ? blueprint.cards : fitCardCount(passages.reduce((total, passage) => total + passage.text.length, 0));
    const work: SetWork = {
      passages,
      packs: ctx.project?.packs ?? [],
      item: { passages, sources },
      source,
      allowed: allowedEvidenceURLs(source, undefined),
      target,
      kinds,
      allowedKinds: chosen.length > 0 ? chosen : kinds.ids(),
      draft,
      save: async () => {
        await ctx.services.checkpoint?.put(DRAFT_KEY, work.draft as unknown as JsonValue);
      },
      progress: () => 0.08 + 0.8 * Math.min(1, work.draft.cards.length / Math.max(1, plannedCards(work.draft) ?? work.target)),
    };
    return work;
  }

  /** One turn of the agent on the set; a turn that ends without a set fails the job, with what it wrote kept. */
  private async turn(ctx: EngineContext<FlashcardSettings>, work: SetWork, prompt: string): Promise<void> {
    const number = nextTurnNumber(ctx.services.checkpoint?.get(TURNS_KEY));
    await ctx.services.checkpoint?.put(TURNS_KEY, number);
    await ctx.services.progress({ stage: "writing", progress: work.progress(), step: work.draft.cards.length ? "Asking your agent to carry on" : "Asking your agent to start" });
    const end = await this.options.work.run({
      turnId: workTurnId(ctx.jobId, number),
      ...(number > 1 ? { replaces: workTurnId(ctx.jobId, number - 1) } : {}),
      target: { type: ctx.node.type, id: ctx.node.id },
      pick: await workPickFor(ctx),
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      instructions: "Open Sourcebook's tools for writing one set of flashcards from this item's sources. Finish with finish_cards.",
      tools: flashcardTools(),
      work,
      ...(ctx.services.signal ? { signal: ctx.services.signal } : {}),
      step: (label) => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress(), step: label })),
      heartbeat: () => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress() })),
    });
    await recordWorkUsage(ctx.services.usage, ctx.jobId, end, this.options.work.agent);
    if (work.draft.finished) return;
    if (end.outcome === "failed") throw workFailure(end, "set of flashcards");
    // The agent ended without saying it was finished: what it wrote stands if it passes as a whole.
    if (work.draft.cards.length === 0 || wholeSetProblems(work).length > 0) {
      throw new JobFailure("The agent ended its turn without finishing the set of flashcards.", false, "agent_dropped");
    }
  }

  private async output(ctx: EngineContext<FlashcardSettings>, work: SetWork): Promise<EngineOutput<CardSet>> {
    await ctx.services.progress({ stage: "verifying", progress: 0.9, step: "Checking the cards" });
    return setOutput(assemble(work), ctx, work.source);
  }
}

const SYSTEM_PROMPT = `You are making one set of flashcards in Open Sourcebook, the notebook that turns a person's own sources into things to learn from, for a person who studies from their own sources. A set is cards the person swipes through, one phone screen each, and turns over: each card does one job (a question, term or cue to answer from memory, a sentence with its key part hidden, a comparison, steps, a formula, a worked example, a picture to name, a question that checks itself), and the person marks each one got it or not yet, so the cards they miss come back until they stick. It is grounded in the sources.

You work only through Open Sourcebook's tools: read the sources with outline_sources, read_passages and search_passages; write the set with plan_cards, write_card, change_card, remove_card and read_cards; and say it is done with finish_cards. You cannot see files, run commands or browse the web here.

Open Sourcebook's notebook skill holds what makes a card help someone remember; read it (read_skill) before you plan, and its references when you want more. Each card you write is checked as you send it, and the tool's answer says exactly what to fix when something is wrong. When the whole set is written and you have read it back as the person will meet it, call finish_cards, then end your turn.`;

/** The prompt of the first turn: the item, its settings, what the plan around it covers, and the sources' outline. */
function writePrompt(ctx: EngineContext<FlashcardSettings>, work: SetWork): string {
  const parts = itemParts(ctx, work);
  if (work.draft.cards.length > 0) {
    parts.push(`You already wrote ${work.draft.cards.length} card${work.draft.cards.length === 1 ? "" : "s"} of this set in an earlier turn, each checked and kept. Read them back with read_cards and carry on from there; change or remove any that should be better.`);
  }
  parts.push("Make the set.");
  return parts.join("\n\n");
}

function repairPrompt(ctx: EngineContext<FlashcardSettings>, work: SetWork, problems: string[]): string {
  return [
    ...itemParts(ctx, work),
    `You wrote this set (read_cards shows it), and Open Sourcebook's last check of the whole set found:\n${problems.map((line) => `- ${line}`).join("\n")}\nFix those cards, then call finish_cards again.`,
  ].join("\n\n");
}

function itemParts(ctx: EngineContext<FlashcardSettings>, work: SetWork): string[] {
  const parts: string[] = [];
  if (ctx.project?.title) parts.push(`Project: ${ctx.project.title}`);
  const packs = packsNote(ctx.project?.packs ?? []);
  if (packs) parts.push(packs);
  parts.push(`Item: ${ctx.node.title.trim() || "a set of flashcards"}`);
  parts.push(ctx.node.prompt.trim() ? `Brief (what this set is for and what it covers; it is not a source, so nothing in it is a fact until a passage says it):\n${ctx.node.prompt.trim()}` : "Brief: none. Make cards for what is most worth remembering in the sources.");
  parts.push(
    ctx.node.settings.cards > 0
      ? `Cards: ${ctx.node.settings.cards}, the number the plan set; the person was shown it.`
      : `Cards: about ${work.target}, from the size of the sources; write as many as they hold things worth remembering, and say so when you finish if that is clearly more or fewer.`,
  );
  if (work.allowedKinds.length < work.kinds.ids().length) parts.push(`Kinds of card this set takes: ${work.allowedKinds.join(", ")}.`);
  if (ctx.assumes.length > 0) {
    parts.push(`The person has already been through these items of the plan; make cards that help them remember what those taught, and do not explain it again from the start:\n${ctx.assumes.map((prior) => `- ${prior.type} "${prior.title}": ${prior.summary}`).join("\n")}`);
  }
  const style = ctx.node.settings.exemplarSummaries;
  if (style.length > 0) parts.push(`Summaries of earlier things the person liked, for the voice only (not content):\n${style.map((line) => `- ${line}`).join("\n")}`);
  const cut = cutNotes(ctx.sources);
  if (cut.length > 0) parts.push(cut.join("\n"));
  const assets = buildAssetManifestGuidance(work.source);
  if (assets) parts.push(assets);
  parts.push(outlineOf(work.passages));
  return parts;
}

/** The tools for a set: the source tools, then the writing tools, described from the set's own contract and kinds. */
export function flashcardTools(): WorkTool<SetWork>[] {
  return [...sourceTools<SetWork>(), planCards, writeCard, changeCard, removeCard, readCards, finishCards];
}

const CITES_SCHEMA: JsonSchema = {
  type: "array",
  description:
    'What the card draws on: {"passage":"P3"}, and when it states something from it, "quote" with a few words copied exactly from that passage and "block" with the index of the block that holds that claim, counted over the front and then the back (the first back block is front.length): the person sees the cite at the end of that block, so a cite on the back shows only once the card is turned over and never gives the answer away.',
  items: {
    type: "object",
    properties: { passage: { type: "string" }, quote: { type: "string" }, block: { type: "integer", minimum: 0 } },
    required: ["passage"],
    additionalProperties: false,
  },
};

const SIDE_SCHEMA = (side: string): JsonSchema => ({ type: "array", maxItems: MAX_BLOCKS_PER_SIDE, items: { type: "object" }, description: `The ${side}'s blocks, in order; the shapes are listed in this tool's description.` });

function cardProperties(): Record<string, JsonSchema> {
  return {
    kind: { type: "string", description: "Which kind of card this is; the kinds are listed in this tool's description." },
    section: { type: "string", description: "The group the card belongs to (a topic, a part of the source); the player shows it small above the card, so neighbouring cards share it." },
    front: { ...SIDE_SCHEMA("front"), minItems: 1 },
    back: SIDE_SCHEMA("back"),
    cites: CITES_SCHEMA,
  };
}

const planCards: WorkTool<SetWork> = {
  name: "plan_cards",
  description: "Sets the set's title, a subtitle, and the groups of cards you mean to write, each with what it covers and about how many cards. The groups show the person how far the writing is; you can call it again to change the plan.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      subtitle: { type: "string", description: "One line under the title." },
      parts: {
        type: "array",
        items: { type: "object", properties: { title: { type: "string" }, about: { type: "string" }, cards: { type: "integer", minimum: 1 } }, required: ["title"], additionalProperties: false },
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
  label: () => "Planning the cards",
  async run(input, work) {
    const title = text(input.title);
    if (!title) return { text: "`title` is required.", isError: true };
    work.draft.title = title.slice(0, 200);
    const subtitle = text(input.subtitle);
    if (subtitle) work.draft.subtitle = subtitle.slice(0, 300);
    if (Array.isArray(input.parts)) {
      work.draft.parts = input.parts
        .filter(isRecord)
        .map((part) => ({ title: text(part.title) ?? "", ...(text(part.about) ? { about: text(part.about)! } : {}), ...(typeof part.cards === "number" && part.cards > 0 ? { cards: Math.round(part.cards) } : {}) }))
        .filter((part) => part.title)
        .slice(0, 60);
    }
    await work.save();
    const planned = plannedCards(work.draft);
    return { text: `Kept: "${work.draft.title}"${planned ? `, about ${planned} cards in ${work.draft.parts!.length} groups` : ""}. Write the cards with write_card, in the order the person should meet them.` };
  },
};

const writeCard: WorkTool<SetWork> = {
  name: "write_card",
  get description() {
    return `Adds one card to the set, after the last one (or after the card named in \`after\`). A card does one job and has a front (what the person sees first) and, for most kinds, a back (what it turns over to). Each side is one phone screen: up to ${MAX_BLOCKS_PER_SIDE} blocks, at most one main block (media, a chart, a table or a question), and at most ${SIDE_BUDGET} units, where each block costs its shown characters (at least 40), plus 40 for every list item, table row, code line, option or pair after the first, plus 350 for media or a chart and 120 for metrics, bigStat or linkPreview. It is checked when you send it: its kind, its blocks against their shapes, each side's size, and every quote word for word against its passage. When anything is wrong nothing is kept and the answer says exactly what to fix.\n\nKinds of card:\n${cardKinds.catalog()}\n\nBlocks:\n${blockCatalog()}`;
  },
  inputSchema: {
    type: "object",
    properties: { ...cardProperties(), after: { type: "string", description: "The id of the card to put this one after; the end when left out." } },
    required: ["kind", "front", "cites"],
    additionalProperties: false,
  },
  label: (_input, work) => {
    const planned = plannedCards(work.draft) ?? work.target;
    const n = work.draft.cards.length + 1;
    return n <= planned ? `Writing card ${n} of ${planned}` : `Writing card ${n}`;
  },
  async run(input, work) {
    const after = text(input.after);
    const at = after ? work.draft.cards.findIndex((card) => card.id === after) : work.draft.cards.length - 1;
    if (after && at < 0) return { text: `There is no card "${after}"; read_cards lists the cards.`, isError: true };
    const checked = checkCard(input, work);
    if ("problems" in checked) return refuse(checked.problems);
    const card = { ...checked.card, id: `c${nextCardNumber(work.draft.cards)}` };
    work.draft.cards.splice(at + 1, 0, card);
    work.draft.finished = false;
    await work.save();
    return { text: keptLine(card, work, checked.notes) };
  },
};

const changeCard: WorkTool<SetWork> = {
  name: "change_card",
  description: "Replaces one card you wrote with a new version, checked the same way as write_card. Send the whole card: its kind, section, front, back and cites. It keeps its id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "The card's id, from read_cards." }, ...cardProperties() },
    required: ["id", "kind", "front", "cites"],
    additionalProperties: false,
  },
  label: (input, work) => {
    const at = work.draft.cards.findIndex((card) => card.id === text(input.id));
    return at >= 0 ? `Improving card ${at + 1}` : "Improving a card";
  },
  async run(input, work) {
    const at = work.draft.cards.findIndex((card) => card.id === text(input.id));
    if (at < 0) return { text: `There is no card "${String(input.id)}"; read_cards lists the cards.`, isError: true };
    const checked = checkCard(input, work);
    if ("problems" in checked) return refuse(checked.problems);
    const card = { ...checked.card, id: work.draft.cards[at]!.id };
    work.draft.cards[at] = card;
    work.draft.finished = false;
    await work.save();
    return { text: keptLine(card, work, checked.notes) };
  },
};

const removeCard: WorkTool<SetWork> = {
  name: "remove_card",
  description: "Removes one card you wrote.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  label: () => "Removing a card",
  async run(input, work) {
    const at = work.draft.cards.findIndex((card) => card.id === text(input.id));
    if (at < 0) return { text: `There is no card "${String(input.id)}"; read_cards lists the cards.`, isError: true };
    work.draft.cards.splice(at, 1);
    work.draft.finished = false;
    await work.save();
    return { text: `Removed. The set has ${work.draft.cards.length} card${work.draft.cards.length === 1 ? "" : "s"}.` };
  },
};

const readCards: WorkTool<SetWork> = {
  name: "read_cards",
  description: "Reads back the set as written so far: its title, its plan, and every card in order with its id, kind, group, front, back and cites.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  label: () => "Reading the cards back",
  run: (_input, work) => ({ text: renderDraft(work) }),
};

const finishCards: WorkTool<SetWork> = {
  name: "finish_cards",
  description:
    "Says the set is finished. The whole set is checked once more (a title, at least one card, every card as write_card checks it, no picture used twice); when it passes, it is kept and you end your turn. The person was shown the number of cards planned; when the set came out clearly larger or smaller than that, give `note`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The set's title, if not set with plan_cards or to change it." },
      subtitle: { type: "string" },
      note: { type: "string", description: "When the set is a different size from the one planned or asked for: one plain sentence to the person on what it became and why (the sources held less on a part, two planned cards were one idea)." },
    },
    additionalProperties: false,
  },
  label: () => "Checking the whole set",
  async run(input, work) {
    const title = text(input.title);
    if (title) work.draft.title = title.slice(0, 200);
    const subtitle = text(input.subtitle);
    if (subtitle) work.draft.subtitle = subtitle.slice(0, 300);
    if (!work.draft.title) return { text: "The set needs a title: give one here or with plan_cards.", isError: true };
    if (work.draft.cards.length === 0) return { text: "The set has no cards yet; write them with write_card.", isError: true };
    const note = text(input.note);
    if (note) work.draft.note = note.slice(0, 300);
    const problems = wholeSetProblems(work);
    if (problems.length > 0) return refuse(problems);
    const planned = plannedCards(work.draft) ?? work.target;
    if (!work.draft.note && offPlan(work.draft.cards.length, planned)) {
      await work.save();
      return { text: `About ${planned} cards were planned and you wrote ${work.draft.cards.length}; the person saw the plan. If this size is right, call finish_cards again with \`note\`: what the set became and why, in a sentence to them. Otherwise write or remove cards first.`, isError: true };
    }
    work.draft.finished = true;
    await work.save();
    return { text: `The set is finished and kept: "${work.draft.title}", ${work.draft.cards.length} card${work.draft.cards.length === 1 ? "" : "s"}. End your turn now.` };
  },
};

/**
 * One card as the agent sent it, checked as the set checks it: cites name
 * the item's passages, blocks fit their shapes, each side fits a screen, the
 * card does what its kind needs, and every quote is word for word in its
 * passage. Either the card as kept (cites pointing at the spot) or what is wrong.
 */
export function checkCard(sent: Record<string, unknown>, work: SetWork): { card: Card; notes: string[] } | { problems: string[] } {
  const problems: string[] = [];
  const front = parsedList(sent.front);
  const back = sent.back === undefined || sent.back === null ? [] : parsedList(sent.back);
  const cites = sent.cites === undefined ? [] : parsedList(sent.cites);
  if (!Array.isArray(front) || front.length === 0) return { problems: [`front must be a list of 1 to ${MAX_BLOCKS_PER_SIDE} blocks.`] };
  if (!Array.isArray(back)) return { problems: ["back must be a list of blocks, or left out for a card that does not turn over."] };
  if (!Array.isArray(cites)) return { problems: ["cites must be a list."] };
  const kind = text(sent.kind);
  if (!kind) return { problems: [`kind is required: one of ${work.allowedKinds.join(", ")}.`] };
  const all = [...front, ...back];
  const labels = new Set(work.passages.map((passage) => passage.label));
  cites.forEach((cite, index) => {
    if (!isRecord(cite) || typeof cite.passage !== "string") problems.push(`cites[${index}]: name a passage, {"passage":"P3"}.`);
    else if (!labels.has(cite.passage.trim())) problems.push(`cites[${index}]: "${cite.passage}" is not a passage of this item; its passages are ${work.passages[0]?.label}–${work.passages.at(-1)?.label}.`);
    else if (cite.block !== undefined && !(Number.isInteger(cite.block) && (cite.block as number) >= 0 && (cite.block as number) < all.length)) problems.push(`cites[${index}].block: must be the index of one of this card's ${all.length} blocks, from 0, front first, then back.`);
    else if (cite.block !== undefined && isRecord(all[cite.block as number]) && (all[cite.block as number] as Record<string, unknown>).type === "background") problems.push(`cites[${index}].block: block ${cite.block} is background, what you add that is not in the sources, so nothing cites it; cite the block that says what the source says.`);
  });
  if (problems.length > 0) return { problems };
  const section = text(sent.section);
  const sides = { front: front as CardBlock[], ...(back.length > 0 ? { back: back as CardBlock[] } : {}) };
  const candidate = setOf(work, [{ id: "c1", kind, ...(section ? { section } : {}), ...sides, cites: cites as unknown as Cite[] }]);
  const prepared = prepareSet(candidate, work.source, work.item);
  const card = prepared.cards[0];
  if (!card) return { problems: ["Nothing of this card's front is left once pictures already used in the set are taken out; write it with something else."] };
  const check = validateCandidate(prepared, work.allowed, work.item, { kinds: work.kinds, allowedKinds: work.allowedKinds });
  const own = (entry: SchemaError) => entry.path.startsWith("$.cards[0]");
  problems.push(...check.errors.filter(own).map((entry) => describe(entry, "$.cards[0]")));
  // A picture another card already shows is shown once.
  const used = mediaURLs(work.draft.cards.filter((other) => other.id !== text(sent.id)));
  for (const url of mediaURLs([card])) if (used.has(url)) problems.push(`${url} is already shown on another card; a picture appears once in a set.`);
  if (problems.length > 0) return { problems };
  const notes = check.warnings.filter(own).map((entry) => (entry.code === "uncited_card" ? "It cites nothing: if it states something from the sources, cite the passage it comes from." : describe(entry, "$.cards[0]")));
  const blocks = cardBlocks(card);
  // A cite is shown at the end of the block it names, so one on a heading lands under the heading, not at its claim.
  const onTitles = card.cites.filter((cite) => cite.block !== undefined && ["heading", "subheading", "kicker"].includes(String(blocks[cite.block]?.type)));
  const beyond = beyondSources(
    wordsOf(blocks.filter((block) => block.type !== "background")),
    work.passages.map((passage) => passage.text),
  );
  if (beyond.numbers.length || beyond.terms.length) {
    const named = [...beyond.numbers, ...beyond.terms.map((term) => `"${term}"`)].join(", ");
    notes.push(`Kept, but your sources do not contain ${named}. The person must be able to tell what their source says from what you add: if the source says it, cite the passage that does; if it is yours (a usual reading, a name, a rule of thumb, an example), put it in a background block or say plainly that it is an example.`);
  }
  if (onTitles.length > 0) notes.push("A cite names a heading as its block, and the person sees a cite at the end of the block it names: with change_card, name the block that holds the claim instead.");
  return { card, notes };
}

/** Every word a card's blocks show, for checking against the sources (a cloze's brackets are not words). */
function wordsOf(blocks: unknown[]): string {
  const out: string[] = [];
  const walk = (value: unknown, key?: string) => {
    if (key && ["type", "url", "style", "color", "language", "systemIcon", "platform", "id"].includes(key)) return;
    if (typeof value === "string") out.push(value.replace(/\[\[|\]\]/g, ""));
    else if (Array.isArray(value)) value.forEach((entry) => walk(entry));
    else if (isRecord(value)) Object.entries(value).forEach(([k, v]) => walk(v, k));
  };
  walk(blocks);
  return out.join("\n");
}

/** A list sent as JSON text (some agents send a nested value as a string) read as the list; anything else as sent. */
function parsedList(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** What is wrong with the set as a whole, by card id. */
function wholeSetProblems(work: SetWork): string[] {
  const set = assemble(work);
  const check = validateCandidate(set, work.allowed, work.item, { kinds: work.kinds, allowedKinds: work.allowedKinds });
  return check.errors.map((entry) => {
    const at = /^\$\.cards\[(\d+)\]/.exec(entry.path);
    const id = at ? set.cards[Number(at[1])]?.id : undefined;
    return id ? `Card ${id}: ${describe(entry, at![0])}` : describe(entry, "$");
  });
}

/** The set from the draft, in Open Sourcebook's shape; ids are the draft's own. */
function assemble(work: SetWork): CardSet {
  return prepareSet(setOf(work, work.draft.cards), work.source, work.item);
}

function setOf(work: SetWork, cards: Card[]): CardSet {
  const metadata = buildMetadataFromSource(work.source, inferSourceKind(work.source));
  return {
    schemaVersion: CARD_SET_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    title: work.draft.title ?? metadata.title,
    subtitle: work.draft.subtitle ?? metadata.subtitle,
    sourceKind: inferSourceKind(work.source),
    ...(metadata.sourceDomain ? { sourceDomain: metadata.sourceDomain } : {}),
    ...(metadata.author ? { author: metadata.author } : {}),
    tags: [],
    cards: cards.map((card) => ({ ...card, cites: card.cites.map((cite) => ({ ...cite })) })),
    ...(work.draft.note ? { sizeNote: work.draft.note } : {}),
  };
}


function keptLine(card: Card, work: SetWork, notes: string[]): string {
  const position = work.draft.cards.findIndex((other) => other.id === card.id) + 1;
  const planned = plannedCards(work.draft) ?? work.target;
  const size = `front ${sideCost(card.front)}${card.back ? `, back ${sideCost(card.back)}` : ""} of ${SIDE_BUDGET} units`;
  return [`Kept as ${card.id}, card ${position} of ${work.draft.cards.length} (about ${planned} planned), a ${card.kind} card, ${size}.`, ...notes].join(" ");
}

function renderDraft(work: SetWork): string {
  const { draft } = work;
  const byLabel = (cite: Cite) => work.passages.find((passage) => (cite.chunkId ? passage.chunkId === cite.chunkId : cite.locator?.charStart !== undefined && passage.id === `${cite.sourceId}@${cite.locator.charStart}-${cite.locator.charEnd}`))?.label;
  const head = [
    `Title: ${draft.title ?? "(none yet)"}${draft.subtitle ? `\nSubtitle: ${draft.subtitle}` : ""}`,
    draft.parts?.length ? `Plan:\n${draft.parts.map((part) => `- ${part.title}${part.cards ? ` (~${part.cards} cards)` : ""}${part.about ? `: ${part.about}` : ""}`).join("\n")}` : "",
    `${draft.cards.length} card${draft.cards.length === 1 ? "" : "s"}${draft.finished ? ", finished" : ""} (about ${plannedCards(draft) ?? work.target} planned):`,
  ].filter(Boolean);
  const cards = draft.cards.map((card, index) => {
    const cites = card.cites
      .filter((cite) => cite.spot !== "image" && cite.spot !== "moment")
      .map((cite) => ({ passage: byLabel(cite) ?? cite.sourceId, ...(cite.quote ? { quote: cite.quote } : {}), ...(cite.block !== undefined ? { block: cite.block } : {}) }));
    return `## ${index + 1}. ${card.id} [${card.kind}] group "${card.section ?? ""}"\nfront: ${JSON.stringify(card.front)}${card.back ? `\nback: ${JSON.stringify(card.back)}` : ""}\ncites: ${JSON.stringify(cites)}`;
  });
  return [...head, ...cards].join("\n\n");
}

/** A check's finding in words, with its place inside the card. */
function describe(entry: SchemaError, prefix: string): string {
  const where = entry.path.startsWith(prefix) ? entry.path.slice(prefix.length).replace(/^\./, "") : entry.path;
  const detail = [entry.expected ? `expected ${entry.expected}` : "", entry.actual ? `got ${entry.actual}` : ""].filter(Boolean).join(", ");
  return `${where ? `${where}: ` : ""}${entry.message}${detail ? ` (${detail})` : ""}`;
}

/** An Open Sourcebook check of the whole set as the agent reads it: the card by its id, then what is wrong. */
function problemLine(issue: ValidationIssue, set: CardSet, draft: SetDraft): string {
  const at = /^\$\.cards\[(\d+)\](.*)$/.exec(issue.path);
  if (at) return `Card ${set.cards[Number(at[1])]?.id ?? draft.cards[Number(at[1])]?.id ?? Number(at[1]) + 1}${at[2] ? ` (${at[2].replace(/^\./, "")})` : ""}: ${issue.message}`;
  if (!issue.path.startsWith("$")) {
    const users = draft.cards.filter((card) => JSON.stringify(cardBlocks(card)).includes(JSON.stringify(issue.path))).map((card) => card.id);
    return `${users.length ? `Card ${users.join(", ")}: ` : ""}${issue.path}: ${issue.message}`;
  }
  return `The set: ${issue.message}`;
}

function refuse(problems: string[]): { text: string; isError: true } {
  return { text: `Not kept. Fix this and send the card again:\n${problems.map((line) => `- ${line}`).join("\n")}`, isError: true };
}

function mediaURLs(cards: Card[]): Set<string> {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) urls.add(value);
  };
  for (const block of cards.flatMap(cardBlocks) as unknown[]) {
    if (!isRecord(block)) continue;
    if (["figure", "image", "labelPicture"].includes(String(block.type))) add(block.url);
    if (block.type === "gallery" && Array.isArray(block.images)) block.images.filter(isRecord).forEach((image) => add(image.url));
    if (block.type === "carousel" && Array.isArray(block.items)) block.items.filter(isRecord).forEach((image) => add(image.url));
  }
  return urls;
}

function plannedCards(draft: SetDraft): number | undefined {
  const total = (draft.parts ?? []).reduce((sum, part) => sum + (part.cards ?? 0), 0);
  return total > 0 ? total : undefined;
}

function readDraft(value: JsonValue | undefined): SetDraft {
  if (isRecord(value) && Array.isArray(value.cards)) {
    const cards = (value.cards as unknown[]).filter((card): card is Card => isRecord(card) && typeof card.id === "string" && Array.isArray(card.front) && Array.isArray(card.cites));
    return {
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.subtitle === "string" ? { subtitle: value.subtitle } : {}),
      ...(Array.isArray(value.parts) ? { parts: value.parts as SetDraft["parts"] } : {}),
      ...(typeof value.note === "string" ? { note: value.note } : {}),
      cards,
      finished: value.finished === true && cards.length > 0,
    };
  }
  return { cards: [], finished: false };
}

/** The sources whose text was read; one that gave only its title and details has nothing to make cards from. */
function readSources(sources: NodeSource[]): NodeSource[] {
  return sources.filter((source) => source.envelope.accessLevel !== "metadata" && source.envelope.accessLevel !== "none");
}

function requirePassages(ctx: EngineContext<FlashcardSettings>): Passage[] {
  const passages = buildPassages(readSources(ctx.sources));
  if (passages.length === 0) throw new PipelineError("Flashcards need source text to be made from; this item has none that could be read.", "NO_SOURCE_TEXT");
  return passages;
}

function issueOf(error: SchemaError, severity: ValidationIssue["severity"]): ValidationIssue {
  const detail = [error.expected ? `expected ${error.expected}` : "", error.actual ? `got ${error.actual}` : ""].filter(Boolean).join(", ");
  return { path: error.path, code: error.code, message: detail ? `${error.message} (${detail})` : error.message, severity };
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
