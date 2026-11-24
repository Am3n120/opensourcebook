/**
 * Card blocks that ask as a kind of quiz question does (the engine's
 * src/cards/asks.ts): a picture to label by its own marks is the label kind,
 * a line to draw on a grid is the graph kind. A card reads the block as that
 * kind's question, draws it with the kind's own piece (pieces.tsx) and
 * grades it with the kind's own grader (quizGrade.ts), so a card and a quiz
 * agree on what is right. A new block of this sort is one entry here.
 */
import { mixedOrder, type Block } from "../blockData";
import { nameRight, type Axis, type Outcome, type Question, type Response } from "../quizGrade";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

function axis(v: unknown): Axis {
  const a = isObj(v) ? v : {};
  return { min: num(a.min), max: num(a.max), step: num(a.step), ...(typeof a.label === "string" && a.label ? { label: a.label } : {}) };
}

const base = (b: Block, kind: string): Question => ({ id: `card-${kind}`, kind, topic: "", prompt: str(b.prompt), points: 1, feedback: { correct: "", incorrect: "" }, cites: [] });

interface BlockQuestion {
  /** The block as its kind's question. */
  question(b: Block): Question;
  /** The verdict once answered, when the kind says more than right or not quite. */
  verdict?(q: Question, r: Response, outcome: Outcome): string | undefined;
}

export const BLOCK_QUESTIONS: Readonly<Record<string, BlockQuestion>> = {
  labelPicture: {
    question(b) {
      const marks = (Array.isArray(b.marks) ? (b.marks as unknown[]) : []).filter(isObj).map((m) => ({ mark: str(m.mark), answer: str(m.answer) }));
      const all = [...marks.map((m) => m.answer), ...strs(b.extra)];
      // Mixed the same way each time the card is drawn, never in the marks' own order.
      const names = mixedOrder(all.length, all.join("|")).map((i) => all[i]!);
      return { ...base(b, "label"), picture: { url: str(b.url), ...(str(b.caption) ? { caption: str(b.caption) } : {}) }, marks, names };
    },
    verdict(q, r, outcome) {
      if (outcome !== "partial") return undefined;
      const labels = (r as { labels?: Array<number | null> }).labels ?? [];
      const marks = q.marks ?? [];
      const right = marks.filter((m, i) => nameRight(m, labels[i] === null || labels[i] === undefined ? undefined : q.names?.[labels[i]!])).length;
      return `${right} of ${marks.length} named.`;
    },
  },
  drawLine: {
    question(b) {
      const axes = isObj(b.axes) ? b.axes : {};
      const line = (Array.isArray(b.line) ? (b.line as unknown[]) : []).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"));
      return { ...base(b, "graph"), axes: { x: axis(axes.x), y: axis(axes.y) }, line };
    },
    verdict: (_q, _r, outcome) => (outcome === "wrong" ? "Not quite. The right line is drawn beside yours." : undefined),
  },
};

/** The block as a question, or undefined when it is not one of these. */
export function blockQuestion(b: Block): { question: Question; entry: BlockQuestion } | undefined {
  if (!Object.hasOwn(BLOCK_QUESTIONS, b.type)) return undefined;
  const entry = BLOCK_QUESTIONS[b.type]!;
  return { question: entry.question(b), entry };
}
