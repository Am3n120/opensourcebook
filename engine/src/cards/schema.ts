/**
 * Runtime checks for blocks and for the version 1 page (blocks.ts). Every
 * block shape and bound in blocks.ts is checked here; the byte validator
 * (validate.ts) runs `validateBlock` on each bit's blocks, and the engine's
 * repair step feeds the errors back to the model.
 */
import { isAssetPath } from "../assets";
import { isRecord } from "../net";
import { ACCESS_LEVELS, type AccessLevel } from "../types/source";
import { askedIssues } from "./asks";
import { KEPT_PICTURE_RULE, isKeptPicture } from "./pictures";
import {
  BYTE_DEPTHS,
  BYTE_TYPES,
  CALLOUT_STYLES,
  CLIP_PLATFORMS,
  EMBED_PLATFORMS,
  SERIES_COLORS,
  type BarItem,
  type PagePayload,
  type ByteBlock,
  type ByteDepth,
  type ByteStat,
  type PageValidationResult,
  type CalloutStyle,
  type EmbedPlatform,
  type LineSeries,
  type RepairSummary,
  type SchemaError,
  type ScaledIngredient,
  type SeriesColor,
} from "./blocks";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/i;

function isAbsoluteHTTPURL(value: unknown): value is string {
  if (typeof value !== "string" || !HTTP_URL_PATTERN.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export interface ValidationOptions {
  repair?: Partial<RepairSummary>;
}

export function emptyRepairSummary(): RepairSummary {
  return {
    attempted: false,
    attempts: 0,
    fixedPaths: [],
    remainingErrors: 0,
    notes: [],
  };
}

export function validatePage(value: unknown, options: ValidationOptions = {}): PageValidationResult {
  const errors: SchemaError[] = [];
  const path = "$";
  if (!isRecord(value)) {
    errors.push(error(path, "type", "The page must be a JSON object", "object", actualType(value)));
    return result(errors, options.repair);
  }

  validateKnownKeys(value, PAGE_KEYS, path, errors);
  validateUUID(value.id, "$.id", errors);
  validateEnum(value.type, BYTE_TYPES, "$.type", errors);
  requiredString(value.title, "$.title", errors);
  requiredString(value.subtitle, "$.subtitle", errors);
  optionalString(value.sourceDomain, "$.sourceDomain", errors);
  optionalString(value.author, "$.author", errors);
  requiredString(value.timeAgo, "$.timeAgo", errors);
  stringArray(value.tags, "$.tags", errors);
  validateStatus(value.status, "$.status", errors);
  validateEnumOrUndefined(value.depth, ["saveOnly", "light", "standard", "deep", "auto"], "$.depth", errors);
  optionalPositiveInteger(value.screensCount, "$.screensCount", errors);
  optionalString(value.durationText, "$.durationText", errors);
  optionalString(value.thumbnailName, "$.thumbnailName", errors);
  optionalString(value.excerpt, "$.excerpt", errors);
  optionalStringArray(value.ingredients, "$.ingredients", errors);
  optionalStringArray(value.steps, "$.steps", errors);
  optionalString(value.difficulty, "$.difficulty", errors);
  optionalString(value.quoteText, "$.quoteText", errors);
  optionalString(value.quoteAuthor, "$.quoteAuthor", errors);
  optionalStringArray(value.keyPoints, "$.keyPoints", errors);
  validateStats(value.stats, "$.stats", errors);
  validateEnum(value.byteDepth, BYTE_DEPTHS, "$.byteDepth", errors);

  if (!Array.isArray(value.blocks)) {
    errors.push(error("$.blocks", "type", "blocks must be an array", "array", actualType(value.blocks)));
  } else {
    value.blocks.forEach((block, index) => validateBlock(block, `$.blocks[${index}]`, errors));
  }

  return result(errors, options.repair, value as unknown as PagePayload);
}

export function isValidPage(value: unknown): value is PagePayload {
  return validatePage(value).valid;
}

function result(errors: SchemaError[], repair?: Partial<RepairSummary>, value?: PagePayload): PageValidationResult {
  const summary: RepairSummary = {
    ...emptyRepairSummary(),
    ...repair,
    fixedPaths: [...(repair?.fixedPaths ?? [])],
    notes: [...(repair?.notes ?? [])],
    remainingErrors: errors.length,
  };
  return {
    valid: errors.length === 0,
    ...(errors.length === 0 && value ? { value } : {}),
    errors,
    repair: summary,
    repairPromptSummary: buildRepairPromptSummary(errors),
  };
}

/** Rules that differ between a version 1 page and a bit. */
export interface BlockRules {
  /** Fewest cards a flashcards block may hold: 2 on a page, 1 in a bit (the bit is the card). */
  minCards: number;
  /** Most cards a flashcards block may hold. */
  maxCards: number;
}

export const PAGE_BLOCK_RULES: BlockRules = { minCards: 2, maxCards: 20 };

/** Checks one block against its shape and bounds, appending errors at `path`. */
export function validateBlock(value: unknown, path: string, errors: SchemaError[], nesting = 0, rules: BlockRules = PAGE_BLOCK_RULES): void {
  if (!isRecord(value)) {
    errors.push(error(path, "type", "ByteBlock must be an object", "object", actualType(value)));
    return;
  }
  if (nesting > 32) {
    errors.push(error(path, "nesting_limit", "Nested reveal blocks exceed the maximum depth", "<= 32", String(nesting)));
    return;
  }
  const type = value.type;
  if (typeof type !== "string") {
    errors.push(error(`${path}.type`, "required", "ByteBlock.type is required", "string", actualType(type)));
    return;
  }
  const allowed = BLOCK_KEYS[type];
  if (!allowed) {
    // The repair loop relays `expected` verbatim to the model, so it must name
    // the valid types — "known block type" leaves repair guessing blindly.
    errors.push(error(`${path}.type`, "enum", `Unknown ByteBlock type '${type}'`, `one of: ${KNOWN_BLOCK_TYPES}`, type));
    return;
  }
  validateKnownKeys(value, allowed, path, errors);

  switch (type) {
    case "kicker":
    case "heading":
    case "subheading":
    case "text":
      requiredString(value.text, `${path}.text`, errors);
      break;
    case "quote":
      requiredString(value.text, `${path}.text`, errors);
      optionalString(value.author, `${path}.author`, errors);
      optionalString(value.source, `${path}.source`, errors);
      break;
    case "divider":
    case "continuation":
    case "spacer":
      break;
    case "image":
      optionalPicture(value.url, `${path}.url`, errors);
      optionalString(value.caption, `${path}.caption`, errors);
      requiredString(value.systemIcon, `${path}.systemIcon`, errors);
      break;
    case "video":
      requiredString(value.youtubeID, `${path}.youtubeID`, errors);
      optionalString(value.title, `${path}.title`, errors);
      break;
    case "audio":
      requiredURL(value.url, `${path}.url`, errors);
      requiredString(value.title, `${path}.title`, errors);
      optionalString(value.subtitle, `${path}.subtitle`, errors);
      break;
    case "linkCard":
      requiredURL(value.url, `${path}.url`, errors);
      requiredString(value.title, `${path}.title`, errors);
      requiredString(value.domain, `${path}.domain`, errors);
      break;
    case "callout":
      validateEnum(value.style, CALLOUT_STYLES, `${path}.style`, errors);
      optionalString(value.title, `${path}.title`, errors);
      requiredString(value.text, `${path}.text`, errors);
      break;
    case "bullets":
    case "numbered":
    case "checklist":
      nonEmptyStringArray(value.items, `${path}.items`, errors);
      break;
    case "metrics":
      validateStats(value.stats, `${path}.stats`, errors, true);
      break;
    case "lineChart":
      optionalString(value.title, `${path}.title`, errors);
      validateLineChart(value, path, errors);
      break;
    case "barChart":
      optionalString(value.title, `${path}.title`, errors);
      validateBarChart(value, path, errors);
      break;
    case "table":
      validateTable(value, path, errors);
      break;
    case "timeline":
      validateTimeline(value.items, `${path}.items`, errors);
      break;
    case "code":
      requiredString(value.text, `${path}.text`, errors);
      requiredString(value.language, `${path}.language`, errors);
      break;
    case "bigStat":
      requiredString(value.value, `${path}.value`, errors);
      requiredString(value.label, `${path}.label`, errors);
      optionalString(value.delta, `${path}.delta`, errors);
      break;
    case "quiz":
      validateQuiz(value, path, errors);
      break;
    case "servingsScaler":
      positiveInteger(value.baseServings, `${path}.baseServings`, errors);
      validateIngredients(value.ingredients, `${path}.ingredients`, errors);
      break;
    case "timer":
      requiredString(value.label, `${path}.label`, errors);
      positiveInteger(value.seconds, `${path}.seconds`, errors);
      break;
    case "reveal":
      requiredString(value.title, `${path}.title`, errors);
      if (!Array.isArray(value.blocks)) {
        errors.push(error(`${path}.blocks`, "type", "reveal.blocks must be an array", "array", actualType(value.blocks)));
      } else {
        value.blocks.forEach((block, index) => validateBlock(block, `${path}.blocks[${index}]`, errors, nesting + 1, rules));
      }
      break;
    case "orderExercise":
      requiredString(value.prompt, `${path}.prompt`, errors);
      nonEmptyStringArray(value.items, `${path}.items`, errors);
      validatePermutation(value.correctOrder, value.items, `${path}.correctOrder`, errors);
      break;
    case "figure":
      requiredPicture(value.url, `${path}.url`, errors);
      optionalString(value.caption, `${path}.caption`, errors);
      optionalString(value.credit, `${path}.credit`, errors);
      optionalString(value.systemIcon, `${path}.systemIcon`, errors);
      break;
    case "gallery":
      validateGalleryImages(value.images, `${path}.images`, errors);
      if (value.columns !== undefined && value.columns !== null && value.columns !== 2 && value.columns !== 3) {
        errors.push(error(`${path}.columns`, "enum", "gallery.columns must be 2 or 3", "2 | 3", actualValue(value.columns)));
      }
      break;
    case "clip":
      requiredAssetURL(value.url, `${path}.url`, errors);
      nonNegativeInteger(value.startSeconds, `${path}.startSeconds`, errors);
      if (value.endSeconds !== undefined && value.endSeconds !== null) {
        if (!Number.isInteger(value.endSeconds)) {
          errors.push(error(`${path}.endSeconds`, "integer", "clip.endSeconds must be an integer", "integer", actualValue(value.endSeconds)));
        } else if (Number.isInteger(value.startSeconds) && (value.endSeconds as number) <= (value.startSeconds as number)) {
          errors.push(error(`${path}.endSeconds`, "range", "clip.endSeconds must be greater than startSeconds", "> startSeconds", actualValue(value.endSeconds)));
        }
      }
      optionalString(value.title, `${path}.title`, errors);
      optionalPicture(value.posterURL, `${path}.posterURL`, errors);
      validateEnumOrUndefined(value.platform, CLIP_PLATFORMS, `${path}.platform`, errors);
      break;
    case "heatmap":
      optionalString(value.title, `${path}.title`, errors);
      optionalString(value.minLabel, `${path}.minLabel`, errors);
      optionalString(value.maxLabel, `${path}.maxLabel`, errors);
      validateHeatmap(value, path, errors);
      break;
    case "scatter":
      optionalString(value.title, `${path}.title`, errors);
      optionalString(value.xLabel, `${path}.xLabel`, errors);
      optionalString(value.yLabel, `${path}.yLabel`, errors);
      validateScatterPoints(value.points, `${path}.points`, errors);
      break;
    case "pie":
      optionalString(value.title, `${path}.title`, errors);
      validatePieItems(value.items, `${path}.items`, errors);
      break;
    case "areaChart":
      optionalString(value.title, `${path}.title`, errors);
      validateLineChart(value, path, errors, "areaChart");
      break;
    case "stackedBar":
      optionalString(value.title, `${path}.title`, errors);
      validateStackedBar(value, path, errors);
      break;
    case "gauge":
      rangedNumber(value.value, `${path}.value`, errors, 0, 100);
      requiredString(value.label, `${path}.label`, errors);
      optionalString(value.detail, `${path}.detail`, errors);
      break;
    case "histogram":
      optionalString(value.title, `${path}.title`, errors);
      validateHistogramBins(value.bins, `${path}.bins`, errors);
      break;
    case "radar":
      optionalString(value.title, `${path}.title`, errors);
      validateRadar(value, path, errors);
      break;
    case "flashcards":
      validateFlashcards(value.cards, `${path}.cards`, errors, rules);
      break;
    case "fillInBlank":
      requiredString(value.prompt, `${path}.prompt`, errors);
      if (typeof value.prompt === "string" && value.prompt.trim().length > 0 && !value.prompt.includes("___")) {
        errors.push(error(`${path}.prompt`, "format", "fillInBlank.prompt must contain the blank marker ___", "___ in prompt", value.prompt));
      }
      requiredString(value.answer, `${path}.answer`, errors);
      if (value.options !== undefined && value.options !== null) {
        boundedStringArray(value.options, `${path}.options`, errors, 2, 5);
      }
      optionalString(value.explanation, `${path}.explanation`, errors);
      break;
    case "cloze":
      requiredString(value.text, `${path}.text`, errors);
      if (typeof value.text === "string" && value.text.trim() && clozeGaps(value.text).length === 0) {
        errors.push(error(`${path}.text`, "format", "cloze.text must hide its key part in double brackets, like: the [[key words]] are hidden", "[[...]] in text", value.text));
      }
      break;
    case "matching":
      optionalString(value.prompt, `${path}.prompt`, errors);
      validateMatchingPairs(value.pairs, `${path}.pairs`, errors);
      break;
    case "labelPicture":
      optionalString(value.prompt, `${path}.prompt`, errors);
      optionalString(value.caption, `${path}.caption`, errors);
      optionalStringArray(value.extra, `${path}.extra`, errors);
      optionalString(value.explanation, `${path}.explanation`, errors);
      validateLabelMarks(value.marks, `${path}.marks`, errors);
      askedErrors(value, path, errors);
      break;
    case "drawLine":
      requiredString(value.prompt, `${path}.prompt`, errors);
      optionalString(value.explanation, `${path}.explanation`, errors);
      validateGrid(value, path, errors);
      askedErrors(value, path, errors);
      break;
    case "prosCons":
      validateProsConsSide(value.pros, `${path}.pros`, errors);
      validateProsConsSide(value.cons, `${path}.cons`, errors);
      break;
    case "background":
      optionalString(value.title, `${path}.title`, errors);
      requiredString(value.text, `${path}.text`, errors);
      break;
    case "definition":
      requiredString(value.term, `${path}.term`, errors);
      requiredString(value.definition, `${path}.definition`, errors);
      optionalString(value.source, `${path}.source`, errors);
      break;
    case "embed":
      validateEnum(value.platform, EMBED_PLATFORMS, `${path}.platform`, errors);
      requiredURL(value.url, `${path}.url`, errors);
      optionalString(value.title, `${path}.title`, errors);
      // A maker's own HTML would run in the phone's web view and load whatever it names (cards/pictures.ts).
      if (value.html !== undefined && value.html !== null) {
        errors.push(error(`${path}.html`, "no_html", "an embed shows the source's own player from its url; leave html out", "no html", "html"));
      }
      break;
    case "linkPreview":
      requiredURL(value.url, `${path}.url`, errors);
      requiredString(value.title, `${path}.title`, errors);
      requiredString(value.domain, `${path}.domain`, errors);
      optionalString(value.description, `${path}.description`, errors);
      optionalPicture(value.imageURL, `${path}.imageURL`, errors);
      break;
    case "carousel":
      validateCarouselItems(value.items, `${path}.items`, errors);
      break;
    case "map":
      optionalString(value.title, `${path}.title`, errors);
      validateMapPlaces(value.places, `${path}.places`, errors);
      break;
    case "hero":
      requiredPicture(value.url, `${path}.url`, errors);
      optionalString(value.title, `${path}.title`, errors);
      optionalString(value.subtitle, `${path}.subtitle`, errors);
      break;
    case "toc":
      optionalString(value.title, `${path}.title`, errors);
      boundedStringArray(value.items, `${path}.items`, errors, 2, 20);
      break;
    case "math":
      requiredString(value.latex, `${path}.latex`, errors);
      optionalString(value.caption, `${path}.caption`, errors);
      break;
    case "audioClip":
      requiredURL(value.url, `${path}.url`, errors);
      if (value.startSeconds !== undefined && value.startSeconds !== null) {
        nonNegativeInteger(value.startSeconds, `${path}.startSeconds`, errors);
      }
      if (value.endSeconds !== undefined && value.endSeconds !== null) {
        if (!Number.isInteger(value.endSeconds)) {
          errors.push(error(`${path}.endSeconds`, "integer", "audioClip.endSeconds must be an integer", "integer", actualValue(value.endSeconds)));
        } else if (Number.isInteger(value.startSeconds) && (value.endSeconds as number) <= (value.startSeconds as number)) {
          errors.push(error(`${path}.endSeconds`, "range", "audioClip.endSeconds must be greater than startSeconds", "> startSeconds", actualValue(value.endSeconds)));
        }
      }
      optionalString(value.title, `${path}.title`, errors);
      break;
    default:
      // The union is exhaustive at runtime through the enum check above.
      break;
  }
}

function validateStatus(value: unknown, path: string, errors: SchemaError[]): void {
  if (!isRecord(value)) {
    errors.push(error(path, "type", "status must be a tagged object", "object", actualType(value)));
    return;
  }
  validateKnownKeys(value, value.type === "generating" ? ["type", "progress"] : ["type"], path, errors);
  const allowed = ["ready", "queued", "generating", "saveOnly", "archived"] as const;
  validateEnum(value.type, allowed, `${path}.type`, errors);
  if (value.type === "generating") {
    finiteNumber(value.progress, `${path}.progress`, errors);
    if (typeof value.progress === "number" && (value.progress < 0 || value.progress > 1)) {
      errors.push(error(`${path}.progress`, "range", "generating progress must be between 0 and 1", "0...1", String(value.progress)));
    }
  }
}

function validateStats(value: unknown, path: string, errors: SchemaError[], required: boolean = false): void {
  if (value === undefined || value === null) {
    if (required) errors.push(error(path, "required", "stats is required", "array", actualType(value)));
    return;
  }
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "stats must be an array", "array", actualType(value)));
    return;
  }
  value.forEach((stat, index) => {
    const statPath = `${path}[${index}]`;
    if (!isRecord(stat)) {
      errors.push(error(statPath, "type", "stat must be an object", "object", actualType(stat)));
      return;
    }
    validateKnownKeys(stat, ["id", "label", "value", "delta"], statPath, errors);
    requiredString(stat.id, `${statPath}.id`, errors);
    requiredString(stat.label, `${statPath}.label`, errors);
    requiredString(stat.value, `${statPath}.value`, errors);
    optionalString(stat.delta, `${statPath}.delta`, errors);
  });
}

function validateLineChart(value: Record<string, unknown>, path: string, errors: SchemaError[], blockType: "lineChart" | "areaChart" = "lineChart"): void {
  if (!Array.isArray(value.xLabels)) {
    errors.push(error(`${path}.xLabels`, "type", `${blockType}.xLabels must be an array`, "string[]", actualType(value.xLabels)));
  } else {
    nonEmptyStringArray(value.xLabels, `${path}.xLabels`, errors);
  }
  if (!Array.isArray(value.series)) {
    errors.push(error(`${path}.series`, "type", `${blockType}.series must be an array`, "LineSeries[]", actualType(value.series)));
    return;
  }
  if (value.series.length === 0) {
    errors.push(error(`${path}.series`, "min_items", `${blockType}.series must contain at least one series`, ">= 1", "0"));
  }
  value.series.forEach((series, index) => {
    const seriesPath = `${path}.series[${index}]`;
    if (!isRecord(series)) {
      errors.push(error(seriesPath, "type", "line series must be an object", "object", actualType(series)));
      return;
    }
    validateKnownKeys(series, ["name", "values", "color"], seriesPath, errors);
    requiredString(series.name, `${seriesPath}.name`, errors);
    validateEnum(series.color, SERIES_COLORS, `${seriesPath}.color`, errors);
    if (!Array.isArray(series.values)) {
      errors.push(error(`${seriesPath}.values`, "type", "series values must be an array", "number[]", actualType(series.values)));
    } else {
      if (series.values.length === 0) {
        errors.push(error(`${seriesPath}.values`, "min_items", "series values cannot be empty", ">= 1", "0"));
      }
      series.values.forEach((entry, valueIndex) => finiteNumber(entry, `${seriesPath}.values[${valueIndex}]`, errors));
      if (Array.isArray(value.xLabels) && series.values.length !== value.xLabels.length) {
        errors.push(error(`${seriesPath}.values`, "consistent_length", "every line series must match xLabels length", String(value.xLabels.length), String(series.values.length)));
      }
    }
  });
}

function validateBarChart(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value.items)) {
    errors.push(error(`${path}.items`, "type", "barChart.items must be an array", "BarItem[]", actualType(value.items)));
    return;
  }
  if (value.items.length === 0) {
    errors.push(error(`${path}.items`, "min_items", "barChart.items must contain at least one item", ">= 1", "0"));
  }
  value.items.forEach((item, index) => {
    const itemPath = `${path}.items[${index}]`;
    if (!isRecord(item)) {
      errors.push(error(itemPath, "type", "bar item must be an object", "object", actualType(item)));
      return;
    }
    validateKnownKeys(item, ["label", "value", "displayValue"], itemPath, errors);
    requiredString(item.label, `${itemPath}.label`, errors);
    finiteNumber(item.value, `${itemPath}.value`, errors);
    requiredString(item.displayValue, `${itemPath}.displayValue`, errors);
  });
}

function validateTable(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value.headers)) {
    errors.push(error(`${path}.headers`, "type", "table.headers must be an array", "string[]", actualType(value.headers)));
  } else {
    nonEmptyStringArray(value.headers, `${path}.headers`, errors);
  }
  if (!Array.isArray(value.rows)) {
    errors.push(error(`${path}.rows`, "type", "table.rows must be an array", "string[][]", actualType(value.rows)));
    return;
  }
  value.rows.forEach((row, index) => {
    const rowPath = `${path}.rows[${index}]`;
    if (!Array.isArray(row)) {
      errors.push(error(rowPath, "type", "table row must be an array", "string[]", actualType(row)));
      return;
    }
    row.forEach((cell, cellIndex) => requiredString(cell, `${rowPath}[${cellIndex}]`, errors));
    if (Array.isArray(value.headers) && row.length !== value.headers.length) {
      errors.push(error(rowPath, "consistent_length", "every table row must match headers length", String(value.headers.length), String(row.length)));
    }
  });
}

function validateTimeline(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "timeline.items must be an array", "TimelineItem[]", actualType(value)));
    return;
  }
  if (value.length === 0) {
    errors.push(error(path, "min_items", "timeline.items must contain at least one item", ">= 1", "0"));
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(error(itemPath, "type", "timeline item must be an object", "object", actualType(item)));
      return;
    }
    validateKnownKeys(item, ["label", "title", "detail"], itemPath, errors);
    requiredString(item.label, `${itemPath}.label`, errors);
    requiredString(item.title, `${itemPath}.title`, errors);
    optionalString(item.detail, `${itemPath}.detail`, errors);
  });
}

function validateGalleryImages(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "gallery.images must be an array", "GalleryImageItem[]", actualType(value)));
    return;
  }
  if (value.length < 2 || value.length > 12) {
    errors.push(error(path, "range", "gallery.images must contain between 2 and 12 items", "2...12", String(value.length)));
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(error(itemPath, "type", "gallery image must be an object", "object", actualType(item)));
      return;
    }
    validateKnownKeys(item, ["url", "caption"], itemPath, errors);
    requiredPicture(item.url, `${itemPath}.url`, errors);
    optionalString(item.caption, `${itemPath}.caption`, errors);
  });
}

function validateHeatmap(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  boundedStringArray(value.xLabels, `${path}.xLabels`, errors, 1, 12);
  boundedStringArray(value.yLabels, `${path}.yLabels`, errors, 1, 12);
  if (!Array.isArray(value.values)) {
    errors.push(error(`${path}.values`, "type", "heatmap.values must be an array", "number[][]", actualType(value.values)));
    return;
  }
  if (Array.isArray(value.yLabels) && value.values.length !== value.yLabels.length) {
    errors.push(error(`${path}.values`, "consistent_length", "heatmap.values must contain one row per yLabels entry", String(value.yLabels.length), String(value.values.length)));
  }
  value.values.forEach((row, index) => {
    const rowPath = `${path}.values[${index}]`;
    if (!Array.isArray(row)) {
      errors.push(error(rowPath, "type", "heatmap row must be an array of numbers", "number[]", actualType(row)));
      return;
    }
    row.forEach((entry, cellIndex) => finiteNumber(entry, `${rowPath}[${cellIndex}]`, errors));
    if (Array.isArray(value.xLabels) && row.length !== value.xLabels.length) {
      errors.push(error(rowPath, "consistent_length", "every heatmap row must match xLabels length", String(value.xLabels.length), String(row.length)));
    }
  });
}

function validateScatterPoints(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "scatter.points must be an array", "ScatterPoint[]", actualType(value)));
    return;
  }
  if (value.length < 1 || value.length > 100) {
    errors.push(error(path, "range", "scatter.points must contain between 1 and 100 points", "1...100", String(value.length)));
  }
  value.forEach((point, index) => {
    const pointPath = `${path}[${index}]`;
    if (!isRecord(point)) {
      errors.push(error(pointPath, "type", "scatter point must be an object", "object", actualType(point)));
      return;
    }
    validateKnownKeys(point, ["x", "y", "label"], pointPath, errors);
    finiteNumber(point.x, `${pointPath}.x`, errors);
    finiteNumber(point.y, `${pointPath}.y`, errors);
    optionalString(point.label, `${pointPath}.label`, errors);
  });
}

function validatePieItems(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "pie.items must be an array", "PieItem[]", actualType(value)));
    return;
  }
  if (value.length < 2 || value.length > 8) {
    errors.push(error(path, "range", "pie.items must contain between 2 and 8 items", "2...8", String(value.length)));
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(error(itemPath, "type", "pie item must be an object", "object", actualType(item)));
      return;
    }
    validateKnownKeys(item, ["label", "value", "displayValue"], itemPath, errors);
    requiredString(item.label, `${itemPath}.label`, errors);
    finiteNumber(item.value, `${itemPath}.value`, errors);
    if (typeof item.value === "number" && Number.isFinite(item.value) && item.value <= 0) {
      errors.push(error(`${itemPath}.value`, "range", "pie item value must be greater than zero", "> 0", String(item.value)));
    }
    optionalString(item.displayValue, `${itemPath}.displayValue`, errors);
  });
}

function validateStackedBar(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  boundedStringArray(value.categories, `${path}.categories`, errors, 1, 12);
  if (!Array.isArray(value.series)) {
    errors.push(error(`${path}.series`, "type", "stackedBar.series must be an array", "StackedBarSeries[]", actualType(value.series)));
    return;
  }
  if (value.series.length < 1 || value.series.length > 4) {
    errors.push(error(`${path}.series`, "range", "stackedBar.series must contain between 1 and 4 series", "1...4", String(value.series.length)));
  }
  value.series.forEach((series, index) => {
    const seriesPath = `${path}.series[${index}]`;
    if (!isRecord(series)) {
      errors.push(error(seriesPath, "type", "stacked bar series must be an object", "object", actualType(series)));
      return;
    }
    validateKnownKeys(series, ["name", "values", "color"], seriesPath, errors);
    requiredString(series.name, `${seriesPath}.name`, errors);
    validateEnum(series.color, SERIES_COLORS, `${seriesPath}.color`, errors);
    if (!Array.isArray(series.values)) {
      errors.push(error(`${seriesPath}.values`, "type", "series values must be an array", "number[]", actualType(series.values)));
    } else {
      series.values.forEach((entry, valueIndex) => finiteNumber(entry, `${seriesPath}.values[${valueIndex}]`, errors));
      if (Array.isArray(value.categories) && series.values.length !== value.categories.length) {
        errors.push(error(`${seriesPath}.values`, "consistent_length", "every stacked bar series must match categories length", String(value.categories.length), String(series.values.length)));
      }
    }
  });
}

function validateHistogramBins(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "histogram.bins must be an array", "HistogramBin[]", actualType(value)));
    return;
  }
  if (value.length < 2 || value.length > 30) {
    errors.push(error(path, "range", "histogram.bins must contain between 2 and 30 bins", "2...30", String(value.length)));
  }
  value.forEach((bin, index) => {
    const binPath = `${path}[${index}]`;
    if (!isRecord(bin)) {
      errors.push(error(binPath, "type", "histogram bin must be an object", "object", actualType(bin)));
      return;
    }
    validateKnownKeys(bin, ["label", "count"], binPath, errors);
    requiredString(bin.label, `${binPath}.label`, errors);
    finiteNumber(bin.count, `${binPath}.count`, errors);
    if (typeof bin.count === "number" && Number.isFinite(bin.count) && bin.count < 0) {
      errors.push(error(`${binPath}.count`, "range", "histogram bin count cannot be negative", ">= 0", String(bin.count)));
    }
  });
}

function validateRadar(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  boundedStringArray(value.axes, `${path}.axes`, errors, 3, 8);
  if (!Array.isArray(value.series)) {
    errors.push(error(`${path}.series`, "type", "radar.series must be an array", "RadarSeries[]", actualType(value.series)));
    return;
  }
  if (value.series.length < 1 || value.series.length > 3) {
    errors.push(error(`${path}.series`, "range", "radar.series must contain between 1 and 3 series", "1...3", String(value.series.length)));
  }
  value.series.forEach((series, index) => {
    const seriesPath = `${path}.series[${index}]`;
    if (!isRecord(series)) {
      errors.push(error(seriesPath, "type", "radar series must be an object", "object", actualType(series)));
      return;
    }
    validateKnownKeys(series, ["name", "values", "color"], seriesPath, errors);
    requiredString(series.name, `${seriesPath}.name`, errors);
    validateEnum(series.color, SERIES_COLORS, `${seriesPath}.color`, errors);
    if (!Array.isArray(series.values)) {
      errors.push(error(`${seriesPath}.values`, "type", "series values must be an array", "number[]", actualType(series.values)));
    } else {
      series.values.forEach((entry, valueIndex) => {
        finiteNumber(entry, `${seriesPath}.values[${valueIndex}]`, errors);
        if (typeof entry === "number" && Number.isFinite(entry) && entry < 0) {
          errors.push(error(`${seriesPath}.values[${valueIndex}]`, "range", "radar values cannot be negative", ">= 0", String(entry)));
        }
      });
      if (Array.isArray(value.axes) && series.values.length !== value.axes.length) {
        errors.push(error(`${seriesPath}.values`, "consistent_length", "every radar series must match axes length", String(value.axes.length), String(series.values.length)));
      }
    }
  });
}

function validateFlashcards(value: unknown, path: string, errors: SchemaError[], rules: BlockRules): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "flashcards.cards must be an array", "Flashcard[]", actualType(value)));
    return;
  }
  if (value.length < rules.minCards || value.length > rules.maxCards) {
    const bounds = rules.minCards === rules.maxCards ? `exactly ${rules.minCards}` : `between ${rules.minCards} and ${rules.maxCards}`;
    errors.push(error(path, "range", `flashcards.cards must contain ${bounds} card${rules.maxCards === 1 ? "" : "s"}`, `${rules.minCards}...${rules.maxCards}`, String(value.length)));
  }
  value.forEach((card, index) => {
    const cardPath = `${path}[${index}]`;
    if (!isRecord(card)) {
      errors.push(error(cardPath, "type", "flashcard must be an object", "object", actualType(card)));
      return;
    }
    validateKnownKeys(card, ["front", "back"], cardPath, errors);
    requiredString(card.front, `${cardPath}.front`, errors);
    requiredString(card.back, `${cardPath}.back`, errors);
  });
}

/** Each mark is `{ mark, answer }`, both words; what else a label needs is the quiz's label kind's to say (asks.ts). */
function validateLabelMarks(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "labelPicture.marks must be an array of { mark, answer }", "{ mark, answer }[]", actualType(value)));
    return;
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(error(`${path}[${index}]`, "type", "a mark is { mark, answer }", "object", actualType(entry)));
      return;
    }
    requiredString(entry.mark, `${path}[${index}].mark`, errors);
    requiredString(entry.answer, `${path}[${index}].answer`, errors);
  });
}

/** Numbers are numbers here, not words for them: the grid and the line are drawn and graded from them as they are. */
function validateGrid(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  const axes = isRecord(value.axes) ? value.axes : undefined;
  if (!axes) errors.push(error(`${path}.axes`, "type", "drawLine.axes is { x: { min, max, step }, y: { min, max, step } }", "object", actualType(value.axes)));
  for (const name of ["x", "y"] as const) {
    const axis = axes && isRecord(axes[name]) ? axes[name] : undefined;
    if (axes && !axis) errors.push(error(`${path}.axes.${name}`, "type", "an axis is { min, max, step, label? }", "object", actualType(axes[name])));
    for (const key of ["min", "max", "step"] as const) {
      if (axis && (typeof axis[key] !== "number" || !Number.isFinite(axis[key]))) errors.push(error(`${path}.axes.${name}.${key}`, "number", "value must be a number", "number", actualType(axis[key])));
    }
    if (axis) optionalString(axis.label, `${path}.axes.${name}.label`, errors);
  }
  const line = value.line;
  const point = (entry: unknown) => Array.isArray(entry) && entry.length === 2 && entry.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!Array.isArray(line) || line.length !== 2 || !line.every(point)) {
    errors.push(error(`${path}.line`, "type", "drawLine.line is two grid points, [[x1, y1], [x2, y2]]", "[[number, number], [number, number]]", actualType(line)));
  }
}

/** The quiz kind's own check of a block that asks as it does, once the block's own shape holds. */
function askedErrors(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  if (errors.some((entry) => entry.path === path || entry.path.startsWith(`${path}.`))) return;
  for (const issue of askedIssues(value)) errors.push(error(`${path}${issue.path}`, issue.code, issue.message));
}

function validateMatchingPairs(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "matching.pairs must be an array", "MatchingPair[]", actualType(value)));
    return;
  }
  if (value.length < 3 || value.length > 8) {
    errors.push(error(path, "range", "matching.pairs must contain between 3 and 8 pairs", "3...8", String(value.length)));
  }
  value.forEach((pair, index) => {
    const pairPath = `${path}[${index}]`;
    if (!isRecord(pair)) {
      errors.push(error(pairPath, "type", "matching pair must be an object", "object", actualType(pair)));
      return;
    }
    validateKnownKeys(pair, ["left", "right"], pairPath, errors);
    requiredString(pair.left, `${pairPath}.left`, errors);
    requiredString(pair.right, `${pairPath}.right`, errors);
  });
}

function validateProsConsSide(value: unknown, path: string, errors: SchemaError[]): void {
  if (!isRecord(value)) {
    errors.push(error(path, "type", "prosCons side must be an object", "object", actualType(value)));
    return;
  }
  validateKnownKeys(value, ["title", "items"], path, errors);
  optionalString(value.title, `${path}.title`, errors);
  boundedStringArray(value.items, `${path}.items`, errors, 1, 8);
}

function validateCarouselItems(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "carousel.items must be an array", "GalleryImageItem[]", actualType(value)));
    return;
  }
  if (value.length < 2 || value.length > 10) {
    errors.push(error(path, "range", "carousel.items must contain between 2 and 10 items", "2...10", String(value.length)));
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      errors.push(error(itemPath, "type", "carousel item must be an object", "object", actualType(item)));
      return;
    }
    validateKnownKeys(item, ["url", "caption"], itemPath, errors);
    requiredPicture(item.url, `${itemPath}.url`, errors);
    optionalString(item.caption, `${itemPath}.caption`, errors);
  });
}

function validateMapPlaces(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "map.places must be an array", "MapPlace[]", actualType(value)));
    return;
  }
  if (value.length < 1 || value.length > 20) {
    errors.push(error(path, "range", "map.places must contain between 1 and 20 places", "1...20", String(value.length)));
  }
  value.forEach((place, index) => {
    const placePath = `${path}[${index}]`;
    if (!isRecord(place)) {
      errors.push(error(placePath, "type", "map place must be an object", "object", actualType(place)));
      return;
    }
    validateKnownKeys(place, ["name", "latitude", "longitude", "note"], placePath, errors);
    requiredString(place.name, `${placePath}.name`, errors);
    rangedNumber(place.latitude, `${placePath}.latitude`, errors, -90, 90);
    rangedNumber(place.longitude, `${placePath}.longitude`, errors, -180, 180);
    optionalString(place.note, `${placePath}.note`, errors);
  });
}

function validateQuiz(value: Record<string, unknown>, path: string, errors: SchemaError[]): void {
  requiredString(value.question, `${path}.question`, errors);
  if (!Array.isArray(value.options)) {
    errors.push(error(`${path}.options`, "type", "quiz.options must be an array", "string[]", actualType(value.options)));
  } else {
    if (value.options.length < 2) {
      errors.push(error(`${path}.options`, "min_items", "quiz.options must contain at least two options", ">= 2", String(value.options.length)));
    }
    value.options.forEach((option, index) => requiredString(option, `${path}.options[${index}]`, errors));
    const correctIndex = value.correctIndex;
    if (!Number.isInteger(correctIndex) || (correctIndex as number) < 0 || (correctIndex as number) >= value.options.length) {
      errors.push(error(`${path}.correctIndex`, "bounds", "quiz.correctIndex must point to an option", `0...${Math.max(value.options.length - 1, 0)}`, String(value.correctIndex)));
    }
  }
  optionalString(value.explanation, `${path}.explanation`, errors);
}

function validateIngredients(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "ingredients must be an array", "ScaledIngredient[]", actualType(value)));
    return;
  }
  if (value.length === 0) {
    errors.push(error(path, "min_items", "servingsScaler.ingredients cannot be empty", ">= 1", "0"));
  }
  value.forEach((ingredient, index) => {
    const ingredientPath = `${path}[${index}]`;
    if (!isRecord(ingredient)) {
      errors.push(error(ingredientPath, "type", "ingredient must be an object", "object", actualType(ingredient)));
      return;
    }
    validateKnownKeys(ingredient, ["quantity", "unit", "name"], ingredientPath, errors);
    if (ingredient.quantity !== undefined && ingredient.quantity !== null) {
      finiteNumber(ingredient.quantity, `${ingredientPath}.quantity`, errors);
      if (typeof ingredient.quantity === "number" && ingredient.quantity < 0) {
        errors.push(error(`${ingredientPath}.quantity`, "range", "ingredient quantity cannot be negative", ">= 0", String(ingredient.quantity)));
      }
    }
    requiredString(ingredient.unit, `${ingredientPath}.unit`, errors, true);
    requiredString(ingredient.name, `${ingredientPath}.name`, errors);
  });
}

function validatePermutation(value: unknown, items: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "correctOrder must be an array", "number[]", actualType(value)));
    return;
  }
  const itemCount = Array.isArray(items) ? items.length : -1;
  if (itemCount < 0) return;
  if (value.length !== itemCount) {
    errors.push(error(path, "permutation_length", "correctOrder must contain one index per item", String(itemCount), String(value.length)));
  }
  const seen = new Set<number>();
  value.forEach((entry, index) => {
    if (!Number.isInteger(entry)) {
      errors.push(error(`${path}[${index}]`, "integer", "correctOrder entries must be integers", "integer", actualType(entry)));
      return;
    }
    if (entry < 0 || entry >= itemCount) {
      errors.push(error(`${path}[${index}]`, "bounds", "correctOrder entry is outside items", `0...${Math.max(itemCount - 1, 0)}`, String(entry)));
    } else if (seen.has(entry)) {
      errors.push(error(`${path}[${index}]`, "permutation", "correctOrder must not repeat an index", "unique indices", String(entry)));
    } else {
      seen.add(entry);
    }
  });
  if (itemCount >= 0 && seen.size === itemCount) {
    for (let expected = 0; expected < itemCount; expected += 1) {
      if (!seen.has(expected)) {
        errors.push(error(path, "permutation", "correctOrder must contain every item index exactly once", `0...${itemCount - 1}`, JSON.stringify(value)));
        break;
      }
    }
  }
}

function validateKnownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, errors: SchemaError[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      errors.push(error(`${path}.${key}`, "unknown_key", "Unknown property is not allowed by the block contract", allowed.join(", "), key));
    }
  }
}

function validateUUID(value: unknown, path: string, errors: SchemaError[]): void {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    errors.push(error(path, "uuid", "id must be a canonical UUID", "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", actualValue(value)));
  }
}

function requiredString(value: unknown, path: string, errors: SchemaError[], allowEmpty = false): void {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    errors.push(error(path, "string", "value must be a non-empty string", "string", actualType(value)));
  }
}

function optionalString(value: unknown, path: string, errors: SchemaError[]): void {
  if (value !== undefined && value !== null && (typeof value !== "string" || value.trim().length === 0)) {
    errors.push(error(path, "string", "optional value must be a non-empty string when present", "string|null", actualType(value)));
  }
}

function stringArray(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "value must be an array of strings", "string[]", actualType(value)));
    return;
  }
  value.forEach((entry, index) => requiredString(entry, `${path}[${index}]`, errors));
}

function optionalStringArray(value: unknown, path: string, errors: SchemaError[]): void {
  if (value === undefined || value === null) return;
  stringArray(value, path, errors);
}

function nonEmptyStringArray(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "value must be an array of strings", "string[]", actualType(value)));
    return;
  }
  if (value.length === 0) {
    errors.push(error(path, "min_items", "array must contain at least one item", ">= 1", "0"));
  }
  stringArray(value, path, errors);
}

function boundedStringArray(value: unknown, path: string, errors: SchemaError[], min: number, max: number): void {
  if (!Array.isArray(value)) {
    errors.push(error(path, "type", "value must be an array of strings", "string[]", actualType(value)));
    return;
  }
  if (value.length < min || value.length > max) {
    errors.push(error(path, "range", `array must contain between ${min} and ${max} items`, `${min}...${max}`, String(value.length)));
  }
  value.forEach((entry, index) => requiredString(entry, `${path}[${index}]`, errors));
}

function optionalPositiveInteger(value: unknown, path: string, errors: SchemaError[]): void {
  if (value === undefined || value === null) return;
  positiveInteger(value, path, errors);
}

function positiveInteger(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    errors.push(error(path, "positive", "value must be a positive integer", "> 0", actualValue(value)));
  }
}

function nonNegativeInteger(value: unknown, path: string, errors: SchemaError[]): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    errors.push(error(path, "non_negative", "value must be a non-negative integer", ">= 0", actualValue(value)));
  }
}

function finiteNumber(value: unknown, path: string, errors: SchemaError[]): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    errors.push(error(path, "finite_number", "value must be a finite number", "finite number", actualValue(value)));
  }
}

function rangedNumber(value: unknown, path: string, errors: SchemaError[], min: number, max: number): void {
  finiteNumber(value, path, errors);
  if (typeof value === "number" && Number.isFinite(value) && (value < min || value > max)) {
    errors.push(error(path, "range", `value must be between ${min} and ${max}`, `${min}...${max}`, String(value)));
  }
}

function requiredURL(value: unknown, path: string, errors: SchemaError[]): void {
  if (!isAbsoluteHTTPURL(value)) {
    errors.push(error(path, "url", "value must be an absolute HTTP(S) URL", "http(s) URL", actualValue(value)));
  }
}

/** A clip's video: the source video's own address, or a video Open Sourcebook keeps. */
function isAssetCapableURL(value: unknown): value is string {
  return isAbsoluteHTTPURL(value) || (typeof value === "string" && isAssetPath(value));
}

function requiredAssetURL(value: unknown, path: string, errors: SchemaError[]): void {
  if (!isAssetCapableURL(value)) {
    errors.push(error(path, "url", "value must be an absolute HTTP(S) URL or a worker-relative /v1/assets/ path", "http(s) URL | /v1/assets/<id>", actualValue(value)));
  }
}

/** A picture: only one Open Sourcebook keeps or embeds (pictures.ts), never a web address. */
function requiredPicture(value: unknown, path: string, errors: SchemaError[]): void {
  if (!isKeptPicture(value)) {
    errors.push(error(path, "kept_picture", KEPT_PICTURE_RULE, "/v1/assets/<id> | data:image/...;base64", actualValue(value)));
  }
}

function optionalPicture(value: unknown, path: string, errors: SchemaError[]): void {
  if (value === undefined || value === null) return;
  requiredPicture(value, path, errors);
}

function validateEnum<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: SchemaError[]): void {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(error(path, "enum", "value is not a supported enum member", allowed.join(" | "), actualValue(value)));
  }
}

function validateEnumOrUndefined<T extends string>(value: unknown, allowed: readonly T[], path: string, errors: SchemaError[]): void {
  if (value !== undefined && value !== null) validateEnum(value, allowed, path, errors);
}

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function actualValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return actualType(value);
  }
}

function error(path: string, code: string, message: string, expected?: string, actual?: string): SchemaError {
  return { path, code, message, ...(expected ? { expected } : {}), ...(actual ? { actual } : {}) };
}

function buildRepairPromptSummary(errors: SchemaError[]): string {
  if (errors.length === 0) return "The payload passed schema validation; no repair is required.";
  const details = errors
    .slice(0, 20)
    .map((entry) => `${entry.path} [${entry.code}]: ${entry.message}`)
    .join("\n");
  const suffix = errors.length > 20 ? `\n…and ${errors.length - 20} more error(s).` : "";
  return `Return the complete corrected JSON. Fix only these contract errors, remove unsupported content, and do not invent replacements:\n${details}${suffix}`;
}

const PAGE_KEYS = [
  "id",
  "type",
  "title",
  "subtitle",
  "sourceDomain",
  "author",
  "timeAgo",
  "tags",
  "status",
  "depth",
  "screensCount",
  "durationText",
  "thumbnailName",
  "excerpt",
  "ingredients",
  "steps",
  "difficulty",
  "quoteText",
  "quoteAuthor",
  "keyPoints",
  "stats",
  "blocks",
  "byteDepth",
] as const;

const BLOCK_KEYS: Record<string, readonly string[]> = {
  kicker: ["type", "text"],
  heading: ["type", "text"],
  subheading: ["type", "text"],
  text: ["type", "text"],
  quote: ["type", "text", "author", "source"],
  divider: ["type"],
  continuation: ["type"],
  spacer: ["type"],
  image: ["type", "url", "caption", "systemIcon"],
  video: ["type", "youtubeID", "title"],
  audio: ["type", "url", "title", "subtitle"],
  linkCard: ["type", "url", "title", "domain"],
  callout: ["type", "style", "title", "text"],
  bullets: ["type", "items"],
  numbered: ["type", "items"],
  metrics: ["type", "stats"],
  lineChart: ["type", "title", "xLabels", "series"],
  barChart: ["type", "title", "items"],
  table: ["type", "headers", "rows"],
  timeline: ["type", "items"],
  code: ["type", "text", "language"],
  bigStat: ["type", "value", "label", "delta"],
  checklist: ["type", "items"],
  quiz: ["type", "question", "options", "correctIndex", "explanation"],
  servingsScaler: ["type", "baseServings", "ingredients"],
  timer: ["type", "label", "seconds"],
  reveal: ["type", "title", "blocks"],
  orderExercise: ["type", "prompt", "items", "correctOrder"],
  figure: ["type", "url", "caption", "credit", "systemIcon"],
  gallery: ["type", "images", "columns"],
  clip: ["type", "url", "startSeconds", "endSeconds", "title", "posterURL", "platform"],
  heatmap: ["type", "title", "xLabels", "yLabels", "values", "minLabel", "maxLabel"],
  scatter: ["type", "title", "xLabel", "yLabel", "points"],
  pie: ["type", "title", "items"],
  areaChart: ["type", "title", "xLabels", "series"],
  stackedBar: ["type", "title", "categories", "series"],
  gauge: ["type", "value", "label", "detail"],
  histogram: ["type", "title", "bins"],
  radar: ["type", "title", "axes", "series"],
  flashcards: ["type", "cards"],
  fillInBlank: ["type", "prompt", "answer", "options", "explanation"],
  cloze: ["type", "text"],
  matching: ["type", "prompt", "pairs"],
  labelPicture: ["type", "prompt", "url", "caption", "marks", "extra", "explanation"],
  drawLine: ["type", "prompt", "axes", "line", "explanation"],
  prosCons: ["type", "pros", "cons"],
  definition: ["type", "term", "definition", "source"],
  background: ["type", "title", "text"],
  embed: ["type", "platform", "url", "title", "html"],
  linkPreview: ["type", "url", "title", "domain", "description", "imageURL"],
  carousel: ["type", "items"],
  map: ["type", "title", "places"],
  hero: ["type", "url", "title", "subtitle"],
  toc: ["type", "title", "items"],
  math: ["type", "latex", "caption"],
  audioClip: ["type", "url", "startSeconds", "endSeconds", "title"],
};

/** Every block type a client may meet. */
export const BLOCK_TYPES: readonly string[] = Object.keys(BLOCK_KEYS);

/** Human-readable type list embedded in enum errors so repair prompts name the valid types. */
const KNOWN_BLOCK_TYPES = Object.keys(BLOCK_KEYS).join(", ");

// Keep these imports visible to make the DTO contract changes fail typecheck if Swift-facing records drift.
void (null as unknown as ByteBlock);
void (null as unknown as ByteDepth);
void (null as unknown as ByteStat);
void (null as unknown as CalloutStyle);
void (null as unknown as EmbedPlatform);
void (null as unknown as LineSeries);
void (null as unknown as ScaledIngredient);
void (null as unknown as SeriesColor);
void (null as unknown as AccessLevel);

/** The hidden parts of a cloze sentence: the words inside each [[...]], in order. */
export function clozeGaps(text: string): string[] {
  return [...text.matchAll(/\[\[([^\[\]]+)\]\]/g)].map((match) => match[1]!.trim()).filter(Boolean);
}
