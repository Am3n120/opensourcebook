/**
 * The blocks a written reply is made of (engine/docs/api.md, "Reply
 * blocks"): a paragraph, a heading, a list, a table, a note, maths, code,
 * a teach-back and a mind map.
 * Every way a reply is written (the person's agent, Open Sourcebook's own model) hands
 * over the same JSON: an ordered list of blocks,
 * each `{kind, ...}`, with inline marks inside its words and cites at the
 * end of the block, list item or table row they support. This file reads
 * that list into reply pieces, checking every cite word for word.
 *
 * Kinds sit in a registry: a new kind (a picture from a source, later) is
 * one registration here and one view in the web. Every stored block keeps
 * its words in plain `text`, so a client that does not know the kind can
 * still show it.
 *
 * Inline marks are the cards' (engine/docs/flashcards.md, "Inline marks"):
 * **bold**, *italic*, `code`, $maths$; and a link to a source spot,
 * written `[words](S1#4)` and stored `[words](cite:N)`, N indexing the
 * reply's cites. Any other link keeps only its words.
 */
import type { Cite } from "../cards/contract";
import { isRecord } from "../net";
import { quoteInPassage, sentenceSpot, type Passage } from "../sources/passages";

/** Most blocks one reply (or one call of the reply tool) holds. */
export const MAX_BLOCKS = 60;
const MAX_TEXT = 4_000;
const MAX_ITEMS = 40;
const MAX_ROWS = 40;
const MAX_COLUMNS = 8;
const MAX_CELL = 600;
/** What a passage label looks like: S1#4 for the person's agent, P3 for Open Sourcebook's own model. */
const LABEL = /^(?:S\d+#\d+|P\d+)$/;

export interface BadQuote {
  passage: string;
  quote: string;
  /** The passage label is not one there is among the ticked sources. */
  unknown?: boolean;
}

/** Where a block, an item or a row stands with its cites. */
export interface Cited {
  /** Indexes into the reply's `cites`, in the order written. */
  cites: number[];
  /** It cited the sources but no cite held up to the check: not shown as cited. */
  unchecked?: boolean;
}

export interface ListItem extends Cited {
  text: string;
}

export interface TableRow extends Cited {
  cells: string[];
}

export interface TextBlock extends Cited {
  kind: "text";
  text: string;
}

export interface HeadingBlock {
  kind: "heading";
  text: string;
}

export interface ListBlock extends Cited {
  kind: "list";
  ordered: boolean;
  items: ListItem[];
  /** The list in plain words, for a client that does not know lists. */
  text: string;
}

export interface TableBlock extends Cited {
  kind: "table";
  header: string[];
  rows: TableRow[];
  text: string;
}

export interface NoteBlock extends Cited {
  kind: "note";
  text: string;
}

export interface MathBlock extends Cited {
  kind: "math";
  /** The formula, LaTeX. */
  text: string;
}

/** What the writer adds that is not in the sources, shown marked as such; never cited. */
export interface BackgroundBlock {
  kind: "background";
  text: string;
}

export interface CodeBlock {
  kind: "code";
  text: string;
  lang?: string;
}

/** How one point of a teach-back stands against the sources. */
export type Verdict = "right" | "missing" | "wrong";

/** The verdicts in the order a teach-back shows them, each with the words that head its group. */
export const VERDICTS: readonly { verdict: Verdict; heading: string }[] = [
  { verdict: "right", heading: "What you got right" },
  { verdict: "missing", heading: "What you left out" },
  { verdict: "wrong", heading: "What the sources say differently" },
];

export interface TeachBackItem extends Cited {
  verdict: Verdict;
  text: string;
}

/**
 * Feedback on the person's own explanation of an idea: each point they made
 * or left out, sorted right, missing or wrong, cited at the spot in their
 * sources that shows it.
 */
export interface TeachBackBlock extends Cited {
  kind: "teachback";
  items: TeachBackItem[];
  /** The feedback in plain words, grouped, for a client that does not know it. */
  text: string;
}

/** One idea on a mind map: a short name, a sentence on it, and where the sources say it. */
export interface MindMapNode extends Cited {
  /** The writer's own id for it, unique in the map, that its links name. */
  id: string;
  /** The idea's name, a few words. */
  text: string;
  /** One sentence on the idea, when there is more to say than its name. */
  detail?: string;
}

/** How two ideas connect, in a few words read from one to the other ("causes", "is part of"). */
export interface MindMapLink {
  from: string;
  to: string;
  text: string;
}

/**
 * A map of the main ideas in the sources and how they connect. The first
 * node is the centre; every other node is linked, through others if need
 * be, to it. Each node carries the cites that open its passages.
 */
export interface MindMapBlock extends Cited {
  kind: "mindmap";
  nodes: MindMapNode[];
  links: MindMapLink[];
  /** The map in plain words, for a client that does not draw it. */
  text: string;
}

export type ReplyBlock = TextBlock | HeadingBlock | ListBlock | TableBlock | NoteBlock | MathBlock | CodeBlock | BackgroundBlock | TeachBackBlock | MindMapBlock;

/**
 * The cites of one reply. Every block that points at the sources resolves
 * its cites here, so one spot cited twice is one cite. It may start from
 * the cites earlier calls of the reply tool already used, so the indexes
 * of blocks already shown never move.
 */
export class CiteBook {
  readonly cites: Cite[];
  readonly bad: BadQuote[] = [];
  private readonly keyOf = new Map<string, number>();
  private readonly byLabel: Map<string, Passage>;

  constructor(
    passages: Passage[],
    private readonly strict: boolean,
    seed: readonly Cite[] = [],
  ) {
    this.byLabel = new Map(passages.map((passage) => [passage.label, passage]));
    this.cites = [];
    for (const cite of seed) this.add(cite);
  }

  /**
   * Cites as written, `[{passage, quote}]`, as indexes. An unknown passage
   * label is dropped; a quote not in its passage is reported and, when
   * strict, dropped (`lost`), else kept as a cite of the whole passage.
   */
  resolve(raw: unknown): { indexes: number[]; lost: boolean } {
    const indexes: number[] = [];
    let lost = false;
    for (const cite of Array.isArray(raw) ? raw : []) {
      if (!isRecord(cite) || typeof cite.passage !== "string") continue;
      const label = cite.passage.trim();
      const passage = this.byLabel.get(label);
      if (!passage) {
        if (this.strict) {
          this.bad.push({ passage: label, quote: typeof cite.quote === "string" ? cite.quote : "", unknown: true });
          lost = true;
        }
        continue;
      }
      let quote = typeof cite.quote === "string" && cite.quote.trim() ? cite.quote.trim() : undefined;
      if ((quote && !quoteInPassage(quote, passage)) || (this.strict && !quote)) {
        this.bad.push({ passage: passage.label, quote: quote ?? "" });
        quote = undefined;
        // Strict: a cite whose words are not in its passage is not shown as a cite.
        if (this.strict) {
          lost = true;
          continue;
        }
      }
      // The spot a reader highlights ends on whole sentences, whichever way the reply was written.
      const index = this.add(citeOf(passage, quote ? sentenceSpot(quote, passage) : undefined));
      if (!indexes.includes(index)) indexes.push(index);
    }
    return { indexes, lost };
  }

  /**
   * Words as stored: `[words](S1#4)` becomes a link to that passage's spot,
   * `[words](cite:N)`; a link to a passage there is not, or to anything
   * else, keeps only its words; stray passage labels such as "(S1#4)" go.
   */
  inline(text: string): string {
    const linked = text.replace(/\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/g, (_all, words: string, target: string) => {
      const passage = this.byLabel.get(target);
      if (!passage) {
        if (LABEL.test(target) && this.strict) this.bad.push({ passage: target, quote: "", unknown: true });
        return words;
      }
      const quote = quoteInPassage(words, passage) ? sentenceSpot(words, passage) : undefined;
      return `[${words}](cite:${this.add(citeOf(passage, quote))})`;
    });
    return linked
      .replace(/\s*[[(](?:passages?\s+)?(?:[SP]\d+(?:#\d+)?)(?:\s*(?:,|;|and|–|-)\s*[SP]?\d+(?:#\d+)?)*[\])]/g, "")
      .replace(/\bS\d+#\d+\b/g, "")
      .replace(/[ \t]+([.,;:!?])/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  private add(cite: Cite): number {
    const key = JSON.stringify(cite);
    let index = this.keyOf.get(key);
    if (index === undefined) {
      index = this.cites.push(cite) - 1;
      this.keyOf.set(key, index);
    }
    return index;
  }
}

function citeOf(passage: Passage, quote: string | undefined): Cite {
  const locator = passage.locator;
  return {
    sourceId: passage.sourceId,
    spot: locator?.cell ? "cell" : locator?.startMs !== undefined ? "moment" : "passage",
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(locator && Object.keys(locator).length > 0 ? { locator } : {}),
    ...(quote ? { quote } : {}),
  };
}

/** What a kind reads a raw block with. */
export interface BlockReader {
  book: CiteBook;
  /** Words with their inline marks, as stored, cut to `max`; "" when there are none. */
  words(raw: unknown, max?: number): string;
  /** The cites written on `raw` (its `cites`), checked. */
  cited(raw: Record<string, unknown>): Cited;
}

export interface BlockKind {
  /** The stored kind. */
  readonly kind: string;
  /** The kinds a writer may name for it; the stored kind is always one. */
  readonly names: readonly string[];
  /** What it is for, for the writer's prompt and tool. */
  readonly about: string;
  /** The block as stored, or what is wrong with it. */
  read(raw: Record<string, unknown>, name: string, reader: BlockReader): ReplyBlock | { problem: string };
  /** The block in plain words, for the reply's `text` and for prompts. */
  asText(block: Record<string, unknown>): string;
  /** Whether it can say something from the sources, and so carry cites. */
  readonly cites: boolean;
}

export class BlockKindRegistry {
  private readonly kinds = new Map<string, BlockKind>();
  private readonly byName = new Map<string, BlockKind>();

  register(kind: BlockKind): this {
    if (this.kinds.has(kind.kind)) throw new Error(`Block kind "${kind.kind}" is already registered.`);
    for (const name of new Set([kind.kind, ...kind.names])) {
      if (this.byName.has(name)) throw new Error(`Block name "${name}" is already taken.`);
      this.byName.set(name, kind);
    }
    this.kinds.set(kind.kind, kind);
    return this;
  }

  get(kind: string): BlockKind | undefined {
    return this.kinds.get(kind);
  }

  list(): BlockKind[] {
    return [...this.kinds.values()];
  }

  /** Every name a writer may use, for a tool's schema. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Raw blocks as stored blocks. A block with an unknown kind but words
   * reads as a paragraph; a block with nothing to show is a problem.
   */
  read(raw: unknown, book: CiteBook): { blocks: ReplyBlock[]; problems: string[] } {
    const blocks: ReplyBlock[] = [];
    const problems: string[] = [];
    const reader: BlockReader = {
      book,
      words: (value, max = MAX_TEXT) => (typeof value === "string" ? book.inline(value).slice(0, max) : ""),
      cited: (entry) => {
        const { indexes, lost } = book.resolve(entry.cites);
        return { cites: indexes, ...(lost && indexes.length === 0 ? { unchecked: true } : {}) };
      },
    };
    const list = Array.isArray(raw) ? raw : [];
    if (list.length > MAX_BLOCKS) problems.push(`A reply holds at most ${MAX_BLOCKS} blocks; ${list.length} were sent.`);
    list.slice(0, MAX_BLOCKS).forEach((entry, index) => {
      if (!isRecord(entry)) return void problems.push(`Block ${index + 1} is not an object.`);
      const name = typeof entry.kind === "string" ? entry.kind.trim() : "paragraph";
      const kind = this.byName.get(name) ?? this.byName.get("paragraph")!;
      const read = kind.read(entry, name, reader);
      if ("problem" in read) problems.push(`Block ${index + 1} (${name}): ${read.problem}`);
      else blocks.push(read);
    });
    return { blocks, problems };
  }

  /** A stored block in plain words; a kind nobody registered reads as its `text`. */
  asText(block: Record<string, unknown>): string {
    const kind = typeof block.kind === "string" ? this.kinds.get(block.kind) : undefined;
    if (kind) return kind.asText(block);
    return typeof block.text === "string" ? block.text : "";
  }
}

/** Words with link targets dropped, for plain text: "[the dates](cite:2)" reads "the dates". */
export function plainWords(text: string): string {
  return text.replace(/\[([^\]\n]+)\]\(cite:\d+\)/g, "$1");
}

function textOf(block: Record<string, unknown>): string {
  return typeof block.text === "string" ? plainWords(block.text) : "";
}

function listText(ordered: boolean, items: readonly { text: string }[]): string {
  return items.map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${plainWords(item.text)}`).join("\n");
}

function tableText(header: readonly string[], rows: readonly { cells: readonly string[] }[]): string {
  return [header, ...rows.map((row) => row.cells)].map((cells) => cells.map(plainWords).join(" | ")).join("\n");
}

function teachBackText(items: readonly { verdict: string; text: string }[]): string {
  return VERDICTS.flatMap(({ verdict, heading }) => {
    const group = items.filter((item) => item.verdict === verdict);
    return group.length ? [[`${heading}:`, ...group.map((item) => `- ${plainWords(item.text)}`)].join("\n")] : [];
  }).join("\n\n");
}

function mindMapText(nodes: readonly { id: string; text: string; detail?: string }[], links: readonly { from: string; to: string; text: string }[]): string {
  const name = new Map(nodes.map((node) => [node.id, plainWords(node.text)]));
  const [centre, ...rest] = nodes;
  if (!centre) return "";
  const head = `Mind map: ${name.get(centre.id)}${centre.detail ? `. ${plainWords(centre.detail)}` : ""}`;
  const ideas = rest.map((node) => `- ${name.get(node.id)}${node.detail ? `: ${plainWords(node.detail)}` : ""}`);
  const ties = links.filter((link) => name.has(link.from) && name.has(link.to)).map((link) => `- ${name.get(link.from)} ${plainWords(link.text)} ${name.get(link.to)}`);
  return [head, ideas.length ? ["Ideas:", ...ideas].join("\n") : "", ties.length ? ["How they connect:", ...ties].join("\n") : ""].filter(Boolean).join("\n\n");
}

const paragraph: BlockKind = {
  kind: "text",
  names: ["paragraph"],
  about: "A short paragraph: two to four sentences about one thing.",
  cites: true,
  read(raw, _name, reader) {
    const text = reader.words(raw.text);
    if (!text) return { problem: "it needs `text`." };
    return { kind: "text", text, ...reader.cited(raw) };
  },
  asText: textOf,
};

const heading: BlockKind = {
  kind: "heading",
  names: [],
  about: "A short title over a part of a long reply. Only in a reply with several parts; never first in a short one.",
  cites: false,
  read(raw, _name, reader) {
    const text = reader.words(raw.text, 160).replace(/^#+\s*/, "").replace(/\*\*/g, "");
    return text ? { kind: "heading", text } : { problem: "it needs `text`." };
  },
  asText: textOf,
};

const list: BlockKind = {
  kind: "list",
  names: ["bullets", "numbered"],
  about: "`bullets` for things that sit side by side, `numbered` for steps or a ranking. `items`: [{text, cites}], one line or two each.",
  cites: true,
  read(raw, name, reader) {
    const ordered = name === "numbered" || (name === "list" && raw.ordered === true);
    const entries = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
    const items: ListItem[] = [];
    for (const entry of entries) {
      const item = typeof entry === "string" ? { text: entry } : isRecord(entry) ? entry : undefined;
      const text = item ? reader.words(item.text, MAX_CELL * 2) : "";
      if (item && text) items.push({ text, ...reader.cited(item) });
    }
    if (items.length === 0) return { problem: "it needs `items`, each with `text`." };
    return { kind: "list", ordered, items, text: listText(ordered, items), ...reader.cited(raw) };
  },
  asText(block) {
    const items = Array.isArray(block.items) ? block.items.filter(isRecord).map((item) => ({ text: typeof item.text === "string" ? item.text : "" })) : [];
    return items.length ? listText(block.ordered === true, items) : textOf(block);
  },
};

const table: BlockKind = {
  kind: "table",
  names: [],
  about: "For comparing things across the same few points. `header`: the column names; `rows`: [{cells, cites}], as many cells as the header has columns. Short cells.",
  cites: true,
  read(raw, _name, reader) {
    const header = (Array.isArray(raw.header) ? raw.header : []).slice(0, MAX_COLUMNS).map((cell) => reader.words(String(cell ?? ""), MAX_CELL));
    if (header.length < 2 || header.some((cell) => !cell)) return { problem: `it needs a \`header\` of 2 to ${MAX_COLUMNS} column names.` };
    const rows: TableRow[] = [];
    for (const [index, entry] of (Array.isArray(raw.rows) ? raw.rows : []).slice(0, MAX_ROWS).entries()) {
      const row = Array.isArray(entry) ? { cells: entry } : isRecord(entry) ? entry : undefined;
      const cells = row && Array.isArray(row.cells) ? row.cells.map((cell) => reader.words(String(cell ?? ""), MAX_CELL)) : [];
      if (cells.length > header.length) return { problem: `row ${index + 1} has ${cells.length} cells but the header has ${header.length} columns.` };
      if (!row || cells.every((cell) => !cell)) continue;
      while (cells.length < header.length) cells.push("");
      rows.push({ cells, ...reader.cited(row) });
    }
    if (rows.length === 0) return { problem: "it needs `rows`, each with `cells`." };
    return { kind: "table", header, rows, text: tableText(header, rows), ...reader.cited(raw) };
  },
  asText(block) {
    const header = Array.isArray(block.header) ? block.header.map(String) : [];
    const rows = Array.isArray(block.rows) ? block.rows.filter(isRecord).map((row) => ({ cells: Array.isArray(row.cells) ? row.cells.map(String) : [] })) : [];
    return header.length ? tableText(header, rows) : textOf(block);
  },
};

const note: BlockKind = {
  kind: "note",
  names: ["callout"],
  about: "One thing set apart: a caveat, a warning, what the sources leave out. At most one per reply.",
  cites: true,
  read(raw, _name, reader) {
    const text = reader.words(raw.text);
    return text ? { kind: "note", text, ...reader.cited(raw) } : { problem: "it needs `text`." };
  },
  asText: textOf,
};

const math: BlockKind = {
  kind: "math",
  names: [],
  about: "A formula on its own line, as LaTeX in `text` without $ around it. Inline maths goes in other text as $...$.",
  cites: true,
  read(raw, _name, reader) {
    const text = typeof raw.text === "string" ? raw.text.trim().replace(/^\$+|\$+$/g, "").trim().slice(0, MAX_TEXT) : "";
    return text ? { kind: "math", text, ...reader.cited(raw) } : { problem: "it needs `text`, the formula." };
  },
  asText: (block) => (typeof block.text === "string" ? `$$${block.text}$$` : ""),
};

const background: BlockKind = {
  kind: "background",
  names: [],
  about:
    "What you add that the sources do not say, to help the person understand: what a term usually means, how such a number is usually read, a rule of thumb. The person sees it marked as not from their sources. It has no cites and never states what the source says or found.",
  cites: false,
  read(raw, _name, reader) {
    const text = reader.words(raw.text);
    return text ? { kind: "background", text } : { problem: "it needs `text`." };
  },
  asText: (block) => (typeof block.text === "string" ? `(Background, not from the sources) ${plainWords(block.text)}` : ""),
};

const code: BlockKind = {
  kind: "code",
  names: [],
  about: "Code or anything that must keep its exact spacing, in `text`, with an optional `lang`.",
  cites: false,
  read(raw) {
    const text = typeof raw.text === "string" ? raw.text.replace(/^\n+|\s+$/g, "").slice(0, MAX_TEXT) : "";
    const lang = typeof raw.lang === "string" && /^[A-Za-z0-9+#._-]{1,20}$/.test(raw.lang) ? raw.lang : undefined;
    return text ? { kind: "code", text, ...(lang ? { lang } : {}) } : { problem: "it needs `text`." };
  },
  asText: (block) => (typeof block.text === "string" ? block.text : ""),
};

const teachBack: BlockKind = {
  kind: "teachback",
  names: ["teach-back"],
  about:
    'Feedback on the person\'s own explanation of an idea, checked against the sources. `items`: [{verdict, text, cites}], one point each: "right" for what they said that the sources bear out, "missing" for what the sources say that matters and they left out, "wrong" for what they said that the sources contradict, saying what the sources say instead. Every item cites the spot that shows it. Only for a teach-back; something they said that the sources neither say nor contradict is not wrong.',
  cites: true,
  read(raw, _name, reader) {
    const entries = Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : [];
    const items: TeachBackItem[] = [];
    const bad: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) continue;
      const text = reader.words(entry.text, MAX_CELL * 2);
      if (!text) continue;
      const verdict = typeof entry.verdict === "string" ? entry.verdict.trim().toLowerCase() : "";
      if (!VERDICTS.some((known) => known.verdict === verdict)) {
        bad.push(`item ${index + 1} needs a \`verdict\` of ${VERDICTS.map((known) => `"${known.verdict}"`).join(", ")}`);
        continue;
      }
      items.push({ verdict: verdict as Verdict, text, ...reader.cited(entry) });
    }
    if (bad.length) return { problem: `${bad.join("; ")}.` };
    if (items.length === 0) return { problem: "it needs `items`, each with a `verdict` and `text`." };
    // Shown grouped, right first: the stored order is the order read.
    const sorted = VERDICTS.flatMap(({ verdict }) => items.filter((item) => item.verdict === verdict));
    return { kind: "teachback", items: sorted, text: teachBackText(sorted), ...reader.cited(raw) };
  },
  asText(block) {
    const items = Array.isArray(block.items)
      ? block.items.filter(isRecord).map((item) => ({ verdict: typeof item.verdict === "string" ? item.verdict : "", text: typeof item.text === "string" ? item.text : "" }))
      : [];
    return items.length ? teachBackText(items) : textOf(block);
  },
};

/** Most ideas on one mind map: more than a phone can show as a map. */
export const MAX_MAP_NODES = 16;
const MAX_MAP_LINKS = 32;

const mindMap: BlockKind = {
  kind: "mindmap",
  names: ["mind-map"],
  about:
    "A map of the main ideas and how they connect, for a person who asks to see the ideas laid out. `nodes`: [{id, text, detail, cites}], the first the central idea, then up to " +
    `${MAX_MAP_NODES - 1} more; \`text\` names the idea in a few words, \`detail\` says it in one sentence, \`cites\` the spot where the sources say it. ` +
    "`links`: [{from, to, text}], node ids and how the first connects to the second in a few words read between them (\"causes\", \"is part of\", \"is measured by\"). Every node is linked, through others if need be, to the central one.",
  cites: true,
  read(raw, _name, reader) {
    const entries = Array.isArray(raw.nodes) ? raw.nodes : [];
    if (entries.length > MAX_MAP_NODES) return { problem: `a map holds at most ${MAX_MAP_NODES} nodes; ${entries.length} were sent. Keep the main ideas.` };
    const nodes: MindMapNode[] = [];
    const bad: string[] = [];
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) continue;
      const id = typeof entry.id === "string" || typeof entry.id === "number" ? String(entry.id).trim().slice(0, 40) : "";
      const text = reader.words(entry.text ?? entry.label, 120);
      if (!id || !text) {
        bad.push(`node ${index + 1} needs an \`id\` and \`text\``);
        continue;
      }
      if (nodes.some((node) => node.id === id)) {
        bad.push(`node id "${id}" is used twice`);
        continue;
      }
      const detail = reader.words(entry.detail, MAX_CELL);
      nodes.push({ id, text, ...(detail ? { detail } : {}), ...reader.cited(entry) });
    }
    if (bad.length) return { problem: `${bad.join("; ")}.` };
    if (nodes.length < 2) return { problem: "it needs `nodes`: the central idea and at least one more, each with an `id` and `text`." };
    const ids = new Set(nodes.map((node) => node.id));
    const links: MindMapLink[] = [];
    for (const [index, entry] of (Array.isArray(raw.links) ? raw.links : []).slice(0, MAX_MAP_LINKS).entries()) {
      if (!isRecord(entry)) continue;
      const from = String(entry.from ?? "").trim();
      const to = String(entry.to ?? "").trim();
      const text = reader.words(entry.text ?? entry.label, 80);
      if (!ids.has(from) || !ids.has(to)) {
        bad.push(`link ${index + 1} names a node there is not (${[from, to].filter((id) => !ids.has(id)).map((id) => `"${id}"`).join(", ") || "none"})`);
        continue;
      }
      if (from === to || !text) {
        bad.push(`link ${index + 1} needs two different nodes and \`text\``);
        continue;
      }
      if (!links.some((link) => link.from === from && link.to === to)) links.push({ from, to, text });
    }
    if (bad.length) return { problem: `${bad.join("; ")}.` };
    const apart = nodes.filter((node) => !reachable(nodes[0].id, links).has(node.id));
    if (apart.length) return { problem: `every node must link, through others if need be, to the central "${plainWords(nodes[0].text)}"; not linked: ${apart.map((node) => `"${node.id}"`).join(", ")}.` };
    return { kind: "mindmap", nodes, links, text: mindMapText(nodes, links), ...reader.cited(raw) };
  },
  asText(block) {
    const nodes = Array.isArray(block.nodes)
      ? block.nodes.filter(isRecord).map((node) => ({ id: String(node.id ?? ""), text: typeof node.text === "string" ? node.text : "", ...(typeof node.detail === "string" ? { detail: node.detail } : {}) }))
      : [];
    const links = Array.isArray(block.links) ? block.links.filter(isRecord).map((link) => ({ from: String(link.from ?? ""), to: String(link.to ?? ""), text: typeof link.text === "string" ? link.text : "" })) : [];
    return nodes.length ? mindMapText(nodes, links) : textOf(block);
  },
};

/** The node ids a map's links reach from `start`, read both ways. */
function reachable(start: string, links: readonly MindMapLink[]): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const link of links) {
      const next = link.from === at ? link.to : link.to === at ? link.from : undefined;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

export function createBlockKinds(): BlockKindRegistry {
  return new BlockKindRegistry().register(paragraph).register(heading).register(list).register(table).register(note).register(math).register(code).register(background).register(teachBack).register(mindMap);
}

/** The block kinds every reply uses. */
export const blockKinds = createBlockKinds();

/** Blocks marked as not checked: a reply that read the sources and cites none of them. */
export function markUnchecked<T extends { kind: string }>(blocks: readonly T[]): T[] {
  return blocks.map((block) => {
    const kind = blockKinds.get(block.kind);
    if (!kind?.cites) return block;
    return { ...block, unchecked: true };
  });
}

/** Whether a stored piece is a written block (a paragraph, a list, ...), not a plan card or a question. */
export function isBlock(piece: { kind: string }): boolean {
  return blockKinds.get(piece.kind) !== undefined;
}
