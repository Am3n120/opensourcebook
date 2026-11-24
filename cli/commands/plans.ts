/** Plans: what to make from a project's sources (items in stages), made in words, then started and followed. */
import { connect, projectOf, type Engine } from "./connect.ts";
import { newChat, readReply, replyText, sendAndWait } from "./chats.ts";
import { listSources } from "./sources.ts";
import { PROJECT_FLAG, Problem, TIMEOUT_FLAG, WAIT_FLAG, flagOn, flagString, type Ctx, type Group } from "./table.ts";
import { plural, sleep, table, timeoutMs } from "./util.ts";

export interface Item {
  id: string;
  type: string;
  title: string;
  level: number;
  prompt?: string;
  settings?: Record<string, unknown>;
  enabled: boolean;
  status: string;
  errorMessage?: string;
  outputId?: string;
  done?: boolean;
  result?: Record<string, unknown>;
  asking?: { question?: string };
  /** What to know about it, though it can be made (a video that will have no sound, and what to do for one), or about what was made. */
  notices?: string[];
  /** Where the person stopped in it (the format's own shape), shared by the phone and the web. */
  progress?: unknown;
  estCostUsd?: number;
  /** `waiting`: something Open Sourcebook runs restarted, or the agent's plan reached its limit; `words` says so, with what is kept. */
  job?: { status?: string; step?: string; progress?: number; errorMessage?: string; waiting?: { reason: string; words: string; nextTryAt?: string; resetsAt?: string } };
  sources?: Array<{ sourceId: string }>;
}

export interface PlanView {
  plan: { id: string; projectId: string; title?: string; status: string; kickedOffAt?: string };
  items: Item[];
  counts: { total: number; done: number };
  estimateUsd?: number;
  issues?: string[];
}

/** What to know about these items, each line once, as the engine says it. */
export function noticesOf(items: Pick<Item, "notices" | "enabled">[]): string[] {
  return [...new Set(items.filter((i) => i.enabled).flatMap((i) => i.notices ?? []))];
}

/** Notice lines under an answer's text, when there are any. */
export function withNotices(text: string, notices: string[]): string {
  return notices.length ? `${text}\n${notices.join("\n")}` : text;
}

export const SETTLED = new Set(["done", "failed", "skipped", "cancelled"]);
export const PLAN_OVER = new Set(["done", "failed", "cancelled", "discarded"]);

/** One line for an item: its title, shape, state and, while it is being made, the live step. */
export function itemLine(i: Item): string {
  const step = i.status === "running" || i.status === "queued" ? i.job?.step : undefined;
  const why = i.status === "failed" ? i.errorMessage : undefined;
  // An item's status "done" means made; the person's tick is said apart from it.
  const waiting = i.status === "running" ? i.job?.waiting : undefined;
  const state = !i.enabled ? "off" : i.status === "done" ? "made" : waiting ? "waiting" : i.status;
  const said = waiting ? ` - ${waiting.words}${waiting.resetsAt ? ` (resets at ${waiting.resetsAt})` : ""}` : step ? ` - ${step}` : "";
  return `${i.title} (${i.type}): ${state}${said}${why ? ` - ${why}` : ""}${i.done ? ", ticked done" : ""}`;
}

export function planText(view: PlanView): string {
  const p = view.plan;
  const enabled = view.items.filter((i) => i.enabled && i.status !== "skipped");
  const made = enabled.filter((i) => i.status === "done").length;
  const state = p.status === "done" ? "finished" : p.status;
  const lines = [`${p.title ?? "Plan"} (${p.id}): ${state}, ${made} of ${plural(enabled.length, "item")} made`];
  lines.push(table(view.items.map((i) => [`  ${i.id}`, `L${i.level}`, itemLine(i)])));
  if (view.issues?.length) lines.push("Before it can start:", ...view.issues.map((s) => `  ${s}`));
  return lines.join("\n");
}

export async function getPlan(engine: Engine, id: string): Promise<PlanView> {
  return engine.call<PlanView>("GET", `/v1/plans/${encodeURIComponent(id)}`);
}

export async function progressOf(engine: Engine, planId: string): Promise<PlanView> {
  return engine.call<PlanView>("GET", `/v1/plans/${encodeURIComponent(planId)}/progress`);
}

/**
 * Follows a plan (or one item of it) until it settles, saying each change of state or step on stderr. Ends early
 * when an item asks the person something ("ask me" branches).
 */
export async function follow(ctx: Ctx, engine: Engine, planId: string, itemId?: string): Promise<PlanView> {
  const until = Date.now() + timeoutMs(ctx, 30);
  const said = new Map<string, string>();
  for (;;) {
    const view = await progressOf(engine, planId);
    for (const i of view.items.filter((x) => x.enabled && (!itemId || x.id === itemId))) {
      const line = itemLine(i);
      if (said.get(i.id) !== line) {
        ctx.progress(line);
        said.set(i.id, line);
      }
    }
    if (itemId) {
      const item = view.items.find((i) => i.id === itemId);
      if (!item) throw new Problem("not_found", `The plan has no item ${itemId}.`);
      if (SETTLED.has(item.status) || item.asking || PLAN_OVER.has(view.plan.status)) return view;
    } else {
      const open = view.items.filter((i) => i.enabled && !SETTLED.has(i.status));
      if (PLAN_OVER.has(view.plan.status) || (view.plan.status !== "draft" && view.plan.status !== "approved" && !open.length) || view.items.some((i) => i.asking)) return view;
      if (view.plan.status === "draft" || view.plan.status === "approved") throw new Problem("plan_not_started", `The plan has not started; start it with "opensourcebook plan start ${planId}".`);
    }
    if (Date.now() > until) throw new Problem("timeout", `Still being made; "opensourcebook plan wait ${planId}" follows it again, "opensourcebook plan show ${planId}" says where it is.`);
    await sleep(ctx.pollMs * 2);
  }
}

/** Every plan of the project with its items: what item and output lookups search. */
export async function plansOf(engine: Engine, projectId: string): Promise<PlanView[]> {
  const { plans } = await engine.call<{ plans: Array<{ id: string; status: string }> }>("GET", `/v1/projects/${encodeURIComponent(projectId)}/plans`);
  return Promise.all(plans.filter((p) => p.status !== "discarded").map((p) => getPlan(engine, p.id)));
}

const PLAN_ARG = { name: "plan", help: "the plan's id (\"opensourcebook plan list\" shows them)" };

function waitAnswer(view: PlanView) {
  const failed = view.items.filter((i) => i.status === "failed");
  const asking = view.items.filter((i) => i.asking);
  const tail = asking.length ? `\n${asking.map((i) => `"${i.title}" asks: ${i.asking?.question ?? "go on?"} (answer with "opensourcebook item answer ${i.id} yes|no")`).join("\n")}` : "";
  return { data: { ...view }, text: `${planText(view)}${tail}`, exit: failed.length ? 1 : 0 };
}

export const plans: Group = {
  thing: "plan",
  aliases: ["plans"],
  about: "what to make from the sources: items (videos, flashcards, quizzes) in stages",
  commands: [
    {
      thing: "plan",
      action: "make",
      summary: "make a plan from a request in words (the planner in the chat writes it)",
      args: [{ name: "request", help: "what you want, in your words", rest: true }],
      flags: [PROJECT_FLAG, { name: "chat", value: "id", help: "plan in this chat (default: a new chat)" }, TIMEOUT_FLAG],
      shape: "{ chatId, plans: PlanView[], reply: Reply }  (PlanView: { plan: { id, status, title? }, items: Item[], counts, estimateUsd?, issues: string[] })",
      more: "The planner may ask a question instead of planning; then plans is empty and reply.questions holds it: answer with \"opensourcebook chat pick <option> --chat <chatId>\".",
      async run(ctx) {
        const engine = connect(ctx);
        const projectId = projectOf(ctx);
        if (!(await listSources(engine, projectId)).some((s) => s.status === "ready")) throw new Problem("no_sources", 'The project has no source that was read yet; add some with "opensourcebook source add <files or links>" first.');
        const chatId = flagString(ctx, "chat") ?? (await newChat(engine, projectId)).id;
        const { chat, reply } = await sendAndWait(ctx, engine, chatId, { text: `/plan ${ctx.args.request}` });
        const r = readReply(reply, new Map((await listSources(engine, projectId)).map((s) => [s.id, s.title])));
        const views = await Promise.all(r.planIds.map((id) => getPlan(engine, id)));
        const text = [replyText(r), ...views.map(planText)].join("\n\n");
        return { data: { chatId: chat.id, plans: views, reply: r }, text: `${text}\n\n${views.length ? `Start it with "opensourcebook plan start ${views.at(-1)!.plan.id} --wait".` : `(chat ${chat.id})`}`, exit: r.failed ? 1 : 0 };
      },
    },
    {
      thing: "plan",
      action: "list",
      summary: "the project's plans",
      flags: [PROJECT_FLAG],
      shape: "{ plans: [{ id, title?, status, counts: { total, done } }] }",
      async run(ctx) {
        const { plans: list } = await connect(ctx).call<{ plans: Array<{ id: string; title?: string; status: string; counts: { total: number; done: number } }> }>("GET", `/v1/projects/${encodeURIComponent(projectOf(ctx))}/plans`);
        return { data: { plans: list }, text: list.length ? table(list.map((p) => [p.id, p.title ?? "Plan", p.status, `${p.counts.done}/${p.counts.total} done`])) : 'No plans yet. Make one with "opensourcebook plan make <what you want>".' };
      },
    },
    {
      thing: "plan",
      action: "show",
      summary: "a plan: its items, their state and live step, and what stops it starting",
      args: [PLAN_ARG],
      shape: "PlanView",
      async run(ctx) {
        const engine = connect(ctx);
        const view = await getPlan(engine, ctx.args.plan!);
        // The plan view's items carry the job's step only in progress; merge it in for the live step.
        const progress = await progressOf(engine, view.plan.id).catch(() => undefined);
        const items = view.items.map((i) => ({ ...i, ...(progress?.items.find((p) => p.id === i.id)?.job ? { job: progress.items.find((p) => p.id === i.id)!.job } : {}) }));
        const merged = { ...view, items };
        return { data: { ...merged }, text: planText(merged) };
      },
    },
    {
      thing: "plan",
      action: "start",
      summary: "start making the plan's items (approves it first, as the app's Start does)",
      args: [PLAN_ARG],
      flags: [WAIT_FLAG, TIMEOUT_FLAG],
      shape: "PlanView",
      more: "Returns at once with the plan running; --wait follows it to the end (a video takes several minutes).",
      async run(ctx) {
        const engine = connect(ctx);
        const id = encodeURIComponent(ctx.args.plan!);
        let view = await getPlan(engine, ctx.args.plan!);
        if (view.plan.status === "draft") view = await engine.call<PlanView>("POST", `/v1/plans/${id}/approve`);
        if (view.plan.status === "approved") view = await engine.call<PlanView>("POST", `/v1/plans/${id}/start`);
        else if (view.plan.status === "cancelled") view = await engine.call<PlanView>("POST", `/v1/plans/${id}/resume`);
        if (flagOn(ctx, "wait")) return waitAnswer(await follow(ctx, engine, view.plan.id));
        return { data: { ...view }, text: `${planText(view)}\n\nFollow it with "opensourcebook plan wait ${view.plan.id}".` };
      },
    },
    {
      thing: "plan",
      action: "wait",
      summary: "follow a started plan until every item is made or failed, with the live step",
      args: [PLAN_ARG],
      flags: [TIMEOUT_FLAG],
      shape: "PlanView (as progress: items with status, job.step, outputId, errorMessage)",
      async run(ctx) {
        return waitAnswer(await follow(ctx, connect(ctx), ctx.args.plan!));
      },
    },
    {
      thing: "plan",
      action: "stop",
      summary: "stop a running plan (or throw away one not started)",
      args: [PLAN_ARG],
      shape: "PlanView",
      async run(ctx) {
        const view = await connect(ctx).call<PlanView>("POST", `/v1/plans/${encodeURIComponent(ctx.args.plan!)}/cancel`);
        return { data: { ...view }, text: `${planText(view)}${view.plan.status === "cancelled" ? `\n\n"opensourcebook plan start ${view.plan.id}" goes on from what is not made yet.` : ""}` };
      },
    },
    {
      thing: "plan",
      action: "rename",
      summary: "give a plan a new title",
      args: [PLAN_ARG, { name: "title", help: "the new title", rest: true }],
      shape: "PlanView",
      async run(ctx) {
        const view = await connect(ctx).call<PlanView>("PATCH", `/v1/plans/${encodeURIComponent(ctx.args.plan!)}`, { json: { title: ctx.args.title } });
        return { data: { ...view }, text: planText(view) };
      },
    },
  ],
};
