/**
 * The skills and their cookbook: every worked example builds as written on its own narration, with its depicted things
 * answered from the specs it carries, and every skill file the agent is offered can be read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { answerDepiction, emptyToolbox, wantedIn } from "../engine/language/toolbox.ts";
import { themeFrom } from "../engine/render/theme.ts";
import { kitKinds } from "../pipeline/stages/scene.ts";
import { useChrome } from "../src/chrome.ts";
import { examples, readSkill, skillFiles, skills, writeSkills } from "../src/skills.ts";
import { existsSync, readFileSync } from "node:fs";
import { listStyles } from "../src/styles.ts";
import { buildScene } from "../src/scene.ts";
import { wordsOf } from "../src/script.ts";
import { estimate } from "../src/voice.ts";

useChrome();
const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-cookbook-"));
after(() => rmSync(folder, { recursive: true, force: true }));

test("there are three skills, each says when it helps, and every file of them can be read and written out", () => {
  assert.deepEqual(skills().map((s) => s.name), ["make-a-video", "media", "teaching"]);
  for (const s of skills()) assert.ok(s.description.length > 60, s.name);
  const video = { language: "# The scene language\n\nfor this style" };
  for (const path of skillFiles(video)) {
    const [skill, ...rest] = path.split("/");
    assert.ok((readSkill(skill!, rest.join("/"), video) ?? "").length > 20, path);
  }
  assert.equal(readSkill("make-a-video", "references/scene-language.md", video), video.language);
  assert.match(readSkill("make-a-video", undefined, video)!, /^---\nname: make-a-video/);
  assert.equal(readSkill("teaching", "../make-a-video/SKILL.md", video), undefined);
  assert.equal(readSkill("nothing", undefined, video), undefined);
  const list = readSkill("make-a-video", "references/examples.md", video)!;
  for (const e of examples()) assert.match(list, new RegExp(`examples/${e.name}\\.md:`));
  assert.ok(examples().length >= 8, `${examples().length} examples`);
  const out = join(folder, "skills");
  writeSkills(out, video);
  assert.equal(readFileSync(join(out, "make-a-video", "references", "scene-language.md"), "utf8"), video.language);
  assert.ok(existsSync(join(out, "teaching", "references", "craft.md")));
  assert.ok(existsSync(join(out, "make-a-video", "references", "examples", "balloon.md")));
});

for (const e of examples()) {
  test(`the cookbook's ${e.name} builds as written in every offered style`, async () => {
   for (const { id: style } of listStyles()) {
    const toolbox = emptyToolbox();
    const wanted = wantedIn(e.source, kitKinds());
    for (const d of e.depictions) {
      const w = wanted.find((x) => x.id === d.id && x.desc === d.desc);
      assert.ok(w, `${e.name}: ${d.id} ("${d.desc}") has a spec but no depict line`);
      assert.deepEqual(answerDepiction(toolbox, w, d.spec, themeFrom(style)), [], `${e.name}: ${d.id}`);
    }
    const scene = { id: "s1", narration: e.narration, onScreenText: [], visual: e.about, cites: [] };
    const words = wordsOf(e.narration).length;
    for (const m of e.source.matchAll(/@(\d+)/g)) assert.ok(Number(m[1]) < words, `${e.name}: @${m[1]} is past its ${words} words`);
    const built = await buildScene({ title: e.title, idea: e.about, brief: "", style, frame: { width: 1080, height: 1920 }, scene, timing: estimate(e.narration), toolbox }, e.source, join(folder, e.name, style));
    assert.deepEqual(built.problems, [], `${e.name} in ${style}:\n${built.problems.join("\n")}`);
    assert.equal(built.ok, true);
    // Nothing measured that a viewer would notice: words cut by the edge, too small, or written over other words. A
    // board is larger than the frame on purpose, its camera leaving words behind and stepping back to show it whole.
    const board = /^\s*board\s/m.test(e.source);
    const measured = board ? [] : built.serious.filter((x) => /^(Words cut by the frame edge|Words too small|Writing on top of writing)/.test(x));
    assert.deepEqual(measured, [], `${e.name} in ${style}`);
   }
  });
}

test("an index or a power typed into words on screen is named, since the viewer would see the _ or ^", async () => {
  const narration = "Multiply the moles by Avogadro's number to count them.";
  const scene = { id: "s1", narration, onScreenText: [], visual: "a formula", cites: [] };
  const built = await buildScene({ title: "t", idea: "i", brief: "", style: "chalkboard", frame: { width: 1080, height: 1920 }, scene, timing: estimate(narration), toolbox: emptyToolbox() }, '@0\ntext a "× N_A" size=big\n@4 keep\ntext b "x^2 and H₂O" size=big\n', join(folder, "typed"));
  assert.ok(built.ok, built.problems.join("\n"));
  assert.ok(built.serious.some((w) => /Typed markup shows as itself: "N_A", "x\^2"/.test(w)), built.serious.join("\n"));
});
