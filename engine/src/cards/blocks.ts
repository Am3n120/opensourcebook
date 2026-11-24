/**
 * The block vocabulary cards, chat replies and older outputs are drawn with
 * (ios/OpenSourcebook/Models/Block.swift on the phone), and the version 1 page payload
 * outputs were stored as before screens. A set of cards itself, version 3,
 * is in contract.ts and engine/docs/flashcards.md. Some names here (ByteBlock,
 * ByteType, ByteDepth) are from when the format was the byte; they name the
 * vocabulary, the source's kind and Open Sourcebook's own writer's depth tiers.
 */

export type ByteType =
  | "quote"
  | "video"
  | "paper"
  | "recipe"
  | "spreadsheet"
  | "thread"
  | "podcast"
  | "travel"
  | "meeting"
  | "note"
  | "article"
  | "image"
  | "link"
  | "other";

export const BYTE_TYPES: readonly ByteType[] = [
  "quote",
  "video",
  "paper",
  "recipe",
  "spreadsheet",
  "thread",
  "podcast",
  "travel",
  "meeting",
  "note",
  "article",
  "image",
  "link",
  "other",
];

export type GenerationDepth = "saveOnly" | "light" | "standard" | "deep" | "auto";
export const GENERATION_DEPTHS: readonly GenerationDepth[] = [
  "saveOnly",
  "light",
  "standard",
  "deep",
  "auto",
];

export type ByteDepth = "saveOnly" | "tiny" | "light" | "medium" | "deep" | "veryDeep";
export const BYTE_DEPTHS: readonly ByteDepth[] = [
  "saveOnly",
  "tiny",
  "light",
  "medium",
  "deep",
  "veryDeep",
];

export type ByteStatus =
  | { type: "ready" }
  | { type: "queued" }
  | { type: "generating"; progress: number }
  | { type: "saveOnly" }
  | { type: "archived" };

export type CalloutStyle = "info" | "success" | "warning" | "primary";
export const CALLOUT_STYLES: readonly CalloutStyle[] = [
  "info",
  "success",
  "warning",
  "primary",
];

export type SeriesColor = "primary" | "info" | "success" | "accent";
export const SERIES_COLORS: readonly SeriesColor[] = [
  "primary",
  "info",
  "success",
  "accent",
];

export type ClipPlatform = "youtube" | "tiktok" | "instagram" | "vimeo" | "web";
export const CLIP_PLATFORMS: readonly ClipPlatform[] = [
  "youtube",
  "tiktok",
  "instagram",
  "vimeo",
  "web",
];

export type EmbedPlatform =
  | "tiktok"
  | "instagram"
  | "x"
  | "threads"
  | "pinterest"
  | "reddit"
  | "spotify"
  | "youtube"
  | "web";
export const EMBED_PLATFORMS: readonly EmbedPlatform[] = [
  "tiktok",
  "instagram",
  "x",
  "threads",
  "pinterest",
  "reddit",
  "spotify",
  "youtube",
  "web",
];

export interface ByteStat {
  id: string;
  label: string;
  value: string;
  delta?: string;
}

export interface LineSeries {
  name: string;
  values: number[];
  color: SeriesColor;
}

export interface BarItem {
  label: string;
  value: number;
  displayValue: string;
}

export interface TimelineItem {
  label: string;
  title: string;
  detail?: string;
}

export interface ScaledIngredient {
  quantity?: number | null;
  unit: string;
  name: string;
}

export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
}

export interface PieItem {
  label: string;
  value: number;
  displayValue?: string;
}

export interface StackedBarSeries {
  name: string;
  values: number[];
  color: SeriesColor;
}

export interface HistogramBin {
  label: string;
  count: number;
}

export interface RadarSeries {
  name: string;
  values: number[];
  color: SeriesColor;
}

export interface Flashcard {
  front: string;
  back: string;
}

export interface MatchingPair {
  left: string;
  right: string;
}

export interface KickerBlock {
  type: "kicker";
  text: string;
}
export interface HeadingBlock {
  type: "heading";
  text: string;
}
export interface SubheadingBlock {
  type: "subheading";
  text: string;
}
export interface TextBlock {
  type: "text";
  text: string;
}
export interface QuoteBlock {
  type: "quote";
  text: string;
  author?: string;
  source?: string;
}
export interface DividerBlock {
  type: "divider";
}
export interface ContinuationBlock {
  type: "continuation";
}
export interface SpacerBlock {
  type: "spacer";
}
export interface ImageBlock {
  type: "image";
  url?: string;
  caption?: string;
  systemIcon: string;
}
export interface VideoBlock {
  type: "video";
  youtubeID: string;
  title?: string;
}
export interface AudioBlock {
  type: "audio";
  url: string;
  title: string;
  subtitle?: string;
}
export interface LinkCardBlock {
  type: "linkCard";
  url: string;
  title: string;
  domain: string;
}
export interface CalloutBlock {
  type: "callout";
  style: CalloutStyle;
  title?: string;
  text: string;
}
export interface BulletsBlock {
  type: "bullets";
  items: string[];
}
export interface NumberedBlock {
  type: "numbered";
  items: string[];
}
export interface MetricsBlock {
  type: "metrics";
  stats: ByteStat[];
}
export interface LineChartBlock {
  type: "lineChart";
  title?: string;
  xLabels: string[];
  series: LineSeries[];
}
export interface BarChartBlock {
  type: "barChart";
  title?: string;
  items: BarItem[];
}
export interface TableBlock {
  type: "table";
  headers: string[];
  rows: string[][];
}
export interface TimelineBlock {
  type: "timeline";
  items: TimelineItem[];
}
export interface CodeBlock {
  type: "code";
  text: string;
  language: string;
}
export interface BigStatBlock {
  type: "bigStat";
  value: string;
  label: string;
  delta?: string;
}
export interface ChecklistBlock {
  type: "checklist";
  items: string[];
}
export interface QuizBlock {
  type: "quiz";
  question: string;
  options: string[];
  correctIndex: number;
  explanation?: string;
}
export interface ServingsScalerBlock {
  type: "servingsScaler";
  baseServings: number;
  ingredients: ScaledIngredient[];
}
export interface TimerBlock {
  type: "timer";
  label: string;
  seconds: number;
}
export interface RevealBlock {
  type: "reveal";
  title: string;
  blocks: ByteBlock[];
}
export interface OrderExerciseBlock {
  type: "orderExercise";
  prompt: string;
  items: string[];
  correctOrder: number[];
}
export interface GalleryImageItem {
  url: string;
  caption?: string;
}
export interface FigureBlock {
  type: "figure";
  url: string;
  caption?: string;
  credit?: string;
  systemIcon?: string;
}
export interface GalleryBlock {
  type: "gallery";
  images: GalleryImageItem[];
  columns?: number;
}
export interface ClipBlock {
  type: "clip";
  url: string;
  startSeconds: number;
  endSeconds?: number;
  title?: string;
  posterURL?: string;
  platform?: ClipPlatform;
}
export interface HeatmapBlock {
  type: "heatmap";
  title?: string;
  xLabels: string[];
  yLabels: string[];
  values: number[][];
  minLabel?: string;
  maxLabel?: string;
}
export interface ScatterBlock {
  type: "scatter";
  title?: string;
  xLabel?: string;
  yLabel?: string;
  points: ScatterPoint[];
}
export interface PieBlock {
  type: "pie";
  title?: string;
  items: PieItem[];
}
export interface AreaChartBlock {
  type: "areaChart";
  title?: string;
  xLabels: string[];
  series: LineSeries[];
}
export interface StackedBarBlock {
  type: "stackedBar";
  title?: string;
  categories: string[];
  series: StackedBarSeries[];
}
export interface GaugeBlock {
  type: "gauge";
  value: number;
  label: string;
  detail?: string;
}
export interface HistogramBlock {
  type: "histogram";
  title?: string;
  bins: HistogramBin[];
}
export interface RadarBlock {
  type: "radar";
  title?: string;
  axes: string[];
  series: RadarSeries[];
}
export interface FlashcardsBlock {
  type: "flashcards";
  cards: Flashcard[];
}
export interface FillInBlankBlock {
  type: "fillInBlank";
  prompt: string;
  answer: string;
  options?: string[];
  explanation?: string;
}
/** A sentence with its key part hidden: each [[...]] is a gap the person recalls before the card turns over. */
export interface ClozeBlock {
  type: "cloze";
  text: string;
}
export interface MatchingBlock {
  type: "matching";
  prompt?: string;
  pairs: MatchingPair[];
}
/**
 * Label a picture on a card: a picture from the source whose parts carry
 * marks of its own (A, B, 1, 2), and for each mark the person picks what it
 * is among the names offered (every mark's answer and the `extra` names,
 * mixed). Checked and graded as the quiz's label kind (cards/asks.ts).
 */
export interface LabelPictureBlock {
  type: "labelPicture";
  prompt?: string;
  url: string;
  caption?: string;
  marks: { mark: string; answer: string }[];
  extra?: string[];
  explanation?: string;
}
export interface GridAxis {
  min: number;
  max: number;
  step: number;
  label?: string;
}
/**
 * Draw a line on a card: a grid where the person puts two points, and the
 * line through them is their answer. `line` is two grid points the right
 * line goes through. Checked and graded as the quiz's graph kind.
 */
export interface DrawLineBlock {
  type: "drawLine";
  prompt: string;
  axes: { x: GridAxis; y: GridAxis };
  line: [number, number][];
  explanation?: string;
}
export interface ProsConsBlock {
  type: "prosCons";
  pros: { title?: string; items: string[] };
  cons: { title?: string; items: string[] };
}
export interface DefinitionBlock {
  type: "definition";
  term: string;
  definition: string;
  source?: string;
}
/**
 * Explanation that is not in the sources: general knowledge that helps the
 * person understand (what a term usually means, how such a number is
 * usually read). The person sees it marked as not from their source; it
 * carries no cite, and it never states a fact about the source.
 */
export interface BackgroundBlock {
  type: "background";
  title?: string;
  text: string;
}
export interface EmbedBlock {
  type: "embed";
  platform: EmbedPlatform;
  url: string;
  title?: string;
  /** Verbatim provider HTML for generic web embeds; named platforms omit it. */
  html?: string;
}
export interface LinkPreviewBlock {
  type: "linkPreview";
  url: string;
  title: string;
  domain: string;
  description?: string;
  imageURL?: string;
}
export interface CarouselBlock {
  type: "carousel";
  items: GalleryImageItem[];
}
export interface MapBlock {
  type: "map";
  title?: string;
  places: { name: string; latitude: number; longitude: number; note?: string }[];
}
export interface HeroBlock {
  type: "hero";
  url: string;
  title?: string;
  subtitle?: string;
}
export interface TocBlock {
  type: "toc";
  title?: string;
  items: string[];
}
export interface MathBlock {
  type: "math";
  latex: string;
  caption?: string;
}
export interface AudioClipBlock {
  type: "audioClip";
  url: string;
  startSeconds?: number;
  endSeconds?: number;
  title?: string;
}

/** Codable tagged union matching ios/OpenSourcebook/Models/Block.swift. */
export type ByteBlock =
  | KickerBlock
  | HeadingBlock
  | SubheadingBlock
  | TextBlock
  | QuoteBlock
  | DividerBlock
  | ContinuationBlock
  | SpacerBlock
  | ImageBlock
  | VideoBlock
  | AudioBlock
  | LinkCardBlock
  | CalloutBlock
  | BulletsBlock
  | NumberedBlock
  | MetricsBlock
  | LineChartBlock
  | BarChartBlock
  | TableBlock
  | TimelineBlock
  | CodeBlock
  | BigStatBlock
  | ChecklistBlock
  | QuizBlock
  | ServingsScalerBlock
  | TimerBlock
  | RevealBlock
  | OrderExerciseBlock
  | FigureBlock
  | GalleryBlock
  | ClipBlock
  | HeatmapBlock
  | ScatterBlock
  | PieBlock
  | AreaChartBlock
  | StackedBarBlock
  | GaugeBlock
  | HistogramBlock
  | RadarBlock
  | FlashcardsBlock
  | FillInBlankBlock
  | LabelPictureBlock
  | DrawLineBlock
  | ClozeBlock
  | MatchingBlock
  | ProsConsBlock
  | DefinitionBlock
  | BackgroundBlock
  | EmbedBlock
  | LinkPreviewBlock
  | CarouselBlock
  | MapBlock
  | HeroBlock
  | TocBlock
  | MathBlock
  | AudioClipBlock;

/**
 * The version 1 page: one long scroll of blocks, as `read` and `bits` outputs
 * were stored before Nov 12, 2026. Never written for a new output; it is read
 * from old rows (upgrade.ts cuts it into bits) and sent to the phone build that
 * only knows pages (`/v1/jobs` `result`). Optional values are omitted in JSON.
 */
export interface PagePayload {
  id: string;
  type: ByteType;
  title: string;
  subtitle: string;
  sourceDomain?: string;
  author?: string;
  timeAgo: string;
  tags: string[];
  status: ByteStatus;
  depth?: GenerationDepth;
  screensCount?: number;
  durationText?: string;
  thumbnailName?: string;
  excerpt?: string;
  ingredients?: string[];
  steps?: string[];
  difficulty?: string;
  quoteText?: string;
  quoteAuthor?: string;
  keyPoints?: string[];
  stats?: ByteStat[];
  blocks: ByteBlock[];
  byteDepth: ByteDepth;
}

export interface DepthTarget {
  generationDepth: GenerationDepth;
  byteDepth: ByteDepth;
  research: boolean;
}

/** What each depth is and whether it researches. Depth sizes Open Sourcebook's own writer's sections; it never sets a count of cards. */
export const DEPTH_TARGETS: Record<Exclude<GenerationDepth, "auto">, DepthTarget> = {
  saveOnly: {
    generationDepth: "saveOnly",
    byteDepth: "saveOnly",
    research: false,
  },
  light: {
    generationDepth: "light",
    byteDepth: "light",
    research: false,
  },
  standard: {
    generationDepth: "standard",
    byteDepth: "medium",
    research: true,
  },
  deep: {
    generationDepth: "deep",
    byteDepth: "deep",
    research: true,
  },
};

export const BYTE_DEPTH_TARGETS: Record<ByteDepth, DepthTarget> = {
  saveOnly: DEPTH_TARGETS.saveOnly,
  tiny: {
    generationDepth: "light",
    byteDepth: "tiny",
    research: false,
  },
  light: DEPTH_TARGETS.light,
  medium: DEPTH_TARGETS.standard,
  deep: DEPTH_TARGETS.deep,
  veryDeep: {
    generationDepth: "deep",
    byteDepth: "veryDeep",
    research: true,
  },
};

export const BYTE_DEPTH_ORDER: readonly ByteDepth[] = [
  "saveOnly",
  "tiny",
  "light",
  "medium",
  "deep",
  "veryDeep",
];

export function depthRank(depth: ByteDepth): number {
  return BYTE_DEPTH_ORDER.indexOf(depth);
}

export function minDepth(a: ByteDepth, b: ByteDepth): ByteDepth {
  return depthRank(a) <= depthRank(b) ? a : b;
}

/**
 * Extraction depthCaps are source-honesty ceilings: what the source evidence
 * alone can support. When the requested depth carries research (standard and
 * deeper), grounded research contributes real evidence the source does not
 * carry, so the ceiling lifts by exactly one tier — never more. saveOnly is
 * never lifted: with zero source evidence research has nothing to anchor to,
 * so the honesty ceiling holds.
 */
export function liftDepthCapForResearch(depthCap: ByteDepth): ByteDepth {
  if (depthCap === "saveOnly" || depthCap === "veryDeep") return depthCap;
  return BYTE_DEPTH_ORDER[depthRank(depthCap) + 1];
}

export function depthTargetForByteDepth(depth: ByteDepth): DepthTarget {
  return BYTE_DEPTH_TARGETS[depth];
}

export interface RepairSummary {
  attempted: boolean;
  attempts: number;
  fixedPaths: string[];
  remainingErrors: number;
  notes: string[];
}

export interface SchemaError {
  path: string;
  code: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface PageValidationResult {
  valid: boolean;
  value?: PagePayload;
  errors: SchemaError[];
  repair: RepairSummary;
  /** A compact instruction that can be passed to a repair-capable provider. */
  repairPromptSummary: string;
}
