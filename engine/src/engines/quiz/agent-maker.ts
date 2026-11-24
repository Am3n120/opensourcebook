/**
 * A quiz made by the person's own agent (docs/DECISIONS.md #53, #54, #64):
 * one turn of their agent through the connector on their computer, with
 * Open Sourcebook's tools for this item (chat/agent/work.ts). It reads the sources and
 * writes questions one at a time, of the kinds the item allows (kinds.ts),
 * each tied to the passages that settle it. Every check the quiz has in
 * code is the writing tool's answer: an unknown or disallowed kind, a field
 * of the kind that is wrong, a quote that is not word for word in its
 * passage, a question that repeats another, words only the writer saw. What
 * makes a good question is a skill it reads (skills/notebook). Open Sourcebook pays
 * nothing: the person's subscription does.
 *
 *   plan      no call: the passages and the kinds are checked.
 *   generate  one turn of the agent; each question it writes is kept on the
 *             job, so a retry carries on from what was written and checked.
 *   validate  the same checks in code over the whole quiz.
 *   repair    once: what failed goes back to the agent, which fixes it.
 */
import { workPickFor } from "../agent-fields";
import { agentProblemHeard, nextTurnNumber, recordWorkUsage, workFailure, workTurnId, type AgentWork, type WorkTool } from "../../chat/agent/work";
import { outlineOf, sourceTools, type SourceWork } from "../../chat/agent/work-tools";
import { packsNote } from "../../chat/agent/work-skills";
import type { JsonSchema } from "../../chat/agent/tools";
import { JobFailure } from "../../jobs/lifecycle";
import { buildPassages, cutNotes, type Passage } from "../../sources/passages";
import type { Citation, EngineContext, EngineOutput, JsonValue, NodeSource, OutputEngine, ValidationIssue, ValidationReport } from "../../studio/types";
import type { ItemMaker } from "../makers";
import { PipelineError } from "../retry";
import type { QuizSettings } from "./definition";
import { QuizEngine, summarize, type QuizBlueprint } from "./engine";
import { createDefaultQuestionKinds } from "./default-kinds";
import type { QuestionKind, QuestionKindRegistry } from "./kinds";
import { picturesNote, sourcePictures, type SourcePicture } from "./pictures";
import { earlierResults, sittingNote } from "./prompts";
import { MAX_QUESTIONS, QUESTION_LIMITS, QUIZ_SCHEMA_VERSION, type QuizPayload, type QuizQuestion } from "./schema";

export const AGENT_QUIZ_MAKER_ID = "agent";

export interface AgentQuizBlueprint {
  /** The kinds the quiz may use, as the item's settings allowed them when it was planned. */
  kinds: string[];
}

export interface AgentQuizMakerOptions {
  work: AgentWork;
  kinds?: QuestionKindRegistry;
}

/** What the agent has written so far, kept on the job after every change. */
export interface QuizDraft {
  title?: string;
  /** How many questions it means to write, when it said. */
  planned?: number;
  questions: QuizQuestion[];
  /** Why the quiz has a different number of questions from the one planned, in the agent's words for the person. */
  note?: string;
  finished: boolean;
}

export interface QuizWork extends SourceWork {
  byId: Map<string, Passage>;
  kinds: QuestionKindRegistry;
  allowed: QuestionKind[];
  /** The sources' pictures, for the kinds that ask about one. */
  pictures: SourcePicture[];
  settings: QuizSettings;
  engine: QuizEngine;
  seed: string;
  draft: QuizDraft;
  save(): Promise<void>;
  progress(): number;
}

const DRAFT_KEY = "agent:quiz";
const TURNS_KEY = "agent:turns";

export function createAgentQuizMaker(options: AgentQuizMakerOptions): ItemMaker<QuizSettings, AgentQuizBlueprint, QuizPayload> {
  const problem = () => agentProblemHeard(options.work.heard());
  return {
    id: AGENT_QUIZ_MAKER_ID,
    label: "Your agent",
    usesAgent: true,
    description:
      "Your own agent writes the quiz on this computer: it reads the sources and writes each question with its feedback, tied to the passages that settle it, and Open Sourcebook checks every quote and every question's fields. No model cost to Open Sourcebook. Needs the connector running on this computer.",
    engine: new AgentQuizEngine(options),
    maxRepairRounds: 1,
    estimateCost: (input) =>
      input.sourceCount === 0 || input.sourceChars === 0 ? { usd: 0, basis: "no source text to ask about" } : { usd: 0, basis: "written by your own agent on this computer: no model cost to Open Sourcebook" },
    ready: () => (options.work.heard() ? problem() === undefined : undefined),
    issues: () => {
      const why = problem();
      return why ? [`your agent makes it, and ${why}: start it, or pick another maker`] : [];
    },
    status: async () => {
      const status = await options.work.status();
      const why = agentProblemHeard(status);
      const agent = status.agent ? { id: status.agent.id, label: status.agent.label, ...(status.model ? { model: status.model } : {}) } : undefined;
      return why ? { available: false, problem: `Your agent makes it, and ${why}.`, ...(agent ? { agent } : {}) } : { available: true, ...(agent ? { agent } : {}) };
    },
  };
}

class AgentQuizEngine implements OutputEngine<QuizSettings, AgentQuizBlueprint, QuizPayload> {
  readonly type = "quiz";
  readonly schemaVersion = QUIZ_SCHEMA_VERSION;
  private readonly kinds: QuestionKindRegistry;
  private readonly checks: QuizEngine;

  constructor(private readonly options: AgentQuizMakerOptions) {
    this.kinds = options.kinds ?? createDefaultQuestionKinds();
    this.checks = new QuizEngine({ kinds: this.kinds });
  }

  async plan(ctx: EngineContext<QuizSettings>): Promise<AgentQuizBlueprint> {
    requirePassages(ctx);
    const allowed = this.checks.allowedKinds(ctx.node.settings, ctx.sources);
    await ctx.services.progress({ stage: "planning", progress: 0.02, step: "Getting the sources ready for your agent" });
    return { kinds: allowed.map((kind) => kind.id) };
  }

  async generate(ctx: EngineContext<QuizSettings>): Promise<EngineOutput<QuizPayload>> {
    const work = this.workFor(ctx);
    if (!work.draft.finished) await this.turn(ctx, work, writePrompt(ctx, work));
    return this.output(ctx, work);
  }

  async validate(ctx: EngineContext<QuizSettings>, output: EngineOutput<QuizPayload>): Promise<ValidationReport> {
    const work = this.workFor(ctx);
    return report(checkQuiz(work, output.payload.questions, output.payload.title));
  }

  async repair(ctx: EngineContext<QuizSettings>, output: EngineOutput<QuizPayload>, validation: ValidationReport): Promise<EngineOutput<QuizPayload>> {
    const work = this.workFor(ctx);
    const problems = validation.issues.filter((issue) => issue.severity === "error").map(problemLine);
    work.draft.finished = false;
    await work.save();
    await this.turn(ctx, work, [...itemParts(ctx, work), `You wrote this quiz (read_quiz shows it), and Open Sourcebook's last check of the whole quiz found:\n${problems.map((line) => `- ${line}`).join("\n")}\nFix those questions, then call finish_quiz again.`].join("\n\n"));
    return this.output(ctx, work);
  }

  private workFor(ctx: EngineContext<QuizSettings>): QuizWork {
    const passages = requirePassages(ctx);
    const work: QuizWork = {
      passages,
      packs: ctx.project?.packs ?? [],
      byId: new Map(passages.map((passage) => [passage.id, passage])),
      kinds: this.kinds,
      allowed: this.checks.allowedKinds(ctx.node.settings, ctx.sources),
      pictures: sourcePictures(ctx.sources),
      settings: ctx.node.settings,
      engine: this.checks,
      seed: ctx.jobId,
      draft: readDraft(ctx.services.checkpoint?.get(DRAFT_KEY)),
      save: async () => {
        await ctx.services.checkpoint?.put(DRAFT_KEY, work.draft as unknown as JsonValue);
      },
      progress: () => {
        const planned = plannedQuestions(work);
        const share = planned ? Math.min(1, work.draft.questions.length / planned) : Math.min(0.9, work.draft.questions.length / 10);
        return 0.08 + 0.8 * share;
      },
    };
    return work;
  }

  private async turn(ctx: EngineContext<QuizSettings>, work: QuizWork, prompt: string): Promise<void> {
    const number = nextTurnNumber(ctx.services.checkpoint?.get(TURNS_KEY));
    await ctx.services.checkpoint?.put(TURNS_KEY, number);
    await ctx.services.progress({ stage: "writing", progress: work.progress(), step: work.draft.questions.length ? "Asking your agent to carry on" : "Asking your agent to start" });
    const end = await this.options.work.run({
      turnId: workTurnId(ctx.jobId, number),
      ...(number > 1 ? { replaces: workTurnId(ctx.jobId, number - 1) } : {}),
      target: { type: ctx.node.type, id: ctx.node.id },
      pick: await workPickFor(ctx),
      systemPrompt: SYSTEM_PROMPT,
      prompt,
      instructions: "Open Sourcebook's tools for writing one quiz from this item's sources. Finish with finish_quiz.",
      tools: quizTools(work),
      work,
      ...(ctx.services.signal ? { signal: ctx.services.signal } : {}),
      step: (label) => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress(), step: label })),
      heartbeat: () => Promise.resolve(ctx.services.progress({ stage: "writing", progress: work.progress() })),
    });
    await recordWorkUsage(ctx.services.usage, ctx.jobId, end, this.options.work.agent);
    if (work.draft.finished) return;
    if (end.outcome === "failed") throw workFailure(end, "quiz");
    // The agent ended without saying it was finished: what it wrote stands if it passes as a whole.
    const errors = checkQuiz(work, work.draft.questions, work.draft.title ?? ctx.node.title).filter((issue) => issue.severity === "error");
    if (work.draft.questions.length === 0 || errors.length > 0) throw new JobFailure("The agent ended its turn without finishing the quiz.", false, "agent_dropped");
  }

  private async output(ctx: EngineContext<QuizSettings>, work: QuizWork): Promise<EngineOutput<QuizPayload>> {
    await ctx.services.progress({ stage: "verifying", progress: 0.9, step: "Checking the quiz" });
    const title = (work.draft.title ?? ctx.node.title.trim()) || "Quiz";
    const questions = work.draft.questions;
    const payload: QuizPayload = { title, passMark: ctx.node.settings.passMark / 100, feedback: ctx.node.settings.feedback, questions, ...(ctx.node.settings.timeLimit ? { timeLimit: ctx.node.settings.timeLimit } : {}), ...(work.draft.note ? { sizeNote: work.draft.note } : {}) };
    const citations: Citation[] = questions.flatMap((question, position) =>
      question.cites.map((cite) => ({
        sourceId: cite.sourceId,
        ...(cite.chunkId ? { chunkId: cite.chunkId } : {}),
        ...(cite.locator ? { locator: cite.locator } : {}),
        ...(cite.quote ? { quote: cite.quote } : {}),
        anchor: `questions[${position}]`,
      })),
    );
    return { title, summary: summarize(questions), payload, citations };
  }
}

const SYSTEM_PROMPT = `You are making one quiz in Open Sourcebook, the notebook that turns a person's own sources into things to learn from, for a person who studies from their own sources. A quiz is a set of questions with feedback that checks what the person understood, and teaches through its feedback; its score can steer what their plan does next.

You work only through Open Sourcebook's tools: read the sources with outline_sources, read_passages and search_passages; write the quiz with plan_quiz, write_question, change_question, remove_question and read_quiz; and say it is done with finish_quiz. You cannot see files, run commands or browse the web here.

Open Sourcebook's notebook skill holds what makes a quiz good; read it (read_skill) before you plan, and its references when you want more. Each question you write is checked as you send it, and the tool's answer says exactly what to fix when something is wrong. When the whole quiz is written and you have read it back as the person will take it, call finish_quiz, then end your turn.`;

function writePrompt(ctx: EngineContext<QuizSettings>, work: QuizWork): string {
  const parts = itemParts(ctx, work);
  if (work.draft.questions.length > 0) {
    parts.push(`You already wrote ${work.draft.questions.length} question${work.draft.questions.length === 1 ? "" : "s"} of this quiz in an earlier turn, each checked and kept. Read them back with read_quiz and carry on from there; change or remove any that should be better.`);
  }
  parts.push("Make the quiz.");
  return parts.join("\n\n");
}

function itemParts(ctx: EngineContext<QuizSettings>, work: QuizWork): string[] {
  const settings = ctx.node.settings;
  const parts: string[] = [];
  if (ctx.project?.title) parts.push(`Project: ${ctx.project.title}`);
  const packs = packsNote(ctx.project?.packs ?? []);
  if (packs) parts.push(packs);
  parts.push(`Item: ${ctx.node.title.trim() || "a quiz"}`);
  parts.push(ctx.node.prompt.trim() ? `Brief (what this quiz is for and what it covers; it is not a source, so nothing in it is a fact until a passage says it):\n${ctx.node.prompt.trim()}` : "Brief: none. Test the main ideas of the sources, evenly.");
  parts.push(settings.questions > 0 ? `Length: ${settings.questions} questions.` : `Length: decide from the brief and from how much the sources hold, up to ${MAX_QUESTIONS}: one question per distinct idea worth testing.`);
  parts.push(`Question kinds this quiz may use: ${work.allowed.map((kind) => `${kind.id} (${kind.label}: ${kind.description})`).join("; ")}.`);
  parts.push(`Difficulty: ${DIFFICULTY_WORDS[settings.difficulty]}`);
  const sitting = sittingNote(settings);
  if (sitting) parts.push(sitting);
  const earlier = earlierResults(ctx.inputs);
  if (earlier) parts.push(earlier);
  if (ctx.assumes.length > 0) {
    parts.push(`The person has already been through these items of the plan (for context; questions still come only from the sources):\n${ctx.assumes.map((prior) => `- ${prior.type} "${prior.title}": ${prior.summary}`).join("\n")}`);
  }
  const cut = cutNotes(ctx.sources);
  if (cut.length > 0) parts.push(cut.join("\n"));
  const pictures = work.allowed.some((kind) => kind.usesPicture) ? picturesNote(work.pictures) : undefined;
  if (pictures) parts.push(pictures);
  parts.push(outlineOf(work.passages));
  return parts;
}

const DIFFICULTY_WORDS: Record<QuizSettings["difficulty"], string> = {
  auto: "as the brief says; when it says nothing, aim at someone who has just studied these sources.",
  easier: "easier: each question uses one idea at a time, directly.",
  standard: "standard: each question uses an idea on a case the sources do not work through themselves.",
  harder: "harder: questions combine ideas, carry them to a new case, or find where an argument goes wrong.",
};

/** The tools for a quiz: the source tools, then the writing tools, described from the kinds this quiz may use. */
export function quizTools(work: Pick<QuizWork, "allowed">): WorkTool<QuizWork>[] {
  const fields = questionSchema(work.allowed);
  const writeQuestion: WorkTool<QuizWork> = {
    name: "write_question",
    description: `Adds one question to the quiz, after the last one. Every question has a kind, a topic (2 to 4 words; results group misses by it), a prompt, feedback {correct, incorrect} (the explanation shown after the player says right or wrong, so it opens with the reason, never with a verdict of its own), and cites: the passages that settle it, each with a few words copied exactly from that passage (at most ${QUESTION_LIMITS.cites}). Optional: display, LaTeX shown under the prompt; points (1 when left out). Then the fields of its kind:\n${kindLines(work.allowed)}\nIt is checked when you send it: the kind and its fields, the cites and every quote word for word, that it does not ask what another question asks, and that what the person reads never names passages or labels. When anything is wrong nothing is kept and the answer says exactly what to fix. Options are kept in an order of Open Sourcebook's choosing, so the right one can sit anywhere.`,
    inputSchema: fields,
    label: (_input, current) => {
      const planned = plannedQuestions(current);
      const n = current.draft.questions.length + 1;
      return planned && n <= planned ? `Writing question ${n} of ${planned}` : `Writing question ${n}`;
    },
    async run(input, current) {
      if (current.settings.questions > 0 && current.draft.questions.length >= current.settings.questions) {
        return { text: `This quiz is set to ${current.settings.questions} questions and has them all; change or remove one instead.`, isError: true };
      }
      const position = current.draft.questions.length;
      const checked = checkQuestion(input, position, current);
      if ("problems" in checked) return refuse(checked.problems);
      current.draft.questions.push(checked.question);
      current.draft.finished = false;
      await current.save();
      return { text: keptLine(checked.question, current) };
    },
  };
  const changeQuestion: WorkTool<QuizWork> = {
    name: "change_question",
    description: "Replaces one question you wrote with a new version, checked the same way as write_question. Send the whole question.",
    inputSchema: { ...fields, properties: { id: { type: "string", description: "The question's id, from read_quiz." }, ...(fields.properties as JsonSchema) }, required: ["id", ...(fields.required as string[])] },
    label: (input) => `Improving question ${String(input.id ?? "").replace(/^q/, "")}`.trim(),
    async run(input, current) {
      const position = current.draft.questions.findIndex((question) => question.id === input.id);
      if (position < 0) return { text: `There is no question "${String(input.id)}"; read_quiz lists them.`, isError: true };
      const checked = checkQuestion(input, position, current);
      if ("problems" in checked) return refuse(checked.problems);
      current.draft.questions[position] = checked.question;
      current.draft.finished = false;
      await current.save();
      return { text: keptLine(checked.question, current) };
    },
  };
  return [...sourceTools<QuizWork>(), planQuiz, writeQuestion, changeQuestion, removeQuestion, readQuiz, finishQuiz];
}

/** The input of a question: the fields every question has, then the fields of each kind this quiz may use, as the kinds give them. */
function questionSchema(kinds: QuestionKind[]): JsonSchema {
  const own: JsonSchema = {};
  for (const kind of kinds) for (const [name, schema] of Object.entries(kind.fields ?? {})) own[name] ??= schema as JsonSchema;
  return {
    type: "object",
    properties: {
      ...own,
      kind: { type: "string", enum: kinds.map((kind) => kind.id) },
      topic: { type: "string" },
      prompt: { type: "string" },
      display: { type: "string" },
      points: { type: "number" },
      feedback: { type: "object", properties: { correct: { type: "string" }, incorrect: { type: "string" } }, required: ["correct", "incorrect"] },
      cites: { type: "array", items: { type: "object", properties: { passage: { type: "string" }, quote: { type: "string" } }, required: ["passage", "quote"] } },
    },
    required: ["kind", "topic", "prompt", "feedback", "cites"],
    additionalProperties: true,
  };
}

function kindLines(kinds: QuestionKind[]): string {
  return kinds.map((kind) => `- ${kind.id} (${kind.label}): ${kind.guidance}`).join("\n");
}

const planQuiz: WorkTool<QuizWork> = {
  name: "plan_quiz",
  description: "Sets the quiz's title and how many questions you mean to write, so the person sees how far the writing is. You can call it again.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" }, questions: { type: "integer", minimum: 1, maximum: MAX_QUESTIONS } },
    required: ["title"],
    additionalProperties: false,
  },
  label: () => "Planning the quiz",
  async run(input, work) {
    const title = text(input.title);
    if (!title) return { text: "`title` is required.", isError: true };
    work.draft.title = title.slice(0, 200);
    if (typeof input.questions === "number" && input.questions > 0) work.draft.planned = Math.min(MAX_QUESTIONS, Math.round(input.questions));
    await work.save();
    const planned = plannedQuestions(work);
    return { text: `Kept: "${work.draft.title}"${planned ? `, ${planned} questions` : ""}. Write them with write_question.` };
  },
};

const removeQuestion: WorkTool<QuizWork> = {
  name: "remove_question",
  description: "Removes one question you wrote; the ones after it move up a number.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  label: () => "Removing a question",
  async run(input, work) {
    const position = work.draft.questions.findIndex((question) => question.id === input.id);
    if (position < 0) return { text: `There is no question "${String(input.id)}"; read_quiz lists them.`, isError: true };
    work.draft.questions.splice(position, 1);
    work.draft.questions = work.draft.questions.map((question, at) => ({ ...question, id: `q${at + 1}` }));
    work.draft.finished = false;
    await work.save();
    return { text: `Removed. The quiz has ${work.draft.questions.length} question${work.draft.questions.length === 1 ? "" : "s"}, q1 to q${work.draft.questions.length}.` };
  },
};

const readQuiz: WorkTool<QuizWork> = {
  name: "read_quiz",
  description: "Reads back the quiz as written so far: its title and every question in order with its id, kind, fields, feedback and cites.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  label: () => "Reading the quiz back",
  run: (_input, work) => ({ text: renderDraft(work) }),
};

const finishQuiz: WorkTool<QuizWork> = {
  name: "finish_quiz",
  description:
    "Says the quiz is finished. The whole quiz is checked once more (a title, at least one question, each as write_question checks it, none asking what another asks); when it passes, it is kept and you end your turn. When it has a different number of questions from the one planned, give `note`.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The quiz's title, if not set with plan_quiz or to change it." },
      note: { type: "string", description: "When the quiz has a different number of questions from the one planned or asked for: one plain sentence to the person on why (the sources settle fewer distinct ideas)." },
    },
    additionalProperties: false,
  },
  label: () => "Checking the whole quiz",
  async run(input, work) {
    const title = text(input.title);
    if (title) work.draft.title = title.slice(0, 200);
    if (!work.draft.title) return { text: "The quiz needs a title: give one here or with plan_quiz.", isError: true };
    if (work.draft.questions.length === 0) return { text: "The quiz has no questions yet; write them with write_question.", isError: true };
    const note = text(input.note);
    if (note) work.draft.note = note.slice(0, 300);
    const issues = checkQuiz(work, work.draft.questions, work.draft.title);
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) return refuse(errors.map(problemLine));
    const planned = plannedQuestions(work);
    if (planned && planned !== work.draft.questions.length && !work.draft.note) {
      await work.save();
      return { text: `The plan said ${planned} questions and the quiz has ${work.draft.questions.length}; the person saw the plan. If this number is right, call finish_quiz again with \`note\`: why, in a sentence to them. Otherwise write or remove questions first.`, isError: true };
    }
    work.draft.finished = true;
    await work.save();
    const short = issues.find((issue) => issue.code === "short");
    return { text: `The quiz is finished and kept: "${work.draft.title}", ${work.draft.questions.length} question${work.draft.questions.length === 1 ? "" : "s"}.${short ? ` (${short.message}.)` : ""} End your turn now.` };
  },
};

/**
 * One question as the agent sent it, checked as the quiz checks it: its kind
 * is known and allowed, its cites name the item's passages with quotes in
 * them, its fields pass its kind's rules, and it does not repeat another
 * question. Either the question as kept (its options in Open Sourcebook's order) or what
 * is wrong.
 */
export function checkQuestion(input: Record<string, unknown>, position: number, work: QuizWork): { question: QuizQuestion } | { problems: string[] } {
  const kindId = text(input.kind);
  const kind = kindId ? work.kinds.get(kindId) : undefined;
  if (!kind) return { problems: [`kind: ${kindId ? `there is no question kind "${kindId}"` : "say the question's kind"}; this quiz may use ${work.allowed.map((known) => known.id).join(" or ")}.`] };
  if (!work.allowed.some((allowed) => allowed.id === kind.id)) return { problems: [`kind: "${kind.id}" is not allowed in this quiz; use ${work.allowed.map((known) => known.id).join(" or ")}.`] };
  const labels = new Map(work.passages.map((passage) => [passage.label, passage]));
  const cites = Array.isArray(input.cites) ? input.cites : [];
  const problems: string[] = [];
  if (cites.length === 0) problems.push('cites: name the passage that settles this question, {"passage":"P3","quote":"..."}.');
  cites.forEach((cite, index) => {
    if (!isRecord(cite) || typeof cite.passage !== "string") problems.push(`cites[${index}]: name a passage, {"passage":"P3","quote":"..."}.`);
    else if (!labels.has(cite.passage.trim())) problems.push(`cites[${index}]: "${cite.passage}" is not a passage of this item; its passages are ${work.passages[0]?.label}–${work.passages.at(-1)?.label}.`);
  });
  if (cites.length > QUESTION_LIMITS.cites) problems.push(`cites: at most ${QUESTION_LIMITS.cites} passages.`);
  if (problems.length > 0) return { problems };
  const cited = cites.filter(isRecord).map((cite) => labels.get(String(cite.passage).trim())!);
  const target = { ref: `t${position + 1}`, topic: text(input.topic) ?? "", objective: "", kind, passages: cited };
  const raw = parsedFields(input, kind);
  const plain = work.engine.toQuestion(raw, position, target, work.byId, work.seed, false);
  const questions = [...work.draft.questions];
  questions[position] = plain;
  const own = `questions[${position}]`;
  const found = checkQuiz(work, questions, work.draft.title ?? "Quiz").filter((issue) => issue.severity === "error" && (issue.path === own || issue.path.startsWith(`${own}.`) || issue.path.startsWith(`${own}[`)));
  if (found.length > 0) return { problems: found.map((issue) => `${issue.path.slice(own.length).replace(/^\./, "") || "the question"}: ${issue.message}`) };
  return { question: work.engine.toQuestion(raw, position, target, work.byId, work.seed) };
}

/**
 * The input with a kind's list and number fields read as such when they came
 * as JSON text (some agents send a nested value as a string).
 */
function parsedFields(input: Record<string, unknown>, kind: QuestionKind): Record<string, unknown> {
  const out = { ...input };
  for (const [name, schema] of Object.entries(kind.fields ?? {})) {
    const value = out[name];
    if (typeof value !== "string" || !["array", "integer", "number", "object"].includes(String(schema.type))) continue;
    try {
      out[name] = JSON.parse(value);
    } catch {
      // Left as sent: the kind's own check says what is wrong.
    }
  }
  return out;
}

/** Every check of the quiz in code, over these questions. */
function checkQuiz(work: QuizWork, questions: QuizQuestion[], title: string): ValidationIssue[] {
  const blueprint: QuizBlueprint = {
    title,
    targets: questions.map((question) => ({ topic: question.topic, objective: question.prompt, kind: question.kind, passageIds: question.cites.map((cite) => cite.passageId) })),
    requested: work.settings.questions,
    omittedPassages: 0,
  };
  const payload: QuizPayload = { title, passMark: work.settings.passMark / 100, feedback: work.settings.feedback, questions, ...(work.settings.timeLimit ? { timeLimit: work.settings.timeLimit } : {}) };
  const ctx = { node: { settings: work.settings } } as EngineContext<QuizSettings>;
  const issues = work.engine.checkInCode(ctx, payload, blueprint, work.byId, new Set(work.pictures.map((picture) => picture.url)));
  if (work.settings.questions > 0 && questions.length > work.settings.questions) {
    issues.push({ path: "$.questions", code: "count", message: `this quiz is set to ${work.settings.questions} questions; it has ${questions.length}`, severity: "error" });
  }
  return issues;
}

function keptLine(question: QuizQuestion, work: QuizWork): string {
  const planned = plannedQuestions(work);
  return `Kept as ${question.id}, question ${work.draft.questions.findIndex((other) => other.id === question.id) + 1} of ${work.draft.questions.length}${planned ? ` (${planned} planned)` : ""}.`;
}

function renderDraft(work: QuizWork): string {
  const { draft } = work;
  const label = (passageId: string) => work.byId.get(passageId)?.label ?? passageId;
  const head = `Title: ${draft.title ?? "(none yet)"}\n${draft.questions.length} question${draft.questions.length === 1 ? "" : "s"}${draft.finished ? ", finished" : ""}${plannedQuestions(work) ? ` (${plannedQuestions(work)} planned)` : ""}:`;
  const questions = draft.questions.map((question) => {
    const { cites, id, ...rest } = question;
    return `## ${id}\n${JSON.stringify({ ...rest, cites: cites.map((cite) => ({ passage: label(cite.passageId), quote: cite.quote })) })}`;
  });
  return [head, ...questions].join("\n\n");
}

/** A check's finding as the agent reads it: the question by its id, then what is wrong. */
function problemLine(issue: ValidationIssue): string {
  const at = /^questions\[(\d+)\](.*)$/.exec(issue.path);
  if (at) return `q${Number(at[1]) + 1}${at[2] ? ` (${at[2].replace(/^\./, "")})` : ""}: ${issue.message}`;
  return `The quiz: ${issue.message}`;
}

function refuse(problems: string[]): { text: string; isError: true } {
  return { text: `Not kept. Fix this and send it again:\n${problems.map((line) => `- ${line}`).join("\n")}`, isError: true };
}

function plannedQuestions(work: Pick<QuizWork, "settings" | "draft">): number | undefined {
  return work.settings.questions > 0 ? work.settings.questions : work.draft.planned;
}

function readDraft(value: JsonValue | undefined): QuizDraft {
  if (isRecord(value) && Array.isArray(value.questions)) {
    const questions = (value.questions as unknown[]).filter((question): question is QuizQuestion => isRecord(question) && typeof question.prompt === "string" && Array.isArray(question.cites));
    return {
      ...(typeof value.title === "string" ? { title: value.title } : {}),
      ...(typeof value.planned === "number" ? { planned: value.planned } : {}),
      ...(typeof value.note === "string" ? { note: value.note } : {}),
      questions,
      finished: value.finished === true && questions.length > 0,
    };
  }
  return { questions: [], finished: false };
}

function readSources(sources: NodeSource[]): NodeSource[] {
  return sources.filter((source) => source.envelope.accessLevel !== "metadata" && source.envelope.accessLevel !== "none");
}

function requirePassages(ctx: EngineContext<QuizSettings>): Passage[] {
  const passages = buildPassages(readSources(ctx.sources));
  if (passages.length === 0) throw new PipelineError("A quiz needs source text to ask about; this item has none that could be read.", "NO_SOURCE_TEXT");
  return passages;
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
