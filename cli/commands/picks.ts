/**
 * Who makes what: the agent that answers the chat, and the one that makes (and, where a shape offers it, reviews)
 * each shape, as Settings' "What makes what" keeps them. The scopes come from the engine (the chat, and each format
 * that declares an agent field in `GET /v1/formats`); nothing here names a shape. The picks are the engine's
 * (`GET /v1/providers`, `PUT /v1/providers/picks/:scope`, `PUT /v1/providers/picks`).
 */
import { connect, type Engine } from "./connect.ts";
import { Problem, flagString, type Ctx, type Flag, type Group } from "./table.ts";
import { table } from "./util.ts";

interface Field {
  kind?: string;
  role?: string;
}
interface Format {
  id: string;
  label: string;
  settings?: Field[];
}
interface Provider {
  id: string;
  label: string;
  state: string;
  added?: boolean;
  enabled?: boolean;
  models?: Array<{ id: string; label?: string }>;
  efforts?: Array<{ id: string; label?: string }>;
}
interface Pick {
  agent?: string;
  model?: string;
  effort?: string;
  off?: boolean;
}
interface Providers {
  connector: { configured: boolean; reachable: boolean };
  providers: Provider[];
  picks?: Record<string, Pick>;
}

/** A pick as the person reads it: "claude · sonnet · medium". */
const pickWords = (p: Pick) => [p.agent, p.model, p.effort].filter(Boolean).join(" · ");
const ready = (p: Provider) => p.added !== false && p.enabled !== false && p.state === "ready";

/** Who does it when nothing is picked: the only agent ready, else Open Sourcebook asks, else nobody can. */
function unpicked(providers: Provider[]): { settled: "only" | "ask" | "none"; words: string; agent?: string } {
  const can = providers.filter(ready);
  if (can.length === 1) return { settled: "only", words: `not picked; ${can[0]!.id}, the only agent ready, does it`, agent: can[0]!.id };
  if (can.length > 1) return { settled: "ask", words: "not picked; several agents are ready, so Open Sourcebook asks first" };
  return { settled: "none", words: "not picked; no agent is ready" };
}

/** The chat and each shape with a maker, and the shapes that offer a reviewer, from the engine's formats. */
async function scopesOf(engine: Engine): Promise<{ make: Array<{ scope: string; label: string }>; review: Set<string> }> {
  const { formats } = await engine.call<{ formats: Format[] }>("GET", "/v1/formats");
  const agentRoles = (f: Format) => (f.settings ?? []).filter((s) => s.kind === "agent").map((s) => s.role);
  return {
    make: [{ scope: "chat", label: "the chat" }, ...formats.filter((f) => agentRoles(f).some((r) => r !== "review")).map((f) => ({ scope: f.id, label: f.label }))],
    review: new Set(formats.filter((f) => agentRoles(f).includes("review")).map((f) => f.id)),
  };
}

async function providersOf(engine: Engine): Promise<Providers> {
  const found = await engine.call<Providers>("GET", "/v1/providers");
  if (!found.connector.reachable) throw new Problem("connector_unreachable", 'The agent connector is not answering, so no agent can be picked; "opensourcebook status" says more.');
  return found;
}

/** The agent, model and effort asked for, checked against what that agent offers; the body the engine takes. */
function pickBody(ctx: Ctx, providers: Provider[], agent: string): { agent: string; model: string | null; effort: string | null } {
  const provider = providers.find((p) => p.id === agent);
  if (!provider) throw new Problem("unknown_agent", `"${agent}" is not one of your agents. They are: ${providers.map((p) => `${p.id} (${p.label})`).join(", ") || "none"}. "opensourcebook agent list" says more.`);
  const model = flagString(ctx, "model");
  const effort = flagString(ctx, "effort");
  const models = provider.models ?? [];
  if (model && models.length && !models.some((m) => m.id === model)) throw new Problem("unknown_model", `${provider.label} has no model "${model}". It has: ${models.map((m) => m.id).join(", ")}.`);
  const efforts = provider.efforts ?? [];
  if (effort && !efforts.some((e) => e.id === effort)) throw new Problem("unknown_effort", efforts.length ? `${provider.label} takes no effort "${effort}". It takes: ${efforts.map((e) => e.id).join(", ")}.` : `${provider.label} takes no effort setting.`);
  return { agent, model: model ?? null, effort: effort ?? null };
}

/** Says what a scope is in words: "the chat", "flashcards", "reviewing video". */
function scopeOf(scope: string, known: Array<{ scope: string }>, what: string): string {
  if (known.some((k) => k.scope === scope)) return scope;
  throw new Problem("unknown_scope", `"${scope}" is not something a maker can be picked for. ${what}: ${known.map((k) => k.scope).join(", ")}.`);
}

const MODEL_FLAG: Flag = { name: "model", value: "model", help: "one of the agent's models (\"opensourcebook makers\" lists them); left out, the agent's own default" };
const EFFORT_FLAG: Flag = { name: "effort", value: "effort", help: "how hard it thinks, one the agent takes; left out, the agent's own default" };

export const picks: Group = {
  thing: "makers",
  about: "who makes what: the agent that answers the chat, and the one that makes (and reviews, where offered) each shape",
  default: "list",
  commands: [
    {
      thing: "makers",
      action: "list",
      summary: "the chat and each shape with who makes it, and who reviews it where a shape offers that (\"opensourcebook makers\" alone)",
      shape: "{ makers: [{ scope, label, pick?: { agent, model?, effort? }, settled: \"picked\"|\"only\"|\"ask\"|\"none\", review?: { scope, off: boolean, pick?: { agent, model?, effort? } } }], agents: [{ id, label, ready: boolean, models: string[], efforts: string[] }] }  (settled: picked, the only agent ready does it, Open Sourcebook asks first, or no agent can)",
      async run(ctx) {
        const engine = connect(ctx);
        const [scopes, found] = await Promise.all([scopesOf(engine), providersOf(engine)]);
        const kept = found.picks ?? {};
        const fallback = unpicked(found.providers);
        const makers = scopes.make.map(({ scope, label }) => {
          const p = kept[scope];
          const pick = p?.agent ? { agent: p.agent, ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}) } : undefined;
          const r = kept[`${scope}.review`];
          const review = scopes.review.has(scope)
            ? { scope: `${scope}.review`, off: !!r?.off, ...(r?.agent && !r.off ? { pick: { agent: r.agent, ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) } } : {}) }
            : undefined;
          return { scope, label, ...(pick ? { pick } : {}), settled: pick ? ("picked" as const) : fallback.settled, ...(review ? { review } : {}) };
        });
        const agents = found.providers.map((p) => ({ id: p.id, label: p.label, ready: ready(p), models: (p.models ?? []).map((m) => m.id), efforts: (p.efforts ?? []).map((e) => e.id) }));
        const rows = makers.map((m) => [
          m.scope,
          m.pick ? pickWords(m.pick) : fallback.words,
          m.review ? `review: ${m.review.off ? "off" : m.review.pick ? pickWords(m.review.pick) : "as who makes it"}` : "",
        ]);
        const text = [
          table(rows),
          "",
          "Agents:",
          ...agents.map((a) => `  ${a.id} (${a.label}): ${a.ready ? "ready" : "not ready"}${a.models.length ? `; models ${a.models.join(", ")}` : ""}${a.efforts.length ? `; efforts ${a.efforts.join(", ")}` : ""}`),
          "",
          'Set one with "opensourcebook makers set <chat|shape> <agent> [--model m] [--effort e]", every one with "opensourcebook makers set-all <agent>", a reviewer with "opensourcebook makers review <shape> <agent|off>".',
        ];
        return { data: { makers, agents }, text: text.join("\n") };
      },
    },
    {
      thing: "makers",
      action: "set",
      summary: "pick the agent (and model and effort) that answers the chat or makes one shape",
      args: [
        { name: "scope", help: "chat, or a shape (\"opensourcebook makers\" lists them)" },
        { name: "agent", help: "one of your agents, by id (\"opensourcebook makers\" lists them)" },
      ],
      flags: [MODEL_FLAG, EFFORT_FLAG],
      shape: "{ scope, pick: { agent, model?, effort? } }",
      async run(ctx) {
        const engine = connect(ctx);
        const [scopes, found] = await Promise.all([scopesOf(engine), providersOf(engine)]);
        const scope = scopeOf(ctx.args.scope!, scopes.make, "It can be");
        const body = pickBody(ctx, found.providers, ctx.args.agent!);
        await engine.call("PUT", `/v1/providers/picks/${encodeURIComponent(scope)}`, { json: body });
        const pick = { agent: body.agent, ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) };
        return { data: { scope, pick }, text: `${scope === "chat" ? "The chat is answered" : `${scope} is made`} by ${pickWords(pick)} from now on.` };
      },
    },
    {
      thing: "makers",
      action: "set-all",
      summary: "pick one agent (and model and effort) for the chat and every shape at once",
      args: [{ name: "agent", help: "one of your agents, by id (\"opensourcebook makers\" lists them)" }],
      flags: [MODEL_FLAG, EFFORT_FLAG],
      shape: "{ scopes: string[], pick: { agent, model?, effort? } }",
      async run(ctx) {
        const engine = connect(ctx);
        const [scopes, found] = await Promise.all([scopesOf(engine), providersOf(engine)]);
        const body = pickBody(ctx, found.providers, ctx.args.agent!);
        const all = scopes.make.map((s) => s.scope);
        await engine.call("PUT", "/v1/providers/picks", { json: { picks: Object.fromEntries(all.map((s) => [s, body])) } });
        const pick = { agent: body.agent, ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) };
        return { data: { scopes: all, pick }, text: `${pickWords(pick)} answers the chat and makes ${all.filter((s) => s !== "chat").join(", ") || "nothing else"} from now on.` };
      },
    },
    {
      thing: "makers",
      action: "review",
      summary: "pick who reviews a shape once it is made, or turn its review off",
      args: [
        { name: "shape", help: "a shape that offers a reviewer (\"opensourcebook makers\" says which)" },
        { name: "agent", help: "one of your agents, by id, or off" },
      ],
      flags: [MODEL_FLAG, EFFORT_FLAG],
      shape: "{ scope, off: boolean, pick?: { agent, model?, effort? } }",
      async run(ctx) {
        const engine = connect(ctx);
        const [scopes, found] = await Promise.all([scopesOf(engine), providersOf(engine)]);
        const reviewed = [...scopes.review].map((scope) => ({ scope }));
        const shape = scopeOf(ctx.args.shape!, reviewed, reviewed.length ? "The shapes with a reviewer are" : "No shape here has a reviewer; shapes");
        const scope = `${shape}.review`;
        if (ctx.args.agent === "off") {
          await engine.call("PUT", `/v1/providers/picks/${encodeURIComponent(scope)}`, { json: { agent: null, model: null, effort: null, off: true } });
          return { data: { scope, off: true }, text: `${shape} is not reviewed from now on.` };
        }
        const body = pickBody(ctx, found.providers, ctx.args.agent!);
        await engine.call("PUT", `/v1/providers/picks/${encodeURIComponent(scope)}`, { json: { ...body, off: null } });
        const pick = { agent: body.agent, ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) };
        return { data: { scope, off: false, pick }, text: `${shape} is reviewed by ${pickWords(pick)} from now on.` };
      },
    },
  ],
};

/** What to type to set a scope's pick: "opensourcebook makers set flashcards <agent>", "opensourcebook makers review video <agent|off>". */
export function pickCommand(scope: string): string {
  const review = /^(.+)\.review$/.exec(scope);
  return review ? `opensourcebook makers review ${review[1]} <agent|off>` : `opensourcebook makers set ${scope} <agent>`;
}

/** A scope in words: "the chat", "flashcards", "reviewing video". */
function thingOf(scope: string): string {
  if (scope === "chat") return "the chat";
  const review = /^(.+)\.review$/.exec(scope);
  return review ? `reviewing ${review[1]}` : scope;
}

/**
 * The one line a `pick_needed` answer becomes: which thing needs a pick and the exact command that sets it. An
 * engine that names no scope gets the general command.
 */
export function pickNeededLine(scopes: readonly string[]): string {
  if (!scopes.length) return 'Several of your agents could do it and none is picked. Pick one with "opensourcebook makers set <chat|shape> <agent>" ("opensourcebook makers" shows who makes what).';
  const things = scopes.map(thingOf);
  const named = things.length === 1 ? things[0]! : `${things.slice(0, -1).join(", ")} and ${things.at(-1)}`;
  const commands = scopes.map(pickCommand);
  const all = scopes.some((s) => !s.endsWith(".review")) && scopes.length > 1 ? ', or all at once with "opensourcebook makers set-all <agent>"' : "";
  return `Several of your agents could do it and none is picked for ${named}. Set ${scopes.length === 1 ? "it" : "them"} with ${commands.map((c) => `"${c}"`).join(" and ")}${all} ("opensourcebook makers" lists the agents).`;
}
