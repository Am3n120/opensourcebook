/**
 * The fresh viewer: once the video's maker has finished, a second turn of the person's agent watches the finished cut
 * the way a person meets it, knowing nothing of how it was made, and says what it understood and what got in its way.
 * Its notes go back to the maker for one round of polish, as a viewer's notes it weighs for itself: knowledge, never a
 * gate. Nothing here scores, grades, passes or fails a video.
 *
 * The viewer runs with no folder and none of its own tools, so it cannot read the scenes, the script, the sources or
 * any file. It sees only what this module gives it: the one-line topic, the video's length against the length asked,
 * the spoken words with their times, the viewer report's measured numbers (src/report.ts), and two tools to watch with:
 * `watch_video`, the whole cut as frames about one a second at phone size, and `watch_frame`, a few frames at full
 * size. It answers with `submit_review`, or in plain words when its agent cannot call that (`reviewFromText`).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// tools.ts and cut.ts import each other, and tools.ts reads cut.ts's values as it loads: tools.ts goes first.
import "./tools.ts";
import { momentOf, PHONE_TILE, sheetOf, timesOver, type Cut } from "./cut.ts";
import { clock } from "./report.ts";
import { jpegBase64 } from "./scene.ts";
import type { VideoRequest } from "./request.ts";
import { withPauses } from "./script.ts";
import type { SoundPlan } from "./sound.ts";
import type { Draft, ToolAnswer } from "./tools.ts";

/** How the viewer watches. Each number is ours, set from the blind viewings this pass is modelled on. */
export const WATCH = {
  /** About one frame a second of the video, as a viewer's eye takes in a moment... */
  everySeconds: 1,
  /** ...and at most this many over the whole cut, so a long video is still seen whole. */
  most: 72,
  /** Frames a sheet, in rows of `cols`, each `PHONE_TILE` pixels wide. */
  perSheet: 9,
  cols: 3,
  /** The sheets one answer may carry: the agent connector passes at most 8 pictures a tool answer. */
  sheets: 8,
  /** Full-size frames the viewer may ask for in all, as many as a blind judge was given. */
  frames: 3,
} as const;

/** How long the viewer's turn may run, in minutes; one viewing does not take long, and a stuck one must not hold the video. */
export const VIEWER_MINUTES = 20;

/** The five things a viewer looks at, as the faults name them. */
export const LENSES = ["taught", "picture", "together", "finish", "right"] as const;
export type Lens = (typeof LENSES)[number];

export interface Fault {
  /** When, as the viewer said it: "0:12", "12-18 s", "the end card". */
  at: string;
  what: string;
  lens?: Lens;
}

/** What the viewer said. */
export interface Review {
  /** What it learned, in its own words, three to five sentences. */
  taught: string;
  /** What worked, so the maker keeps it: one to three strengths and the best moment. */
  worked: { strengths: string[]; bestMoment: string };
  /** What got in its way, the most important first, each with when. */
  faults: Fault[];
  weakestMoment: string;
  /** The one change that would help this video most. */
  topChange: string;
  /** How it came: by submit_review, or read from the viewer's last words. */
  via: "tool" | "text";
}

/**
 * The fresh viewer's one round on a video, kept in its draft so a restart or a resume never starts a second one.
 * `watching` while it watches; then `noFaults` (cut kept), `failed` (it could not watch or say, cut kept), `skipped`
 * (no cut could be made), `polishing` while the maker works on its notes, `polished` (the maker's turn ended; what it
 * made is the video) or `keptFirst` (the maker's polish turn was cut off, so the first cut is the video).
 */
export interface ReviewRecord {
  round: 1;
  state: "watching" | "noFaults" | "failed" | "skipped" | "polishing" | "polished" | "keptFirst";
  at: string;
  /** The cut the viewer watched, and where a copy of its file is kept (relative to the job's folder). */
  cut?: number;
  firstCut?: string;
  review?: Review;
  /** Why it failed, was skipped or the first cut was kept, in a few words. */
  why?: string;
  /** The model the viewer ran on, when its agent said. */
  model?: string;
  /** After polish: the beats the maker changed, added or removed, whether it changed the sound, and the cut it rendered last. */
  changed?: string[];
  soundChanged?: boolean;
  polishedCut?: number;
}

/** What the viewer's tools read: the request, the cut and its file, and what it has asked for so far. */
export interface ViewerSession {
  request: VideoRequest;
  cut: Cut;
  /** The cut's mp4, a copy that nothing else writes while the viewer watches. */
  video: string;
  /** Where its sheets and frames are written. */
  folder: string;
  /** The viewer report's text for the cut, when it could be read. */
  report?: string;
  watched: number;
  framesShown: number;
  review?: Review;
}

const fail = (text: string): ToolAnswer => ({ text, isError: true });
const str = (v: unknown, most = 1200) => (typeof v === "string" ? v.trim().slice(0, most) : "");

/** What the viewer is: someone meeting the video once, on a phone, knowing nothing of the topic or how it was made. */
export const VIEWER_SYSTEM = `You are watching a short explainer video on your phone, held upright. You do not know this topic. You have not seen how the video was made: not its script, its sources, its scenes or its code, and you cannot open any of them. You only watch it, once, and say what a viewer would.

# How you watch
You cannot play the video, so Open Sourcebook shows it to you:
- watch_video: the whole video as frames about one a second, at phone size (${PHONE_TILE} pixels wide, as the narrowest phones show it upright), ${WATCH.perSheet} to a sheet, left to right and down, with the time of each frame and what the voice says then. The sheets are dense on purpose: writing you can hardly read here is as hard to read on a phone.
- watch_frame: up to ${WATCH.frames} frames at full size, at the times you pick, for a closer look at a moment.
- The message gives the spoken words with their times and a few numbers code measured in the video.
Go through the frames in order with the words spoken at each moment, as if watching once at normal speed.

# What to say
Plainly and specifically, with the time of each thing you mention, through five lenses:
1. Did it teach? Write what the video taught you, in your own words, in 3 to 5 sentences, as you would explain it to a friend, from this one viewing and without looking back. Say where you got lost or had to look twice, and what was on screen and being said then. Say whether the key mechanism was shown happening on screen, or only told by the voice while the screen showed words.
2. The picture. Is there a specific, recognizable thing or mechanism you could see in motion, or boxes with words, empty shapes and placeholders? Is the whole frame used, the lower half above the captions included, or does the picture sit small in empty space?
3. Words, voice and picture together. Does the picture show what the voice says as it says it, or are they about different things? Stretches where nothing changes on screen while the voice carries on, or things that change or jump too fast to take in; captions that read steadily or not; the pace and the sound.
4. Readable and finished on a phone. Writing too small, cut off by the edge, on top of other writing or gone before you could read it; an empty or abrupt opening; an abrupt ending; the end card.
5. Right and consistent. Anything that seemed wrong or misleading; numbers or parts on screen that do not add up; a thing called one name, then another.

Say what worked as well as what did not, so it is kept: one to three strengths and the best moment. Then the faults, the most important first, each with its time and what you saw and heard then; the weakest moment; and the single change that would help this video most. Only what a viewer would notice: say "the arrow at 0:21 points at nothing", not how to code it. If nothing got in your way, say so: no faults is an answer.

This is a viewing, not a grade: give no score and no verdict. When you have watched it, answer with submit_review and stop.`;

export const VIEWER_INSTRUCTIONS = "Open Sourcebook's tools for watching one video: watch_video for the whole video at phone size, watch_frame for a few frames at full size, and submit_review to answer.";

/** The spoken words with their times, a line at each sentence or pause, and the pauses where the voice waits. */
export function spokenLines(cut: Cut): string[] {
  const lines: string[] = [];
  let line: { at: number; words: string[]; end: number } | undefined;
  const flush = () => {
    if (line) lines.push(`[${clock(line.at)}] ${line.words.join(" ")}`);
    line = undefined;
  };
  const holds = [...cut.holds].sort((a, b) => a.start - b.start);
  let h = 0;
  for (const w of cut.words) {
    while (h < holds.length && holds[h]!.start <= w.start) {
      flush();
      lines.push(`[${clock(holds[h]!.start)}] (the voice pauses ${holds[h]!.seconds.toFixed(1)} s)`);
      h += 1;
    }
    if (line && (w.start - line.end > 0.8 || line.words.length >= 16)) flush();
    line ??= { at: w.start, words: [], end: w.end };
    line.words.push(w.text);
    line.end = w.end;
    if (/[.!?]["”’)]*$/.test(w.text)) flush();
  }
  flush();
  return lines;
}

/** The viewer's first message: the topic, the length, what is said and when, and what code measured. */
export function viewerPrompt(s: ViewerSession): string {
  const r = s.request;
  const seconds = s.cut.durationMs / 1000;
  const spoken = s.cut.spans.length ? s.cut.spans.at(-1)!.endMs / 1000 : seconds;
  const words = spokenLines(s.cut);
  return [
    `The video was made to teach: "${r.title}".${r.brief ? ` ${r.brief}` : ""}`,
    `It runs ${clock(seconds)} (${Math.round(seconds)} s), the end card after the last words at ${clock(spoken)}${r.targetSeconds ? `; about ${Math.round(r.targetSeconds)} s of narration was asked for` : ""}. The frame is ${r.frame.width} by ${r.frame.height}${r.frame.height > r.frame.width ? ", a phone held upright" : ""}, captions near the bottom.`,
    s.cut.voice.real ? "" : "It has no voice: the captions carry the words.",
    words.length ? `What is said, with when (minutes:seconds):\n${words.join("\n")}` : "Nothing is said in it.",
    s.report
      ? `What code measured in the video, for you to weigh against what you see (s1, s2 and so on are its scenes in order; these are measurements, not a verdict):\n${s.report}`
      : "",
    "Watch it with watch_video, look closer with watch_frame when you need to, then answer with submit_review.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the voice says at a moment, for a viewer: the words, a pause, or nothing; the end card named. */
function saidAt(cut: Cut, t: number): string {
  const m = momentOf(cut, t);
  const said = m.said.startsWith("pause ") ? "(a pause in the voice)" : m.said === "no words" ? "(no words)" : m.said;
  return m.beat === "end card" ? `end card, ${said}` : said;
}

const watchVideo = {
  name: "watch_video",
  description: `The whole video as frames about one a second (at most ${WATCH.most}), each ${PHONE_TILE} pixels wide as a phone held upright shows it, ${WATCH.perSheet} a sheet (${WATCH.cols} a row), left to right and down, with each frame's time and what the voice says then.`,
  inputSchema: { type: "object", properties: {} },
  async run(_input: Record<string, unknown>, s: ViewerSession): Promise<ToolAnswer> {
    const seconds = s.cut.durationMs / 1000;
    const end = Math.max(0.5, seconds - 0.25);
    const times = timesOver(0.4, end, Math.max(WATCH.everySeconds, (end - 0.4) / (WATCH.most - 1)), WATCH.most);
    s.watched += 1;
    const groups: number[][] = [];
    for (let i = 0; i < times.length && groups.length < WATCH.sheets; i += WATCH.perSheet) groups.push(times.slice(i, i + WATCH.perSheet));
    const sheets = await Promise.all(groups.map((g, i) => sheetOf(s.video, g, s.request.frame, join(s.folder, `watch-${s.watched}`, `sheet-${i + 1}`), { tile: PHONE_TILE, cols: WATCH.cols })));
    const shown = groups.flat();
    const lines = shown.map((t, i) => `${i + 1}. ${clock(t)}: ${saidAt(s.cut, t)}`);
    return {
      text: [
        `The video, ${clock(seconds)}: ${shown.length} frames on ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} below, ${WATCH.perSheet} a sheet, left to right and down, numbered across the sheets:`,
        ...lines,
      ].join("\n"),
      images: sheets.map((f) => ({ mimeType: "image/jpeg", dataBase64: jpegBase64(f) })),
    };
  },
};

const watchFrame = {
  name: "watch_frame",
  description: `Frames of the video at full size, at the times you name in seconds: up to ${WATCH.frames} in all, for a closer look at a moment.`,
  inputSchema: { type: "object", properties: { at: { type: "array", items: { type: "number" }, description: `Seconds into the video, at most ${WATCH.frames}.` } }, required: ["at"] },
  async run(input: Record<string, unknown>, s: ViewerSession): Promise<ToolAnswer> {
    const seconds = s.cut.durationMs / 1000;
    const left = WATCH.frames - s.framesShown;
    if (left <= 0) return fail(`All ${WATCH.frames} full-size frames have been shown; watch_video shows the whole video again.`);
    const asked = (Array.isArray(input.at) ? input.at : [input.at]).map(Number).filter((n) => Number.isFinite(n));
    if (!asked.length) return fail("Name the moments in at, as seconds into the video.");
    const times = asked.slice(0, left).map((t) => Math.round(Math.max(0, Math.min(seconds - 0.05, t)) * 100) / 100);
    s.framesShown += times.length;
    const files = await Promise.all(times.map((t, i) => sheetOf(s.video, [t], s.request.frame, join(s.folder, `frame-${s.framesShown - times.length + i + 1}`), { tile: s.request.frame.width, cols: 1 })));
    return {
      text: [`${times.length === 1 ? "One frame" : `${times.length} frames`} at full size below, in order${asked.length > times.length ? ` (the first ${times.length}; ${WATCH.frames} in all)` : ""}:`, ...times.map((t, i) => `${i + 1}. ${clock(t)}: ${saidAt(s.cut, t)}`), `${WATCH.frames - s.framesShown} full-size frame${WATCH.frames - s.framesShown === 1 ? "" : "s"} left.`].join("\n"),
      images: files.map((f) => ({ mimeType: "image/jpeg", dataBase64: jpegBase64(f) })),
    };
  },
};

const submitReview = {
  name: "submit_review",
  description: "Your answer, once you have watched the video: what it taught you, what worked, what got in your way, the weakest moment and the one change that would help it most. Sending it again replaces it.",
  inputSchema: {
    type: "object",
    properties: {
      taught: { type: "string", description: "What the video taught you, in your own words, 3 to 5 sentences, from this one viewing: as you would explain it to a friend." },
      worked: {
        type: "object",
        description: "What worked, so it is kept.",
        properties: { strengths: { type: "array", items: { type: "string" }, description: "One to three things that worked, each with when." }, bestMoment: { type: "string", description: "The best moment, with its time, and why." } },
        required: ["strengths", "bestMoment"],
      },
      faults: {
        type: "array",
        description: "What got in your way, the most important first; empty when nothing did.",
        items: {
          type: "object",
          properties: {
            at: { type: "string", description: 'When: "0:12", "0:12-0:18", or "the end card".' },
            what: { type: "string", description: "What you saw and heard then, and why it got in your way." },
            lens: { type: "string", enum: [...LENSES], description: "taught, picture, together (words, voice and picture), finish (readable and finished on a phone) or right." },
          },
          required: ["at", "what"],
        },
      },
      weakestMoment: { type: "string", description: "The weakest moment, with its time, and why." },
      topChange: { type: "string", description: "The single change that would help this video most." },
    },
    required: ["taught", "worked", "faults", "weakestMoment", "topChange"],
  },
  async run(input: Record<string, unknown>, s: ViewerSession): Promise<ToolAnswer> {
    const read = readReview(input, "tool");
    if (!read.review) return fail(`Not taken:\n- ${read.problems.join("\n- ")}`);
    s.review = read.review;
    return { text: `Taken: ${read.review.faults.length === 0 ? "no faults" : read.review.faults.length === 1 ? "one fault" : `${read.review.faults.length} faults`}. That is the whole viewing; stop now.` };
  },
};

export const VIEWER_TOOLS = [watchVideo, watchFrame, submitReview];
export const viewerListing = () => VIEWER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

/** One of the viewer's tools, answered. */
export async function viewerCall(name: string, input: unknown, s: ViewerSession): Promise<ToolAnswer> {
  const tool = VIEWER_TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`There is no tool "${name}" here: watch_video, watch_frame and submit_review are the tools.`);
  try {
    return await tool.run(typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}, s);
  } catch (e) {
    return fail(`That failed in the service: ${(e as Error).message.slice(0, 300)}. Try once more.`);
  }
}

const lensOf = (v: unknown): Lens | undefined => {
  const t = str(v).toLowerCase();
  return (LENSES as readonly string[]).includes(t) ? (t as Lens) : undefined;
};

/** A fault as it came: an object with at and what, or a line of text starting with its time. */
function faultOf(raw: unknown): Fault | undefined {
  if (typeof raw === "string") {
    const line = raw.trim();
    if (!line) return undefined;
    const m = TIME_AT_START.exec(line);
    return m ? { at: m[1]!.trim(), what: line.slice(m[0].length).trim().slice(0, 600) || line.slice(0, 600) } : { at: "", what: line.slice(0, 600) };
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  const what = str(f.what ?? f.fault ?? f.text ?? f.note, 600);
  if (!what) return undefined;
  const at = typeof f.at === "number" ? `${f.at} s` : str(f.at ?? f.time ?? f.when, 60);
  const lens = lensOf(f.lens);
  return { at, what, ...(lens ? { lens } : {}) };
}

/** The viewer's answer read and checked; `problems` says what is missing when it cannot be taken. */
export function readReview(raw: unknown, via: Review["via"]): { review?: Review; problems: string[] } {
  const problems: string[] = [];
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const taught = str(r.taught, 2000);
  if (!taught) problems.push("taught: what the video taught you, 3 to 5 sentences.");
  const w = r.worked;
  const worked = Array.isArray(w)
    ? { strengths: w.map((x) => str(x, 400)).filter(Boolean).slice(0, 3), bestMoment: str(r.bestMoment, 400) }
    : typeof w === "object" && w !== null
      ? { strengths: (Array.isArray((w as Record<string, unknown>).strengths) ? ((w as Record<string, unknown>).strengths as unknown[]) : []).map((x) => str(x, 400)).filter(Boolean).slice(0, 3), bestMoment: str((w as Record<string, unknown>).bestMoment ?? r.bestMoment, 400) }
      : { strengths: typeof w === "string" && w.trim() ? [str(w, 400)] : [], bestMoment: str(r.bestMoment, 400) };
  if (r.faults !== undefined && !Array.isArray(r.faults)) problems.push("faults: a list, empty when nothing got in your way.");
  const faults = (Array.isArray(r.faults) ? r.faults : []).map(faultOf).filter((f): f is Fault => !!f).slice(0, 12);
  if (problems.length) return { problems };
  return { review: { taught, worked, faults, weakestMoment: str(r.weakestMoment, 600), topChange: str(r.topChange, 600), via }, problems };
}

const TIME_AT_START = /^\s*(?:\*\*)?\[?((?:\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*s)(?:\s*(?:-|–|to)\s*(?:\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*s))?|the end card|end card)\]?(?:\*\*)?\s*[:,—–-]?\s*/i;

/** The headings a viewer writes its answer under, in plain words (the whole heading, before any colon), and the field each fills. */
const HEADINGS: [RegExp, string][] = [
  [/^(?:what (?:it|the video) taught(?: me)?|what i learned|taught|did it teach)$/i, "taught"],
  [/^(?:(?:the )?best ?moment)$/i, "bestMoment"],
  [/^(?:what worked|worked|strengths)$/i, "strengths"],
  [/^(?:(?:the )?weakest ?moment)$/i, "weakestMoment"],
  [/^(?:faults|what got in (?:my|the) way|problems)$/i, "faults"],
  [/^(?:top ?change|the single change|single change|one change|the one change(?: i would make)?)$/i, "topChange"],
];

/** The field a line opens, and what follows its heading on the same line; undefined for a line that is not a heading. */
function headingOf(raw: string): { field: string; rest: string } | undefined {
  const clean = raw.replace(/\*\*|__/g, "").replace(/^\s*#+\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim();
  const colon = clean.search(/[:：]/);
  const head = (colon >= 0 ? clean.slice(0, colon) : clean).replace(/\s*\([^)]*\)\s*$/, "").replace(/[?.]\s*$/, "").trim();
  if (colon < 0 && clean.length > 45) return undefined;
  const hit = HEADINGS.find(([re]) => re.test(head));
  return hit ? { field: hit[1], rest: colon >= 0 ? clean.slice(colon + 1).trim() : "" } : undefined;
}

/**
 * A viewer's answer from its last words, when it wrote it out instead of calling submit_review: a JSON object of the
 * same fields, or the fields under headings ("Taught:", "Faults:" and a list...). Undefined when what it taught is not there.
 */
export function reviewFromText(text: string): Review | undefined {
  const t = text.trim();
  if (!t) return undefined;
  for (const candidate of [/```(?:json)?\s*([\s\S]*?)```/i.exec(t)?.[1], t.includes("{") ? t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1) : undefined]) {
    if (!candidate) continue;
    try {
      const read = readReview(JSON.parse(candidate), "text");
      if (read.review) return read.review;
    } catch {
      // Not JSON: the headings below.
    }
  }
  const parts: Record<string, string[]> = {};
  let field: string | undefined;
  for (const raw of t.split("\n")) {
    const heading = headingOf(raw);
    if (heading) {
      field = heading.field;
      parts[field] ??= [];
      if (heading.rest) parts[field]!.push(heading.rest);
      continue;
    }
    if (field && raw.trim()) (parts[field] ??= []).push(raw.replace(/\*\*/g, "").trim());
  }
  const join_ = (k: string) => (parts[k] ?? []).join(" ").trim();
  const items = (k: string) => (parts[k] ?? []).map((l) => l.replace(/^[-*•]\s*|^\d+[.)]\s*/, "").trim()).filter((l) => l && !/^(none|no faults?\.?|nothing\.?)$/i.test(l));
  const taught = join_("taught");
  if (!taught) return undefined;
  return {
    taught: taught.slice(0, 2000),
    worked: { strengths: items("strengths").slice(0, 3).map((x) => x.slice(0, 400)), bestMoment: join_("bestMoment").slice(0, 400) },
    faults: items("faults").map(faultOf).filter((f): f is Fault => !!f).slice(0, 12),
    weakestMoment: join_("weakestMoment").slice(0, 600),
    topChange: join_("topChange").slice(0, 600),
    via: "text",
  };
}

/** The review as plain lines, for the maker's notes and the log. */
export function reviewLines(r: Review): string[] {
  return [
    `What it took from the video, in its own words: ${r.taught}`,
    `What worked: ${r.worked.strengths.length ? r.worked.strengths.join(" | ") : "(it named nothing)"}${r.worked.bestMoment ? `. Best moment: ${r.worked.bestMoment}` : ""}`,
    r.faults.length ? `What got in its way, the most important first:\n${r.faults.map((f, i) => `${i + 1}. ${f.at ? `${f.at}: ` : ""}${f.what}${f.lens ? ` (${f.lens})` : ""}`).join("\n")}` : "Nothing got in its way.",
    r.weakestMoment ? `The weakest moment: ${r.weakestMoment}` : "",
    r.topChange ? `The one change it would make: ${r.topChange}` : "",
  ].filter(Boolean);
}

/** A beat's words and picture, as the maker made them: what it can change surgically in the polish. */
function beatText(draft: Draft, cut: Cut, id: string): string {
  const s = draft.script!.scenes.find((x) => x.id === id)!;
  const span = cut.spans.find((x) => x.id === id);
  const source = draft.scenes[id]?.source ?? "";
  return [
    `## ${id}${span ? `, ${clock(span.startMs / 1000)} to ${clock(span.endMs / 1000)} in cut ${cut.number}` : ""}`,
    `Narration: ${withPauses(s)}`,
    s.onScreenText.length ? `On screen: ${s.onScreenText.join(" | ")}` : "",
    "Source:",
    "```",
    source.trimEnd(),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

const soundText = (sound: SoundPlan | undefined) =>
  !sound ? "No sound placed (voice only)." : `Sound: ${sound.music.length ? `music ${sound.music.map((c) => `${c.name} at ${c.scene} @${c.at}, ${c.level} dB`).join("; ")}` : "no music"}; ${sound.effects.length ? `effects ${sound.effects.map((c) => `${c.name} at ${c.scene} @${c.at}, ${c.level} dB`).join("; ")}` : "no effects"}.`;

/**
 * What the maker hears in its polish turn: a viewer watched its finished video, and what it said, as a viewer's notes
 * it weighs for itself; then its beats as they stand, words and sources and the sound, so it can change only what it
 * agrees with.
 */
export function polishText(review: Review, draft: Draft, cut: Cut): string {
  return [
    `You made this video and finished it. A viewer then watched cut ${cut.number} once, fresh: it saw only what a person sees (the frames at phone size, the words with their times, the measured numbers), never your script, scenes or passages. Its notes are below. They are one viewer's notes, for you to weigh: where you agree a change would make the video clearer for the person, make it; where you judge the video right as it is, leave it. Keep what worked. This is the one round of notes on this video.`,
    "Change only what you choose to, with write_beat and only the fields that change (your beats are in this video's draft as they stand below), then render, watch what you changed, and call finish. If you change nothing, call finish and the person gets the cut they would have had.",
    "# The viewer's notes",
    ...reviewLines(review),
    "# Your video as it stands",
    `Cut ${cut.number}: ${(cut.durationMs / 1000).toFixed(1)} s with the end card. The viewer's times are the cut's; each beat below says where it is in it.`,
    ...draft.script!.scenes.map((s) => beatText(draft, cut, s.id)),
    soundText(draft.sound),
  ].join("\n\n");
}

/** What of the beats changed between two drafts: beats changed, added or removed, by id, and whether the sound changed. */
export function changedBeats(before: Draft, after: Draft): { beats: string[]; sound: boolean } {
  const of = (d: Draft) => new Map((d.script?.scenes ?? []).map((s) => [s.id, JSON.stringify([withPauses(s), s.onScreenText, s.visual, d.scenes[s.id]?.source ?? ""])]));
  const a = of(before);
  const b = of(after);
  const beats = [...new Set([...a.keys(), ...b.keys()])].filter((id) => a.get(id) !== b.get(id));
  return { beats, sound: JSON.stringify(before.sound ?? null) !== JSON.stringify(after.sound ?? null) };
}

/** Keeps a copy of a cut's file (and the scenes' data the report reads) in the job's `review/` folder; returns the copy's path, relative. */
export function keepCut(folder: string, cut: Cut): string | undefined {
  const from = join(folder, cut.file);
  if (!existsSync(from)) return undefined;
  mkdirSync(join(folder, "review"), { recursive: true });
  const kept = join("review", `cut-${cut.number}.mp4`);
  copyFileSync(from, join(folder, kept));
  if (cut.facts && existsSync(join(folder, cut.facts))) copyFileSync(join(folder, cut.facts), join(folder, "review", `cut-${cut.number}-facts.json`));
  return kept;
}

/** Puts a kept cut back as the job's video, so the first cut is what the person gets. */
export function restoreCut(folder: string, cut: Cut, kept: string): void {
  copyFileSync(join(folder, kept), join(folder, cut.file));
  const facts = join(folder, "review", `cut-${cut.number}-facts.json`);
  if (cut.facts && existsSync(facts)) copyFileSync(facts, join(folder, cut.facts));
}
