/**
 * Makers for the byte and the quiz (docs/DECISIONS.md #33, #37, #54): what
 * makes one. A shape has one payload; a maker is one way of making it, in
 * the same shape the video makers have (video/makers.ts): its own engine,
 * its words for the form and the planner, its estimate, and what it needs.
 *
 * The format's engine is a dispatcher over its registry: it picks the maker
 * an item asks for, or the default when the item leaves it to Open Sourcebook, records
 * the pick in the blueprint saved on the job, and runs that maker's steps.
 * A retry reads the pick back, so it makes the same thing. Nothing outside
 * a maker's own module names it.
 *
 * The default is the one asked for by the engine's settings when it can
 * make things now, else the first registered one that can, else the first.
 * "Can now" is what the maker last heard (`ready`); it never calls out.
 */
import type {
  CostEstimate,
  CostEstimateInput,
  EngineContext,
  EngineOutput,
  JsonValue,
  OutputEngine,
  PicksByScope,
  SettingField,
  ValidationReport,
} from "../studio/types";
import { agentField, settleAgentPick, type AgentSettings } from "./agent-fields";
import { JobFailure } from "../jobs/lifecycle";

/** The value of `maker` that leaves the pick open until the item is made. */
export const OPEN_PICK = "auto";

/** How the open pick of a maker reads on screen: what it does, not who does it. */
export const OPEN_MAKER_LABEL = "Whichever is ready";

/** What the open pick of a maker does, naming the maker it would get now. */
export function openMakerWords(now: string): string {
  return `Uses the maker that can make it on this computer when it is made: now that is ${now}.`;
}

const MAKER_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

export function isMakerId(value: unknown): value is string {
  return typeof value === "string" && MAKER_ID_PATTERN.test(value);
}

/** Whether a maker can make things right now, for Settings and before Start. */
export interface MakerStatus {
  available: boolean;
  /** Why not, in plain words with what to do, when it is not. */
  problem?: string;
  /** Who writes for it, when someone does (the person's own agent). */
  agent?: { id?: string; label?: string; model?: string };
}

export interface ItemMaker<Settings, Blueprint = unknown, Payload = unknown> {
  /** Stored in an item's `maker` setting and on the job. Lowercase letters, digits and dashes. */
  readonly id: string;
  /** Short, as the form shows it. */
  readonly label: string;
  /** What it makes, how and what it needs, for the form and for the planner. */
  readonly description: string;
  readonly engine: OutputEngine<Settings, Blueprint, Payload>;
  readonly maxRepairRounds: number;
  estimateCost(input: CostEstimateInput<Settings>): CostEstimate;
  /**
   * Why it cannot make an item with these settings now, each in words that
   * follow the item's title, with what to do. From what it last heard. Empty
   * when it can.
   */
  issues?(settings: Settings): string[];
  /** False when it last heard it cannot make anything now; undefined when it has not heard. Absent: always ready. */
  ready?(): boolean | undefined;
  /** Asks what it needs whether it is there now. Absent: always available. */
  status?(signal?: AbortSignal): Promise<MakerStatus>;
  /** True when the person's own agent makes it, so the item's agent, model and effort reach it. */
  readonly usesAgent?: boolean;
}

export class MakerRegistry<Settings extends { maker?: string }, Payload = unknown> {
  private readonly makers = new Map<string, ItemMaker<Settings, unknown, Payload>>();
  private readonly wantedDefault?: string;

  /**
   * `thing` names the shape in messages ("set of flashcards"). `defaultId` is the maker
   * the engine's settings prefer; `legacy` is the maker a blueprint saved
   * before makers existed belongs to.
   */
  constructor(
    readonly thing: string,
    options: { defaultId?: string; legacy?: string } = {},
  ) {
    if (options.defaultId?.trim()) this.wantedDefault = options.defaultId.trim();
    this.legacy = options.legacy;
  }

  readonly legacy?: string;

  register(maker: ItemMaker<Settings, unknown, Payload>): this {
    if (!isMakerId(maker.id) || maker.id === OPEN_PICK) throw new Error(`"${maker.id}" is not a valid ${this.thing} maker id.`);
    if (this.makers.has(maker.id)) throw new Error(`The ${this.thing} maker "${maker.id}" is already registered.`);
    if (!maker.label.trim() || !maker.description.trim()) throw new Error(`The ${this.thing} maker "${maker.id}" needs a label and a description.`);
    this.makers.set(maker.id, maker);
    return this;
  }

  get(id: string): ItemMaker<Settings, unknown, Payload> | undefined {
    return this.makers.get(id);
  }

  list(): ItemMaker<Settings, unknown, Payload>[] {
    return [...this.makers.values()];
  }

  get size(): number {
    return this.makers.size;
  }

  /** The maker "auto" picks now: the preferred one when it can make things, else the first that can, else the first. */
  default(): ItemMaker<Settings, unknown, Payload> | undefined {
    const usable = (maker: ItemMaker<Settings, unknown, Payload> | undefined) => maker !== undefined && maker.ready?.() !== false;
    const wanted = this.wantedDefault ? this.makers.get(this.wantedDefault) : undefined;
    if (usable(wanted)) return wanted;
    return this.list().find(usable) ?? wanted ?? this.list()[0];
  }

  /** The maker an item's settings ask for: theirs, or the default when they leave it to Open Sourcebook. */
  resolve(settings: Pick<Settings, "maker">): { maker: ItemMaker<Settings, unknown, Payload> } | { missing: string } {
    const wanted = settings.maker && settings.maker !== OPEN_PICK ? settings.maker : undefined;
    if (wanted) {
      const maker = this.makers.get(wanted);
      return maker ? { maker } : { missing: wanted };
    }
    const fallback = this.default();
    return fallback ? { maker: fallback } : { missing: OPEN_PICK };
  }

  /** Why an item with these settings cannot be made now: no maker, its maker is not set up, or it says it cannot. */
  issues(settings: Settings): string[] {
    const resolved = this.resolve(settings);
    if ("missing" in resolved) {
      return resolved.missing === OPEN_PICK
        ? [`nothing here can make a ${this.thing}: connect your agent (start the connector on this computer) or add a model API key`]
        : [`its maker "${resolved.missing}" is not set up here: pick another maker`];
    }
    return resolved.maker.issues?.(settings) ?? [];
  }

  /** The maker an item that leaves it open would get now, as the `maker` setting to store; empty when it names one or none is set up. */
  settle(settings: Pick<Settings, "maker">): { maker?: string } {
    if (settings.maker && settings.maker !== OPEN_PICK) return {};
    const fallback = this.default();
    return fallback ? { maker: fallback.id } : {};
  }

  /** The label of the maker an item's settings get: theirs, or the one an open pick gets now. */
  labelFor(settings: Pick<Settings, "maker">): string | undefined {
    const resolved = this.resolve(settings);
    return "maker" in resolved ? resolved.maker.label : undefined;
  }

  /**
   * The maker's agent field (agent-fields.ts), when some maker runs the
   * person's agent; shown only while such a maker is picked (or the one an
   * open pick gets) when other makers do not run it.
   */
  agentFields(turnKind: "chat" | "work"): SettingField[] {
    const list = this.list();
    const agentMakers = list.filter((maker) => maker.usesAgent === true);
    if (agentMakers.length === 0) return [];
    if (agentMakers.length === list.length || list.length < 2) return [agentField(turnKind)];
    const fallback = this.default();
    const when = [...(fallback && agentMakers.includes(fallback) ? [OPEN_PICK] : []), ...agentMakers.map((maker) => maker.id)];
    return [agentField(turnKind, { key: "maker", in: when })];
  }

  /**
   * What an item's open agent and effort get from the remembered pick of
   * `scope`, only when the maker it gets runs the person's agent.
   */
  settleAgent(scope: string, settings: Settings & AgentSettings, picks?: PicksByScope): Record<string, JsonValue> {
    const resolved = this.resolve(settings);
    if (!("maker" in resolved) || resolved.maker.usesAgent !== true) return {};
    return settleAgentPick(scope, settings, picks);
  }

  /** The `maker` setting, offered only when there is more than one maker. */
  settingFields(): SettingField[] {
    const list = this.list();
    const fallback = this.default();
    if (list.length < 2 || !fallback) return [];
    return [
      {
        key: "maker",
        label: "Maker",
        help: `What makes the ${this.thing}.`,
        kind: "choice",
        options: [
          { value: OPEN_PICK, label: OPEN_MAKER_LABEL, description: openMakerWords(fallback.label) },
          ...list.map((maker) => ({ value: maker.id, label: maker.label, description: maker.description })),
        ],
      },
    ];
  }
}

/** What the dispatcher saves on the job: the maker it picked, and that maker's own blueprint. */
export interface MadeBlueprint {
  maker: string;
  made: unknown;
}

/** A format's engine where every step is the picked maker's. */
export class MakersEngine<Settings extends { maker?: string }, Payload> implements OutputEngine<Settings, MadeBlueprint, Payload> {
  constructor(
    readonly type: string,
    readonly schemaVersion: number,
    readonly makers: MakerRegistry<Settings, Payload>,
  ) {}

  async plan(ctx: EngineContext<Settings>): Promise<MadeBlueprint> {
    const maker = this.pick(ctx.node.settings);
    const made = await maker.engine.plan(this.forMaker(ctx, maker));
    return { maker: maker.id, made };
  }

  async generate(ctx: EngineContext<Settings>, blueprint: MadeBlueprint): Promise<EngineOutput<Payload>> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.generate(this.forMaker(ctx, maker), made);
  }

  async validate(ctx: EngineContext<Settings>, output: EngineOutput<Payload>, blueprint: MadeBlueprint): Promise<ValidationReport> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.validate(this.forMaker(ctx, maker), output, made);
  }

  async repair(ctx: EngineContext<Settings>, output: EngineOutput<Payload>, report: ValidationReport, blueprint: MadeBlueprint): Promise<EngineOutput<Payload>> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.repair(this.forMaker(ctx, maker), output, report, made);
  }

  async produce(ctx: EngineContext<Settings>, output: EngineOutput<Payload>, blueprint: MadeBlueprint): Promise<EngineOutput<Payload>> {
    const { maker, made } = this.saved(blueprint);
    return maker.engine.produce ? maker.engine.produce(this.forMaker(ctx, maker), output, made) : output;
  }

  repairRounds(blueprint: MadeBlueprint): number | undefined {
    return this.found(blueprint)?.maker.maxRepairRounds;
  }

  private pick(settings: Settings): ItemMaker<Settings, unknown, Payload> {
    const resolved = this.makers.resolve(settings);
    if ("missing" in resolved) throw missingMaker(this.makers.thing, resolved.missing);
    return resolved.maker;
  }

  private saved(blueprint: MadeBlueprint): { maker: ItemMaker<Settings, unknown, Payload>; made: unknown } {
    const found = this.found(blueprint);
    if (!found) throw missingMaker(this.makers.thing, isMadeBlueprint(blueprint) ? blueprint.maker : (this.makers.legacy ?? OPEN_PICK));
    return found;
  }

  /** The maker a saved blueprint names; one saved before makers existed belongs to the legacy maker. */
  private found(blueprint: MadeBlueprint): { maker: ItemMaker<Settings, unknown, Payload>; made: unknown } | undefined {
    if (!isMadeBlueprint(blueprint)) {
      const maker = this.makers.legacy ? this.makers.get(this.makers.legacy) : undefined;
      return maker ? { maker, made: blueprint } : undefined;
    }
    const maker = this.makers.get(blueprint.maker);
    return maker ? { maker, made: blueprint.made } : undefined;
  }

  /** The item's settings with the pick filled in, so a maker never resolves "auto" itself. */
  private forMaker(ctx: EngineContext<Settings>, maker: ItemMaker<Settings, unknown, Payload>): EngineContext<Settings> {
    if (ctx.node.settings.maker === maker.id) return ctx;
    return { ...ctx, node: { ...ctx.node, settings: { ...ctx.node.settings, maker: maker.id } } };
  }
}

function isMadeBlueprint(value: unknown): value is MadeBlueprint {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { maker?: unknown }).maker === "string" && "made" in value;
}

/** A stored item whose maker is not set up here fails with that said, never as another maker. */
export function missingMaker(thing: string, id: string): JobFailure {
  return id === OPEN_PICK
    ? new JobFailure(`Nothing on this engine can make a ${thing}: no agent is connected and no model API key is set.`, false, "no_maker")
    : new JobFailure(`The ${thing} maker "${id}" is not set up on this engine.`, false, "maker_missing");
}

/** Reads the `maker` setting: "auto" or an id, checked by shape only (a maker that is not set up now is said before Start). */
export function parseMakerSetting(value: unknown): { ok: true; maker?: string } | { ok: false; message: string } {
  if (value === undefined) return { ok: true };
  if (value === OPEN_PICK || isMakerId(value)) return { ok: true, maker: value as string };
  return { ok: false, message: `maker must be "${OPEN_PICK}" or an id of lowercase letters, digits and dashes` };
}
