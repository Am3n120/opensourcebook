/**
 * Match pairs: things on the left, each matched to one on the right (a term
 * and its meaning, a cause and its effect, a person and what they did).
 *
 * Fields: `pairs`, each `{ left, right }` as they belong together; `rights`,
 * the order the right-hand side is offered in (indices into `pairs`), chosen
 * by the engine. Response: `{ "matches": [<pair index> | null, ...] }`, for
 * each left in order the pair whose right the person picked for it. Each
 * pair matched rightly earns its share.
 */
import { index, isPermutation, isRecord, listIssues, mixedPermutation, text, type KindIssue, type QuestionKind } from "../kinds";
import type { QuizQuestion } from "../schema";

const MIN_PAIRS = 2;
const MAX_PAIRS = 8;

export interface Pair {
  left: string;
  right: string;
}

const pairs = (question: QuizQuestion): Pair[] => (Array.isArray(question.pairs) ? (question.pairs as Pair[]) : []);

/** For each left, the pair index picked for it, or undefined when none was. */
function picked(question: QuizQuestion, response: unknown): Array<number | undefined> | undefined {
  if (!isRecord(response) || !Array.isArray(response.matches)) return undefined;
  const count = pairs(question).length;
  return pairs(question).map((_, at) => {
    const value = index((response.matches as unknown[])[at]);
    return value !== undefined && value < count ? value : undefined;
  });
}

export const matchKind: QuestionKind = {
  id: "match",
  label: "Match pairs",
  description: "Match each thing on the left to the one it goes with on the right.",
  fields: {
    pairs: {
      type: "array",
      minItems: MIN_PAIRS,
      maxItems: MAX_PAIRS,
      description: "The pairs as they belong together; Open Sourcebook offers the right-hand sides mixed.",
      items: { type: "object", properties: { left: { type: "string" }, right: { type: "string" } }, required: ["left", "right"] },
    },
  },
  guidance: `"kind":"match", "pairs":[{"left":"...","right":"..."}, ...] (${MIN_PAIRS} to ${MAX_PAIRS} pairs, every left different and every right different). Each left goes with exactly one right, as the source says; no right could fairly go with another left. The prompt says what joins them ("Match each term to its meaning"). Keep the rights alike in length and form, so none is matched by its grammar alone. Open Sourcebook offers the rights mixed.`,
  normalize(raw) {
    const list = Array.isArray(raw.pairs) ? raw.pairs.filter(isRecord) : [];
    return { pairs: list.map((pair) => ({ left: text(pair.left) ?? "", right: text(pair.right) ?? "" })) };
  },
  check(question) {
    const list = pairs(question);
    if (!Array.isArray(question.pairs) || list.length < MIN_PAIRS || list.length > MAX_PAIRS || !list.every(isRecord)) {
      return [{ path: ".pairs", code: "count", message: `needs ${MIN_PAIRS} to ${MAX_PAIRS} pairs, each {"left":"...","right":"..."}` }];
    }
    const issues: KindIssue[] = [];
    const side = (name: "left" | "right") =>
      listIssues(list.map((pair) => pair[name]), "", MIN_PAIRS, MAX_PAIRS, "pairs").map((issue) => ({ ...issue, path: `.pairs${issue.path}.${name}` }));
    issues.push(...side("left"), ...side("right"));
    if (question.rights !== undefined && !isPermutation(question.rights, list.length)) {
      issues.push({ path: ".rights", code: "rights", message: "rights must list every pair's index once" });
    }
    return issues;
  },
  arrange(question, random) {
    return { rights: mixedPermutation(pairs(question).length, random) };
  },
  describeAnswer(question) {
    return pairs(question).map((pair) => `${pair.left} → ${pair.right}`).join("; ");
  },
  grade(question, response) {
    const chosen = picked(question, response);
    if (!chosen || chosen.every((value) => value === undefined)) return { fraction: 0, answered: false };
    return { fraction: chosen.filter((value, at) => value === at).length / chosen.length, answered: true };
  },
  describeShown(question) {
    const list = pairs(question);
    const rights = isPermutation(question.rights, list.length) ? question.rights : list.map((_, at) => at);
    return [`To match: ${list.map((pair) => pair.left).join("; ")}`, `With, offered mixed: ${rights.map((at) => list[at]!.right).join("; ")}`];
  },
  describeResponse(question, response) {
    const chosen = picked(question, response);
    if (!chosen) return undefined;
    const list = pairs(question);
    return list.map((pair, at) => `${pair.left} → ${chosen[at] === undefined ? "(none)" : list[chosen[at]!]!.right}${chosen[at] === at ? " (right)" : " (wrong)"}`).join("; ");
  },
};
