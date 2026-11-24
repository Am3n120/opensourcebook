/**
 * The registry the worker uses: the five shapes Open Sourcebook makes (docs/DECISIONS.md
 * #33, and the rows that made audio the fourth and the guide the fifth), in
 * the order every list of them in the app shows: video, flashcards (was the
 * byte), quiz, audio and guide. This file is the one home of that order;
 * nothing else sorts the formats. Flashcards, quiz,
 * audio and guide are always registered; what they say before Start
 * when no maker of theirs can make anything now is their makers' (#66), and
 * audio says it is not ready when nothing here can voice it.
 * Video is registered when a video maker is set up (#54, #69), and
 * otherwise declared, so clients can show it and the planner knows it
 * cannot be made yet. Variety comes from makers and kinds of card or question, never from
 * video (#37), not from more formats here.
 */
import { createAudioDefinition, type AudioDefinitionOptions } from "../engines/audio/definition";
import { createGuideDefinition, type GuideDefinitionOptions } from "../engines/guide/definition";
import { createFlashcardsDefinition, type FlashcardsDefinitionOptions } from "../engines/flashcards/definition";
import { createQuizDefinition, type QuizDefinitionOptions } from "../engines/quiz/definition";
import { createVideoDefinition, type VideoDefinitionOptions } from "../engines/video/definition";
import { FormatRegistry } from "./registry";
import type { FormatDescriptor } from "./types";

export interface DefaultRegistryOptions {
  flashcards?: FlashcardsDefinitionOptions;
  quiz?: QuizDefinitionOptions;
  /** With a maker, video is made; without one it stays declared. */
  video?: VideoDefinitionOptions;
  /** Its makers and its voice; without them it says why it cannot be made here. */
  audio?: AudioDefinitionOptions;
  /** Its makers; without one it says why it cannot be made here. */
  guide?: GuideDefinitionOptions;
}

/**
 * Formats with no engine here (video without a maker). Their settings
 * are empty while they cannot be made. The colour slot names one of the web app's
 * `--fmt-N-*` tokens and the icon one of its line icons (`web/src/design/`).
 */
export const DECLARED_FORMATS: readonly FormatDescriptor[] = [
  { id: "video", label: "video", colorSlot: 1, icon: "play", about: "Something to watch, with nothing sideways: what is best seen happening or built up. It can be short or long and thorough.", blurb: "an explainer to watch, drawn scene by scene", settings: [], defaults: {} },
];

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): FormatRegistry {
  const registry = new FormatRegistry();
  // Registration order is the order clients list the formats in.
  if (options.video && options.video.makers.length > 0) registry.register(createVideoDefinition(options.video));
  else registry.declare(declared("video"));
  registry.register(createFlashcardsDefinition(options.flashcards)).register(createQuizDefinition(options.quiz));
  registry.register(createAudioDefinition(options.audio));
  registry.register(createGuideDefinition(options.guide));
  for (const descriptor of DECLARED_FORMATS) if (!registry.has(descriptor.id)) registry.declare(descriptor);
  return registry;
}

function declared(id: string): FormatDescriptor {
  const descriptor = DECLARED_FORMATS.find((format) => format.id === id);
  if (!descriptor) throw new Error(`No declared descriptor for "${id}".`);
  return descriptor;
}
