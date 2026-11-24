/**
 * The skills the agent works with: folders under `skills/`, each a SKILL.md (a name and a line on when it helps, then
 * the knowledge) with references beside it. make-a-video is how an Open Sourcebook video is made with the tools, the scene language
 * and a cookbook of worked scenes; teaching is how to explain; media is the voice, pictures and sound. None of it is a
 * rule: the agent reads what serves the video it is making, as files in its own folder when it has one, or through
 * `read_skill`. A few references are written for the video at hand (the scene language for its style, the depicter's
 * kinds, the cookbook's index) and exist only as the agent reads them.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { DEPICTER_SYSTEM } from "../engine/design/depict/depicter.ts";
import type { ExtraSkill } from "./request.ts";
import type { PropSpec } from "../engine/design/depict/spec.ts";

export const SKILLS = join(import.meta.dirname, "../skills");
const EXAMPLES = join(SKILLS, "make-a-video", "references", "examples");

export interface Skill {
  name: string;
  /** When it helps, in a line: what the agent sees before it opens the skill. */
  description: string;
}

/** Reads a SKILL.md's front matter: its name and description. */
export function frontMatter(text: string): Skill | undefined {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (!block) return undefined;
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
  const name = field("name");
  const description = field("description");
  return name && description ? { name, description } : undefined;
}

export function skills(): Skill[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SKILLS, e.name, "SKILL.md")))
    .map((e) => frontMatter(readFileSync(join(SKILLS, e.name, "SKILL.md"), "utf8")))
    .filter((s): s is Skill => !!s)
    .sort((a, b) => (a.name === "make-a-video" ? -1 : b.name === "make-a-video" ? 1 : a.name.localeCompare(b.name)));
}

/** The skills sent with a video (a project's packs), as their SKILL.md names and describes them; a skill named like one of the service's own is passed over. */
export function extraSkills(extra: readonly ExtraSkill[] = []): Skill[] {
  const own = new Set(skills().map((s) => s.name));
  return extra
    .filter((x) => !own.has(x.name))
    .map((x) => {
      const about = frontMatter(x.files["SKILL.md"] ?? "");
      return about ? { name: x.name, description: about.description } : undefined;
    })
    .filter((s): s is Skill => !!s);
}

/** The skills, a line each, for the instructions: the service's own, then any sent with the video. */
export const skillIndex = (extra: readonly ExtraSkill[] = []) => [...skills(), ...extraSkills(extra)].map((s) => `- ${s.name}: ${s.description}`).join("\n");

export interface Example {
  name: string;
  title: string;
  /** What the example shows, in a line. */
  about: string;
  /** The narration the scene is timed to; `@N` is its N-th word, from 0. */
  narration: string;
  source: string;
  /** The depicted things' specs, as the agent sends them with write_beat. */
  depictions: { id: string; desc: string; spec: PropSpec }[];
  /** The whole file, as the agent reads it. */
  text: string;
}

/** Reads one cookbook file: a `# Title`, a line on what it shows, the narration, a `scene` block and an optional `depictions` block. */
export function readExample(name: string, text: string): Example {
  const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? name;
  const about = /^# .+\n\n(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  const narration = /^Narration: "(.+)"$/m.exec(text)?.[1]?.trim() ?? "";
  const source = /```scene\n([\s\S]*?)```/.exec(text)?.[1] ?? "";
  const json = /```depictions\n([\s\S]*?)```/.exec(text)?.[1];
  const depictions = json ? (JSON.parse(json) as Example["depictions"]) : [];
  if (!narration || !source) throw new Error(`cookbook example ${name} needs a Narration: "..." line and a scene block`);
  return { name, title, about, narration, source, depictions, text };
}

export function examples(): Example[] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readExample(f.replace(/\.md$/, ""), readFileSync(join(EXAMPLES, f), "utf8")));
}

const DEPICTING = `# Answering as the depicter

A \`depict ID "words"\` line asks for a thing drawn as itself. In Open Sourcebook you are the depicter: when write_beat meets a depicted thing it cannot draw yet, it answers with what the depicter is asked for it (the thing, its description, the verbs and states the scene uses, what is on screen with it, where it stands). Send the answer as a PropSpec in \`depictions\` with the scene ({ id, desc, spec }, with id and desc exactly as on the depict line), and write_beat checks it, keeps it for the whole video and builds. The same id and words in a later scene draw the same thing; asking it for a new verb or state asks for its spec again, with everything it was asked so far.

What a depicter is told, which is how the engine reads your spec:

${DEPICTER_SYSTEM}

Worked specs for every kind are in the cookbook's examples with depicted things (references/examples.md).`;

function cookbook(): string {
  return [
    "# The cookbook",
    "",
    "Each example is a whole scene on a topic unrelated to any video, timed to its own narration (@N is its N-th word), in references/examples/NAME.md. They show the form and the mechanism, never the content: draw what your own words are about.",
    "",
    ...examples().map((e) => `- examples/${e.name}.md: ${e.title}. ${e.about}`),
  ].join("\n");
}

/** What is written for the video at hand: the scene language's guide for its style and frame, and the skills sent with it. */
export interface ForVideo {
  language: string;
  extra?: readonly ExtraSkill[];
}

/** The references written for the video at hand, and the files of the skills sent with it, by their path inside the skills folder. */
function written(video: ForVideo): Record<string, string> {
  const sent = new Set(extraSkills(video.extra).map((s) => s.name));
  const extra = (video.extra ?? []).filter((x) => sent.has(x.name)).flatMap((x) => Object.entries(x.files).map(([path, text]) => [`${x.name}/${path}`, text] as const));
  return {
    ...Object.fromEntries(extra),
    "make-a-video/references/scene-language.md": video.language,
    "make-a-video/references/depicting.md": DEPICTING,
    "make-a-video/references/examples.md": cookbook(),
  };
}

/** Every file of every skill, by its path inside the skills folder, with the written ones. */
export function skillFiles(video: ForVideo): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.name.endsWith(".md")) out.push(relative(SKILLS, path).split(sep).join("/"));
    }
  };
  walk(SKILLS);
  return [...new Set([...out, ...Object.keys(written(video))])].sort();
}

/**
 * One file of a skill: its SKILL.md when no file is named, else the file by its path inside the skill
 * (`references/teaching.md`) or inside the skills folder (`teaching/references/craft.md`). Undefined when there is none.
 */
export function readSkill(skill: string, file: string | undefined, video: ForVideo): string | undefined {
  const name = skill.trim().toLowerCase();
  const inside = (file ?? "SKILL.md").trim().replace(/^\.?\/+/, "") || "SKILL.md";
  const path = normalize(inside.startsWith(`${name}/`) ? inside : `${name}/${inside}`).split(sep).join("/");
  if (!path.startsWith(`${name}/`)) return undefined;
  const made = written(video)[path];
  if (made !== undefined) return made;
  const full = join(SKILLS, path);
  if (!full.startsWith(SKILLS + sep) || !existsSync(full) || !statSync(full).isFile()) return undefined;
  return readFileSync(full, "utf8");
}

/** Puts every skill into a folder as files (the agent's own folder, when it has one), with the written references. */
export function writeSkills(dest: string, video: ForVideo): void {
  const made = written(video);
  for (const path of skillFiles(video)) {
    const to = join(dest, ...path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    if (made[path] !== undefined) writeFileSync(to, made[path]!);
    else copyFileSync(join(SKILLS, ...path.split("/")), to);
  }
}
