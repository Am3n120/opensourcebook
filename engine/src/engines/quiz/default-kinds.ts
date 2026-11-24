/**
 * The kinds of quiz question Open Sourcebook writes today, in the order settings forms
 * offer them. A new kind is one file in `kind/` and one line here.
 */
import { completeKind } from "./kind/complete";
import { graphKind } from "./kind/graph";
import { labelKind } from "./kind/label";
import { matchKind } from "./kind/match";
import { orderKind } from "./kind/order";
import { choiceKind, QuestionKindRegistry, workedKind } from "./kinds";

export function createDefaultQuestionKinds(): QuestionKindRegistry {
  return new QuestionKindRegistry().register(choiceKind).register(workedKind).register(orderKind).register(matchKind).register(completeKind).register(graphKind).register(labelKind);
}
