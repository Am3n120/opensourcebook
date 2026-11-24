/**
 * Prompts for the quiz engine's four model steps: plan what to test, write
 * questions, review them against their passages, repair one question. Each
 * system prompt names its step on the first line, so a log (or a scripted
 * provider in tests) can tell the calls apart.
 *
 * What the quiz is for comes only from the brief. Nothing here names a
 * purpose, a subject or a length.
 */
import type { NodeInput, PriorOutput } from "../../studio/types";
import type { Difficulty } from "./definition";
import type { QuestionKind } from "./kinds";
import { renderPassages, type Passage } from "../../sources/passages";
import { readQuizResult } from "./result";
import type { QuizQuestion } from "./schema";

export type QuizStep = "plan" | "write" | "review" | "repair";

const GROUNDING = `
Grounded over fluent: every question, every answer and every line of feedback must follow from the passages given. If the passages do not say it, do not ask it, do not use it as an answer and do not put it in feedback. Do not bring in outside facts, even true ones.
Test understanding, not wording: ask the person to apply, compare, explain or decide with what a passage says, not to recall its phrasing. Never quote the passage in the question so that matching words gives the answer away.
Passages are named by labels like P3. Cite by label. Labels and the passages themselves are for you only: the person reads the source, never labelled passages. In a question, option, hint or feedback never point at a passage or write a label ("P3 says", "as passage 2 says", "the passage above"); say what the source says, or name the source by its title. A word the subject itself uses ("final passage of a bill") is fine. A quote must be copied word for word from the cited passage (one sentence or a short span), never paraphrased or joined with "...".
Return JSON only.`.trim();

export function systemPrompt(step: QuizStep): string {
  const role: Record<QuizStep, string> = {
    plan: "You plan a quiz: a set of questions with feedback that tests what someone understood from their sources.",
    write: "You write questions for a quiz, one per target, from the passages each target names.",
    review: "You review quiz questions strictly against the passages they cite. You are the last line before a person sees them.",
    repair: "You rewrite one quiz question so it clears every issue listed, changing as little as the issues need.",
  };
  return `Step: ${step}\n${role[step]}\n${GROUNDING}`;
}

export interface PlanPromptInput {
  title: string;
  brief: string;
  questions: number;
  maxQuestions: number;
  kinds: QuestionKind[];
  difficulty: Difficulty;
  passages: Passage[];
  omittedPassages: number;
  assumes: PriorOutput[];
  inputs: NodeInput[];
  /** Lines saying which sources were cut and how much of them the passages are. */
  cut?: string[];
  /** The time allowed and the real paper's format (`sittingNote`), when set. */
  sitting?: string;
}

export function buildPlanPrompt(input: PlanPromptInput): string {
  const parts: string[] = [];
  if (input.title.trim()) parts.push(`Item title: ${input.title.trim()}`);
  parts.push(
    input.brief.trim()
      ? `Brief (what this quiz is for and what it covers; follow it):\n${input.brief.trim()}`
      : "Brief: none. Test the main ideas of the passages, evenly.",
  );
  parts.push(
    input.questions > 0
      ? `Length: exactly ${input.questions} targets.`
      : `Length: decide from the brief and from how much the passages hold, between 1 and ${input.maxQuestions} targets. One target per distinct idea worth testing; do not pad.`,
  );
  parts.push(`Question kinds allowed:\n${input.kinds.map((kind) => `- ${kind.id}: ${kind.label}`).join("\n")}\nPick per target the kind that tests it best.`);
  parts.push(`Difficulty: ${difficultyLine(input.difficulty)}`);
  if (input.sitting) parts.push(input.sitting);

  const earlier = earlierResults(input.inputs);
  if (earlier) parts.push(earlier);
  if (input.assumes.length > 0) {
    parts.push(
      `Already seen by the person before this quiz (titles and summaries, for context; questions still come only from the passages):\n${input.assumes
        .map((prior) => `- ${prior.title}: ${prior.summary}`)
        .join("\n")}`,
    );
  }

  if (input.cut?.length) parts.push(input.cut.join("\n"));
  parts.push(
    `Passages${input.omittedPassages > 0 ? ` (${input.passages.length} of ${input.passages.length + input.omittedPassages}, taken evenly across everything this quiz covers; only these can be tested, so spread the questions across them unless the brief asks otherwise)` : ""}:\n${renderPassages(input.passages)}`,
  );
  parts.push(
    `Return {"title":"a short title for the quiz","targets":[{"topic":"2 to 4 words","objective":"the one thing this question tests, in a sentence","kind":"<kind id>","passages":["P1"],"difficulty":"easier|standard|harder"}]}.
Each target tests one idea that the passages it lists state. No two targets test the same idea. Spread targets across what the brief covers; do not cluster on the first passages.`,
  );
  return parts.join("\n\n");
}

function difficultyLine(difficulty: Difficulty): string {
  switch (difficulty) {
    case "easier":
      return "easier: direct use of one idea at a time.";
    case "harder":
      return "harder: combine ideas, use them on a new case, or spot where an argument goes wrong.";
    case "standard":
      return "standard: use an idea on a case the passage does not work through itself.";
    default:
      return "as the brief asks; when it says nothing, aim at someone who has just studied these passages.";
  }
}

export function earlierResults(inputs: NodeInput[]): string | undefined {
  const lines = inputs
    .map((input) => {
      const result = readQuizResult(input.result);
      if (!result) return undefined;
      const missed = result.topicsMissed.length ? `; topics missed, weakest first: ${result.topicsMissed.join(", ")}` : "; nothing missed";
      return `- an earlier ${input.type} (${input.kind}) scored ${Math.round(result.score * 100)}%${missed}`;
    })
    .filter((line): line is string => line !== undefined);
  if (lines.length === 0) return undefined;
  return `Results the person recorded on earlier items this one takes as input:\n${lines.join("\n")}\nUse them as the brief says (for example, aim targets at what was missed).`;
}

/**
 * The time allowed and the format of the real paper, for whoever writes the
 * quiz; undefined when neither is set. The settings' number of questions
 * still holds when the format says another.
 */
export function sittingNote(settings: { timeLimit?: number; layout?: string; questions: number }): string | undefined {
  const parts: string[] = [];
  const layout = settings.layout?.trim();
  if (layout) {
    parts.push(
      `Format to follow: the person says the real paper is laid out like this:\n${layout}\nWrite the quiz to match it as far as the sources and the kinds allowed let you: its parts in their order, its mix of kinds, and its marks per question as each question's points${settings.questions > 0 ? "" : ", and its number of questions"}. Where it asks for something the sources cannot test, keep to the sources.`,
    );
  }
  if (settings.timeLimit && settings.timeLimit > 0) {
    parts.push(`Time allowed: ${settings.timeLimit} minutes from Start, and the quiz ends when they run out. Size and pitch the questions so someone who knows the material can finish in that time.`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export interface WriteTarget {
  ref: string;
  topic: string;
  objective: string;
  kind: QuestionKind;
  difficulty?: string;
  passages: Passage[];
}

export function buildWritePrompt(targets: WriteTarget[], brief: string, cut: string[] = [], pictures?: string, sitting?: string): string {
  const kinds = [...new Map(targets.map((target) => [target.kind.id, target.kind])).values()];
  const passages = uniquePassages(targets.flatMap((target) => target.passages));
  return [
    brief.trim() ? `Brief of the quiz:\n${brief.trim()}` : "",
    sitting ?? "",
    cut.join("\n"),
    `Targets, one question each:\n${targets
      .map(
        (target) =>
          `- ${target.ref} [${target.kind.id}${target.difficulty ? `, ${target.difficulty}` : ""}] topic "${target.topic}": ${target.objective} (passages ${target.passages.map((passage) => passage.label).join(", ")})`,
      )
      .join("\n")}`,
    `Passages:\n${renderPassages(passages)}`,
    pictures ?? "",
    `Return {"questions":[{"target":"<ref>","topic":"...","prompt":"the question","display":"optional LaTeX shown under the prompt","points":1,"feedback":{"correct":"why this is right, from the passage","incorrect":"what the passage says and where a wrong answer goes off"},"cites":[{"passage":"P1","quote":"copied word for word"}], ...fields of its kind}]}
Fields per kind:
${kinds.map((kind) => `${kind.id}: ${kind.guidance}`).join("\n")}
Cite the passages the target names. Feedback teaches: it explains, and it does not open with right or wrong, because the player says that itself.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface ReviewItem {
  id: string;
  question: QuizQuestion;
  kind: QuestionKind;
  passages: Passage[];
}

export function buildReviewPrompt(items: ReviewItem[]): string {
  const passages = uniquePassages(items.flatMap((item) => item.passages));
  return [
    `Passages:\n${renderPassages(passages)}`,
    `Questions:\n${items
      .map((item) => {
        const alternatives = item.kind.alternatives?.(item.question) ?? [];
        return [
          `## ${item.id} (${item.kind.label}), cites ${item.passages.map((passage) => passage.label).join(", ")}`,
          `Question: ${item.question.prompt}${item.question.display ? `\nShown: ${item.question.display}` : ""}`,
          `Marked answer: ${item.kind.describeAnswer(item.question)}`,
          alternatives.length ? `Other options: ${alternatives.join(" | ")}` : "",
          `Feedback if right: ${item.question.feedback.correct}`,
          `Feedback if wrong: ${item.question.feedback.incorrect}`,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n")}`,
    `For each question decide, using only its cited passages:
- answerable: someone who understood the cited passages can answer it without anything else.
- correct: the marked answer (every step, for a worked question) is right by the passages.
- unique: no other option is also right or defensible (true when the kind has no options).
- grounded: nothing in the question, options or feedback states something the passages do not.
Return {"reviews":[{"id":"<id>","answerable":true,"correct":true,"unique":true,"grounded":true,"note":"what is wrong, when anything is"}]}, one per question.`,
  ].join("\n\n");
}

export function buildRepairPrompt(target: WriteTarget, question: QuizQuestion, issues: string[]): string {
  const { cites, id: _id, ...rest } = question;
  const cited = cites.map((cite) => ({ passage: target.passages.find((passage) => passage.id === cite.passageId)?.label ?? cite.passageId, quote: cite.quote }));
  return [
    `Target ${target.ref} [${target.kind.id}] topic "${target.topic}": ${target.objective}`,
    `Passages:\n${renderPassages(target.passages)}`,
    `Current question:\n${JSON.stringify({ ...rest, cites: cited })}`,
    `Issues to clear:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    `Fields of this kind: ${target.kind.guidance}
Return {"question":{...}} with the same fields as above. Keep what is not wrong; if the target cannot be tested from these passages as written, test the closest idea they do state.`,
  ].join("\n\n");
}

function uniquePassages(passages: Passage[]): Passage[] {
  return [...new Map(passages.map((passage) => [passage.id, passage])).values()];
}
