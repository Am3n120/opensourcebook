/**
 * The quiz engine over a scripted provider: the four steps through
 * runEngine, every validation rule, per-question repair, settings and the
 * descriptor.
 */
import { describe, expect, it } from "vitest";
import { createNullAssetStore } from "../src/assets";
import { InMemoryUsageSink } from "../src/providers/usage";
import { FormatRegistry, runEngine } from "../src/studio/registry";
import type { EngineCheckpoint, EngineContext, JsonValue, NodeInput, NodeSource } from "../src/studio/types";
import type { SourceEnvelope } from "../src/types";
import { createQuizDefinition, estimateQuizCost, parseQuizSettings, type QuizSettings } from "../src/engines/quiz/definition";
import { normalizePlan, type QuizBlueprint } from "../src/engines/quiz/engine";
import { createDefaultQuestionKinds } from "../src/engines/quiz/default-kinds";
import { choiceKind, seededRandom, workedKind } from "../src/engines/quiz/kinds";
import { buildPassages, quoteInPassage } from "../src/sources/passages";
import { buildPlanPrompt, sittingNote, systemPrompt } from "../src/engines/quiz/prompts";
import { P1, P2, allGood, goodQuestions, planAnswer, scripted, stepOf, type Handler, type Step } from "./support/quiz-script";

function envelope(text: string, title = "Enzymes"): SourceEnvelope {
  return {
    originalText: text,
    kind: "text",
    title,
    text,
    references: [],
    metadata: {},
    accessLevel: "full",
    depthCap: "light",
    limitations: [],
    fetchedAt: "2026-11-12T09:00:00.000Z",
  };
}

const chunked: NodeSource = {
  sourceId: "src-1",
  envelope: envelope(`${P1}\n\n${P2}`),
  chunks: [
    { id: "chunk-1", ord: 0, text: P1, locator: { charStart: 0, charEnd: P1.length } },
    { id: "chunk-2", ord: 1, text: P2, locator: { charStart: P1.length + 2, charEnd: P1.length + 2 + P2.length } },
  ],
};

function context(options: {
  handlers?: Partial<Record<Step, Handler>>;
  settings?: Record<string, unknown>;
  sources?: NodeSource[];
  prompt?: string;
  inputs?: NodeInput[];
} = {}) {
  const usage = new InMemoryUsageSink();
  const provider = scripted(usage, options.handlers);
  const parsed = parseQuizSettings(options.settings ?? {});
  if (!parsed.ok) throw new Error("bad settings in test");
  const ctx: EngineContext<QuizSettings> = {
    jobId: "job-1",
    node: { id: "node-1", type: "quiz", title: "Quiz", prompt: options.prompt ?? "Quiz the two main ideas.", settings: parsed.settings },
    sources: options.sources ?? [chunked],
    assumes: [],
    inputs: options.inputs ?? [],
    services: {
      provider: provider.provider,
      assets: createNullAssetStore(),
      usage,
      fetch: async () => new Response(null),
      now: () => "2026-11-12T09:00:00.000Z",
      progress: () => undefined,
    },
  };
  return { ctx, usage, ...provider };
}

const definition = createQuizDefinition({ sleep: async () => undefined, maxProviderAttempts: 2 });

describe("quiz engine: plan → generate → validate", () => {
  it("makes a valid quiz whose questions cite their passages, and reports every call to usage", async () => {
    const t = context({ settings: { passMark: 60 } });
    const result = await runEngine(definition, t.ctx);

    expect(result.report).toEqual({ valid: true, issues: [] });
    expect(result.repairRounds).toBe(0);
    const { payload } = result.output;
    expect(payload).toMatchObject({ title: "Enzymes quiz", passMark: 0.6, feedback: "afterEach" });
    expect(payload.questions.map((question) => [question.id, question.kind, question.topic])).toEqual([
      ["q1", "choice", "Activation energy"],
      ["q2", "worked", "Temperature"],
    ]);
    expect(payload.questions[0].cites).toEqual([
      { passageId: "chunk-1", sourceId: "src-1", chunkId: "chunk-1", locator: { charStart: 0, charEnd: P1.length }, quote: "Enzymes speed up reactions by lowering the activation energy." },
    ]);
    expect(result.output.citations.map((citation) => [citation.chunkId, citation.anchor])).toEqual([
      ["chunk-1", "questions[0]"],
      ["chunk-2", "questions[1]"],
    ]);
    expect(result.output.summary).toBe("A quiz of 2 questions on Activation energy, Temperature.");

    expect(t.calls.map(stepOf)).toEqual(["plan", "write", "review"]);
    expect(t.calls.map((call) => call.task)).toEqual(["planning", "section", "section"]);
    expect(t.usage.events).toHaveLength(3);
  });

  it("writes and reviews only the passages each batch tests", async () => {
    const t = context();
    await runEngine(definition, t.ctx);
    const [write] = t.ofStep("write");
    expect(write.userPrompt).toContain(P1);
    expect(write.userPrompt).toContain(P2);
    const [plan] = t.ofStep("plan");
    expect(plan.userPrompt).toContain("Quiz the two main ideas.");
  });

  it("asks for the fixed length and keeps the plan to it", async () => {
    const many = { ...planAnswer, targets: [...planAnswer.targets, { topic: "Reuse", objective: "Enzymes are not used up", kind: "choice", passages: ["P1"] }] };
    const t = context({ settings: { questions: 2 }, handlers: { plan: () => many } });
    const blueprint = await definition.engine.plan(t.ctx);
    expect(t.calls[0].userPrompt).toContain("exactly 2 targets");
    expect((blueprint.made as QuizBlueprint).targets).toHaveLength(2);
  });

  it("refuses an item with no source text", async () => {
    const t = context({ sources: [{ sourceId: "empty", envelope: envelope(""), chunks: [] }] });
    await expect(definition.engine.plan(t.ctx)).rejects.toThrow(/source text/);
    expect(t.calls).toHaveLength(0);
  });

  it("retries a plan with nothing usable, then fails", async () => {
    const t = context({ handlers: { plan: () => ({ targets: [{ topic: "x", objective: "y", kind: "choice", passages: ["P9"] }] }) } });
    await expect(definition.engine.plan(t.ctx)).rejects.toThrow(/no usable targets/);
    expect(t.ofStep("plan")).toHaveLength(2);
  });
});

describe("quiz engine: validation and per-question repair", () => {
  async function made(handlers: Partial<Record<Step, Handler>> = {}) {
    const t = context({ handlers });
    const blueprint = await definition.engine.plan(t.ctx);
    const output = await definition.engine.generate(t.ctx, blueprint);
    return { t, blueprint, output };
  }

  it("fails a quote that is not in its passage, repairs only that question, and keeps the others as they were", async () => {
    const write: Handler = () => ({
      questions: [goodQuestions.t1, { ...goodQuestions.t2, cites: [{ passage: "P2", quote: "Enzymes work at any temperature." }] }],
    });
    const t = context({ handlers: { write } });
    const result = await runEngine(definition, t.ctx);

    expect(result.report.valid).toBe(true);
    expect(result.repairRounds).toBe(1);
    const repairs = t.ofStep("repair");
    expect(repairs).toHaveLength(1);
    expect(repairs[0].userPrompt).toMatch(/^Target t2/);
    expect(repairs[0].userPrompt).toContain("quote_not_in_passage");
    expect(t.calls.map(stepOf)).toEqual(["plan", "write", "repair", "review"]);
    expect(result.output.payload.questions[1].cites[0].quote).toBe("Above it the enzyme denatures and the rate falls quickly.");
  });

  it("fails what the reviewer flags, with its note, and repairs just that question", async () => {
    let reviews = 0;
    const review: Handler = (request) => {
      reviews += 1;
      const verdicts = allGood(request).reviews;
      if (reviews === 1) verdicts[0] = { ...verdicts[0], correct: false, grounded: false, note: "B is also defensible" } as never;
      return { reviews: verdicts };
    };
    const t = context({ handlers: { review } });
    const result = await runEngine(definition, t.ctx);

    expect(result.report.valid).toBe(true);
    expect(t.ofStep("repair")).toHaveLength(1);
    expect(t.ofStep("repair")[0].userPrompt).toMatch(/^Target t1/);
    expect(t.ofStep("repair")[0].userPrompt).toContain("the marked answer is not right by the passages: B is also defensible");
    expect(t.ofStep("repair")[0].userPrompt).toContain("review_unsupported");
  });

  it("fails honestly when repair cannot clear an issue", async () => {
    const t = context({ handlers: { review: (request) => ({ reviews: allGood(request).reviews.map((verdict) => ({ ...verdict, answerable: false })) }) } });
    const result = await runEngine(definition, t.ctx);
    expect(result.report.valid).toBe(false);
    expect(result.repairRounds).toBe(2);
    expect(result.report.issues.map((issue) => [issue.path, issue.code])).toEqual([
      ["questions[0]", "review_unanswerable"],
      ["questions[1]", "review_unanswerable"],
    ]);
  });

  it("does not spend a review on an output that fails the checks in code", async () => {
    const { t, blueprint, output } = await made();
    output.payload.questions[0] = { ...output.payload.questions[0], prompt: "" };
    const report = await definition.engine.validate(t.ctx, output, blueprint);
    expect(report.issues).toEqual([{ path: "questions[0].prompt", code: "empty", message: "prompt must be non-empty text", severity: "error" }]);
    expect(t.ofStep("review")).toHaveLength(0);
  });

  it("checks each kind's rules, citations, and duplicates", async () => {
    const { t, blueprint, output } = await made();
    const [choice, worked] = output.payload.questions;
    output.payload.questions = [
      { ...choice, options: ["Lower activation energy", "lower  activation energy", "None of the above"], answer: 5 },
      { ...worked, steps: [{ prompt: "Rate?", input: "entries", values: [] }], cites: [{ ...worked.cites[0], passageId: "elsewhere" }] },
    ];
    let codes = (await definition.engine.validate(t.ctx, output, blueprint)).issues.map((issue) => `${issue.path} ${issue.code}`);
    expect(codes).toEqual([
      "questions[0].options[1] duplicate_option",
      "questions[0].answer answer",
      "questions[0].options[2] of_the_above",
      "questions[1].steps[0].values values",
      "questions[1].cites[0] unknown_passage",
    ]);

    output.payload.questions = [choice, { ...choice, id: "q2", kind: "choice", cites: worked.cites, prompt: `${choice.prompt} ` }];
    codes = (await definition.engine.validate(t.ctx, output, blueprint)).issues.map((issue) => `${issue.path} ${issue.code}`);
    expect(codes).toEqual(["questions[1].prompt duplicate"]);
  });

  it("refuses a kind the item's settings do not allow", async () => {
    const t = context({ settings: { kinds: ["choice"] } });
    const blueprint = { maker: "api", made: { title: "C", targets: [{ topic: "T", objective: "O", kind: "worked", passageIds: ["chunk-2"] }], requested: 0, omittedPassages: 0 } satisfies QuizBlueprint };
    const output = await definition.engine.generate(t.ctx, blueprint);
    // The engine writes the target's kind; validation holds the item to its settings.
    const report = await definition.engine.validate(t.ctx, output, blueprint);
    expect(report.issues.map((issue) => issue.code)).toEqual(["kind"]);
  });

  it("fails generate when every batch fails", async () => {
    const t = context({ handlers: { write: () => { throw new Error("upstream down"); } } });
    const blueprint = await definition.engine.plan(t.ctx);
    await expect(definition.engine.generate(t.ctx, blueprint)).rejects.toThrow(/Every batch/);
  });

  it("writes a question the batch left out during repair", async () => {
    const t = context({ handlers: { write: () => ({ questions: [goodQuestions.t1] }) } });
    const result = await runEngine(definition, t.ctx);
    expect(result.report.valid).toBe(true);
    expect(t.ofStep("repair").map((call) => /^Target (t\d+)/.exec(call.userPrompt)![1])).toEqual(["t2"]);
    expect(result.output.payload.questions[1].prompt).toBe(goodQuestions.t2.prompt);
  });

  it("warns, without failing, when the sources held fewer questions than asked", async () => {
    const t = context({ settings: { questions: 5 } });
    const result = await runEngine(definition, t.ctx);
    expect(result.report.valid).toBe(true);
    expect(result.report.issues).toEqual([
      { path: "$.questions", code: "short", message: "5 questions were asked for; the sources supported 2", severity: "warning" },
    ]);
  });
});

describe("quiz passages", () => {
  it("cites a source without stored chunks by character range, with no chunk id", () => {
    const passages = buildPassages([{ sourceId: "raw", envelope: envelope(`${P1}\n\n${P2}`), chunks: [] }]);
    expect(passages[0]).toMatchObject({ id: expect.stringMatching(/^raw@0-\d+$/), label: "P1", sourceId: "raw", locator: { charStart: 0 } });
    expect(passages[0].chunkId).toBeUndefined();
  });

  it("keeps to the item's range and labels passages in order across sources", () => {
    const second: NodeSource = { sourceId: "src-2", envelope: envelope(P2, "Other"), chunks: [{ id: "c9", ord: 0, text: P2, locator: { charStart: 0, charEnd: P2.length } }] };
    const ranged = { ...chunked, range: { charStart: 0, charEnd: 10 } };
    expect(buildPassages([ranged, second]).map((passage) => [passage.label, passage.id])).toEqual([
      ["P1", "chunk-1"],
      ["P2", "c9"],
    ]);
  });

  it("matches quotes word for word, ignoring case, spacing and quote marks", () => {
    const [passage] = buildPassages([chunked]);
    expect(quoteInPassage("enzymes  speed up reactions", passage)).toBe(true);
    expect(quoteInPassage("Enzymes speed up all reactions", passage)).toBe(false);
    expect(quoteInPassage("", passage)).toBe(false);
  });
});

describe("quiz plan", () => {
  it("drops unknown passages and repeated objectives, and falls back to an allowed kind", () => {
    const passages = buildPassages([chunked]);
    const blueprint = normalizePlan(
      {
        targets: [
          { topic: "A", objective: "Same idea", kind: "essay", passages: ["P1", "P7"] },
          { topic: "B", objective: "same  idea", kind: "choice", passages: ["P2"] },
          { topic: "C", objective: "Unsourced", kind: "choice", passages: [] },
        ],
      },
      passages,
      [workedKind, choiceKind],
      0,
      0,
      "Item title",
    );
    expect(blueprint).toEqual({ title: "Item title", targets: [{ topic: "A", objective: "Same idea", kind: "worked", passageIds: ["chunk-1"] }], requested: 0, omittedPassages: 0 });
  });

  it("tells the planner what an earlier quiz's result missed", () => {
    const prompt = buildPlanPrompt({
      title: "Fix",
      brief: "Go back over what was missed.",
      questions: 0,
      maxQuestions: 80,
      kinds: [choiceKind],
      difficulty: "auto",
      passages: buildPassages([chunked]),
      omittedPassages: 0,
      assumes: [],
      inputs: [{ kind: "fix_of", nodeId: "n0", type: "quiz", result: { score: 0.25, topicsMissed: ["Temperature", "Activation energy"] } }],
    });
    expect(prompt).toContain("scored 25%; topics missed, weakest first: Temperature, Activation energy");
    expect(prompt).not.toMatch(/\bdiagnostic\b|\bexams?\b/i);
  });
});

describe("quiz engine: a timed quiz in the real paper's format", () => {
  const layout = "Part A: short multiple choice, 1 mark each. Part B: one worked problem worth 4 marks.";

  it("keeps the time limit on the quiz and gives the format and the time to the plan and every write", async () => {
    const t = context({ settings: { timeLimit: 45, layout, feedback: "atEnd" } });
    const result = await runEngine(definition, t.ctx);
    expect(result.report.valid).toBe(true);
    expect(result.output.payload).toMatchObject({ feedback: "atEnd", timeLimit: 45 });
    for (const call of [...t.ofStep("plan"), ...t.ofStep("write")]) {
      expect(call.userPrompt).toContain(`Format to follow: the person says the real paper is laid out like this:\n${layout}`);
      expect(call.userPrompt).toContain("Time allowed: 45 minutes from Start");
    }
    // The format sets the count only when the settings leave it open.
    expect(t.ofStep("plan")[0]!.userPrompt).toContain("marks per question as each question's points, and its number of questions.");
  });

  it("leaves both out of the quiz and the prompts when they are not set", async () => {
    const t = context();
    const result = await runEngine(definition, t.ctx);
    expect(result.output.payload).not.toHaveProperty("timeLimit");
    for (const call of t.calls) expect(call.userPrompt).not.toMatch(/Format to follow|Time allowed/);
  });

  it("follows the count the settings fix over one the format gives", () => {
    const prompt = sittingNote({ questions: 12, layout: "Forty questions.", timeLimit: 0 })!;
    expect(prompt).toContain("its marks per question as each question's points.");
    expect(prompt).not.toContain("number of questions");
    expect(prompt).not.toContain("Time allowed");
  });

  it("refuses a quiz whose time limit is not a whole number of minutes in range, before any review", async () => {
    const t = context({ settings: { timeLimit: 30 } });
    const blueprint = await definition.engine.plan(t.ctx);
    const output = await definition.engine.generate(t.ctx, blueprint);
    output.payload = { ...output.payload, timeLimit: 0.5 };
    const report = await definition.engine.validate(t.ctx, output, blueprint);
    expect(report.issues.map((issue) => `${issue.path} ${issue.code}`)).toEqual(["$.timeLimit range"]);
    expect(t.ofStep("review")).toHaveLength(0);
  });
});

describe("quiz settings and descriptor", () => {
  it("fills defaults and reads every declared setting", () => {
    expect(parseQuizSettings(undefined)).toEqual({
      ok: true,
      settings: { questions: 0, kinds: ["choice", "worked", "order", "match", "complete", "graph", "label"], difficulty: "auto", passMark: 70, feedback: "afterEach", timeLimit: 0, layout: "" },
    });
    expect(parseQuizSettings({ questions: 12, kinds: ["worked"], difficulty: "harder", passMark: 80, feedback: "atEnd" })).toMatchObject({
      ok: true,
      settings: { questions: 12, kinds: ["worked"], difficulty: "harder", passMark: 80, feedback: "atEnd" },
    });
  });

  it("reads a time limit and the real paper's format, and refuses ones out of range", () => {
    expect(parseQuizSettings({ timeLimit: 50, layout: "  Part A: 20 multiple choice, 1 mark each. Part B: 2 worked problems, 10 marks each.  " })).toMatchObject({
      ok: true,
      settings: { timeLimit: 50, layout: "Part A: 20 multiple choice, 1 mark each. Part B: 2 worked problems, 10 marks each." },
    });
    const bad = parseQuizSettings({ timeLimit: 12.5, layout: "x".repeat(1_001) });
    expect(!bad.ok && bad.issues.map((issue) => issue.path)).toEqual(["$.timeLimit", "$.layout"]);
    expect(parseQuizSettings({ timeLimit: 301 }).ok).toBe(false);
    expect(parseQuizSettings({ timeLimit: -5 }).ok).toBe(false);
  });

  it("says a time limit and a format to follow in the item's own lines, and nothing when neither is set", () => {
    const set = parseQuizSettings({ questions: 30, timeLimit: 90, layout: "Two parts." });
    const plain = parseQuizSettings({ questions: 30 });
    if (!set.ok || !plain.ok) throw new Error("bad settings in test");
    expect(definition.describe!(set.settings)).toEqual(expect.arrayContaining(["90 minutes", "in the real paper's format"]));
    expect(definition.describe!(plain.settings).join(" ")).not.toMatch(/minutes|format/);
  });

  it("allows any kind its registry knows", () => {
    const kinds = createDefaultQuestionKinds().register({ ...choiceKind, id: "yesNo" });
    expect(parseQuizSettings({ kinds: ["yesNo"] }, kinds).ok).toBe(true);
    expect(parseQuizSettings({ kinds: ["yesNo"] }).ok).toBe(false);
  });

  it("refuses values outside what the descriptor declares", () => {
    const result = parseQuizSettings({ questions: 2.5, kinds: ["essay"], difficulty: "exam", passMark: 120, feedback: "never", mode: "x" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual(["$.mode", "$.questions", "$.kinds", "$.difficulty", "$.passMark", "$.feedback"]);
  });

  it("registers with defaults its own parser accepts, and estimates from the settings", () => {
    const registry = new FormatRegistry().register(definition);
    expect(registry.ready()).toEqual(["quiz"]);
    const settings = parseQuizSettings({ questions: 10 });
    const estimate = estimateQuizCost({ settings: settings.ok ? settings.settings : (undefined as never), sourceChars: 12_000, sourceCount: 1 }, { inputPerMillion: 1, outputPerMillion: 4 });
    expect(estimate.usd).toBeGreaterThan(0);
    expect(estimate.basis).toMatch(/^10 questions, ~8 calls/);
    // Sanity check against the first real run (deepseek-v4-flash, 24,000
    // characters): an 8-question quiz cost $0.031. Near, not to the cent.
    const eight = estimateQuizCost({ settings: { ...(settings.ok ? settings.settings : (undefined as never)), questions: 8 }, sourceChars: 24_000, sourceCount: 1 }, { inputPerMillion: 0.3, outputPerMillion: 1.2 }).usd!;
    expect(eight).toBeGreaterThan(0.015);
    expect(eight).toBeLessThan(0.06);
    const unpriced = estimateQuizCost({ settings: { ...(settings.ok ? settings.settings : (undefined as never)), questions: 0 }, sourceChars: 12_000, sourceCount: 1 }, undefined);
    expect(unpriced.basis).toMatch(/length from the brief.*no model price set/);
    expect(unpriced).toMatchObject({ unpriced: true });
    expect(unpriced.usd).toBeUndefined();
  });
});

describe("quiz engine: where the right option sits", () => {
  const twelve = {
    title: "Enzymes quiz",
    targets: Array.from({ length: 12 }, (_, at) => ({ topic: `Idea ${at + 1}`, objective: `Objective number ${at + 1}`, kind: "choice", passages: ["P1"] })),
  };
  const written = (request: { userPrompt: string }) => ({
    questions: [...request.userPrompt.matchAll(/^- (t\d+) \[/gm)].map(([, ref]) => ({
      ...goodQuestions.t1,
      target: ref,
      prompt: `Question ${ref}: what did the enzyme change?`,
      options: ["Lowered the activation energy", "Was used up as fuel", "Raised the temperature", "Made more product"],
      optionFeedback: ["right: it lowers it", "wrong: not used up", "wrong: no heat", "wrong: same product"],
      answer: 0,
    })),
  });

  it("shuffles each question's options, moving the answer and per-option feedback with them", async () => {
    const t = context({ settings: { kinds: ["choice"] }, handlers: { plan: () => twelve, write: written } });
    const { output } = await runEngine(definition, t.ctx);
    const questions = output.payload.questions;
    const positions = questions.map((question) => question.answer as number);
    expect(new Set(positions).size).toBeGreaterThan(1);
    for (const question of questions) {
      const options = question.options as string[];
      expect(options[question.answer as number]).toBe("Lowered the activation energy");
      expect((question.optionFeedback as string[])[question.answer as number]).toBe("right: it lowers it");
      expect(options.map((option, at) => [option, (question.optionFeedback as string[])[at]]).sort()).toEqual([
        ["Lowered the activation energy", "right: it lowers it"],
        ["Made more product", "wrong: same product"],
        ["Raised the temperature", "wrong: no heat"],
        ["Was used up as fuel", "wrong: not used up"],
      ]);
    }
  });

  it("gives the same order every time for the same job and question", async () => {
    const first = await runEngine(definition, context({ settings: { kinds: ["choice"] }, handlers: { plan: () => twelve, write: written } }).ctx);
    const second = await runEngine(definition, context({ settings: { kinds: ["choice"] }, handlers: { plan: () => twelve, write: written } }).ctx);
    expect(second.output.payload.questions.map((question) => question.options)).toEqual(first.output.payload.questions.map((question) => question.options));
  });

  it("shuffles a worked question's choice steps too", () => {
    const question = { ...workedKind.normalize(goodQuestions.t2), prompt: "x" } as never;
    const answers = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const arranged = workedKind.arrange!(question, seededRandom(`s${seed}`)) as { steps: Array<{ options?: string[]; answer?: number }> };
      const step = arranged.steps[0];
      expect(step.options![step.answer!]).toBe("denatures");
      answers.add(String(step.answer));
    }
    expect(answers).toEqual(new Set(["0", "1"]));
  });

  it("flags a right option that gives itself away by length, and leaves alike options alone", () => {
    const base = { id: "q1", kind: "choice", topic: "t", prompt: "p", points: 1, feedback: { correct: "c", incorrect: "i" }, cites: [] };
    const long = { ...base, options: ["It lowers the activation energy the reaction must reach, so more collisions succeed", "It is used up", "It heats the mix"], answer: 0 };
    expect(choiceKind.check(long).map((issue) => issue.code)).toEqual(["answer_stands_out"]);
    const alike = { ...base, options: ["It lowers the activation energy", "It is used up as a fuel source", "It raises the temperature a bit"], answer: 0 };
    expect(choiceKind.check(alike)).toEqual([]);
  });
});

describe("quiz engine: prompt labels never reach the person", () => {
  it("flags a label or 'the passages' in any text a person reads, and repair clears it", async () => {
    const leaky = { ...goodQuestions.t1, prompt: "Using the passages, what did the enzyme change?", feedback: { correct: "P1 says it lowers activation energy.", incorrect: "Look again at P1." } };
    const t = context({ settings: { kinds: ["choice"] }, handlers: {
      plan: () => ({ title: "Enzymes quiz", targets: [planAnswer.targets[0]] }),
      write: () => ({ questions: [leaky] }),
    } });
    const result = await runEngine(definition, t.ctx);
    const [repair] = t.ofStep("repair");
    expect(repair.userPrompt).toContain("names_prompt_label");
    expect(repair.userPrompt).toContain("questions[0].prompt");
    expect(repair.userPrompt).toContain("questions[0].feedback.correct");
    expect(result.report.valid).toBe(true);
    expect(JSON.stringify(result.output.payload.questions[0])).not.toMatch(/P1 says/);
  });

  it("takes a label word used as ordinary vocabulary: no repair, nothing flagged", async () => {
    const ordinary = { ...goodQuestions.t1, prompt: "Like final passage of a bill, which step must the reaction get through first?", feedback: { correct: "The enzyme is the source of the lower barrier, like a passage through the mountains.", incorrect: "A quote from Lincoln will not help; think of the barrier." } };
    const t = context({ settings: { kinds: ["choice"] }, handlers: {
      plan: () => ({ title: "Enzymes quiz", targets: [planAnswer.targets[0]] }),
      write: () => ({ questions: [ordinary] }),
    } });
    const result = await runEngine(definition, t.ctx);
    expect(t.ofStep("repair")).toEqual([]);
    expect(result.report.issues.filter((issue) => issue.code === "names_prompt_label")).toEqual([]);
  });

  it("tells every writer that labels are for citing only", () => {
    expect(t0().systemPrompt).toContain("never point at a passage or write a label");
  });
});

function t0() {
  return { systemPrompt: systemPrompt("write") };
}

describe("quiz engine: a retry continues from finished work", () => {
  it("keeps each written question, so a retry writes only the ones not done", async () => {
    const entries = new Map<string, JsonValue>();
    const checkpoint: EngineCheckpoint = { get: (key) => entries.get(key), put: async (key, value) => void entries.set(key, structuredClone(value)) };
    const seven = {
      title: "Enzymes quiz",
      targets: Array.from({ length: 7 }, (_, at) => ({ topic: `Idea ${at + 1}`, objective: `Objective number ${at + 1}`, kind: "choice", passages: ["P1"] })),
    };
    const write = (request: { userPrompt: string }) => ({
      questions: [...request.userPrompt.matchAll(/^- (t\d+) \[/gm)].map(([, ref]) => ({ ...goodQuestions.t1, target: ref, prompt: `Question ${ref}: what did the enzyme change?` })),
    });
    const controller = new AbortController();
    const first = context({ settings: { kinds: ["choice"] }, handlers: {
      plan: () => seven,
      write: (request) => {
        if (request.userPrompt.includes("- t6 [")) {
          controller.abort(new Error("attempt lost"));
          throw new Error("provider timed out");
        }
        return write(request);
      },
    } });
    first.ctx.services.checkpoint = checkpoint;
    first.ctx.services.signal = controller.signal;
    const blueprint = await definition.engine.plan(first.ctx);
    await expect(runEngine(definition, first.ctx, { blueprint })).rejects.toThrow();
    expect([...entries.keys()].sort()).toEqual(["question:0", "question:1", "question:2", "question:3", "question:4"]);

    const second = context({ settings: { kinds: ["choice"] }, handlers: { write } });
    second.ctx.services.checkpoint = checkpoint;
    const result = await runEngine(definition, second.ctx, { blueprint });
    const writes = second.ofStep("write");
    expect(writes).toHaveLength(1);
    expect(writes[0].userPrompt).toContain("- t6 [");
    expect(writes[0].userPrompt).not.toContain("- t1 [");
    expect(result.output.payload.questions).toHaveLength(7);
    expect(result.report.valid).toBe(true);
  });
});

describe("quiz engine: a source that was cut", () => {
  it("tells the planner and the writers how much of the source the passages are", async () => {
    const cut: NodeSource = { ...chunked, envelope: { ...chunked.envelope, metadata: { textCut: "true", textChars: "50000", textUsedChars: "24000" } } };
    const t = context({ sources: [cut] });
    await runEngine(definition, t.ctx);
    const note = '"Enzymes" was cut: its passages are only the first 24,000 of 50,000 characters.';
    expect(t.ofStep("plan")[0].userPrompt).toContain(note);
    expect(t.ofStep("write")[0].userPrompt).toContain(note);
  });
});

describe("quiz engine: a source with no text read", () => {
  it("refuses, saying only the title and details could be read, instead of asking about a title", async () => {
    const titleOnly: NodeSource = {
      sourceId: "yt",
      envelope: { ...envelope("A video title | Channel"), accessLevel: "metadata", limitations: ["Gemini YouTube extraction was unavailable; used public metadata fallback"] },
      chunks: [],
    };
    const t = context({ sources: [titleOnly] });
    await expect(definition.engine.plan(t.ctx)).rejects.toMatchObject({ code: "NO_SOURCE_TEXT", message: expect.stringContaining("Only the title and details") });
    expect(t.calls).toHaveLength(0);
  });
});
