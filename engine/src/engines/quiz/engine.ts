/**
 * The quiz engine: questions with feedback, each
 * citing the passage it tests.
 *
 *   plan      one call: from the brief, the settings, the passages, what the
 *             person has already seen and any earlier results, pick targets
 *             (one idea each, its kind and its passages). Saved on the job.
 *   generate  write questions in small batches, each call reading only its
 *             targets' passages. A batch that fails leaves empty questions
 *             that validation flags and repair writes one by one.
 *   validate  in code first: schema, each kind's own rules, citations point
 *             at the item's passages and their quotes are in them, no
 *             duplicates. Only an output that passes that is reviewed by the
 *             model, per question against its cited passages: answerable from
 *             them, marked answer right, no other option right, nothing in it
 *             the passages do not say.
 *   repair    per failing question: rewrite that question alone with its
 *             issues; every other question is left as it was.
 *
 * Provider calls go through `services.provider`, which reports each one to
 * the job's usage sink, as the byte engine's do. No state is kept between
 * steps: passages are rebuilt from the context and the targets come from the
 * blueprint.
 */
import type { Citation, EngineContext, EngineOutput, JsonValue, NodeSource, OutputEngine, ValidationIssue, ValidationReport } from "../../studio/types";
import type { ProviderTask } from "../../types/provider";
import { PipelineError, withRetry } from "../retry";
import type { QuizSettings } from "./definition";
import { createDefaultQuestionKinds } from "./default-kinds";
import { seededRandom, type QuestionKind, type QuestionKindRegistry } from "./kinds";
import { picturesNote, sourcePictures } from "./pictures";
import { spread } from "../../sources/reading";
import { buildPassages, cutNotes, learnerStrings, normalizeText, promptLabelLeaks, quoteInPassage, type Passage } from "../../sources/passages";
import {
  buildPlanPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  buildWritePrompt,
  sittingNote,
  systemPrompt,
  type QuizStep,
  type ReviewItem,
  type WriteTarget,
} from "./prompts";
import { QUIZ_SCHEMA_VERSION, MAX_QUESTIONS, MAX_TIME_LIMIT, QUESTION_LIMITS, QUESTIONS_PER_CALL, type QuizPayload, type QuizQuestion, type QuestionCite } from "./schema";

/** One planned question: what it tests and from which passages. */
export interface QuizTarget {
  topic: string;
  objective: string;
  kind: string;
  passageIds: string[];
  difficulty?: string;
}

export interface QuizBlueprint {
  title: string;
  targets: QuizTarget[];
  /** The fixed length asked for, 0 when the brief decided. */
  requested: number;
  /** Passages the planning prompt left out; those it showed were spread across the sources. */
  omittedPassages: number;
}

/** One reviewer verdict on one question. */
export interface QuestionReview {
  id: string;
  answerable: boolean;
  correct: boolean;
  unique: boolean;
  grounded: boolean;
  note?: string;
}

export interface QuizEngineOptions {
  kinds?: QuestionKindRegistry;
  /** Attempts per provider step before it counts as failed. */
  maxProviderAttempts?: number;
  concurrency?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Most passage characters the planning call reads. */
  maxPlanChars?: number;
}

const DEFAULT_CONCURRENCY = 4;
/**
 * Most passage characters the planning call reads; past it the planner sees
 * passages taken evenly across all the quiz covers (engine/docs/long-sources.md).
 */
export const DEFAULT_MAX_PLAN_CHARS = 48_000;
/** Prompts that share this many of their words count as the same question. */
const DUPLICATE_OVERLAP = 0.85;

// The router has no task of its own for reviewing yet; review reads a few
// passages and returns short verdicts, the same profile as writing a section.
const TASKS: Record<QuizStep, ProviderTask> = { plan: "planning", write: "section", review: "section", repair: "repair" };

export class QuizEngine implements OutputEngine<QuizSettings, QuizBlueprint, QuizPayload> {
  readonly type = "quiz";
  readonly schemaVersion = QUIZ_SCHEMA_VERSION;
  private readonly kinds: QuestionKindRegistry;

  constructor(private readonly options: QuizEngineOptions = {}) {
    this.kinds = options.kinds ?? createDefaultQuestionKinds();
  }

  async plan(ctx: EngineContext<QuizSettings>): Promise<QuizBlueprint> {
    const passages = requirePassages(ctx);
    const settings = ctx.node.settings;
    const allowed = this.allowedKinds(settings, ctx.sources);
    const shown = spread(passages, this.options.maxPlanChars ?? DEFAULT_MAX_PLAN_CHARS);
    const omitted = passages.length - shown.length;
    await ctx.services.progress({ stage: "planning", progress: 0.05 });

    return withRetry(async () => {
      const response = await this.call<unknown>(ctx, "plan", buildPlanPrompt({
        title: ctx.node.title,
        brief: ctx.node.prompt,
        questions: settings.questions,
        maxQuestions: MAX_QUESTIONS,
        kinds: allowed,
        difficulty: settings.difficulty,
        passages: shown,
        omittedPassages: omitted,
        assumes: ctx.assumes,
        inputs: ctx.inputs,
        cut: cutNotes(ctx.sources),
        sitting: sittingNote(settings),
      }));
      const blueprint = normalizePlan(response, shown, allowed, settings.questions, omitted, ctx.node.title);
      // A plan with nothing to test is junk model output, retried like a transient failure.
      if (blueprint.targets.length === 0) throw new PipelineError("Quiz plan has no usable targets", "EMPTY_STRUCTURE");
      return blueprint;
    }, this.retryOptions());
  }

  async generate(ctx: EngineContext<QuizSettings>, blueprint: QuizBlueprint): Promise<EngineOutput<QuizPayload>> {
    const passages = byId(requirePassages(ctx));
    const targets = blueprint.targets.map((target, position) => this.writeTarget(target, position, passages));
    const questions = new Array<QuizQuestion | undefined>(targets.length).fill(undefined);
    const batches = chunk(targets.map((target, position) => ({ target, position })), QUESTIONS_PER_CALL);
    let finished = 0;
    let failures = 0;
    const pictures = targets.some((target) => target.kind.usesPicture) ? picturesNote(sourcePictures(ctx.sources)) : undefined;

    // Questions an earlier attempt wrote are kept; only the rest are written.
    for (const { target, position } of batches.flat()) {
      const kept = readQuestion(ctx.services.checkpoint?.get(`question:${position}`), target);
      if (kept) questions[position] = kept;
    }
    const pending = batches.map((batch) => batch.filter(({ position }) => questions[position] === undefined)).filter((batch) => batch.length > 0);
    finished = batches.length - pending.length;

    await this.forEach(ctx, pending, async (batch) => {
      try {
        const response = await withRetry(
          () => this.call<unknown>(ctx, "write", buildWritePrompt(batch.map((entry) => entry.target), ctx.node.prompt, cutNotes(ctx.sources), pictures, sittingNote(ctx.node.settings))),
          this.retryOptions(),
        );
        const written = writtenQuestions(response);
        for (const { target, position } of batch) {
          const raw = written.get(target.ref) ?? (batch.length === 1 && written.size === 1 ? [...written.values()][0] : undefined);
          if (!raw) continue;
          questions[position] = this.toQuestion(raw, position, target, passages, ctx.jobId);
          await ctx.services.checkpoint?.put(`question:${position}`, questions[position] as unknown as JsonValue);
        }
      } catch (error) {
        if (ctx.services.signal?.aborted) throw error;
        failures += 1;
      }
      finished += 1;
      await ctx.services.progress({ stage: "writing", progress: 0.2 + 0.5 * (finished / batches.length) });
    });
    if (pending.length > 0 && failures === pending.length && questions.every((question) => question === undefined)) throw new PipelineError("Every batch of quiz questions failed to generate.", "EMPTY_STRUCTURE");

    const filled = questions.map((question, position) => question ?? emptyQuestion(position, targets[position]));
    return this.toOutput(ctx, blueprint, filled);
  }

  async validate(ctx: EngineContext<QuizSettings>, output: EngineOutput<QuizPayload>, blueprint: QuizBlueprint): Promise<ValidationReport> {
    const passages = byId(buildPassages(readSources(ctx.sources)));
    const issues = this.checkInCode(ctx, output.payload, blueprint, passages, new Set(sourcePictures(ctx.sources).map((picture) => picture.url)));
    if (issues.some((issue) => issue.severity === "error")) return report(issues);

    await ctx.services.progress({ stage: "reviewing", progress: 0.75 });
    issues.push(...(await this.review(ctx, output.payload, passages)));
    return report(issues);
  }

  async repair(
    ctx: EngineContext<QuizSettings>,
    output: EngineOutput<QuizPayload>,
    validation: ValidationReport,
    blueprint: QuizBlueprint,
  ): Promise<EngineOutput<QuizPayload>> {
    const passages = byId(buildPassages(readSources(ctx.sources)));
    const byQuestion = new Map<number, string[]>();
    for (const issue of validation.issues) {
      if (issue.severity !== "error") continue;
      const position = questionIndex(issue.path);
      if (position === undefined || position >= blueprint.targets.length) continue;
      byQuestion.set(position, [...(byQuestion.get(position) ?? []), `${issue.path}: ${issue.message} (${issue.code})`]);
    }
    await ctx.services.progress({ stage: "repairing", progress: 0.8 });

    const questions = blueprint.targets.map((target, position) => output.payload.questions[position] ?? emptyQuestion(position, this.writeTarget(target, position, passages)));
    await this.forEach(ctx, [...byQuestion.entries()], async ([position, problems]) => {
      const target = this.writeTarget(blueprint.targets[position], position, passages);
      try {
        const response = await withRetry(
          () => this.call<unknown>(ctx, "repair", buildRepairPrompt(target, questions[position], problems)),
          this.retryOptions(),
        );
        const raw = isRecord(response) && isRecord(response.question) ? response.question : isRecord(response) ? response : undefined;
        if (raw) questions[position] = this.toQuestion(raw, position, target, passages, ctx.jobId);
      } catch (error) {
        // The question stays as it was; the next validation reports it again.
        if (ctx.services.signal?.aborted) throw error;
      }
    });
    return this.toOutput(ctx, blueprint, questions);
  }

  /** Every rule that needs no model. */
  checkInCode(ctx: EngineContext<QuizSettings>, payload: QuizPayload, blueprint: QuizBlueprint, passages: Map<string, Passage>, pictures?: ReadonlySet<string>): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (!payload.title?.trim()) issues.push(error("$.title", "empty", "the quiz needs a title"));
    if (!(payload.passMark >= 0 && payload.passMark <= 1)) issues.push(error("$.passMark", "range", "passMark must be 0 to 1"));
    if (payload.timeLimit !== undefined && !(Number.isInteger(payload.timeLimit) && payload.timeLimit > 0 && payload.timeLimit <= MAX_TIME_LIMIT)) {
      issues.push(error("$.timeLimit", "range", `timeLimit must be a whole number of minutes from 1 to ${MAX_TIME_LIMIT}`));
    }
    if (payload.questions.length !== blueprint.targets.length) {
      issues.push(error("$.questions", "count", `expected ${blueprint.targets.length} questions, found ${payload.questions.length}`));
    }
    const allowed = new Set(ctx.node.settings.kinds);
    const seen: Array<{ position: number; words: Set<string>; key: string }> = [];

    payload.questions.forEach((question, position) => {
      const at = `questions[${position}]`;
      const kind = this.kinds.get(question.kind);
      if (!kind || !allowed.has(question.kind)) {
        issues.push(error(`${at}.kind`, "kind", `kind "${question.kind}" is not allowed here; use ${[...allowed].join(" or ")}`));
        return;
      }
      if (question.id !== `q${position + 1}`) issues.push(error(`${at}.id`, "id", `id must be q${position + 1}`));
      issues.push(...textIssues(question, at));
      issues.push(...leakIssues(question, at, [...passages.values()]));
      for (const problem of kind.check(question, pictures ? { pictures } : {})) issues.push(error(`${at}${problem.path}`, problem.code, problem.message));
      issues.push(...citeIssues(question.cites, at, passages));

      const key = normalizeText(`${question.prompt} ${question.display ?? ""}`);
      const words = wordSet(key);
      const earlier = seen.find((other) => other.key === key || overlap(other.words, words) >= DUPLICATE_OVERLAP);
      if (key && earlier) issues.push(error(`${at}.prompt`, "duplicate", `asks the same as questions[${earlier.position}]; test a different idea`));
      seen.push({ position, words, key });
    });

    if (blueprint.requested > 0 && blueprint.targets.length < blueprint.requested) {
      issues.push(warning("$.questions", "short", `${blueprint.requested} questions were asked for; the sources supported ${blueprint.targets.length}`));
    }
    if (blueprint.omittedPassages > 0) {
      issues.push(warning("$", "passages_omitted", `${blueprint.omittedPassages} passages were not shown to the planner; the ones it saw were taken evenly across the sources`));
    }
    return issues;
  }

  /** The model's verdict per question, in batches, each reading only the passages its questions cite. */
  private async review(ctx: EngineContext<QuizSettings>, payload: QuizPayload, passages: Map<string, Passage>): Promise<ValidationIssue[]> {
    const items: Array<ReviewItem & { position: number }> = payload.questions.map((question, position) => ({
      id: question.id,
      position,
      question,
      kind: this.kinds.get(question.kind)!,
      passages: question.cites.map((cite) => passages.get(cite.passageId)!),
    }));
    const issues: ValidationIssue[] = [];
    await this.forEach(ctx, chunk(items, QUESTIONS_PER_CALL), async (batch) => {
      // A review that cannot run fails the attempt: an unreviewed quiz is not shipped.
      const response = await withRetry(() => this.call<unknown>(ctx, "review", buildReviewPrompt(batch)), this.retryOptions());
      const verdicts = reviewsById(response);
      for (const item of batch) issues.push(...reviewIssues(verdicts.get(item.id), `questions[${item.position}]`));
    });
    return issues.sort((a, b) => (questionIndex(a.path) ?? 0) - (questionIndex(b.path) ?? 0));
  }

  /**
   * A written question in the payload shape. Its options are shuffled with a
   * seed from the job, the position and the prompt: writers put the right
   * option first far more often than chance, and the order is fixed once the
   * quiz is stored.
   */
  toQuestion(raw: Record<string, unknown>, position: number, target: WriteTarget, passages: Map<string, Passage>, seed: string, arrange = true): QuizQuestion {
    const feedback = isRecord(raw.feedback) ? raw.feedback : {};
    const points = typeof raw.points === "number" && Number.isFinite(raw.points) && raw.points > 0 ? Math.min(raw.points, QUESTION_LIMITS.points) : 1;
    const display = str(raw.display);
    const byLabel = new Map([...passages.values()].map((passage) => [passage.label, passage]));
    const cites: QuestionCite[] = (Array.isArray(raw.cites) ? raw.cites : [])
      .filter(isRecord)
      .map((cite) => ({ passage: byLabel.get(str(cite.passage) ?? "") ?? passages.get(str(cite.passage) ?? ""), quote: str(cite.quote) ?? "" }))
      .filter((cite): cite is { passage: Passage; quote: string } => cite.passage !== undefined)
      .slice(0, QUESTION_LIMITS.cites)
      .map(({ passage, quote }) => toCite(passage, quote));
    const fields = target.kind.normalize(raw);
    const prompt = str(raw.prompt) ?? "";
    const arranged = (arrange ? target.kind.arrange?.({ ...fields, prompt } as QuizQuestion, seededRandom(`${seed}:${position}:${prompt}`)) : undefined) ?? {};
    return {
      ...fields,
      ...arranged,
      id: `q${position + 1}`,
      kind: target.kind.id,
      topic: str(raw.topic) ?? target.topic,
      prompt,
      ...(display ? { display } : {}),
      points,
      feedback: { correct: str(feedback.correct) ?? "", incorrect: str(feedback.incorrect) ?? "" },
      // With no usable citation, the target's passages stand in with no
      // quote, so validation asks for one rather than losing the link.
      cites: cites.length > 0 ? cites : target.passages.slice(0, QUESTION_LIMITS.cites).map((passage) => toCite(passage, "")),
    };
  }

  private toOutput(ctx: EngineContext<QuizSettings>, blueprint: QuizBlueprint, questions: QuizQuestion[]): EngineOutput<QuizPayload> {
    const settings = ctx.node.settings;
    const payload: QuizPayload = {
      title: blueprint.title,
      passMark: settings.passMark / 100,
      feedback: settings.feedback,
      questions,
      ...(settings.timeLimit ? { timeLimit: settings.timeLimit } : {}),
    };
    const citations: Citation[] = questions.flatMap((question, position) =>
      question.cites.map((cite) => ({
        sourceId: cite.sourceId,
        ...(cite.chunkId ? { chunkId: cite.chunkId } : {}),
        ...(cite.locator ? { locator: cite.locator } : {}),
        ...(cite.quote ? { quote: cite.quote } : {}),
        anchor: `questions[${position}]`,
      })),
    );
    return { title: blueprint.title, summary: summarize(questions), payload, citations };
  }

  writeTarget(target: QuizTarget, position: number, passages: Map<string, Passage>): WriteTarget {
    const kind = this.kinds.get(target.kind) ?? this.kinds.all()[0];
    return {
      ref: `t${position + 1}`,
      topic: target.topic,
      objective: target.objective,
      kind,
      ...(target.difficulty ? { difficulty: target.difficulty } : {}),
      passages: target.passageIds.map((id) => passages.get(id)).filter((passage): passage is Passage => passage !== undefined),
    };
  }

  /**
   * The kinds this quiz may use: those its settings name that this engine
   * knows, without the kinds about a picture when its sources (given) hold
   * none.
   */
  allowedKinds(settings: QuizSettings, sources?: readonly NodeSource[]): QuestionKind[] {
    const known = settings.kinds.map((id) => this.kinds.get(id)).filter((kind): kind is QuestionKind => kind !== undefined);
    if (known.length === 0) throw new PipelineError("None of the quiz's question kinds is known to this engine.", "INVALID_SETTINGS");
    const kinds = sources && sourcePictures(sources).length === 0 ? known.filter((kind) => !kind.usesPicture) : known;
    if (kinds.length === 0) throw new PipelineError(`This quiz takes only questions about a picture (${known.map((kind) => kind.label.toLowerCase()).join(", ")}), and its sources have no pictures. Allow another kind of question or add a source with pictures.`, "INVALID_SETTINGS");
    return kinds;
  }

  private call<T>(ctx: EngineContext<QuizSettings>, step: QuizStep, userPrompt: string): Promise<T> {
    return ctx.services.provider.generateJSON<T>({ systemPrompt: systemPrompt(step), userPrompt, task: TASKS[step] });
  }

  private async forEach<T>(ctx: EngineContext<QuizSettings>, items: T[], work: (item: T) => Promise<void>): Promise<void> {
    const size = Math.max(1, this.options.concurrency ?? DEFAULT_CONCURRENCY);
    for (let start = 0; start < items.length; start += size) {
      ctx.services.signal?.throwIfAborted();
      await Promise.all(items.slice(start, start + size).map(work));
    }
  }

  private retryOptions() {
    return {
      maxAttempts: this.options.maxProviderAttempts,
      sleep: this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    };
  }
}

/** A question an earlier attempt wrote for this target, when the checkpoint holds one. */
function readQuestion(value: JsonValue | undefined, target: WriteTarget): QuizQuestion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.kind !== target.kind.id || typeof value.prompt !== "string") return undefined;
  return value as unknown as QuizQuestion;
}

/** The sources whose text was read; one that gave only its title and details has nothing to ask about. */
function readSources(sources: NodeSource[]): NodeSource[] {
  return sources.filter((source) => source.envelope.accessLevel !== "metadata" && source.envelope.accessLevel !== "none");
}

function requirePassages(ctx: EngineContext<QuizSettings>): Passage[] {
  const read = readSources(ctx.sources);
  if (ctx.sources.length > 0 && read.length === 0) {
    const why = ctx.sources.flatMap((source) => source.envelope.limitations).slice(0, 2).join(" ");
    throw new PipelineError(`Only the title and details of this item's sources could be read, not their text, so there is nothing to ask about.${why ? ` ${why}` : ""}`, "NO_SOURCE_TEXT");
  }
  const passages = buildPassages(read);
  if (passages.length === 0) throw new PipelineError("A quiz needs source text to ask about; this item has none.", "NO_SOURCE_TEXT");
  return passages;
}


/** The model's plan, kept to what can be used: known passages, allowed kinds, distinct objectives, the asked length. */
export function normalizePlan(
  response: unknown,
  passages: Passage[],
  kinds: QuestionKind[],
  requested: number,
  omittedPassages: number,
  fallbackTitle: string,
): QuizBlueprint {
  const record = isRecord(response) ? response : {};
  const byLabel = new Map(passages.map((passage) => [passage.label, passage.id]));
  const allowed = new Set(kinds.map((kind) => kind.id));
  const objectives = new Set<string>();
  const targets: QuizTarget[] = [];
  for (const raw of Array.isArray(record.targets) ? record.targets : []) {
    if (!isRecord(raw)) continue;
    const objective = str(raw.objective);
    const passageIds = [...new Set((Array.isArray(raw.passages) ? raw.passages : []).map((label) => byLabel.get(String(label))).filter((id): id is string => id !== undefined))];
    if (!objective || passageIds.length === 0) continue;
    const key = normalizeText(objective);
    if (objectives.has(key)) continue;
    objectives.add(key);
    const difficulty = str(raw.difficulty);
    targets.push({
      topic: (str(raw.topic) ?? "General").slice(0, QUESTION_LIMITS.topic),
      objective,
      kind: typeof raw.kind === "string" && allowed.has(raw.kind) ? raw.kind : kinds[0].id,
      passageIds: passageIds.slice(0, QUESTION_LIMITS.cites),
      ...(difficulty ? { difficulty } : {}),
    });
  }
  const limit = requested > 0 ? requested : MAX_QUESTIONS;
  return {
    title: (str(record.title) ?? fallbackTitle.trim()) || "Quiz",
    targets: targets.slice(0, limit),
    requested,
    omittedPassages,
  };
}

function writtenQuestions(response: unknown): Map<string, Record<string, unknown>> {
  const list = isRecord(response) && Array.isArray(response.questions) ? response.questions : Array.isArray(response) ? response : [];
  const written = new Map<string, Record<string, unknown>>();
  for (const raw of list) {
    if (isRecord(raw) && typeof raw.target === "string" && !written.has(raw.target)) written.set(raw.target, raw);
  }
  return written;
}

function reviewsById(response: unknown): Map<string, QuestionReview> {
  const list = isRecord(response) && Array.isArray(response.reviews) ? response.reviews : [];
  const reviews = new Map<string, QuestionReview>();
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const note = str(raw.note);
    reviews.set(raw.id, {
      id: raw.id,
      answerable: raw.answerable === true,
      correct: raw.correct === true,
      unique: raw.unique === true,
      grounded: raw.grounded === true,
      ...(note ? { note } : {}),
    });
  }
  return reviews;
}

function reviewIssues(review: QuestionReview | undefined, at: string): ValidationIssue[] {
  if (!review) return [error(at, "review_missing", "the reviewer returned no verdict for this question")];
  const note = review.note ? `: ${review.note}` : "";
  const issues: ValidationIssue[] = [];
  if (!review.answerable) issues.push(error(at, "review_unanswerable", `cannot be answered from its cited passages${note}`));
  if (!review.correct) issues.push(error(at, "review_wrong_answer", `the marked answer is not right by the passages${note}`));
  if (!review.unique) issues.push(error(at, "review_not_unique", `another option is also right${note}`));
  if (!review.grounded) issues.push(error(at, "review_unsupported", `says something the passages do not${note}`));
  return issues;
}

function textIssues(question: QuizQuestion, at: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const required: Array<[string, unknown, number]> = [
    ["topic", question.topic, QUESTION_LIMITS.topic],
    ["prompt", question.prompt, QUESTION_LIMITS.prompt],
    ["feedback.correct", question.feedback?.correct, QUESTION_LIMITS.feedback],
    ["feedback.incorrect", question.feedback?.incorrect, QUESTION_LIMITS.feedback],
  ];
  for (const [field, value, max] of required) {
    if (typeof value !== "string" || !value.trim()) issues.push(error(`${at}.${field}`, "empty", `${field} must be non-empty text`));
    else if (value.length > max) issues.push(error(`${at}.${field}`, "too_long", `${field} is at most ${max} characters`));
  }
  if (question.display !== undefined && (typeof question.display !== "string" || question.display.length > QUESTION_LIMITS.display)) {
    issues.push(error(`${at}.display`, "display", `display is text of at most ${QUESTION_LIMITS.display} characters`));
  }
  if (!(typeof question.points === "number" && question.points > 0 && question.points <= QUESTION_LIMITS.points)) {
    issues.push(error(`${at}.points`, "points", `points must be above 0 and at most ${QUESTION_LIMITS.points}`));
  }
  return issues;
}

/** Fields of a question no person reads as text. */
const NOT_SHOWN = new Set(["id", "kind", "cites", "answer", "input"]);

function leakIssues(question: QuizQuestion, at: string, passages: Passage[]): ValidationIssue[] {
  return learnerStrings(question, at, NOT_SHOWN).flatMap(({ path, text }) => {
    const leaks = promptLabelLeaks(text, passages);
    return leaks.length === 0
      ? []
      : [error(path, "names_prompt_label", `names ${leaks.map((term) => `"${term}"`).join(", ")}, words only the writer saw; the person reads the source, not labelled passages. Say what the source says instead`)];
  });
}

function citeIssues(cites: QuestionCite[] | undefined, at: string, passages: Map<string, Passage>): ValidationIssue[] {
  if (!Array.isArray(cites) || cites.length === 0) return [error(`${at}.cites`, "uncited", "every question cites the passage it tests")];
  const issues: ValidationIssue[] = [];
  if (cites.length > QUESTION_LIMITS.cites) issues.push(error(`${at}.cites`, "too_many", `at most ${QUESTION_LIMITS.cites} passages`));
  cites.forEach((cite, position) => {
    const path = `${at}.cites[${position}]`;
    const passage = passages.get(cite.passageId);
    if (!passage || passage.sourceId !== cite.sourceId) {
      issues.push(error(path, "unknown_passage", "cites a passage that is not in this item's sources"));
    } else if (!cite.quote?.trim()) {
      issues.push(error(`${path}.quote`, "no_quote", `quote the words of ${passage.label} this question tests`));
    } else if (cite.quote.length > QUESTION_LIMITS.quote) {
      issues.push(error(`${path}.quote`, "too_long", `a quote is at most ${QUESTION_LIMITS.quote} characters`));
    } else if (!quoteInPassage(cite.quote, passage)) {
      issues.push(error(`${path}.quote`, "quote_not_in_passage", `the quote is not word for word in ${passage.label}`));
    }
  });
  return issues;
}

function toCite(passage: Passage, quote: string): QuestionCite {
  return {
    passageId: passage.id,
    sourceId: passage.sourceId,
    ...(passage.chunkId ? { chunkId: passage.chunkId } : {}),
    ...(passage.locator ? { locator: passage.locator } : {}),
    quote,
  };
}

function emptyQuestion(position: number, target: WriteTarget): QuizQuestion {
  return {
    ...target.kind.normalize({}),
    id: `q${position + 1}`,
    kind: target.kind.id,
    topic: target.topic,
    prompt: "",
    points: 1,
    feedback: { correct: "", incorrect: "" },
    cites: target.passages.slice(0, QUESTION_LIMITS.cites).map((passage) => toCite(passage, "")),
  };
}

/** What later items are told this quiz covered. */
export function summarize(questions: QuizQuestion[]): string {
  const topics = [...new Set(questions.map((question) => question.topic).filter(Boolean))];
  const listed = topics.length > 4 ? `${topics.slice(0, 4).join(", ")} and ${topics.length - 4} more` : topics.join(", ");
  return `A quiz of ${questions.length} question${questions.length === 1 ? "" : "s"}${listed ? ` on ${listed}` : ""}.`;
}

function questionIndex(path: string): number | undefined {
  const match = /^questions\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : undefined;
}

function wordSet(text: string): Set<string> {
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function byId(passages: Passage[]): Map<string, Passage> {
  return new Map(passages.map((passage) => [passage.id, passage]));
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}

function str(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function error(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}

function warning(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "warning" };
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}
