/** Skills sent with a video (a project's packs) reach the video agent: in its folder, its instructions and read_skill. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forVideo, systemPrompt, turnPrompt } from "../src/prompt.ts";
import { readRequest } from "../src/request.ts";
import { readSkill, writeSkills } from "../src/skills.ts";

const body = (skills?: unknown) => ({
  id: "v1",
  title: "A video",
  passages: [{ id: "p1", sourceId: "s1", sourceTitle: "Notes", text: "Some words." }],
  ...(skills !== undefined ? { skills } : {}),
});
const pack = { name: "made-up-pack", files: { "SKILL.md": "---\nname: made-up-pack\ndescription: Knowledge for a made-up kind of work.\n---\n\n# Made-up pack\n\nWhat helps here.", "references/more.md": "More of it." } };

test("a request may carry extra skills by folder, each with its files; a bad one is refused with what is wrong", () => {
  const ok = readRequest(body([pack]), ["chalkboard"]);
  assert.ok("request" in ok);
  assert.deepEqual(ok.request.skills, [pack]);
  const none = readRequest(body(), ["chalkboard"]);
  assert.ok("request" in none && none.request.skills === undefined, "a request without skills is as before");
  const bad = readRequest(body([{ name: "../up", files: { "../x.md": "x" } }]), ["chalkboard"]);
  assert.ok("problems" in bad);
  assert.match(bad.problems.join(" "), /skills\[0\]\.name/);
  assert.match(bad.problems.join(" "), /needs a SKILL\.md/);
});

test("a sent skill is written into the agent's folder, listed in its instructions and the turn, and read by read_skill", () => {
  const read = readRequest(body([pack]), ["chalkboard"]);
  assert.ok("request" in read);
  const video = forVideo(read.request, "chalkboard");
  const dir = mkdtempSync(join(tmpdir(), "skills-sent-"));
  try {
    writeSkills(dir, video);
    assert.match(readFileSync(join(dir, "made-up-pack", "SKILL.md"), "utf8"), /# Made-up pack/);
    assert.equal(readFileSync(join(dir, "made-up-pack", "references", "more.md"), "utf8"), "More of it.");
    assert.ok(existsSync(join(dir, "teaching", "SKILL.md")), "the service's own skills are still there");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(systemPrompt("files", read.request.skills), /- made-up-pack: Knowledge for a made-up kind of work\./);
  assert.match(turnPrompt(read.request, []), /packs on[\s\S]*made-up-pack/);
  assert.equal(readSkill("made-up-pack", "references/more.md", video), "More of it.");
  // Without it, nothing of it shows.
  const plain = readRequest(body(), ["chalkboard"]);
  assert.ok("request" in plain);
  assert.doesNotMatch(turnPrompt(plain.request, []), /packs on/);
  assert.equal(readSkill("made-up-pack", undefined, forVideo(plain.request, "chalkboard")), undefined);
});
