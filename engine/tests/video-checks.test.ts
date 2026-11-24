/**
 * What every video is checked against in code whoever made it, its
 * settings, and what happens to an item or a job that names the storyboard
 * maker Open Sourcebook took out (DECISIONS #69): it is made by the maker Open Sourcebook picks now,
 * never by a stand-in, and an old storyboard video still opens.
 */
import { describe, expect, it } from "vitest";
import { LABEL_CASES } from "../../common/label-cases";
import { checkVideo, keptNotes, keptOver, TRUE_TO_SOURCES, type VideoBlueprint } from "../src/engines/video/checks";
import { RETIRED_VIDEO_MAKERS, parseVideoSettings, videoDefinitionFor } from "../src/engines/video/definition";
import { VideoMakerRegistry } from "../src/engines/video/makers";
import { buildPassages, promptLabelLeaks, type Passage } from "../src/sources/passages";
import { createDefaultRegistry } from "../src/studio/default-registry";
import type { NodeSource } from "../src/studio/types";
import type { SourceEnvelope } from "../src/types";
import type { Scene, Video } from "../src/video/contract";
import { V1, V2 } from "./support/sky-text";

function envelope(text: string): SourceEnvelope {
  return { originalText: text, kind: "text", title: "Sky colour notes", text, references: [], metadata: {}, accessLevel: "full", depthCap: "light", limitations: [], fetchedAt: "2026-11-13T09:00:00.000Z" };
}

const source: NodeSource = {
  sourceId: "src-1",
  envelope: envelope(`${V1}\n\n${V2}`),
  chunks: [
    { id: "chunk-1", ord: 0, text: V1, locator: { charStart: 0, charEnd: V1.length } },
    { id: "chunk-2", ord: 1, text: V2, locator: { charStart: V1.length + 2, charEnd: V1.length + 2 + V2.length } },
  ],
};
const passages = new Map(buildPassages([source]).map((passage) => [passage.id, passage]));

function scene(at: number, overrides: Partial<Scene> = {}): Scene {
  return {
    id: `s${at}`,
    kind: "explain",
    durationMs: 8000,
    visual: { kind: "diagram", description: "Sunlight entering the air, its blue part bouncing off in every direction." },
    narration: "Air scatters the short blue waves much more than the long red ones.",
    onScreenText: ["Blue scatters most"],
    cites: [{ sourceId: "src-1", spot: "passage", chunkId: at === 1 ? "chunk-1" : "chunk-2", quote: at === 1 ? "Air molecules scatter short wavelengths" : "the sky looks red" }],
    ...overrides,
  };
}

const video = (scenes: Scene[]): Video => ({ schemaVersion: 1, title: "Why the sky is blue", idea: "Short waves scatter most.", aspect: { width: 1080, height: 1920 }, scenes });
const shape = (scenes: Scene[], minutes = 0): VideoBlueprint => ({
  title: "",
  idea: "",
  scenes: scenes.map((one) => ({ does: "", kind: one.kind, passageIds: [], seconds: one.durationMs / 1000 })),
  minutes,
  omittedPassages: 0,
});
const codes = (scenes: Scene[], minutes = 0) => checkVideo(video(scenes), shape(scenes, minutes), passages).map((issue) => [issue.path, issue.code, issue.severity]);

describe("video checks", () => {
  it("pass a video whose scenes fit their lengths and quote their passages word for word", () => {
    expect(codes([scene(1), scene(2)])).toEqual([]);
  });

  it("refuse narration that cannot be said in its scene, a quote not in its passage and a passage label the viewer would see", () => {
    const issues = codes([
      scene(1, { durationMs: 2000, narration: "As P1 says, sunlight holds every colour and air scatters the short blue waves far more than the long red ones." }),
      scene(2, { cites: [{ sourceId: "src-1", spot: "passage", chunkId: "chunk-2", quote: "the sky goes purple" }] }),
    ]);
    expect(issues).toEqual(
      expect.arrayContaining([
        ["scenes[0].narration", "too_fast", "error"],
        ["scenes[0].narration", "names_prompt_label", "error"],
        ["scenes[1].cites[0].quote", "quote_not_in_passage", "error"],
      ]),
    );
  });

  it("warn, without refusing, when the length is far from the one asked for", () => {
    expect(codes([scene(1), scene(2)], 2)).toEqual([["$.scenes", "length", "warning"]]);
  });

  it("take a label word used as ordinary vocabulary, and refuse one used as a pointer at the passages or a scene id", () => {
    for (const narration of ["Final passage needs a simple majority.", "The final passage of the bill comes last.", "Light finds a passage through the air.", "The sun is the source of the light.", "A quote from Lincoln opens it."]) {
      expect(codes([scene(1, { narration }), scene(2)])).toEqual([]);
    }
    for (const [narration, leak] of [["As passage 2 says, short waves scatter.", "passage 2"], ["The excerpt above says short waves scatter.", "The excerpt above"], ["As s2 shows, short waves scatter.", "s2"], ["According to the passage, short waves scatter.", "According to the passage"]] as const) {
      const issues = checkVideo(video([scene(1, { narration }), scene(2)]), shape([scene(1), scene(2)]), passages);
      expect(issues).toEqual([expect.objectContaining({ path: "scenes[0].narration", code: "names_prompt_label", severity: "error", message: expect.stringContaining(`"${leak}"`) })]);
    }
  });

  it("do not ask whether words fit a scene whose length was measured from its voice", () => {
    const fast = [scene(1, { durationMs: 2000, narration: "Sunlight holds every colour and air scatters the short blue waves far more than the long red ones." }), scene(2)];
    expect(codes(fast)).toEqual([["scenes[0].narration", "too_fast", "error"]]);
    expect(checkVideo(video(fast), shape(fast), passages, { timedByVoice: true })).toEqual([]);
  });

  it("keep a rendered video over everything but a cite untrue to its sources, and say what was kept over in a line for the person", () => {
    const issues = checkVideo(video([scene(1, { narration: "As passage 2 says, short waves scatter." }), scene(2, { cites: [{ sourceId: "src-1", spot: "passage", chunkId: "chunk-2", quote: "the sky goes purple" }] })]), shape([scene(1), scene(2)]), passages);
    const { issues: settled, kept } = keptOver(issues);
    expect(settled.filter((issue) => issue.severity === "error").map((issue) => issue.code)).toEqual(["quote_not_in_passage"]);
    expect(kept.map((issue) => issue.code)).toEqual(["names_prompt_label"]);
    expect(keptNotes(kept)).toEqual([`Kept as rendered, though Open Sourcebook's checks found: scene 1's narration: names "passage 2", words only the writer saw.`]);
    expect(keptNotes([])).toEqual([]);
    // A quote too long but word for word in its passage is form, not falsehood; one not in its passage stays strict whatever its length.
    const long = "x".repeat(400);
    const tooLong = checkVideo(video([scene(1, { cites: [{ sourceId: "src-1", spot: "passage", chunkId: "chunk-1", quote: long }] }), scene(2)]), shape([scene(1), scene(2)]), passages);
    expect(tooLong.map((issue) => issue.code)).toEqual(["quote_not_in_passage"]);
    expect([...TRUE_TO_SOURCES].sort()).toEqual(["no_quote", "quote_not_in_passage", "unknown_passage"]);
  });
});

describe("the label check", () => {
  it("answers the shared cases (common/label-cases.ts) as the scenes service's write_beat does", () => {
    for (const c of LABEL_CASES) {
      const own: Passage[] = [
        { id: "p-own", label: "P1", sourceId: "src", text: c.sources },
        { id: "P2", label: "P2", sourceId: "src", text: "More notes." },
        { id: "P3", label: "P3", sourceId: "src", text: "And more." },
      ];
      const leaks = promptLabelLeaks(c.text, own, ["s1", "s2", "s3"]);
      if (c.leaks.length === 0) expect(leaks, c.text).toEqual([]);
      else expect(leaks, c.text).toEqual(expect.arrayContaining(c.leaks));
    }
  });
});

describe("video settings", () => {
  it("parse with defaults and refuse unknown values", () => {
    expect(parseVideoSettings(undefined)).toEqual({ ok: true, settings: { minutes: 0, aspect: "portrait" } });
    const bad = parseVideoSettings({ minutes: 99, aspect: "round", voice: "x", style: "Not An Id" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((issue) => issue.path).sort()).toEqual(["$.aspect", "$.minutes", "$.style", "$.voice"]);
  });

  it("keep a maker and a style by shape only, so one not set up here now never makes a stored item unreadable", () => {
    expect(parseVideoSettings({ maker: "auto", style: "gone-style" })).toEqual({ ok: true, settings: { minutes: 0, aspect: "portrait", maker: "auto", style: "gone-style" } });
    expect(parseVideoSettings({ maker: "scenes" })).toEqual({ ok: true, settings: { minutes: 0, aspect: "portrait", maker: "scenes" } });
    expect(parseVideoSettings({ maker: 3 }).ok).toBe(false);
  });

  it("read a maker Open Sourcebook took out as the open pick", () => {
    expect(RETIRED_VIDEO_MAKERS).toContain("storyboard");
    expect(parseVideoSettings({ maker: "storyboard", minutes: 1 })).toEqual({ ok: true, settings: { minutes: 1, aspect: "portrait" } });
  });
});

describe("a video maker Open Sourcebook took out", () => {
  const real = {
    id: "drawn",
    label: "Drawn",
    description: "Draws it.",
    about: "drawn scenes",
    engine: { type: "video", schemaVersion: 1 as const, plan: async () => ({}), generate: async () => Promise.reject(new Error("unused")), validate: async () => ({ valid: true, issues: [] }), repair: async () => Promise.reject(new Error("unused")) },
    maxRepairRounds: 1,
    styles: () => [],
    estimateCost: () => ({ usd: 0, basis: "free" }),
  };
  const definition = videoDefinitionFor(new VideoMakerRegistry().register(real));

  it("is never asked for: an item naming it has nothing to fix before Start and is priced by the real maker", () => {
    const parsed = parseVideoSettings({ maker: "storyboard" });
    if (!parsed.ok) throw new Error("bad settings");
    expect(definition.itemIssues!(parsed.settings)).toEqual([]);
    expect(definition.estimateCost({ settings: parsed.settings, sourceChars: 10, sourceCount: 1 })).toEqual({ usd: 0, basis: "free" });
  });

  it("leaves its saved blueprints, and those saved before makers existed, to be planned again", () => {
    expect(definition.keepsBlueprint!({ maker: "storyboard", made: { scenes: [] } })).toBe(false);
    expect(definition.keepsBlueprint!({ title: "Old", idea: "", scenes: [], minutes: 0, omittedPassages: 0 })).toBe(false);
    expect(definition.keepsBlueprint!({ maker: "drawn", made: {} })).toBe(true);
    // A maker only switched off here is kept: the item says so instead of changing maker.
    expect(definition.keepsBlueprint!({ maker: "scenes", made: {} })).toBe(true);
  });

  it("is not offered anywhere: video without a maker is declared, not ready, with no settings", () => {
    const without = createDefaultRegistry({ video: { makers: [] } }).views().find((view) => view.id === "video")!;
    expect(without).toMatchObject({ ready: false, settings: [] });
    const withOne = createDefaultRegistry({ video: { makers: [real] } });
    expect(withOne.ready()).toEqual(["video", "flashcards", "quiz"]);
    expect(withOne.views().find((view) => view.id === "video")!.settings.map((field) => field.key)).toEqual(["minutes", "aspect"]);
    expect(JSON.stringify(withOne.views())).not.toMatch(/storyboard/i);
  });
});
