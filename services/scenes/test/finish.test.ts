/**
 * finish answers once a video with the facts from Open Sourcebook's own record when a step was skipped, and never otherwise; the
 * next finish always hands the video over. The drafts here are written by hand: nothing is built or rendered.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listStyles } from "../src/styles.ts";
import { callTool, emptyDraft, renders, scenesKey, skippedSteps, type Draft, type ToolContext } from "../src/tools.ts";
import { cutKey } from "../src/cut.ts";
import { emptyMaking } from "../src/making.ts";
import { voiceFromEnv } from "../src/voice.ts";

const folder = mkdtempSync(join(tmpdir(), "opensourcebook-scenes-finish-"));
after(() => rmSync(folder, { recursive: true, force: true }));

const scene = (id: string, narration: string) => ({ id, narration, onScreenText: [], visual: "a lever on a rock lifts a heavy stone", cites: [] });

function ctxWith(more: Partial<Draft> = {}): ToolContext {
  const draft: Draft = {
    ...emptyDraft(),
    script: { title: "Levers", idea: "A push far away lifts a load near.", scenes: [scene("s1", "A lever turns on one point."), scene("s2", "Push far from it and the load rises.")] },
    scenes: { s1: { source: "@0\ntext t \"Lever\"", built: true, looked: true, writes: 1, looks: 1 }, s2: { source: "@0\ntext t \"Push\"", built: true, looked: false, writes: 1, looks: 0 } },
    ...more,
  };
  const request = { id: "f1", title: "Levers", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 20, style: "flat", passages: [], limits: { minScenes: 1, maxScenes: 12, narrationMaxChars: 600, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4 } } as never;
  return { request, draft, folder: join(folder, String(Math.random()).slice(2)), styles: listStyles(), voice: voiceFromEnv({}), step: () => undefined, save: () => undefined };
}

const cut = (number: number) => ({ number, key: "old", file: "cut.mp4", durationMs: 20_000, renderMs: 1, spans: [], words: [], voice: { id: "silent", label: "No voice", real: false } }) as unknown as Draft["cut"];

test("never rendered: finish answers once with that fact, does not end, and the next finish hands the video over", async () => {
  const ctx = ctxWith();
  assert.deepEqual(skippedSteps(ctx), ["The video was never rendered: it has not existed yet as the viewer will meet it, with the real voice and its pace, the cuts and the captions."]);
  const first = await callTool("finish", {}, ctx);
  assert.equal(first.isError, undefined, "an answer, not a refusal");
  assert.equal(first.text, "Not handed over yet. From Open Sourcebook's record of this video:\n- The video was never rendered: it has not existed yet as the viewer will meet it, with the real voice and its pace, the cuts and the captions.\nOpen Sourcebook says this once. Calling finish again hands the video over as it is.");
  assert.doesNotMatch(first.text, /\?/, "facts, never a question");
  assert.equal(ctx.draft.finished, undefined, "the video is not handed over yet");
  assert.equal(ctx.draft.finishAnswered, true);
  const second = await callTool("finish", {}, ctx);
  assert.match(second.text, /^The video is taken/);
  assert.deepEqual(ctx.draft.finished, {});
  // Once a video, never a loop: a later finish, after more changes, goes straight through.
  delete ctx.draft.finished;
  assert.match((await callTool("finish", {}, ctx)).text, /^The video is taken/);
});

test("rendered but never watched and its report never read is said; watching it or reading the report is enough to say nothing", async () => {
  const unseen = ctxWith({ cut: cut(2) });
  assert.deepEqual(skippedSteps(unseen), ["The video was rendered (cut 2), but no render was ever watched and its viewer report was never read."]);
  assert.match((await callTool("finish", {}, unseen)).text, /^Not handed over yet\.[\s\S]*cut 2\), but no render was ever watched/);
  const watched = ctxWith({ cut: cut(2), watchedCut: 2, seenCut: 2 });
  watched.draft.cut!.key = cutKey(watched);
  assert.deepEqual(skippedSteps(watched), []);
  const read = ctxWith({ cut: cut(2), seenCut: 2 });
  read.draft.cut!.key = cutKey(read);
  read.draft.report = { cut: 2, things: 0, scenes: scenesKey(read.draft) };
  assert.deepEqual(skippedSteps(read), []);
});

test("a viewer report that listed things, with no scene changed since, is said; a changed scene, or an empty report, says nothing", async () => {
  const ctx = ctxWith({ cut: cut(1), seenCut: 1 });
  ctx.draft.cut!.key = cutKey(ctx);
  ctx.draft.report = { cut: 1, things: 3, scenes: scenesKey(ctx.draft) };
  assert.deepEqual(skippedSteps(ctx), ["The viewer report for cut 1 listed 3 things a viewer would notice, and no scene has changed since it was read."]);
  ctx.draft.report.things = 1;
  assert.match(skippedSteps(ctx)[0]!, /listed one thing a viewer would notice/);
  // A beat's picture changed after the report: that step was not skipped. What is left is that the changed video, the
  // one the person would get, has not been seen.
  ctx.draft.scenes.s2!.source = "@0\ntext t \"Push harder\"";
  assert.deepEqual(skippedSteps(ctx), ["The video has changed since cut 1, the last render (seen: cut 1): what the person would get is rendered after you stop, and nobody has seen it."]);
  // So did its words.
  const words = ctxWith({ cut: cut(1), seenCut: 1 });
  words.draft.report = { cut: 1, things: 2, scenes: scenesKey(words.draft) };
  words.draft.script!.scenes[0]!.narration = "A lever turns on one fixed point.";
  assert.ok(!skippedSteps(words).some((f) => f.includes("listed")));
  // Nothing skipped: finish hands the video over at once, with no answer first.
  const clean = ctxWith({ cut: cut(1), watchedCut: 1, seenCut: 1 });
  clean.draft.cut!.key = cutKey(clean);
  clean.draft.report = { cut: 1, things: 0, scenes: scenesKey(clean.draft) };
  assert.match((await callTool("finish", {}, clean)).text, /^The video is taken/);
  assert.equal(clean.draft.finishAnswered, undefined);
});

test("a render still running, with nothing seen yet, is said with how far it is and that watch and the report wait for it", async () => {
  const ctx = ctxWith();
  renders.set(ctx.folder, { started: Date.now(), progress: 0.42, done: Promise.resolve() });
  try {
    const answer = await callTool("finish", {}, ctx);
    assert.match(answer.text, /^Not handed over yet\. From Open Sourcebook's record of this video:\n- A render is still running \(42% of its frames\), and nothing of any render has been seen yet\. watch and viewer_report wait for it\.\n/);
    // An earlier render watched: nothing was skipped, the running one aside.
    const seen = ctxWith({ cut: cut(1), watchedCut: 1, seenCut: 1 });
    renders.set(seen.folder, { started: Date.now(), progress: 0.5, done: Promise.resolve() });
    assert.deepEqual(skippedSteps(seen), []);
    renders.delete(seen.folder);
  } finally {
    renders.delete(ctx.folder);
  }
});

test("something seen of an earlier render, not of the one the person would get, is said with which was seen", async () => {
  // Cut 1's report was read; then the video changed and cut 2 was rendered and is the video as it stands.
  const ctx = ctxWith({ cut: cut(2), made: { ...emptyMaking(), seen: [{ cut: 1, how: "report", afterAnswer: false }] } });
  ctx.draft.cut!.key = cutKey(ctx);
  assert.deepEqual(skippedSteps(ctx), ["Cut 2, the video as it stands and the file the person would get, was never watched and its viewer report never read; what was seen was cut 1, an earlier render."]);
  // Watching cut 2 is enough.
  ctx.draft.made!.seen.push({ cut: 2, how: "watch", afterAnswer: false });
  assert.deepEqual(skippedSteps(ctx), []);
  // The video changed after the last render that was seen: what the person gets is rendered after the turn, unseen.
  const changed = ctxWith({ cut: cut(2), made: { ...emptyMaking(), seen: [{ cut: 2, how: "watch", afterAnswer: false }] } });
  assert.deepEqual(skippedSteps(changed), ["The video has changed since cut 2, the last render (seen: cut 2): what the person would get is rendered after you stop, and nobody has seen it."]);
});

test("a finish refused because a beat does not build is the old refusal, and does not use up the one answer", async () => {
  const ctx = ctxWith();
  ctx.draft.scenes.s2!.built = false;
  const refused = await callTool("finish", {}, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^Not yet:/);
  assert.equal(ctx.draft.finishAnswered, undefined);
});
