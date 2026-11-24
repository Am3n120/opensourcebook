/** The skills' pages given whole to the video agent at the start of a turn, in its system prompt. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { useChrome } from "../src/chrome.ts";
import { GIVEN_PAGES, knowledgeFromEnv, pieceLine, replaceSection, shelfList, tokens } from "../src/knowledge.ts";
import { forVideo, notGiven, systemPrompt, turnPrompt } from "../src/prompt.ts";
import { shelf } from "../src/shelf.ts";
import { examples, readSkill } from "../src/skills.ts";
import { listStyles } from "../src/styles.ts";

useChrome();

const request = (style = "chalkboard") =>
  ({ title: "How a siphon works", brief: "", assumes: [], frame: { width: 1080, height: 1920 }, targetSeconds: 45, style, passages: [{ id: "p1", sourceId: "s", sourceTitle: "Notes", text: "A siphon moves water uphill and over." }], limits: { minScenes: 2, maxScenes: 12, narrationMaxChars: 600, visualMinChars: 20, visualMaxChars: 700, onScreenTextMax: 4 } }) as never;

const built = (style = "chalkboard", workspace: "files" | "full" | undefined = "files") => {
  const video = forVideo(request(style), style === "auto" ? listStyles()[0]!.id : style);
  return { video, prompt: systemPrompt(workspace, [], { video, style: style === "auto" ? listStyles()[0]!.id : style, open: style === "auto" }) };
};

/** A page's paragraphs, without its front matter and the parts the prompt says are elsewhere. */
function paragraphs(path: string, text: string): string[] {
  let body = text.replace(/^---\n[\s\S]*?\n---\n+/, "");
  if (path === "make-a-video/SKILL.md") body = replaceSection(body, "What Open Sourcebook needs from a video", "");
  if (path === "teaching/SKILL.md") body = replaceSection(body, "More in this skill", "");
  if (path === "make-a-video/references/scene-language.md") body = body.replace(`\n${shelfList()}\n`, "\n");
  return body.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
}

test("every page listed as given is in the built system prompt, whole, each with the file it is", () => {
  const { video, prompt } = built();
  assert.deepEqual(GIVEN_PAGES, [
    "make-a-video/references/what-viewers-notice.md",
    "teaching/SKILL.md",
    "teaching/references/attention.md",
    "teaching/references/craft.md",
    "teaching/references/demonstrate.md",
    "teaching/references/art-direction.md",
    "make-a-video/SKILL.md",
    "make-a-video/references/scene-language.md",
  ]);
  for (const path of GIVEN_PAGES) {
    assert.ok(prompt.includes(`<page file="skills/${path}">`), `${path} is not marked in the system prompt`);
    const [skill, ...rest] = path.split("/");
    const text = readSkill(skill!, rest.join("/"), video);
    assert.ok(text, `${path} could not be read`);
    for (const p of paragraphs(path, text)) assert.ok(prompt.includes(p), `${path} is missing from the system prompt: "${p.slice(0, 120)}"`);
  }
});

test("the pages come in the order that serves the agent: viewers, explaining, the tools, then the scene language set apart as reference", () => {
  const { prompt } = built();
  const at = (path: string) => prompt.indexOf(`<page file="skills/${path}">`);
  const order = GIVEN_PAGES.map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(prompt.indexOf("# What Open Sourcebook needs") < at(GIVEN_PAGES[0]!), "the starting instructions come first");
  assert.ok(prompt.indexOf("## The pieces on the shelf") > at("make-a-video/SKILL.md"));
  assert.ok(prompt.indexOf("## The pieces on the shelf") < prompt.indexOf("## Reference: the scene language"));
  assert.match(prompt, /## Reference: the scene language\n\nEverything below is reference/);
  // What Open Sourcebook needs is said once, at the top; the video page says where it is.
  assert.equal(prompt.split("Every beat stands on the passages").length, 2);
  assert.match(prompt, /## What Open Sourcebook needs from a video\n\nAs under What Open Sourcebook needs at the top of these instructions\./);
  for (const heading of ["# Programs", "# How things move", "# Things as themselves", "# A board", "# Readable", "# Craft"]) {
    assert.ok(prompt.includes(`\n${heading}\n`), `core syntax and guidance ${heading} stays whole`);
  }
  assert.ok(prompt.includes("Emphasis costs what it takes away"), "scene-language Craft section stays whole");
  assert.ok(prompt.includes("A stop from the person ends the work"), "make-a-video How the pieces fit stays whole");
  assert.doesNotMatch(prompt, /nothing checks it|knowledge to weigh, not rules|How you go about it is yours/);
});

test("the shelf is listed once, a line each from each piece's own about, with no rule to use one", () => {
  const { prompt } = built();
  const pieces = shelf();
  assert.ok(pieces.length > 10);
  for (const p of pieces) {
    assert.ok(prompt.includes(`- ${pieceLine(p)}`), `${p.name} is not listed`);
    assert.equal(prompt.split(`- ${pieceLine(p)}`).length, 2, `${p.name} is listed more than once`);
    assert.ok(pieceLine(p).endsWith(p.doc));
  }
  const part = prompt.slice(prompt.indexOf("## The pieces on the shelf"), prompt.indexOf("## Reference: the scene language"));
  assert.doesNotMatch(part.split("\n- ")[0]!, /\b(must|should|always|search|find_piece)\b/i, "awareness only: nothing tells the agent to search or use one");
});

test("the rest of the skills stay files to open, listed by path, and are not given whole", () => {
  const { video, prompt } = built();
  const rest = notGiven(video);
  for (const f of ["make-a-video/references/depicting.md", "make-a-video/references/examples.md", "make-a-video/references/a-session.md", "make-a-video/references/simulation.md", "make-a-video/references/whiteboard.md", "make-a-video/references/worked-math.md", "media/SKILL.md"]) {
    assert.ok(rest.includes(f), `${f} should be left as a file`);
    assert.ok(prompt.includes(`- ${f}\n`), `${f} is not listed to open`);
    assert.ok(!prompt.includes(`<page file="skills/${f}">`));
  }
  for (const e of examples()) assert.ok(!prompt.includes(e.source.trim()), `the example ${e.name} is not given whole`);
  assert.ok(!prompt.includes(readSkill("media", undefined, video)!.split("\n").slice(6, 10).join("\n")), "media is not given");
});

test("a style left open says the scene language is for the first style until one is picked; a set style says it is this video's", () => {
  assert.match(built("auto").prompt, /written for the style \w+, the first one, as none is picked yet/);
  assert.match(built("ink").prompt, /written for this video's style, ink, and this frame/);
});

test("the setting turns the pages off, back to the index alone; on by default", () => {
  assert.equal(knowledgeFromEnv({}), true);
  assert.equal(knowledgeFromEnv({ SCENES_AGENT_KNOWLEDGE: "" }), true);
  assert.equal(knowledgeFromEnv({ SCENES_AGENT_KNOWLEDGE: "index" }), false);
  assert.equal(knowledgeFromEnv({ SCENES_AGENT_KNOWLEDGE: "off" }), false);
  const index = systemPrompt("files");
  assert.doesNotMatch(index, /<page file=/);
  assert.match(index, /in skills\/ in your folder, as files/);
});

test("the system prompt fits in one command-line argument everywhere the agents run (Linux takes 128 KiB at most per argument)", () => {
  const { prompt } = built("auto", undefined);
  const bytes = Buffer.byteLength(prompt);
  assert.ok(bytes < 120_000, `the system prompt is ${bytes} bytes, too near the 131072 one argument can hold on Linux; pass it as a file`);
  assert.ok(tokens(prompt) > 15_000, "the pages are given whole, not condensed");
});

test("a set style reaches the first message with its description, its own line on how a scene in it looks, and its leanings", () => {
  const first = turnPrompt(request("chalkboard"), listStyles());
  assert.match(first, /Style: chalkboard\. A teacher's slate/);
  assert.match(first, /How a scene in it looks, in its own words: Chalk drawing on a dark green classroom chalkboard/);
  const open = turnPrompt(request("auto"), listStyles());
  assert.match(open, /Style: yours to pick/);
  for (const s of listStyles()) assert.ok(open.includes(`- ${s.id} (${s.label}): ${s.description}`));
});
