/**
 * A quiz and a branch under it, end to end with a scripted provider: the
 * real quiz engine makes the quiz through the output runner; its result,
 * graded by `gradeQuiz` as a player would, is recorded through the done
 * route; the `metric` branch reads the score; the branch item (another
 * quiz) takes the result as its input and plans from what was missed.
 */
import { describe, expect, it } from "vitest";
import { ownerIdForToken } from "../src/http";
import { handleRequest } from "../src/index";
import { createQuizDefinition } from "../src/engines/quiz/definition";
import { gradeQuiz } from "../src/engines/quiz/result";
import type { QuizPayload } from "../src/engines/quiz/schema";
import { PlanRunner } from "../src/studio/plan-runner";
import { FormatRegistry } from "../src/studio/registry";
import type { StructuredGenerationRequest } from "../src/types";
import { CLIENT_TOKEN, authed, bodyOf, createTestEngine } from "./support/engine-harness";
import { P1, P2, defaultHandlers, goodQuestions, planAnswer, stepOf } from "./support/quiz-script";

// The two paragraphs are short enough to be one stored chunk, P1.
const onePassage = (question: Record<string, unknown>) => ({
  ...question,
  cites: (question.cites as Array<{ quote: string }>).map((cite) => ({ passage: "P1", quote: cite.quote })),
});
const answer = (request: StructuredGenerationRequest) => {
  switch (stepOf(request)) {
    case "plan":
      return { ...planAnswer, targets: planAnswer.targets.map((target) => ({ ...target, passages: ["P1"] })) };
    case "write":
      return { questions: [onePassage(goodQuestions.t1), onePassage(goodQuestions.t2)] };
    default:
      return defaultHandlers[stepOf(request)](request);
  }
};

async function setup() {
  const registry = new FormatRegistry().register(createQuizDefinition({ sleep: async () => undefined }));
  const engine = createTestEngine({ registry, answer });
  const { repos } = engine.deps;
  const ownerId = await ownerIdForToken(CLIENT_TOKEN);
  const project = await repos.projects.create({ ownerId, title: "Biology" });
  const { source } = await engine.deps.sources.add({ ownerId, projectId: project.id, text: `${P1}\n\n${P2}` });
  const plan = await repos.plans.create({ ownerId, projectId: project.id, title: "Enzymes" });
  const queue: string[] = [];
  const runner = new PlanRunner({ repos, jobs: engine.deps.jobs, registry, schedule: async (jobId) => void queue.push(jobId) });
  engine.deps.plans = runner;
  engine.deps.consumer = { ...engine.deps.consumer, onFinished: (job) => runner.onJobFinished(job) };

  const quiz = await repos.plans.addNode({
    planId: plan.id, ord: 0, level: 0, type: "quiz", title: "Quiz", prompt: "Quiz the two ideas.", settings: { questions: 2, passMark: 70 },
  });
  const fix = await repos.plans.addNode({
    planId: plan.id, ord: 0, level: 1, type: "quiz", title: "Fix", prompt: "Go back over what was missed.",
    parentId: quiz.id, condition: { kind: "metric", metric: "score", below: 0.7 },
  });
  for (const node of [quiz, fix]) await repos.plans.setNodeSources(node.id, [{ sourceId: source.id }]);
  await repos.plans.addEdge({ fromNode: quiz.id, toNode: fix.id, kind: "fix_of" });
  await repos.plans.setStatus(plan.id, "approved");
  await runner.kickOff(plan.id);
  const drain = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await engine.deliver(next);
  };
  await drain();

  const output = await repos.outputs.latestForNode(quiz.id);
  const status = async () => Object.fromEntries((await repos.plans.listNodes(plan.id)).map((node) => [node.title, node.status]));
  /** What the player does when the person finishes: grade, then tick done with the result. */
  const finish = async (responses: Record<string, unknown>) => {
    const result = gradeQuiz(output!.payload as unknown as QuizPayload, responses);
    const response = await handleRequest(authed(`/v1/plans/${plan.id}/items/${quiz.id}/done`, { method: "POST", body: { result } }), engine.deps);
    expect(response.status).toBe(200);
    await drain();
    return result;
  };
  const plansCalls = () => engine.provider.calls.filter((call) => stepOf(call) === "plan");
  // The engine shuffles options, so the right ones are read from the stored quiz.
  const questions = (output!.payload as unknown as QuizPayload).questions;
  const right = { q1: questions[0].answer as number, step: (questions[1].steps as Array<{ answer: number }>)[0].answer };
  const wrong = { q1: ((questions[0].options as string[]).length - 1 + right.q1) % (questions[0].options as string[]).length };
  return { engine, repos, quiz, fix, output, status, finish, plansCalls, right, wrong };
}

describe("a quiz with a branch under it", () => {
  it("makes the quiz, then runs the branch when the score is below the threshold, with the result as its input", async () => {
    const t = await setup();
    expect(t.output).toMatchObject({ type: "quiz", schemaVersion: 1, title: "Enzymes quiz" });
    expect((t.output!.payload as unknown as QuizPayload).questions).toHaveLength(2);
    expect(t.output!.costUsd).toBeGreaterThan(0);
    expect(await t.status()).toEqual({ Quiz: "done", Fix: "pending" });

    // q1 wrong; q2's first step revealed, second right: 0.5 of 2 points.
    const result = await t.finish({ q1: { choice: t.wrong.q1 }, q2: { steps: [{ value: t.right.step, revealed: true }, { value: ["falls"] }] } });
    expect(result).toMatchObject({ score: 0.25, passed: false, missed: ["q1", "q2"] });

    expect(await t.status()).toEqual({ Quiz: "done", Fix: "done" });
    const [, fixPlan] = t.plansCalls();
    expect(fixPlan.userPrompt).toContain("Go back over what was missed.");
    expect(fixPlan.userPrompt).toContain("an earlier quiz (fix_of) scored 25%; topics missed, weakest first: Activation energy, Temperature");
    const fixOutput = await t.repos.outputs.latestForNode(t.fix.id);
    expect(fixOutput?.type).toBe("quiz");
  });

  it("skips the branch when the score reaches the threshold", async () => {
    const t = await setup();
    const result = await t.finish({ q1: { choice: t.right.q1 }, q2: { steps: [{ value: t.right.step }, { value: ["Falls"] }] } });
    expect(result).toMatchObject({ score: 1, passed: true, topicsMissed: [] });
    expect(await t.status()).toEqual({ Quiz: "done", Fix: "skipped" });
    expect(t.plansCalls()).toHaveLength(1);
  });
});
