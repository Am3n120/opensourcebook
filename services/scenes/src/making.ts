/**
 * How a video was made, step by step, written by Open Sourcebook from the tool calls it answered, never asked of the agent: the
 * passages read, the beats written, the looks, the renders, whether a render was watched and its viewer report read,
 * the beats changed after a report, the pieces searched for and used, the pictures searched for and kept, every tool
 * answered by name with its count, and whether finish answered once with facts.
 * It is kept in the draft as the calls come, and given with the job, in its log and with its result.
 *
 * What it cannot see: files the agent read with its own tools in its folder (the skills there among them), and the
 * pages given whole with its instructions, which it did not have to open.
 */
import type { ToolAnswer } from "./tools.ts";
import type { Review, ReviewRecord } from "./review.ts";

/** What the calls came to so far, kept in the draft. */
export interface MakingLog {
  passagesRead: string[];
  /** Skill files read with read_skill, as skill/file. */
  skillsRead: string[];
  /** write_beat calls taken, and refused. */
  beatsWritten: number;
  beatsRefused: number;
  looks: number;
  /** Renders started (a render answered with nothing changed, or one already running, is not one). */
  renders: number;
  /** watch of a render, and watch before any render (each beat's opening and end from the builds). */
  watched: number;
  watchedBuilds: number;
  reportsRead: number;
  /** Beats taken by write_beat after the first viewer report was read, by id. */
  changedAfterReport: string[];
  /** Beats taken by write_beat after a render's frames or findings were shown (by render or finish), by id. */
  changedAfterRender: string[];
  /** What find_piece was asked: the words, or a piece by name. */
  piecesSearched: string[];
  /** True when find_piece was called before the first write_beat attempt. */
  piecesSearchedBeforeFirstBeat: boolean;
  /** What find_images was asked, and the pictures kept as assets (save_image, generate_image, cut_out), by name. */
  picturesSearched: string[];
  picturesKept: string[];
  /** sound placed (or placed again). */
  soundPlaced: number;
  finishCalls: number;
  /** finish's one answer with the facts of skipped steps, whole, as the agent was given it. */
  finishAnswer?: string;
  /** Every tool Open Sourcebook answered, by name, with how many times it was called (taken or refused). */
  calls: Record<string, number>;
  /**
   * Each time a render was really seen, in order: which cut, by watch, its viewer report, render, or finish, and
   * whether it came after finish's answer. The one source of what was seen, for finish's facts and this record alike.
   */
  seen: Seen[];
}

/** One look at a render: its cut, how (watch, reading its viewer report, render, or finish), and whether finish had answered by then. */
export interface Seen {
  cut: number;
  how: "watch" | "report" | "render" | "finish";
  afterAnswer: boolean;
}

export const emptyMaking = (): MakingLog => ({ passagesRead: [], skillsRead: [], beatsWritten: 0, beatsRefused: 0, looks: 0, renders: 0, watched: 0, watchedBuilds: 0, reportsRead: 0, changedAfterReport: [], changedAfterRender: [], piecesSearched: [], piecesSearchedBeforeFirstBeat: false, picturesSearched: [], picturesKept: [], soundPlaced: 0, finishCalls: 0, calls: {}, seen: [] });

/** A log kept by an older version, with what it did not record yet as empty. */
export const withDefaults = (log: Partial<MakingLog> | undefined): MakingLog => ({ ...emptyMaking(), ...log });

/** The first line of finish's one answer with facts; the facts follow it, one a line. */
export const FACTS_HEAD = "Not handed over yet. From Open Sourcebook's record of this video:";

const add = (list: string[], value: string) => {
  if (value && !list.includes(value)) list.push(value);
};

/** Notes one answered tool call in the log. `beat` is the beat a write_beat was about once taken. */
export function noteCall(log: MakingLog, name: string, input: Record<string, unknown>, answer: ToolAnswer, beat?: string): void {
  const ok = !answer.isError;
  log.calls ??= {};
  log.calls[name] = (log.calls[name] ?? 0) + 1;
  switch (name) {
    case "read_passages":
      if (ok && Array.isArray(input.ids)) for (const id of input.ids) add(log.passagesRead, String(id));
      return;
    case "read_skill":
      if (ok) add(log.skillsRead, `${String(input.skill ?? "")}/${typeof input.file === "string" && input.file.trim() ? input.file.trim() : "SKILL.md"}`);
      return;
    case "write_beat":
      // Only a beat's id reads it back and changes nothing.
      if (!Object.keys(input).some((k) => k !== "beat" && input[k] !== undefined)) return;
      if (!ok) log.beatsRefused += 1;
      else {
        log.beatsWritten += 1;
        if (log.reportsRead > 0 && beat) add(log.changedAfterReport, beat);
        if ((log.seen ?? []).some((s) => s.how === "render" || s.how === "finish") && beat) add((log.changedAfterRender ??= []), beat);
      }
      return;
    case "look":
      if (ok) log.looks += 1;
      return;
    case "render": {
      if (!ok || /^(Nothing changed since the last render|A render is already running)/.test(answer.text)) return;
      log.renders += 1;
      const cut = /^Cut (\d+):/.exec(answer.text);
      if (cut && (answer.images?.length || /viewer_report finds nothing|A viewer of this render would notice/.test(answer.text))) {
        (log.seen ??= []).push({ cut: Number(cut[1]), how: "render", afterAnswer: !!log.finishAnswer });
      }
      return;
    }
    case "watch": {
      if (!ok) return;
      // A render watched answers with its cut first; anything else (the builds, a render still running) is not one.
      const cut = /^Cut (\d+):/.exec(answer.text);
      if (cut) {
        log.watched += 1;
        (log.seen ??= []).push({ cut: Number(cut[1]), how: "watch", afterAnswer: !!log.finishAnswer });
      } else if (!/^Still rendering/.test(answer.text)) log.watchedBuilds += 1;
      return;
    }
    case "viewer_report": {
      // Only a report really read counts: one that waited on a render still running read nothing.
      const cut = ok ? /^The viewer report for cut (\d+)/.exec(answer.text) : null;
      if (cut) {
        log.reportsRead += 1;
        (log.seen ??= []).push({ cut: Number(cut[1]), how: "report", afterAnswer: !!log.finishAnswer });
      }
      return;
    }
    case "find_piece":
      if (log.beatsWritten === 0 && log.beatsRefused === 0) log.piecesSearchedBeforeFirstBeat = true;
      add(log.piecesSearched, typeof input.name === "string" && input.name.trim() ? `name: ${input.name.trim()}` : typeof input.want === "string" ? input.want.trim() : "(every piece)");
      return;
    case "find_images":
      if (typeof input.query === "string" && input.query.trim()) add((log.picturesSearched ??= []), input.query.trim());
      return;
    case "save_image":
    case "generate_image":
    case "cut_out":
      if (ok && typeof input.name === "string" && input.name.trim()) add((log.picturesKept ??= []), input.name.trim());
      return;
    case "sound":
      if (ok) log.soundPlaced += 1;
      return;
    case "finish":
      log.finishCalls += 1;
      if (ok && answer.text.startsWith(FACTS_HEAD)) {
        log.finishAnswer = answer.text;
        const cut = /\nCut (\d+):/.exec(answer.text);
        if (cut && (answer.images?.length || /viewer_report finds nothing|A viewer of this render would notice/.test(answer.text))) {
          (log.seen ??= []).push({ cut: Number(cut[1]), how: "finish", afterAnswer: true });
        }
      }
      return;
  }
}

/** The record of how a video was made, as given with the job: the log, and what the draft says now. */
export interface Making extends MakingLog {
  /** Beats in the video as it stands. */
  beats: number;
  /** Pieces from the shelf the video's scenes run, by name. */
  piecesUsed: string[];
  /** A render was watched, and a viewer report read. */
  watchedRender: boolean;
  readReport: boolean;
  /** finish answered once with the facts of skipped steps before it handed the video over. */
  finishAnswered: boolean;
  /**
   * The fresh viewer's round, when one ran: how it ended, the cut it watched, how many faults it named and how its
   * answer came, and after the maker's polish turn, the beats it changed and the cut it rendered last.
   */
  review?: ReviewSummary;
  /** The render the person got: the agent's cut by its number, or `after`, one Open Sourcebook made after the turn. Once handed over. */
  handedOver?: number | "after";
}

/** What was seen of each cut, from the record (`MakingLog.seen`): by cut number, how often watched, its report read, shown by render, and shown by finish. */
export function seenByCut(seen: Seen[]): Map<number, { watched: number; reports: number; rendered: number; finished: number; afterAnswer: boolean }> {
  const out = new Map<number, { watched: number; reports: number; rendered: number; finished: number; afterAnswer: boolean }>();
  for (const s of seen) {
    const one = out.get(s.cut) ?? { watched: 0, reports: 0, rendered: 0, finished: 0, afterAnswer: true };
    if (s.how === "watch") one.watched += 1;
    else if (s.how === "report") one.reports += 1;
    else if (s.how === "finish") one.finished += 1;
    else one.rendered += 1;
    one.afterAnswer &&= s.afterAnswer;
    out.set(s.cut, one);
  }
  return out;
}

/** What was seen, cut by cut, in a few words: "cut 1 watched 1 time, its viewer report read 1 time (after finish's answer)". */
export function seenWords(seen: Seen[]): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  return [...seenByCut(seen)]
    .map(([cut, s]) => `cut ${cut} ${[s.watched ? `watched ${n(s.watched, "time")}` : "", s.reports ? `its viewer report read ${n(s.reports, "time")}` : "", s.rendered ? `shown by render ${n(s.rendered, "time")}` : "", s.finished ? `shown by finish ${n(s.finished, "time")}` : ""].filter(Boolean).join(", ")}${s.afterAnswer ? " (after finish's answer)" : ""}`)
    .join("; ");
}

/** The pieces a scene runs, of those on the shelf: `run NAME id ...` lines. */
export function piecesIn(sources: string[], shelf: string[]): string[] {
  const names = new Set(shelf);
  const out: string[] = [];
  for (const s of sources) for (const m of s.matchAll(/^\s*run\s+([a-z0-9-]+)\s/gm)) if (names.has(m[1]!)) add(out, m[1]!);
  return out;
}

/** The facts in finish's answer, one each, without the lines around them. */
export function factsOf(answer: string): string[] {
  const lines = answer.split("\n");
  const end = lines.findIndex((l) => l.startsWith("Open Sourcebook says this once."));
  return (end < 0 ? lines : lines.slice(0, end))
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

/** Which render the person got, and whether that one was seen; empty before it is handed over. */
function handedWords(m: Making): string {
  if (m.handedOver === undefined) return "";
  if (m.handedOver === "after") return "the person got a render Open Sourcebook made after the turn, which nobody watched";
  const s = seenByCut(m.seen ?? []).get(m.handedOver);
  if (!s) return `the person got cut ${m.handedOver}, never watched nor its viewer report read`;
  return `the person got cut ${m.handedOver}, ${[s.watched ? "watched" : "", s.reports ? "its viewer report read" : "", s.rendered ? "shown by render" : "", s.finished ? "shown by finish" : ""].filter(Boolean).join(" and ")}`;
}

/** The viewer's round, in a few words, for the record of the making. */
export interface ReviewSummary {
  state: ReviewRecord["state"];
  cut?: number;
  faults?: number;
  via?: Review["via"];
  changed?: string[];
  soundChanged?: boolean;
  polishedCut?: number;
  why?: string;
}

export function reviewSummary(r: ReviewRecord): ReviewSummary {
  return {
    state: r.state,
    ...(r.cut !== undefined ? { cut: r.cut } : {}),
    ...(r.review ? { faults: r.review.faults.length, via: r.review.via } : {}),
    ...(r.changed ? { changed: r.changed } : {}),
    ...(r.soundChanged !== undefined ? { soundChanged: r.soundChanged } : {}),
    ...(r.polishedCut !== undefined ? { polishedCut: r.polishedCut } : {}),
    ...(r.why ? { why: r.why } : {}),
  };
}

/** The fresh viewer's round in a few words: "watched cut 1, 3 faults; the maker changed s2, s3 and rendered cut 2". */
export function reviewWords(r: NonNullable<Making["review"]>): string {
  const faults = r.faults === undefined ? "" : `, ${r.faults === 0 ? "no faults" : r.faults === 1 ? "one fault" : `${r.faults} faults`}${r.via === "text" ? " (read from its words)" : ""}`;
  const watched = r.cut !== undefined ? `watched cut ${r.cut}${faults}` : "watched nothing";
  const changed = r.changed ? `; the maker changed ${r.changed.length ? r.changed.join(", ") : "no beat"}${r.soundChanged ? " and the sound" : ""}` : "";
  const outcome: Record<string, string> = {
    watching: " (watching)",
    noFaults: "; the cut is kept",
    failed: `; it could not finish (${r.why ?? "no answer"}), so the cut is kept`,
    skipped: ` (${r.why ?? "no cut to watch"})`,
    polishing: "; the maker is going over its notes",
    polished: r.polishedCut !== undefined ? ` and rendered cut ${r.polishedCut}` : "",
    keptFirst: `; the polish turn was cut off (${r.why ?? ""}), so the first cut is kept`,
  };
  return `${watched}${changed}${outcome[r.state] ?? ""}`;
}

/** The record, a line, for the job's log. */
export function makingText(m: Making): string {
  const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
  return [
    `passages read: ${m.passagesRead.join(", ") || "none"}`,
    `skill files read with read_skill: ${m.skillsRead.join(", ") || "none"}`,
    `${n(m.beatsWritten, "beat written", "beats written")}${m.beatsRefused ? ` (${m.beatsRefused} refused)` : ""}, ${m.beats} in the video`,
    n(m.looks, "look"),
    n(m.renders, "render"),
    m.watchedRender ? `a render watched ${n(m.watched, "time")}` : "no render watched",
    m.watchedBuilds ? `the builds watched ${n(m.watchedBuilds, "time")}` : "",
    m.readReport ? `the viewer report read ${n(m.reportsRead, "time")}` : "the viewer report never read",
    m.seen?.length ? `seen: ${seenWords(m.seen)}` : "",
    handedWords(m),
    m.readReport || m.changedAfterReport.length > 0 ? `beats changed after the report: ${m.changedAfterReport.join(", ") || "none"}` : "",
    (m.seen ?? []).some((s) => s.how === "render" || s.how === "finish") || (m.changedAfterRender?.length ?? 0) > 0 ? `beats changed after a shown render: ${(m.changedAfterRender ?? []).join(", ") || "none"}` : "",
    `pieces searched: ${m.piecesSearched.map((q) => `"${q}"`).join(", ") || "none"}${m.piecesSearchedBeforeFirstBeat ? " (before first beat)" : ""}`,
    `pieces used: ${m.piecesUsed.join(", ") || "none"}`,
    `pictures searched: ${m.picturesSearched.map((q) => `"${q}"`).join(", ") || "none"}`,
    `pictures kept: ${m.picturesKept.join(", ") || "none"}`,
    m.soundPlaced ? "sound placed" : "no sound placed",
    `finish called ${n(m.finishCalls, "time")}${m.finishAnswered ? `, answered once with facts${m.finishAnswer ? ` (${factsOf(m.finishAnswer).join(" ")})` : ""}` : ""}`,
    m.review ? `fresh viewer: ${reviewWords(m.review)}` : "",
    `tools answered: ${Object.entries(m.calls).map(([t, c]) => `${t} ${c}`).join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("; ");
}
