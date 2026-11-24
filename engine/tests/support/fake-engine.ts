/**
 * A small OutputEngine for runner tests. It spends one provider call in
 * plan and one in generate (so usage and cost are real rows), records what
 * its context held, and can be told to stay invalid, fail or wait.
 */
import type {
  EngineContext,
  EngineOutput,
  FormatDescriptor,
  MakeTiming,
  FormatDefinition,
  FormatId,
  OutputEngine,
  ValidationReport,
} from "../../src/studio/types";

export interface FakeBlueprint {
  outline: string[];
}

export interface FakePayload {
  nodeTitle: string;
  sourceTexts: string[];
  assumes: string[];
  inputs: string[];
  repaired?: boolean;
}

export interface FakeEngineScript {
  /** Validation errors that survive every repair. */
  alwaysInvalid?: boolean;
  /** Thrown from generate. */
  failWith?: Error;
  /** Invalid until the output has been repaired once. */
  invalidUntilRepaired?: boolean;
  /** Thrown from repair. */
  failRepair?: Error;
  /** Awaited at the start of generate, so a test can hold a run open. */
  holdGenerate?: (ctx: EngineContext) => Promise<void>;
  /** The making time the output carries, as a maker that measured it would say. */
  timing?: MakeTiming;
}

export interface FakeEngineLog {
  contexts: EngineContext[];
  plans: number;
  generates: number;
  repairs: number;
}

export function fakeDefinition(
  type: FormatId,
  log: FakeEngineLog,
  script: (ctx: EngineContext) => FakeEngineScript = () => ({}),
  descriptor: Partial<FormatDescriptor> = {},
): FormatDefinition<Record<string, unknown>, FakeBlueprint, FakePayload> {
  const engine: OutputEngine<Record<string, unknown>, FakeBlueprint, FakePayload> = {
    type,
    schemaVersion: 1,
    async plan(ctx) {
      log.plans += 1;
      await ctx.services.provider.generateJSON({ systemPrompt: "plan", userPrompt: ctx.node.title, task: "planning" });
      return { outline: ctx.sources.map((source) => source.sourceId) };
    },
    async generate(ctx) {
      log.generates += 1;
      log.contexts.push(ctx as EngineContext);
      const behaviour = script(ctx as EngineContext);
      if (behaviour.holdGenerate) await behaviour.holdGenerate(ctx as EngineContext);
      if (behaviour.failWith) throw behaviour.failWith;
      await ctx.services.progress({ stage: "writing", progress: 0.5 });
      await ctx.services.provider.generateJSON({ systemPrompt: "write", userPrompt: ctx.node.title, task: "section" });
      return { ...output(ctx), ...(behaviour.timing ? { timing: behaviour.timing } : {}) };
    },
    async validate(ctx, candidate): Promise<ValidationReport> {
      const behaviour = script(ctx as EngineContext);
      if (behaviour.alwaysInvalid || (behaviour.invalidUntilRepaired && !candidate.payload.repaired)) {
        return { valid: false, issues: [{ path: "$.lines", code: "empty", message: "no lines", severity: "error" }] };
      }
      return { valid: true, issues: [] };
    },
    async repair(ctx) {
      log.repairs += 1;
      const behaviour = script(ctx as EngineContext);
      if (behaviour.failRepair) throw behaviour.failRepair;
      return { ...output(ctx), payload: { ...output(ctx).payload, repaired: true } };
    },
  };
  return {
    descriptor: { id: type, label: type, colorSlot: 1, icon: "test", settings: [], defaults: {}, ...descriptor },
    engine,
    maxRepairRounds: 1,
    parseSettings: (raw) =>
      raw === undefined || raw === null || (typeof raw === "object" && !Array.isArray(raw))
        ? { ok: true, settings: (raw ?? {}) as Record<string, unknown> }
        : { ok: false, issues: [{ path: "$", code: "type", message: "Settings must be an object", severity: "error" }] },
    estimateCost: () => ({ usd: 0, basis: "fake" }),
  };
}

export function emptyLog(): FakeEngineLog {
  return { contexts: [], plans: 0, generates: 0, repairs: 0 };
}

function output(ctx: EngineContext<Record<string, unknown>>): EngineOutput<FakePayload> {
  return {
    title: `Output for ${ctx.node.title || ctx.node.id}`,
    summary: `Covers ${ctx.node.title || ctx.node.id}.`,
    payload: {
      nodeTitle: ctx.node.title,
      sourceTexts: ctx.sources.map((source) => source.envelope.text),
      assumes: ctx.assumes.map((prior) => prior.nodeId),
      inputs: ctx.inputs.map((input) => input.nodeId),
    },
    citations: ctx.sources.map((source) => ({ sourceId: source.sourceId })),
  };
}
