/**
 * The checks every video gets in code, whoever made it (engine/docs/video.md):
 * a title and an idea, scenes within their limits, narration that fits its
 * scene, quotes word for word in the passages they cite, no passage labels
 * the viewer would see, and a length near the one asked for. A maker runs
 * them as the last gate before its video is kept.
 *
 * Two kinds of finding. A cite untrue to the sources (a passage the item does not have, no quote, a quote not word for
 * word in its passage: `TRUE_TO_SOURCES`) protects the person from wrong content and always holds a video back. The
 * rest are about form and wording; a maker whose video is already rendered and taken keeps it over them and says what
 * they found in the video's notes (`keptOver`), since its writer met the same checks while it wrote (the scenes
 * service's write_beat answers them).
 */
import { learnerStrings, promptLabelLeaks, quoteInPassage, type Passage } from "../../sources/passages";
import type { ValidationIssue } from "../../studio/types";
import { VIDEO_LIMITS, plannedTimeline, spokenWords, type Scene, type SceneCite, type Video } from "../../video/contract";

/** How far the total may land from a set length: within a third either way (video.md, "Settings"). */
const LENGTH_TOLERANCE = 1 / 3;

/** One planned scene: what it does, from which passages, about how long. */
export interface ScenePlan {
  does: string;
  kind: string;
  passageIds: string[];
  seconds: number;
}

export interface VideoBlueprint {
  title: string;
  idea: string;
  scenes: ScenePlan[];
  /** The target length asked for, 0 when the brief decided. */
  minutes: number;
  omittedPassages: number;
}

/** The findings that keep a video true to its sources: never kept over, by any maker. */
export const TRUE_TO_SOURCES: ReadonlySet<string> = new Set(["unknown_passage", "no_quote", "quote_not_in_passage"]);

export interface VideoCheckOptions {
  /**
   * True when each scene's length was measured from its voice (a rendered video): it then lasts as long as its words
   * take, so whether they fit is not checked.
   */
  timedByVoice?: boolean;
}

/** Every rule that needs no model (engine/docs/video.md). */
export function checkVideo(video: Video, blueprint: VideoBlueprint, passages: Map<string, Passage>, options: VideoCheckOptions = {}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!video.title?.trim()) issues.push(error("$.title", "empty", "the video needs a title"));
  if (!video.idea?.trim()) issues.push(error("$.idea", "empty", "the video needs its idea in a sentence"));
  if (video.scenes.length === 0 || video.scenes.length > VIDEO_LIMITS.maxScenes) {
    issues.push(error("$.scenes", "count", `a video has 1 to ${VIDEO_LIMITS.maxScenes} scenes`));
  }
  if (video.scenes.length !== blueprint.scenes.length) {
    issues.push(error("$.scenes", "count", `expected ${blueprint.scenes.length} scenes, found ${video.scenes.length}`));
  }
  const all = [...passages.values()];
  // The scene ids are words only the writer saw too (its beats were s1, s2, ...).
  const sceneIds = video.scenes.map((scene) => scene.id);
  video.scenes.forEach((scene, at) => issues.push(...sceneIssues(scene, at, passages, all, sceneIds, options)));
  if (video.scenes.length > 0 && video.scenes.every((scene) => !scene.narration.trim())) {
    issues.push(error("$.scenes", "silent", "no scene has narration; a video says something"));
  }

  const totalMs = video.scenes.reduce((sum, scene) => sum + (Number.isFinite(scene.durationMs) ? scene.durationMs : 0), 0);
  if (totalMs > VIDEO_LIMITS.maxMinutes * 60_000) issues.push(error("$.scenes", "too_long", `the whole video is at most ${VIDEO_LIMITS.maxMinutes} minutes`));
  if (blueprint.minutes > 0) {
    const target = blueprint.minutes * 60_000;
    if (Math.abs(totalMs - target) > target * LENGTH_TOLERANCE) {
      issues.push(warning("$.scenes", "length", `runs ${Math.round(totalMs / 1000)} s; about ${Math.round(target / 1000)} s was asked for`));
    }
  }
  if (blueprint.omittedPassages > 0) issues.push(warning("$", "passages_omitted", `${blueprint.omittedPassages} passages were too far into the sources to plan from`));
  return issues;
}

function sceneIssues(scene: Scene, at: number, passages: Map<string, Passage>, all: Passage[], sceneIds: string[], options: VideoCheckOptions): ValidationIssue[] {
  const path = `scenes[${at}]`;
  const issues: ValidationIssue[] = [];
  if (scene.id !== `s${at + 1}`) issues.push(error(`${path}.id`, "id", `id must be s${at + 1}`));
  if (!scene.kind.trim()) issues.push(error(`${path}.kind`, "empty", "say in a word or two what the scene does"));
  if (!Number.isFinite(scene.durationMs) || scene.durationMs < VIDEO_LIMITS.minSceneMs || scene.durationMs > VIDEO_LIMITS.maxSceneMs) {
    issues.push(error(`${path}.durationMs`, "range", `a scene lasts ${VIDEO_LIMITS.minSceneMs / 1000} to ${VIDEO_LIMITS.maxSceneMs / 1000} seconds`));
  }
  if (!scene.visual.kind.trim()) issues.push(error(`${path}.visual.kind`, "empty", "say what sort of picture it is"));
  const description = scene.visual.description.trim();
  if (description.length < VIDEO_LIMITS.visualMin) issues.push(error(`${path}.visual.description`, "too_short", "describe what is seen concretely enough to make it"));
  else if (description.length > VIDEO_LIMITS.visualMax) issues.push(error(`${path}.visual.description`, "too_long", `at most ${VIDEO_LIMITS.visualMax} characters`));
  if (scene.narration.length > VIDEO_LIMITS.narration) issues.push(error(`${path}.narration`, "too_long", `at most ${VIDEO_LIMITS.narration} characters`));
  const words = spokenWords(scene.narration);
  if (!options.timedByVoice && Number.isFinite(scene.durationMs) && scene.durationMs > 0) {
    const needed = Math.ceil((words / VIDEO_LIMITS.maxWordsPerSecond) * 1000);
    if (needed > scene.durationMs) {
      issues.push(error(`${path}.narration`, "too_fast", `${words} words do not fit in ${scene.durationMs / 1000} s; give the scene at least ${Math.ceil(needed / 1000)} s or say less`));
    }
  }
  if (scene.onScreenText.length > VIDEO_LIMITS.onScreenEntries) issues.push(error(`${path}.onScreenText`, "too_many", `at most ${VIDEO_LIMITS.onScreenEntries} entries`));
  scene.onScreenText.forEach((text, index) => {
    if (!text.trim() || text.length > VIDEO_LIMITS.onScreenChars) issues.push(error(`${path}.onScreenText[${index}]`, "length", `1 to ${VIDEO_LIMITS.onScreenChars} characters`));
  });
  for (const { path: at, text } of learnerStrings({ narration: scene.narration, onScreenText: scene.onScreenText }, path, new Set())) {
    const leaks = promptLabelLeaks(text, all, sceneIds);
    if (leaks.length > 0) {
      issues.push(error(at, "names_prompt_label", `names ${leaks.map((term) => `"${term}"`).join(", ")}, words only the writer saw; the viewer never sees labelled passages. Say what the source says instead`));
    }
  }
  if (scene.cites.length === 0) {
    if (scene.narration.trim()) issues.push(warning(`${path}.cites`, "uncited", "this scene cites nothing; it should state nothing from the sources"));
  } else if (scene.cites.length > VIDEO_LIMITS.cites) {
    issues.push(error(`${path}.cites`, "too_many", `at most ${VIDEO_LIMITS.cites} passages`));
  }
  scene.cites.forEach((cite, index) => {
    const at = `${path}.cites[${index}]`;
    const passage = passages.get(passageIdOf(cite));
    if (!passage || passage.sourceId !== cite.sourceId) issues.push(error(at, "unknown_passage", "cites a passage that is not in this item's sources"));
    else if (!cite.quote?.trim()) issues.push(error(`${at}.quote`, "no_quote", `quote the words of ${passage.label} this scene draws on`));
    // Whether it is true to the passage first, whatever its length: that is the finding that holds a video back.
    else if (!quoteInPassage(cite.quote, passage)) issues.push(error(`${at}.quote`, "quote_not_in_passage", `the quote is not word for word in ${passage.label}`));
    else if (cite.quote.length > VIDEO_LIMITS.quote) issues.push(error(`${at}.quote`, "too_long", `a quote is at most ${VIDEO_LIMITS.quote} characters`));
  });
  return issues;
}

/**
 * A rendered video's findings as its maker keeps it: every error that is not about being true to the sources becomes a
 * warning, so the video is kept, and comes back in `kept` to be said in the video's notes. A cite untrue to the sources
 * stays an error.
 */
export function keptOver(issues: ValidationIssue[]): { issues: ValidationIssue[]; kept: ValidationIssue[] } {
  const kept = issues.filter((issue) => issue.severity === "error" && !TRUE_TO_SOURCES.has(issue.code));
  return { issues: issues.map((issue) => (kept.includes(issue) ? { ...issue, severity: "warning" as const } : issue)), kept };
}

/** At most this many findings are named in a video's notes; the rest are counted. */
const NOTED = 3;

/**
 * What Open Sourcebook's checks found in a video it kept anyway, in words for the person on the item: where, and what. Empty when
 * nothing was kept over.
 */
export function keptNotes(kept: ValidationIssue[]): string[] {
  if (kept.length === 0) return [];
  const named = kept.slice(0, NOTED).map((issue) => `${whereIs(issue.path)}: ${issue.message.split(";")[0]!.trim()}`);
  const more = kept.length > NOTED ? ` And ${kept.length - NOTED} more.` : "";
  return [`Kept as rendered, though Open Sourcebook's checks found: ${named.join("; ")}.${more}`];
}

/** A finding's place in words: "scene 4's narration", "the video". */
function whereIs(path: string): string {
  const scene = /^scenes\[(\d+)\]\.?([a-zA-Z]+)?/.exec(path);
  if (!scene) return path === "$" || path.startsWith("$.scenes") ? "the video" : path.replace(/^\$\./, "the ");
  const field = scene[2] === "onScreenText" ? "on-screen text" : scene[2] === "durationMs" ? "length" : scene[2] === "cites" ? "cites" : scene[2];
  return `scene ${Number(scene[1]) + 1}${field ? `'s ${field}` : ""}`;
}

/** The passage a cite points at: its chunk, or the character span of a source without stored chunks (passages.ts ids). */
export function passageIdOf(cite: SceneCite): string {
  if (cite.chunkId) return cite.chunkId;
  return `${cite.sourceId}@${cite.locator?.charStart ?? 0}-${cite.locator?.charEnd ?? 0}`;
}

/** What later items are told this video covered. */
export function summarize(video: Video): string {
  const timeline = plannedTimeline(video.scenes);
  const total = Math.round((timeline.at(-1)?.endMs ?? 0) / 1000);
  const length = total >= 60 ? `${Math.floor(total / 60)} min ${total % 60} s` : `${total} s`;
  return `A video of ${video.scenes.length} scene${video.scenes.length === 1 ? "" : "s"}, ${length}${video.idea ? `: ${video.idea}` : "."}`;
}

function error(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "error" };
}

function warning(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message, severity: "warning" };
}
