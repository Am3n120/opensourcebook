/**
 * The quiz format's registry entry: descriptor, settings and cost estimate.
 *
 * Settings say how long, how hard, which question kinds, the pass mark, the
 * time allowed and the format a real paper has, when the person says one;
 * what the quiz is for (a first look at what someone knows, a quiz after
 * a topic, a long exam-style run, a fix for what was missed) is the brief's
 * to say, never a setting.
 */
import type {
  Glimpse,
  CostEstimate,
  CostEstimateInput,
  FormatDefinition,
  FormatDescriptor,
  SettingField,
  SettingOption,
  SettingsResult,
  ValidationIssue,
} from "../../studio/types";
import type { ModelPrice } from "../../types/provider";
import { plainLine } from "../../studio/glimpse";
import { countSize } from "../../studio/size";
import { quizAnchor } from "./anchor";
import { DEFAULT_MAX_PLAN_CHARS, QuizEngine, type QuizBlueprint, type QuizEngineOptions } from "./engine";
import { createDefaultQuestionKinds } from "./default-kinds";
import type { QuestionKindRegistry } from "./kinds";
import { FEEDBACK_TIMINGS, MAX_LAYOUT, MAX_QUESTIONS, MAX_TIME_LIMIT, QUESTIONS_PER_CALL, QUIZ_SCHEMA_VERSION, type QuizPayload, type FeedbackTiming } from "./schema";
import { MakerRegistry, MakersEngine, parseMakerSetting, OPEN_PICK, type ItemMaker, type MadeBlueprint } from "../makers";
import { AGENT_SETTING_KEYS, readAgentFields } from "../agent-fields";

export type Difficulty = "auto" | "easier" | "standard" | "harder";
export const DIFFICULTIES: readonly Difficulty[] = ["auto", "easier", "standard", "harder"];

export interface QuizSettings {
  /** How many questions; 0 lets the brief and the sources decide. */
  questions: number;
  /** Question kinds the quiz may use; ids from the kind registry. */
  kinds: string[];
  /** "auto" follows the brief. */
  difficulty: Difficulty;
  /** Percent of the points that passes, 0 to 100. */
  passMark: number;
  feedback: FeedbackTiming;
  /** Minutes from Start until the quiz ends as it stands; 0 is no limit. Absent on settings stored before it: 0. */
  timeLimit?: number;
  /**
   * How the real paper is laid out, in the person's words (its parts, how
   * many questions of each kind, the marks for each); the maker writes the
   * quiz to match. Empty: the brief and the sources decide.
   */
  layout?: string;
  /** The maker's id, or "auto" (absent) for the one Open Sourcebook picks (engines/makers.ts). */
  maker?: string;
  /** Who makes it when the person's agent does: "auto" (the default from Settings) or a pick id (engines/agent-fields.ts). */
  agent?: string;
  /** How hard that agent thinks: "auto" or an effort id. */
  effort?: string;
}

export const QUIZ_MAX_REPAIR_ROUNDS = 2;

export interface QuizDefinitionOptions extends QuizEngineOptions {
  price?: ModelPrice;
  /** False when no model API key is set here, so Open Sourcebook's own writer is not offered. Offered when absent. */
  api?: boolean;
  /** Other makers (the person's own agent), listed before Open Sourcebook's own writer. */
  makers?: ItemMaker<QuizSettings, unknown, QuizPayload>[];
  /** The maker "auto" prefers when it can make things now. */
  defaultMaker?: string;
}

export type QuizDefinition = FormatDefinition<QuizSettings, MadeBlueprint, QuizPayload>;

/** Open Sourcebook's own writer, calling a model with the API key set on this engine. Stored on jobs as its id. */
export const API_QUIZ_MAKER_ID = "api";

/** Each difficulty in words; `auto` leaves it to the brief. */
const DIFFICULTY_OPTIONS: Record<Difficulty, Omit<SettingOption, "value">> = {
  auto: { label: "From the brief", description: "As hard as the brief says the quiz is for." },
  easier: { label: "Easier", description: "Each question uses one idea at a time, directly." },
  standard: { label: "Standard", description: "Questions use an idea on a case the sources do not work through." },
  harder: { label: "Harder", description: "Questions combine ideas, use them on new cases or find a flaw in an argument." },
};

/** When the player shows whether an answer was right. */
const FEEDBACK_OPTIONS: Record<FeedbackTiming, Omit<SettingOption, "value">> = {
  afterEach: { label: "After each question", description: "Says right or wrong, and why, as soon as each question is answered." },
  atEnd: { label: "At the end", description: "Holds every answer's feedback until the whole quiz is done." },
};

export function quizSettingFields(kinds: QuestionKindRegistry): SettingField[] {
  return [
    {
      key: "questions",
      label: "Questions",
      help: "How many questions it asks, which is how far it goes: a few for a quick check, many for an exam-like run.",
      kind: "number",
      min: 0,
      max: MAX_QUESTIONS,
      step: 1,
      specialValues: [{ value: 0, means: "auto", label: "Fit to the brief", description: "Counted when it is made, from the brief and the sources." }],
    },
    {
      key: "kinds",
      label: "Question kinds",
      help: "Which kinds of question it may use.",
      kind: "choices",
      // Every registered kind offers itself, in its own words.
      options: kinds.options(),
      minItems: 1,
      maxItems: kinds.ids().length,
    },
    { key: "difficulty", label: "Difficulty", kind: "choice", options: DIFFICULTIES.map((value) => ({ value, ...DIFFICULTY_OPTIONS[value] })) },
    { key: "passMark", label: "Pass mark", help: "Share of the points that passes. Branches can read the score.", kind: "number", min: 0, max: 100, step: 5, unit: "%" },
    { key: "feedback", label: "Feedback", kind: "choice", options: FEEDBACK_TIMINGS.map((value) => ({ value, ...FEEDBACK_OPTIONS[value] })) },
    {
      key: "timeLimit",
      label: "Time limit",
      help: "Minutes from Start. The clock shows while answering, and when it runs out the quiz ends as it stands.",
      kind: "number",
      min: 0,
      max: MAX_TIME_LIMIT,
      step: 5,
      unit: "min",
      specialValues: [{ value: 0, means: "none", label: "No time limit", description: "Take as long as you need." }],
    },
    {
      key: "layout",
      label: "Format to follow",
      help: "How the real paper is laid out, in your words: its parts, how many questions of each kind, the marks for each. The quiz is written to match it.",
      kind: "text",
      maxLength: MAX_LAYOUT,
    },
  ];
}

export function defaultQuizSettings(kinds: QuestionKindRegistry): QuizSettings {
  return { questions: 0, kinds: kinds.ids(), difficulty: "auto", passMark: 70, feedback: "afterEach", timeLimit: 0, layout: "" };
}

export function quizDescriptor(kinds: QuestionKindRegistry = createDefaultQuestionKinds(), makers?: MakerRegistry<QuizSettings, QuizPayload>): FormatDescriptor {
  const defaults = defaultQuizSettings(kinds);
  const pick = [...(makers?.settingFields() ?? []), ...(makers?.agentFields("chat") ?? [])];
  return {
    id: "quiz",
    label: "quiz",
    plural: "quizzes",
    colorSlot: 3,
    icon: "check",
    // Stored rows and plan items made before the rename (DECISIONS #35).
    aliases: ["check"],
    about:
      "Questions for checking yourself, with feedback, graded as you answer; its score can steer what comes next. Suits finding out what you know, testing it after learning something, or practising problems. Its number of questions and difficulty set how far it goes, from three quick questions to a long exam-like run. For a practice exam it can be timed, hold its feedback to the end, and follow the real paper's format, then give a mark and a breakdown by topic.",
    blurb: "questions that check what you know, with feedback",
    reports: [
      { metric: "score", label: "Score", about: "share of the points earned, 0 to 1", unit: "share" },
      { metric: "correct", label: "Right answers", about: "how many questions were answered right", unit: "count" },
      { metric: "answered", label: "Questions answered", about: "how many questions were answered", unit: "count" },
    ],
    settings: [...quizSettingFields(kinds), ...pick],
    defaults: { ...defaults, kinds: [...defaults.kinds], ...(pick.some((field) => field.key === "maker") ? { maker: OPEN_PICK } : {}) },
  };
}

/** The makers of quizzes here: the ones given (the person's agent), then Open Sourcebook's own writer when a key is set. */
export function quizMakers(options: QuizDefinitionOptions = {}): MakerRegistry<QuizSettings, QuizPayload> {
  const { price, api = true, makers = [], defaultMaker, ...engineOptions } = options;
  const kinds = engineOptions.kinds ?? createDefaultQuestionKinds();
  const registry = new MakerRegistry<QuizSettings, QuizPayload>("quiz", { ...(defaultMaker ? { defaultId: defaultMaker } : {}), legacy: API_QUIZ_MAKER_ID });
  for (const maker of makers) registry.register(maker);
  if (api) {
    registry.register({
      id: API_QUIZ_MAKER_ID,
      label: "Model API key",
      description: "Open Sourcebook writes it with the model API key set on this engine: it plans what to test, writes the questions, has each one reviewed against its passages and repairs what fails. Each call is paid on that key.",
      engine: new QuizEngine({ ...engineOptions, kinds }) as ItemMaker<QuizSettings, unknown, QuizPayload>["engine"],
      maxRepairRounds: QUIZ_MAX_REPAIR_ROUNDS,
      estimateCost: (input) => estimateQuizCost(input, price),
    });
  }
  return registry;
}

export function createQuizDefinition(options: QuizDefinitionOptions = {}): QuizDefinition {
  const kinds = options.kinds ?? createDefaultQuestionKinds();
  const makers = quizMakers({ ...options, kinds });
  const engine = new MakersEngine<QuizSettings, QuizPayload>("quiz", QUIZ_SCHEMA_VERSION, makers);
  return {
    descriptor: quizDescriptor(kinds, makers),
    engine,
    maxRepairRounds: Math.max(0, ...makers.list().map((maker) => maker.maxRepairRounds)),
    repairRoundsFor: (blueprint) => engine.repairRounds(blueprint),
    parseSettings: (raw) => parseQuizSettings(raw, kinds),
    itemIssues: (settings) => makers.issues(settings),
    estimateCost: (input) => {
      const resolved = makers.resolve(input.settings);
      return "maker" in resolved ? resolved.maker.estimateCost(input) : { unpriced: true, basis: "nothing here can make a quiz" };
    },
    settle: (settings, input) => ({ ...makers.settle(settings), ...makers.settleAgent("quiz", settings, input.picks), ...(settings.questions === 0 && input.sourceChars > 0 ? { questions: guessedCount(input.sourceChars) } : {}) }),
    describe: (settings) => [
      makers.labelFor(settings) ?? "No maker set up here",
      settings.questions > 0 ? `${settings.questions} question${settings.questions === 1 ? "" : "s"}` : "Questions fit the brief",
      settings.difficulty === "auto" ? "difficulty from the brief" : `${DIFFICULTY_OPTIONS[settings.difficulty].label.toLowerCase()} questions`,
      `pass at ${settings.passMark}%`,
      ...sittingLines(settings),
    ],
    describeMade: (quiz, settings) => {
      const count = Array.isArray(quiz?.questions) ? quiz.questions.length : 0;
      const planned = settings.questions > 0 && settings.questions !== count ? ` of ${settings.questions} planned` : "";
      return [
        makers.labelFor(settings) ?? "Made",
        `${count} question${count === 1 ? "" : "s"}${planned}`,
        settings.difficulty === "auto" ? "difficulty from the brief" : `${DIFFICULTY_OPTIONS[settings.difficulty].label.toLowerCase()} questions`,
        `pass at ${settings.passMark}%`,
        ...sittingLines(settings),
      ];
    },
    glimpse: quizGlimpse,
    size: (quiz) => countSize(Array.isArray(quiz?.questions) ? quiz.questions.length : 0, "question", "questions"),
    describeAnchor: quizAnchor(kinds),
  };
}

/** The time limit and the format to follow, in words, when they are set. */
function sittingLines(settings: QuizSettings): string[] {
  return [
    ...(settings.timeLimit ? [`${settings.timeLimit} minutes`] : []),
    ...(settings.layout?.trim() ? ["in the real paper's format"] : []),
  ];
}

/** A quiz's glimpse: its first question. */
export function quizGlimpse(quiz: QuizPayload): Glimpse | undefined {
  const first = Array.isArray(quiz?.questions) ? quiz.questions[0] : undefined;
  const text = plainLine(typeof first?.prompt === "string" ? first.prompt : undefined);
  return text ? { text } : undefined;
}

export function parseQuizSettings(raw: unknown, kinds: QuestionKindRegistry = createDefaultQuestionKinds()): SettingsResult<QuizSettings> {
  const settings = defaultQuizSettings(kinds);
  if (raw === undefined || raw === null) return { ok: true, settings };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, issues: [issue("$", "type", "Settings must be an object")] };
  const record = raw as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (!(key in settings) && key !== "maker" && !AGENT_SETTING_KEYS.includes(key)) issues.push(issue(`$.${key}`, "unknown_key", `Unknown setting "${key}"`));
  }

  if (record.questions !== undefined) {
    const value = record.questions;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_QUESTIONS) settings.questions = value;
    else issues.push(issue("$.questions", "range", `questions must be a whole number from 0 to ${MAX_QUESTIONS}`));
  }
  if (record.kinds !== undefined) {
    const value = record.kinds;
    if (!Array.isArray(value) || value.length === 0) {
      issues.push(issue("$.kinds", "type", "kinds must be a non-empty list of question kinds"));
    } else {
      const unknown = value.filter((kind) => typeof kind !== "string" || !kinds.get(kind));
      if (unknown.length > 0) issues.push(issue("$.kinds", "enum", `kinds must be among ${kinds.ids().join(", ")}`));
      else settings.kinds = [...new Set(value as string[])];
    }
  }
  if (record.difficulty !== undefined) {
    if (typeof record.difficulty === "string" && (DIFFICULTIES as readonly string[]).includes(record.difficulty)) settings.difficulty = record.difficulty as Difficulty;
    else issues.push(issue("$.difficulty", "enum", `difficulty must be one of ${DIFFICULTIES.join(", ")}`));
  }
  if (record.passMark !== undefined) {
    const value = record.passMark;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) settings.passMark = value;
    else issues.push(issue("$.passMark", "range", "passMark must be a number from 0 to 100"));
  }
  if (record.feedback !== undefined) {
    if (typeof record.feedback === "string" && (FEEDBACK_TIMINGS as readonly string[]).includes(record.feedback)) settings.feedback = record.feedback as FeedbackTiming;
    else issues.push(issue("$.feedback", "enum", `feedback must be one of ${FEEDBACK_TIMINGS.join(", ")}`));
  }
  if (record.timeLimit !== undefined) {
    const value = record.timeLimit;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_TIME_LIMIT) settings.timeLimit = value;
    else issues.push(issue("$.timeLimit", "range", `timeLimit must be a whole number of minutes from 0 to ${MAX_TIME_LIMIT}`));
  }
  if (record.layout !== undefined) {
    const value = record.layout;
    if (typeof value === "string" && value.length <= MAX_LAYOUT) settings.layout = value.trim();
    else issues.push(issue("$.layout", "length", `layout must be text of at most ${MAX_LAYOUT} characters`));
  }
  // A maker is checked by shape only: one not set up here now is said before Start and when the item runs.
  const maker = parseMakerSetting(record.maker);
  if (!maker.ok) issues.push(issue("$.maker", "format", maker.message));
  else if (maker.maker) settings.maker = maker.maker;
  Object.assign(settings, readAgentFields(record, issues));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, settings };
}

/**
 * Rough, before-the-fact cost: one planning call reading every passage (or,
 * for a long source, a spread of them up to its budget), then
 * per batch of questions one writing call and one review call reading only
 * the passages they test, and one repair round on a share of the questions.
 * With length left to the brief, the count is guessed from the size of the
 * sources. The real number comes from the usage log.
 */
export function estimateQuizCost(input: CostEstimateInput<QuizSettings>, price: ModelPrice | undefined): CostEstimate {
  if (input.sourceCount === 0 || input.sourceChars === 0) return { usd: 0, basis: "no source text to ask about" };
  const questions = input.settings.questions || guessedCount(input.sourceChars);
  const batches = Math.ceil(questions / QUESTIONS_PER_CALL);
  const repairs = Math.ceil(questions * REPAIR_SHARE);
  const sourceTokens = Math.ceil(input.sourceChars / CHARS_PER_TOKEN);
  const perBatchSource = Math.min(sourceTokens, QUESTIONS_PER_CALL * PASSAGE_TOKENS);
  const calls = 1 + batches * 2 + repairs;
  // The plan reads every passage up to its budget, then a spread across them.
  const planTokens = Math.ceil(Math.min(input.sourceChars, DEFAULT_MAX_PLAN_CHARS) / CHARS_PER_TOKEN);
  const tokensIn = planTokens + PROMPT_TOKENS + batches * 2 * (perBatchSource + PROMPT_TOKENS) + repairs * (PASSAGE_TOKENS + PROMPT_TOKENS);
  const tokensOut = PLAN_TOKENS_PER_QUESTION * questions + QUESTION_TOKENS * questions + REVIEW_TOKENS_PER_QUESTION * questions + QUESTION_TOKENS * repairs;
  const count = input.settings.questions ? `${questions} questions` : `~${questions} questions (length from the brief)`;
  return {
    ...(price ? { usd: round((tokensIn * price.inputPerMillion + tokensOut * price.outputPerMillion) / 1_000_000) } : { unpriced: true }),
    basis: `${count}, ~${calls} calls, ~${formatThousands(tokensIn + tokensOut)} tokens${price ? "" : ", no model price set"}` };
}

/*
 * Sizes per question, from the first real run (Nov 12, 2026,
 * deepseek-v4-flash): planning wrote 300 to 650 tokens per question, and a
 * write or review batch about 1,500 per question between them (output counts
 * the model's thinking). An 8-question quiz cost $0.031, a 14-question one
 * $0.035. Typical shapes, not limits.
 */
const CHARS_PER_TOKEN = 4;
const PROMPT_TOKENS = 1_200;
const PASSAGE_TOKENS = 400;
const PLAN_TOKENS_PER_QUESTION = 400;
const QUESTION_TOKENS = 1_200;
const REVIEW_TOKENS_PER_QUESTION = 300;
const REPAIR_SHARE = 0.25;

/** For the estimate only: about one question per two passages, within what one sitting holds. */
function guessedCount(sourceChars: number): number {
  return Math.min(20, Math.max(3, Math.round(sourceChars / 2_400)));
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

function formatThousands(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value);
}
