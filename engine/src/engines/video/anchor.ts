/**
 * A moment of a video in words (`FormatDefinition.describeAnchor`): the time
 * the person is at, as the video player keeps it (`{ time }` in seconds),
 * with the scene playing then, what it shows, the words on screen and what
 * the voice says around that moment. Where each scene sits comes from the
 * render (`render.scenes`); within a scene the words are placed evenly over
 * its span, since the payload keeps the scene's narration, not each word's
 * time.
 */
import type { AnchorWords, JsonValue } from "../../studio/types";
import type { Video } from "../../video/contract";

/** Words of the narration said before and after the moment, around it. */
const BEFORE = 10;
const AFTER = 5;

export function videoAnchor(video: Video, at: JsonValue): AnchorWords | undefined {
  if (!at || typeof at !== "object" || Array.isArray(at) || typeof at.time !== "number" || !Number.isFinite(at.time) || at.time < 0) return undefined;
  const scenes = Array.isArray(video?.scenes) ? video.scenes : [];
  if (scenes.length === 0) return undefined;
  const ms = at.time * 1000;
  const spans = video.render?.scenes?.length === scenes.length ? video.render.scenes : planned(scenes.map((scene) => scene.durationMs));
  const found = spans.findIndex((span) => ms < span.endMs);
  const index = found === -1 ? spans.length - 1 : found;
  const scene = scenes[index]!;
  const span = spans[index]!;
  const total = video.render?.durationMs ?? spans.at(-1)!.endMs;
  const facts = [`At ${clock(ms)} of ${clock(total)}, in scene ${index + 1} of ${scenes.length}${scene.kind ? ` (${scene.kind})` : ""}.`];
  if (scene.visual?.description) facts.push(`What the scene shows: ${scene.visual.description}`);
  if (scene.onScreenText?.length) facts.push(`Words on screen: ${scene.onScreenText.map((line) => `"${line}"`).join(", ")}`);
  const words = (scene.narration ?? "").split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const share = span.endMs > span.startMs ? Math.min(1, Math.max(0, (ms - span.startMs) / (span.endMs - span.startMs))) : 0;
    const now = Math.min(words.length - 1, Math.floor(share * words.length));
    const from = Math.max(0, now - BEFORE);
    const to = Math.min(words.length, now + AFTER + 1);
    facts.push(`Around this moment the voice says: "${from > 0 ? "… " : ""}${words.slice(from, to).join(" ")}${to < words.length ? " …" : ""}"`);
    facts.push(`The scene's whole narration: "${scene.narration}"`);
  } else facts.push("Nothing is said in this scene.");
  const before = scenes[index - 1]?.narration;
  if (before) facts.push(`The scene before said: "${before}"`);
  for (const cite of scene.cites ?? []) if (cite.quote) facts.push(`The scene cites: "${cite.quote}"`);
  if (video.idea) facts.push(`The video's one idea: ${video.idea}`);
  return { label: `at ${clock(ms)}`, facts };
}

function planned(lengths: number[]): Array<{ startMs: number; endMs: number }> {
  let at = 0;
  return lengths.map((length) => {
    const span = { startMs: at, endMs: at + length };
    at += length;
    return span;
  });
}

/** 0:42, 1:05:09. */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
