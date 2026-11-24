/**
 * A made set of flashcards or quiz as plain text for a terminal: what the person reads,
 * in order, each claim's cite as a number after it and the cited words
 * listed under it. Read defensively: a payload is data, and a block or a
 * question kind this does not know is shown by its words.
 */
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
/** Inline marks taken off: **bold**, *italic*, `code`, a link's label kept. */
const plain = (v: unknown): string => str(v).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
const LETTERS = "ABCDEFGH";
/** Blocks that ask and know their answer: answering one marks the card (the engine's ASK_BLOCKS). */
const ASKS = ["quiz", "fillInBlank", "matching", "orderExercise", "labelPicture", "drawLine"];

/** The cites of one card or question, numbered from `start`, as the lines that list them. */
function citeLines(cites: unknown[], names: Map<string, string>, start: number): { lines: string[]; numbers: Map<number, number> } {
  const numbers = new Map<number, number>();
  const lines: string[] = [];
  cites.forEach((raw, i) => {
    const c = rec(raw);
    const n = start + lines.length;
    numbers.set(i, n);
    const where = rec(c.locator).page !== undefined ? `, p. ${str(rec(c.locator).page)}` : "";
    lines.push(`  [${n}] ${names.get(str(c.sourceId)) ?? "a source"}${where}${str(c.quote) ? `: "${str(c.quote)}"` : ""}`);
  });
  return { lines, numbers };
}

export function blockLine(block: Rec): string {
  return blockText(block);
}

function blockText(block: Rec): string {
  switch (str(block.type)) {
    case "heading":
      return `## ${plain(block.text)}`;
    case "kicker":
    case "subheading":
      return plain(block.text).toUpperCase();
    case "bullets":
    case "checklist":
      return list(block.items).map((t) => `- ${plain(t)}`).join("\n");
    case "numbered":
      return list(block.items).map((t, i) => `${i + 1}. ${plain(t)}`).join("\n");
    case "callout":
      return `> ${[plain(block.title), plain(block.text)].filter(Boolean).join(": ")}`;
    case "background":
      return `(Background, not from your source) ${[plain(block.title), plain(block.text)].filter(Boolean).join(": ")}`;
    case "definition":
      return `${plain(block.term)}: ${plain(block.definition)}`;
    case "math":
      return `  ${str(block.latex)}${str(block.caption) ? `  (${plain(block.caption)})` : ""}`;
    case "table":
      return [list(block.headers), ...list(block.rows)].map((row) => list(row).map(plain).join(" | ")).join("\n");
    case "bigStat":
      return `${str(block.value)}  ${plain(block.label)}`;
    case "quiz":
      return [`Check: ${plain(block.question)}`, ...list(block.options).map((o, i) => `  ${LETTERS[i]}) ${plain(o)}`)].join("\n");
    case "fillInBlank":
      return `Check: ${plain(block.prompt)}`;
    case "cloze":
      return plain(str(block.text).replace(/\[\[([^[\]]+)\]\]/g, "[$1]"));
    case "matching":
      return [`Check: ${plain(block.prompt) || "match these"}`, ...list(block.pairs).map((p) => `  ${plain(rec(p).left)}  ...`)].join("\n");
    case "orderExercise":
      return [`Check: ${plain(block.prompt)}`, ...list(block.items).map((t) => `  - ${plain(t)}`)].join("\n");
    case "labelPicture": {
      const marks = list(block.marks).map(rec);
      const names = [...marks.map((m) => str(m.answer)), ...list(block.extra).map(str)].sort((a, b) => a.localeCompare(b));
      return [`Check: ${plain(block.prompt) || "name each mark on the picture"}`, `  (a picture${str(block.caption) ? `: ${plain(block.caption)}` : ""})`, ...marks.map((m) => `  ${plain(m.mark)}: ...`), `  Names: ${names.map(plain).join("; ")}`].join("\n");
    }
    case "drawLine": {
      const axes = rec(block.axes);
      const axis = (a: Rec, name: string) => `${str(a.label) || name} from ${String(a.min)} to ${String(a.max)} in steps of ${String(a.step)}`;
      return [`Check: ${plain(block.prompt)}`, `  (draw a straight line through two points: ${axis(rec(axes.x), "x")}; ${axis(rec(axes.y), "y")})`].join("\n");
    }
    default:
      return plain(block.text ?? block.caption ?? block.title ?? block.label);
  }
}

/** A cloze's sentence with its gaps hidden, as the front shows it. */
export const hidden = (text: unknown): string => plain(str(text).replace(/\[\[([^[\]]+)\]\]/g, "_____"));

/** How a card is marked, from its sides (engine/docs/flashcards.md, "Card"): by its answer, by the person, or not at all. */
export function markOf(card: Rec): "answer" | "self" | "none" {
  const front = list(card.front).map(rec);
  if (front.some((b) => ASKS.includes(str(b.type)))) return "answer";
  if (list(card.back).length > 0 || front.some((b) => str(b.type) === "cloze")) return "self";
  return "none";
}

/** One side of a card as lines, each block's cite numbers after it. */
function sideText(blocks: Rec[], at: Map<number, number[]>, offset: number, front: boolean): string[] {
  return blocks
    .map((block, i) => {
      const text = front && str(block.type) === "cloze" ? hidden(block.text) : blockText(block);
      const nums = at.get(offset + i);
      return `${text}${nums?.length ? ` ${nums.map((n) => `[${n}]`).join("")}` : ""}`;
    })
    .filter((t) => t.trim());
}

/** A set of flashcards, card by card: its front, then its back (a cloze's back is the whole sentence), then its cites. */
export function cardsText(payload: unknown, names: Map<string, string>): string {
  const set = rec(payload);
  const cards = list(set.cards).map(rec);
  const out = [`${plain(set.title)}${str(set.subtitle) ? `\n${plain(set.subtitle)}` : ""}`, `A set of ${cards.length} flashcard${cards.length === 1 ? "" : "s"}.`];
  let next = 1;
  cards.forEach((card, k) => {
    const front = list(card.front).map(rec);
    const back = list(card.back).map(rec);
    const cites = list(card.cites);
    const { lines, numbers } = citeLines(cites, names, next);
    next += lines.length;
    // Each block's cite numbers after it (blocks counted front then back); a cite of the whole card after its last block.
    const total = front.length + back.length;
    const at = new Map<number, number[]>();
    cites.forEach((raw, i) => {
      const b = rec(raw).block;
      const where = typeof b === "number" && b >= 0 && b < total ? b : total - 1;
      at.set(where, [...(at.get(where) ?? []), numbers.get(i)!]);
    });
    const mark = markOf(card);
    const head = `--- ${k + 1} of ${cards.length}${str(card.section) ? ` · ${plain(card.section)}` : ""}${str(card.kind) ? ` · ${str(card.kind)}` : ""}`;
    const clozes = front.filter((b) => str(b.type) === "cloze");
    // A cite's quote can give the answer away, so a card that turns over shows its cites with its answer, never on its front.
    const onFront = new Map(mark === "self" ? [] : [...at].filter(([i]) => i < front.length));
    const shownLater = mark === "self" ? [...at].filter(([i]) => i < front.length).flatMap(([, ns]) => ns) : [];
    const body = [`Front: ${sideText(front, onFront, 0, true).join("\n")}`];
    const later = shownLater.length ? ` ${shownLater.map((n) => `[${n}]`).join("")}` : "";
    if (back.length > 0) body.push(`Back: ${sideText(back, at, front.length, false).join("\n")}${later}`);
    else if (clozes.length > 0) body.push(`Back: ${clozes.map((b) => blockText(b)).join("\n")}${later}`);
    if (mark === "none") body.push("(to read; not marked)");
    out.push([head, ...body, ...lines].join("\n"));
  });
  if (str(set.sizeNote)) out.push(plain(set.sizeNote));
  return out.join("\n\n");
}

/** A quiz, question by question, with its answers and feedback (the item is the person's own). */
export function quizText(payload: unknown, names: Map<string, string>): string {
  const quiz = rec(payload);
  const questions = list(quiz.questions).map(rec);
  const time = typeof quiz.timeLimit === "number" && quiz.timeLimit > 0 ? ` with ${quiz.timeLimit} minute${quiz.timeLimit === 1 ? "" : "s"} to answer` : "";
  const out = [plain(quiz.title), `A quiz of ${questions.length} question${questions.length === 1 ? "" : "s"}${time}.`];
  let next = 1;
  questions.forEach((q, k) => {
    const { lines } = citeLines(list(q.cites), names, next);
    const nums = lines.map((_, i) => `[${next + i}]`).join("");
    next += lines.length;
    const body = [`--- Question ${k + 1}${str(q.topic) ? ` · ${plain(q.topic)}` : ""}`, plain(q.prompt)];
    if (str(q.display)) body.push(`  ${str(q.display)}`);
    list(q.options).forEach((o, i) => body.push(`  ${LETTERS[i]}) ${plain(o)}${i === q.answer ? "   <- right" : ""}`));
    list(q.steps).map(rec).forEach((s, i) => {
      const answer = s.input === "choice" ? plain(list(s.options)[Number(s.answer)]) : list(s.values).map(plain).join(", ");
      body.push(`  Step ${i + 1}: ${plain(s.prompt)}  -> ${answer}${str(s.unit) ? ` ${str(s.unit)}` : ""}${str(s.form) ? ` (${plain(s.form)})` : ""}`);
    });
    if (list(q.items).length) body.push(`  In order: ${list(q.items).map((t, i) => `${i + 1}. ${plain(t)}`).join("  ")}`);
    list(q.pairs).map(rec).forEach((p) => body.push(`  ${plain(p.left)} -> ${plain(p.right)}`));
    if (str(rec(q.picture).caption)) body.push(`  Picture: ${plain(rec(q.picture).caption)}`);
    list(q.marks).map(rec).forEach((m) => body.push(`  ${plain(m.mark)}: ${plain(m.answer)}`));
    if (list(q.extra).length) body.push(`  Also offered: ${list(q.extra).map(plain).join(", ")}`);
    if (q.axes) {
      const axis = (a: Record<string, unknown>, n: string) => `${str(a.label) || n} ${a.min} to ${a.max} by ${a.step}`;
      body.push(`  Grid: ${axis(rec(rec(q.axes).x), "x")}; ${axis(rec(rec(q.axes).y), "y")}`);
      body.push(`  The line through ${list(q.line).map((p) => `(${list(p).join(", ")})`).join(" and ")}`);
    }
    list(q.lines).forEach((l) => body.push(`  ${plain(l).replace(/\[\[([^[\]]*)\]\]/g, (_, a: string) => `[${a.split("|")[0]!.trim()}]`)}`));
    const fb = rec(q.feedback);
    if (str(fb.correct)) body.push(`If right: ${plain(fb.correct)} ${nums}`.trim());
    if (str(fb.incorrect)) body.push(`If not: ${plain(fb.incorrect)} ${nums}`.trim());
    out.push([...body, ...lines].join("\n"));
  });
  if (str(quiz.sizeNote)) out.push(plain(quiz.sizeNote));
  return out.join("\n\n");
}

/** The source ids a set's or quiz's cites name. */
export function citedSources(payload: unknown): string[] {
  const p = rec(payload);
  const cites = [...list(p.cards).flatMap((b) => list(rec(b).cites)), ...list(p.questions).flatMap((q) => list(rec(q).cites))];
  return [...new Set(cites.map((c) => str(rec(c).sourceId)).filter(Boolean))];
}
