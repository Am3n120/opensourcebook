/**
 * The format registry and the one loop every engine runs through. Nothing
 * outside this file decides what a format is or how its steps are ordered;
 * routes, the plan runner and the planning skill all ask here.
 *
 * A format is either declared (a descriptor only: clients can show it, no
 * engine makes it yet) or registered (descriptor plus engine). Ids and
 * aliases are unique across both.
 */
import type {
  AnchorWords,
  EngineContext,
  EngineOutput,
  FormatDefinition,
  FormatDescriptor,
  FormatId,
  Glimpse,
  JsonValue,
  MadeSize,
  SettingCondition,
  SettingField,
  ValidationReport,
} from "./types";
import { isFormatId } from "./types";

export class UnknownFormatError extends Error {
  constructor(readonly format: string) {
    super(`No engine is registered for format "${format}".`);
    this.name = "UnknownFormatError";
  }
}

/**
 * A descriptor as `GET /v1/formats` serves it: `ready` when an engine can
 * make it now; `problem`, when it cannot because of something the person
 * can fix, says what (`FormatDefinition.unavailable`).
 */
export interface FormatView extends FormatDescriptor {
  ready: boolean;
  problem?: string;
}

interface Entry {
  descriptor: FormatDescriptor;
  definition?: FormatDefinition;
}

export class FormatRegistry {
  private readonly entries = new Map<FormatId, Entry>();
  /** Every id and alias → the id it stands for. */
  private readonly ids = new Map<string, FormatId>();

  /** A format clients can show but no engine makes yet. */
  declare(descriptor: FormatDescriptor): this {
    this.add({ descriptor });
    return this;
  }

  /** A format with its engine. */
  register<Settings, Blueprint, Payload>(definition: FormatDefinition<Settings, Blueprint, Payload>): this {
    const { id } = definition.descriptor;
    if (definition.engine.type !== id) {
      throw new Error(`Format "${id}" was registered with an engine for "${definition.engine.type}".`);
    }
    const defaults = definition.parseSettings(definition.descriptor.defaults);
    if (!defaults.ok) throw new Error(`Format "${id}": its own defaults do not parse.`);
    this.add({ descriptor: definition.descriptor, definition: definition as unknown as FormatDefinition });
    return this;
  }

  /** The id `idOrAlias` stands for, or undefined when no format declares it. */
  resolve(idOrAlias: string): FormatId | undefined {
    return this.ids.get(idOrAlias);
  }

  /** Declared or registered, by id or alias. */
  has(idOrAlias: string): boolean {
    return this.ids.has(idOrAlias);
  }

  descriptor(idOrAlias: string): FormatDescriptor | undefined {
    return this.entry(idOrAlias)?.descriptor;
  }

  /** The engine-backed definition, or undefined (unknown, or declared without an engine). */
  get(idOrAlias: string): FormatDefinition | undefined {
    return this.entry(idOrAlias)?.definition;
  }

  require(idOrAlias: string): FormatDefinition {
    const definition = this.get(idOrAlias);
    if (!definition) throw new UnknownFormatError(idOrAlias);
    return definition;
  }

  /** The id a stored type is served as: its format's id, or the type itself when no format declares it. */
  servedType(type: string): string {
    return this.resolve(type) ?? type;
  }

  /** Every id a stored row of this format may carry: the id and its aliases. */
  storedTypes(idOrAlias: string): string[] {
    const descriptor = this.descriptor(idOrAlias);
    return descriptor ? [descriptor.id, ...(descriptor.aliases ?? [])] : [idOrAlias];
  }

  /**
   * A stored output as clients see it: under its format's current id, and
   * with its payload upgraded to the current schema version when the format
   * knows how. Read-time only; nothing is written back.
   */
  served<T extends { type: string; schemaVersion: number; payload: unknown }>(output: T): T {
    const type = this.servedType(output.type);
    const upgraded = this.get(type)?.upgrade?.(output.payload, output.schemaVersion);
    return { ...output, type, ...(upgraded ? { payload: upgraded.payload, schemaVersion: upgraded.schemaVersion } : {}) };
  }

  /** What a list shows of a served output besides its title; undefined when its format shows nothing or cannot read it. */
  glimpse(output: { type: string; payload: unknown }): Glimpse | undefined {
    try {
      const glimpse = this.get(output.type)?.glimpse?.(output.payload);
      return glimpse && (glimpse.text || glimpse.media) ? glimpse : undefined;
    } catch {
      return undefined;
    }
  }

  /** How big a served output is, in its format's unit; undefined when its format does not say or cannot read it. */
  size(output: { type: string; payload: unknown }): MadeSize | undefined {
    try {
      const size = this.get(output.type)?.size?.(output.payload);
      return size && Number.isFinite(size.count) && size.count > 0 && size.unit.trim() ? size : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A spot in a served output said in words by its format
   * (`describeAnchor`); undefined when the format has no words for spots or
   * cannot read this one.
   */
  anchor(output: { type: string; payload: unknown }, at: JsonValue): AnchorWords | undefined {
    try {
      const words = this.get(output.type)?.describeAnchor?.(output.payload, at);
      return words && words.label.trim() ? { label: words.label.trim(), facts: words.facts.filter((fact) => fact.trim()) } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Formats an engine can make now, in registration order. This is what the planner may use. */
  ready(): FormatId[] {
    return [...this.entries.values()].filter((entry) => entry.definition && !problemOf(entry)).map((entry) => entry.descriptor.id);
  }

  /** Why a format cannot be made now, in its own words; undefined when it can, or when it only has no engine. */
  problem(idOrAlias: string): string | undefined {
    const entry = this.entry(idOrAlias);
    return entry ? problemOf(entry) : undefined;
  }

  /** Every format, in registration order. */
  views(): FormatView[] {
    return [...this.entries.values()].map((entry) => {
      const problem = problemOf(entry);
      return { ...entry.descriptor, ready: entry.definition !== undefined && !problem, ...(problem ? { problem } : {}) };
    });
  }

  private entry(idOrAlias: string): Entry | undefined {
    const id = this.ids.get(idOrAlias);
    return id === undefined ? undefined : this.entries.get(id);
  }

  private add(entry: Entry): void {
    const { id, aliases = [] } = entry.descriptor;
    for (const name of [id, ...aliases]) {
      if (!isFormatId(name)) throw new Error(`"${name}" is not a valid format id.`);
      if (this.ids.has(name)) throw new Error(`Format id "${name}" is already taken.`);
    }
    if (new Set([id, ...aliases]).size !== aliases.length + 1) throw new Error(`Format "${id}" repeats an id in its aliases.`);
    if (!Number.isInteger(entry.descriptor.colorSlot) || entry.descriptor.colorSlot < 1 || entry.descriptor.colorSlot > FORMAT_COLOR_SLOTS) {
      throw new Error(`Format "${id}": colorSlot must be 1 to ${FORMAT_COLOR_SLOTS}.`);
    }
    checkOptions(entry.descriptor);
    checkAgentFields(entry.descriptor);
    this.entries.set(id, entry);
    for (const name of [id, ...aliases]) this.ids.set(name, id);
  }
}

/** What a registered format says stops it now; a format that cannot say is taken at its word that it can. */
function problemOf(entry: Entry): string | undefined {
  try {
    return entry.definition?.unavailable?.()?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** At most one maker's agent field and one reviewer field, so a scope's default has one setting to settle. */
function checkAgentFields(descriptor: FormatDescriptor): void {
  const agents = descriptor.settings.filter((field) => field.kind === "agent");
  for (const role of ["make", "review"] as const) {
    if (agents.filter((field) => field.kind === "agent" && (field.role ?? "make") === role).length > 1) {
      throw new Error(`Format "${descriptor.id}": at most one agent setting with role "${role}".`);
    }
  }
}

/**
 * Every option a setting offers is a distinct code with words a form can
 * show in its place, and a picture only as a path on this engine. A setting
 * shown only while another holds some value names a setting of the same
 * format, and values that setting can hold.
 */
function checkOptions(descriptor: FormatDescriptor): void {
  const fields = new Map(descriptor.settings.map((field) => [field.key, field]));
  for (const field of descriptor.settings) {
    if (field.showWhen) checkShowWhen(descriptor, field.key, field.showWhen, fields);
    if (field.kind !== "choice" && field.kind !== "choices") continue;
    const values = field.options.map((option) => option.value);
    if (values.length === 0 || new Set(values).size !== values.length) {
      throw new Error(`Format "${descriptor.id}": setting "${field.key}" needs options with distinct values.`);
    }
    for (const option of field.options) {
      if (!option.label?.trim() || !option.description?.trim()) {
        throw new Error(`Format "${descriptor.id}": option "${option.value}" of "${field.key}" needs a label and a description.`);
      }
      if (option.preview !== undefined && !/^\/v1\/[^/\s][^\s]*$/.test(option.preview)) {
        throw new Error(`Format "${descriptor.id}": the preview of option "${option.value}" of "${field.key}" must be a path on this engine (/v1/...).`);
      }
    }
  }
}

function checkShowWhen(descriptor: FormatDescriptor, key: string, condition: SettingCondition, fields: Map<string, SettingField>): void {
  const other = fields.get(condition.key);
  const say = (why: string) => new Error(`Format "${descriptor.id}": setting "${key}" is shown when ${why}.`);
  if (!other || condition.key === key) throw say(`"${condition.key}", which is not another of its settings`);
  if (!Array.isArray(condition.in) || condition.in.length === 0 || condition.in.some((value) => typeof value !== "string" || !value)) {
    throw say(`"${condition.key}" is one of no values`);
  }
  if (other.kind === "choice" || other.kind === "choices") {
    const offered = new Set(other.options.map((option) => option.value));
    const unknown = condition.in.find((value) => !offered.has(value));
    if (unknown !== undefined) throw say(`"${condition.key}" is "${unknown}", which it does not offer`);
  }
}

/** How many neutral colour slots the palette has (tokens.css, OpenSourcebookTheme). */
export const FORMAT_COLOR_SLOTS = 8;

export interface EngineRunOptions<Blueprint> {
  /** A blueprint saved by an earlier attempt; when present `plan` is skipped. */
  blueprint?: Blueprint;
  /** Called once with a fresh blueprint so the runner can save it on the job. */
  onBlueprint?(blueprint: Blueprint): void | Promise<void>;
  /** Called with every validation report: round 0 is the first output, then one per repair round. */
  onReport?(report: ValidationReport, round: number): void | Promise<void>;
}

export interface EngineRunResult<Payload> {
  output: EngineOutput<Payload>;
  report: ValidationReport;
  repairRounds: number;
}

/**
 * plan → generate → validate → repair (at most `maxRepairRounds` times),
 * then produce when the engine has that step and the output is valid.
 * Returns the last output with its last report; the caller decides what an
 * invalid result means for the job. Stops between steps once the job's signal
 * is aborted.
 */
export async function runEngine<Settings, Blueprint, Payload>(
  definition: FormatDefinition<Settings, Blueprint, Payload>,
  ctx: EngineContext<Settings>,
  options: EngineRunOptions<Blueprint> = {},
): Promise<EngineRunResult<Payload>> {
  const { engine } = definition;
  const stopIfCancelled = () => ctx.services.signal?.throwIfAborted();

  let blueprint = options.blueprint;
  if (blueprint === undefined) {
    stopIfCancelled();
    blueprint = await engine.plan(ctx);
    await options.onBlueprint?.(blueprint);
  }

  const maxRepairRounds = definition.repairRoundsFor?.(blueprint) ?? definition.maxRepairRounds;
  // The newest whole output an earlier attempt made (after generate, or
  // after a repair round) is the place to continue from.
  const checkpoint = ctx.services.checkpoint;
  // A draft belongs to a saved blueprint; a fresh plan starts clean.
  const saved = options.blueprint === undefined ? undefined : readDraft<Payload>(checkpoint?.get(DRAFT_KEY));
  let output: EngineOutput<Payload>;
  let repairRounds = 0;
  if (saved?.produced) {
    // An earlier attempt validated and produced this output (its reports are
    // on the job); only the write was lost, so nothing is checked or paid again.
    return { output: saved.output, report: { valid: true, issues: [] }, repairRounds: saved.repairRounds };
  }
  if (saved) {
    output = saved.output;
    repairRounds = Math.min(saved.repairRounds, maxRepairRounds);
  } else {
    stopIfCancelled();
    output = await engine.generate(ctx, blueprint);
    await checkpoint?.put(DRAFT_KEY, { output, repairRounds } as unknown as JsonValue);
  }
  stopIfCancelled();
  let report = await engine.validate(ctx, output, blueprint);
  await options.onReport?.(report, repairRounds);

  while (!report.valid && repairRounds < maxRepairRounds) {
    stopIfCancelled();
    output = await engine.repair(ctx, output, report, blueprint);
    repairRounds += 1;
    await checkpoint?.put(DRAFT_KEY, { output, repairRounds } as unknown as JsonValue);
    stopIfCancelled();
    report = await engine.validate(ctx, output, blueprint);
    await options.onReport?.(report, repairRounds);
  }

  if (report.valid && engine.produce) {
    stopIfCancelled();
    await ctx.services.progress({ stage: "producing", progress: 0.9 });
    output = await engine.produce(ctx, output, blueprint);
    await checkpoint?.put(DRAFT_KEY, { output, repairRounds, produced: true } as unknown as JsonValue);
  }

  return { output, report, repairRounds };
}

/** Checkpoint key of the newest whole output and the repair rounds behind it. */
export const DRAFT_KEY = "draft";

function readDraft<Payload>(value: JsonValue | undefined): { output: EngineOutput<Payload>; repairRounds: number; produced: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = value.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || !("payload" in output)) return undefined;
  const rounds = typeof value.repairRounds === "number" && value.repairRounds >= 0 ? value.repairRounds : 0;
  return { output: output as unknown as EngineOutput<Payload>, repairRounds: rounds, produced: value.produced === true };
}
