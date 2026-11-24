/**
 * The flashcards format's registry entry: descriptor, settings and cost
 * estimate. A set of flashcards is cards to swipe and flip, each doing one
 * job, brought back over days until they stick (engine/docs/flashcards.md).
 *
 * The format was called "byte" (bits read one screen at a time) until Nov
 * 2026; `byte` and its own old ids `bits` and `read` are aliases, so stored
 * rows, plan items and routes made with them resolve here, and their stored
 * payloads are served as cards (cards/upgrade.ts).
 */
import { depthRank, type ByteDepth, type GenerationDepth } from "../../cards/blocks";
import { CARD_SET_SCHEMA_VERSION, type CardSet } from "../../cards/contract";
import { cardKinds, type CardKindRegistry } from "../../cards/kinds";
import { toCardSet } from "../../cards/upgrade";
import type {
  CostEstimate,
  CostEstimateInput,
  FormatDefinition,
  FormatDescriptor,
  Glimpse,
  SettingField,
  SettingsResult,
  ValidationIssue,
} from "../../studio/types";
import type { ModelPrice } from "../../types/provider";
import { plainLine } from "../../studio/glimpse";
import { countSize } from "../../studio/size";
import { flashcardsAnchor } from "./anchor";
import { ApiFlashcardsEngine, type ApiFlashcardsEngineOptions } from "./engine";
import { depthForTextLength, generationDepthToByteDepth } from "./pipeline";
import { LONG_SECTION_CHARS } from "./prompts";
import { MAP_CHARS, WHOLE_READ_CHARS } from "../../sources/reading";
import { MakerRegistry, MakersEngine, parseMakerSetting, OPEN_PICK, type ItemMaker, type MadeBlueprint } from "../makers";
import { AGENT_SETTING_KEYS, readAgentFields } from "../agent-fields";
import { MAX_CARDS, fitCardCount, requestedDepthOf, type FlashcardSettings } from "./settings";

/** August's bounds on exemplar summaries. */
const MAX_EXEMPLARS = 12;
const MAX_EXEMPLAR_CHARS = 4_000;
/** August's repair budget: two model rounds. */
export const FLASHCARDS_MAX_REPAIR_ROUNDS = 2;

export interface FlashcardsDefinitionOptions extends ApiFlashcardsEngineOptions {
  /** Price of the model that writes the output; without one the estimate is tokens only. */
  price?: ModelPrice;
  /** False when no model API key is set here, so Open Sourcebook's own writer is not offered. Offered when absent. */
  api?: boolean;
  /** Other makers (the person's own agent), listed before Open Sourcebook's own writer. */
  makers?: ItemMaker<FlashcardSettings, unknown, CardSet>[];
  /** The maker "auto" prefers when it can make things now. */
  defaultMaker?: string;
  /** The kinds of card; the ones Open Sourcebook ships when absent. */
  kinds?: CardKindRegistry;
}

export type FlashcardsDefinition = FormatDefinition<FlashcardSettings, MadeBlueprint, CardSet>;

/** Open Sourcebook's own writer, calling a model with the API key set on this engine. Stored on jobs as its id. */
export const API_FLASHCARDS_MAKER_ID = "api";

export function defaultFlashcardSettings(kinds: CardKindRegistry = cardKinds): FlashcardSettings {
  return { cards: 0, kinds: kinds.ids(), exemplarSummaries: [] };
}

/** What a set may set; `parseFlashcardSettings` checks the values. */
export function flashcardSettingFields(kinds: CardKindRegistry = cardKinds): SettingField[] {
  return [
    {
      key: "cards",
      label: "Cards",
      help: "How many cards the set has, which is how far it goes: a few for one idea, dozens for a chapter, hundreds over a course.",
      kind: "number",
      min: 0,
      max: MAX_CARDS,
      step: 1,
      specialValues: [{ value: 0, means: "auto", label: "Fit to the sources", description: "Counted when it is made: as many cards as the sources hold things worth remembering." }],
    },
    {
      key: "kinds",
      label: "Kinds of card",
      help: "Which kinds of card it may use; the maker picks among them for each thing to remember.",
      kind: "choices",
      // Every registered kind offers itself, in its own words.
      options: kinds.options(),
      minItems: 1,
      maxItems: kinds.ids().length,
    },
    {
      key: "exemplarSummaries",
      label: "Style examples",
      help: "Earlier summaries the writing should sound like.",
      kind: "textList",
      maxItems: MAX_EXEMPLARS,
      maxLength: MAX_EXEMPLAR_CHARS,
      hidden: true,
    },
  ];
}

export function flashcardsDescriptor(makers?: MakerRegistry<FlashcardSettings, CardSet>, kinds: CardKindRegistry = cardKinds): FormatDescriptor {
  const pick = [...(makers?.settingFields() ?? []), ...(makers?.agentFields("chat") ?? [])];
  const defaults = defaultFlashcardSettings(kinds);
  return {
    id: "flashcards",
    label: "flashcards",
    plural: "sets of flashcards",
    singular: "set of flashcards",
    colorSlot: 2,
    icon: "feed",
    // Stored rows and plan items made when this format was the byte (and before, `bits` and `read`), and the old declared id `cards`.
    aliases: ["byte", "bits", "read", "cards"],
    about:
      "Cards to swipe and flip, each doing one job: a question, term or cue on the front and the answer on the back, a sentence with its key part hidden, a comparison, steps, a formula, a worked example, a picture to name, or a question that checks itself. The person marks each card got it or not yet, and missed cards come back in the same sitting and later ones on later days, until they stick. Suits what should be remembered and recalled without looking: terms and definitions, facts, formulas, steps, distinctions; after a video or a reading, and before a quiz. Its number of cards sets how far it goes, from a handful on one idea to hundreds over a course.",
    blurb: "cards to swipe and flip, brought back until they stick",
    reports: [
      { metric: "learned", label: "Cards learned", about: "cards got right on reviews spread over days", unit: "count" },
      { metric: "got", label: "Cards got", about: "cards marked got it, or answered right, the last time through", unit: "count" },
      { metric: "missed", label: "Cards not yet", about: "cards marked not yet, or answered wrong, the last time through", unit: "count" },
    ],
    settings: [...flashcardSettingFields(kinds), ...pick],
    defaults: { ...defaults, kinds: [...defaults.kinds], ...(pick.some((field) => field.key === "maker") ? { maker: OPEN_PICK } : {}) },
  };
}

/** The makers of sets here: the ones given (the person's agent), then Open Sourcebook's own writer when a key is set. */
export function flashcardMakers(options: FlashcardsDefinitionOptions = {}): MakerRegistry<FlashcardSettings, CardSet> {
  const { price, api = true, makers = [], defaultMaker, kinds: _kinds, ...engineOptions } = options;
  const registry = new MakerRegistry<FlashcardSettings, CardSet>("set of flashcards", { ...(defaultMaker ? { defaultId: defaultMaker } : {}), legacy: API_FLASHCARDS_MAKER_ID });
  for (const maker of makers) registry.register(maker);
  if (api) {
    registry.register({
      id: API_FLASHCARDS_MAKER_ID,
      label: "Model API key",
      description: "Open Sourcebook writes it with the model API key set on this engine: it plans the set, writes its cards and repairs what fails its checks. Each call is paid on that key.",
      engine: new ApiFlashcardsEngine(engineOptions) as ItemMaker<FlashcardSettings, unknown, CardSet>["engine"],
      maxRepairRounds: FLASHCARDS_MAX_REPAIR_ROUNDS,
      estimateCost: (input) => estimateFlashcardsCost(input, price),
    });
  }
  return registry;
}

export function createFlashcardsDefinition(options: FlashcardsDefinitionOptions = {}): FlashcardsDefinition {
  const kinds = options.kinds ?? cardKinds;
  const makers = flashcardMakers(options);
  const engine = new MakersEngine<FlashcardSettings, CardSet>("flashcards", CARD_SET_SCHEMA_VERSION, makers);
  return {
    descriptor: flashcardsDescriptor(makers, kinds),
    engine,
    maxRepairRounds: Math.max(0, ...makers.list().map((maker) => maker.maxRepairRounds)),
    repairRoundsFor: (blueprint) => engine.repairRounds(blueprint as MadeBlueprint),
    parseSettings: (raw) => parseFlashcardSettings(raw, kinds),
    itemIssues: (settings) => makers.issues(settings),
    settle: (settings, input) => ({ ...makers.settle(settings), ...makers.settleAgent("flashcards", settings, input.picks), ...(settings.cards === 0 && input.sourceChars > 0 ? { cards: fitCardCount(input.sourceChars) } : {}) }),
    describe: (settings) => [makers.labelFor(settings) ?? "No maker set up here", settings.cards > 0 ? `${settings.cards} card${settings.cards === 1 ? "" : "s"}` : "Cards fit the sources"],
    describeMade: (set, settings) => {
      const cards = Array.isArray(set?.cards) ? set.cards.length : 0;
      return [makers.labelFor(settings) ?? "Made", `${cards} card${cards === 1 ? "" : "s"}`];
    },
    estimateCost: (input) => {
      const resolved = makers.resolve(input.settings);
      return "maker" in resolved ? resolved.maker.estimateCost(input) : { unpriced: true, basis: "nothing here can make a set of flashcards" };
    },
    upgrade: upgradeStoredSet,
    glimpse: flashcardsGlimpse,
    size: (set) => countSize(Array.isArray(set?.cards) ? set.cards.length : 0, "card", "cards"),
    describeAnchor: flashcardsAnchor,
  };
}

/** A set's glimpse: the first words its first card shows. */
export function flashcardsGlimpse(set: CardSet): Glimpse | undefined {
  const blocks = Array.isArray(set?.cards) ? (set.cards[0]?.front ?? []) : [];
  const said = blocks.find((block) => "text" in block && typeof block.text === "string" && block.type !== "kicker") as { text: string } | undefined;
  const text = plainLine(said?.text?.replace(/\[\[([^\[\]]+)\]\]/g, "…"));
  return text ? { text } : undefined;
}

/**
 * An output stored before cards (a version 2 byte, a version 1 page) is
 * served as a set of cards (engine/docs/flashcards.md, "Old outputs").
 * Anything else is left as stored.
 */
export function upgradeStoredSet(payload: unknown, schemaVersion: number) {
  if (schemaVersion >= CARD_SET_SCHEMA_VERSION) return undefined;
  const set = toCardSet(payload, schemaVersion);
  return set ? { payload: set, schemaVersion: CARD_SET_SCHEMA_VERSION } : undefined;
}

/** Old items' lengths as a count of cards, so a plan made when this was a byte keeps its size. */
const LEGACY_DEPTH_CARDS: Record<string, number> = { auto: 0, saveOnly: 0, light: 8, standard: 20, deep: 40 };

export function parseFlashcardSettings(raw: unknown, kinds: CardKindRegistry = cardKinds): SettingsResult<FlashcardSettings> {
  const defaults = defaultFlashcardSettings(kinds);
  if (raw === undefined || raw === null) return { ok: true, settings: defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [issue("$", "type", "Settings must be an object")] };
  }
  const record = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!["cards", "kinds", "exemplarSummaries", "maker", "depth", ...AGENT_SETTING_KEYS].includes(key)) issues.push(issue(`$.${key}`, "unknown_key", `Unknown setting "${key}"`));
  }

  let cards = defaults.cards;
  if (record.cards !== undefined) {
    if (typeof record.cards === "number" && Number.isInteger(record.cards) && record.cards >= 0 && record.cards <= MAX_CARDS) cards = record.cards;
    else issues.push(issue("$.cards", "range", `cards must be a whole number from 0 to ${MAX_CARDS}`));
  } else if (typeof record.depth === "string" && record.depth in LEGACY_DEPTH_CARDS) {
    // A length stored when this format was the byte.
    cards = LEGACY_DEPTH_CARDS[record.depth]!;
  }

  let chosen = defaults.kinds;
  if (record.kinds !== undefined) {
    if (!Array.isArray(record.kinds) || record.kinds.length === 0 || record.kinds.some((kind) => typeof kind !== "string")) {
      issues.push(issue("$.kinds", "type", "kinds must be a list of at least one kind of card"));
    } else {
      const unknown = (record.kinds as string[]).filter((kind) => !kinds.get(kind));
      if (unknown.length > 0) issues.push(issue("$.kinds", "enum", `Unknown kind${unknown.length === 1 ? "" : "s"} of card: ${unknown.join(", ")}; the kinds are ${kinds.ids().join(", ")}`));
      else chosen = [...new Set(record.kinds as string[])];
    }
  }

  const exemplarSummaries: string[] = [];
  if (record.exemplarSummaries !== undefined) {
    if (!Array.isArray(record.exemplarSummaries)) {
      issues.push(issue("$.exemplarSummaries", "type", "exemplarSummaries must be an array of strings"));
    } else if (record.exemplarSummaries.length > MAX_EXEMPLARS) {
      issues.push(issue("$.exemplarSummaries", "max_items", `At most ${MAX_EXEMPLARS} exemplar summaries`));
    } else {
      record.exemplarSummaries.forEach((entry, index) => {
        if (typeof entry !== "string") issues.push(issue(`$.exemplarSummaries[${index}]`, "type", "Must be a string"));
        else if (entry.length > MAX_EXEMPLAR_CHARS) {
          issues.push(issue(`$.exemplarSummaries[${index}]`, "max_length", `At most ${MAX_EXEMPLAR_CHARS} characters`));
        } else if (entry.trim()) exemplarSummaries.push(entry.trim());
      });
    }
  }

  // A maker is checked by shape only: one not set up here now is said before Start and when the item runs.
  const maker = parseMakerSetting(record.maker);
  if (!maker.ok) issues.push(issue("$.maker", "format", maker.message));
  const agent = readAgentFields(record, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings: { cards, kinds: chosen, exemplarSummaries, ...(maker.ok && maker.maker ? { maker: maker.maker } : {}), ...agent } };
}

/**
 * Rough, before-the-fact cost of what the engine will read and write
 * (engine/docs/long-sources.md): the plan call reads every passage, or a map
 * of a long source; each section reads every passage, or for a long source
 * its own share of it, at most what one call reads; research reads at most
 * that much too; and one repair round. At deep depth and beyond a long source
 * gets a section per `LONG_SECTION_CHARS` of it, so a whole book is priced as
 * reading and teaching the whole book. The real number comes from the
 * usage log.
 */
export function estimateFlashcardsCost(input: CostEstimateInput<FlashcardSettings>, price: ModelPrice | undefined): CostEstimate {
  const depth = estimatedDepth(requestedDepthOf(input.settings), input.sourceChars);
  if (depth === "saveOnly" || input.sourceCount === 0) return { usd: 0, basis: "save only, no model calls" };

  const long = input.sourceChars > WHOLE_READ_CHARS;
  const base = SECTIONS_BY_DEPTH[depth];
  const share = LONG_SECTION_CHARS[depth];
  const sections = long && share ? Math.max(base, Math.ceil(input.sourceChars / share)) : base;
  const planChars = long ? MAP_CHARS : input.sourceChars;
  const sectionChars = long ? Math.min(WHOLE_READ_CHARS, input.sourceChars / sections) : input.sourceChars;
  const research = depthRank(depth) >= depthRank("medium") ? 1 : 0;
  const researchChars = Math.min(input.sourceChars, WHOLE_READ_CHARS);
  const repairs = Math.ceil(sections * REPAIRED_BITS_PER_SECTION);
  const calls = 1 + sections + research + repairs;
  const readChars = planChars + sections * sectionChars + research * researchChars;
  const tokensIn = Math.ceil(readChars / CHARS_PER_TOKEN) + (1 + sections + research) * PROMPT_OVERHEAD_TOKENS + repairs * REPAIR_INPUT_TOKENS;
  const tokensOut = PLAN_OUTPUT_TOKENS + sections * SECTION_OUTPUT_TOKENS + research * RESEARCH_OUTPUT_TOKENS + repairs * REPAIR_OUTPUT_TOKENS;
  const tokens = `~${formatThousands(tokensIn + tokensOut)} tokens`;
  const reads = long ? `, reads ${Math.round(Math.min(1, (sections * sectionChars) / input.sourceChars) * 100)}% of ${formatThousands(input.sourceChars)} characters` : "";
  return {
    ...(price ? { usd: round((tokensIn * price.inputPerMillion + tokensOut * price.outputPerMillion) / 1_000_000) } : { unpriced: true }),
    basis: `${depth} depth, ~${sections} section${sections === 1 ? "" : "s"}${reads}, ${calls} calls, ${tokens}${price ? "" : ", no model price set"}`,
  };
}

/*
 * Sizes per call, from the first real run (Nov 12, 2026, deepseek-v4-flash,
 * 24,000-character sources): a section call read about 11k tokens and wrote
 * 3k to 4.5k (output counts the model's thinking); a plan wrote 1.5k to 3.5k;
 * research about 1k to 2k. A light byte planned 5 sections, a medium one
 * about 8, a deep one about 13. These are typical shapes, not limits; the
 * planner decides the real numbers.
 */
const CHARS_PER_TOKEN = 4;
/** Guidance, bit rules and block catalog sent with every call. */
const PROMPT_OVERHEAD_TOKENS = 4_000;
const PLAN_OUTPUT_TOKENS = 2_500;
const SECTION_OUTPUT_TOKENS = 3_500;
const RESEARCH_OUTPUT_TOKENS = 1_500;
/** About one bit in two sections needs a repair call, each reading guidance and its own passages. */
const REPAIRED_BITS_PER_SECTION = 0.5;
const REPAIR_INPUT_TOKENS = 6_000;
const REPAIR_OUTPUT_TOKENS = 1_500;
/** Typical section counts at each depth, for the estimate only; the planner decides the real number. */
const SECTIONS_BY_DEPTH: Record<Exclude<ByteDepth, "saveOnly">, number> = {
  tiny: 1,
  light: 4,
  medium: 8,
  deep: 13,
  veryDeep: 18,
};

/** The depth the engine would pick, from size alone (the source's own cap is not known yet). */
function estimatedDepth(requested: GenerationDepth, sourceChars: number): ByteDepth {
  if (sourceChars === 0) return "saveOnly";
  return requested === "auto" ? depthForTextLength(sourceChars) : generationDepthToByteDepth(requested);
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

function formatThousands(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}
