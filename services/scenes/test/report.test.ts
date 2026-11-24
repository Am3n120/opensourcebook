/**
 * The viewer report on small built scenes: each kind of observation is found at the right time with its numbers, what
 * reads fine is not reported, and the report never gates, scores or orders.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scene, SceneNode, Track } from "../engine/core/types.ts";
import { observe, reportText, sampleScenes, VIEWER, type Heard, type Motion } from "../src/report.ts";

const FPS = 30;
const W = 1080;
const H = 1920;

/** A text node shown (opacity 1) from one second to another of a scene, hidden before and after. */
function shown(id: string, text: string, from: number, to: number, place: { x?: number; y?: number; size?: number } = {}): { node: SceneNode; track: Track } {
  const [a, b] = [Math.round(from * FPS), Math.round(to * FPS)];
  return {
    node: { id, kind: "text", props: { x: place.x ?? W / 2, y: place.y ?? H * 0.4, text, size: place.size ?? 72, opacity: 0 } },
    track: { target: id, prop: "opacity", keys: [{ at: Math.max(0, a - 1), value: 0, ease: "step" }, { at: a, value: 1, ease: "step" }, { at: b, value: 1, ease: "step" }, { at: b + 1, value: 0, ease: "step" }] },
  };
}

/** A filled shape on screen the whole scene, so the frame is not empty. */
const block = (id: string, box = { x: W / 2, y: H * 0.3, w: 700, h: 700 }): SceneNode => ({ id, kind: "path", props: { x: box.x, y: box.y, points: [-box.w / 2, -box.h / 2, box.w / 2, -box.h / 2, box.w / 2, box.h / 2, -box.w / 2, box.h / 2], closed: 1, fill: "#336699", opacity: 1 } });

function scene(seconds: number, parts: { node: SceneNode; track?: Track }[]): Scene {
  return { fps: FPS, width: W, height: H, frames: Math.round(seconds * FPS), background: "#ffffff", nodes: parts.map((p) => p.node), tracks: parts.flatMap((p) => (p.track ? [p.track] : [])), events: [] };
}

/** Words spoken evenly over a stretch of one beat, in seconds of the video. */
function said(beat: string, text: string, from: number, to: number) {
  const list = text.split(" ");
  const each = (to - from) / list.length;
  return list.map((w, i) => ({ text: w, start: from + i * each, end: from + (i + 1) * each - 0.05, beat }));
}

const heardOf = (spans: [string, number, number][], words: Heard["words"], holds: Heard["holds"] = []): Heard => ({
  durationMs: (spans.at(-1)![2] + 3) * 1000,
  spans: spans.map(([id, a, b]) => ({ id, startMs: a * 1000, endMs: b * 1000 })),
  words,
  holds,
  voice: { real: true, label: "test" },
  sound: { lufs: -14, truePeak: -1.2, music: [] },
});

/** A picture that changes at every moment, so nothing reads as standing still unless a test says so. */
const moving = (seconds: number, still: [number, number][] = []): Motion => ({ fps: VIEWER.motionFps, change: Array.from({ length: Math.round(seconds * VIEWER.motionFps) }, (_, i) => (still.some(([a, b]) => i / VIEWER.motionFps > a && i / VIEWER.motionFps <= b) ? 0 : 0.05)) });

const GATING = /\b(must|should|need to|needs to|have to|required|fix|fail(ed|s)?|pass(ed|es)?|score|error|wrong|bad|not allowed|reject)/i;

test("a label on screen too briefly is reported at its time, with its reading time; a readable one is not", () => {
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(6, [{ node: block("box") }, shown("quick", "activation energy", 2, 2.5), shown("calm", "the slow label", 3, 5.5)]) }]);
  const heard = heardOf([["s1", 0, 6]], said("s1", "a reaction needs a push to start and here it goes", 0.2, 5.6));
  const r = observe(facts, heard, moving(6));
  const brief = r.observations.filter((o) => o.kind === "brief");
  assert.equal(brief.length, 1, reportText(r, ""));
  assert.equal(brief[0]!.beat, "s1");
  assert.ok(Math.abs(brief[0]!.at - 2) < 0.11, `at ${brief[0]!.at}`);
  assert.match(brief[0]!.text, /^At 0:02\.0 \(s1, 2\.0 s in\) the words "activation energy" are on screen for 0\.6 s; reading 2 words takes about 1\.2 s/);
  assert.ok(!r.observations.some((o) => o.text.includes("the slow label")));
});

test("writing gone before the voice names it, and writing that comes well after its word, are reported", () => {
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(10, [{ node: block("box") }, shown("early", "photosynthesis", 0.5, 2.5), shown("late", "chlorophyll", 7, 9.5)]) }]);
  const words = [...said("s1", "leaves are green because of chlorophyll", 0.2, 3), ...said("s1", "and then comes photosynthesis in the light", 4.5, 8)];
  const r = observe(facts, heardOf([["s1", 0, 10]], words), moving(10));
  const gone = r.observations.find((o) => o.kind === "gone");
  const late = r.observations.find((o) => o.kind === "late");
  assert.ok(gone && /"photosynthesis" leaves the screen \d\.\d s before the voice says "photosynthesis"/.test(gone.text), reportText(r, ""));
  assert.ok(late && /"chlorophyll" appears \d\.\d s after the voice said "chlorophyll"/.test(late.text), reportText(r, ""));
});

test("a stretch where nothing on screen changes while the voice goes on is reported with its words; a moving picture is not", () => {
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(10, [{ node: block("box") }, shown("t", "a heading", 0, 10)]) }]);
  const heard = heardOf([["s1", 0, 10]], said("s1", "one two three four five six seven eight nine ten eleven twelve", 0.2, 9.8));
  const still = observe(facts, heard, moving(10, [[2, 7]])).observations.filter((o) => o.kind === "still");
  assert.equal(still.length, 1);
  assert.match(still[0]!.text, /^From 0:02\.0 to 0:07\.\d \(s1\) nothing on screen moves or changes for 5\.\d s while the voice says "/);
  assert.equal(observe(facts, heard, moving(10)).observations.filter((o) => o.kind === "still").length, 0);
});

test("writing on top of writing, writing cut by the frame and writing too small for a phone are reported; tidy writing is not", () => {
  const messy = scene(5, [
    { node: block("box") },
    shown("a", "first words here", 0, 5, { x: 540, y: 900 }),
    shown("b", "second words here", 0, 5, { x: 560, y: 905 }),
    shown("edge", "this line runs off the side", 0, 5, { x: 1080, y: 1200 }),
    shown("tiny", "tiny footnote", 0, 5, { x: 540, y: 1400, size: 24 }),
  ]);
  const heard = heardOf([["s1", 0, 5]], said("s1", "some words are spoken over this whole scene now", 0.2, 4.8));
  const r = observe(sampleScenes([{ id: "s1", offset: 0, scene: messy }]), heard, moving(5));
  const kinds = new Set(r.observations.map((o) => o.kind));
  for (const k of ["overlap", "cut", "small"]) assert.ok(kinds.has(k), `${k}: ${reportText(r, "")}`);
  assert.match(r.observations.find((o) => o.kind === "small")!.text, /"tiny footnote" is 8\.0 pt on a phone 360 points wide; 11 pt is the smallest/);

  const tidy = scene(5, [{ node: block("box") }, shown("a", "first words here", 0, 5, { x: 540, y: 1000 }), shown("b", "second words here", 0, 5, { x: 540, y: 1200 })]);
  const fine = observe(sampleScenes([{ id: "s1", offset: 0, scene: tidy }]), heard, moving(5));
  assert.deepEqual(fine.observations.map((o) => o.kind), [], reportText(fine, ""));
  assert.match(reportText(fine, ""), /Reads fine: .*no writing sits on other writing/);
});

test("a beat that opens empty, one that cuts just as something appears, and a long gap in the voice are reported", () => {
  const a = scene(4, [shown("t", "arrives late", 1.2, 4), { node: block("box"), track: { target: "box", prop: "opacity", keys: [{ at: 0, value: 0, ease: "step" }, { at: 36, value: 1, ease: "step" }] } }]);
  const b = scene(4, [{ node: block("box2") }, shown("end", "right at the end", 3.7, 4)]);
  const words = [...said("s1", "the first beat speaks", 0.3, 1.5), ...said("s1", "and again", 3.5, 3.9), ...said("s2", "the second beat speaks a little", 4.2, 7.5)];
  const r = observe(sampleScenes([{ id: "s1", offset: 0, scene: a }, { id: "s2", offset: 4, scene: b }]), heardOf([["s1", 0, 4], ["s2", 4, 8]], words, [{ beat: "s1", id: "h1", start: 1.5, seconds: 2 }]), moving(8));
  const opens = r.observations.find((o) => o.kind === "opens");
  assert.ok(opens && /^s1 opens on an empty frame: nothing is on screen for its first 1\.2 s/.test(opens.text), reportText(r, ""));
  assert.ok(r.observations.some((o) => o.kind === "ending" && o.beat === "s2"), reportText(r, ""));
  const gap = r.observations.find((o) => o.kind === "gap");
  assert.ok(gap && /the voice is quiet for 2\.\d s, between "speaks" and "and" \(a \[pause 2\] in s1\)/.test(gap.text), reportText(r, ""));
});

test("rushed speech is reported with its pace", () => {
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(4, [{ node: block("box") }]) }]);
  const words = said("s1", "so many words are packed into this very short stretch of time that it sounds rushed to anyone", 0.1, 3.9);
  const fast = observe(facts, heardOf([["s1", 0, 4]], words), moving(4)).observations.find((o) => o.kind === "fast");
  assert.ok(fast && /is spoken at \d{3} words a minute/.test(fast.text));
});

test("the report is information: no gating words, no pass or fail, no score, most noticeable first", () => {
  const messy = scene(8, [
    shown("a", "first words here", 0.8, 8, { x: 540, y: 900 }),
    shown("b", "second words here", 0.8, 8, { x: 560, y: 905 }),
    shown("quick", "gone in a flash", 3, 3.3),
    shown("tiny", "tiny footnote", 1, 8, { x: 540, y: 1400, size: 24 }),
  ]);
  const heard = heardOf([["s1", 0, 8]], said("s1", "words go by over this whole scene and then more words follow it", 0.2, 7.8));
  const r = observe(sampleScenes([{ id: "s1", offset: 0, scene: messy }]), heard, moving(8, [[3.5, 7.9]]));
  const text = reportText(r, "About this cut.");
  assert.ok(r.observations.length >= 4, text);
  assert.doesNotMatch(text, GATING);
  assert.doesNotMatch(text, /\d+ ?\/ ?\d+|\bout of \d|\bgrade\b|\brating\b/i);
  const weights = r.observations.map((o) => o.weight);
  assert.deepEqual(weights, [...weights].sort((x, y) => y - x));
  // Every line says when.
  for (const o of r.observations) assert.match(o.text, /\d:\d\d\.\d|^s\d|In s\d/);
});

test("a drawn thing that first shows well after the voice names it is reported, with both times; one there from the start is not", () => {
  const plug = { node: { ...block("plug", { x: W / 2, y: H * 0.3, w: 500, h: 300 }), props: { ...block("plug", { x: W / 2, y: H * 0.3, w: 500, h: 300 }).props, opacity: 0 } }, track: { target: "plug", prop: "opacity", keys: [{ at: 0, value: 0, ease: "step" as const }, { at: 4 * FPS, value: 1, ease: "step" as const }] } };
  const housing = { node: block("housing", { x: W / 2, y: H * 0.6, w: 600, h: 300 }) };
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(6, [housing, plug]) }]);
  const heard = heardOf([["s1", 0, 6]], said("s1", "inside the housing turns a plug that you push", 0.2, 3));
  const r = observe(facts, heard, moving(6), [], 4);
  const late = r.observations.filter((o) => o.kind === "named-first");
  assert.equal(late.length, 1, reportText(r, ""));
  assert.match(late[0]!.text, /"plug" is said at 0:0\d\.\d and the thing drawn for it \(plug\) first shows at 0:04\.0/);
  assert.ok(!late[0]!.text.includes("(housing)"));
  assert.doesNotMatch(late[0]!.text, GATING);
});

test("the report says how the seconds are shared between beats against the length asked", () => {
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(4, [{ node: block("a") }]) }, { id: "s2", offset: 4, scene: scene(8, [{ node: block("b") }]) }]);
  const heard = heardOf([["s1", 0, 4], ["s2", 4, 12]], [...said("s1", "one two three four", 0.2, 3.8), ...said("s2", "five six seven eight", 4.2, 11.8)]);
  const text = reportText(observe(facts, heard, moving(12), [], 10), "");
  assert.match(text, /Time by beat: s1 4\.0 s \(33%\), s2 8\.0 s \(67%\); 12\.0 s spoken against about 10 s asked \(20% over\)/);
  assert.match(text, /The longest beat is s2, the shortest s1/);
});

test("the report notes factually when most beats of a video share one shelf piece, and stays quiet when pieces vary or beats are few", () => {
  const mk = (ids: string[]) => {
    const spans: [string, number, number][] = ids.map((id, i) => [id, i * 4, (i + 1) * 4]);
    const scenes = spans.map(([id, a]) => ({ id, offset: a, scene: scene(4, [{ node: block("a") }]) }));
    const words = spans.flatMap(([id, a, b]) => said(id, "one two three four", a + 0.2, b - 0.2));
    return { spans, scenes, words };
  };
  const four = mk(["s1", "s2", "s3", "s4"]);
  const repeated = observe(
    { ...sampleScenes(four.scenes), pieces: { s1: ["journey"], s2: ["journey"], s3: ["two-tracks"], s4: ["journey"] } },
    heardOf(four.spans, four.words),
    moving(16),
  );
  const same = repeated.observations.filter((o) => o.kind === "same-piece");
  assert.equal(same.length, 1);
  assert.match(same[0]!.text, /3 of 4 beats \(s1, s2, s4\) run the same shelf piece \("journey"\), starting at 0:00\.0/);
  assert.doesNotMatch(same[0]!.text, GATING);

  const varied = observe(
    { ...sampleScenes(four.scenes), pieces: { s1: ["journey"], s2: ["two-tracks"], s3: ["flow"], s4: ["bars"] } },
    heardOf(four.spans, four.words),
    moving(16),
  );
  assert.equal(varied.observations.filter((o) => o.kind === "same-piece").length, 0);

  const two = mk(["s1", "s2"]);
  const short = observe(
    { ...sampleScenes(two.scenes), pieces: { s1: ["journey"], s2: ["journey"] } },
    heardOf(two.spans, two.words),
    moving(8),
  );
  assert.equal(short.observations.filter((o) => o.kind === "same-piece").length, 0);
});

test("common function words in narration and labels do not trigger false late or gone timing warnings", () => {
  const facts = sampleScenes([{ id: "s1", offset: 0, scene: scene(10, [{ node: block("box") }, shown("label", "Cools at once", 7, 9.5)]) }]);
  const words = said("s1", "Once the metal heats up, energy spreads through the bar until it settles", 0.2, 4);
  const r = observe(facts, heardOf([["s1", 0, 10]], words), moving(10));
  assert.deepEqual(
    r.observations.filter((o) => o.kind === "late" || o.kind === "gone"),
    [],
    reportText(r, ""),
  );
});
