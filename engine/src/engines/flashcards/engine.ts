/**
 * Open Sourcebook's own writer of a set of flashcards, the "Model API key" maker
 * (docs/DECISIONS.md #33, #34; engine/docs/flashcards.md): it calls a model
 * with the key set on this engine. It grew out of the August page pipeline
 * and keeps what that did well: research, evidence-only URLs and media, chart
 * checks, repair and media salvage.
 *
 *   plan      size the set (the item's number of cards, or one fit to its
 *             sources), research for a large set, plan the sections. Saved on
 *             the job, so a redelivered job does not research or plan again.
 *             A source with no readable text makes no set.
 *   generate  write each section as cards (bounded concurrency, a fallback
 *             card per failed section), assemble and clean the set.
 *   validate  the set's contract per card (kind and what it needs, blocks,
 *             one screen per side, cites) with the item's kinds, evidence
 *             URLs and grounding per card, then URL/media/chart verification.
 *   repair    each failing card on its own, the rest kept as they are, ids
 *             kept (the person's progress is kept by them); when the only
 *             errors left after it are media URLs that cannot be verified,
 *             strip exactly those.
 *
 * The engine keeps no state between steps: validate and repair re-derive the
 * merged source and the passages from the context and read the size and
 * research from the blueprint they are handed.
 */
import { BYTE_DEPTHS, depthRank, type ByteDepth, type GenerationDepth, type SchemaError } from "../../cards/blocks";
import { CARD_SET_SCHEMA_VERSION, cardBlocks, type Card, type CardSet } from "../../cards/contract";
import { cardKinds } from "../../cards/kinds";
import type { CardSetRules } from "../../cards/validate";
import { isRecord } from "../../net";
import { createOpenAlexProvider } from "../../providers/openalex";
import { researchSource } from "../../research";
import { mergeNodeSources } from "../../sources/node-sources";
import { buildPassages, type Passage } from "../../sources/passages";
import { charsOf, isLong, passagesNamed, renderMap, spread, spreadNote, WHOLE_READ_CHARS } from "../../sources/reading";
import type { EngineContext, EngineOutput, EngineServices, JsonValue, OutputEngine, ValidationIssue, ValidationReport } from "../../studio/types";
import type { ResearchResult, SourceEnvelope } from "../../types/source";
import type { URLVerificationReport } from "../../types/verification";
import { verifyPayloadURLs } from "../../verify";
import { PipelineError, withRetry } from "../retry";
import { setOutput, verificationIssues } from "./output";
import {
  allowedEvidenceURLs,
  buildSetFromSections,
  decideDepth,
  fallbackSectionDraft,
  inferSourceKind,
  normalizeSectionDraft,
  normalizeStructurePlan,
  passageOf,
  prepareSet,
  salvageUnverifiableMedia,
  validateCandidate,
  type ItemEvidence,
} from "./pipeline";
import {
  buildCardRepairPrompt,
  buildDeliverySystemPrompt,
  buildMetadataFromSource,
  buildSectionPrompt,
  buildStructurePrompt,
  type CardTarget,
  type NodePromptContext,
  type PromptEvidence,
} from "./prompts";
import { fitCardCount, offPlan, requestedDepthOf, type FlashcardSettings } from "./settings";
import type { SectionDraft, StructurePlan, StructureSection } from "./types";

/** Saved on the job between attempts; plain JSON. */
export interface ApiFlashcardsBlueprint {
  requestedDepth: GenerationDepth;
  /** How far the set goes: decides research and, for a long source, how many sections. */
  depth: ByteDepth;
  /** Cards the set is to have: the item's setting, or the count fit to its sources. Absent on a blueprint saved before cards. */
  cards?: number;
  research?: ResearchResult;
  structure?: StructurePlan;
}

export interface ApiFlashcardsEngineOptions {
  research?: (source: SourceEnvelope, services: EngineServices) => Promise<ResearchResult>;
  verify?: (set: CardSet, services: EngineServices, warningURLs: string[]) => Promise<URLVerificationReport>;
  /** Attempts per provider step before it counts as failed. */
  maxProviderAttempts?: number;
  sectionConcurrency?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_SECTION_CONCURRENCY = 4;
const WRITING_START = 0.3;
const WRITING_END = 0.75;

const defaultResearch: NonNullable<ApiFlashcardsEngineOptions["research"]> = (source, services) =>
  researchSource(source, services.provider, createOpenAlexProvider({ fetchImpl: services.fetch }));

const defaultVerify: NonNullable<ApiFlashcardsEngineOptions["verify"]> = (set, services, warningURLs) =>
  verifyPayloadURLs(set, { fetchImpl: services.sourceFetch ?? services.fetch, warningURLs });

export class ApiFlashcardsEngine implements OutputEngine<FlashcardSettings, ApiFlashcardsBlueprint, CardSet> {
  readonly type = "flashcards";
  readonly schemaVersion = CARD_SET_SCHEMA_VERSION;

  constructor(private readonly options: ApiFlashcardsEngineOptions = {}) {}

  async plan(ctx: EngineContext<FlashcardSettings>): Promise<ApiFlashcardsBlueprint> {
    const source = mergeNodeSources(ctx.sources);
    const requestedDepth = requestedDepthOf(ctx.node.settings);
    const depth = decideDepth(requestedDepth, source);
    const item = itemEvidence(ctx);
    // A title and channel are nothing to make cards from: no set, rather than one that stands in for the source.
    if (depth === "saveOnly" || item.passages.length === 0) {
      throw new PipelineError("Flashcards need source text to be made from; this item has none that could be read.", "NO_SOURCE_TEXT");
    }
    const cards = targetCards(ctx, item);
    const long = isLong(item.passages);
    let research: ResearchResult | undefined;
    if (depthRank(depth) >= depthRank("medium")) {
      await ctx.services.progress({ stage: "researching", progress: 0.05 });
      // Research reads a spread of a long source, never all of it.
      const read = long ? { ...source, text: spread(item.passages, WHOLE_READ_CHARS).map((passage) => passage.text).join("\n\n") } : source;
      research = await (this.options.research ?? defaultResearch)(read, ctx.services);
    }

    await ctx.services.progress({ stage: "structuring", progress: 0.15 });
    const target = cardTarget(ctx, cards);
    // A section-less plan is junk model output, not a valid "nothing to
    // say": it is retried like a transient failure.
    const structure = await withRetry(async () => {
      const response = await ctx.services.provider.generateJSON<unknown>({
        systemPrompt: buildDeliverySystemPrompt(),
        userPrompt: buildStructurePrompt(source, depth, target, research, ctx.node.settings.exemplarSummaries, promptContext(ctx), long ? mapEvidence(item) : item),
        task: "planning",
        depth,
      });
      const candidate = normalizeStructurePlan(response, source);
      if (candidate.sections.length === 0) throw new PipelineError("Structure plan contains no sections", "EMPTY_STRUCTURE");
      return long ? assignSections(candidate, item.passages) : withoutRanges(candidate);
    }, this.retryOptions());
    return { requestedDepth, depth, cards, ...(research ? { research } : {}), structure };
  }

  async generate(ctx: EngineContext<FlashcardSettings>, blueprint: ApiFlashcardsBlueprint): Promise<EngineOutput<CardSet>> {
    const blueprintIssue = checkBlueprint(blueprint);
    if (blueprintIssue) throw new PipelineError(`Saved blueprint is unusable: ${blueprintIssue}`, "INVALID_BLUEPRINT");
    const source = mergeNodeSources(ctx.sources);
    const item = itemEvidence(ctx);
    const plan = blueprint.structure!;
    const sections = await this.writeSections(ctx, source, blueprint, plan, item);
    const set = withSizeNote(buildSetFromSections(source, plan, sections, item), ctx.node.settings.cards);
    await ctx.services.progress({ stage: "verifying", progress: WRITING_END });
    return setOutput(set, ctx, source);
  }

  async validate(ctx: EngineContext<FlashcardSettings>, output: EngineOutput<CardSet>, blueprint: ApiFlashcardsBlueprint): Promise<ValidationReport> {
    const source = mergeNodeSources(ctx.sources);
    const local = validateCandidate(output.payload, allowedEvidenceURLs(source, blueprint.research), itemEvidence(ctx), rulesOf(ctx));
    const warnings = local.warnings.map((entry) => schemaIssue(entry, "warning"));
    if (local.errors.length > 0) return report([...local.errors.map((entry) => schemaIssue(entry, "error")), ...warnings]);
    // Network checks only for a set that is otherwise sound.
    const warningURLs = source.originalURL ? [source.originalURL] : [];
    const verification = await (this.options.verify ?? defaultVerify)(output.payload, ctx.services, warningURLs);
    return report([...verificationIssues(verification), ...warnings]);
  }

  /**
   * Repairs only the cards that failed, one small call per card, several at a
   * time, so how large a set is never decides whether its repair fits in one
   * provider call. Every other card is kept as it is. A repaired card keeps
   * its id (a card split in two keeps it on the first). A card whose repair
   * call fails stays as it was and the next validation reports it again.
   */
  async repair(
    ctx: EngineContext<FlashcardSettings>,
    output: EngineOutput<CardSet>,
    validation: ValidationReport,
    blueprint: ApiFlashcardsBlueprint,
  ): Promise<EngineOutput<CardSet>> {
    const source = mergeNodeSources(ctx.sources);
    const item = itemEvidence(ctx);
    const current = output.payload;
    const { byCard, rest } = errorsByCard(validation.issues, current);
    const kinds = allowedKinds(ctx);
    await ctx.services.progress({ stage: "repairing", progress: WRITING_END });

    const replaced = new Map<number, Card[]>();
    const failing = [...byCard.entries()];
    const concurrency = Math.max(1, this.options.sectionConcurrency ?? DEFAULT_SECTION_CONCURRENCY);
    for (let start = 0; start < failing.length; start += concurrency) {
      ctx.services.signal?.throwIfAborted();
      await Promise.all(
        failing.slice(start, start + concurrency).map(async ([index, errors]) => {
          const card = current.cards[index];
          try {
            const response = await withRetry(
              () =>
                ctx.services.provider.generateJSON<unknown>({
                  systemPrompt: buildDeliverySystemPrompt(),
                  userPrompt: buildCardRepairPrompt(cardForPrompt(card, item), errors, source, kinds, { passages: passagesForCard(card, item, blueprint.structure), sources: item.sources }, {
                    ...(card.section ? { section: card.section } : {}),
                    ...neighbours(current.cards, index),
                  }),
                  task: "repair",
                  depth: blueprint.depth,
                }),
              this.retryOptions(),
            );
            const cards = repairedCards(response, card);
            if (cards.length > 0) replaced.set(index, cards);
          } catch (error) {
            if (ctx.services.signal?.aborted) throw error;
          }
        }),
      );
    }

    // Errors on the set itself (its title, subtitle) are filled from the plan and the source, with no model.
    const header = rest.length > 0 ? headerFrom(blueprint.structure, source) : {};
    let set = withSizeNote(
      prepareSet({ ...current, ...header, cards: current.cards.flatMap((card, index) => replaced.get(index) ?? [card]) }, source, item, current.id),
      ctx.node.settings.cards,
    );

    // When the only errors the model left are media URLs that cannot be
    // verified, drop exactly those blocks rather than fail a set whose text
    // is sound. No model round can make an unharvested asset exist.
    const allowed = allowedEvidenceURLs(source, blueprint.research);
    const remaining = validateCandidate(set, allowed, item, rulesOf(ctx));
    const salvaged = remaining.errors.length === 0 ? undefined : salvageUnverifiableMedia(set, remaining.errors);
    if (salvaged && validateCandidate(salvaged.set, allowed, item, rulesOf(ctx)).errors.length === 0) set = salvaged.set;
    return setOutput(set, ctx, source);
  }

  private async writeSections(
    ctx: EngineContext<FlashcardSettings>,
    source: SourceEnvelope,
    blueprint: ApiFlashcardsBlueprint,
    plan: StructurePlan,
    item: ItemEvidence,
  ): Promise<SectionDraft[]> {
    const total = plan.sections.length;
    const concurrency = Math.max(1, Math.min(this.options.sectionConcurrency ?? DEFAULT_SECTION_CONCURRENCY, total));
    const drafts = new Array<SectionDraft | undefined>(total).fill(undefined);
    const failures: Array<{ index: number; error: unknown }> = [];
    const target = cardTarget(ctx, blueprint.cards ?? targetCards(ctx, item));
    const shares = sectionShares(plan, target.cards, item);
    // Progress counts finished sections, not their order, so it never goes back.
    let completed = 0;
    const reportWriting = () =>
      ctx.services.progress({ stage: "writing", progress: WRITING_START + (WRITING_END - WRITING_START) * (completed / total) });

    await reportWriting();
    for (let start = 0; start < total; start += concurrency) {
      ctx.services.signal?.throwIfAborted();
      const batch = plan.sections.slice(start, start + concurrency);
      await Promise.all(
        batch.map(async (section, offset) => {
          const index = start + offset;
          const key = `section:${section.id}`;
          const kept = readSectionDraft(ctx.services.checkpoint?.get(key), section.id);
          if (kept) {
            drafts[index] = kept;
            completed += 1;
            await reportWriting();
            return;
          }
          try {
            const response = await withRetry(
              () =>
                ctx.services.provider.generateJSON<unknown>({
                  systemPrompt: buildDeliverySystemPrompt(),
                  userPrompt: buildSectionPrompt(
                    source,
                    plan,
                    section.id,
                    { ...target, section: shares[index] },
                    blueprint.research,
                    ctx.node.settings.exemplarSummaries,
                    promptContext(ctx),
                    sectionEvidence(section, item),
                  ),
                  task: "section",
                  depth: blueprint.depth,
                }),
              this.retryOptions(),
            );
            drafts[index] = normalizeSectionDraft(response, section, item);
            // Only a written section is kept; a fallback is tried again next attempt.
            await ctx.services.checkpoint?.put(key, drafts[index] as unknown as JsonValue);
          } catch (error) {
            if (ctx.services.signal?.aborted) throw error;
            // One failed section does not kill the set; it gets a fallback card.
            failures.push({ index, error });
          }
          completed += 1;
          await reportWriting();
        }),
      );
    }
    if (failures.length === total) {
      const first = failures[0]?.error;
      const detail = first instanceof Error ? ` First failure: ${first.message}` : "";
      throw new PipelineError(`All ${total} section(s) failed to generate.${detail}`, "EMPTY_STRUCTURE");
    }
    return drafts.map((draft, index) => draft ?? fallbackSectionDraft(plan.sections[index]));
  }

  private retryOptions() {
    return {
      maxAttempts: this.options.maxProviderAttempts,
      sleep: this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    };
  }
}

/** How many cards the item asks for: its setting, or a count fit to the size of its passages. */
function targetCards(ctx: EngineContext<FlashcardSettings>, item: ItemEvidence): number {
  return ctx.node.settings.cards > 0 ? ctx.node.settings.cards : Math.max(1, fitCardCount(charsOf(item.passages)));
}

/** The kinds this item takes, registered ones only; every kind when the setting names none. */
function allowedKinds(ctx: EngineContext<FlashcardSettings>): string[] {
  const chosen = (ctx.node.settings.kinds ?? []).filter((id) => cardKinds.get(id));
  return chosen.length > 0 ? chosen : cardKinds.ids();
}

function rulesOf(ctx: EngineContext<FlashcardSettings>): CardSetRules {
  return { allowedKinds: allowedKinds(ctx) };
}

function cardTarget(ctx: EngineContext<FlashcardSettings>, cards: number): CardTarget {
  return { cards, asked: ctx.node.settings.cards > 0, kinds: allowedKinds(ctx) };
}

/**
 * About how many of the set's cards each section holds: an even share for a
 * short item, where every section reads everything, and a share by how much
 * of the source a section covers for a long one. At least one each.
 */
export function sectionShares(plan: StructurePlan, cards: number, item: ItemEvidence): number[] {
  const size = new Map(item.passages.map((passage) => [passage.id, passage.text.length]));
  const weights = plan.sections.map((section) => (section.passages?.length ? section.passages.reduce((sum, id) => sum + (size.get(id) ?? 0), 0) : 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return plan.sections.map((_, index) => Math.max(1, Math.round(total > 0 ? (cards * weights[index]) / total : cards / plan.sections.length)));
}

/**
 * The set's own words on its size when the person asked for a number and it
 * came out clearly different; none otherwise (a count fit to the sources is
 * a guess, never a promise).
 */
function withSizeNote(set: CardSet, asked: number): CardSet {
  const { sizeNote: _old, ...rest } = set;
  const made = set.cards.length;
  if (asked <= 0 || !offPlan(made, asked)) return rest;
  const note =
    made < asked
      ? `You asked for ${asked} cards; the sources held enough for ${made}.`
      : `You asked for ${asked} cards; the sources held more worth remembering, so the set has ${made}.`;
  return { ...rest, sizeNote: note };
}

/** A section an earlier attempt wrote, when the checkpoint holds one for this section. */
function readSectionDraft(value: JsonValue | undefined, sectionID: string): SectionDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.sectionID !== sectionID || !Array.isArray(value.cards) || value.cards.length === 0) return undefined;
  return value as unknown as SectionDraft;
}

type RepairError = { path: string; code: string; message: string };

/**
 * Validation errors by the card they are in, with paths made relative to the
 * card. A URL that failed verification belongs to every card that uses it.
 * Errors on no card (the set's own fields) are `rest`.
 */
export function errorsByCard(issues: ValidationIssue[], set: CardSet): { byCard: Map<number, RepairError[]>; rest: RepairError[] } {
  const byCard = new Map<number, RepairError[]>();
  const rest: RepairError[] = [];
  const add = (index: number, error: RepairError) => byCard.set(index, [...(byCard.get(index) ?? []), error]);
  for (const issue of issues) {
    if (issue.severity !== "error") continue;
    const at = /^\$\.cards\[(\d+)\](.*)$/.exec(issue.path);
    if (at && Number(at[1]) < set.cards.length) {
      add(Number(at[1]), { path: at[2] ? at[2].replace(/^\./, "") : "(the card)", code: issue.code, message: issue.message });
      continue;
    }
    if (!issue.path.startsWith("$")) {
      const needle = JSON.stringify(issue.path);
      const users = set.cards.map((card, index) => (JSON.stringify(cardBlocks(card)).includes(needle) ? index : -1)).filter((index) => index >= 0);
      if (users.length > 0) {
        for (const index of users) add(index, { path: "(a link or media url)", code: issue.code, message: `${issue.path}: ${issue.message}` });
        continue;
      }
    }
    rest.push({ path: issue.path, code: issue.code, message: issue.message });
  }
  return { byCard, rest };
}

/** A card as the writer saw cards: cites by passage label; the engine's own media cites are left out. */
function cardForPrompt(card: Card, item: ItemEvidence): Record<string, unknown> {
  const cites = card.cites
    .filter((cite) => cite.spot !== "image" && cite.spot !== "moment")
    .map((cite) => {
      const passage = passageOf(cite, item.passages);
      return passage
        ? { passage: passage.label, ...(cite.quote ? { quote: cite.quote } : {}), ...(cite.block !== undefined ? { block: cite.block } : {}) }
        : cite;
    });
  return { kind: card.kind, front: card.front, ...(card.back ? { back: card.back } : {}), cites };
}

/** Most characters of passages a card repair reads when the card cites none. */
const UNCITED_REPAIR_CHARS = 12_000;

/**
 * The passages a card cites; when it cites none, a spread of its section's
 * range (or of the whole item) up to a bound, so it can cite something.
 */
function passagesForCard(card: Card, item: ItemEvidence, plan: StructurePlan | undefined): Passage[] {
  const cited = new Map<string, Passage>();
  for (const cite of card.cites) {
    const passage = passageOf(cite, item.passages);
    if (passage) cited.set(passage.id, passage);
  }
  if (cited.size > 0) return [...cited.values()];
  const section = plan?.sections.find((candidate) => candidate.title === card.section && candidate.passages?.length);
  return spread(section ? passagesById(section.passages!, item.passages) : item.passages, UNCITED_REPAIR_CHARS);
}

/** What the planner of a long item reads: a map of its passages instead of them. */
function mapEvidence(item: ItemEvidence): ItemEvidence & PromptEvidence {
  return { ...item, map: { text: renderMap(item.passages), passages: item.passages.length, chars: charsOf(item.passages) } };
}

/**
 * What one section's writer reads: its own range, whole when it fits a call
 * and an even spread of it when not; every passage when the plan gave the
 * section no range (a short item). Cites still resolve against every passage
 * of the item, so labels mean the same in every step.
 */
function sectionEvidence(section: StructureSection, item: ItemEvidence): ItemEvidence & PromptEvidence {
  const covered = section.passages?.length ? passagesById(section.passages, item.passages) : item.passages;
  const shown = spread(covered, WHOLE_READ_CHARS);
  const note = spreadNote(shown, covered);
  return { ...item, passages: shown, all: item.passages, ...(note ? { note } : {}) };
}

function passagesById(ids: string[], passages: Passage[]): Passage[] {
  const wanted = new Set(ids);
  return passages.filter((passage) => wanted.has(passage.id));
}

/** A short item's plan: every section reads everything, so a range the planner wrote anyway is dropped. */
function withoutRanges(plan: StructurePlan): StructurePlan {
  return { ...plan, sections: plan.sections.map(({ range: _range, passages: _passages, ...section }) => section) };
}

/**
 * A long item's plan with each section's passages, so that together the
 * sections cover every passage, in order (engine/docs/long-sources.md):
 * a section keeps the range it named, less what an earlier section already
 * took; sections that named none share what is left, in order; and passages
 * no section covers join the section next to them.
 */
export function assignSections(plan: StructurePlan, passages: Passage[]): StructurePlan {
  const owner = new Array<number>(passages.length).fill(-1);
  const position = new Map(passages.map((passage, index) => [passage.id, index]));
  plan.sections.forEach((section, sectionIndex) => {
    for (const passage of passagesNamed(section.range, passages) ?? []) {
      const index = position.get(passage.id)!;
      if (owner[index] < 0) owner[index] = sectionIndex;
    }
  });

  // Sections with no range share the passages no one took, in runs of about equal size, in order.
  const unnamed = plan.sections.map((_, index) => index).filter((index) => !owner.includes(index));
  const free = owner.map((value, index) => (value < 0 ? index : -1)).filter((index) => index >= 0);
  if (unnamed.length > 0 && free.length > 0) {
    const total = free.reduce((sum, index) => sum + passages[index].text.length, 0);
    let used = 0;
    for (const index of free) {
      owner[index] = unnamed[Math.min(unnamed.length - 1, Math.floor((used / total) * unnamed.length))];
      used += passages[index].text.length;
    }
  }

  // Whatever is still uncovered joins the nearest section before it (or after it, at the start).
  for (let index = 0; index < owner.length; index += 1) {
    if (owner[index] >= 0) continue;
    const before = owner.slice(0, index).reverse().find((value) => value >= 0);
    owner[index] = before ?? owner.find((value) => value >= 0) ?? 0;
  }

  return {
    ...plan,
    sections: plan.sections.map(({ range: _range, ...section }, sectionIndex) => {
      const ids = passages.filter((_, index) => owner[index] === sectionIndex).map((passage) => passage.id);
      return { ...section, passages: ids };
    }),
  };
}

/** What the cards on either side ask, so a repaired card still fits in its run. */
function neighbours(cards: Card[], index: number): { before?: string; after?: string } {
  const gist = (card: Card | undefined) => {
    for (const block of card?.front ?? []) {
      const record = block as unknown as Record<string, unknown>;
      const words = [record.text, record.question, record.prompt, record.term].find((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (words) return words.replace(/\s+/g, " ").slice(0, 200);
    }
    return undefined;
  };
  const before = gist(cards[index - 1]);
  const after = gist(cards[index + 1]);
  return { ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

/**
 * The cards a repair answer gives for one card: `{ cards }`, a list, or one
 * card. They keep the card's section, and the first keeps its id, so the
 * person's progress on it stays; the rest get new ids when the set is prepared.
 */
function repairedCards(response: unknown, original: Card): Card[] {
  // A writer sometimes wraps its answer in one more object ({ "card": ... }).
  const outer = isRecord(response) ? response : undefined;
  const record = outer && isRecord(outer.card) ? outer.card : outer;
  const list = Array.isArray(response) ? response : Array.isArray(record?.cards) ? record.cards : record && Array.isArray(record.front) ? [record] : [];
  return list
    .filter((entry): entry is Record<string, unknown> => isRecord(entry) && Array.isArray(entry.front) && entry.front.length > 0)
    .map((entry, index) => ({
      id: index === 0 ? original.id : "",
      kind: typeof entry.kind === "string" && entry.kind ? entry.kind : original.kind,
      ...(original.section ? { section: original.section } : {}),
      front: entry.front as Card["front"],
      ...(Array.isArray(entry.back) && entry.back.length > 0 ? { back: entry.back as Card["front"] } : {}),
      cites: (Array.isArray(entry.cites) ? entry.cites : []) as Card["cites"],
    }));
}

/** The set's own fields from the plan, or from the source when there is no plan. */
function headerFrom(plan: StructurePlan | undefined, source: SourceEnvelope): Pick<CardSet, "title" | "subtitle"> {
  const metadata = buildMetadataFromSource(source, inferSourceKind(source));
  return { title: plan?.title || metadata.title, subtitle: plan?.subtitle || metadata.subtitle };
}

function promptContext(ctx: EngineContext<FlashcardSettings>): NodePromptContext {
  return { brief: ctx.node.prompt, assumes: ctx.assumes };
}

function checkBlueprint(blueprint: ApiFlashcardsBlueprint): string | undefined {
  if (!blueprint || typeof blueprint !== "object") return "not an object";
  if (!(BYTE_DEPTHS as readonly string[]).includes(blueprint.depth)) return `unknown depth "${String(blueprint.depth)}"`;
  if (!blueprint.structure?.sections?.length) return "no sections";
  return undefined;
}

/** The item's passages, labelled P1, P2, ... in a fixed order, and its sources. */
function itemEvidence(ctx: EngineContext<FlashcardSettings>): ItemEvidence {
  return { passages: buildPassages(ctx.sources), sources: ctx.sources };
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

/** A schema error as an issue; what was expected and what was found go into the message, so a repair knows the allowed values. */
function schemaIssue(error: SchemaError, severity: ValidationIssue["severity"]): ValidationIssue {
  const detail = [error.expected ? `expected ${error.expected}` : "", error.actual ? `got ${error.actual}` : ""].filter(Boolean).join(", ");
  return { path: error.path, code: error.code, message: detail ? `${error.message} (${detail})` : error.message, severity };
}
