/**
 * What each kind of block looks like, for a writer: one example of its
 * shape and a line on what it is for. Every block type a card may hold has an
 * entry here beside its keys in schema.ts (a test keeps the two together),
 * so a writer's tools can describe the whole vocabulary from this list
 * instead of keeping one of their own. Values in the examples are
 * placeholders; bounds are the schema's, and it says when one is crossed.
 */
import { ASK_BLOCKS, BLOCKS_NOT_ON_A_CARD, CHART_BLOCKS, HIDING_BLOCKS, MEDIA_BLOCKS } from "./contract";
import { BLOCK_TYPES } from "./schema";

export interface BlockShape {
  /** One example, as JSON. */
  example: Record<string, unknown>;
  /** What it is for, in a line. */
  use: string;
}

export const BLOCK_SHAPES: Record<string, BlockShape> = {
  kicker: { example: { type: "kicker", text: "..." }, use: "a few words above a heading that set the scene" },
  heading: { example: { type: "heading", text: "..." }, use: "a few plain words naming what the side is about; most cards need none" },
  subheading: { example: { type: "subheading", text: "..." }, use: "a smaller heading" },
  text: { example: { type: "text", text: "..." }, use: "a short paragraph; **bold**, *italic*, `code`, $math$ and [label](url) marks allowed" },
  quote: { example: { type: "quote", text: "...", author: "...", source: "..." }, use: "words worth reading as they were said, with who said them" },
  callout: { example: { type: "callout", style: "info", title: "...", text: "..." }, use: "one thing to notice or watch out for; style info, success, warning or primary" },
  bullets: { example: { type: "bullets", items: ["...", "..."] }, use: "a few parallel points" },
  numbered: { example: { type: "numbered", items: ["...", "..."] }, use: "steps or points where order matters" },
  checklist: { example: { type: "checklist", items: ["...", "..."] }, use: "things the person can tick off" },
  timeline: { example: { type: "timeline", items: [{ label: "...", title: "...", detail: "..." }] }, use: "events or stages in order, each with a label such as a date" },
  definition: { example: { type: "definition", term: "...", definition: "...", source: "..." }, use: "a term and what it means; source is a title or page, never a URL" },
  background: {
    example: { type: "background", title: "...", text: "..." },
    use: "what you add that is not in the sources, to help them understand (what a term usually means, how such a number is usually read); shown marked as not from their source, never cited, never a fact about the source itself",
  },
  code: { example: { type: "code", language: "python", text: "..." }, use: "code, one line per line" },
  math: { example: { type: "math", latex: "a^2 + b^2 = c^2", caption: "..." }, use: "a formula in LaTeX, with what it says in the caption" },
  bigStat: { example: { type: "bigStat", value: "42%", label: "...", delta: "..." }, use: "one number that matters, large" },
  prosCons: { example: { type: "prosCons", pros: { title: "...", items: ["..."] }, cons: { title: "...", items: ["..."] } }, use: "two sides weighed against each other" },
  table: { example: { type: "table", headers: ["...", "..."], rows: [["...", "..."]] }, use: "things compared along the same lines; every row as long as the headers" },
  metrics: { example: { type: "metrics", stats: [{ label: "...", value: "...", delta: "..." }] }, use: "a few numbers side by side" },
  lineChart: { example: { type: "lineChart", title: "...", xLabels: ["...", "..."], series: [{ name: "...", values: [1, 2], color: "primary" }] }, use: "values changing over an ordered axis; each series as long as xLabels; color primary, info, success or accent" },
  areaChart: { example: { type: "areaChart", title: "...", xLabels: ["...", "..."], series: [{ name: "...", values: [1, 2], color: "primary" }] }, use: "like lineChart, with the area filled" },
  barChart: { example: { type: "barChart", title: "...", items: [{ label: "...", value: 3, displayValue: "3" }] }, use: "amounts compared across categories" },
  stackedBar: { example: { type: "stackedBar", title: "...", categories: ["...", "..."], series: [{ name: "...", values: [1, 2], color: "primary" }] }, use: "parts of a whole across categories; each series as long as categories" },
  pie: { example: { type: "pie", title: "...", items: [{ label: "...", value: 60, displayValue: "60%" }, { label: "...", value: 40, displayValue: "40%" }] }, use: "shares of one whole, 2 to 8, every value above 0" },
  scatter: { example: { type: "scatter", title: "...", xLabel: "...", yLabel: "...", points: [{ x: 1, y: 2, label: "..." }] }, use: "how two measures go together across observations" },
  histogram: { example: { type: "histogram", title: "...", bins: [{ label: "0-9", count: 4 }, { label: "10-19", count: 7 }] }, use: "how often values fall in each range" },
  heatmap: { example: { type: "heatmap", title: "...", xLabels: ["...", "..."], yLabels: ["..."], values: [[0.2, 0.8]], minLabel: "Low", maxLabel: "High" }, use: "a value for each pair of two categories; one row per yLabel, each as long as xLabels" },
  radar: { example: { type: "radar", title: "...", axes: ["...", "...", "..."], series: [{ name: "...", values: [1, 2, 3], color: "primary" }] }, use: "a profile across 3 to 8 measures" },
  gauge: { example: { type: "gauge", value: 72, label: "...", detail: "..." }, use: "one real percentage or score from 0 to 100" },
  quiz: { example: { type: "quiz", question: "...", options: ["...", "...", "..."], correctIndex: 0, explanation: "..." }, use: "one multiple-choice question, each wrong option a real mistake, with why the answer is right" },
  cloze: { example: { type: "cloze", text: "The ... is [[the key part]], which ..." }, use: "a sentence with its key part in [[double brackets]], hidden until the card turns over; one or two gaps, each a part worth recalling" },
  fillInBlank: { example: { type: "fillInBlank", prompt: "The ___ is ...", answer: "...", options: ["...", "..."], explanation: "..." }, use: "a sentence with a gap (___) to fill" },
  matching: { example: { type: "matching", prompt: "...", pairs: [{ left: "...", right: "..." }, { left: "...", right: "..." }, { left: "...", right: "..." }] }, use: "3 to 8 pairs to match" },
  orderExercise: { example: { type: "orderExercise", prompt: "...", items: ["...", "...", "..."], correctOrder: [2, 0, 1] }, use: "items to put in order; correctOrder lists the item indexes in the right order" },
  labelPicture: {
    example: { type: "labelPicture", prompt: "...", url: "/v1/assets/ASSET-ID", caption: "...", marks: [{ mark: "A", answer: "first part" }, { mark: "B", answer: "second part" }], extra: ["a part on no mark"], explanation: "..." },
    use: "a picture from the source whose own printed marks (A, B, 1, 2) the person names, picking among every mark's answer and the extra names, mixed; 2 to 8 marks, up to 4 extra. Only when the sources' text says what each mark stands for (a key, a caption, the passage explaining the picture): you cannot see the picture, so never guess a mark. The caption never gives an answer away",
  },
  drawLine: {
    example: { type: "drawLine", prompt: "...", axes: { x: { min: 0, max: 10, step: 1, label: "..." }, y: { min: 0, max: 50, step: 5, label: "..." } }, line: [[0, 5], [8, 45]], explanation: "..." },
    use: "a straight line the person draws on a grid by placing two points: a rate or straight-line relation the sources give with numbers. The prompt gives what is needed to draw it; each axis at most 24 steps; line is two different grid points the right line goes through, well apart",
  },
  flashcards: { example: { type: "flashcards", cards: [{ front: "...", back: "..." }] }, use: "one card to recall and flip: the bit is the card, so a deck is one bit per card" },
  reveal: { example: { type: "reveal", title: "...", blocks: [{ type: "text", text: "..." }] }, use: "something to think about first, then open: an answer, a worked step" },
  servingsScaler: { example: { type: "servingsScaler", baseServings: 4, ingredients: [{ quantity: 100, unit: "g", name: "..." }] }, use: "amounts the person can scale, from a yield the source states" },
  timer: { example: { type: "timer", label: "...", seconds: 300 }, use: "a timing the source states, to run while doing it" },
  figure: { example: { type: "figure", url: "/v1/assets/ASSET-ID", caption: "...", credit: "Page 3" }, use: "a picture taken from the source itself, by its asset URL" },
  image: { example: { type: "image", url: "/v1/assets/ASSET-ID", caption: "...", systemIcon: "photo" }, use: "a picture from the source, by its asset URL (never a web address); figure is usually better" },
  gallery: { example: { type: "gallery", images: [{ url: "/v1/assets/ASSET-ID", caption: "..." }, { url: "/v1/assets/ASSET-ID", caption: "..." }], columns: 2 }, use: "2 to 12 pictures from the source" },
  carousel: { example: { type: "carousel", items: [{ url: "/v1/assets/ASSET-ID", caption: "..." }, { url: "/v1/assets/ASSET-ID", caption: "..." }] }, use: "2 to 10 pictures from the source to swipe through" },
  clip: { example: { type: "clip", url: "https://...", startSeconds: 12, endSeconds: 34, title: "...", platform: "youtube" }, use: "a stretch of the source's own video" },
  video: { example: { type: "video", youtubeID: "...", title: "..." }, use: "the source's own YouTube video" },
  embed: { example: { type: "embed", platform: "youtube", url: "https://...", title: "..." }, use: "the source's own post or player" },
  linkCard: { example: { type: "linkCard", url: "https://...", title: "...", domain: "..." }, use: "a link the source gives" },
  linkPreview: { example: { type: "linkPreview", url: "https://...", title: "...", domain: "...", description: "..." }, use: "a richer card for a link the source gives; its imageURL, when given, is one of the source's /v1/assets/ pictures" },
  map: { example: { type: "map", title: "...", places: [{ name: "...", latitude: 48.85, longitude: 2.35, note: "..." }] }, use: "real places the source names, with true coordinates" },
};

/** The block types a card may hold, in the schema's order. */
export function cardBlockTypes(): string[] {
  return BLOCK_TYPES.filter((type) => !BLOCKS_NOT_ON_A_CARD.has(type));
}

/** The family a block belongs to, in words: what decides how many a bit may hold. */
export function blockFamily(type: string): string {
  if (MEDIA_BLOCKS.has(type)) return "media";
  if (CHART_BLOCKS.has(type)) return "chart";
  if (ASK_BLOCKS.has(type)) return "a question";
  if (HIDING_BLOCKS.has(type)) return "text";
  if (type === "table" || type === "prosCons") return "table";
  return "text";
}

/** Every block a card may hold, one line each: its shape and what it is for, grouped by family. */
export function blockCatalog(): string {
  const groups = new Map<string, string[]>();
  for (const type of cardBlockTypes()) {
    const shape = BLOCK_SHAPES[type];
    const line = shape ? `- ${JSON.stringify(shape.example)}: ${shape.use}` : `- {"type":"${type}"}`;
    const family = blockFamily(type);
    groups.set(family, [...(groups.get(family) ?? []), line]);
  }
  return [...groups.entries()].map(([family, lines]) => `${family === "text" ? "Text blocks (any number)" : `${capitalize(family)} (a main block: at most one per side)`}:\n${lines.join("\n")}`).join("\n");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
