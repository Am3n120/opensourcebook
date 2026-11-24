/**
 * What the player asks of a kind beyond drawing it (pieces.tsx): when it is
 * answered, its verdict, the line tied to what was picked, its keys. Kept
 * apart from the pieces' views, which export only themselves.
 */
import { stepRight, type Outcome, type Question, type Response } from "../quizGrade";
import { verdictWord, withoutVerdict } from "../verdict";

export type WorkedResponse = { steps: Array<{ value: number | string[]; revealed?: boolean }> };

const pickedOf = (r: Response | undefined) => (r as { choice?: number } | undefined)?.choice;

/** A choice's own line on the option picked. */
export function choiceSaid(q: Question, r: Response | undefined): string | undefined {
  const picked = pickedOf(r);
  return picked === undefined ? undefined : withoutVerdict(q.optionFeedback?.[picked]);
}

/** A letter picks that option. */
export function choiceKey(q: Question, key: string): Response | undefined {
  if (!/^[a-h]$/i.test(key)) return undefined;
  const i = key.toUpperCase().charCodeAt(0) - 65;
  return i < (q.options?.length ?? 0) ? { choice: i } : undefined;
}

/** A worked question's verdict counts its steps, and says plainly that a shown step costs that step only. */
export function workedVerdict(q: Question, response: Response | undefined, outcome: Outcome): string {
  const steps = q.steps ?? [];
  const given = (response as WorkedResponse | undefined)?.steps ?? [];
  const shown = given.filter((g) => g?.revealed).length;
  if (outcome === "right") return verdictWord(outcome);
  if (steps.length === 1) return shown ? "Shown, so this one doesn't count." : verdictWord(outcome);
  const right = steps.filter((s, i) => given[i] && !given[i]!.revealed && stepRight(s, given[i]!.value)).length;
  const cost = shown === 0 ? "" : shown === 1 ? " The step you were shown doesn't count; the others do." : ` The ${shown} steps you were shown don't count; the others do.`;
  return `${right} of ${steps.length} steps right.${cost}`;
}


/** Put in order says how many items are in their place, unless all are. */
export function orderVerdict(q: Question, response: Response | undefined, outcome: Outcome): string {
  if (outcome === "right") return verdictWord(outcome);
  const order = (response as { order?: number[] } | undefined)?.order ?? [];
  const placed = order.filter((k, i) => k === i).length;
  return `${placed} of ${q.items?.length ?? order.length} in place`;
}

/** A question counts as answered once every step is checked. */
export function stepsDone(q: Question, r: Response | undefined): boolean {
  const steps = (r as WorkedResponse | undefined)?.steps ?? [];
  return (q.steps ?? []).every((_, i) => steps[i]?.value !== undefined && (steps[i] as { checked?: boolean }).checked === true);
}

/** A problem worked in steps, each checked before the next opens. */

/** 1st, 2nd, 3rd, 4th, ... 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${end}`;
}
