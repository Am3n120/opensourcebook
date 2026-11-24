/** The record of how a video was made, written by Open Sourcebook from the calls it answered, never asked of the agent. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FACTS_HEAD, emptyMaking, factsOf, makingText, noteCall, piecesIn, seenByCut, seenWords, withDefaults } from "../src/making.ts";

const ok = (text = "fine") => ({ text });
const no = (text = "not taken") => ({ text, isError: true });

test("each answered call is noted as what it was: passages, beats, looks, renders, watching, the report, pieces, sound, finish", () => {
  const log = emptyMaking();
  noteCall(log, "read_passages", { ids: ["p1", "p2"] }, ok());
  noteCall(log, "read_passages", { ids: ["p1"] }, ok());
  noteCall(log, "read_skill", { skill: "media" }, ok());
  noteCall(log, "read_skill", { skill: "make-a-video", file: "references/depicting.md" }, ok());
  noteCall(log, "read_skill", { skill: "nope" }, no());
  noteCall(log, "write_beat", { narration: "A lever.", source: "@0" }, ok(), "s1");
  noteCall(log, "write_beat", { narration: "Bad." }, no());
  noteCall(log, "write_beat", { beat: "s1" }, ok(), "s1");
  noteCall(log, "look", { scene: "s1" }, ok());
  noteCall(log, "watch", {}, ok("Nothing is rendered yet (render makes the real video). From the builds instead: one sheet"));
  noteCall(log, "render", {}, ok("Cut 1: 12.0 s with the end card"));
  noteCall(log, "render", {}, ok("Nothing changed since the last render.\nCut 1: ..."));
  noteCall(log, "render", {}, ok("A render is already running (40% of its frames"));
  noteCall(log, "watch", {}, ok("Cut 1: 12.0 s with the end card, 9.0 s spoken."));
  noteCall(log, "find_piece", { want: "two sides weighed" }, ok());
  noteCall(log, "find_piece", { name: "balance" }, ok());
  noteCall(log, "write_beat", { source: "@0\nrun balance b" }, ok(), "s2");
  noteCall(log, "viewer_report", {}, ok("Still rendering after waiting 110 s: 40% of its frames"));
  noteCall(log, "viewer_report", {}, ok("The viewer report for cut 1 (0:12.0 with the end card, the video as it stands)."));
  noteCall(log, "write_beat", { beat: "s2", source: "@0\nrun balance b left=A" }, ok(), "s2");
  noteCall(log, "sound", { music: [], effects: [] }, ok());
  noteCall(log, "finish", {}, ok("Not handed over yet."));
  noteCall(log, "finish", {}, ok("The video is taken."));
  assert.deepEqual(log, {
    passagesRead: ["p1", "p2"],
    skillsRead: ["media/SKILL.md", "make-a-video/references/depicting.md"],
    beatsWritten: 3,
    beatsRefused: 1,
    looks: 1,
    renders: 1,
    watched: 1,
    watchedBuilds: 1,
    reportsRead: 1,
    changedAfterReport: ["s2"],
    changedAfterRender: [],
    piecesSearched: ["two sides weighed", "name: balance"],
    piecesSearchedBeforeFirstBeat: false,
    picturesSearched: [],
    picturesKept: [],
    soundPlaced: 1,
    finishCalls: 2,
    calls: { read_passages: 2, read_skill: 3, write_beat: 5, look: 1, watch: 2, render: 3, find_piece: 2, viewer_report: 2, sound: 1, finish: 2 },
    seen: [
      { cut: 1, how: "watch", afterAnswer: false },
      { cut: 1, how: "report", afterAnswer: false },
    ],
  });
});

test("the picture tools are in the record: what find_images was asked, what was kept, and every tool by its count", () => {
  const log = emptyMaking();
  noteCall(log, "find_images", { query: "pin tumbler lock cutaway" }, ok('Nothing found for "pin tumbler lock cutaway".'));
  noteCall(log, "find_images", { query: "door lock cylinder keyhole" }, ok("4 pictures"));
  noteCall(log, "view_images", { from: ["c3"] }, ok());
  noteCall(log, "save_image", { from: "c3", name: "cylinder_photo" }, ok("Kept as cylinder_photo"));
  noteCall(log, "save_image", { from: "c9", name: "bad name" }, no());
  noteCall(log, "generate_image", { prompt: "a key", name: "key_art" }, ok());
  noteCall(log, "cut_out", { asset: "key_art", thing: "key", name: "key_cut" }, ok());
  noteCall(log, "web_search", { query: "lock" }, ok());
  assert.deepEqual(log.picturesSearched, ["pin tumbler lock cutaway", "door lock cylinder keyhole"]);
  assert.deepEqual(log.picturesKept, ["cylinder_photo", "key_art", "key_cut"]);
  assert.deepEqual(log.calls, { find_images: 2, view_images: 1, save_image: 2, generate_image: 1, cut_out: 1, web_search: 1 });
  const line = makingText({ ...log, beats: 0, piecesUsed: [], watchedRender: false, readReport: false, finishAnswered: false });
  assert.match(line, /pictures searched: "pin tumbler lock cutaway", "door lock cylinder keyhole"; pictures kept: cylinder_photo, key_art, key_cut;/);
  assert.match(line, /tools answered: find_images 2, view_images 1, save_image 2, generate_image 1, cut_out 1, web_search 1$/);
});

test("finish's one answer with facts is kept whole in the record, and its facts are in the record's line", () => {
  const log = emptyMaking();
  const answer = `${FACTS_HEAD}\n- The video was rendered (cut 1), but no render was ever watched and its viewer report was never read.\n- The viewer report for cut 1 listed 3 things a viewer would notice, and no scene has changed since it was read.\nOpen Sourcebook says this once. Calling finish again hands the video over as it is.`;
  noteCall(log, "finish", {}, ok(answer));
  noteCall(log, "finish", {}, ok("The video is taken: cut 1, as you last rendered it. Stop now."));
  assert.equal(log.finishAnswer, answer);
  const line = makingText({ ...log, beats: 1, piecesUsed: [], watchedRender: false, readReport: false, finishAnswered: true });
  assert.match(line, /finish called 2 times, answered once with facts \(The video was rendered \(cut 1\), but no render was ever watched and its viewer report was never read\. The viewer report for cut 1 listed 3 things a viewer would notice, and no scene has changed since it was read\.\);/);
});

test("finish's answer and the record agree, from one record of what was seen: which cut, and whether before or after the answer", () => {
  // As in a run where finish said nothing had been read, then the report was read, then finish took the video.
  const log = emptyMaking();
  noteCall(log, "render", {}, ok("Cut 1: 113.8 s with the end card"));
  const answer = `${FACTS_HEAD}\n- The video was rendered (cut 1), but no render was ever watched and its viewer report was never read.\nOpen Sourcebook says this once. Calling finish again hands the video over as it is.`;
  noteCall(log, "finish", {}, ok(answer));
  noteCall(log, "viewer_report", {}, ok("The viewer report for cut 1 (1:53.8 with the end card, the video as it stands)."));
  noteCall(log, "finish", {}, ok("The video is taken: cut 1, as you last rendered it. Stop now."));
  const line = makingText({ ...log, beats: 7, piecesUsed: [], watchedRender: false, readReport: true, finishAnswered: true, handedOver: 1 });
  assert.match(line, /the viewer report read 1 time; seen: cut 1 its viewer report read 1 time \(after finish's answer\); the person got cut 1, its viewer report read;/);
  // A report read of an earlier cut, and the person given a later one: the record says which.
  const two = emptyMaking();
  noteCall(two, "viewer_report", {}, ok("The viewer report for cut 1 (0:20.0 with the end card)."));
  assert.match(makingText({ ...two, beats: 2, piecesUsed: [], watchedRender: false, readReport: true, finishAnswered: false, handedOver: 2 }), /seen: cut 1 its viewer report read 1 time; the person got cut 2, never watched nor its viewer report read;/);
  assert.match(makingText({ ...two, beats: 2, piecesUsed: [], watchedRender: false, readReport: true, finishAnswered: false, handedOver: "after" }), /the person got a render Open Sourcebook made after the turn, which nobody watched;/);
});

test("a record kept by an older version reads with what it did not keep as empty", () => {
  const old = { passagesRead: ["p1"], skillsRead: [], beatsWritten: 1, beatsRefused: 0, looks: 0, renders: 0, watched: 0, watchedBuilds: 0, reportsRead: 0, changedAfterReport: [], piecesSearched: [], soundPlaced: 0, finishCalls: 0 };
  const log = withDefaults(old as Partial<ReturnType<typeof emptyMaking>>);
  noteCall(log, "find_images", { query: "x" }, ok());
  assert.deepEqual(log.picturesSearched, ["x"]);
  assert.deepEqual(log.calls, { find_images: 1 });
});

test("the pieces used are the shelf's pieces the scenes run, once each", () => {
  assert.deepEqual(piecesIn(["@0\nrun balance b left=A\n@3 keep\nrun mine m", "@0\n  run timeline t dates=1|2", "@0\nrun balance c"], ["balance", "timeline"]), ["balance", "timeline"]);
});

test("the record reads as one line for the log, saying what was and was not done", () => {
  const line = makingText({ ...emptyMaking(), passagesRead: ["p1"], beatsWritten: 2, renders: 1, finishCalls: 2, beats: 2, piecesUsed: [], watchedRender: false, readReport: false, finishAnswered: true });
  assert.match(line, /^passages read: p1; skill files read with read_skill: none; 2 beats written, 2 in the video; 0 looks; 1 render; no render watched; the viewer report never read; pieces searched: none; pieces used: none; pictures searched: none; pictures kept: none; no sound placed; finish called 2 times, answered once with facts; tools answered: none$/);
});

test("seen by render stays apart from manual watch/report counts, still tracks changes after, and notes pre-first-beat piece searches", () => {
  const early = emptyMaking();
  noteCall(early, "find_piece", { want: "steps in order" }, ok());
  assert.equal(early.piecesSearchedBeforeFirstBeat, true);
  early.seen.push({ cut: 1, how: "render", afterAnswer: false });
  noteCall(early, "write_beat", { beat: "s1", source: "@0" }, ok(), "s1");
  assert.deepEqual(early.changedAfterReport, []);
  assert.deepEqual(early.changedAfterRender, ["s1"]);
  assert.equal(early.watched, 0);
  assert.equal(early.reportsRead, 0);
  assert.deepEqual(seenByCut(early.seen).get(1), { watched: 0, reports: 0, rendered: 1, finished: 0, afterAnswer: false });
  assert.equal(seenWords(early.seen), "cut 1 shown by render 1 time");
  const line = makingText({ ...early, beats: 1, piecesUsed: [], watchedRender: false, readReport: false, finishAnswered: false, handedOver: 1 });
  assert.match(line, /no render watched; the viewer report never read; seen: cut 1 shown by render 1 time; the person got cut 1, shown by render; beats changed after a shown render: s1; pieces searched: "steps in order" \(before first beat\);/);
  assert.doesNotMatch(line, /beats changed after the report/);

  const late = emptyMaking();
  noteCall(late, "write_beat", { narration: "Step one.", source: "@0" }, ok(), "s1");
  noteCall(late, "find_piece", { want: "steps" }, ok());
  assert.equal(late.piecesSearchedBeforeFirstBeat, false);

  const fromRender = emptyMaking();
  noteCall(fromRender, "render", {}, { text: "Cut 1: 12.0 s with the end card\nA viewer of this render would notice one thing; the most noticeable:\n- something", images: [{ mimeType: "image/jpeg", dataBase64: "AA==" }] });
  assert.equal(fromRender.renders, 1);
  assert.equal(fromRender.watched, 0);
  assert.equal(fromRender.reportsRead, 0);
  assert.deepEqual(fromRender.seen, [{ cut: 1, how: "render", afterAnswer: false }]);

  const bg = emptyMaking();
  noteCall(bg, "render", {}, ok("Rendering in the background (35% of its frames so far). Keep working if you like; watch waits for it and shows it."));
  assert.equal(bg.renders, 1);
  assert.deepEqual(bg.seen, []);
  assert.equal(bg.watched, 0);
  assert.equal(bg.reportsRead, 0);

  const fromFinish = emptyMaking();
  const finishText = `${FACTS_HEAD}\n- The video was rendered (cut 1), but no render was ever watched and its viewer report was never read.\nOpen Sourcebook says this once. Calling finish again hands the video over as it is.\nCut 1:\nA viewer of this render would notice one thing:\n- A finding`;
  noteCall(fromFinish, "finish", {}, { text: finishText, images: [{ mimeType: "image/jpeg", dataBase64: "AA==" }] });
  assert.equal(fromFinish.finishCalls, 1);
  assert.deepEqual(fromFinish.seen, [{ cut: 1, how: "finish", afterAnswer: true }]);
  assert.equal(seenWords(fromFinish.seen), "cut 1 shown by finish 1 time (after finish's answer)");
  assert.deepEqual(factsOf(fromFinish.finishAnswer!), ["The video was rendered (cut 1), but no render was ever watched and its viewer report was never read."]);
  noteCall(fromFinish, "write_beat", { beat: "s1", source: "@0" }, ok(), "s1");
  assert.deepEqual(fromFinish.changedAfterReport, []);
  assert.deepEqual(fromFinish.changedAfterRender, ["s1"]);
});
