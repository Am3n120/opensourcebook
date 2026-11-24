/**
 * The agent's tools with no agent: hand-written calls in the order an agent makes them, on the fixture script, with the
 * silent voice (the render at the end uses ElevenLabs' code with a stand-in for its call). Building and looking use the real engine and headless Chrome.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { useChrome } from "../src/chrome.ts";
import { closeRenderer } from "../pipeline/stages/scene.ts";
import { DEFAULT_LIMITS } from "../src/script.ts";
import { allStyles, listStyles } from "../src/styles.ts";
import { callTool, emptyDraft, makingOf, scenesKey, stepNumber, unfinished, type ToolContext } from "../src/tools.ts";
import { emptyMaking } from "../src/making.ts";
import { finalBuild, renderVideo, voiceAll } from "../src/produce.ts";
import { currentCut, cutKey } from "../src/cut.ts";
import { silentVoice } from "../src/voice.ts";
import { elevenVoice } from "../src/eleven.ts";
import { fakeTts } from "./fixtures/voice.ts";
import { passages, script, sources } from "./fixtures/scenes.ts";

useChrome();
const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-tools-"));
after(async () => {
  await closeRenderer();
  rmSync(folder, { recursive: true, force: true });
});

const steps: string[] = [];
const ctx: ToolContext = {
  request: { id: "t1", title: "Levers", brief: "how a lever lifts a load", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 12, style: "auto", passages, limits: DEFAULT_LIMITS },
  draft: emptyDraft(),
  folder,
  styles: listStyles(),
  voice: silentVoice(),
  step: (label) => steps.push(label),
  save: () => undefined,
};

test("every style says in plain words what it looks like", () => {
  const styles = allStyles();
  assert.ok(styles.length >= 7 && listStyles().length >= 3);
  for (const s of styles) assert.ok(s.label && s.description.length > 20, s.id);
});

test("read_passages gives the text by id, and says when an id is unknown", async () => {
  const r = await callTool("read_passages", { ids: ["p1", "p9"] }, ctx);
  assert.match(r.text, /\[p1\] Notes on simple machines\nA lever is a stiff bar/);
  assert.match(r.text, /\[p9\] There is no passage/);
});

/** A fixture scene as write_beat takes it, with its picture when one is given. */
const beat = (i: number, extra: Record<string, unknown> = {}) => ({ ...script.scenes[i]!, ...extra });

test("write_beat takes beats one at a time, and the video so far says how it sits against the length asked for", async () => {
  const long = { ...ctx, request: { ...ctx.request, targetSeconds: 40 }, draft: emptyDraft() };
  await callTool("write_beat", beat(0), long);
  const taken = await callTool("write_beat", beat(1), long);
  assert.equal(taken.isError, undefined, taken.text);
  assert.match(taken.text, /The narration comes to \d+ s; about 40 s was asked for: \d+% shorter, about \d+ words fewer than that length at this voice's pace/);
  assert.match(taken.text, /The video so far: s1 \d+\.\d s/, "each beat with its seconds");
  const thin = await callTool("about_video", { short: "The notes say only what a lever is and what it does." }, long);
  assert.match(thin.text, /Shorter because: The notes say only/);
  assert.equal(long.draft.short, "The notes say only what a lever is and what it does.");
});

test("write_beat answers a pointer at the passages while the agent writes, takes the subject's own words, and refuses a beat past the most scenes", async () => {
  const own = { ...ctx, draft: emptyDraft() };
  const leak = await callTool("write_beat", beat(0, { narration: "As passage p1 says, a lever is a stiff bar that turns on one fixed point." }), own);
  assert.equal(leak.isError, true);
  assert.match(leak.text, /^s1 was not taken\. Fix these and send it again:\n- s1: narration or on-screen text points at what only you were given: "p1", "passage p1"\./);
  const plain = await callTool("write_beat", beat(0, { narration: "A lever gives the push a passage to the load: one stiff bar on one fixed point." }), own);
  assert.equal(plain.isError, undefined, plain.text);
  const few = { ...ctx, request: { ...ctx.request, limits: { ...DEFAULT_LIMITS, maxScenes: 1 } }, draft: emptyDraft() };
  await callTool("write_beat", beat(0), few);
  const past = await callTool("write_beat", beat(1), few);
  assert.equal(past.isError, true);
  assert.match(past.text, /s2 was not taken[\s\S]*the video would have 2 beats; at most 1/);
});

test("read_skill reads a skill or one of its files, the scene language written for this video's style, and lists the files when one is unknown", async () => {
  assert.match((await callTool("read_skill", { skill: "make-a-video" }, ctx)).text, /^---\nname: make-a-video/);
  assert.match((await callTool("read_skill", { skill: "teaching", file: "references/demonstrate.md" }, ctx)).text, /# Showing ideas working/);
  assert.match((await callTool("read_skill", { skill: "make-a-video", file: "references/examples/balloon.md" }, ctx)).text, /```scene\nprogram balloon/);
  assert.match((await callTool("read_skill", { skill: "make-a-video", file: "references/depicting.md" }, ctx)).text, /Kinds\n\* container/);
  assert.match((await callTool("read_skill", { skill: "make-a-video", file: "references/scene-language.md" }, ctx)).text, /^# The scene language/);
  const unknown = await callTool("read_skill", { skill: "hooks" }, ctx);
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /teaching\/references\/craft\.md/);
});

test("about_video says what the video is; write_beat refuses a misquote, then takes each beat and gives every word's number and time", async () => {
  const about = await callTool("about_video", { title: script.title, idea: script.idea, style: "flat", styleWhy: "a lesson" }, ctx);
  assert.equal(about.isError, undefined, about.text);
  assert.match(about.text, /Style: flat \(your pick\)/);
  assert.equal(ctx.draft.style, "flat");
  const wrong = structuredClone(script.scenes[0]!);
  wrong.cites[0]!.quote = "a heavy load is easy";
  const refused = await callTool("write_beat", wrong, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /s1 was not taken[\s\S]*the quote "a heavy load is easy" is not word for word in p1/);
  const first = await callTool("write_beat", beat(0), ctx);
  assert.equal(first.isError, undefined, first.text);
  assert.match(first.text, /@0 A \d\.\d  @1 lever \d\.\d  @2 is/);
  assert.match(first.text, /No picture yet/);
  await callTool("write_beat", beat(1), ctx);
  assert.deepEqual(Object.keys(ctx.draft.timings), ["s1", "s2"]);
  assert.deepEqual(ctx.draft.script!.scenes.map((s) => s.id), ["s1", "s2"]);
});

test("write_beat answers a picture that does not build with its lines, and one that builds with what code sees", async () => {
  const bad = await callTool("write_beat", { beat: "s1", source: "@0\nboxx a \"hi\"\n" }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Its picture does not build/);
  assert.match(bad.text, /line 2: .*Did you mean box/);
  const good = await callTool("write_beat", { beat: "s1", source: sources.s1 }, ctx);
  assert.equal(good.isError, undefined, good.text);
  assert.match(good.text, /Its picture builds: \d+\.\d s/);
  assert.equal(good.images?.length, 1, "a strip of what it draws");
  assert.match(good.text, /What it draws over its \d+\.\d s is in the \d+ small frames below/);
  assert.match(good.text, /instruments' readings/);
  const plain = await callTool("write_beat", { beat: "s2", source: sources.s2 }, ctx);
  assert.match(plain.text, /Only words and plain shapes: this scene is made of/);
  // The beats are still being written, so the step says which scene, not "of" a total that is only how many exist so far.
  assert.ok(steps.includes("Drawing scene 2"), steps.join(" | "));
  assert.ok(!steps.some((x) => / of \d/.test(x)), steps.join(" | "));
});

test("a beat whose picture is only words and plain shapes is answered with the shelf as a picture once, then a line", async () => {
  const fresh = { ...ctx, draft: emptyDraft() };
  const drawn = await callTool("write_beat", { ...beat(0), source: sources.s1 }, fresh);
  assert.doesNotMatch(drawn.text, /The shelf has/, "a beat that draws says nothing of the shelf");
  const first = await callTool("write_beat", { ...beat(1), source: sources.s2 }, fresh);
  assert.match(first.text, /Only words and plain shapes/);
  assert.match(first.text, /The shelf has \d+ pieces that draw themselves in this video's style and follow the voice: the second picture below shows each/);
  assert.equal(first.images?.length, 2, "the strip, then the shelf");
  assert.equal(fresh.draft.shelfShown, "s2");
  assert.doesNotMatch(first.text, /\b(must|should|always|try)\b/i, "what is there, never which to use");
  const again = await callTool("write_beat", { beat: "s2", source: `${sources.s2}\n` }, fresh);
  assert.match(again.text, /the picture of all of them came with s2's answer, and find_piece with no want shows it again/);
  assert.equal(again.images?.length, 1, "the strip alone");

  // Calling about_video with an idea shows the shelf picture once, before beat 1, without pre-selecting pieces.
  const preBeat = { ...ctx, draft: emptyDraft() };
  const withoutIdea = await callTool("about_video", { title: "How a bill becomes law" }, preBeat);
  assert.equal(withoutIdea.images, undefined);
  assert.equal(preBeat.draft.shelfShown, undefined);
  const withIdea = await callTool("about_video", { title: "How a bill becomes law", idea: "How a bill moves through committee, both chambers, and the president's desk to become law.", style: "flat" }, preBeat);
  assert.equal(withIdea.isError, undefined, withIdea.text);
  assert.match(withIdea.text, /The shelf has \d+ pieces/);
  assert.doesNotMatch(withIdea.text, /Pieces on the shelf whose words meet this idea/);
  assert.equal(withIdea.images?.length, 1, "whole-shelf contact sheet only");
  assert.equal(preBeat.draft.shelfShown, "about_video");
  // A second about_video call does not re-attach the sheet.
  const secondAbout = await callTool("about_video", { idea: "How a bill moves through both chambers to become law." }, preBeat);
  assert.equal(secondAbout.images, undefined);

  // Calling about_video with an idea AFTER beat 1 is already written does not attach the shelf sheet.
  const postBeat = { ...ctx, draft: emptyDraft() };
  await callTool("write_beat", { ...beat(0), source: sources.s1 }, postBeat);
  const lateAbout = await callTool("about_video", { idea: "Two tracks through House and Senate.", style: "flat" }, postBeat);
  assert.equal(lateAbout.images, undefined);
  assert.equal(postBeat.draft.shelfShown, undefined);

  // shelfBeside on a plain-shapes beat lists high-confidence structural matches, and stays silent on vague/non-matching visual words.
  const structuralBeat = { ...ctx, draft: emptyDraft() };
  const structural = await callTool("write_beat", { ...beat(1), visual: "Two tracks running in parallel through House and Senate before merging.", source: sources.s2 }, structuralBeat);
  assert.match(structural.text, /Pieces on the shelf whose names or tags share words with this beat's visual/);
  assert.match(structural.text, /run two-tracks ID/);
  const vagueBeat = { ...ctx, draft: emptyDraft() };
  const vague = await callTool("write_beat", { ...beat(1), visual: "A poem about grief and time shown slowly.", source: sources.s2 }, vagueBeat);
  assert.doesNotMatch(vague.text, /Pieces on the shelf whose names or tags share words/);
});

test("a new beat goes where it is put and can be removed", async () => {
  const added = await callTool("write_beat", { ...beat(0), after: "start" }, ctx);
  assert.equal(added.isError, undefined, added.text);
  assert.deepEqual(ctx.draft.script!.scenes.map((s) => s.id), ["s3", "s1", "s2"]);
  assert.match(added.text, /^s3 \(1 of 3\)/);
  const removed = await callTool("write_beat", { beat: "s3", remove: true }, ctx);
  assert.match(removed.text, /Removed s3\. The beats now: s1, s2/);
  assert.equal(ctx.draft.sceneCount, undefined);
  assert.equal(ctx.draft.timings.s3, undefined);
  assert.equal((await callTool("write_beat", { beat: "s9", visual: "x" }, ctx)).isError, true);
});

test("write_beat asks the agent, as the depicter, for a thing drawn as itself, keeps its answer and says what it can do", async () => {
  const source = '@0\ndepict thermo "a glass clinical thermometer in degrees Celsius" value=37\n@5 keep\ndo change thermo value=38.6 frames=30\n';
  const asked = await callTool("write_beat", { beat: "s2", source }, ctx);
  assert.equal(asked.isError, true);
  assert.match(asked.text, /thermo \("a glass clinical thermometer in degrees Celsius"\) is not depicted yet\. Answer as the depicter/);
  assert.match(asked.text, /What the plan has it do: changes its value/);
  const spec = { kind: "gauge", form: "thermometer", label: "clinical thermometer", size: { w: 2, h: 14, unit: "cm" }, params: { scale: { from: 35, to: 42, major: 1, minor: 0.5, unit: "°C" } }, colors: { column: "#d8342c" }, colorSources: { column: "known" }, state: { value: 37 }, why: "test" };
  const wrong = await callTool("write_beat", { beat: "s2", source, depictions: [{ id: "thermo", desc: "a glass clinical thermometer in degrees Celsius", spec: { ...spec, label: "" } }] }, ctx);
  assert.match(wrong.text, /These depictions were not kept[\s\S]*thermo: label/);
  const drawn = await callTool("write_beat", { beat: "s2", source, depictions: [{ id: "thermo", desc: "a glass clinical thermometer in degrees Celsius", spec }] }, ctx);
  assert.equal(drawn.isError, undefined, drawn.text);
  assert.match(drawn.text, /Kept the depictions of thermo\./);
  assert.match(drawn.text, /The depicted things \(use exactly these names\):\n- thermo, drawn as clinical thermometer/);
  // Kept for the whole video: the same thing in a later write needs no spec.
  assert.equal((await callTool("write_beat", { beat: "s2", source }, ctx)).isError, undefined);
  await callTool("write_beat", { beat: "s2", source: sources.s2 }, ctx);
});

test("finish needs every scene to build and nothing else; look and watch show stills when the agent wants them", async () => {
  const seen = await callTool("look", { scene: "s1", at: [0, 11] }, ctx);
  assert.equal(seen.isError, undefined, seen.text);
  assert.equal(seen.images?.length, 2);
  assert.equal(seen.images![0]!.mimeType, "image/jpeg");
  assert.ok(Buffer.from(seen.images![0]!.dataBase64, "base64").length < 150_000, "a small JPEG");
  assert.match(seen.text, /Still 1 \(how the scene opens\): .* as the voice says/);
  assert.match(seen.text, /On screen: "The lever"/);
  assert.doesNotMatch(seen.text, /judge|critic/);
  const strip = await callTool("look", { scene: "s1", from: 0, to: 3 }, ctx);
  assert.equal(strip.isError, undefined, strip.text);
  assert.equal(strip.images?.length, 1, "one picture of the frames");
  assert.match(strip.text, /s1 from 0\.0 to 3\.0 s of \d+\.\d: \d+ frames/);
  // s2 was never looked at: that is the agent's call.
  assert.deepEqual(unfinished(ctx.draft), []);
  // A sound that is not in the kit, or on no word, is not taken; none chosen is voice only.
  const wrong = await callTool("sound", { music: [{ scene: "s1", at: 99, name: "kazoo", level: -4, why: "" }], effects: [] }, ctx);
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /s1 has words @0 to @\d+[\s\S]*no music named "kazoo"/);
  const chosen = await callTool("sound", { music: [{ scene: "s1", at: 0, name: "focus", level: -4, why: "calm steps" }], effects: [{ scene: "s2", at: 2, name: "pop", level: -24, why: "the load lifts" }] }, ctx);
  assert.equal(chosen.isError, undefined, chosen.text);
  const sheet = await callTool("watch", {}, ctx);
  assert.equal(sheet.isError, undefined, sheet.text);
  assert.equal(sheet.images?.length, 1, "one sheet for two scenes");
  assert.match(sheet.text, /s1: Size: /);
  // Never rendered: the first finish answers once with that fact, and the second hands the video over as it is.
  const first = await callTool("finish", { note: "short and plain" }, ctx);
  assert.equal(first.isError, undefined);
  assert.match(first.text, /^Not handed over yet\. From Open Sourcebook's record of this video:\n- The video was never rendered/);
  assert.match(first.text, /Calling finish again hands the video over as it is\./);
  assert.equal(ctx.draft.finished, undefined);
  const done = await callTool("finish", { note: "short and plain" }, ctx);
  assert.match(done.text, /The video is taken/);
  // Said as a fact, never refused: nothing of this video was rendered and seen.
  assert.match(done.text, /the person gets a video you have not seen/);
  assert.deepEqual(ctx.draft.finished, { note: "short and plain" });
});

test("changing a beat's words speaks it again and builds it on its new times; a pause is a hold the picture can wait in", async () => {
  const narration = "Push down far from it, [pause 1.5] and the heavy load near it rises.";
  const before = ctx.draft.timings.s2!.timing.seconds;
  const source = sources.s2.replace("@8 keep", "@h1 keep\nlight load\n@h1.end keep\n@8 keep");
  const paused = await callTool("write_beat", { beat: "s2", narration, source }, ctx);
  assert.equal(paused.isError, undefined, paused.text);
  assert.match(paused.text, /spoken again/);
  assert.match(paused.text, /@4 it, \d+\.\d \[pause 1\.5 = @h1 \d+\.\d to @h1\.end \d+\.\d\]/);
  const timing = ctx.draft.timings.s2!.timing;
  assert.deepEqual(timing.holds?.map((h) => [h.id, h.afterWord, h.seconds]), [["h1", 4, 1.5]]);
  assert.ok(Math.abs(timing.seconds - before - 1.5) < 0.01, `${before} → ${timing.seconds}`);
  assert.ok(timing.words[5]!.start - timing.words[4]!.end >= 1.5);
  assert.equal(ctx.draft.script!.scenes[1]!.narration, "Push down far from it, and the heavy load near it rises.");
  assert.equal(ctx.draft.scenes.s1!.built, true, "s1's words did not change");
  assert.equal(ctx.draft.scenes.s2!.built, true);
  assert.equal(ctx.draft.finished, undefined);
  await callTool("look", { scene: "s2" }, ctx);
  await callTool("look", { scene: "s2", at: [3] }, ctx);
  // No count of looks: a beat can be looked at as often as the agent wants.
  const again = await callTool("look", { scene: "s2" }, ctx);
  assert.equal(again.isError, undefined, again.text);
  assert.equal(ctx.draft.scenes.s2!.looks, 3);
  assert.match((await callTool("finish", {}, ctx)).text, /The video is taken/);
});

test("the finished scenes are built again on the voice's times and rendered to an mp4 with captions' timing and its sound", async () => {
  // A real voice now (ElevenLabs' code with a stand-in for its call): every scene is spoken again and the sound is mixed.
  ctx.voice = elevenVoice({ tts: fakeTts(), cacheDir: join(folder, ".voice") });
  const spoken = await voiceAll(ctx);
  assert.ok(spoken.every((s) => s.audio));
  const { placed, broken } = await finalBuild(ctx, spoken);
  assert.deepEqual(broken, {});
  let last = 0;
  const out = await renderVideo(ctx, placed, spoken, (p) => (last = p));
  assert.equal(last, 1);
  const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height", "-of", "csv=p=0", out.path], { encoding: "utf8" });
  assert.match(probe, /video,1080,1920/);
  assert.ok(out.bytes > 10_000);
  assert.deepEqual(out.laid.spans.map((s) => s.id), ["s1", "s2"]);
  assert.equal(out.laid.spans[1]!.startMs, out.laid.spans[0]!.endMs);
  assert.ok(out.laid.timeline.captions.length >= 4);
  assert.ok(out.durationMs > out.laid.spans[1]!.endMs, "the end card follows the scenes");
  assert.match(probe, /audio/);
  assert.deepEqual(out.sound?.music, ["focus"]);
  assert.deepEqual(out.sound?.effects, ["pop"]);
  assert.ok(Math.abs(out.sound!.lufs + 14) < 0.6, `${out.sound!.lufs} LUFS`);
});

test("render makes the real video while the agent works, watch shows its frames with what is said, and finish takes it while nothing changed", async () => {
  const made = await callTool("render", {}, ctx);
  assert.equal(made.isError, undefined, made.text);
  // Put together whole, the video's count is fixed, so a step may say the total.
  assert.equal(ctx.draft.sceneCount, 2);
  assert.match(made.text, /^Cut 1: .*\n(A viewer of this render would notice (one thing|\d+ things); the most noticeable:|viewer_report finds nothing)/);
  assert.ok((made.images?.length ?? 0) >= 1, "render returns phone-size contact sheet");
  assert.match(made.text, /frames of cut 1 below at phone size \(360 pixels wide\)/);
  assert.deepEqual(ctx.draft.made?.seen, [{ cut: 1, how: "render", afterAnswer: true }]);
  assert.equal(ctx.draft.made?.watched, 0, "render sheet does not inflate manual watch count");
  assert.equal(ctx.draft.made?.reportsRead, 0, "render findings do not inflate manual viewer_report count");
  assert.equal(ctx.draft.report, undefined, "render findings do not forge a manual viewer_report entry");
  assert.equal(makingOf(ctx.draft).readReport, false);
  assert.equal(makingOf(ctx.draft).reportsRead, 0);
  assert.equal(makingOf(ctx.draft).renders, 1);
  assert.equal(ctx.draft.seenCut, 1);
  // A backgrounded render completed before finish: finish answers once with the skipped-step fact + phone frames + findings, and records cut 1 as seen so the second finish never claims it wasn't seen.
  const unseenCtx: ToolContext = {
    ...ctx,
    draft: { ...ctx.draft, finishAnswered: undefined, finished: undefined, seenCut: undefined, watchedCut: undefined, report: undefined, made: { ...emptyMaking(), renders: 1, seen: [] } },
  };
  const firstFinish = await callTool("finish", {}, unseenCtx);
  assert.match(firstFinish.text, /^Not handed over yet\. From Open Sourcebook's record of this video:\n- The video was rendered \(cut 1\), but no render was ever watched/);
  assert.match(firstFinish.text, /\nCut 1:\n/);
  assert.ok((firstFinish.images?.length ?? 0) >= 1, "finish carries phone frames too");
  assert.equal(unseenCtx.draft.seenCut, 1);
  assert.deepEqual(unseenCtx.draft.made?.seen, [{ cut: 1, how: "finish", afterAnswer: true }]);
  const secondFinish = await callTool("finish", {}, unseenCtx);
  assert.match(secondFinish.text, /^The video is taken: cut 1/);
  assert.doesNotMatch(secondFinish.text, /You did not watch|not seen/);
  // Unaddressed actionable findings from render's own report also trigger finish's one-time nudge, without touching readReport / reportsRead.
  const renderUnfixedCtx: ToolContext = {
    ...ctx,
    draft: { ...ctx.draft, finishAnswered: undefined, finished: undefined, seenCut: 1, watchedCut: undefined, report: undefined, renderReport: { cut: 1, things: 3, scenes: scenesKey(ctx.draft) }, made: { ...emptyMaking(), renders: 1, seen: [{ cut: 1, how: "render", afterAnswer: false }] } },
  };
  const renderNudge = await callTool("finish", {}, renderUnfixedCtx);
  assert.match(renderNudge.text, /^Not handed over yet\. From Open Sourcebook's record of this video:\n- The viewer report shown with cut 1 listed 3 things a viewer would notice, and no scene has changed since it rendered\./);
  assert.doesNotMatch(renderNudge.text, /no render was ever watched/);
  assert.ok((renderNudge.images?.length ?? 0) >= 1, "finish attaches cut 1 frames on render-report nudge");
  assert.equal(makingOf(renderUnfixedCtx.draft).readReport, false);
  assert.equal(makingOf(renderUnfixedCtx.draft).reportsRead, 0);
  const afterRenderNudge = await callTool("finish", {}, renderUnfixedCtx);
  assert.match(afterRenderNudge.text, /^The video is taken: cut 1/);
  assert.doesNotMatch(afterRenderNudge.text, /You did not watch|not seen/);
  // When render's report had zero actionable findings, finish hands over immediately.
  const renderCleanCtx: ToolContext = {
    ...ctx,
    draft: { ...ctx.draft, finishAnswered: undefined, finished: undefined, seenCut: 1, watchedCut: undefined, report: undefined, renderReport: { cut: 1, things: 0, scenes: scenesKey(ctx.draft) }, made: { ...emptyMaking(), renders: 1, seen: [{ cut: 1, how: "render", afterAnswer: false }] } },
  };
  const cleanFinish = await callTool("finish", {}, renderCleanCtx);
  assert.match(cleanFinish.text, /^The video is taken: cut 1/);
  // When only non-scene state (such as sound) changes after cut 1, finish still attaches cut 1's findings and phone frames.
  const soundAfterRenderCtx: ToolContext = {
    ...ctx,
    draft: {
      ...ctx.draft,
      finishAnswered: undefined,
      finished: undefined,
      seenCut: 1,
      watchedCut: undefined,
      report: undefined,
      renderReport: { cut: 1, things: 3, scenes: scenesKey(ctx.draft) },
      sound: { music: [{ scene: "s1", at: 0, name: "focus", level: -12, why: "later mix" }], effects: [] },
      made: { ...emptyMaking(), renders: 1, seen: [{ cut: 1, how: "render", afterAnswer: false }] },
    },
  };
  assert.equal(currentCut(soundAfterRenderCtx), undefined);
  const soundNudge = await callTool("finish", {}, soundAfterRenderCtx);
  assert.match(soundNudge.text, /^Not handed over yet\. From Open Sourcebook's record of this video:/);
  assert.match(soundNudge.text, /The video has changed since cut 1, the last render \(seen: cut 1\)/);
  assert.match(soundNudge.text, /The viewer report shown with cut 1 listed 3 things a viewer would notice, and no scene has changed since it rendered\./);
  assert.match(soundNudge.text, /\nCut 1:\n/);
  assert.ok((soundNudge.images?.length ?? 0) >= 1, "finish still attaches cut 1 frames when only sound changed");
  const seen = await callTool("watch", {}, ctx);
  assert.equal(seen.isError, undefined, seen.text);
  assert.equal(seen.images?.length, 1);
  assert.match(seen.text, /^Cut 1: \d+\.\d s with the end card/);
  assert.match(seen.text, /It is the video as it stands/);
  assert.match(seen.text, /\n1\. 0\.4 s, s1 \+0\.4 s: "/);
  assert.match(seen.text, /s2 \+\d\.\d s: (pause s2 @h1|")/);
  const cut = ctx.draft.cut!;
  assert.equal(cut.key, cutKey(ctx));
  assert.ok(cut.words.length > 10 && cut.words.every((w, i) => i === 0 || w.start >= cut.words[i - 1]!.start));
  // A stretch, every half second.
  const stretch = await callTool("watch", { from: 1, to: 3 }, ctx);
  assert.match(stretch.text, /5 frames of the mp4 below, left to right and down, from 1\.0 to 3\.0 s/);
  // At phone size: four frames a sheet, each 360 pixels wide; one moment alone.
  const phone = await callTool("watch", { phone: true }, ctx);
  assert.match(phone.text, /at phone size \(360 pixels wide/);
  assert.ok((phone.images?.length ?? 0) >= 2);
  const width = (b64: string) => { const b = Buffer.from(b64, "base64"); for (let i = 2; i < b.length; ) { const m = b[i + 1]!; if (m >= 0xc0 && m <= 0xc2) return b.readUInt16BE(i + 7); i += 2 + b.readUInt16BE(i + 2); } return 0; };
  assert.equal(width(phone.images![0]!.dataBase64), 2 * (360 + 6));
  const moment = await callTool("watch", { at: 1.5, phone: true }, ctx);
  assert.equal(moment.images?.length, 1);
  assert.match(moment.text, /One frame of the mp4 below at phone size/);
  // The viewer report reads this render.
  const report = await callTool("viewer_report", {}, ctx);
  assert.equal(report.isError, undefined, report.text);
  assert.match(report.text, /^The viewer report for cut 1 \(0:\d\d\.\d with the end card, the video as it stands\)/);
  assert.match(report.text, /Reads fine: /);
  assert.equal(makingOf(ctx.draft).readReport, true);
  assert.equal(makingOf(ctx.draft).reportsRead, 1);
  // Nothing changed: render says so, and finish takes this cut.
  assert.match((await callTool("render", {}, ctx)).text, /Nothing changed since the last render/);
  const taken = (await callTool("finish", {}, ctx)).text;
  assert.match(taken, /cut 1, as you last rendered it/);
  assert.doesNotMatch(taken, /not seen/, "it was watched");
  // A change makes the cut stale, and finish says the video is rendered again after.
  await callTool("about_video", { title: "Levers, plainly" }, ctx);
  assert.notEqual(cutKey(ctx), cut.key);
  assert.match((await callTool("watch", {}, ctx)).text, /The video has changed since this cut/);
  assert.match((await callTool("finish", {}, ctx)).text, /voiced and rendered as it stands after you stop/);
});

test("videoSoFar notes factually when most beats run the same shelf piece", async () => {
  const sameCtx: ToolContext = { ...ctx, voice: silentVoice(), draft: emptyDraft() };
  await callTool("write_beat", { ...beat(0), source: "@0\nrun bars b w=800 h=900" }, sameCtx);
  await callTool("write_beat", { ...beat(1), source: "@0\nrun bars b w=800 h=900" }, sameCtx);
  const third = await callTool("write_beat", { ...beat(0), source: "@0\nrun bars b w=800 h=900" }, sameCtx);
  assert.equal(third.isError, undefined, third.text);
  assert.match(third.text, /All 3 beats so far use the same piece, bars\./);
  const varied = await callTool("write_beat", { beat: "s2", source: "@0\nrun counter c w=800 h=900" }, sameCtx);
  assert.equal(varied.isError, undefined, varied.text);
  assert.doesNotMatch(varied.text, /use the same piece/);
});

test("a scene's step says which scene while the beats are written, and \"of N\" only once the whole video's count is fixed", async () => {
  const said: string[] = [];
  const fresh: ToolContext = { ...ctx, draft: emptyDraft(), step: (label) => said.push(label) };
  await callTool("write_beat", beat(0), fresh);
  await callTool("write_beat", beat(1), fresh);
  assert.deepEqual(said, ["Drawing scene 1", "Drawing scene 2"]);
  assert.equal(stepNumber(fresh.draft, "s2"), "2");
  // As a render or finish leaves it: the video was put together whole with two scenes.
  fresh.draft.sceneCount = 2;
  await callTool("write_beat", { beat: "s1", visual: "A bar on a small wedge." }, fresh);
  assert.equal(said.at(-1), "Drawing scene 1 of 2");
  // A new beat makes the total unknown again.
  await callTool("write_beat", beat(0), fresh);
  assert.equal(said.at(-1), "Drawing scene 3");
  assert.equal(fresh.draft.sceneCount, undefined);
  fresh.draft.sceneCount = 2;
  assert.equal(stepNumber(fresh.draft, "s3"), "3", "a count from before a beat was added is never said");
});
