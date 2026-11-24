import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_CASES } from "../../../common/label-cases.ts";
import { checkScene, checkScript, DEFAULT_LIMITS, numberedWords, readLimits, readPauses, withPauses, type Passage } from "../src/script.ts";
import { opening } from "../src/scene.ts";
import { lengthNote } from "../src/tools.ts";
import { passages, script } from "./fixtures/scenes.ts";

const styles = ["chalkboard", "flat"];

test("a grounded script is taken, with scene ids in order", () => {
  const r = checkScript({ ...script, style: "flat" }, passages, DEFAULT_LIMITS, styles);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.script!.scenes.map((s) => s.id), ["s1", "s2"]);
  assert.equal(r.script!.style, "flat");
});

test("a quote must be word for word in its passage; only spaces may differ", () => {
  const spaced = structuredClone(script);
  spaced.scenes[0]!.cites[0]!.quote = "A lever is a  stiff bar\nthat turns on a fixed point called the fulcrum.";
  assert.deepEqual(checkScript(spaced, passages, DEFAULT_LIMITS, styles).problems, []);
  const changed = structuredClone(script);
  changed.scenes[0]!.cites[0]!.quote = "A lever is a rigid bar that turns on a fixed point.";
  assert.match(checkScript(changed, passages, DEFAULT_LIMITS, styles).problems.join("\n"), /not word for word in p1/);
});

test("every scene cites a known passage, and lengths stay inside the limits", () => {
  const bad = structuredClone(script) as any;
  bad.scenes[0].cites = [];
  bad.scenes[1].cites = [{ passageId: "nope", quote: "x" }];
  bad.scenes[1].visual = "short";
  bad.scenes[1].onScreenText = ["a", "b", "c", "d", "e"];
  const problems = checkScript(bad, passages, DEFAULT_LIMITS, styles).problems.join("\n");
  assert.match(problems, /scene 1: cite at least one passage/);
  assert.match(problems, /no passage "nope"/);
  assert.match(problems, /scene 2: visual is 5 characters/);
  assert.match(problems, /scene 2: onScreenText has 5 entries; at most 4\. Keep the 4 a viewer most needs \(you sent "/);
  assert.match(checkScript({ ...script, scenes: [script.scenes[0]] }, passages, DEFAULT_LIMITS, styles).problems.join("\n"), /scenes: 1; write 2 to 12/);
  assert.match(checkScript({ ...script, style: "comic" }, passages, DEFAULT_LIMITS, styles).problems.join("\n"), /style: "comic" is not one of/);
});

test("labels the viewer never sees are refused in what is said or shown", () => {
  const labelled = structuredClone(script);
  labelled.scenes[1]!.narration = "As s1 showed, pushing far from the fulcrum lifts the load.";
  assert.match(checkScript(labelled, passages, DEFAULT_LIMITS, styles).problems.join("\n"), /scene 2: narration or on-screen text points at what only you were given: "s1"/);
  const pointed = structuredClone(script);
  pointed.scenes[0]!.onScreenText = ["As passage p1 says"];
  assert.match(checkScript(pointed, passages, DEFAULT_LIMITS, styles).problems.join("\n"), /"p1", "passage p1"/);
});

test("the subject's own words are not labels: a word used as ordinary vocabulary is taken", () => {
  for (const narration of ["The final passage of the bill needs a simple majority.", "Final passage needs a simple majority.", "Traders found a passage through the mountains.", "The source of the river lies far upstream."]) {
    const plain = structuredClone(script);
    plain.scenes[1]!.narration = narration;
    assert.deepEqual(checkScript(plain, passages, DEFAULT_LIMITS, styles).problems, [], narration);
  }
});

test("write time and the engine read labels by the same rule: the shared cases (common/label-cases.ts) answer here as they do there", () => {
  for (const c of LABEL_CASES) {
    // The case's labels are the passages' ids and labels and the beats' ids, its sources the passages' text.
    const own: Passage[] = [{ id: "p-own", label: "P1", sourceId: "src", sourceTitle: "Notes", text: c.sources }, { id: "P2", sourceId: "src", sourceTitle: "Notes", text: "More notes." }, { id: "P3", sourceId: "src", sourceTitle: "Notes", text: "And more." }];
    const scene = { narration: c.text, onScreenText: [], visual: "A plain card with the words on it, large.", cites: [{ passageId: "p-own", quote: c.sources.slice(0, 20) }] };
    const problems: string[] = [];
    checkScene(scene, "s1", "s1", own, DEFAULT_LIMITS, problems, [], ["s1", "s2", "s3"]);
    const said = problems.filter((p) => p.includes("points at what only you were given"));
    if (c.leaks.length === 0) assert.deepEqual(said, [], c.text);
    else for (const leak of c.leaks) assert.ok(said.join(" ").includes(`"${leak}"`), `${c.text}: ${said.join(" ")} misses ${leak}`);
  }
});

test("a caller's limits win over the defaults, and nonsense is ignored", () => {
  const limits = readLimits({ maxScenes: 1, minScenes: 1, narrationMaxChars: "x", visualMaxChars: -3 });
  assert.equal(limits.maxScenes, 1);
  assert.equal(limits.narrationMaxChars, DEFAULT_LIMITS.narrationMaxChars);
  assert.equal(limits.visualMaxChars, DEFAULT_LIMITS.visualMaxChars);
  assert.match(checkScript(script, passages, limits, styles).problems.join("\n"), /scenes: 2; write 1 to 1/);
});

test("a scene's words are numbered from 0, as scene moments count them", () => {
  assert.equal(numberedWords("Push down far from it."), "@0 Push @1 down @2 far @3 from @4 it.");
});

test("the spoken length is told against the length asked for, never refused", () => {
  assert.equal(lengthNote(57, 60, 140), "The narration comes to 57 s; about 60 s was asked for.");
  assert.match(lengthNote(41, 55, 100), /comes to 41 s; about 55 s was asked for: 25% shorter, about 34 words fewer than that length at this voice's pace \(2\.4 words a second\)\. If it is shorter because the passages say too little/);
  assert.match(lengthNote(80, 60, 200), /33% longer, about 50 words more than that length at this voice's pace \(2\.5 words a second\)\.$/);
});

test("caption key words are kept when the narration says them, and the rest are named", () => {
  const withKeys = structuredClone(script) as typeof script & { scenes: { emphasis?: string[] }[] };
  withKeys.scenes[0]!.emphasis = ["lever", "fulcrum", "banana"];
  const checked = checkScript(withKeys, passages, DEFAULT_LIMITS, styles);
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.script!.scenes[0]!.emphasis?.includes("banana"), false);
  assert.match(checked.notes.join(" "), /scene 1: caption key words not in its narration, so not lit: "banana"/);
});


test("a scene's first state is a cut unless it says how it enters, and only that line changes", () => {
  const program = "program p doc=\"x\"\n  // @0 inside a program is code\nend\n";
  assert.equal(opening(`${program}@0\ntext t "a"\n@3 keep\n`), `${program}@0 cut\ntext t "a"\n@3 keep\n`);
  assert.equal(opening("@0 enter=draw\ntext t \"a\"\n"), "@0 enter=draw\ntext t \"a\"\n");
  assert.equal(opening("@0 cut\n"), "@0 cut\n");
  assert.equal(opening("read text=0.04\n@0 move=20\n"), "read text=0.04\n@0 move=20 cut\n");
});

test("a pause in the narration is taken out of its words and kept after the word before it", () => {
  const r = readPauses("Watch the ball [pause 1.5] fall. Then [pause] it [pause 2s] stops.");
  assert.equal(r.narration, "Watch the ball fall. Then it stops.");
  assert.deepEqual(r.pauses, [{ afterWord: 2, seconds: 1.5 }, { afterWord: 4, seconds: 1 }, { afterWord: 5, seconds: 2 }]);
  assert.deepEqual(r.wrong, []);
  assert.equal(withPauses(r), "Watch the ball [pause 1.5] fall. Then [pause 1] it [pause 2] stops.");
  assert.match(readPauses("[pause 1] Too soon.").wrong[0]!, /comes before any word/);
  assert.match(readPauses("Here [pause long] it is.").wrong[0]!, /is not a pause/);
});
