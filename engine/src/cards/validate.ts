/**
 * Checks a set of flashcards (contract.ts, engine/docs/flashcards.md) without
 * the network or the sources: the set's fields; each card's kind, its sides'
 * blocks against the block schema, the blocks a card may not hold, at most
 * one main block and one screen per side, and what its kind needs (kinds.ts);
 * and the shape of every cite. Grounding against the item's passages and
 * evidence URLs is the engine's (it has the sources).
 */
import { isRecord } from "../net";
import { BYTE_TYPES, type SchemaError } from "./blocks";
import {
  BLOCKS_NOT_ON_A_CARD,
  CARD_SET_SCHEMA_VERSION,
  MAX_BLOCKS_PER_SIDE,
  SIDE_BUDGET,
  isFeatureBlock,
  sideCost,
  type Card,
  type CardSet,
} from "./contract";
import { cardKinds, type CardKindRegistry } from "./kinds";
import { validateBlock, type BlockRules } from "./schema";

/** A flashcards block never sits on a card (the card is the card), so its bounds only matter for older pages. */
const CARD_BLOCK_RULES: BlockRules = { minCards: 1, maxCards: 1 };

const SET_KEYS = new Set([
  "schemaVersion",
  "id",
  "title",
  "subtitle",
  "sourceKind",
  "sourceDomain",
  "author",
  "tags",
  "excerpt",
  "durationText",
  "cards",
  "sizeNote",
  "upgradedFrom",
]);
const CARD_KEYS = new Set(["id", "kind", "section", "front", "back", "cites"]);
const CITE_KEYS = new Set(["sourceId", "spot", "chunkId", "locator", "assetId", "quote", "block"]);
const LOCATOR_KEYS = new Set(["page", "endPage", "slide", "endSlide", "startMs", "endMs", "charStart", "charEnd", "cell"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;
const MAX_TAGS = 8;

export interface CardSetCheck {
  errors: SchemaError[];
  /** Never block delivery: an empty `cites` on a made card. */
  warnings: SchemaError[];
}

export interface CardSetRules {
  /** The kinds a card may be; every registered kind when absent. */
  kinds?: CardKindRegistry;
  /** The kind ids this item allows (its settings); every registered one when absent. */
  allowedKinds?: readonly string[];
}

export function validateCardSet(value: unknown, rules: CardSetRules = {}): CardSetCheck {
  const errors: SchemaError[] = [];
  const warnings: SchemaError[] = [];
  if (!isRecord(value)) {
    errors.push(error("$", "type", "The set must be a JSON object"));
    return { errors, warnings };
  }
  unknownKeys(value, SET_KEYS, "$", errors);
  if (value.schemaVersion !== CARD_SET_SCHEMA_VERSION) errors.push(error("$.schemaVersion", "enum", `schemaVersion must be ${CARD_SET_SCHEMA_VERSION}`));
  if (typeof value.id !== "string" || !UUID_PATTERN.test(value.id)) errors.push(error("$.id", "uuid", "id must be a UUID"));
  requiredString(value.title, "$.title", errors);
  requiredString(value.subtitle, "$.subtitle", errors);
  oneOf(value.sourceKind, BYTE_TYPES, "$.sourceKind", errors);
  for (const key of ["sourceDomain", "author", "excerpt", "durationText", "sizeNote"] as const) optionalString(value[key], `$.${key}`, errors);
  if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
    errors.push(error("$.tags", "type", "tags must be an array of strings"));
  } else if (value.tags.length > MAX_TAGS) {
    errors.push(error("$.tags", "max_items", `At most ${MAX_TAGS} tags`));
  }
  if (value.upgradedFrom !== undefined && !(Number.isInteger(value.upgradedFrom) && (value.upgradedFrom as number) >= 1)) {
    errors.push(error("$.upgradedFrom", "type", "upgradedFrom must be a positive integer"));
  }

  if (!Array.isArray(value.cards)) {
    errors.push(error("$.cards", "type", "cards must be an array"));
    return { errors, warnings };
  }
  if (value.cards.length === 0) errors.push(error("$.cards", "min_items", "A set has at least one card"));
  const ids = new Set<string>();
  value.cards.forEach((card, index) => validateCard(card, `$.cards[${index}]`, ids, errors, warnings, rules));
  return { errors, warnings };
}

export function isValidCardSet(value: unknown): value is CardSet {
  return validateCardSet(value).errors.length === 0;
}

/** One card on its own, as a maker's tool checks it before keeping it. */
export function validateCard(value: unknown, path: string, ids: Set<string>, errors: SchemaError[], warnings: SchemaError[], rules: CardSetRules = {}): void {
  if (!isRecord(value)) {
    errors.push(error(path, "type", "A card must be an object"));
    return;
  }
  unknownKeys(value, CARD_KEYS, path, errors);
  if (typeof value.id !== "string" || !value.id.trim()) {
    errors.push(error(`${path}.id`, "required", "A card needs an id"));
  } else if (ids.has(value.id)) {
    errors.push(error(`${path}.id`, "duplicate", `Card id "${value.id}" is used twice`));
  } else {
    ids.add(value.id);
  }
  const registry = rules.kinds ?? cardKinds;
  const kind = typeof value.kind === "string" ? registry.get(value.kind) : undefined;
  if (typeof value.kind !== "string" || !OPEN_NAME_PATTERN.test(value.kind)) {
    errors.push(error(`${path}.kind`, "type", `kind must be one of ${registry.ids().join(", ")}`));
  } else if (!kind) {
    errors.push(error(`${path}.kind`, "unknown_kind", `"${value.kind}" is not a kind of card; the kinds are ${registry.ids().join(", ")}`));
  } else if (rules.allowedKinds && !rules.allowedKinds.includes(kind.id)) {
    errors.push(error(`${path}.kind`, "kind_not_allowed", `This set takes only ${rules.allowedKinds.join(", ")} cards`));
  }
  optionalString(value.section, `${path}.section`, errors);

  const before = errors.length;
  validateSide(value.front, `${path}.front`, true, errors);
  if (value.back !== undefined) validateSide(value.back, `${path}.back`, false, errors);
  // What a kind needs only means something for sides that are themselves sound.
  if (kind && errors.length === before) {
    for (const problem of kind.check(value as unknown as Card)) errors.push(error(path, "kind_needs", problem));
  }

  if (!Array.isArray(value.cites)) {
    errors.push(error(`${path}.cites`, "type", "cites must be an array (empty when nothing is cited)"));
    return;
  }
  if (value.cites.length === 0 && kind?.mark !== "none") warnings.push(error(`${path}.cites`, "uncited_card", "This card cites nothing"));
  const blockCount = (Array.isArray(value.front) ? value.front.length : 0) + (Array.isArray(value.back) ? value.back.length : 0);
  value.cites.forEach((cite, index) => validateCite(cite, `${path}.cites[${index}]`, blockCount, errors));
}

function validateSide(value: unknown, path: string, required: boolean, errors: SchemaError[]): void {
  const side = path.endsWith(".front") ? "front" : "back";
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", `${side} must be an array of blocks`));
    return;
  }
  if ((required && value.length === 0) || value.length > MAX_BLOCKS_PER_SIDE) {
    errors.push(error(path, "range", `A card's ${side} holds ${required ? 1 : 0} to ${MAX_BLOCKS_PER_SIDE} blocks; one card does one job, so make another card for the rest`));
  }
  let blockErrors = 0;
  value.forEach((block, index) => {
    const blockPath = `${path}[${index}]`;
    const before = errors.length;
    if (isRecord(block) && typeof block.type === "string" && BLOCKS_NOT_ON_A_CARD.has(block.type)) {
      errors.push(error(`${blockPath}.type`, "not_on_a_card", notOnACard(block.type)));
    } else {
      validateBlock(block, blockPath, errors, 0, CARD_BLOCK_RULES);
    }
    blockErrors += errors.length - before;
  });
  if (blockErrors > 0) return;
  const features = value.filter((block) => isFeatureBlock(String(block.type)));
  if (features.length > 1) {
    errors.push(error(path, "too_many_features", `A side holds at most one media, chart, table or question block; this ${side} has ${features.length}. Make another card for the rest.`));
  }
  const cost = sideCost(value);
  if (cost > SIDE_BUDGET) {
    errors.push(error(path, "side_over_budget", `This ${side} costs ${cost} units and one screen holds ${SIDE_BUDGET}; a card does one job, so split it into two cards or say it shorter.`));
  }
}

function notOnACard(type: string): string {
  if (type === "flashcards") return "A card is already a flashcard: put the front on its front and the answer on its back";
  if (type === "reveal") return "A card already turns over: put what the reveal hides on the card's back";
  if (type === "hero") return "A hero block does not belong on a card; use a figure";
  return `A ${type} block does not belong on a card; leave it out`;
}

function validateCite(value: unknown, path: string, blockCount: number, errors: SchemaError[]): void {
  if (!isRecord(value)) {
    errors.push(error(path, "type", "A cite must be an object"));
    return;
  }
  unknownKeys(value, CITE_KEYS, path, errors);
  requiredString(value.sourceId, `${path}.sourceId`, errors);
  if (typeof value.spot !== "string" || !OPEN_NAME_PATTERN.test(value.spot)) {
    errors.push(error(`${path}.spot`, "type", "spot must be a name such as passage, image or moment"));
  }
  optionalString(value.chunkId, `${path}.chunkId`, errors);
  optionalString(value.assetId, `${path}.assetId`, errors);
  optionalString(value.quote, `${path}.quote`, errors);
  if (value.block !== undefined && !(Number.isInteger(value.block) && (value.block as number) >= 0 && (value.block as number) < blockCount)) {
    errors.push(error(`${path}.block`, "range", `block must be the index of one of this card's ${blockCount} blocks, front first, then back`));
  }
  if (value.locator !== undefined) {
    if (!isRecord(value.locator)) {
      errors.push(error(`${path}.locator`, "type", "locator must be an object"));
    } else {
      unknownKeys(value.locator, LOCATOR_KEYS, `${path}.locator`, errors);
      for (const [key, entry] of Object.entries(value.locator)) {
        if (key === "cell" ? typeof entry !== "string" : !(Number.isInteger(entry) && (entry as number) >= 0)) {
          errors.push(error(`${path}.locator.${key}`, "type", key === "cell" ? "cell must be a string" : `${key} must be a non-negative integer`));
        }
      }
    }
  }
}

function unknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, errors: SchemaError[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(error(`${path}.${key}`, "unknown_key", `Unknown property "${key}"`));
  }
}

function requiredString(value: unknown, path: string, errors: SchemaError[]): void {
  if (typeof value !== "string" || !value.trim()) errors.push(error(path, "required", "Must be a non-empty string"));
}

function optionalString(value: unknown, path: string, errors: SchemaError[]): void {
  if (value !== undefined && typeof value !== "string") errors.push(error(path, "type", "Must be a string when present"));
}

function oneOf(value: unknown, allowed: readonly string[], path: string, errors: SchemaError[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) errors.push(error(path, "enum", `Must be one of ${allowed.join(", ")}`));
}

function error(path: string, code: string, message: string): SchemaError {
  return { path, code, message };
}
