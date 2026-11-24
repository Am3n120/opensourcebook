/**
 * The video payload (`outputs.payload_json` for format `video`), schema
 * version 1. The contract is engine/docs/video.md; this file is its shape in
 * code. A video is a list of scenes plus `render`, the file its maker made
 * from them. Scene kinds and picture kinds are open words the
 * writer chooses; nothing here lists them.
 */
import type { CiteSpot } from "../cards/contract";
import type { SourceLocator } from "../studio/types";

export const VIDEO_SCHEMA_VERSION = 1;

export interface Video {
  schemaVersion: typeof VIDEO_SCHEMA_VERSION;
  title: string;
  /** The one thing the video carries. */
  idea: string;
  /** The frame's shape, e.g. 9 by 16. */
  aspect: { width: number; height: number };
  scenes: Scene[];
  /** The file made from the scenes; absent until it is made. */
  render?: VideoRender;
  /**
   * What Open Sourcebook's own checks found in the video that did not stop it being kept (a rendered video is kept over anything
   * but a cite untrue to its sources), in words for the person. Absent when they found nothing.
   */
  notes?: string[];
}

export interface Scene {
  id: string;
  /** What the scene does, in the writer's words. */
  kind: string;
  durationMs: number;
  visual: { kind: string; description: string };
  narration: string;
  onScreenText: string[];
  cites: SceneCite[];
}

/** A card's Cite (engine/docs/flashcards.md) without `block`. */
export interface SceneCite {
  sourceId: string;
  spot: CiteSpot;
  chunkId?: string;
  locator?: SourceLocator;
  assetId?: string;
  quote?: string;
}

export interface VideoRender {
  /** The maker that made the file (`scenes`), or `storyboard` on a video made before that maker was taken out (DECISIONS #69). */
  by: string;
  /**
   * Who made it, in words (DECISIONS #54): the maker, the style it used, the
   * agent that wrote it and the voice. Optional; players that do not read
   * it lose nothing.
   */
  maker?: VideoMadeBy;
  /**
   * True when the file lays out each scene in words, not its finished
   * picture and sound: only on videos the storyboard maker made before it
   * was taken out. Every video made now is false.
   */
  storyboard: boolean;
  assetId: string;
  url: string;
  contentType: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  audio: boolean;
  captions: boolean;
  scenes: Array<{ id: string; startMs: number; endMs: number }>;
  renderMs: number;
  madeAt: string;
}

export interface VideoMadeBy {
  id: string;
  label: string;
  style?: { id: string; label: string };
  agent?: { id: string; label?: string; model?: string; effort?: string };
  voice?: { id: string; label: string; real: boolean; /** What a viewer should know about it (no sound, and why), in a line. */ note?: string };
}

/** Bounds every video is checked against (video.md). They bound, they never choose. */
export const VIDEO_LIMITS = {
  maxScenes: 60,
  minSceneMs: 1_500,
  maxSceneMs: 60_000,
  maxMinutes: 30,
  /** Spoken words per second of scene the narration may need. */
  maxWordsPerSecond: 3.5,
  kind: 40,
  visualMin: 20,
  visualMax: 700,
  narration: 1_200,
  onScreenEntries: 4,
  onScreenChars: 120,
  cites: 4,
  quote: 300,
  title: 140,
  idea: 400,
} as const;

/** Shapes a video's frame may take, by setting value. */
export const ASPECTS = {
  portrait: { width: 9, height: 16 },
  landscape: { width: 16, height: 9 },
  square: { width: 1, height: 1 },
} as const;
export type AspectName = keyof typeof ASPECTS;
export const ASPECT_NAMES = Object.keys(ASPECTS) as AspectName[];

/** Words in a piece of narration, as a voice would say them. */
export function spokenWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Where each scene starts and ends when they play back to back at their planned lengths. */
export function plannedTimeline(scenes: readonly Pick<Scene, "id" | "durationMs">[]): Array<{ id: string; startMs: number; endMs: number }> {
  let at = 0;
  return scenes.map((scene) => {
    const span = { id: scene.id, startMs: at, endMs: at + scene.durationMs };
    at += scene.durationMs;
    return span;
  });
}
