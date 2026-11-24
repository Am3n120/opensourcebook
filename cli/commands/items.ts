/** Items: one thing in a plan (a video, a set of flashcards or a quiz), and once made, the thing itself. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { cardsText, citedSources, quizText } from "./readable.ts";
import { connect, projectOf, type Engine } from "./connect.ts";
import { PLAN_OVER, follow, getPlan, itemLine, plansOf, progressOf, withNotices, type Item, type PlanView } from "./plans.ts";
import { PRINT_FLAG, PROJECT_FLAG, Problem, TIMEOUT_FLAG, flagList, flagOn, flagString, type Ctx, type Group } from "./table.ts";
import { browserAddress, openUrl, table } from "./util.ts";
import { readReply, replyText, titlesOf, waitForReply, type Chat, type Message } from "./chats.ts";

export interface Output {
  id: string;
  type: string;
  title: string;
  summary?: string;
  planId?: string;
  itemId?: string;
  payload: Record<string, unknown>;
  citations?: unknown[];
}

const PLAN_FLAG = { name: "plan", value: "id", help: "the item's plan (default: found among the project's plans)" };

/** Finds an item and its plan: in --plan when given, else among the project's plans. */
export async function findItem(ctx: Ctx, engine: Engine, itemId: string): Promise<{ view: PlanView; item: Item }> {
  const planId = flagString(ctx, "plan");
  const views = planId ? [await getPlan(engine, planId)] : await plansOf(engine, projectOf(ctx));
  for (const view of views) {
    const item = view.items.find((i) => i.id === itemId);
    if (item) {
      // The live step and the made thing come with progress.
      const progress = await progressOf(engine, view.plan.id).catch(() => undefined);
      const live = progress?.items.find((i) => i.id === itemId);
      return { view, item: { ...item, ...(live?.job ? { job: live.job } : {}), ...(live?.outputId ? { outputId: live.outputId } : {}), status: live?.status ?? item.status } };
    }
  }
  throw new Problem("not_found", `No item ${itemId} in ${planId ? "that plan" : "the project's plans"}. "opensourcebook plan show <plan>" lists a plan's items with their ids.`);
}

/** The made thing of an item, or a plain sentence on why there is none yet. */
export async function madeOf(ctx: Ctx, engine: Engine, itemId: string): Promise<{ view: PlanView; item: Item; output: Output }> {
  const { view, item } = await findItem(ctx, engine, itemId);
  if (!item.outputId) {
    const why = item.status === "failed" ? `it failed: ${item.errorMessage ?? "no reason given"} ("opensourcebook item retry ${item.id}" tries again)` : `it is ${item.status}${item.job?.step ? ` (${item.job.step})` : ""}; "opensourcebook item wait ${item.id}" follows it`;
    throw new Problem("not_made", `"${item.title}" is not made yet: ${why}.`);
  }
  const { output } = await engine.call<{ output: Output }>("GET", `/v1/outputs/${encodeURIComponent(item.outputId)}`);
  return { view, item, output };
}

/** `key=value` settings; a value that reads as JSON (a number, true, false) is kept as that. */
export function parseSettings(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Problem("bad_arguments", `--set takes key=value, like --set questions=5; "${pair}" has no "=".`);
    const raw = pair.slice(at + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // A plain word stays a word.
    }
    out[pair.slice(0, at)] = value;
  }
  return out;
}

const ITEM_ARG = { name: "item", help: "the item's id (\"opensourcebook plan show <plan>\" lists them)" };

const videoFile = (output: Output): string | undefined => {
  const render = output.payload.render as { assetId?: string; url?: string } | undefined;
  return render?.assetId ? `/v1/assets/${encodeURIComponent(render.assetId)}` : render?.url?.startsWith("/v1/") ? render.url : undefined;
};

export const items: Group = {
  thing: "item",
  aliases: ["items"],
  about: "one thing in a plan (video, flashcards, quiz, audio, guide) and, once made, the thing itself",
  commands: [
    {
      thing: "item",
      action: "list",
      summary: "every item of the project's plans (or of one plan) with its state",
      flags: [PROJECT_FLAG, PLAN_FLAG],
      shape: "{ items: [Item & { planId }] }  (Item: { id, type, title, status, enabled, done, outputId?, errorMessage?, job?: { step?, waiting?: { reason, words, nextTryAt, resetsAt? } } })",
      async run(ctx) {
        const engine = connect(ctx);
        const planId = flagString(ctx, "plan");
        const views = planId ? [await progressOf(engine, planId)] : await Promise.all((await plansOf(engine, projectOf(ctx))).map((v) => progressOf(engine, v.plan.id)));
        const all = views.flatMap((v) => v.items.map((i) => ({ ...i, planId: v.plan.id })));
        return { data: { items: all }, text: all.length ? table(all.map((i) => [i.id, itemLine(i)])) : 'No items yet. Make a plan with "opensourcebook plan make <what you want>".' };
      },
    },
    {
      thing: "item",
      action: "status",
      summary: "an item's state, with the live step while it is being made",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG],
      shape: "{ planId, item: Item, notices?: string[] }  (notices: what to know about it, such as a video with no sound and what to do for one)",
      async run(ctx) {
        const { view, item } = await findItem(ctx, connect(ctx), ctx.args.item!);
        const notices = item.notices ?? [];
        return { data: { planId: view.plan.id, item, ...(notices.length ? { notices } : {}) }, text: withNotices(`${itemLine(item)}${item.outputId ? `\nMade: "opensourcebook item get ${item.id}" gives it, "opensourcebook item open ${item.id}" shows it.` : ""}`, notices) };
      },
    },
    {
      thing: "item",
      action: "wait",
      summary: "follow one item until it is made or failed, with the live step",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG, TIMEOUT_FLAG],
      shape: "{ planId, item: Item }",
      async run(ctx) {
        const engine = connect(ctx);
        const { view } = await findItem(ctx, engine, ctx.args.item!);
        if (!["running", "done", "failed", "cancelled"].includes(view.plan.status) && !PLAN_OVER.has(view.plan.status)) throw new Problem("plan_not_started", `Its plan has not started; start it with "opensourcebook plan start ${view.plan.id}".`);
        const after = await follow(ctx, engine, view.plan.id, ctx.args.item!);
        const item = after.items.find((i) => i.id === ctx.args.item)!;
        return { data: { planId: after.plan.id, item }, text: itemLine(item), exit: item.status === "failed" ? 1 : 0 };
      },
    },
    {
      thing: "item",
      action: "get",
      summary: "the made thing: a video's file, or a set of flashcards or a quiz to read here (as JSON with --json or --to)",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG, { name: "to", value: "file", help: "where to save it (default: a video goes to <item id>.mp4 in this folder; flashcards or a quiz are printed)" }],
      shape: "{ item: Item, output: { id, type, title, summary? }, file?: string, payload?: object, notices?: string[] }  (notices: what to know about it, such as a video that has no sound and why)",
      more: "A set of flashcards' payload is its cards, each a front and a back (engine/docs/flashcards.md); \"opensourcebook cards review\" goes through the ones due; a quiz's is its questions, with the answers (quiz show leaves them out); a video's is its scenes, with the file saved.",
      async run(ctx) {
        const engine = connect(ctx);
        const { item, output } = await madeOf(ctx, engine, ctx.args.item!);
        const about = { id: output.id, type: output.type, title: output.title, ...(output.summary ? { summary: output.summary } : {}) };
        const assetPath = output.type === "video" ? videoFile(output) : undefined;
        const to = flagString(ctx, "to");
        if (assetPath) {
          const file = resolve(ctx.cwd, to ?? `${item.id}.mp4`);
          const { data } = await engine.bytes(assetPath);
          writeFileSync(file, data);
          const notices = item.notices ?? [];
          return { data: { item, output: about, file, ...(notices.length ? { notices } : {}) }, text: withNotices(`Saved "${output.title}" to ${file}`, notices) };
        }
        if (to) {
          const file = resolve(ctx.cwd, to);
          writeFileSync(file, `${JSON.stringify(output.payload, null, 2)}\n`);
          return { data: { item, output: about, file }, text: `Saved "${output.title}" (${output.type}) to ${file}` };
        }
        // In the terminal flashcards or a quiz read as text, its cites numbered with the words they quote; --json keeps the payload.
        const reader = output.type === "flashcards" ? cardsText : output.type === "quiz" ? quizText : undefined;
        let text = JSON.stringify(output.payload, null, 2);
        if (reader && !ctx.json) {
          const names = new Map<string, string>();
          for (const id of citedSources(output.payload)) {
            const view = await engine.call<{ source?: { title?: string } }>("GET", `/v1/sources/${encodeURIComponent(id)}`).catch(() => undefined);
            if (view?.source?.title) names.set(id, view.source.title);
          }
          text = reader(output.payload, names);
        }
        return { data: { item, output: about, payload: output.payload }, text };
      },
    },
    {
      thing: "item",
      action: "open",
      summary: "show the made thing in the app, in the browser",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG, PRINT_FLAG],
      shape: "{ url: string, opened: boolean }",
      async run(ctx) {
        const engine = connect(ctx);
        const { output } = await madeOf(ctx, engine, ctx.args.item!);
        const url = `${engine.web}/outputs/${encodeURIComponent(output.id)}`;
        // The browser is let in by a one-time address (cli/opener.ts), which then shows the made thing.
        const entry = await browserAddress(ctx, new URL(url).pathname);
        const opened = !flagOn(ctx, "print") && openUrl(ctx, entry);
        return { data: { url, opened, ...(opened ? {} : { open: entry }) }, text: opened ? `Opened ${url} in the browser on this computer.` : `${entry}\n(works once, for ten minutes, in this computer's browser; then it is at ${url})` };
      },
    },
    {
      thing: "item",
      action: "change",
      summary: "change an item of a plan that has not started",
      args: [ITEM_ARG],
      flags: [
        PLAN_FLAG,
        { name: "title", value: "words", help: "its title" },
        { name: "brief", value: "words", help: "what the maker is told about it" },
        { name: "type", value: "shape", help: "video, flashcards, quiz, audio or guide (\"opensourcebook maker list\" says which can be made now)" },
        { name: "set", value: "key=value", help: "a setting of its shape, like questions=5 or minutes=2", many: true },
        { name: "off", help: "keep it in the plan but do not make it" },
        { name: "on", help: "make it again" },
        { name: "source", value: "id", help: "read this source (replaces the item's list)", many: true },
      ],
      shape: "PlanView",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        const patch: Record<string, unknown> = {};
        const title = flagString(ctx, "title");
        const brief = flagString(ctx, "brief");
        const type = flagString(ctx, "type");
        if (title) patch.title = title;
        if (brief) patch.prompt = brief;
        if (type) patch.type = type;
        const set = flagList(ctx, "set");
        if (set.length) patch.settings = { ...(item.settings ?? {}), ...parseSettings(set) };
        if (flagOn(ctx, "off")) patch.enabled = false;
        if (flagOn(ctx, "on")) patch.enabled = true;
        const src = flagList(ctx, "source");
        if (src.length) patch.sources = src.map((sourceId) => ({ sourceId }));
        if (!Object.keys(patch).length) throw new Problem("bad_arguments", 'Say what to change: --title, --brief, --type, --set key=value, --on, --off or --source.');
        const after = await engine.call<PlanView>("PATCH", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}`, { json: patch });
        const changed = after.items.find((i) => i.id === item.id)!;
        return { data: { ...after }, text: `${itemLine(changed)}${after.issues?.length ? `\nBefore the plan can start: ${after.issues.join(" ")}` : ""}` };
      },
    },
    {
      thing: "item",
      action: "retry",
      summary: "make a failed item again",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG],
      shape: "PlanView",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        const after = await engine.call<PlanView>("POST", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/retry`);
        return { data: { ...after }, text: `Making "${item.title}" again; "opensourcebook item wait ${item.id}" follows it.` };
      },
    },
    {
      thing: "item",
      action: "done",
      summary: "tick an item as done (or not, with --undo), as the app's done tick",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG, { name: "undo", help: "take the tick off" }],
      shape: "{ item: Item, counts: { total, done } }",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        const done = !flagOn(ctx, "undo");
        const answer = await engine.call<{ item: Item; counts: { total: number; done: number } }>("POST", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/done`, { json: { done, ...(done && item.outputId ? { outputId: item.outputId } : {}) } });
        return { data: answer, text: `${done ? "Ticked" : "Unticked"} "${item.title}"; ${answer.counts.done} of ${answer.counts.total} done.` };
      },
    },
    {
      thing: "item",
      action: "progress",
      summary: "where the person stopped in a made item, kept for the phone and the web; give JSON to set it, --clear to forget it",
      args: [ITEM_ARG, { name: "progress", help: "the new place as JSON, in the shape the item's format keeps (a set's cards and when each comes back, a quiz's answers so far, a video's time)", optional: true, rest: true }],
      flags: [PROJECT_FLAG, PLAN_FLAG, { name: "clear", help: "forget where the person stopped" }],
      shape: "{ item: Item, progress: object | null }",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        const raw = ctx.args.progress;
        if (raw === undefined && !flagOn(ctx, "clear")) return { data: { item, progress: item.progress ?? null }, text: item.progress === undefined ? `No place is kept for "${item.title}".` : JSON.stringify(item.progress, null, 2) };
        let progress: unknown = null;
        if (raw !== undefined) {
          try {
            progress = JSON.parse(raw);
          } catch {
            throw new Problem("bad_arguments", `The place must be JSON, such as '{"bit": 3}'; "${raw}" is not.`);
          }
        }
        const answer = await engine.call<{ item: Item }>("POST", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/progress`, { json: { progress } });
        return { data: { item: answer.item, progress: answer.item.progress ?? null }, text: progress === null ? `Forgot where the person stopped in "${item.title}".` : `Kept where the person stopped in "${item.title}".` };
      },
    },
    {
      thing: "item",
      action: "answer",
      summary: "answer an item that asks whether to go on (yes makes it, no skips it)",
      args: [ITEM_ARG, { name: "answer", help: "yes or no" }],
      flags: [PROJECT_FLAG, PLAN_FLAG],
      shape: "{ item: Item, counts: { total, done } }",
      async run(ctx) {
        const word = ctx.args.answer!.toLowerCase();
        if (!["yes", "no", "y", "n", "true", "false"].includes(word)) throw new Problem("bad_arguments", 'Answer with yes or no.');
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        const answer = await engine.call<{ item: Item; counts: { total: number; done: number } }>("POST", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/answer`, { json: { answer: word.startsWith("y") || word === "true" } });
        return { data: answer, text: itemLine(answer.item) };
      },
    },
    {
      thing: "item",
      action: "ask",
      summary: "ask about a made thing, or say what looks wrong, in its thread; prints the answer",
      args: [ITEM_ARG, { name: "words", help: "what to ask or say", rest: true }],
      flags: [PROJECT_FLAG, PLAN_FLAG, { name: "at", value: "json", help: "where in it, in its player's shape, such as '{\"time\": 42}' (default: where the person stopped)" }, TIMEOUT_FLAG],
      shape: "{ chatId, created: boolean, about: { item, label? }, messageId, answer: string, cites: [{ n, sourceId, source, quote? }], covered?: boolean, planIds: string[], questions: [...], failed?: string }",
      more: "The message goes to the thing's thread, which is also the chat that made it (a new chat when it has none), and the reply shows in both. Waits while the person's own agent writes it.",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        if (!item.outputId) throw new Problem("not_made", `"${item.title}" is not made yet, so there is nothing to talk about in it.`);
        if (!ctx.args.words) throw new Problem("bad_arguments", "Say what to ask, such as: opensourcebook item ask <item> why is B wrong?");
        const raw = flagString(ctx, "at");
        let at: unknown = item.progress;
        if (raw !== undefined) {
          try {
            at = JSON.parse(raw);
          } catch {
            throw new Problem("bad_arguments", `--at must be JSON in the player's shape, such as '{"time": 42}'; "${raw}" is not.`);
          }
        }
        const sent = await engine.call<{ chat: Chat; created: boolean; messages: Message[] }>("POST", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/thread`, {
          json: { text: ctx.args.words, ...(at !== undefined && at !== null ? { at } : {}), from: "terminal" },
        });
        const about = (sent.messages[0] as Message & { about?: { item: string; label?: string } }).about;
        const { chat, reply } = await waitForReply(ctx, engine, sent);
        const r = readReply(reply, await titlesOf(engine, chat.projectId));
        const where = about?.label ? ` (${about.label})` : "";
        return {
          data: { chatId: chat.id, created: sent.created, about: { item: item.id, ...(about?.label ? { label: about.label } : {}) }, ...r },
          text: `${replyText(r)}\n\n(on "${item.title}"${where}; in chat ${chat.id}${sent.created ? ", new" : ""})`,
          exit: r.failed ? 1 : 0,
        };
      },
    },
    {
      thing: "item",
      action: "thread",
      summary: "a made thing's thread: what was asked about it, where, and the answers",
      args: [ITEM_ARG],
      flags: [PROJECT_FLAG, PLAN_FLAG],
      shape: "{ chatId?, messages: [{ id, role, text, label?, at? }] }",
      async run(ctx) {
        const engine = connect(ctx);
        const { view, item } = await findItem(ctx, engine, ctx.args.item!);
        const thread = await engine.call<{ chat?: Chat; messages: Array<Message & { about?: { label?: string; at?: unknown } }> }>("GET", `/v1/plans/${encodeURIComponent(view.plan.id)}/items/${encodeURIComponent(item.id)}/thread`);
        const titles = thread.chat ? await titlesOf(engine, thread.chat.projectId) : new Map<string, string>();
        const messages = thread.messages.map((m) => ({ id: m.id, role: m.role, text: m.role === "user" ? m.text : m.state === "running" ? "(being written)" : readReply(m, titles).answer, ...(m.about?.label ? { label: m.about.label } : {}), ...(m.about?.at !== undefined ? { at: m.about.at } : {}) }));
        const text = messages.length
          ? messages.map((m) => (m.role === "user" ? `You${m.label ? ` (${m.label})` : ""}: ${m.text}` : `Open Sourcebook: ${m.text}`)).join("\n\n")
          : `Nothing said about "${item.title}" yet. "opensourcebook item ask ${item.id} <words>" starts its thread.`;
        return { data: { ...(thread.chat ? { chatId: thread.chat.id } : {}), messages }, text };
      },
    },
  ],
};
