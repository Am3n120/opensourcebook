/**
 * Going through a made set of flashcards from the command: the cards due now
 * (front and back, so whoever runs it can put each to the person and check
 * the answer), then each marked got it or not yet and kept on the item, as
 * the app's player does, with the same spacing rule.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, type Engine } from "./connect.ts";
import { madeOf } from "./items.ts";
import { getPlan } from "./plans.ts";
import { blockLine, hidden, markOf } from "./readable.ts";
import { PROJECT_FLAG, Problem, flagOn, type Ctx, type Group } from "./table.ts";

interface Memory {
  box: number;
  due: number;
  seen: number;
  missed: number;
}

interface Spacing {
  SCHEDULE: { about: string; next(memory: Memory | undefined, mark: "got" | "missed", now: number): Memory; learned(memory: Memory | undefined): boolean };
  memoriesOf(progress: unknown): Record<string, Memory>;
  isDue(memory: Memory | undefined, now: number): boolean;
  standing(markable: readonly string[], memories: Record<string, Memory>, now: number): { cards: number; new: number; due: number; learned: number; nextDue?: number };
  whenWords(at: number, now: number): string;
}

/** The web player's own spacing rule (web/src/player/spacing.ts), so cards gone through here come back when they would in the app. */
async function spacing(ctx: Ctx): Promise<Spacing> {
  return (await import(pathToFileURL(join(ctx.root, "web", "src", "player", "spacing.ts")).href)) as Spacing;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

async function setOf(ctx: Ctx, engine: Engine) {
  const made = await madeOf(ctx, engine, ctx.args.item!);
  if (made.output.type !== "flashcards") throw new Problem("not_flashcards", `"${made.item.title}" is a ${made.output.type}, not a set of flashcards; "opensourcebook item get ${made.item.id}" gives it.`);
  const cards = list(made.output.payload.cards).map(rec);
  // The item's kept progress, fresh: the plan's own view of it.
  const view = await getPlan(engine, made.view.plan.id);
  const progress = view.items.find((i) => i.id === made.item.id)?.progress;
  return { ...made, cards, progress, s: await spacing(ctx) };
}

/** A card as the person meets it: its number in the set, its front (gaps hidden) and the back to check against. */
function shown(card: Rec, n: number) {
  const front = list(card.front).map(rec);
  const back = list(card.back).map(rec);
  const clozes = front.filter((b) => b.type === "cloze");
  return {
    n,
    id: String(card.id),
    kind: String(card.kind ?? ""),
    front: front.map((b) => (b.type === "cloze" ? hidden(b.text) : blockLine(b))).join("\n"),
    back: (back.length ? back.map(blockLine) : clozes.map(blockLine)).join("\n"),
    marked: markOf(card),
  };
}

export const cards: Group = {
  thing: "cards",
  about: "go through a made set of flashcards here: the cards due now, then each marked got it or not yet",
  commands: [
    {
      thing: "cards",
      action: "review",
      summary: "the cards of a set due now (or every card with --all), front and back, to put to the person",
      args: [{ name: "item", help: "the flashcards item's id" }],
      flags: [PROJECT_FLAG, { name: "all", help: "every card, not only the ones due (a set never gone through has none due: all its cards are new)" }],
      shape: "{ item, standing: { cards, new, due, learned }, cards: [{ n, id, kind, front, back, marked: self|answer|none }] }",
      more: "Put each front to the person, let them answer, show the back, then record what they got with \"opensourcebook cards mark <item> 1=got 2=not\".",
      async run(ctx) {
        const { item, cards: all, progress, s } = await setOf(ctx, connect(ctx));
        const now = Date.now();
        const memories = s.memoriesOf(progress);
        const markable = all.filter((c) => markOf(c) !== "none").map((c) => String(c.id));
        const standing = s.standing(markable, memories, now);
        const everything = flagOn(ctx, "all") || standing.new === markable.length;
        const picked = all.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => everything || s.isDue(memories[String(c.id)], now));
        const list = picked.map(({ c, n }) => shown(c, n));
        const head = `${standing.cards} cards: ${standing.learned} learned, ${standing.due} due, ${standing.new} new.`;
        const text =
          list.length === 0
            ? `${head} Nothing is due now${standing.nextDue ? `; the next card comes back ${s.whenWords(standing.nextDue, now)}` : ""}. "--all" shows every card.`
            : [head, ...list.map((c) => [`${c.n}. ${c.front}`, c.back ? `   Back: ${c.back.replace(/\n/g, "\n         ")}` : c.marked === "none" ? "   (to read; not marked)" : "   (answered by its question)"].join("\n")), `Record what was got with "opensourcebook cards mark ${item.id} 1=got 2=not ...".`].join("\n\n");
        return { data: { item, standing, cards: list }, text };
      },
    },
    {
      thing: "cards",
      action: "mark",
      summary: "record cards as got it or not yet, kept on the item and brought back by the app's spacing rule",
      args: [{ name: "item", help: "the flashcards item's id" }, { name: "marks", help: "like 1=got 2=not (a card's number in the set or its id; got, or not / missed)", many: true }],
      flags: [PROJECT_FLAG],
      shape: "{ marked: [{ id, mark, box, due, back: string }], standing: { cards, new, due, learned } }",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item, cards: all, progress, s } = await setOf(ctx, engine);
        const now = Date.now();
        const memories = { ...s.memoriesOf(progress) };
        const marked: Array<{ id: string; mark: "got" | "missed"; box: number; due: number; back: string }> = [];
        for (const word of (ctx.lists.marks ?? []).flatMap((w) => w.split(/[\s,;]+/)).filter(Boolean)) {
          const m = /^([^=]+)=(.+)$/.exec(word);
          if (!m) throw new Problem("bad_arguments", `"${word}" is not a mark; write card=got or card=not, like 1=got.`);
          const [, key, value] = m as unknown as [string, string, string];
          const card = all.find((c) => String(c.id) === key) ?? all[Number(key) - 1];
          if (!card) throw new Problem("bad_arguments", `The set has no card ${key}; it has ${all.length}.`);
          if (markOf(card) === "none") throw new Problem("bad_arguments", `Card ${key} is only read; it is not marked.`);
          const mark = /^(got|yes|y|1|right)$/i.test(value) ? "got" : /^(not|no|n|missed|miss|0|wrong|not-yet|notyet)$/i.test(value) ? "missed" : undefined;
          if (!mark) throw new Problem("bad_arguments", `"${value}" is not a mark; use got or not.`);
          const id = String(card.id);
          const next = s.SCHEDULE.next(memories[id], mark, now);
          memories[id] = next;
          marked.push({ id, mark, box: next.box, due: next.due, back: s.whenWords(next.due, now) });
        }
        if (marked.length === 0) throw new Problem("bad_arguments", 'Give at least one mark, like 1=got 2=not.');
        const place = rec(progress).card;
        await engine.call("POST", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/progress`, { json: { progress: { card: typeof place === "number" ? place : 0, cards: memories } } });
        const markable = all.filter((c) => markOf(c) !== "none").map((c) => String(c.id));
        const standing = s.standing(markable, memories, now);
        const text = [...marked.map((m) => `${m.id}: ${m.mark === "got" ? "got it" : "not yet"}, back ${m.back}`), `${standing.learned} of ${standing.cards} learned, ${standing.due} due now.`].join("\n");
        return { data: { marked, standing }, text };
      },
    },
  ],
};
