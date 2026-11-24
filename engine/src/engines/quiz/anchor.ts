/**
 * A spot in a quiz in words (`FormatDefinition.describeAnchor`): the
 * question the person is on, as the quiz player keeps it (`{ at, responses,
 * ended }`), with what it shows, the person's answer, whether it was right,
 * the right answer and what the quiz told them. Each kind says its own part
 * (`describeShown`, `describeResponse`, `describeAnswer`), so a new kind
 * brings its own words.
 */
import type { AnchorWords, JsonValue } from "../../studio/types";
import type { QuestionKindRegistry } from "./kinds";
import type { QuizPayload } from "./schema";

const OUTCOME = { right: "right", wrong: "wrong", partial: "partly right" } as const;

export function quizAnchor(kinds: QuestionKindRegistry) {
  return (quiz: QuizPayload, at: JsonValue): AnchorWords | undefined => {
    if (!at || typeof at !== "object" || Array.isArray(at) || !Array.isArray(quiz?.questions)) return undefined;
    const index = typeof at.at === "number" && Number.isInteger(at.at) ? at.at : undefined;
    const question = index === undefined ? undefined : quiz.questions[index];
    if (!question) return undefined;
    const kind = kinds.get(question.kind);
    const responses = at.responses && typeof at.responses === "object" && !Array.isArray(at.responses) ? at.responses : {};
    const response = responses[question.id];
    const grade = kind && response !== undefined ? kind.grade(question, response) : undefined;
    const answered = grade?.answered === true;
    const outcome = !answered ? undefined : grade.fraction >= 1 ? OUTCOME.right : grade.fraction <= 0 ? OUTCOME.wrong : OUTCOME.partial;
    const facts = [`Question ${index! + 1} of ${quiz.questions.length}${question.topic ? ` (on ${question.topic})` : ""}: ${question.prompt}`];
    if (question.display) facts.push(`Shown under it: ${question.display}`);
    for (const line of kind?.describeShown?.(question) ?? []) facts.push(line);
    if (answered) {
      const said = kind?.describeResponse?.(question, response);
      facts.push(`Their answer: ${said ?? "given"}. That is ${outcome}.`);
    } else facts.push("They have not answered it yet, so they have not seen the right answer or the explanation.");
    if (kind) facts.push(`The right answer, as the quiz has it: ${kind.describeAnswer(question)}`);
    if (answered) {
      const told = outcome === OUTCOME.right ? question.feedback?.correct : question.feedback?.incorrect;
      if (told) facts.push(`The explanation the quiz gave them: "${told}"`);
    }
    for (const cite of question.cites ?? []) if (cite.quote) facts.push(`The quiz cites for it: "${cite.quote}"`);
    return { label: `question ${index! + 1}${outcome ? ` · ${outcome}` : ""}`, facts };
  };
}
