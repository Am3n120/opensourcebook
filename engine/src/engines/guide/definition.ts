/**
 * The guide format's registry entry (engine/docs/guide.md): a page or a few
 * of notes to keep, print and change by hand, the fifth thing Open Sourcebook makes
 * beside video, flashcards, quiz and audio. Its descriptor, settings,
 * makers, what it says before it is made and once it is, a spot of it in
 * words, and how a change the person makes by hand is laid over it.
 */
import type { FormatDefinition, FormatDescriptor, Glimpse } from "../../studio/types";
import { plainLine } from "../../studio/glimpse";
import { countSize } from "../../studio/size";
import { MakerRegistry, MakersEngine, OPEN_PICK, type ItemMaker, type MadeBlueprint } from "../makers";
import { guideAnchor } from "./anchor";
import { GUIDE_LIMITS, GUIDE_SCHEMA_VERSION, guideWords, pagesOf, pagesWords, type GuidePayload } from "./contract";
import { editGuide } from "./edit";
import { DEFAULT_GUIDE_SETTINGS, fitPages, parseGuideSettings, type GuideSettings } from "./settings";

export interface GuideDefinitionOptions {
  /** Its makers (the person's own agent). With none, nothing here can write one. */
  makers?: ItemMaker<GuideSettings, unknown, GuidePayload>[];
  defaultMaker?: string;
}

export type GuideDefinition = FormatDefinition<GuideSettings, MadeBlueprint, GuidePayload>;

export function guideDescriptor(makers?: MakerRegistry<GuideSettings, GuidePayload>): FormatDescriptor {
  const pick = [...(makers?.settingFields() ?? []), ...(makers?.agentFields("chat") ?? [])];
  return {
    id: "guide",
    label: "guide",
    plural: "guides",
    singular: "guide",
    colorSlot: 5,
    icon: "book",
    about:
      "A page or a few of notes to keep: what matters in the material, under headings, every claim with its cite, which the person prints, looks things up in and changes by hand afterwards. A reference, not a lesson. Suits a summary to revise from, key terms and definitions, formulas and steps in one place, a cheat sheet before an exam, or the notes that go with a video or a chapter. Not for learning something for the first time (a video teaches it) or for practising recall (flashcards and a quiz do that). Its length in printed pages sets how far it goes.",
    blurb: "notes to keep, print and change by hand",
    settings: [
      {
        key: "pages",
        label: "Length",
        help: "About how many printed pages it fills, which is how much it keeps: one page for a topic, a few for a whole course.",
        kind: "number",
        min: 0,
        max: GUIDE_LIMITS.maxPages,
        step: 1,
        unit: "pages",
        specialValues: [{ value: 0, means: "auto", label: "Fit to the brief", description: "Sized when it is written, as long as the brief and the sources need." }],
      },
      ...pick,
    ],
    defaults: { ...DEFAULT_GUIDE_SETTINGS, ...(pick.some((field) => field.key === "maker") ? { maker: OPEN_PICK } : {}) },
  };
}

export function guideMakers(options: GuideDefinitionOptions): MakerRegistry<GuideSettings, GuidePayload> {
  const registry = new MakerRegistry<GuideSettings, GuidePayload>("guide", options.defaultMaker ? { defaultId: options.defaultMaker } : {});
  for (const maker of options.makers ?? []) registry.register(maker);
  return registry;
}

export function createGuideDefinition(options: GuideDefinitionOptions = {}): GuideDefinition {
  const makers = guideMakers(options);
  const engine = new MakersEngine<GuideSettings, GuidePayload>("guide", GUIDE_SCHEMA_VERSION, makers);
  return {
    descriptor: guideDescriptor(makers),
    engine,
    maxRepairRounds: Math.max(0, ...makers.list().map((maker) => maker.maxRepairRounds)),
    repairRoundsFor: (blueprint) => engine.repairRounds(blueprint),
    parseSettings: parseGuideSettings,
    unavailable: () => (makers.size === 0 ? "A guide is written by your own agent, which is not connected: start Open Sourcebook again, with Claude Code installed and signed in." : undefined),
    itemIssues: (settings) => makers.issues(settings),
    estimateCost: (input) => {
      const resolved = makers.resolve(input.settings);
      return "maker" in resolved ? resolved.maker.estimateCost(input) : { unpriced: true, basis: "nothing here can make a guide" };
    },
    settle: (settings, input) => ({ ...makers.settle(settings), ...makers.settleAgent("guide", settings, input.picks), ...(settings.pages === 0 && input.sourceChars > 0 ? { pages: fitPages(input.sourceChars) } : {}) }),
    describe: (settings) => [makers.labelFor(settings) ?? "No maker set up here", settings.pages > 0 ? `about ${pagesWords(settings.pages)}` : "Length fits the brief"],
    describeMade: (guide) => {
      const sections = Array.isArray(guide?.sections) ? guide.sections : [];
      return [`about ${pagesWords(pagesOf(guideWords({ sections })))}`, `${sections.length} section${sections.length === 1 ? "" : "s"}`];
    },
    glimpse: guideGlimpse,
    // Printed pages by halves, counted from its words as `describeMade` says them.
    size: (guide) => (Array.isArray(guide?.sections) && guide.sections.length > 0 ? countSize(pagesOf(guideWords({ sections: guide.sections })), "page", "pages") : undefined),
    describeAnchor: guideAnchor,
    edit: (guide, edited, now) => editGuide(guide, edited, now),
  };
}

/** A guide's glimpse: what it covers. */
export function guideGlimpse(guide: GuidePayload): Glimpse | undefined {
  const text = plainLine(typeof guide?.about === "string" && guide.about.trim() ? guide.about : guide?.sections?.[0]?.points?.[0]?.text);
  return text ? { text } : undefined;
}
