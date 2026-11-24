/**
 * Fill in the working: a worked solution or a derivation shown line by line,
 * with a few parts left as gaps for the person to type. It checks that they
 * can carry each step, where a worked question has them build it alone.
 *
 * Fields: `lines`, the working in order, each line plain text where a gap is
 * written `[[answer]]` or `[[answer|another accepted answer]]`. Response:
 * `{ "gaps": ["...", ...] }`, what was typed into each gap in reading order.
 * A gap compares the way a typed step does (`sameAnswer`), and each gap
 * typed rightly earns its share.
 */
import { isRecord, sameAnswer, texts, type KindIssue, type QuestionKind } from "../kinds";
import type { QuizQuestion } from "../schema";

const MIN_LINES = 2;
const MAX_LINES = 12;
const MAX_GAPS = 6;
const MAX_LINE = 400;

const GAP = /\[\[([^[\]]*)\]\]/g;

/** One line split into its text and its gaps, in order. */
export type LinePart = { text: string } | { answers: string[] };

export function lineParts(line: string): LinePart[] {
  const parts: LinePart[] = [];
  let from = 0;
  for (const match of line.matchAll(GAP)) {
    if (match.index! > from) parts.push({ text: line.slice(from, match.index) });
    parts.push({ answers: match[1]!.split("|").map((answer) => answer.trim()).filter(Boolean) });
    from = match.index! + match[0].length;
  }
  if (from < line.length) parts.push({ text: line.slice(from) });
  return parts;
}

const lines = (question: QuizQuestion): string[] => (Array.isArray(question.lines) ? (question.lines as unknown[]).filter((line): line is string => typeof line === "string") : []);

/** Every gap's accepted answers, in reading order. */
export function gapsOf(question: QuizQuestion): string[][] {
  return lines(question).flatMap((line) => lineParts(line).flatMap((part) => ("answers" in part ? [part.answers] : [])));
}

function typed(response: unknown): string[] | undefined {
  if (!isRecord(response) || !Array.isArray(response.gaps)) return undefined;
  return response.gaps.map((value) => (typeof value === "string" ? value : ""));
}

const gapRight = (answers: string[], value: string | undefined) => value !== undefined && value.trim() !== "" && answers.some((answer) => sameAnswer(value, answer));

/** A line as the person sees it before answering, a gap drawn as a blank. */
const blanked = (line: string) => line.replace(GAP, "___");

export const completeKind: QuestionKind = {
  id: "complete",
  label: "Fill in the working",
  description: "A worked solution shown line by line, with a few parts left to type in.",
  fields: {
    lines: {
      type: "array",
      items: { type: "string" },
      minItems: MIN_LINES,
      maxItems: MAX_LINES,
      description: "The working in order, one line each; a part to type in is written [[answer]] or [[answer|another accepted answer]].",
    },
  },
  guidance: `"kind":"complete", "lines":["...","..."] (${MIN_LINES} to ${MAX_LINES} lines of working in order, plain text; $...$ for inline maths is fine but a gap is never inside it). Leave 1 to ${MAX_GAPS} short parts as gaps, written [[answer]] or [[answer|another accepted answer]]: a number, a word, a short term, each one the person can work out from the lines before it. Equivalent forms of a number (52.5 and 52.50, 1/4 and 0.25, a unit typed or left off) are accepted on their own, so never list them. Use new numbers or a new case, not the passage's own worked example word for word.`,
  normalize(raw) {
    return { lines: texts(raw.lines) };
  },
  check(question) {
    const list = question.lines;
    if (!Array.isArray(list) || list.length < MIN_LINES || list.length > MAX_LINES) return [{ path: ".lines", code: "count", message: `needs ${MIN_LINES} to ${MAX_LINES} lines` }];
    const issues: KindIssue[] = [];
    list.forEach((line, at) => {
      if (typeof line !== "string" || !line.trim()) issues.push({ path: `.lines[${at}]`, code: "empty", message: "a line must be non-empty text" });
      else if (line.length > MAX_LINE) issues.push({ path: `.lines[${at}]`, code: "too_long", message: `a line is at most ${MAX_LINE} characters` });
      else if (/\[\[|\]\]/.test(line.replace(GAP, ""))) issues.push({ path: `.lines[${at}]`, code: "gap", message: "a gap is [[answer]], opened and closed on the same line, never nested" });
      else if (lineParts(line).some((part) => "answers" in part && part.answers.length === 0)) issues.push({ path: `.lines[${at}]`, code: "gap", message: "a gap holds its answer, [[answer]]" });
      else if (lineParts(line).some((part, position, parts) => "answers" in part && insideMath(parts.slice(0, position)))) issues.push({ path: `.lines[${at}]`, code: "gap", message: "a gap is never inside $...$; close the maths before it" });
    });
    const count = gapsOf(question).length;
    if (issues.length === 0 && (count < 1 || count > MAX_GAPS)) issues.push({ path: ".lines", code: "gaps", message: `leave 1 to ${MAX_GAPS} gaps, each [[answer]]; it has ${count}` });
    return issues;
  },
  describeAnswer(question) {
    return gapsOf(question).map((answers, at) => `gap ${at + 1}: ${answers.join(" or ")}`).join("; ");
  },
  grade(question, response) {
    const values = typed(response);
    const gaps = gapsOf(question);
    if (!values || gaps.length === 0 || values.every((value) => !value.trim())) return { fraction: 0, answered: false };
    return { fraction: gaps.filter((answers, at) => gapRight(answers, values[at])).length / gaps.length, answered: true };
  },
  describeShown(question) {
    return [`The working, with gaps to fill in:`, ...lines(question).map(blanked)];
  },
  describeResponse(question, response) {
    const values = typed(response);
    if (!values) return undefined;
    return gapsOf(question).map((answers, at) => `gap ${at + 1}: ${values[at]?.trim() || "(blank)"} (${gapRight(answers, values[at]) ? "right" : "wrong"})`).join("; ");
  },
};

/** Whether the text before a point leaves a $...$ open. */
function insideMath(before: LinePart[]): boolean {
  const text = before.map((part) => ("text" in part ? part.text : "")).join("");
  return (text.replace(/\\\$/g, "").match(/\$/g) ?? []).length % 2 === 1;
}
