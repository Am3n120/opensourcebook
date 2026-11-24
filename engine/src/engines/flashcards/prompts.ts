/**
 * Prompts for Open Sourcebook's own writer of a set of flashcards (engine/docs/flashcards.md).
 * A set is cards, each one screen doing one job; the planner splits the set
 * into sections, each section's writer returns its cards, each card citing
 * the passages it draws from by label, and a repair sees one card. The kinds
 * of card and the blocks are described from their registries (cards/kinds.ts,
 * cards/shapes.ts), never from a list kept here. The item context a plan
 * gives each output, the brief and the earlier outputs the person has seen,
 * is left out when empty.
 */
import { isAssetPath } from "../../assets";
import type { ByteDepth, ByteType } from "../../cards/blocks";
import { BLOCKS_NOT_ON_A_CARD, MAX_BLOCKS_PER_SIDE, SIDE_BUDGET } from "../../cards/contract";
import { cardKinds } from "../../cards/kinds";
import { blockCatalog } from "../../cards/shapes";
import { cutNotes, renderPassages, type Passage } from "../../sources/passages";
import { labelRanges, WHOLE_READ_CHARS } from "../../sources/reading";
import type { NodeSource, PriorOutput } from "../../studio/types";
import type { ResearchResult, SourceEnvelope } from "../../types/source";
import type { SetMetadata, StructurePlan } from "./types";

/** How many cards the set is to have and which kinds it takes. */
export interface CardTarget {
  /** Cards in the whole set: the number the person asked for, or a count fit to the sources. */
  cards: number;
  /** True when the person set the number (they were shown it); false when it was fit to the size of the sources. */
  asked: boolean;
  /** The kinds of card the set may use (ids from cards/kinds.ts); every kind when empty. */
  kinds: readonly string[];
  /** About how many of the cards one section holds, for a section's writer. */
  section?: number;
}

/** What every call is told: who it writes for and what it may draw on. The checks enforce the same. */
const BASE_GUIDANCE = `You write a set of flashcards in Open Sourcebook, the notebook that turns a person's own sources into things to learn from, as JSON for a phone and a web client, from the person's own sources.
Use only what the supplied sources and explicitly labeled supplemental research support. Do not invent facts, quotes, URLs, authors, charts, media or exemplar content. What you add to help the person understand goes in a background block, marked as not from their sources.
No placeholder URLs, fake charts or filler cards. If the sources cannot support a block, leave it out.
Every link must be a real URL present in the source envelope or supplemental references. Source references are labeled source; research references are labeled supplemental.
Never surface engine internals as content: no 'Access Level', 'Limitations', 'Fetched At', timestamps, raw source metadata, or naked source URLs in block text, titles, quote attributions, or definition sources. Provenance goes through cites, figure.credit, linkPreview, or the set's subtitle only.
Structure content with real blocks, not markdown syntax inside bodies: never paste fenced code (triple-backtick fences) into text, quote, or callout bodies — lift each fence into a code block ({"type":"code","language":"...","text":"..."} with the fence's language and body) — and never use markdown heading markers (#, ##) inside bodies when a heading block is warranted. Inline marks are allowed only in body text (text, quote, callout text, the items of bullets and numbered, and a definition's definition): **bold**, *italic*, \`code\`, [label](url) links and $math$, used sparingly. Kickers, headings and every other field are plain text with no marks.
Return JSON only. Match the block shapes exactly, including the type discriminator.`;

/** Rules on blocks the catalog's one line per block does not carry. */
const BLOCK_RULES = `- definition.source is a human-readable attribution (a title, an author, a page), never a URL.
- An embed with platform web carries the exact HTML string from source metadata.oembedJSON, and only when a successful JSON oEmbed response supplied non-empty html; never invent or rewrite provider HTML. Named platforms (youtube, tiktok, instagram, x, ...) render their official player from the url.
- Charts, tables and metrics use only real, finite, consistent values from the evidence.
- Inline [label](https://...) links use only URLs from the source envelope, supplemental references or the asset manifest.`;

/** What makes a card, from the set's own contract and the kinds this set takes. */
export function buildCardRules(kinds: readonly string[] = []): string {
  const allowed = kinds.filter((id) => cardKinds.get(id));
  return `Cards:
- The person swipes through the cards, one phone screen each. They try to answer from the front, turn the card over, check themselves against the back and mark it got it or not yet; the cards they miss come back until they stick.
- One job per card: one thing to remember (a fact, a term, a distinction, a set of steps, a formula, a way to solve a problem). Two things to remember are two cards.
- The front makes the person retrieve, not recognise: it asks (a question, a term to define, a cue, a hidden part, a problem to try) and never shows the answer or gives it away in its wording. Ask about what matters in the sources, not about how they happen to be worded.
- The back is the answer, short enough to check yourself against at a glance: the answer first, in a few words or one line, then at most a short why. An answer that needs a paragraph is more than one card.
- A card is {"kind":"...","front":[...],"back":[...],"cites":[...]}. A kind that does not turn over (a question that checks itself, a point that is only read) has no back.
- Each side fits one screen: 1 to ${MAX_BLOCKS_PER_SIDE} blocks (a back may be left out), at most one main block (media, a chart, a table or a question), and at most ${SIDE_BUDGET} units, where each block costs its shown characters (at least 40), plus 40 for every list item, table row, code line, option or pair after the first, plus 350 for media or a chart and 120 for metrics, bigStat or linkPreview. A side over that is said shorter or made two cards.
- A card never holds a ${[...BLOCKS_NOT_ON_A_CARD].join(", ")} block.
- cites: every card names the passages it draws from, {"passage":"P3"}. When it states something from a passage, add "quote" with a few words copied exactly from that passage and "block" with the index of the block that holds that claim, counted over the front and then the back (the first back block is number front.length). The person sees a cite at the end of the block it names, so the cite of an answer goes on a back block and never gives the answer away on the front. Cite only passages that say what the card says. Pictures and clips from the source are cited by the engine.
- A background block (what a term usually means, an example of your own, how such a number is usually read) is never cited; everything else on a card comes from the sources.
Kinds of card (use only these):
${cardKinds.catalog(allowed.length > 0 ? allowed : cardKinds.ids())}
Blocks:
${blockCatalog()}
${BLOCK_RULES}`;
}

/** A kind the set takes, for the example of a section's answer. */
function exampleKind(kinds: readonly string[]): string {
  return kinds.find((id) => cardKinds.get(id)) ?? cardKinds.ids()[0] ?? "recall";
}

/** The number of cards in words, as the planner reads it. */
function targetLine(target: CardTarget): string {
  return target.asked
    ? `The set has ${target.cards} card${target.cards === 1 ? "" : "s"}: the number the person asked for. Make that many unless the sources clearly hold fewer things worth remembering, and never pad with trivia or repeats to reach it.`
    : `About ${target.cards} card${target.cards === 1 ? "" : "s"} fits sources of this size: make as many as the sources hold things worth remembering, never padding to reach a number or cramming to stay under one.`;
}

/** The share of the set one section's writer is asked for. */
function sectionTargetLine(target: CardTarget): string {
  const share = target.section ?? target.cards;
  return `About ${share} card${share === 1 ? "" : "s"} for this section (the set has ${target.asked ? "" : "about "}${target.cards} in all): fewer when its part of the sources holds fewer things worth remembering, never filler.`;
}

export function buildSourceBlockGuidance(source: SourceEnvelope): string {
  switch (source.kind) {
    case "youtube":
      return "Video: cards on what the transcript explains and shows. A clip of the source video, with its frame as posterURL, can show the moment a card asks about. oEmbed metadata alone supports no card.";
    case "paper":
    case "pdf":
      return "Paper: cards on the question it asks, the method, the findings with their real numbers, the limits and what the result means. A table or chart on a back uses only values the paper gives; a figure from the paper is the front of a picture card.";
    case "recipe":
      return "Recipe: cards on what goes in and in what amount, the steps in order (a steps card), and timings and temperatures as the source states them. Do not invent substitutions, nutrition or cooking times.";
    case "spreadsheet":
      return "Spreadsheet: cards on what the values show (which is largest, how two compare, how they change); a chart or metrics block on a back uses only the sheet's values with its own labels. Never fabricate a trend or a percentage.";
    case "thread":
    case "social":
      return "Post or thread: cards only on what the post's own text says; its title and details alone support no card.";
    case "article":
    case "web":
      return "Web page: cards on the page's own claims, terms, steps and distinctions, not on how the page is laid out or published.";
    default:
      return "Choose the kinds of card and the blocks the evidence warrants.";
  }
}

/// Compact one-line-per-asset manifest plus the media-block contract. Empty
/// when the source harvested no assets, so prompts stay unchanged there.
export function buildAssetManifestGuidance(source: SourceEnvelope): string {
  // Only pictures Open Sourcebook keeps can be shown (cards/pictures.ts); one kept only as a web address is left out.
  const assets = (source.assets ?? []).filter((asset) => isAssetPath(asset.url));
  if (assets.length === 0) return "";
  const lines = assets.map((asset) => {
    const parts = [`kind=${asset.kind}`];
    if (asset.page !== undefined) parts.push(`page=${asset.page}`);
    if (asset.timestampMs !== undefined) parts.push(`timestampMs=${asset.timestampMs}`);
    parts.push(`url=${asset.url}`);
    if (asset.caption) parts.push(`caption=${asset.caption.replace(/\s+/g, " ").trim()}`);
    return `[asset] ${parts.join(" ")}`;
  });
  return `Harvested source assets (REAL media extracted from the source; this manifest is complete):
${lines.join("\n")}
You may embed media ONLY through figure/gallery/clip/carousel/labelPicture blocks or linkPreview.imageURL and ONLY with these exact URLs. A picture is always one of these /v1/assets/ addresses: a web address of a picture is never shown, so never write one; a clip's url alone is the source video's own address. Never invent, guess, or transform media URLs.
Each asset may appear in AT MOST ONE block in the whole set — never reuse the same asset URL across figure/clip.posterURL/carousel/linkPreview. When the manifest has exactly one image, place it once (prefer figure) and omit imageURL elsewhere rather than repeating it.
Media block JSON shapes:
figure {"type":"figure","url":"/v1/assets/<id>","caption":"...","credit":"Page 12","systemIcon":"..."} — for PDF figures and charts; use credit for provenance such as "Page 12".
gallery {"type":"gallery","images":[{"url":"/v1/assets/<id>","caption":"..."}],"columns":2} — for image sets; 2-12 images, columns 2 or 3.
clip {"type":"clip","url":"<source video URL>","startSeconds":12,"endSeconds":34,"title":"...","posterURL":"/v1/assets/<id>","platform":"youtube"} — for video time ranges; url must be the source video URL, platform is youtube|tiktok|instagram|vimeo|web. When the manifest carries a frame asset whose timestampMs matches the clip's startSeconds (chapter boundary), posterURL MUST be that frame asset — a real frame from that moment beats a bare player.
A picture belongs on the card that asks about it (the front of a picture card) or on the card whose answer it shows. A figure's caption never gives away the answer its card asks for.`;
}

/** What a plan item adds to the prompts. Empty fields add nothing. */
export interface NodePromptContext {
  /** The item's brief, written by the planning agent and editable by the user. */
  brief?: string;
  /** Earlier outputs the learner has already seen. */
  assumes?: PriorOutput[];
}

export function buildNodeContextGuidance(context: NodePromptContext = {}): string {
  const lines: string[] = [];
  const brief = context.brief?.trim();
  if (brief) lines.push(`Brief for this output (from the learner's plan; follow it within the evidence):\n${brief}`);
  const assumes = context.assumes ?? [];
  if (assumes.length > 0) {
    lines.push(
      `The learner has already been through these outputs; make cards that help them remember what those taught, and do not explain it again from the start:\n${assumes
        .map((prior) => `- ${prior.type} "${prior.title}": ${prior.summary}`)
        .join("\n")}`,
    );
  }
  return lines.join("\n");
}

/** What the item can cite, labelled P1, P2, ...; the envelope's own text is left out so the source is sent once. */
export interface PromptEvidence {
  passages: Passage[];
  /** The item's sources, for what the passages leave out (`cutNotes`). */
  sources?: NodeSource[];
  /**
   * A map of the item's passages (`renderMap`), shown instead of them when
   * the item is too long to read in one call; the planner then names the
   * range each section covers.
   */
  map?: { text: string; passages: number; chars: number };
  /** Said before the passages, e.g. that they are a sample of a section's range (`spreadNote`). */
  note?: string;
  /** Every passage of the item, when `passages` is only a section's share; labels in the plan are read against these. */
  all?: Passage[];
}

/** The plan as writers see it: each section's range as labels ("P12–P40"), not passage ids. */
function planForPrompt(plan: StructurePlan, all: Passage[]): StructurePlan {
  return {
    ...plan,
    sections: plan.sections.map(({ passages, range: _range, ...section }) => {
      if (!passages?.length) return section;
      const ids = new Set(passages);
      return { ...section, covers: labelRanges(all.filter((passage) => ids.has(passage.id)), all) };
    }),
  };
}

function envelopeForPrompt(source: SourceEnvelope): Omit<SourceEnvelope, "text" | "originalText"> {
  const { text: _text, originalText: _originalText, ...rest } = source;
  return rest;
}

function passagesSection(evidence: PromptEvidence): string {
  const before = [...cutNotes(evidence.sources ?? []), ...(evidence.note ? [evidence.note] : [])];
  if (evidence.map) return [...before, mapBody(evidence.map)].join("\n");
  if (evidence.passages.length === 0) return "Passages: none (the source has no readable text; cite nothing).";
  return [...before, passagesBody(evidence)].join("\n");
}

function mapBody(map: NonNullable<PromptEvidence["map"]>): string {
  return `The source is too long to read here in one go (${map.passages} passages, ${map.chars.toLocaleString("en-US")} characters). This is a map of all of it: each line is a run of passages, with their labels, pages when known, size and opening words. Each section's writer reads only the passages of its own range.\n${map.text}`;
}

/**
 * About how much of a long source one section stands for at the thorough
 * depths (a set of dozens of cards and more), so a large set over a book has
 * as many sections as the book needs (engine/docs/long-sources.md). Smaller
 * sets skim: their few sections each cover a long range and read a spread of
 * it. On the real runs of Nov 13, 2026 a section wrote about 7k tokens
 * whether it covered 12,000 or 6,000 characters (and timed out at 60 s about
 * as often), so a smaller share only adds calls; how long a section's writing
 * takes is the provider's timeout to meet, not this number's.
 */
export const LONG_SECTION_CHARS: Partial<Record<ByteDepth, number>> = { deep: 12_000, veryDeep: 10_000 };

function passagesBody(evidence: PromptEvidence): string {
  return `Passages (the source's text, labelled for citing). Labels and the passages themselves are for cites only: the learner never sees them, so no block text may name a label or point at a passage ("P3 says", "the passage above"); a word the subject itself uses is fine:\n${renderPassages(evidence.passages)}`;
}

/** What a section of a long item says about its range, added to the plan's shape. */
function sectionRangeRules(depth: ByteDepth): string {
  const share = LONG_SECTION_CHARS[depth];
  const size = share
    ? `A set this large covers all of the source: give it about one section per ${share.toLocaleString("en-US")} characters of the map, each with its own range.`
    : "A set this size skims: a few sections may each cover a long range.";
  return `Every section names "passages", the range of the map it covers, as labels: "P12-P40", or a list such as ["P12-P20","P31"]. Ranges follow the map's order, and together the sections cover every line of the map: nothing in the source is left out of the set. A section's writer reads its whole range when it is up to about ${WHOLE_READ_CHARS.toLocaleString("en-US")} characters and an even sample of it when it is longer. ${size}`;
}

export function buildStructurePrompt(
  source: SourceEnvelope,
  depth: ByteDepth,
  target: CardTarget,
  research: ResearchResult | undefined,
  exemplarSummaries: string[] = [],
  context: NodePromptContext = {},
  evidence: PromptEvidence = { passages: [] },
): string {
  return `${buildCardRules(target.kinds)}
Plan the sections of a set of flashcards. A section is a run of cards on one topic or part of the sources, in the order the person should meet them; each section is written separately into cards. ${targetLine(target)} Plan sections that together hold that many cards, about 3 to 12 each; a set of a few cards is one section. No section may promise what the sources do not hold.
For each section, purpose says what its cards make the person able to recall, and suggestedBlocks lists the kinds of card (and any main block, such as a figure or a table) its cards call for.
${buildSourceBlockGuidance(source)}
${buildAssetManifestGuidance(source)}
${buildNodeContextGuidance(context)}
Source envelope (without its text):
${JSON.stringify(envelopeForPrompt(source))}
${passagesSection(evidence)}
Supplemental research (use only if present and relevant):
${JSON.stringify(research ?? { claims: [], references: [] })}
Caller-supplied exemplar summaries (style guidance only; do not copy content):
${JSON.stringify(exemplarSummaries)}
Return JSON matching StructurePlan: type, title, subtitle, optional sourceDomain/author/tags/excerpt/durationText, and sections [{id,title,purpose,suggestedBlocks${evidence.map ? ",passages" : ""}}].${evidence.map ? `\n${sectionRangeRules(depth)}` : ""}`;
}

export function buildSectionPrompt(
  source: SourceEnvelope,
  plan: StructurePlan,
  sectionID: string,
  target: CardTarget,
  research: ResearchResult | undefined,
  exemplarSummaries: string[] = [],
  context: NodePromptContext = {},
  evidence: PromptEvidence = { passages: [] },
): string {
  const shown = planForPrompt(plan, evidence.all ?? evidence.passages);
  const section = shown.sections.find((candidate) => candidate.id === sectionID);
  return `${buildCardRules(target.kinds)}
Write only section ${sectionID} of a set of flashcards, as cards. Players show the section's title small above each of its cards, so never repeat it as a heading; most cards need no heading at all. Every card you write is about this section's purpose; a point that belongs to another section is left to it. ${sectionTargetLine(target)}
Return JSON {"sectionID":"${sectionID}","cards":[{"kind":"${exampleKind(target.kinds)}","front":[...],"back":[...],"cites":[{"passage":"P1","quote":"...","block":1}]}]}, the cards in the order the person should meet them.
${buildSourceBlockGuidance(source)}
${buildAssetManifestGuidance(source)}
${buildNodeContextGuidance(context)}
Section plan: ${JSON.stringify(section)}
Set plan: ${JSON.stringify(shown)}
Source envelope (without its text): ${JSON.stringify(envelopeForPrompt(source))}
${passagesSection(evidence)}
Supplemental research: ${JSON.stringify(research ?? { claims: [], references: [] })}
Caller-supplied exemplar summaries (style only): ${JSON.stringify(exemplarSummaries)}
Media blocks require real URLs or YouTube IDs from evidence; figure, gallery, clip and carousel blocks (and linkPreview.imageURL) may only embed URLs from the harvested asset manifest above (or source/labeled supplemental evidence URLs).`;
}

/**
 * Repair of one card: only that card, its errors (paths relative to the card)
 * and the passages it cites go to the model, so the call stays small however
 * large the set is. The answer replaces the card; a card split in two comes
 * back as two.
 */
export function buildCardRepairPrompt(
  card: unknown,
  errors: Array<{ path: string; code: string; message: string }>,
  source: SourceEnvelope,
  kinds: readonly string[] = [],
  evidence: PromptEvidence = { passages: [] },
  context: { section?: string; before?: string; after?: string } = {},
): string {
  const around = [
    context.section ? `It is in the section "${context.section}".` : "",
    context.before ? `The card before it asks: ${context.before}` : "",
    context.after ? `The card after it asks: ${context.after}` : "",
  ].filter(Boolean);
  return `${buildCardRules(kinds)}
${buildAssetManifestGuidance(source)}
Repair this card of a set of flashcards. Fix only the listed errors and keep everything that is not wrong. Preserve supported content and remove unsupported content rather than inventing replacements. A side over budget or with two main blocks, or a card doing two jobs, becomes two or more cards, in order; a card that does not do what its kind needs changes its sides or its kind; a quote that is not in its passage is copied exactly or dropped. Keep the card's cites, written {"passage":"P3","quote":"...","block":0}, with block counted over the front and then the back.
Return JSON {"cards":[...]}: the card or cards that take this one's place, in order. Do not return any other card of the set.
${around.join("\n")}
Validation errors (paths are inside this card):
${JSON.stringify(errors)}
${passagesSection(evidence)}
Card JSON:
${JSON.stringify(card)}`;
}

export function buildDeliverySystemPrompt(): string {
  return `${BASE_GUIDANCE}
The set is delivered to clients that show one card per screen: the person swipes between cards and turns each one over.`;
}

export function buildMetadataFromSource(source: SourceEnvelope, fallbackType: ByteType): SetMetadata {
  const firstLine = source.text
    .split(/\n|\.|!/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return {
    type: source.kind === "unknown" || source.kind === "text" || source.kind === "web" || source.kind === "pdf" || source.kind === "youtube" || source.kind === "social" ? fallbackType : source.kind,
    title: source.title ?? firstLine?.slice(0, 140) ?? "Saved source",
    subtitle: source.author ? `${source.author}${source.sourceDomain ? ` · ${source.sourceDomain}` : ""}` : source.sourceDomain ?? "Saved source",
    ...(source.sourceDomain ? { sourceDomain: source.sourceDomain } : {}),
    ...(source.author ? { author: source.author } : {}),
    tags: [],
    ...(source.excerpt ? { excerpt: source.excerpt } : {}),
    ...(source.metadata.durationText ? { durationText: source.metadata.durationText } : {}),
  };
}
