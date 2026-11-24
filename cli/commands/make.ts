/**
 * `opensourcebook make <shape> <words...>`: one thing made at once, the way `/<shape> ...` is in the app's chat. Open Sourcebook's planner in
 * the chat settles its brief and settings and it starts with nothing to approve; `--wait` follows it until it is
 * made. The shapes are whatever the running engine can make now (`GET /v1/skills`, its commands): nothing here names
 * one. A path through the material is `opensourcebook plan make`.
 */
import { connect, projectOf, type Engine } from "./connect.ts";
import { newChat, readReply, replyText, sendAndWait } from "./chats.ts";
import { follow, getPlan, noticesOf, planText, withNotices } from "./plans.ts";
import { listSources } from "./sources.ts";
import { PROJECT_FLAG, Problem, TIMEOUT_FLAG, WAIT_FLAG, flagOn, flagString, type Group } from "./table.ts";

interface ChatCommand {
  command: string;
  label: string;
  about: string;
  format?: string;
}

/** The shapes the running engine can make now, as its chat's commands. */
export async function shapesOf(engine: Engine): Promise<ChatCommand[]> {
  const r = await engine.call<{ commands?: ChatCommand[] }>("GET", "/v1/skills");
  return (r.commands ?? []).filter((c) => c.format);
}

export const make: Group = {
  thing: "",
  about: "Making one thing at once (a path through the material is \"opensourcebook plan make\"):",
  commands: [
    {
      thing: "",
      action: "make",
      summary: "make one thing now, with nothing to approve: its shape, then what it is about",
      args: [
        { name: "shape", help: "what to make, as the app's chat command names it (\"opensourcebook make help\" lists what this Open Sourcebook can make)" },
        { name: "request", help: "what it is about and anything to honour (length, look), in your words; left out, it is made from the sources", optional: true, rest: true },
      ],
      flags: [PROJECT_FLAG, { name: "chat", value: "id", help: "make it in this chat (default: a new chat), so a follow-up such as \"make it shorter\" there remakes it" }, WAIT_FLAG, TIMEOUT_FLAG],
      shape: "{ chatId, plan?: PlanView, reply: Reply, notices?: string[] }  (plan: the one-item plan it was made as; absent when Open Sourcebook asked a question or could not make it, and reply says why; notices: what to know about it, such as a video that will have no sound and what to do for one)",
      more: [
        "It starts at once. --wait follows it until it is made, with the live step on stderr.",
        "To change it after, say so in the same chat: opensourcebook chat ask \"make it shorter\" --chat <chatId>.",
        "A plan (several things, or a path through the material, shown first and started by you) is \"opensourcebook plan make\".",
      ].join("\n"),
      async run(ctx) {
        const engine = connect(ctx);
        const wanted = ctx.args.shape!.replace(/^\//, "").toLowerCase();
        const shapes = await shapesOf(engine);
        const shape = shapes.find((s) => s.command === wanted);
        if (!shape) {
          const list = shapes.map((s) => `${s.command} (${s.about})`).join(", ");
          throw new Problem("unknown_shape", shapes.length ? `This Open Sourcebook can't make "${wanted}". It can make: ${list}.` : "This Open Sourcebook can't make anything right now.");
        }
        // The shape is checked before the project, so asking for something Open Sourcebook doesn't make says that first.
        const projectId = projectOf(ctx);
        if (!(await listSources(engine, projectId)).some((s) => s.status === "ready")) throw new Problem("no_sources", 'The project has no source that was read yet; add some with "opensourcebook source add <files or links>" first.');
        const chatId = flagString(ctx, "chat") ?? (await newChat(engine, projectId)).id;
        const { chat, reply } = await sendAndWait(ctx, engine, chatId, { text: `/${shape.command}${ctx.args.request ? ` ${ctx.args.request}` : ""}` });
        const r = readReply(reply, new Map((await listSources(engine, projectId)).map((s) => [s.id, s.title])));
        const id = r.planIds.at(-1);
        if (!id) return { data: { chatId: chat.id, reply: r }, text: `${replyText(r)}\n\n(chat ${chat.id})`, exit: r.failed ? 1 : r.questions.length ? 0 : 1 };
        const view = flagOn(ctx, "wait") ? await follow(ctx, engine, id) : await getPlan(engine, id);
        const failed = view.items.some((i) => i.status === "failed");
        const tail = flagOn(ctx, "wait") ? "" : `\n\nFollow it with "opensourcebook plan wait ${id}".`;
        // The followed view is the plan's progress, which has no notices; the plan itself says what to know of each item, made or not.
        const notices = noticesOf((flagOn(ctx, "wait") ? await getPlan(engine, id) : view).items);
        return { data: { chatId: chat.id, plan: view, reply: r, notices }, text: withNotices(`${replyText(r)}\n\n${planText(view)}${tail}\nChange it by saying so: opensourcebook chat ask "<what to change>" --chat ${chat.id}`, notices), exit: failed ? 1 : 0 };
      },
    },
  ],
};
