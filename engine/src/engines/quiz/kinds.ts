/**
 * Question kinds. A kind owns its own fields: how the model is told to write
 * them, how model output is cleaned, what makes them valid, how the answer
 * reads to a reviewer, and how a person's response is graded. The engine,
 * validation and `gradeQuiz` only ever go through this interface, so a new
 * kind (ordering, matching, a short written answer) is one more
 * `QuestionKind` registered here.
 *
 * Here, with the registry and what every kind shares:
 *   choice  one right option among several.
 *   worked  a problem solved in steps, each step checked: typed values, or
 *           a pick between options. A step can be revealed, which counts as
 *           missed.
 * The others are one file each in `kind/`, and default-kinds.ts lists them.
 */
import type { SettingOption } from "../../studio/types";
import type { QuizQuestion } from "./schema";

export interface KindIssue {
  /** Relative to the question, starting with "." (".options[2]"). */
  path: string;
  code: string;
  message: string;
}

export interface Grade {
  /** 0...1 of the question's points. */
  fraction: number;
  answered: boolean;
}

/** What a kind's check may know beyond the question itself. */
export interface KindContext {
  /** The pictures this item's sources hold (`/v1/assets/<id>`), when known. */
  pictures?: ReadonlySet<string>;
}

export interface QuestionKind {
  readonly id: string;
  /** Sentence case, as settings forms show it as an option and players next to the topic. */
  readonly label: string;
  /** One plain line on what answering it is like, for settings forms and the planner. */
  readonly description: string;
  /** The JSON fields of this kind and their rules, for the writing prompt. */
  readonly guidance: string;
  /**
   * This kind's own fields as JSON Schema properties, for a writer whose
   * tool input is checked against a schema (the person's own agent).
   */
  readonly fields?: Record<string, { [key: string]: unknown }>;
  /** This kind's own fields from model output, cleaned; anything it does not know is dropped. */
  normalize(raw: Record<string, unknown>): Record<string, unknown>;
  check(question: QuizQuestion, context?: KindContext): KindIssue[];
  /**
   * True when a question of this kind is about a picture from the sources:
   * the writer is shown the sources' pictures, and the kind is left out of a
   * quiz whose sources have none.
   */
  readonly usesPicture?: boolean;
  /** The right answer in words, for the reviewer. */
  describeAnswer(question: QuizQuestion): string;
  /** The options a reviewer must check are not also right, when the kind has any. */
  alternatives?(question: QuizQuestion): string[];
  /**
   * Puts the kind's options in an order the writer did not choose, so the
   * right one sits anywhere. Everything tied to an option (its feedback, the
   * answer index) moves with it. `random` is seeded, so the same question
   * always comes out the same way. Kinds without options leave it out.
   */
  arrange?(question: QuizQuestion, random: () => number): Record<string, unknown>;
  grade(question: QuizQuestion, response: unknown): Grade;
  /**
   * What the person sees of the question beyond its prompt (the options,
   * the steps), in plain lines, for the agent answering about it. Absent:
   * the prompt says it all.
   */
  describeShown?(question: QuizQuestion): string[];
  /**
   * The person's response in words ("B) the left ventricle"), with any line
   * the quiz shows for that response; undefined when there is none to say.
   */
  describeResponse?(question: QuizQuestion, response: unknown): string | undefined;
}

export class QuestionKindRegistry {
  private readonly kinds = new Map<string, QuestionKind>();

  register(kind: QuestionKind): this {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(kind.id)) throw new Error(`"${kind.id}" is not a question kind id.`);
    if (this.kinds.has(kind.id)) throw new Error(`Question kind "${kind.id}" is already registered.`);
    // Settings forms offer every kind by these words, never by its id.
    if (!kind.label.trim() || !kind.description.trim()) throw new Error(`Question kind "${kind.id}" needs a label and a description.`);
    this.kinds.set(kind.id, kind);
    return this;
  }

  get(id: string): QuestionKind | undefined {
    return this.kinds.get(id);
  }

  ids(): string[] {
    return [...this.kinds.keys()];
  }

  all(): QuestionKind[] {
    return [...this.kinds.values()];
  }

  /** Every kind as a settings option, in registration order: a kind registered here offers itself. */
  options(): SettingOption[] {
    return this.all().map((kind) => ({ value: kind.id, label: kind.label, description: kind.description }));
  }
}

export const MAX_OPTIONS = 8;
const MAX_STEPS = 12;
export const MAX_TEXT = 1_000;

/**
 * How a typed answer compares with the one written (web/src/player/quizGrade.ts
 * compares the same way; answer-cases.json holds the cases both are tested
 * on). Case, spacing, minus signs and number forms do not matter: 52.5 and
 * 52.50, 1/4 and 0.25, a decimal comma or point as the person's locale writes
 * it, digits grouped or not, and a unit typed or left off. A different unit
 * is a different answer.
 */
export function sameAnswer(given: string, expected: string, unit?: string): boolean {
  const a = normalizeAnswer(given);
  const b = normalizeAnswer(expected);
  if (a === b) return true;
  const x = quantity(a);
  const y = quantity(b);
  if (!x || !y) return false;
  const named = unitKey(unit ?? "");
  // A unit typed where none was written cannot be checked against anything, so it is let be.
  if (x.unit && (y.unit || named) && x.unit !== y.unit && x.unit !== named) return false;
  const want = y.readings[0]!;
  return x.readings.some((value) => Math.abs(value - want) <= 1e-9 * Math.max(1, Math.abs(want)));
}

export function normalizeAnswer(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[−–—]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "");
}

const unitKey = (unit: string) => unit.toLowerCase().replace(/[\s.]/g, "");

/** A number with an optional currency sign before it and unit after it; every way the digits can be read. */
function quantity(value: string): { readings: number[]; unit: string } | undefined {
  const m = /^([$€£¥])?\s*(-?[\d.,\u00a0\u202f ]*\d(?:\s*\/\s*-?[\d.,]*\d)?(?:e-?\d+)?)\s*([^\d\s][^\d]*)?$/.exec(value);
  if (!m) return undefined;
  const [, sign, digits, after] = m as unknown as [string, string | undefined, string, string | undefined];
  const readings = numberReadings(digits);
  return readings.length ? { readings, unit: unitKey(sign ?? after ?? "") } : undefined;
}

/**
 * The values digits can stand for. A lone comma or point followed by exactly
 * three digits ("1,000", "1.000") reads either as grouping or as a decimal
 * mark, as locales write it; anything else has one reading.
 */
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
  if (commas && points) {
    // The later mark is the decimal one; the other groups digits.
    read.push(body.lastIndexOf(",") > body.lastIndexOf(".") ? plain(body.replace(/\./g, "").replace(",", ".")) : plain(body.replace(/,/g, "")));
  } else if (commas || points) {
    const mark = commas ? "," : ".";
    const count = commas || points;
    const grouped = new RegExp(`^-?\\d{1,3}(\\${mark}\\d{3})+$`).test(body);
    if (count === 1 && grouped) read.push(plain(body.replace(mark, ".")), plain(body.replace(mark, "")));
    else if (count === 1) read.push(plain(body.replace(mark, ".")));
    else if (grouped) read.push(plain(body.split(mark).join("")));
  } else read.push(plain(body));
  return read.filter((value): value is number => value !== undefined && Number.isFinite(value));
}

export function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((entry): entry is string => entry !== undefined) : [];
}

export function index(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionIssues(options: unknown, answer: unknown, at: string): KindIssue[] {
  const issues: KindIssue[] = [];
  if (!Array.isArray(options) || options.length < 2 || options.length > MAX_OPTIONS) {
    return [{ path: `${at}.options`, code: "options", message: `needs 2 to ${MAX_OPTIONS} options` }];
  }
  const seen = new Map<string, number>();
  options.forEach((option, position) => {
    if (typeof option !== "string" || !option.trim()) {
      issues.push({ path: `${at}.options[${position}]`, code: "empty", message: "an option must be non-empty text" });
    } else if (option.length > MAX_TEXT) {
      issues.push({ path: `${at}.options[${position}]`, code: "too_long", message: `an option is at most ${MAX_TEXT} characters` });
    } else {
      const key = normalizeAnswer(option);
      if (seen.has(key)) issues.push({ path: `${at}.options[${position}]`, code: "duplicate_option", message: `repeats option ${seen.get(key)! + 1}` });
      else seen.set(key, position);
    }
  });
  if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= options.length) {
    issues.push({ path: `${at}.answer`, code: "answer", message: "answer must be the index of one of the options" });
  }
  return issues;
}

/** A shuffled order of 0..n-1 (Fisher-Yates). */
export function permutation(length: number, random: () => number): number[] {
  const order = Array.from({ length }, (_, position) => position);
  for (let position = length - 1; position > 0; position -= 1) {
    const other = Math.floor(random() * (position + 1));
    [order[position], order[other]] = [order[other], order[position]];
  }
  return order;
}

/** Options, their per-option entries and the answer index, all in `order`. */
function reorder(options: string[], answer: number, order: number[], perOption?: string[]): { options: string[]; answer: number; perOption?: string[] } {
  return {
    options: order.map((from) => options[from]),
    answer: order.indexOf(answer),
    ...(perOption ? { perOption: order.map((from) => perOption[from]) } : {}),
  };
}

/** A repeatable random number source from a string: the same seed gives the same sequence. */
export function seededRandom(seed: string): () => number {
  // FNV-1a hash of the seed, then mulberry32.
  let state = 0x811c9dc5;
  for (let position = 0; position < seed.length; position += 1) {
    state ^= seed.charCodeAt(position);
    state = Math.imul(state, 0x01000193);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The right option gives itself away when it is much longer than every
 * other: a reader picks the longest and is right. Above this ratio to the
 * longest wrong option (and this many characters more) it must be evened out.
 */
export const STANDOUT_RATIO = 1.4;
export const STANDOUT_MIN_CHARS = 20;

function standsOut(options: string[], answer: number): boolean {
  if (options.length < 3 || answer < 0 || answer >= options.length) return false;
  const right = options[answer].length;
  const longestWrong = Math.max(...options.filter((_, position) => position !== answer).map((option) => option.length));
  return right >= longestWrong * STANDOUT_RATIO && right - longestWrong >= STANDOUT_MIN_CHARS;
}

export const letter = (position: number) => String.fromCharCode(65 + position);

/** One right option among several. Response: `{ "choice": <option index> }`. */
export const choiceKind: QuestionKind = {
  id: "choice",
  label: "Multiple choice",
  description: "Pick the one right answer from a few options.",
  fields: {
    options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: MAX_OPTIONS, description: "The options, all different." },
    answer: { type: "integer", minimum: 0, description: "The index of the one right option, from 0." },
    optionFeedback: { type: "array", items: { type: "string" }, description: "Optional: one line per option, in the same order, explaining what that option gets right or where it goes off. The player says right or wrong itself, so a line does not open with a verdict." },
  },
  guidance:
    '"kind":"choice", "options":["...","..."] (2 to 8, all different, each plausible to someone who misread the passage), "answer":<index of the one right option, from 0>, "optionFeedback":["..."] (optional, one line per option explaining what it gets right or where it goes off; the player says right or wrong itself, so no line opens with a verdict). Exactly one option may be right; no "all of the above" or "none of the above". Make the options alike in length and detail, so the right one does not stand out by length. Any order is fine: the engine shuffles them.',
  normalize(raw) {
    const options = texts(raw.options);
    const optionFeedback = texts(raw.optionFeedback);
    return {
      options,
      answer: index(raw.answer) ?? -1,
      ...(optionFeedback.length === options.length && options.length > 0 ? { optionFeedback } : {}),
    };
  },
  check(question) {
    const issues = optionIssues(question.options, question.answer, "");
    const feedback = question.optionFeedback;
    if (feedback !== undefined && (!Array.isArray(feedback) || feedback.length !== (question.options as unknown[] | undefined)?.length)) {
      issues.push({ path: ".optionFeedback", code: "option_feedback", message: "optionFeedback needs one entry per option" });
    }
    for (const [position, option] of (Array.isArray(question.options) ? question.options : []).entries()) {
      if (typeof option === "string" && /\b(all|none) of the above\b/i.test(option)) {
        issues.push({ path: `.options[${position}]`, code: "of_the_above", message: '"all/none of the above" options are not allowed' });
      }
    }
    if (issues.length === 0 && standsOut(question.options as string[], question.answer as number)) {
      issues.push({
        path: ".options",
        code: "answer_stands_out",
        message: "the right option is much longer than every wrong one, so length gives it away; make the options alike in length and detail",
      });
    }
    return issues;
  },
  arrange(question, random) {
    const options = question.options as string[];
    const feedback = Array.isArray(question.optionFeedback) ? (question.optionFeedback as string[]) : undefined;
    const arranged = reorder(options, question.answer as number, permutation(options.length, random), feedback);
    return { options: arranged.options, answer: arranged.answer, ...(arranged.perOption ? { optionFeedback: arranged.perOption } : {}) };
  },
  describeAnswer(question) {
    const options = question.options as string[];
    const answer = question.answer as number;
    return `${letter(answer)}) ${options[answer]}`;
  },
  alternatives(question) {
    const options = question.options as string[];
    return options.map((option, position) => `${letter(position)}) ${option}`).filter((_, position) => position !== question.answer);
  },
  grade(question, response) {
    const choice = isRecord(response) ? index(response.choice) : undefined;
    if (choice === undefined) return { fraction: 0, answered: false };
    return { fraction: choice === question.answer ? 1 : 0, answered: true };
  },
  describeShown(question) {
    const options = Array.isArray(question.options) ? (question.options as string[]) : [];
    return options.map((option, position) => `${letter(position)}) ${option}`);
  },
  describeResponse(question, response) {
    const choice = isRecord(response) ? index(response.choice) : undefined;
    const options = Array.isArray(question.options) ? (question.options as string[]) : [];
    if (choice === undefined || choice >= options.length) return undefined;
    const line = Array.isArray(question.optionFeedback) ? (question.optionFeedback as string[])[choice] : undefined;
    return `${letter(choice)}) ${options[choice]}${line ? ` (the quiz's line on that option: "${line}")` : ""}`;
  },
};

export type WorkedStep =
  | EntryStep
  | { prompt: string; input: "choice"; options: string[]; answer: number; hint?: string };

/**
 * A step answered by typing. Written today with one value (one box); an older
 * quiz may have several boxes in one step. `unit` is shown beside the box and
 * may be typed or left off; `form` says what shape the answer takes ("to one
 * decimal place"), shown under it; `accept` lists other answers that are also
 * right, beyond the forms `sameAnswer` already treats as the same.
 */
export interface EntryStep {
  prompt: string;
  input: "entries";
  values: string[];
  unit?: string;
  form?: string;
  accept?: string[];
  hint?: string;
}

/**
 * The boxes a typed step shows, each with the answers it takes. An older
 * step whose several values are all one answer written different ways
 * ("52.5", "52.50") is one box taking any of them.
 */
export function entryBoxes(step: EntryStep): string[][] {
  const values = step.values;
  const accept = step.accept ?? [];
  if (values.length > 1 && values.every((value) => sameAnswer(value, values[0]!, step.unit))) return [[...values, ...accept]];
  return values.map((value, at) => (at === 0 && values.length === 1 ? [value, ...accept] : [value]));
}

/** Whether a typed step's boxes hold right answers. */
export function entriesRight(step: EntryStep, given: unknown): boolean {
  const boxes = entryBoxes(step);
  const values = Array.isArray(given) ? given : [];
  return values.length === boxes.length && boxes.every((answers, at) => typeof values[at] === "string" && answers.some((answer) => sameAnswer(values[at] as string, answer, step.unit)));
}

/**
 * A problem worked in steps; each step is checked before the next opens.
 * Response: `{ "steps": [{ "value": ["0","1"] | <option index>, "revealed"?: true }, ...] }`.
 * A step counts when its value is right and it was not revealed; the
 * question earns the share of steps that count.
 */
export const workedKind: QuestionKind = {
  id: "worked",
  label: "Worked, step-checked",
  description: "Work a problem through in steps; each step is checked, with a hint to reveal.",
  fields: {
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_STEPS,
      description: "The steps, in the order the work is done.",
      items: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          input: { type: "string", enum: ["entries", "choice"] },
          values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1, description: "For entries: the one answer typed for this step, as [\"...\"]. Equivalent forms (52.5 and 52.50, 1/4 and 0.25, with or without the unit, a decimal comma) are accepted on their own." },
          unit: { type: "string", description: "For entries: the unit the answer is in, shown beside the box (\"cm\", \"%\"); the person may type it or leave it off." },
          form: { type: "string", description: "For entries: what shape the answer takes, shown under the box, when it matters (\"to one decimal place\", \"as a fraction\")." },
          accept: { type: "array", items: { type: "string" }, description: "For entries: other answers that are also right in their own words (a synonym, another name), not other forms of the same number." },
          options: { type: "array", items: { type: "string" }, description: "For choice: the options." },
          answer: { type: "integer", minimum: 0, description: "For choice: the index of the right option." },
          hint: { type: "string" },
        },
        required: ["prompt", "input"],
      },
    },
  },
  guidance:
    '"kind":"worked", "steps":[ ... ] (1 to 12, in the order the work is done). A step is either {"prompt":"...","input":"entries","values":["..."],"unit":"...","form":"...","hint":"..."} with one box: values holds its one answer (a number or a word); unit, when it has one, is shown beside the box and may be typed or left off; form says what shape the answer takes when it matters ("to one decimal place"). Equivalent forms of a number are accepted on their own, so never list them; a step that asks for two things is two steps. Or {"prompt":"...","input":"choice","options":["...","..."],"answer":<index>,"hint":"..."} for a decision. The hint says what to look at again, without giving the answer. Use new numbers or a new case, not the passage\'s own worked example.',
  normalize(raw) {
    const steps = Array.isArray(raw.steps) ? raw.steps.filter(isRecord).map(normalizeStep) : [];
    return { steps };
  },
  check(question) {
    const steps = question.steps;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
      return [{ path: ".steps", code: "steps", message: `needs 1 to ${MAX_STEPS} steps` }];
    }
    const issues: KindIssue[] = [];
    steps.forEach((step: unknown, position) => {
      const at = `.steps[${position}]`;
      if (!isRecord(step) || typeof step.prompt !== "string" || !step.prompt.trim()) {
        issues.push({ path: `${at}.prompt`, code: "empty", message: "a step needs a prompt" });
        return;
      }
      if (step.input === "entries") {
        const values = step.values;
        if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string" || !values[0].trim()) {
          issues.push({ path: `${at}.values`, code: "values", message: 'an entries step has one box: values is its one answer, ["..."]; other forms of the same answer are accepted on their own, and a step that asks for two things is two steps' });
        }
      } else if (step.input === "choice") {
        issues.push(...optionIssues(step.options, step.answer, at));
      } else {
        issues.push({ path: `${at}.input`, code: "input", message: 'step input must be "entries" or "choice"' });
      }
    });
    return issues;
  },
  describeAnswer(question) {
    return (question.steps as WorkedStep[])
      .map((step, position) => `${position + 1}. ${step.prompt} → ${step.input === "entries" ? `${step.values.join(", ")}${step.unit ? ` ${step.unit}` : ""}${step.form ? ` (${step.form})` : ""}` : step.options[step.answer]}`)
      .join("\n");
  },
  arrange(question, random) {
    const steps = (question.steps as WorkedStep[]).map((step) => {
      if (step.input !== "choice") return step;
      const arranged = reorder(step.options, step.answer, permutation(step.options.length, random));
      return { ...step, options: arranged.options, answer: arranged.answer };
    });
    return { steps };
  },
  grade(question, response) {
    const steps = question.steps as WorkedStep[];
    const given = isRecord(response) && Array.isArray(response.steps) ? response.steps : [];
    if (!given.some((entry) => isRecord(entry))) return { fraction: 0, answered: false };
    const right = steps.filter((step, position) => {
      const entry = given[position];
      if (!isRecord(entry) || entry.revealed === true) return false;
      if (step.input === "choice") return entry.value === step.answer;
      return entriesRight(step, entry.value);
    }).length;
    return { fraction: right / steps.length, answered: true };
  },
  describeShown(question) {
    return (question.steps as WorkedStep[]).map(
      (step, position) => `Step ${position + 1}: ${step.prompt}${step.input === "choice" ? ` (options: ${step.options.map((option, at) => `${letter(at)}) ${option}`).join("; ")})` : step.unit ? ` (in ${step.unit})` : ""}`,
    );
  },
  describeResponse(question, response) {
    const steps = question.steps as WorkedStep[];
    const given = isRecord(response) && Array.isArray(response.steps) ? response.steps : [];
    const said = steps.flatMap((step, position) => {
      const entry = given[position];
      if (!isRecord(entry)) return [];
      if (entry.revealed === true) return [`step ${position + 1} shown to them`];
      const value = step.input === "choice" ? (typeof entry.value === "number" ? `${letter(entry.value)}) ${step.options[entry.value] ?? ""}` : "") : Array.isArray(entry.value) ? entry.value.join(", ") : "";
      const right = step.input === "choice" ? entry.value === step.answer : entriesRight(step, entry.value);
      return [`step ${position + 1}: ${value || "(blank)"}${step.input === "entries" && step.unit ? ` ${step.unit}` : ""}, ${right ? "right" : "wrong"}`];
    });
    return said.length ? said.join("; ") : undefined;
  },
};

function normalizeStep(raw: Record<string, unknown>): WorkedStep {
  const prompt = text(raw.prompt) ?? "";
  const hint = text(raw.hint);
  const base = { prompt, ...(hint ? { hint } : {}) };
  if (raw.input === "choice" || (raw.input === undefined && Array.isArray(raw.options))) {
    return { ...base, input: "choice", options: texts(raw.options), answer: index(raw.answer) ?? -1 };
  }
  const unit = text(raw.unit);
  const form = text(raw.form);
  const accept = texts(raw.accept);
  return { ...base, input: "entries", values: texts(raw.values), ...(unit ? { unit } : {}), ...(form ? { form } : {}), ...(accept.length ? { accept } : {}) };
}

/**
 * Issues with a list of texts that must each be filled in, short enough and
 * different from one another (case and spacing aside): the items to order,
 * the two sides of pairs, the names on a picture.
 */
export function listIssues(values: unknown, at: string, min: number, max: number, what: string): KindIssue[] {
  if (!Array.isArray(values) || values.length < min || values.length > max) return [{ path: at, code: "count", message: `needs ${min} to ${max} ${what}` }];
  const issues: KindIssue[] = [];
  const seen = new Map<string, number>();
  values.forEach((value, position) => {
    if (typeof value !== "string" || !value.trim()) issues.push({ path: `${at}[${position}]`, code: "empty", message: "must be non-empty text" });
    else if (value.length > MAX_TEXT) issues.push({ path: `${at}[${position}]`, code: "too_long", message: `at most ${MAX_TEXT} characters` });
    else {
      const key = normalizeAnswer(value);
      if (seen.has(key)) issues.push({ path: `${at}[${position}]`, code: "duplicate", message: `repeats entry ${seen.get(key)! + 1}; each must be different` });
      else seen.set(key, position);
    }
  });
  return issues;
}

/** True when `value` is an order of 0..length-1, each once. */
export function isPermutation(value: unknown, length: number): value is number[] {
  if (!Array.isArray(value) || value.length !== length) return false;
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry >= length || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

/** A shuffled order that is never the order written, so the person always has something to do. */
export function mixedPermutation(length: number, random: () => number): number[] {
  const order = permutation(length, random);
  if (length > 1 && order.every((from, position) => from === position)) order.push(order.shift()!);
  return order;
}
