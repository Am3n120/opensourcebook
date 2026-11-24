import { describe, expect, it } from "vitest";
import { parseFlashcardSettings } from "../src/engines/flashcards/definition";
import { createDefaultQuestionKinds } from "../src/engines/quiz/default-kinds";
import { choiceKind } from "../src/engines/quiz/kinds";
import { parseQuizSettings, quizDescriptor } from "../src/engines/quiz/definition";
import { parseVideoSettings } from "../src/engines/video/definition";
import { handleRequest } from "../src/index";
import { createDefaultRegistry } from "../src/studio/default-registry";
import { METRIC_UNITS, type ReportedMetric, type SettingField } from "../src/studio/types";
import { ScenesClient } from "../src/engines/video/scenes/client";
import { createScenesMaker } from "../src/engines/video/scenes/maker";
import { authed, createTestEngine } from "./support/engine-harness";
import { FakeScenesService } from "./support/fake-scenes";

const scenes = new FakeScenesService();
/** Video made here by its real maker, over a fake scenes service. */
const videoMade = { makers: [createScenesMaker({ client: new ScenesClient({ url: "http://127.0.0.1:8660", token: scenes.token }, scenes.fetch) })] };

async function servedFormats(registry = createDefaultRegistry()) {
  const engine = createTestEngine({ registry });
  const response = await handleRequest(authed("/v1/formats"), engine.deps);
  expect(response.status).toBe(200);
  return ((await response.json()) as { formats: Array<{ id: string; ready: boolean; about?: string; settings: SettingField[]; defaults: Record<string, unknown> }> }).formats;
}

describe("GET /v1/formats", () => {
  it("serves every descriptor in registration order, marking which can be made now", async () => {
    const engine = createTestEngine({ registry: createDefaultRegistry() });
    const response = await handleRequest(authed("/v1/formats"), engine.deps);
    expect(response.status).toBe(200);
    const { formats } = (await response.json()) as { formats: Array<Record<string, unknown>> };
    // The owner's order, everywhere the app lists the shapes: video, flashcards, quiz, audio, guide.
    expect(formats.map((format) => [format.id, format.ready])).toEqual([
      ["video", false],
      ["flashcards", true],
      ["quiz", true],
      ["audio", false],
      ["guide", false],
    ]);
    expect(formats[3]!.problem).toEqual(expect.any(String));
    expect(formats[0]).toMatchObject({ id: "video", label: "video", settings: [], defaults: {} });
    expect(formats[1]).toMatchObject({
      id: "flashcards",
      label: "flashcards",
      colorSlot: 2,
      icon: "feed",
      aliases: ["byte", "bits", "read", "cards"],
      defaults: { cards: 0, kinds: ["recall", "cloze", "compare", "steps", "formula", "worked", "picture", "ask", "explain"], exemplarSummaries: [] },
    });
    expect((formats[1].settings as Array<{ key: string }>).map((field) => field.key)).toEqual(["cards", "kinds", "exemplarSummaries"]);
    expect(formats[2]).toMatchObject({
      id: "quiz",
      label: "quiz",
      colorSlot: 3,
      icon: "check",
      aliases: ["check"],
      defaults: { questions: 0, kinds: ["choice", "worked", "order", "match", "complete", "graph", "label"], difficulty: "auto", passMark: 70, feedback: "afterEach", timeLimit: 0, layout: "" },
    });
    expect((formats[2].settings as Array<{ key: string }>).map((field) => field.key)).toEqual(["questions", "kinds", "difficulty", "passMark", "feedback", "timeLimit", "layout"]);
    expect(formats[4]).toMatchObject({ id: "guide", label: "guide", colorSlot: 5, icon: "book", defaults: { pages: 0 } });
  });

  it("keeps the same order when video has a maker", async () => {
    const formats = await servedFormats(createDefaultRegistry({ video: videoMade }));
    expect(formats.map((format) => format.id)).toEqual(["video", "flashcards", "quiz", "audio", "guide"]);
  });

  it("gives every format a few plain words on what it is, for a person meeting the word", async () => {
    const served = (await servedFormats(createDefaultRegistry({ video: videoMade }))) as Array<{ id: string; blurb?: string }>;
    for (const format of served) {
      expect(format.blurb, format.id).toBeTruthy();
      // A few words, not the planner's paragraph.
      expect(format.blurb!.split(/\s+/).length, format.id).toBeLessThanOrEqual(10);
    }
    expect(served.find((f) => f.id === "flashcards")?.blurb).toMatch(/swipe and flip/);
  });

  it("serves question kinds as a multi-pick, each kind in its own words from the kind registry", async () => {
    const quiz = (await servedFormats()).find((format) => format.id === "quiz")!;
    expect(quiz.settings.find((field) => field.key === "kinds")).toEqual({
      key: "kinds",
      label: "Question kinds",
      help: "Which kinds of question it may use.",
      kind: "choices",
      options: [
        { value: "choice", label: "Multiple choice", description: "Pick the one right answer from a few options." },
        { value: "worked", label: "Worked, step-checked", description: "Work a problem through in steps; each step is checked, with a hint to reveal." },
        { value: "order", label: "Put in order", description: "Arrange a few things into the order the source gives them: stages, events, steps or sizes." },
        { value: "match", label: "Match pairs", description: "Match each thing on the left to the one it goes with on the right." },
        { value: "complete", label: "Fill in the working", description: "A worked solution shown line by line, with a few parts left to type in." },
        { value: "graph", label: "Draw a line on a graph", description: "Draw a straight line on a grid by placing two points on it." },
        { value: "label", label: "Label a picture", description: "Name the marked parts of a picture from the source." },
      ],
      minItems: 1,
      maxItems: 7,
    });
  });

  it("gives every option of every setting of every ready format a label and a one-line description", async () => {
    for (const registry of [createDefaultRegistry(), createDefaultRegistry({ video: videoMade })]) {
      const formats = await servedFormats(registry);
      const picks = formats.filter((format) => format.ready).flatMap((format) => format.settings.filter((field) => field.kind === "choice" || field.kind === "choices").map((field) => ({ format, field })));
      // Kinds of card, quiz kinds, difficulty and feedback; video's shape when video can be made.
      expect(picks.length).toBeGreaterThanOrEqual(4);
      for (const { format, field } of picks) {
        if (field.kind !== "choice" && field.kind !== "choices") continue;
        expect(field.options.length, `${format.id}.${field.key}`).toBeGreaterThan(0);
        for (const option of field.options) {
          const where = `${format.id}.${field.key}.${option.value}`;
          expect(option.label.trim(), where).not.toBe("");
          expect(option.description.trim(), where).not.toBe("");
          expect(option.description, where).not.toContain("\n");
          // Words, not the stored code, in sentence case like every other label.
          expect(option.label, where).not.toBe(option.value);
          expect(option.label.charAt(0), where).toBe(option.label.charAt(0).toUpperCase());
        }
        // Defaults are among the options.
        const fallback = format.defaults[field.key];
        const values = field.options.map((option) => option.value);
        for (const value of Array.isArray(fallback) ? fallback : [fallback]) expect(values, `${format.id}.${field.key}`).toContain(value);
      }
    }
    const video = (await servedFormats(createDefaultRegistry({ video: videoMade }))).find((format) => format.id === "video")!;
    expect(video.settings.find((field) => field.key === "aspect")).toMatchObject({ kind: "choice", options: [{ value: "portrait", label: "Portrait (9:16)" }, {}, {}] });
  });

  it("says in data which number values mean something other than the number", async () => {
    const formats = await servedFormats(createDefaultRegistry({ video: videoMade }));
    const special = formats.flatMap((format) =>
      format.settings.flatMap((field) => (field.kind === "number" && field.specialValues ? [[`${format.id}.${field.key}`, field.specialValues] as const] : [])),
    );
    expect(special).toEqual([
      ["video.minutes", [{ value: 0, means: "auto", label: "Fit to the brief", description: "Timed when it is made, as long as the brief and the sources need." }]],
      ["flashcards.cards", [{ value: 0, means: "auto", label: "Fit to the sources", description: "Counted when it is made: as many cards as the sources hold things worth remembering." }]],
      ["quiz.questions", [{ value: 0, means: "auto", label: "Fit to the brief", description: "Counted when it is made, from the brief and the sources." }]],
      ["quiz.timeLimit", [{ value: 0, means: "none", label: "No time limit", description: "Take as long as you need." }]],
      ["audio.minutes", [{ value: 0, means: "auto", label: "Fit to the brief", description: "Timed when it is written, as long as the brief and the sources need." }]],
      ["guide.pages", [{ value: 0, means: "auto", label: "Fit to the brief", description: "Sized when it is written, as long as the brief and the sources need." }]],
    ]);
    // Each special value is a value the setting accepts, and the planner reads what it means.
    expect(parseQuizSettings({ questions: 0 }).ok).toBe(true);
    expect(parseVideoSettings({ minutes: 0 }).ok).toBe(true);
  });

  it("names every number a format reports in words, with how to show it", async () => {
    const formats = (await servedFormats(createDefaultRegistry({ video: videoMade }))) as unknown as Array<{ id: string; reports?: ReportedMetric[] }>;
    for (const format of formats) {
      for (const report of format.reports ?? []) {
        const where = `${format.id}.${report.metric}`;
        expect(report.label.trim(), where).not.toBe("");
        expect(report.label, where).not.toBe(report.metric);
        expect(report.label.charAt(0), where).toBe(report.label.charAt(0).toUpperCase());
        if (report.unit !== undefined) expect(METRIC_UNITS, where).toContain(report.unit);
      }
    }
    expect(formats.find((format) => format.id === "quiz")?.reports).toEqual([
      { metric: "score", label: "Score", about: "share of the points earned, 0 to 1", unit: "share" },
      { metric: "correct", label: "Right answers", about: "how many questions were answered right", unit: "count" },
      { metric: "answered", label: "Questions answered", about: "how many questions were answered", unit: "count" },
    ]);
  });

  it("keeps each setting's help to what the data does not already say", async () => {
    const formats = await servedFormats(createDefaultRegistry({ video: videoMade }));
    for (const format of formats) {
      for (const field of format.settings) {
        if (!field.help) continue;
        const where = `${format.id}.${field.key}`;
        // A special value's meaning is in its description, an option's in its own words.
        const named = (words: string) => new RegExp(`(^|\\W)${words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`, "i");
        if (field.kind === "number") for (const special of field.specialValues ?? []) for (const words of [String(special.value), special.label]) expect(field.help, where).not.toMatch(named(words));
        if (field.kind === "choice" || field.kind === "choices") for (const option of field.options) expect(field.help, where).not.toMatch(named(option.label));
      }
    }
    const quiz = formats.find((format) => format.id === "quiz")!;
    const video = formats.find((format) => format.id === "video")!;
    expect(quiz.settings.find((field) => field.key === "questions")?.help).toBe("How many questions it asks, which is how far it goes: a few for a quick check, many for an exam-like run.");
    expect(video.settings.find((field) => field.key === "minutes")?.help).toBe("Target length in minutes, which is how far it goes: under a minute for one idea, ten or more for a thorough lesson.");
  });

  it("says what each shape is for and that its own settings set how far it goes, so depth is never one shape's", async () => {
    const formats = await servedFormats(createDefaultRegistry({ video: videoMade }));
    for (const format of formats.filter((candidate) => candidate.ready)) {
      expect(format.about, format.id).toMatch(/\bSuits\b/);
      expect(format.about, format.id).toMatch(/how far it goes/);
      // The setting that sets it says so in its own help.
      expect(format.settings.some((field) => /how far it goes/.test(field.help ?? "")), format.id).toBe(true);
      // No option is called "deep" or "thorough" as if only this shape could be.
      for (const field of format.settings) {
        if (field.kind === "choice" || field.kind === "choices") for (const option of field.options) expect(option.label, `${format.id}.${field.key}`).not.toMatch(/\b(deep|thorough)\b/i);
      }
    }
  });

  it("offers a new question kind as soon as it is registered", () => {
    const kinds = createDefaultQuestionKinds().register({ ...choiceKind, id: "yesNo", label: "Yes or no", description: "Say whether a statement is true." });
    const field = quizDescriptor(kinds).settings.find((candidate) => candidate.key === "kinds");
    expect(field).toMatchObject({ kind: "choices", maxItems: 8 });
    expect(field?.kind === "choices" && field.options.at(-1)).toEqual({ value: "yesNo", label: "Yes or no", description: "Say whether a statement is true." });
    expect(parseQuizSettings({ kinds: ["yesNo"] }, kinds)).toMatchObject({ ok: true, settings: { kinds: ["yesNo"] } });
  });

  it("keeps stored settings as the same codes, parsed as before", () => {
    expect(parseQuizSettings({ kinds: ["worked"], difficulty: "harder", feedback: "atEnd" })).toMatchObject({ ok: true, settings: { kinds: ["worked"], difficulty: "harder", feedback: "atEnd" } });
    expect(parseQuizSettings({ kinds: ["choice", "choice"] })).toMatchObject({ ok: true, settings: { kinds: ["choice"] } });
    expect(parseQuizSettings({ kinds: [] }).ok).toBe(false);
    expect(parseQuizSettings({ kinds: ["multiple choice"] }).ok).toBe(false);
    // An item planned when flashcards were the byte stored a length; it parses as a count of cards.
    expect(parseFlashcardSettings({ depth: "saveOnly" })).toMatchObject({ ok: true, settings: { cards: 0 } });
    expect(parseFlashcardSettings({ depth: "standard" })).toMatchObject({ ok: true, settings: { cards: 20 } });
    expect(parseFlashcardSettings({ cards: 12, depth: "deep" })).toMatchObject({ ok: true, settings: { cards: 12 } });
    expect(parseVideoSettings({ aspect: "square" })).toMatchObject({ ok: true, settings: { aspect: "square" } });
  });

  it("needs the client token", async () => {
    const engine = createTestEngine();
    const response = await handleRequest(new Request("https://engine.test/v1/formats"), engine.deps);
    expect(response.status).toBe(401);
  });
});
