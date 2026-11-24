/**
 * Branch conditions (docs/VISION.md "A plan, when a path is wanted", docs/DECISIONS.md #28). A
 * branch item (`plan_nodes.parent_id` + `condition_json`) runs only when its
 * condition holds on an earlier item's result. A condition is a small tagged
 * object, `{ "kind": ..., ...fields }`; each kind is read and decided by a
 * `ConditionResolver` in a `ConditionRegistry`, so new kinds are added by
 * registering a resolver, not by changing the plan runner.
 *
 * Built in:
 *   { "kind": "metric", "metric": "score", "below": 0.7 }
 *   { "kind": "metric", "metric": "score", "atLeast": 0.7 }
 *       A number the parent's result reports (`item_results.result_json`).
 *       Waits until the parent has a result with that number.
 *   { "kind": "ask", "question"?: "More practice?" }
 *       The person decides. Their answer is stored on the branch item's own
 *       result as `{ "answer": true | false }`; until then it waits. The
 *       answer is read only while the item is pending: once it runs, its
 *       status holds the decision and its own result may replace the answer.
 *
 * Conditions written before kinds existed, `{ "metric", "below" }` with no
 * `kind`, read as `metric`. Stored conditions are never rewritten.
 */
import { isRecord } from "../net";
import type { Plan, PlanNode } from "./repositories/plans";
import type { ItemResult } from "./repositories/results";
import type { JsonValue } from "./types";

export type JsonRecord = { [key: string]: JsonValue };

/** What a resolver decides for a pending branch item. */
export type ConditionDecision = "run" | "skip" | "wait";

export interface ConditionContext {
  plan: Plan;
  /** The branch item being decided. */
  node: PlanNode;
  /** The earlier item the condition is on. */
  parent: PlanNode;
  /** The person's recorded result for any item of the plan, if any. */
  resultOf(nodeId: string): ItemResult | undefined;
}

export interface ConditionResolver<Condition = unknown> {
  /** The `kind` it reads, e.g. `metric`. Lower camelCase. */
  kind: string;
  /** When it holds, in a sentence, for the planner. */
  about?: string;
  /** One condition of this kind, as stored; the planner is shown it. */
  example?: JsonRecord;
  /** Checks the condition's own fields (`kind` included); a message when they are wrong. */
  parse(value: JsonRecord): Condition | string;
  decide(condition: Condition, context: ConditionContext): ConditionDecision | Promise<ConditionDecision>;
}

export interface ParsedCondition {
  kind: string;
  condition: unknown;
  resolver: ConditionResolver;
}

export class ConditionRegistry {
  private readonly resolvers = new Map<string, ConditionResolver>();

  register<Condition>(resolver: ConditionResolver<Condition>): this {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(resolver.kind)) throw new Error(`"${resolver.kind}" is not a condition kind.`);
    if (this.resolvers.has(resolver.kind)) throw new Error(`Condition kind "${resolver.kind}" is already registered.`);
    this.resolvers.set(resolver.kind, resolver as ConditionResolver);
    return this;
  }

  has(kind: string): boolean {
    return this.resolvers.has(kind);
  }

  kinds(): string[] {
    return [...this.resolvers.keys()];
  }

  /** Every kind with what it says about itself, in registration order. */
  describe(): Array<{ kind: string; about?: string; example?: JsonRecord }> {
    return [...this.resolvers.values()].map((resolver) => ({
      kind: resolver.kind,
      ...(resolver.about ? { about: resolver.about } : {}),
      ...(resolver.example ? { example: resolver.example } : {}),
    }));
  }

  /** The condition read by its kind's resolver, or a message saying why it cannot be. */
  parse(value: JsonValue | undefined): ParsedCondition | string {
    const kind = conditionKind(value);
    if (kind === undefined) return 'condition must be an object with a "kind"';
    const resolver = this.resolvers.get(kind);
    if (!resolver) return `no resolver decides condition kind "${kind}"`;
    const condition = resolver.parse(withKind(value as JsonRecord, kind));
    return typeof condition === "string" ? condition : { kind, condition, resolver };
  }

  async decide(parsed: ParsedCondition, context: ConditionContext): Promise<ConditionDecision> {
    return parsed.resolver.decide(parsed.condition, context);
  }
}

/** A stored condition's kind; `metric` for the shape written before kinds. Undefined when it has none. */
export function conditionKind(value: JsonValue | undefined): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.kind === "string" && value.kind) return value.kind;
  if (value.kind === undefined && "metric" in value) return "metric";
  return undefined;
}

function withKind(value: JsonRecord, kind: string): JsonRecord {
  return value.kind === undefined ? { kind, ...value } : value;
}

function onlyKeys(value: JsonRecord, allowed: string[]): string | undefined {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length ? `condition has unknown field ${extra.map((key) => `"${key}"`).join(", ")}` : undefined;
}

export type MetricCondition = { kind: "metric"; metric: string } & ({ below: number } | { atLeast: number });

/** A number on the parent's result, below or at least a threshold. */
export const metricResolver: ConditionResolver<MetricCondition> = {
  kind: "metric",
  about: "A number the parent item's result reports (its format lists them) is below, or at least, a threshold.",
  example: { kind: "metric", metric: "score", below: 0.5 },
  parse(value) {
    const extra = onlyKeys(value, ["kind", "metric", "below", "atLeast"]);
    if (extra) return extra;
    if (typeof value.metric !== "string" || !value.metric.trim()) return "condition.metric must be a non-empty string";
    const bounds = (["below", "atLeast"] as const).filter((key) => value[key] !== undefined);
    if (bounds.length !== 1) return 'condition needs exactly one of "below" or "atLeast"';
    const bound = bounds[0]!;
    const threshold = value[bound];
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) return `condition.${bound} must be a number`;
    return bound === "below" ? { kind: "metric", metric: value.metric, below: threshold } : { kind: "metric", metric: value.metric, atLeast: threshold };
  },
  decide(condition, { parent, resultOf }) {
    const result = resultOf(parent.id)?.result;
    const value = isRecord(result) ? result[condition.metric] : undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) return "wait";
    const holds = "below" in condition ? value < condition.below : value >= condition.atLeast;
    return holds ? "run" : "skip";
  },
};

export interface AskCondition {
  kind: "ask";
  /** What to ask; clients word it themselves when absent. */
  question?: string;
}

/** The person decides; the answer is `{ answer: boolean }` on the branch item's own result. */
export const askResolver: ConditionResolver<AskCondition> = {
  kind: "ask",
  about: "The person is asked once the parent item is done, and decides.",
  example: { kind: "ask", question: "Want more practice on this?" },
  parse(value) {
    const extra = onlyKeys(value, ["kind", "question"]);
    if (extra) return extra;
    if (value.question === undefined) return { kind: "ask" };
    if (typeof value.question !== "string" || !value.question.trim()) return "condition.question must be non-empty text";
    return { kind: "ask", question: value.question };
  },
  decide(_condition, { node, resultOf }) {
    const own = resultOf(node.id)?.result;
    const answer = isRecord(own) ? own.answer : undefined;
    if (typeof answer !== "boolean") return "wait";
    return answer ? "run" : "skip";
  },
};

/** The kinds Open Sourcebook decides today. */
export function createDefaultConditions(): ConditionRegistry {
  return new ConditionRegistry().register(metricResolver).register(askResolver);
}
