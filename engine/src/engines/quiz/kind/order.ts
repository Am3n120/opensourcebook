/**
 * Put in order: a few things the source puts in a sequence (the stages of a
 * process, events in time, steps of a method, sizes from least to most),
 * shown mixed for the person to arrange.
 *
 * Fields: `items`, written in the right order; `shown`, the order they are
 * first shown in (indices into `items`), chosen by the engine and never the
 * right order. Response: `{ "order": [<item index>, ...] }`, the items as
 * the person arranged them. Each neighbouring pair in the right order earns
 * its share, so one item out of place costs less than a reversed list.
 */
import { index, isPermutation, isRecord, listIssues, mixedPermutation, texts, type QuestionKind } from "../kinds";
import type { QuizQuestion } from "../schema";

const MIN_ITEMS = 3;
const MAX_ITEMS = 8;

const items = (question: QuizQuestion): string[] => (Array.isArray(question.items) ? (question.items as string[]) : []);

/** The order a response gives, when it is a whole order of the question's items. */
function given(question: QuizQuestion, response: unknown): number[] | undefined {
  const order = isRecord(response) && Array.isArray(response.order) ? response.order.map(index) : undefined;
  return order && isPermutation(order, items(question).length) ? order : undefined;
}

/** The share of neighbouring pairs that follow each other as they should. */
export function orderFraction(order: number[]): number {
  if (order.length < 2) return order.length === 1 ? 1 : 0;
  let right = 0;
  for (let at = 0; at + 1 < order.length; at += 1) if (order[at + 1] === order[at]! + 1) right += 1;
  return right / (order.length - 1);
}

const listed = (question: QuizQuestion, order: number[]) => order.map((from, at) => `${at + 1}. ${items(question)[from] ?? ""}`).join("; ");

export const orderKind: QuestionKind = {
  id: "order",
  label: "Put in order",
  description: "Arrange a few things into the order the source gives them: stages, events, steps or sizes.",
  fields: {
    items: {
      type: "array",
      items: { type: "string" },
      minItems: MIN_ITEMS,
      maxItems: MAX_ITEMS,
      description: "The things to order, written in the right order. Open Sourcebook shows them mixed.",
    },
  },
  guidance: `"kind":"order", "items":["...","...","..."] (${MIN_ITEMS} to ${MAX_ITEMS}, written in the right order, all different). Use it only when the source itself settles the order (a sequence, a timeline, a ranking it states), and say in the prompt what the order is by ("from first to last", "from smallest to largest"). Items are alike in length and do not give their place away (no "first", "then", numbers or dates that order them on their own). Open Sourcebook shows them mixed.`,
  normalize(raw) {
    return { items: texts(raw.items) };
  },
  check(question) {
    const issues = listIssues(question.items, ".items", MIN_ITEMS, MAX_ITEMS, "items");
    if (question.shown !== undefined && !isPermutation(question.shown, items(question).length)) {
      issues.push({ path: ".shown", code: "shown", message: "shown must list every item's index once" });
    }
    return issues;
  },
  arrange(question, random) {
    return { shown: mixedPermutation(items(question).length, random) };
  },
  describeAnswer(question) {
    return listed(question, items(question).map((_, at) => at));
  },
  grade(question, response) {
    const order = given(question, response);
    return order ? { fraction: orderFraction(order), answered: true } : { fraction: 0, answered: false };
  },
  describeShown(question) {
    const shown = isPermutation(question.shown, items(question).length) ? question.shown : items(question).map((_, at) => at);
    return [`To put in order, shown mixed as: ${shown.map((from) => items(question)[from]).join("; ")}`];
  },
  describeResponse(question, response) {
    const order = given(question, response);
    return order ? `the order ${listed(question, order)}` : undefined;
  },
};
