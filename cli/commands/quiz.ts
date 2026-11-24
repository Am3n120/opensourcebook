/** Taking a made quiz from the command: its questions, then the answers graded and recorded as the app's player does. */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, type Engine } from "./connect.ts";
import { madeOf, type Output } from "./items.ts";
import { PROJECT_FLAG, Problem, flagOn, type Ctx, type Group } from "./table.ts";

interface Question {
  id: string;
  kind: string;
  topic: string;
  prompt: string;
  options?: string[];
  steps?: Array<{ prompt: string; input: "entries" | "choice"; options?: string[]; values?: string[] }>;
  items?: string[];
  shown?: number[];
  pairs?: Array<{ left: string; right: string }>;
  rights?: number[];
  picture?: { caption?: string };
  marks?: Array<{ mark: string }>;
  names?: string[];
  axes?: { x: { min: number; max: number; step: number; label?: string }; y: { min: number; max: number; step: number; label?: string } };
  lines?: string[];
  feedback: { correct: string; incorrect: string };
}

interface Grader {
  asQuiz(payload: Record<string, unknown>): { title: string; passMark: number; questions: Question[]; timeLimit?: number };
  gradeQuiz(quiz: unknown, responses: Record<string, unknown>): Record<string, unknown> & { score: number; correct: number; count: number; passed: boolean; questions: Array<{ id: string; outcome: string }>; topicsMissed: string[] };
}

/**
 * The web player's own grader (web/src/player/quizGrade.ts, which grades the way the engine does), so a quiz taken
 * here records the same result as one taken in the app.
 */
async function grader(ctx: Ctx): Promise<Grader> {
  return (await import(pathToFileURL(join(ctx.root, "web", "src", "player", "quizGrade.ts")).href)) as Grader;
}

const LETTERS = "ABCDEFGHIJKL";
const lettered = (texts: string[]) => texts.map((text, i) => ({ letter: LETTERS[i]!, text }));
const inOrder = (order: number[] | undefined, n: number) => (order?.length === n ? order : Array.from({ length: n }, (_, i) => i));
/** A line of working with each gap a numbered blank: "v = ___(1) km/h". */
function blanked(lines: string[]): string[] {
  let gap = 0;
  return lines.map((line) => line.replace(/\[\[[^[\]]*\]\]/g, () => `___(${++gap})`));
}

async function quizOf(ctx: Ctx, engine: Engine) {
  const made = await madeOf(ctx, engine, ctx.args.item!);
  if (made.output.type !== "quiz") throw new Problem("not_a_quiz", `"${made.item.title}" is a ${made.output.type}, not a quiz; "opensourcebook item get ${made.item.id}" gives it.`);
  const g = await grader(ctx);
  return { ...made, g, quiz: g.asQuiz(made.output.payload) };
}

/** Questions as a person sees them before answering: no answers, no feedback. */
function asked(questions: Question[]) {
  return questions.map((q, n) => ({
    n: n + 1,
    id: q.id,
    kind: q.kind,
    topic: q.topic,
    prompt: q.prompt,
    ...(q.options ? { options: q.options.map((o, i) => ({ letter: LETTERS[i], text: o })) } : {}),
    ...(q.steps ? { steps: q.steps.map((s, i) => ({ step: i + 1, prompt: s.prompt, input: s.input, ...(s.options ? { options: s.options.map((o, j) => ({ letter: LETTERS[j], text: o })) } : {}), ...(s.values ? { entries: s.values.length } : {}) })) } : {}),
    ...(q.items ? { toOrder: inOrder(q.shown, q.items.length).map((k, i) => ({ number: i + 1, text: q.items![k]! })) } : {}),
    ...(q.pairs ? { left: q.pairs.map((p) => p.left), rights: lettered(inOrder(q.rights, q.pairs.length).map((k) => q.pairs![k]!.right)) } : {}),
    ...(q.marks ? { ...(q.picture?.caption ? { picture: q.picture.caption } : {}), marks: q.marks.map((m) => m.mark), names: lettered(q.names ?? []) } : {}),
    ...(q.axes ? { axes: q.axes } : {}),
    ...(q.lines ? { working: blanked(q.lines) } : {}),
  }));
}

/**
 * Answers as words: `1=B 2=A` (question number or id, then a letter or option number), and for a worked question
 * one per step, `3.1=12 3.2=B` (entries of a step separated by commas when it has more than one box). Put in
 * order: the shown numbers in order, `4=3,1,2`; match pairs and label a picture: a letter for each in turn,
 * `5=B,A,C`; a line on a graph: two points, `6=1:15,3:25`; fill in the working: one per gap, `7.1=4 7.2=30`.
 */
export function parseAnswers(words: string[], questions: Question[]): Record<string, unknown> {
  const responses: Record<string, Record<string, unknown>> = {};
  for (const word of words.flatMap((w) => w.split(/[\s;]+/)).filter(Boolean)) {
    const m = /^([^=.]+)(?:\.(\d+))?=(.+)$/.exec(word);
    if (!m) throw new Problem("bad_arguments", `"${word}" is not an answer; write question=answer, like 1=B (or 3.1=12 for step 1 of a worked question).`);
    const [, key, stepRaw, value] = m as unknown as [string, string, string | undefined, string];
    const q = questions.find((x) => x.id === key) ?? questions[Number(key) - 1];
    if (!q) throw new Problem("bad_arguments", `The quiz has no question ${key}; it has ${questions.length}.`);
    const pick = (options: string[] | undefined): number => {
      const letter = LETTERS.indexOf(value.toUpperCase());
      const n = value.length === 1 && letter >= 0 ? letter : Number(value) - 1;
      if (!Number.isInteger(n) || n < 0 || n >= (options?.length ?? 0)) throw new Problem("bad_arguments", `"${value}" is not an option of question ${key}; pick ${LETTERS.slice(0, options?.length ?? 0).split("").join(", ")}.`);
      return n;
    };
    if (stepRaw === undefined) {
      const several = (n: number, read: (part: string) => number) => {
        const parts = value.split(",").map((part) => part.trim());
        if (parts.length !== n) throw new Problem("bad_arguments", `Question ${key} takes ${n} answers separated by commas; "${value}" has ${parts.length}.`);
        return parts.map(read);
      };
      const letterOf = (texts: unknown[]) => (part: string) => {
        const i = LETTERS.indexOf(part.toUpperCase());
        if (part.length !== 1 || i < 0 || i >= texts.length) throw new Problem("bad_arguments", `"${part}" is not one of question ${key}'s letters; pick ${LETTERS.slice(0, texts.length).split("").join(", ")}.`);
        return i;
      };
      if (q.options) responses[q.id] = { choice: pick(q.options) };
      else if (q.items) {
        const shown = inOrder(q.shown, q.items.length);
        const order = several(q.items.length, (part) => {
          const n = Number(part);
          if (!Number.isInteger(n) || n < 1 || n > shown.length) throw new Problem("bad_arguments", `"${part}" is not one of question ${key}'s numbers, 1 to ${shown.length}.`);
          return shown[n - 1]!;
        });
        responses[q.id] = { order };
      } else if (q.pairs) {
        const rights = inOrder(q.rights, q.pairs.length);
        responses[q.id] = { matches: several(q.pairs.length, letterOf(rights)).map((i) => rights[i]!) };
      } else if (q.marks) responses[q.id] = { labels: several(q.marks.length, letterOf(q.names ?? [])) };
      else if (q.axes) {
        const points = value.split(",").map((part) => part.split(":").map((n) => Number(n.trim())));
        if (points.length !== 2 || !points.every((p) => p.length === 2 && p.every(Number.isFinite))) throw new Problem("bad_arguments", `Question ${key} takes two points, like ${key}=1:15,3:25.`);
        responses[q.id] = { points: points as Array<[number, number]> };
      } else if (q.lines) throw new Problem("bad_arguments", `Question ${key} has gaps to fill in; answer each gap, like ${key}.1=...`);
      else if (q.steps) throw new Problem("bad_arguments", `Question ${key} is worked step by step; answer each step, like ${key}.1=...`);
      else throw new Problem("bad_arguments", `Question ${key} is a kind of question (${q.kind}) this command cannot answer.`);
      continue;
    }
    if (q.lines) {
      const count = blanked(q.lines).join("\n").match(/___\(\d+\)/g)?.length ?? 0;
      const n = Number(stepRaw);
      if (!Number.isInteger(n) || n < 1 || n > count) throw new Problem("bad_arguments", `Question ${key} has no gap ${stepRaw}; it has ${count}.`);
      const gaps = [...((responses[q.id] as { gaps?: string[] } | undefined)?.gaps ?? Array.from({ length: count }, () => ""))];
      gaps[n - 1] = value.trim();
      responses[q.id] = { gaps };
      continue;
    }
    const step = q.steps?.[Number(stepRaw) - 1];
    if (!step) throw new Problem("bad_arguments", `Question ${key} has no step ${stepRaw}.`);
    const prior = (responses[q.id] as { steps?: Array<{ value: number | string[] }> } | undefined)?.steps ?? [];
    const steps = [...prior];
    // A step with one box takes the whole answer, so a decimal comma ("52,5") stays one number.
    steps[Number(stepRaw) - 1] = { value: step.input === "choice" ? pick(step.options) : (step.values?.length ?? 1) > 1 ? value.split(",").map((s) => s.trim()) : [value.trim()] };
    responses[q.id] = { steps };
  }
  return responses;
}

export const quiz: Group = {
  thing: "quiz",
  about: "take a made quiz here: its questions, then your answers graded and recorded",
  commands: [
    {
      thing: "quiz",
      action: "show",
      summary: "a made quiz's questions, without the answers, to put to the person",
      args: [{ name: "item", help: "the quiz item's id" }],
      flags: [PROJECT_FLAG],
      shape: "{ item: Item, title, passMark, timeLimit?, questions: [{ n, id, kind, topic, prompt, options?: [{ letter, text }], steps?, toOrder?, left?, rights?, marks?, names?, axes?, working? }] }",
      async run(ctx) {
        const { item, quiz: q } = await quizOf(ctx, connect(ctx));
        const list = asked(q.questions);
        const text = [
          `${q.title} (${list.length} questions${q.timeLimit ? `, ${q.timeLimit} minutes in the app` : ""})`,
          ...list.map((x) =>
            [
              `${x.n}. ${x.prompt}`,
              ...(x.options ?? []).map((o) => `   ${o.letter}) ${o.text}`),
              ...(x.steps ?? []).map((s) => `   step ${s.step}: ${s.prompt}${s.options ? ` ${s.options.map((o) => `${o.letter}) ${o.text}`).join("  ")}` : ""}`),
              ...(x.toOrder ?? []).map((o) => `   ${o.number}. ${o.text}`),
              ...(x.left ? [`   Match: ${x.left.map((l, i) => `${i + 1}) ${l}`).join("  ")}`, `   With: ${x.rights!.map((r) => `${r.letter}) ${r.text}`).join("  ")}`] : []),
              ...(x.marks ? [`   ${x.picture ? `Picture: ${x.picture}. ` : ""}Marks: ${x.marks.join(", ")}`, `   Names: ${x.names!.map((r) => `${r.letter}) ${r.text}`).join("  ")}`] : []),
              ...(x.axes ? [`   Grid: ${x.axes.x.label ?? "x"} ${x.axes.x.min} to ${x.axes.x.max} by ${x.axes.x.step}; ${x.axes.y.label ?? "y"} ${x.axes.y.min} to ${x.axes.y.max} by ${x.axes.y.step}. Give two points on the line.`] : []),
              ...(x.working ?? []).map((l) => `   ${l}`),
            ].join("\n"),
          ),
        ];
        text.push(`Answer with "opensourcebook quiz answer ${item.id} 1=B 2=A ...".`);
        return { data: { item, title: q.title, passMark: q.passMark, ...(q.timeLimit ? { timeLimit: q.timeLimit } : {}), questions: list }, text: text.join("\n\n") };
      },
    },
    {
      thing: "quiz",
      action: "answer",
      summary: "grade answers to a made quiz and record the result on its item, as the app's player does",
      args: [{ name: "item", help: "the quiz item's id" }, { name: "answers", help: "like 1=B 2=A; 3.1=12 for step 1 of a worked question or gap 1 of working to fill in; 4=3,1,2 to put in order; 5=B,A for pairs or a picture's marks; 6=1:15,3:25 for a line", many: true }],
      flags: [PROJECT_FLAG, { name: "keep", help: "grade only; do not record the result or tick the item" }],
      shape: "{ result: { score: 0..1, correct, count, passed, questions: [{ id, outcome }], topicsMissed }, feedback: [{ n, outcome, feedback }], recorded: boolean }",
      more: "The result goes on the item with its done tick, so a later item in the plan that depends on the score can read it.",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item, output, g, quiz: q } = await quizOf(ctx, engine);
        const result = g.gradeQuiz(q, parseAnswers(ctx.lists.answers ?? [], q.questions));
        const feedback = result.questions.map((r, i) => ({ n: i + 1, outcome: r.outcome, feedback: r.outcome === "right" ? q.questions[i]!.feedback.correct : r.outcome === "skipped" ? "" : q.questions[i]!.feedback.incorrect }));
        const keep = flagOn(ctx, "keep");
        if (!keep) await record(engine, view.plan.id, item.id, output, result);
        const pct = Math.round(result.score * 100);
        const text = [
          `${pct}%: ${result.correct} of ${result.count} right${result.passed ? ", passed" : ""}.`,
          ...feedback.map((f) => `${f.n}. ${f.outcome}${f.feedback ? `: ${f.feedback}` : ""}`),
          ...(result.topicsMissed.length ? [`To go over: ${result.topicsMissed.join(", ")}`] : []),
          keep ? "(not recorded)" : "Recorded on the item.",
        ];
        return { data: { result, feedback, recorded: !keep }, text: text.join("\n") };
      },
    },
  ],
};

async function record(engine: Engine, planId: string, itemId: string, output: Output, result: unknown): Promise<void> {
  await engine.call("POST", `/v1/plans/${encodeURIComponent(planId)}/items/${encodeURIComponent(itemId)}/done`, { json: { done: true, outputId: output.id, result } });
}
