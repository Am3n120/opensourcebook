/**
 * What the planner model is told. The plan model (stages, items, branches,
 * edges) is described in general terms only. Which formats exist, their
 * settings, what their results report, which condition kinds a branch
 * may use and which kinds of link join items are read from the registries
 * at run time (`catalog`), so nothing here names a format, a condition kind,
 * a link kind, a subject or a plan shape.
 */
import type { ConditionRegistry } from "../../studio/conditions";
import { createDefaultEdgeKinds, type EdgeKindRegistry } from "../../studio/edge-kinds";
import type { FormatRegistry } from "../../studio/registry";
import type { SettingField, SettingOption } from "../../studio/types";
import { formatLine } from "../about-opensourcebook";
import { plannerGuide } from "./guide";

/**
 * How a plan is written down, for anything that plans (the person's agent
 * and Open Sourcebook's own model). Only the shape and the contract live here: what a
 * plan is made of, where labels go, what may be used. How to think about a
 * plan (who the person is, how big, which shape, how long, how to write a
 * brief) is the planner's skill (skills/planner, `plannerGuide`), read on
 * every turn by every planner, so there is one truth.
 */
export const PLAN_RULES = `How a plan is written down:
- Stages run one after another. Items in the same stage sit side by side: they cannot assume each other, and two may cover the same thing from different angles on purpose. An item may assume everything in earlier stages.
- A branch is an item that runs only when a condition on an earlier item's result holds. Its parent must be in an earlier stage.
- An item may be linked to earlier items by the kinds of link you are given: building on them, or reading them as inputs (their output and the result the person recorded). Use a listed kind; another kind of input may be named by a short word in lower_snake_case.
- Each item has one format from the list you are given, a title, a brief, settings from that format's own settings, and its sources: whole, or a run of passages.
- Every brief starts with one short plain sentence the person reads on the plan card: what this item does for them, and why it is this shape. The rest of the brief is for the item's maker.
- Write each brief in its own format's terms, as the format's description says it is. Never make an item material for something Open Sourcebook can't make (a script to record, narration to read out, slides for another tool).
- Source labels (S1) and passage numbers go only in the "sources" field. Never put them in a brief, a title or your reply: the item's maker and the person never see them.
- Use only the formats listed as able to be made now, and only the settings, condition kinds and sources you are given. If the person asks for something Open Sourcebook cannot make now, say so plainly in a sentence, as "Open Sourcebook can't make <it> yet" (never words like declared, registry or available), and plan what Open Sourcebook can make.
- No days, dates or schedule in a plan: the person goes through it at their own pace.
- Write titles, briefs and your reply in the language the person writes in.`;

export const PLANNER_SYSTEM_PROMPT = `${plannerGuide()}

${PLAN_RULES}
Return only JSON in the shape asked for.`;

export const NEW_PLAN_SHAPE = `Return JSON:
{
  "reply": "<a short message to the person, shown above the plan>",
  "after": "<optional: anything more to say, shown below the plan>",
  "title": "<the plan's title>",
  "budgetUsd": <only when the person named a spending limit, in dollars>,
  "stages": [
    { "label": "<optional, only if it helps read the plan>",
      "dueOn": "<optional, YYYY-MM-DD: only when the person gave a day or a deadline for it>",
      "items": [
        { "key": "<a short unique key you choose>",
          "format": "<a format id>",
          "title": "...",
          "brief": "...",
          "settings": { },
          "sources": [ { "source": "S1", "from": <first passage, optional>, "to": <last passage, optional> } ],
          "branchOf": { "item": "<key of an item in an earlier stage>", "condition": { <a condition> } },
          "assumes": [ "<key of an earlier item it builds on, beyond its stage order>" ],
          "inputs": [ { "item": "<key of an earlier item>", "kind": "<a link kind>" } ],
          "enabled": true } ] } ]
}
branchOf, assumes, inputs, settings and enabled are optional.`;

export const EDIT_SHAPE = `Return JSON:
{ "reply": "<one or two short sentences to the person, shown above the plan card>",
  "after": "<optional: anything more to say, shown below the plan>",
  "ops": [ <changes, applied in order> ] }
Change only what was asked; everything you do not name stays as it is. In ops, refer to items as I1, I2, ... and to stages by their number; in your reply, name items by their titles, never by I1, I2. Ops:
{ "op": "change", "item": "I2", "title"?: "...", "brief"?: "...", "format"?: "<id>", "settings"?: { }, "sources"?: [ { "source": "S1", "from"?: 1, "to"?: 4 } ], "enabled"?: true|false, "branchOf"?: { "item": "I1", "condition": { } } | null }
{ "op": "add", "key": "<new key>", "stage": <stage number, or the key of a new stage>, "position"?: <0-based place in the stage>, "format": "<id>", "title": "...", "brief": "...", "settings"?: { }, "sources": [ ... ], "branchOf"?: { ... }, "assumes"?: [ "I1" ], "inputs"?: [ { "item": "I1", "kind": "<a link kind>" } ] }
{ "op": "remove", "item": "I3" }
{ "op": "move", "item": "I3", "stage": <stage number or new stage key>, "position"?: <0-based> }
{ "op": "addStage", "key": "<new stage key>", "after": <stage number, or null for first>, "label"?: "...", "dueOn"?: "YYYY-MM-DD" }
{ "op": "label", "stage": <stage number or new stage key>, "label": "..." | null }
{ "op": "date", "stage": <stage number or new stage key>, "dueOn": "YYYY-MM-DD" | null }
{ "op": "link", "from": "I1", "to": "I4", "kind": "<a link kind>" }
{ "op": "unlink", "from": "I1", "to": "I4", "kind": "..." }
{ "op": "title", "title": "..." }
{ "op": "budget", "usd": <dollars> | null }
The plan card under your reply lists every change your ops make, one line each, so your reply never lists them again: give the gist (what the plan now does differently, in a sentence), and say plainly anything asked for that you did not or could not change. Never claim a change your ops do not make, and give no reason the person did not give.
An item marked as made or changed by the person by hand stays as it is unless their message asks about it. An item in a format Open Sourcebook can't make yet blocks Start: point that out, but do not remove or change it unasked.
If the message is a remark or a question about the plan rather than a change, answer it honestly in "reply" with "ops": [] (and if it points out something wrong, fix what you can with ops and say plainly what you can't).
If the person is asking for a different plan rather than a change to this one, return { "reply": "...", "newPlan": true } instead.`;

/** Under `/plan`: plan now, with what can be made now. */
export const FORCED_NOTE = `The person asked for a plan now: return a plan, not questions. Use only formats that can be made now; if they asked for something Open Sourcebook cannot make yet, say so plainly at the start of the reply and say which formats the plan uses instead.`;

/**
 * Offered unless the person forced a plan: the planner may ask first.
 * What it asks, and how many questions, are left to the sources and the
 * request.
 */
export const ASK_SHAPE = `Before planning or changing a plan, you may ask instead, when something that would change the plan a lot is not in the conversation or the sources (your guide says when). To ask, return instead:
{ "ask": { "reply": "<a short message before the questions>",
  "questions": [ { "text": "<one question>", "options": [ "<a short answer the person can pick>" ], "multiple": <true if more than one answer may be picked> } ] } }
Give options when the question has clear answers to pick from; the person can always type their own. Ask only what matters, in the person's language.`;

/** The formats, condition kinds and link kinds the planner may use, read from the registries now. */
export function catalog(registry: FormatRegistry, conditions: ConditionRegistry, edgeKinds: EdgeKindRegistry = createDefaultEdgeKinds()): string {
  const notYet = registry.views().filter((format) => !format.ready).map(formatLine);
  const formats = registry.ready().map((id) => {
    const descriptor = registry.descriptor(id)!;
    const lines = [`- ${descriptor.id} ("${descriptor.label}")${descriptor.about ? `: ${descriptor.about}` : ""}`];
    const shown = descriptor.settings.filter((field) => !field.hidden);
    const notNow = unreadyOptions(registry, id);
    if (shown.length > 0) lines.push(`  settings: ${shown.map((field) => describeSetting(field, notNow)).join("; ")}`);
    lines.push(`  defaults: ${JSON.stringify(descriptor.defaults)}`);
    const parsedDefaults = registry.get(id)?.parseSettings(descriptor.defaults);
    const notices = parsedDefaults?.ok ? (registry.get(id)?.itemNotices?.(parsedDefaults.settings) ?? []) : [];
    if (notices.length) lines.push(`  what the person should know about it now: ${notices.join(" ")}`);
    if (descriptor.reports?.length) lines.push(`  its result reports: ${descriptor.reports.map((report) => `${report.metric} (${report.about})`).join(", ")}`);
    else lines.push("  its result reports no numbers");
    return lines.join("\n");
  });
  const kinds = conditions.describe().map((kind) => `- ${kind.kind}${kind.about ? `: ${kind.about}` : ""}${kind.example ? ` e.g. ${JSON.stringify(kind.example)}` : ""}`);
  const links = edgeKinds.list().map((kind) => `- ${kind.id}: ${kind.about}`);
  const declared = notYet.length ? `\n\nFormats Open Sourcebook can't make yet (never in a plan):\n${notYet.join("\n")}` : "";
  return `What Open Sourcebook can make on this computer now (facts read from its registries at the start of this turn; your guide is how to use them).\n\nFormats that can be made now, the only ones a plan may use:\n${formats.join("\n")}${declared}\n\nBranch conditions you may use:\n${kinds.join("\n")}\n\nKinds of link from an earlier item to a later one (said of the later item):\n${links.join("\n")}`;
}

function describeSetting(field: SettingField, notNow: (key: string, value: string) => string | undefined = () => undefined): string {
  const when = field.showWhen ? `, read only when ${field.showWhen.key} is ${field.showWhen.in.join(" or ")}` : "";
  const help = field.help || when ? ` (${field.help ?? ""}${field.help ? when : when.slice(2)})` : "";
  switch (field.kind) {
    case "choice":
      return `${field.key}${help}: one of ${field.options.map((option) => describeOption(option, notNow(field.key, option.value))).join(" | ")}`;
    case "choices":
      return `${field.key}${help}: a list of ${field.minItems ? `at least ${field.minItems} of ` : ""}${field.options.map((option) => describeOption(option)).join(" | ")}`;
    case "number":
      return `${field.key}: number${field.min !== undefined ? ` from ${field.min}` : ""}${field.max !== undefined ? ` to ${field.max}` : ""}${field.unit ? ` ${field.unit}` : ""}${help}${
        field.specialValues?.length ? `; ${field.specialValues.map((special) => `${special.value} means: ${special.description}`).join("; ")}` : ""
      }`;
    case "toggle":
      return `${field.key}: true or false${help}`;
    case "text":
      return `${field.key}: text${help}`;
    case "textList":
      return `${field.key}: list of text${help}`;
    case "agent":
      return `${field.key}: an agent and model pick ("agent", "agent:<provider>", or "agent:<provider>:<model>"), or leave open for default${help}`;
  }
}

/** An option as the planner writes it (its value), with what picking it does. */
function describeOption(option: SettingOption, notNow?: string): string {
  return `${option.value} (${option.description}${notNow ? ` Not ready on this computer now: ${notNow}.` : ""})`;
}

/**
 * Which picks of a format's choices cannot be made on this computer now (a
 * maker whose service is not running), from what the format last heard
 * (`itemIssues`), so the planner picks what will run.
 */
function unreadyOptions(registry: FormatRegistry, id: string): (key: string, value: string) => string | undefined {
  const definition = registry.get(id);
  const descriptor = registry.descriptor(id);
  if (!definition?.itemIssues || !descriptor) return () => undefined;
  return (key, value) => {
    if (value === "auto") return undefined;
    const parsed = definition.parseSettings({ ...descriptor.defaults, [key]: value });
    if (!parsed.ok) return undefined;
    const issues = definition.itemIssues!(parsed.settings);
    return issues.length ? issues.join("; ") : undefined;
  };
}
