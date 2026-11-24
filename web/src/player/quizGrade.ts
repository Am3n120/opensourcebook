/**
 * Grading a quiz the way the engine does (engine/src/engines/quiz/result.ts,
 * kinds.ts): the result is what the done tick records, what `metric`
 * branches read and what later items take as input, so it must be the same
 * shape and the same numbers. Kinds the web does not know count as skipped.
 *
 * Each kind grades in one entry of `GRADES`; both graders are tested on the
 * cases in engine/src/engines/quiz/kind-cases.json. This file imports
 * nothing at run time: the re command loads it as it is.
 */
import type { JsonObject } from "../api/types";

export interface Question {
  id: string;
  kind: string;
  topic: string;
  prompt: string;
  display?: string;
  points: number;
  feedback: { correct: string; incorrect: string };
  cites: Array<{ sourceId: string; quote?: string; locator?: { page?: number; slide?: number; charStart?: number; charEnd?: number } }>;
  options?: string[];
  answer?: number;
  optionFeedback?: string[];
  steps?: WorkedStep[];
  /** order: the things to order, in the right order, and the order first shown. */
  items?: string[];
  shown?: number[];
  /** match: the pairs as they belong, and the order the rights are offered in. */
  pairs?: Array<{ left: string; right: string }>;
  rights?: number[];
  /** label: the picture, its own marks with what each is, and every name offered. */
  picture?: { url: string; caption?: string };
  marks?: Array<{ mark: string; answer: string }>;
  names?: string[];
  /** graph: the grid, and two points the right line goes through. */
  axes?: { x: Axis; y: Axis };
  line?: Array<[number, number]>;
  /** complete: the working, a gap written [[answer|other]]. */
  lines?: string[];
}

export interface Axis {
  min: number;
  max: number;
  step: number;
  label?: string;
}

export type WorkedStep = EntryStep | { prompt: string; input: "choice"; options: string[]; answer: number; hint?: string };

/** A typed step (engine kinds.ts `EntryStep`): one box today; `unit` beside it, `form` under it. */
export interface EntryStep {
  prompt: string;
  input: "entries";
  values: string[];
  unit?: string;
  form?: string;
  accept?: string[];
  hint?: string;
}

export interface Quiz {
  title: string;
  passMark: number;
  feedback: "afterEach" | "atEnd";
  questions: Question[];
  /** Minutes from Start until the quiz ends as it stands; absent when it has no limit. */
  timeLimit?: number;
}

export type Response =
  | { choice: number }
  | { steps: Array<{ value: number | string[]; revealed?: boolean }> }
  | { order: number[] }
  | { matches: Array<number | null> }
  | { labels: Array<number | null> }
  | { points: Array<[number, number]> }
  | { gaps: string[] };
export type Responses = Record<string, Response>;
export type Outcome = "right" | "partial" | "wrong" | "skipped";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The quiz payload (schema version 1), read defensively. */
export function asQuiz(payload: JsonObject): Quiz {
  const questions = (Array.isArray(payload.questions) ? (payload.questions as unknown[]) : []).filter(isObj).map((q, i): Question => {
    const fb = isObj(q.feedback) ? q.feedback : {};
    return {
      ...(q as object),
      id: str(q.id) || `q${i + 1}`,
      kind: str(q.kind),
      topic: str(q.topic),
      prompt: str(q.prompt),
      ...(typeof q.display === "string" ? { display: q.display } : {}),
      points: typeof q.points === "number" && q.points > 0 ? q.points : 1,
      feedback: { correct: str(fb.correct), incorrect: str(fb.incorrect) },
      cites: Array.isArray(q.cites) ? (q.cites.filter(isObj) as Question["cites"]) : [],
    };
  });
  return {
    title: str(payload.title),
    passMark: typeof payload.passMark === "number" ? payload.passMark : 0.7,
    feedback: payload.feedback === "atEnd" ? "atEnd" : "afterEach",
    questions,
    ...(typeof payload.timeLimit === "number" && payload.timeLimit > 0 ? { timeLimit: payload.timeLimit } : {}),
  };
}

/*
 * Typed answers compare exactly as the engine compares them (kinds.ts
 * `sameAnswer`); both are tested on engine/src/engines/quiz/answer-cases.json.
 */
export function normalizeAnswer(value: string): string {
  return value.trim().toLowerCase().replace(/[−–—]/g, "-").replace(/\s+/g, " ").replace(/\.$/, "");
}

const unitKey = (unit: string) => unit.toLowerCase().replace(/[\s.]/g, "");

function quantity(value: string): { readings: number[]; unit: string } | undefined {
  const m = /^([$€£¥])?\s*(-?[\d.,\u00a0\u202f ]*\d(?:\s*\/\s*-?[\d.,]*\d)?(?:e-?\d+)?)\s*([^\d\s][^\d]*)?$/.exec(value);
  if (!m) return undefined;
  const readings = numberReadings(m[2]!);
  return readings.length ? { readings, unit: unitKey(m[1] ?? m[3] ?? "") } : undefined;
}

/** The values digits can stand for: a lone comma or point before exactly three digits reads both ways. */
function numberReadings(raw: string): number[] {
  const text = raw.replace(/[\u00a0\u202f ](?=\d{3}\b)/g, "");
  const fraction = /^(-?[\d.,]+)\s*\/\s*(-?[\d.,]+)$/.exec(text);
  if (fraction) {
    const top = numberReadings(fraction[1]!)[0];
    const bottom = numberReadings(fraction[2]!)[0];
    return top !== undefined && bottom ? [top / bottom] : [];
  }
  const sci = /^(.*?)(e-?\d+)$/.exec(text);
  const body = sci ? sci[1]! : text;
  const exponent = sci ? Number(`1${sci[2]}`) : 1;
  const plain = (s: string) => (/^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) * exponent : undefined);
  const commas = (body.match(/,/g) ?? []).length;
  const points = (body.match(/\./g) ?? []).length;
  const read: Array<number | undefined> = [];
  if (commas && points) read.push(body.lastIndexOf(",") > body.lastIndexOf(".") ? plain(body.replace(/\./g, "").replace(",", ".")) : plain(body.replace(/,/g, "")));
  else if (commas || points) {
    const mark = commas ? "," : ".";
    const count = commas || points;
    const grouped = new RegExp(`^-?\\d{1,3}(\\${mark}\\d{3})+$`).test(body);
    if (count === 1 && grouped) read.push(plain(body.replace(mark, ".")), plain(body.replace(mark, "")));
    else if (count === 1) read.push(plain(body.replace(mark, ".")));
    else if (grouped) read.push(plain(body.split(mark).join("")));
  } else read.push(plain(body));
  return read.filter((v): v is number => v !== undefined && Number.isFinite(v));
}

/** Case, spacing, minus signs, number forms, a decimal comma and a unit typed or left off do not matter. */
export function sameAnswer(given: string, expected: string, unit?: string): boolean {
  const a = normalizeAnswer(given);
  const b = normalizeAnswer(expected);
  if (a === b) return true;
  const x = quantity(a);
  const y = quantity(b);
  if (!x || !y) return false;
  const named = unitKey(unit ?? "");
  if (x.unit && (y.unit || named) && x.unit !== y.unit && x.unit !== named) return false;
  const want = y.readings[0]!;
  return x.readings.some((v) => Math.abs(v - want) <= 1e-9 * Math.max(1, Math.abs(want)));
}

/** The boxes a typed step shows, each with the answers it takes; an older step listing one answer several ways is one box. */
export function entryBoxes(step: EntryStep): string[][] {
  const values = step.values;
  const accept = step.accept ?? [];
  if (values.length > 1 && values.every((v) => sameAnswer(v, values[0]!, step.unit))) return [[...values, ...accept]];
  return values.map((v, i) => (i === 0 && values.length === 1 ? [v, ...accept] : [v]));
}

/** Whether one worked step's answer is right. */
export function stepRight(step: WorkedStep, value: number | string[] | undefined): boolean {
  if (step.input === "choice") return value === step.answer;
  const boxes = entryBoxes(step);
  const values = Array.isArray(value) ? value : [];
  return values.length === boxes.length && boxes.every((answers, i) => typeof values[i] === "string" && answers.some((a) => sameAnswer(values[i]!, a, step.unit)));
}

type Grade = { fraction: number; answered: boolean };
const unanswered: Grade = { fraction: 0, answered: false };
const nums = (v: unknown): Array<number | undefined> => (Array.isArray(v) ? v.map((n) => (typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : undefined)) : []);
const isOrder = (v: Array<number | undefined>, n: number): v is number[] => v.length === n && new Set(v).size === n && v.every((k) => k !== undefined && k < n);

/** The share of neighbouring pairs in their right order (engine kind/order.ts). */
export function orderFraction(order: number[]): number {
  if (order.length < 2) return order.length === 1 ? 1 : 0;
  let right = 0;
  for (let i = 0; i + 1 < order.length; i += 1) if (order[i + 1] === order[i]! + 1) right += 1;
  return right / (order.length - 1);
}

/** Whether a point is on the line through a and b, as near as the grid can tell (engine kind/graph.ts). */
export function onLine(p: [number, number], [a, b]: [number, number][], axes: { x: Axis; y: Axis }): boolean {
  const cross = (b![0] - a![0]) * (p[1] - a![1]) - (b![1] - a![1]) * (p[0] - a![0]);
  return Math.abs(cross) <= axes.x.step * axes.y.step * 1e-6;
}

const GAP = /\[\[([^[\]]*)\]\]/g;

/** A line of working split into text and gaps (engine kind/complete.ts). */
export function lineParts(line: string): Array<{ text: string } | { answers: string[] }> {
  const parts: Array<{ text: string } | { answers: string[] }> = [];
  let from = 0;
  for (const m of line.matchAll(GAP)) {
    if (m.index! > from) parts.push({ text: line.slice(from, m.index) });
    parts.push({ answers: m[1]!.split("|").map((a) => a.trim()).filter(Boolean) });
    from = m.index! + m[0].length;
  }
  if (from < line.length) parts.push({ text: line.slice(from) });
  return parts;
}

/** Every gap's accepted answers, in reading order. */
export function gapsOf(q: Question): string[][] {
  return (q.lines ?? []).flatMap((line) => lineParts(line).flatMap((p) => ("answers" in p ? [p.answers] : [])));
}

export const gapRight = (answers: string[], value: string | undefined): boolean => value !== undefined && value.trim() !== "" && answers.some((a) => sameAnswer(value, a));

/** Whether a picked name is the one a mark stands for. */
export const nameRight = (mark: { answer: string }, name: string | undefined): boolean => name !== undefined && normalizeAnswer(name) === normalizeAnswer(mark.answer);

/** How each kind grades a response: one entry per kind, as the engine's kinds do. */
const GRADES: Record<string, (q: Question, r: unknown) => Grade> = {
  choice(q, r) {
    const choice = isObj(r) && typeof r.choice === "number" ? r.choice : undefined;
    return choice === undefined ? unanswered : { fraction: choice === q.answer ? 1 : 0, answered: true };
  },
  worked(q, r) {
    if (!q.steps?.length) return unanswered;
    const given = isObj(r) && Array.isArray(r.steps) ? r.steps : [];
    if (!given.some(isObj)) return unanswered;
    const right = q.steps.filter((s, i) => {
      const e = given[i];
      return isObj(e) && e.revealed !== true && stepRight(s, e.value as number | string[]);
    }).length;
    return { fraction: right / q.steps.length, answered: true };
  },
  order(q, r) {
    const order = nums(isObj(r) ? r.order : undefined);
    return isOrder(order, q.items?.length ?? 0) ? { fraction: orderFraction(order), answered: true } : unanswered;
  },
  match(q, r) {
    const pairs = q.pairs ?? [];
    const picked = nums(isObj(r) ? r.matches : undefined);
    const chosen = pairs.map((_, i) => (picked[i] !== undefined && picked[i]! < pairs.length ? picked[i] : undefined));
    if (!isObj(r) || chosen.every((k) => k === undefined)) return unanswered;
    return { fraction: chosen.filter((k, i) => k === i).length / pairs.length, answered: true };
  },
  label(q, r) {
    const marks = q.marks ?? [];
    const picked = nums(isObj(r) ? r.labels : undefined);
    const chosen = marks.map((_, i) => (picked[i] !== undefined ? q.names?.[picked[i]!] : undefined));
    if (!isObj(r) || chosen.every((n) => n === undefined)) return unanswered;
    return { fraction: marks.filter((m, i) => nameRight(m, chosen[i])).length / marks.length, answered: true };
  },
  graph(q, r) {
    const raw = isObj(r) && Array.isArray(r.points) ? r.points : [];
    const points = raw.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)));
    if (points.length !== 2 || raw.length !== 2 || !q.axes || q.line?.length !== 2) return unanswered;
    const same = Math.abs(points[0]![0] - points[1]![0]) <= q.axes.x.step * 1e-6 && Math.abs(points[0]![1] - points[1]![1]) <= q.axes.y.step * 1e-6;
    return { fraction: !same && points.every((p) => onLine(p, q.line!, q.axes!)) ? 1 : 0, answered: true };
  },
  complete(q, r) {
    const gaps = gapsOf(q);
    const typed = isObj(r) && Array.isArray(r.gaps) ? r.gaps.map((v) => (typeof v === "string" ? v : "")) : undefined;
    if (!typed || gaps.length === 0 || typed.every((v) => !v.trim())) return unanswered;
    return { fraction: gaps.filter((answers, i) => gapRight(answers, typed[i])).length / gaps.length, answered: true };
  },
};

/** Whether the web can show and grade this kind of question. */
export const knownKind = (kind: string): boolean => Object.hasOwn(GRADES, kind);

/** One question's share of its points, and whether it was answered. */
export function gradeQuestion(q: Question, response: unknown): Grade {
  return knownKind(q.kind) ? GRADES[q.kind]!(q, response) : unanswered;
}

export function outcomeOf(q: Question, response: unknown): Outcome {
  const g = gradeQuestion(q, response);
  return !g.answered ? "skipped" : g.fraction === 1 ? "right" : g.fraction === 0 ? "wrong" : "partial";
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;

/** The result the done tick records (engine `QuizResult`, version 1). */
export function gradeQuiz(quiz: Quiz, responses: Responses): JsonObject {
  const questions = quiz.questions.map((q) => {
    const g = gradeQuestion(q, responses[q.id]);
    const fraction = Math.min(1, Math.max(0, g.fraction));
    const outcome: Outcome = !g.answered ? "skipped" : fraction === 1 ? "right" : fraction === 0 ? "wrong" : "partial";
    return { id: q.id, topic: q.topic, outcome, earned: round(q.points * fraction), points: q.points };
  });
  const topics = new Map<string, { topic: string; earned: number; points: number }>();
  for (const q of questions) {
    const t = topics.get(q.topic) ?? { topic: q.topic, earned: 0, points: 0 };
    t.earned = round(t.earned + q.earned);
    t.points = round(t.points + q.points);
    topics.set(q.topic, t);
  }
  const earned = round(questions.reduce((n, q) => n + q.earned, 0));
  const total = round(questions.reduce((n, q) => n + q.points, 0));
  const score = total > 0 ? round(earned / total) : 0;
  const topicList = [...topics.values()];
  return {
    format: "quiz",
    version: 1,
    score,
    earned,
    total,
    correct: questions.filter((q) => q.outcome === "right").length,
    answered: questions.filter((q) => q.outcome !== "skipped").length,
    count: questions.length,
    passMark: quiz.passMark,
    passed: score >= quiz.passMark,
    questions,
    missed: questions.filter((q) => q.outcome !== "right").map((q) => q.id),
    topicsMissed: topicList
      .filter((t) => t.earned < t.points)
      .sort((a, b) => a.earned / a.points - b.earned / b.points)
      .map((t) => t.topic),
    topics: topicList,
  } as unknown as JsonObject;
}

