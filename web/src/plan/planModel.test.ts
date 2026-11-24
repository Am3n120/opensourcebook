import type { FormatDescriptor, Item, PlanView } from "../api/types";
import {
  ancestors,
  briefLine,
  buildStages,
  canEditItems,
  conditionText,
  diffItem,
  fieldValue,
  formatWords,
  stageName,
  timeLeft,
  underwayText,
  inWords,
  joinLabels,
  edgeKindLabel,
  issueFix,
  moveToStage,
  moveWithinStage,
  neighbourLevel,
  resultText,
  runningFor,
  seedRememberedPicks,
  settingsLines,
  newStageLevel,
  parentOptions,
  parseCondition,
  setField,
  visibleFields,
  withBranches,
} from "./planModel";
import { looksLikeMarkdown, parseMarkdown } from "../sources/mdBlocks";

function item(id: string, level: number, ord: number, extra: Partial<Item> = {}): Item {
  return { id, level, ord, type: "bits", title: id, settings: {}, enabled: true, status: "pending", sources: [], done: false, ...extra };
}

// a1 a2 side by side on stage 1; b1 on stage 2 with a branch c1 under it on stage 3, and c2 under c1 on stage 4.
const items = [
  item("a2", 1, 1),
  item("a1", 1, 0),
  item("b1", 2, 0),
  item("c1", 3, 0, { parentId: "b1", condition: { kind: "metric", metric: "score", below: 0.7 } }),
  item("d1", 3, 1),
  item("c2", 4, 0, { parentId: "c1" }),
];

describe("buildStages", () => {
  test("groups by level in run order, with labels and stage numbers", () => {
    const stages = buildStages(items, [{ level: 2, label: "Practice" }]);
    expect(stages.map((s) => [s.level, s.number, s.label])).toEqual([
      [1, 1, undefined],
      [2, 2, "Practice"],
      [3, 3, undefined],
      [4, 4, undefined],
    ]);
    expect(stages[0]!.rows.map((r) => r.item.id)).toEqual(["a1", "a2"]);
  });

  test("indents branches by how many parents are above them", () => {
    const rows = buildStages(items, []).flatMap((s) => s.rows);
    const depth = Object.fromEntries(rows.map((r) => [r.item.id, r.depth]));
    expect(depth).toEqual({ a1: 0, a2: 0, b1: 0, c1: 1, d1: 0, c2: 2 });
    expect(rows.find((r) => r.item.id === "c1")?.parent?.id).toBe("b1");
  });

  test("a parent loop or a missing parent does not hang", () => {
    const loop = [item("x", 1, 0, { parentId: "y" }), item("y", 2, 0, { parentId: "x" }), item("z", 1, 1, { parentId: "gone" })];
    expect(ancestors(loop, loop[0]!).map((i) => i.id)).toEqual(["y"]);
    expect(ancestors(loop, loop[2]!)).toEqual([]);
  });
});

describe("reordering", () => {
  test("moving within a stage swaps two ords and sends only those", () => {
    expect(moveWithinStage(items, "a2", -1)).toEqual([
      { id: "a2", level: 1, ord: 0 },
      { id: "a1", level: 1, ord: 1 },
    ]);
  });

  test("nothing moves past the ends of a stage", () => {
    expect(moveWithinStage(items, "a1", -1)).toEqual([]);
    expect(moveWithinStage(items, "b1", 1)).toEqual([]);
  });

  test("moving to another stage appends it there and closes the gap behind", () => {
    expect(moveToStage(items, "a1", 2)).toEqual([
      { id: "a2", level: 1, ord: 0 },
      { id: "a1", level: 2, ord: 1 },
    ]);
  });

  test("ords that were not contiguous are renumbered", () => {
    const gappy = [item("p", 1, 5), item("q", 1, 9)];
    expect(moveWithinStage(gappy, "q", -1)).toEqual([
      { id: "q", level: 1, ord: 0 },
      { id: "p", level: 1, ord: 1 },
    ]);
  });

  test("earlier and later go to the neighbouring stage, or a new one at the ends", () => {
    expect(neighbourLevel(items, "b1", -1)).toBe(1);
    expect(neighbourLevel(items, "b1", 1)).toBe(3);
    expect(neighbourLevel(items, "a1", -1)).toBe(0);
    expect(neighbourLevel(items, "c2", 1)).toBeUndefined();
    expect(newStageLevel(items)).toBe(5);
    expect(newStageLevel([])).toBe(1);
  });
});

describe("branches and removal", () => {
  test("removing an item takes its branches with it", () => {
    expect(withBranches(items, "b1").map((i) => i.id)).toEqual(["b1", "c1", "c2"]);
  });

  test("a branch may hang only under a lower stage, never under itself or its own branches", () => {
    expect(parentOptions(items, items.find((i) => i.id === "c1")!).map((i) => i.id)).toEqual(["a1", "a2", "b1"]);
    expect(parentOptions(items, { level: 2 }).map((i) => i.id)).toEqual(["a1", "a2"]);
  });

  test("conditions read as words; an unknown kind shows its fields", () => {
    expect(conditionText({ kind: "metric", metric: "score", below: 0.7 }, "Check 1")).toBe("If you score under 70% on “Check 1”");
    expect(conditionText({ kind: "metric", metric: "score", atLeast: 0.9 })).toBe("If you score 90% or more");
    expect(conditionText({ kind: "metric", metric: "time", below: 30 })).toBe("If time is below 30");
    expect(conditionText({ kind: "ask", question: "More practice?" })).toBe("Ask me: More practice?");
    expect(conditionText({ kind: "mood", is: "tired" }, "Read")).toBe('If mood (is "tired") on “Read”');
  });

  test("the condition editor takes JSON with a kind, or nothing", () => {
    expect(parseCondition("")).toEqual({ ok: true, condition: null });
    expect(parseCondition('{"kind":"ask"}')).toEqual({ ok: true, condition: { kind: "ask" } });
    expect(parseCondition("{nope").ok).toBe(false);
    expect(parseCondition('{"metric":"score"}').ok).toBe(false);
    expect(parseCondition("[1]").ok).toBe(false);
  });
});

describe("settings from the descriptor", () => {
  const format: FormatDescriptor = {
    id: "x",
    label: "x",
    colorSlot: 1,
    icon: "doc",
    ready: true,
    settings: [
      { key: "length", label: "Length", kind: "number", min: 0 },
      { key: "internal", label: "Internal", kind: "text", hidden: true },
      { key: "future", label: "Future", kind: "colourWheel" } as never,
    ],
    defaults: { length: 10 },
  };

  test("shows only visible fields of kinds it can draw", () => {
    expect(visibleFields(format).map((f) => f.key)).toEqual(["length"]);
  });

  test("shows and reads a field only while the setting it depends on holds one of its values, its default counting", () => {
    const video: FormatDescriptor = {
      ...format,
      settings: [
        { key: "maker", label: "Maker", kind: "choice", options: [{ value: "auto", label: "Whichever is ready" }, { value: "a", label: "Plain" }, { value: "b", label: "Drawn" }] },
        { key: "style", label: "Style", kind: "choice", showWhen: { key: "maker", in: ["b"] }, options: [{ value: "auto", label: "Maker's pick" }, { value: "ink", label: "Ink" }] },
      ],
      defaults: { maker: "auto", style: "auto" },
    };
    expect(visibleFields(video, {}).map((f) => f.key)).toEqual(["maker"]);
    expect(visibleFields(video, { maker: "b" }).map((f) => f.key)).toEqual(["maker", "style"]);
    // Without the item's settings (a list of what a format has), every field is there.
    expect(visibleFields(video).map((f) => f.key)).toEqual(["maker", "style"]);
    expect(settingsLines(video, { maker: "a", style: "ink" })).toEqual([{ label: "Maker", text: "Plain" }]);
    expect(settingsLines(video, { maker: "b", style: "ink" })).toEqual([
      { label: "Maker", text: "Drawn" },
      { label: "Style", text: "Ink" },
    ]);
    expect(settingsLines({ ...video, defaults: { maker: "b", style: "auto" } }, {})).toEqual([
      { label: "Maker", text: "Drawn" },
      { label: "Style", text: "Maker's pick" },
    ]);
  });

  test("says how long a running item has been at it, from its first full minute", () => {
    const start = "2026-11-15T10:00:00.000Z";
    expect(runningFor(start, Date.parse(start) + 59_000)).toBe("");
    expect(runningFor(start, Date.parse(start) + 4 * 60_000 + 10_000)).toBe(" · 4 min so far");
    expect(runningFor(undefined)).toBe("");
  });

  test("reads the item's value, else the default; a default value is not stored", () => {
    expect(fieldValue(format, {}, "length")).toBe(10);
    expect(setField(format, {}, "length", 12)).toEqual({ length: 12 });
    expect(setField(format, { length: 12 }, "length", 10)).toEqual({});
  });
});

test("item edits are allowed only before Start", () => {
  expect(["draft", "approved", "running", "done", "failed", "cancelled"].filter((s) => canEditItems(s as never))).toEqual(["draft", "approved"]);
});

test("diffItem sends only changed fields", () => {
  expect(diffItem({ a: 1, b: { c: 1 }, d: "x" }, { a: 1, b: { c: 2 }, d: "y" })).toEqual({ b: { c: 2 }, d: "y" });
});

describe("row state", () => {
  test("before Start an item is planned, a branch if needed, an unchecked one left out", async () => {
    const { rowState } = await import("./planModel");
    expect(rowState(item("a", 1, 0), false).text).toBe("planned");
    expect(rowState(item("c", 2, 0, { parentId: "a" }), false)).toMatchObject({ text: "if needed", filter: "if" });
    expect(rowState(item("x", 1, 0, { enabled: false }), false).text).toBe("left out");
  });

  test("after Start the row follows the item's status and done tick", async () => {
    const { rowState } = await import("./planModel");
    expect(rowState(item("a", 1, 0, { status: "done" }), true).text).toBe("ready");
    expect(rowState(item("a", 1, 0, { status: "done", done: true }), true).text).toBe("done");
    expect(rowState(item("a", 1, 0, { status: "running" }), true)).toMatchObject({ tone: "gen", filter: "gen" });
    expect(rowState(item("c", 2, 0, { parentId: "a", asking: {} }), true).text).toBe("asking you");
  });
});

describe("the brief on the card", () => {
  it("is the brief's first sentence; the rest is for the engine", () => {
    expect(briefLine("Lets you compute attention by hand. Cover the formula, then do not repeat the intro.")).toBe("Lets you compute attention by hand.");
    expect(briefLine("[setup]\nOne line only")).toBe("One line only");
    expect(briefLine("Was ist Aufmerksamkeit? Danach die Formel.")).toBe("Was ist Aufmerksamkeit?");
    expect(briefLine(undefined)).toBe("");
  });
});

describe("settings in words", () => {
  // Shaped like the engine's quiz descriptor; the test reads only what a descriptor gives.
  const quiz: FormatDescriptor = {
    id: "quiz", label: "quiz", colorSlot: 3, icon: "check", ready: true,
    settings: [
      { key: "questions", label: "Questions", help: "How many.", kind: "number", min: 0, max: 80, specialValues: [{ value: 0, label: "Fit to the brief", description: "The brief and the sources decide how many questions." }] },
      {
        key: "kinds", label: "Question kinds", help: "Which kinds of question it may use.", kind: "choices", minItems: 1,
        options: [
          { value: "choice", label: "Multiple choice", description: "Pick the one right answer." },
          { value: "worked", label: "Worked, step-checked", description: "Work a problem through in steps." },
        ],
      },
      { key: "passMark", label: "Pass mark", kind: "number", unit: "%" },
      { key: "minutes", label: "Length", kind: "number", unit: "min" },
      { key: "notes", label: "Notes", help: "Anything (for example) to add.", kind: "textList" },
      { key: "depth", label: "Depth", kind: "choice", options: [{ value: "auto", label: "Auto", description: "Sized to the sources." }] },
    ],
    defaults: { questions: 0, kinds: ["choice", "worked"], passMark: 70, minutes: 5, notes: [], depth: "auto" },
  };
  test("reads labels and meanings from the descriptor, never codes", () => {
    expect(settingsLines(quiz, {})).toEqual([
      { label: "Questions", text: "Fit to the brief" },
      { label: "Question kinds", text: "Multiple choice and worked, step-checked" },
      { label: "Pass mark", text: "70%" },
      { label: "Length", text: "5 min" },
      { label: "Depth", text: "Auto" },
    ]);
    expect(settingsLines(quiz, { questions: 12, kinds: ["worked"] }).slice(0, 2)).toEqual([
      { label: "Questions", text: "12" },
      { label: "Question kinds", text: "Worked, step-checked" },
    ]);
  });
  test("a free list shows what was typed; a code no option offers any more still shows", () => {
    expect(settingsLines(quiz, { notes: ["Keep it short", "(for example) wins"], kinds: ["choice", "saveOnly"] }).filter((l) => l.label === "Notes" || l.label === "Question kinds")).toEqual([
      { label: "Question kinds", text: "Multiple choice and saveOnly" },
      { label: "Notes", text: "Keep it short and (for example) wins" },
    ]);
  });
  test("a number's help is never read for meaning: without special values, 0 is just 0", () => {
    const plain = { ...quiz, settings: [{ key: "questions", label: "Questions", help: "How many. 0 lets the brief and the sources decide.", kind: "number" as const, min: 0 }] };
    expect(settingsLines(plain, { questions: 0 })).toEqual([{ label: "Questions", text: "0" }]);
  });
  test("labels join into one phrase; a later one goes lower case unless it starts with a capitalised code", () => {
    expect(joinLabels(["Multiple choice", "Worked, step-checked"])).toBe("Multiple choice and worked, step-checked");
    expect(joinLabels(["Light", "PDF pages", "Deep"])).toBe("Light, PDF pages, and deep");
  });
  test("a link between items reads the engine's label; a kind it does not list reads in words", () => {
    const kinds = [{ id: "assumes", label: "Builds on", about: "May rely on it." }];
    expect(edgeKindLabel(kinds, "assumes")).toBe("Builds on");
    expect(edgeKindLabel(kinds, "fix_of")).toBe("Fix of");
  });
  test("issue fixes are picked by code, never by the words", () => {
    expect(issueFix("no_sources")).toEqual({ label: "Pick sources", toSources: true });
    expect(issueFix("format_not_ready").label).toBe("Change format");
    expect(issueFix("something_new").label).toBe("Edit");
  });
  test("codes and results read in words", () => {
    expect(inWords("fix_of")).toBe("fix of");
    expect(inWords("assumesThat")).toBe("assumes that");
  });
  test("a result reads in the format's words: its labels, in its order, a share as a percentage", () => {
    const reports = [
      { metric: "score", label: "Score", unit: "share" },
      { metric: "correct", label: "Right answers", unit: "count" },
      { metric: "answered", label: "Questions answered", unit: "count" },
    ];
    expect(resultText({ answered: 2, score: 0.5, correct: 1, format: "quiz", version: 1 }, { ...quiz, reports })).toBe("Score 50% · Right answers 1 · Questions answered 2");
    expect(resultText({ score: 1 }, { ...quiz, reports })).toBe("Score 100%");
    // Without words from the engine, nothing is shown rather than codes.
    expect(resultText({ score: 0.5 }, { ...quiz, reports: undefined })).toBeUndefined();
    expect(resultText({ score: 0.5 })).toBeUndefined();
  });
});

describe("Markdown sources", () => {
  test("blocks keep the span they came from", () => {
    const text = "# Title\n\nOne **bold** line\nand more.\n\n- a\n- b\n\n> said\n\n```\ncode\n```";
    const blocks = parseMarkdown(text);
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "list", "quote", "code"]);
    expect(blocks[1]).toMatchObject({ kind: "paragraph", text: "One **bold** line and more." });
    expect(text.slice(blocks[1]!.start, blocks[1]!.end)).toBe("One **bold** line\nand more.");
    expect(blocks[2]).toMatchObject({ items: ["a", "b"], ordered: false });
    expect(blocks[4]).toMatchObject({ text: "code" });
  });
  test("a source is Markdown when named so, or text with headings", () => {
    expect(looksLikeMarkdown("cells.md", "unknown", "plain")).toBe(true);
    expect(looksLikeMarkdown("Notes", "text", "## Part 1\nx")).toBe(true);
    expect(looksLikeMarkdown("Page", "web", "## Part 1\nx")).toBe(false);
    expect(looksLikeMarkdown("Notes", "text", "#hashtag only")).toBe(false);
  });
});

describe("a started plan, in words", () => {
  const at = Date.parse("2026-11-18T10:00:00.000Z");
  const ago = (s: number) => new Date(at - s * 1000).toISOString();
  const view = (status: string, items: Item[]) => ({ plan: { id: "p", projectId: "x", version: 1, status, kickedOffAt: ago(600), createdAt: ago(900), updatedAt: ago(1) }, items, stages: [], edges: [], counts: { total: items.length, done: 0 } }) as unknown as PlanView;

  test("says how long is left only once the maker's progress and the time spent can tell", () => {
    expect(timeLeft({ progress: 0.05, startedAt: ago(60) }, at)).toBeUndefined();
    expect(timeLeft({ progress: 0.5, startedAt: ago(5) }, at)).toBeUndefined();
    expect(timeLeft({ progress: 0.5, startedAt: ago(20) }, at)).toBe("almost done");
    expect(timeLeft({ progress: 0.5, startedAt: ago(60) }, at)).toBe("about a minute left");
    expect(timeLeft({ progress: 0.25, startedAt: ago(120) }, at)).toBe("about 6 minutes left");
    expect(timeLeft(undefined, at)).toBeUndefined();
  });

  test("takes the maker's own word on when it is done first, and shows no number when it cannot know", () => {
    const later = (seconds: number) => new Date(at + seconds * 1000).toISOString();
    // Progress alone would say about 6 minutes; the maker, from what this computer did before, says 10.
    expect(timeLeft({ progress: 0.25, startedAt: ago(120), doneBy: later(600) }, at)).toBe("about 10 minutes left");
    expect(timeLeft({ progress: 0.25, startedAt: ago(120), doneBy: later(30) }, at)).toBe("almost done");
    // Past what it expected, or it cannot know: no number, however far the progress is.
    expect(timeLeft({ progress: 0.25, startedAt: ago(120), doneBy: later(-60) }, at)).toBeUndefined();
    expect(timeLeft({ progress: 0.25, startedAt: ago(120), leftUnknown: true }, at)).toBeUndefined();
  });

  test("says where a plan is once it has started, and nothing before", () => {
    const making = item("a", 1, 0, { title: "The loop", status: "running", job: { id: "j", status: "running", stage: "writing", progress: 0.5, startedAt: ago(60), attempt: 1 } });
    const made = item("b", 2, 0, { status: "done", outputId: "o1" });
    expect(underwayText(view("running", [made, making]), at)).toBe("Started: 1 of 2 made so far. Making “The loop” now, about a minute left.");
    expect(underwayText(view("done", [made]), at)).toBe("All made. Press Play to go through it.");
    expect(underwayText(view("cancelled", [made, making]), at)).toMatch(/^Stopped with 1 of 2 made/);
    const draft = view("draft", [made]);
    expect(underwayText({ ...draft, plan: { ...draft.plan, kickedOffAt: undefined } } as unknown as PlanView, at)).toBeUndefined();
  });
});

describe("stageName", () => {
  test("a short plan says its order in plain words; a long one numbers; a label always wins", () => {
    expect(stageName({ number: 1 }, 1)).toBe("To make");
    expect([1, 2, 3].map((number) => stageName({ number }, 3))).toEqual(["First", "Then", "Then"]);
    expect(stageName({ number: 4 }, 6)).toBe("Stage 4");
    expect(stageName({ number: 1, label: "Warm-up" }, 2)).toBe("Warm-up");
  });
});

describe("formatWords", () => {
  const formats = [
    { id: "flashcards", label: "flashcards", colorSlot: 2, icon: "feed", aliases: ["bits", "byte"], blurb: "cards to swipe and flip, brought back until they stick", settings: [], defaults: {}, ready: true },
    { id: "quiz", label: "quiz", colorSlot: 3, icon: "check", settings: [], defaults: {}, ready: true },
  ] as FormatDescriptor[];

  test("names each format a plan makes once, in plan order, with its descriptor's own few words", () => {
    const items = [item("a", 1, 0), item("b", 2, 0, { type: "byte" }), item("c", 3, 0, { type: "quiz" })];
    expect(formatWords(items, formats)).toEqual([{ label: "flashcards", blurb: "cards to swipe and flip, brought back until they stick" }]);
  });

  test("leaves out what is not in the plan", () => {
    expect(formatWords([item("a", 1, 0, { enabled: false })], formats)).toEqual([]);
  });
});

describe("agent setting fields and remembered picks", () => {
  const format: FormatDescriptor = {
    id: "explainer",
    label: "explainer",
    colorSlot: 1,
    icon: "play",
    ready: true,
    settings: [{ key: "agent", label: "Agent & model", kind: "agent", effortKey: "effort", turnKind: "work" }],
    defaults: {},
  };

  test("formats agent, model, and effort cleanly in settingsLines and seeds remembered picks", () => {
    expect(settingsLines(format, { agent: "agent:claude:sonnet", effort: "high" })).toEqual([
      { label: "Agent & model", text: "claude (sonnet, high effort)" },
    ]);
    expect(settingsLines(format, { agent: "agent:codex", effort: "high" })).toEqual([
      { label: "Agent & model", text: "codex (high effort)" },
    ]);
    expect(settingsLines(format, { agent: "auto" })).toEqual([{ label: "Agent & model", text: "Default" }]);
    expect(seedRememberedPicks(format, { explainer: { agent: "claude", model: "opus", effort: "max" } })).toEqual({
      agent: "agent:claude:opus",
      effort: "max",
    });
  });
});
