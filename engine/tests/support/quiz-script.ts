/**
 * A scripted provider for the quiz engine: answers each of its four steps
 * (plan, write, review, repair) from a handler, by the "Step:" line its
 * system prompts open with. The default handlers make a two-question quiz
 * over the two passages below that passes review.
 */
import type { StructuredGenerationRequest, StructuredProvider, UsageSink } from "../../src/types";

export const P1 = "Enzymes speed up reactions by lowering the activation energy. They are not used up by the reaction they speed up.";
export const P2 = "Each enzyme has an optimum temperature. Above it the enzyme denatures and the rate falls quickly.";

export type Step = "plan" | "write" | "review" | "repair";
export type Handler = (request: StructuredGenerationRequest) => unknown;

export const stepOf = (request: StructuredGenerationRequest) => /^Step: (\w+)/.exec(request.systemPrompt)?.[1] as Step;

/** Answers each step from its handler and reports one usage event per call, as real adapters do. */
export function scripted(usage: UsageSink, handlers: Partial<Record<Step, Handler>> = {}) {
  const calls: StructuredGenerationRequest[] = [];
  const provider: StructuredProvider = {
    name: "scripted",
    async generateJSON<T>(request: StructuredGenerationRequest): Promise<T> {
      calls.push(request);
      await usage.record({ provider: "scripted", model: "m", task: request.task, tokensIn: 10, tokensOut: 5, usd: 0.001, latencyMs: 1, ok: true });
      const handler = { ...defaultHandlers, ...handlers }[stepOf(request)];
      if (!handler) throw new Error(`no handler for ${stepOf(request)}`);
      return handler(request) as T;
    },
  };
  return { provider, calls, ofStep: (step: Step) => calls.filter((call) => stepOf(call) === step) };
}

export const planAnswer = {
  title: "Enzymes quiz",
  targets: [
    { topic: "Activation energy", objective: "Why an enzyme speeds a reaction", kind: "choice", passages: ["P1"] },
    { topic: "Temperature", objective: "What happens past the optimum", kind: "worked", passages: ["P2"] },
  ],
};

export const goodQuestions: Record<string, Record<string, unknown>> = {
  t1: {
    target: "t1",
    topic: "Activation energy",
    prompt: "A reaction runs faster once an enzyme is added. What did the enzyme change?",
    options: ["It lowered the activation energy", "It was used up as fuel", "It raised the temperature"],
    answer: 0,
    feedback: { correct: "Enzymes lower the activation energy.", incorrect: "The source says enzymes lower activation energy and are not used up." },
    cites: [{ passage: "P1", quote: "Enzymes speed up reactions by lowering the activation energy." }],
  },
  t2: {
    target: "t2",
    topic: "Temperature",
    prompt: "An enzyme is heated well past its optimum. Work out what happens.",
    steps: [
      { prompt: "Past the optimum the enzyme…", input: "choice", options: ["denatures", "speeds up"], answer: 0, hint: "Read what happens above the optimum." },
      { prompt: "So the rate…", input: "entries", values: ["falls"] },
    ],
    feedback: { correct: "Above the optimum it denatures and the rate falls.", incorrect: "Above the optimum the enzyme denatures, so the rate falls quickly." },
    cites: [{ passage: "P2", quote: "Above it the enzyme denatures and the rate falls quickly." }],
  },
};

export const refsIn = (prompt: string) => [...prompt.matchAll(/^- (t\d+) \[/gm)].map((match) => match[1]);
export const idsIn = (prompt: string) => [...prompt.matchAll(/^## (q\d+) /gm)].map((match) => match[1]);
export const allGood = (request: StructuredGenerationRequest) => ({
  reviews: idsIn(request.userPrompt).map((id) => ({ id, answerable: true, correct: true, unique: true, grounded: true })),
});

export const defaultHandlers: Record<Step, Handler> = {
  plan: () => planAnswer,
  write: (request) => ({ questions: refsIn(request.userPrompt).map((ref) => goodQuestions[ref]) }),
  review: allGood,
  repair: (request) => {
    const ref = /^Target (t\d+)/.exec(request.userPrompt)![1];
    return { question: goodQuestions[ref] };
  },
};

