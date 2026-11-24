/**
 * The audio format's registry entry (engine/docs/audio.md): a spoken
 * walk-through with no picture, the fourth thing Open Sourcebook makes beside video,
 * flashcards and quiz. Its descriptor, settings, makers, what it says before
 * it is made and once it is, a moment of it in words, and what stops it on
 * this computer: audio without a voice is nothing, so when the scenes service
 * says it cannot voice audio (no voice key), the format is not ready and says
 * why, in the service's words, through its tile, its command and the planner.
 */
import type { FormatDefinition, FormatDescriptor, Glimpse } from "../../studio/types";
import { plainLine } from "../../studio/glimpse";
import { playingSize } from "../../studio/size";
import { MakerRegistry, MakersEngine, OPEN_PICK, type ItemMaker, type MadeBlueprint } from "../makers";
import { audioAnchor } from "./anchor";
import { AUDIO_LIMITS, AUDIO_SCHEMA_VERSION, minutesWords, type AudioPayload } from "./contract";
import { DEFAULT_AUDIO_SETTINGS, fitMinutes, parseAudioSettings, type AudioSettings } from "./settings";
import type { AudioVoiceClient } from "./voice-client";

export interface AudioDefinitionOptions {
  /** Its makers (the person's own agent). With none, nothing here can write one. */
  makers?: ItemMaker<AudioSettings, unknown, AudioPayload>[];
  /** What voices it: the scenes service on this computer. Without it, audio is not made here. */
  voice?: AudioVoiceClient;
  defaultMaker?: string;
}

export type AudioDefinition = FormatDefinition<AudioSettings, MadeBlueprint, AudioPayload>;

export function audioDescriptor(makers?: MakerRegistry<AudioSettings, AudioPayload>): FormatDescriptor {
  const pick = [...(makers?.settingFields() ?? []), ...(makers?.agentFields("chat") ?? [])];
  return {
    id: "audio",
    label: "audio",
    plural: "audio walk-throughs",
    singular: "audio walk-through",
    colorSlot: 4,
    icon: "listen",
    about:
      "Something to listen to, with no picture: one voice walking the person through the material, for when their eyes and hands are busy (walking, commuting, doing something else). Suits following a story, an argument or a process from start to end, a companion to a video on the same topic, a longer walk through a chapter, or going back over what was learned. Not for what has to be seen (a diagram, a derivation, a table to compare) or recalled word for word. Its length in minutes sets how far it goes.",
    blurb: "a spoken walk-through to listen to, with no picture",
    settings: [
      {
        key: "minutes",
        label: "Length",
        help: "About how long it runs, which is how far it goes: a few minutes on one idea, twenty or more for a whole chapter.",
        kind: "number",
        min: 0,
        max: AUDIO_LIMITS.maxMinutes,
        step: 1,
        unit: "min",
        specialValues: [{ value: 0, means: "auto", label: "Fit to the brief", description: "Timed when it is written, as long as the brief and the sources need." }],
      },
      ...pick,
    ],
    defaults: { ...DEFAULT_AUDIO_SETTINGS, ...(pick.some((field) => field.key === "maker") ? { maker: OPEN_PICK } : {}) },
    // Making times are kept apart by length (engine/docs/api.md, "Making times"); it is spoken by the computer's voice.
    timing: { setting: "minutes", edges: [2, 4, 7, 12, 20] },
    voiced: true,
  };
}

export function audioMakers(options: AudioDefinitionOptions): MakerRegistry<AudioSettings, AudioPayload> {
  const registry = new MakerRegistry<AudioSettings, AudioPayload>("audio walk-through", options.defaultMaker ? { defaultId: options.defaultMaker } : {});
  for (const maker of options.makers ?? []) registry.register(maker);
  return registry;
}

export function createAudioDefinition(options: AudioDefinitionOptions = {}): AudioDefinition {
  const makers = audioMakers(options);
  const engine = new MakersEngine<AudioSettings, AudioPayload>("audio", AUDIO_SCHEMA_VERSION, makers);
  return {
    descriptor: audioDescriptor(makers),
    engine,
    maxRepairRounds: Math.max(0, ...makers.list().map((maker) => maker.maxRepairRounds)),
    repairRoundsFor: (blueprint) => engine.repairRounds(blueprint),
    parseSettings: parseAudioSettings,
    unavailable: () => {
      if (!options.voice) return "Audio is voiced by Open Sourcebook's scene maker on this computer, which is not set up here: start Open Sourcebook again.";
      if (makers.size === 0) return "Audio is written by your own agent, which is not connected: start Open Sourcebook again, with Claude Code installed and signed in.";
      const voice = options.voice.heard();
      return voice && !voice.ready ? (voice.problem ?? "There is no voice on this computer to speak it.") : undefined;
    },
    itemIssues: (settings) => makers.issues(settings),
    estimateCost: (input) => {
      const resolved = makers.resolve(input.settings);
      return "maker" in resolved ? resolved.maker.estimateCost(input) : { unpriced: true, basis: "nothing here can make an audio walk-through" };
    },
    settle: (settings, input) => ({ ...makers.settle(settings), ...makers.settleAgent("audio", settings, input.picks), ...(settings.minutes === 0 && input.sourceChars > 0 ? { minutes: fitMinutes(input.sourceChars) } : {}) }),
    describe: (settings) => [makers.labelFor(settings) ?? "No maker set up here", settings.minutes > 0 ? `about ${minutesWords(settings.minutes)}` : "Length fits the brief"],
    describeMade: (audio) => {
      const ms = audio?.file?.durationMs;
      const parts = Array.isArray(audio?.parts) ? audio.parts.length : 0;
      return [ms ? minutesWords(ms / 60_000) : "Not voiced yet", `${parts} part${parts === 1 ? "" : "s"}`];
    },
    glimpse: audioGlimpse,
    // How long it plays, from its file; not said before it is voiced.
    size: (audio) => playingSize(audio?.file?.durationMs),
    describeAnchor: audioAnchor,
  };
}

/** An audio's glimpse: what it walks through. */
export function audioGlimpse(audio: AudioPayload): Glimpse | undefined {
  const text = plainLine(typeof audio?.about === "string" && audio.about.trim() ? audio.about : audio?.parts?.[0]?.text);
  return text ? { text } : undefined;
}
