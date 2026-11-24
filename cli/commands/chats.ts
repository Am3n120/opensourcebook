/** Chats: asking the project's sources, answered with cites by the person's own agent inside Open Sourcebook. */
import { connect, projectOf, type Engine } from "./connect.ts";
import { listSources } from "./sources.ts";
import { PROJECT_FLAG, Problem, TIMEOUT_FLAG, flagList, flagString, type Ctx, type Group } from "./table.ts";
import { sleep, table, timeoutMs } from "./util.ts";

export interface Chat {
  id: string;
  projectId: string;
  title?: string;
  messageCount?: number;
  busySince?: string;
  updatedAt?: string;
}

interface Cite {
  sourceId: string;
  quote?: string;
  locator?: Record<string, number>;
}

interface Piece {
  kind: string;
  text?: string;
  cites?: number[];
  items?: Array<{ text: string; cites?: number[] }>;
  header?: string[];
  rows?: Array<{ cells: string[]; cites?: number[] }>;
  planId?: string;
  action?: string;
  id?: string;
  options?: Array<{ id: string; label: string; skill?: string }>;
  multiple?: boolean;
  failure?: boolean;
}

export interface Message {
  id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  pieces?: Piece[];
  cites?: Cite[];
  covered?: boolean;
  state?: string;
  steps?: Array<{ label: string; state: string }>;
  failed?: { reason: string };
  skill?: string;
}

/** A reply in the shape the command answers with: the words, numbered cites with their source, plans, questions. */
export interface Reply {
  messageId: string;
  answer: string;
  cites: Array<{ n: number; sourceId: string; source: string; quote?: string }>;
  covered?: boolean;
  planIds: string[];
  questions: Array<{ id: string; text: string; multiple: boolean; options: Array<{ id: string; label: string }> }>;
  failed?: string;
}

const marks = (cites: number[] | undefined) => (cites?.length ? ` ${cites.map((c) => `[${c + 1}]`).join("")}` : "");

/** Draws a reply as plain text, each cite a [n] at the end of what it supports. */
export function readReply(message: Message, titles: Map<string, string>): Reply {
  const lines: string[] = [];
  const planIds: string[] = [];
  const questions: Reply["questions"] = [];
  for (const p of message.pieces ?? []) {
    if (p.kind === "text" || p.kind === "note") lines.push(`${p.kind === "note" ? "Note: " : ""}${p.text ?? ""}${marks(p.cites)}`);
    else if (p.kind === "heading") lines.push(`## ${p.text ?? ""}`);
    else if (p.kind === "list") lines.push(...(p.items ?? []).map((i, n) => `${(p as { ordered?: boolean }).ordered ? `${n + 1}.` : "-"} ${i.text}${marks(i.cites)}`));
    else if (p.kind === "table") lines.push(...[p.header ?? [], ...(p.rows ?? []).map((r) => [...r.cells])].map((r, n) => `| ${r.join(" | ")} |${n > 0 ? marks(p.rows?.[n - 1]?.cites) : ""}`));
    else if (p.kind === "math") lines.push(`$$ ${p.text ?? ""} $$${marks(p.cites)}`);
    else if (p.kind === "code") lines.push("```", p.text ?? "", "```");
    else if (p.kind === "plan" && p.planId) {
      if (!planIds.includes(p.planId)) planIds.push(p.planId);
      // A thing made at once is a plan of one item underneath; it is said as what it is.
      const made = (p as { made?: string }).made;
      lines.push(made ? `[${made === "remade" ? "remade" : "being made"} now: ${p.planId}]` : `[plan ${p.action ?? "made"}: ${p.planId}]`);
    } else if (p.kind === "question" && p.id) {
      questions.push({ id: p.id, text: p.text ?? "", multiple: !!p.multiple, options: (p.options ?? []).map((o) => ({ id: o.id, label: o.label })) });
      lines.push(`? ${p.text ?? ""}`, ...(p.options ?? []).map((o) => `    ${o.id}: ${o.label}`));
    } else if (p.text) lines.push(p.text);
  }
  const cites = (message.cites ?? []).map((c, i) => ({ n: i + 1, sourceId: c.sourceId, source: titles.get(c.sourceId) ?? c.sourceId, ...(c.quote ? { quote: c.quote } : {}) }));
  return {
    messageId: message.id,
    answer: lines.join("\n").trim() || message.text,
    cites,
    ...(message.covered !== undefined ? { covered: message.covered } : {}),
    planIds,
    questions,
    ...(message.failed ? { failed: message.failed.reason } : {}),
  };
}

export function replyText(reply: Reply): string {
  const out = [reply.answer];
  if (reply.cites.length) out.push("", ...reply.cites.map((c) => `[${c.n}] ${c.source}${c.quote ? `: "${c.quote}"` : ""}`));
  if (reply.questions.length) out.push("", 'Answer a question with "opensourcebook chat pick <option id>" (add --chat to name the chat).');
  return out.join("\n");
}

export async function titlesOf(engine: Engine, projectId: string): Promise<Map<string, string>> {
  try {
    return new Map((await listSources(engine, projectId)).map((s) => [s.id, s.title]));
  } catch {
    return new Map();
  }
}

/** Sends a message and waits until its reply is written, saying each step on stderr. */
export async function sendAndWait(ctx: Ctx, engine: Engine, chatId: string, body: Record<string, unknown>): Promise<{ chat: Chat; reply: Message }> {
  // Open Sourcebook's reply then points at commands, not at the app's card and buttons.
  const sent = await engine.call<{ chat: Chat; messages: Message[] }>("POST", `/v1/chats/${encodeURIComponent(chatId)}/messages`, { json: { ...body, from: "terminal" } });
  return waitForReply(ctx, engine, sent);
}

/** Waits until the reply among a sent message's answer is written, saying each step on stderr. */
export async function waitForReply(ctx: Ctx, engine: Engine, sent: { chat: Chat; messages: Message[] }): Promise<{ chat: Chat; reply: Message }> {
  const chatId = sent.chat.id;
  const first = sent.messages.filter((m) => m.role === "assistant").at(-1);
  if (!first) throw new Problem("engine_error", "Open Sourcebook took the message but wrote no reply.");
  let reply: Message = first;
  let chat = sent.chat;
  const until = Date.now() + timeoutMs(ctx, 15);
  let said = "";
  while (reply.state === "running") {
    if (Date.now() > until) throw new Problem("timeout", `The reply is still being written. Read it later with "opensourcebook chat show ${chatId}".`);
    await sleep(ctx.pollMs);
    const read: { chat: Chat; messages: Message[] } = await engine.call("GET", `/v1/chats/${encodeURIComponent(chatId)}`, { query: { after: reply.seq - 1 } });
    chat = read.chat;
    const id = reply.id;
    reply = read.messages.find((m) => m.id === id) ?? reply;
    const step = reply.steps?.at(-1)?.label;
    if (step && step !== said) {
      ctx.progress(step);
      said = step;
    }
  }
  return { chat, reply };
}

export async function newChat(engine: Engine, projectId: string): Promise<Chat> {
  return (await engine.call<{ chat: Chat }>("POST", `/v1/projects/${encodeURIComponent(projectId)}/chats`, { json: {} })).chat;
}

const CHAT_FLAG = { name: "chat", value: "id", help: "go on in this chat (default: a new chat)" };

export const chats: Group = {
  thing: "chat",
  aliases: ["chats"],
  about: "ask the project's sources; answers come with cites, checked word for word",
  commands: [
    {
      thing: "chat",
      action: "ask",
      summary: "ask a question and get the cited answer",
      args: [{ name: "question", help: "what to ask", rest: true }],
      flags: [PROJECT_FLAG, CHAT_FLAG, { name: "source", value: "id", help: "read only this source (default: all of them)", many: true }, TIMEOUT_FLAG],
      shape: "{ chatId, messageId, answer: string, cites: [{ n, sourceId, source, quote? }], covered?: boolean, planIds: string[], questions: [{ id, text, multiple, options: [{ id, label }] }], failed?: string }",
      more: "Waits while the person's own agent writes the reply inside Open Sourcebook (usually under a minute). Each [n] in the answer is a cite: n is in cites, with the source's title and the words quoted from it. covered: false means the sources did not hold the answer.",
      async run(ctx) {
        const engine = connect(ctx);
        const projectId = projectOf(ctx);
        const chatId = flagString(ctx, "chat") ?? (await newChat(engine, projectId)).id;
        const sourcesPicked = flagList(ctx, "source");
        const { chat, reply } = await sendAndWait(ctx, engine, chatId, { text: ctx.args.question, ...(sourcesPicked.length ? { sources: sourcesPicked } : {}) });
        const r = readReply(reply, await titlesOf(engine, chat.projectId));
        return { data: { chatId: chat.id, ...r }, text: `${replyText(r)}\n\n(chat ${chat.id}; follow up with --chat ${chat.id})`, exit: r.failed ? 1 : 0 };
      },
    },
    {
      thing: "chat",
      action: "pick",
      summary: "answer the question in the last reply by picking options",
      args: [{ name: "options", help: "option ids (or their words) from the question", many: true }],
      flags: [{ name: "chat", value: "id", help: "the chat (its id is printed with every answer)" }, TIMEOUT_FLAG],
      shape: "the same as chat ask",
      async run(ctx) {
        const chatId = flagString(ctx, "chat");
        if (!chatId) throw new Problem("bad_arguments", 'opensourcebook chat pick needs --chat <id>: the chat whose reply asked (printed with every answer).');
        const engine = connect(ctx);
        const { messages } = await engine.call<{ messages: Message[] }>("GET", `/v1/chats/${encodeURIComponent(chatId)}`);
        const asked = [...messages].reverse().find((m) => m.role === "assistant" && (m.pieces ?? []).some((p) => p.kind === "question"));
        if (!asked) throw new Problem("no_question", "No reply in this chat asks anything to pick from.");
        const wanted = ctx.lists.options ?? [];
        const picks: Array<{ questionId: string; optionIds: string[] }> = [];
        const labels: string[] = [];
        for (const q of (asked.pieces ?? []).filter((p) => p.kind === "question")) {
          const chosen = (q.options ?? []).filter((o) => wanted.some((w) => w === o.id || w.toLowerCase() === o.label.toLowerCase()));
          if (chosen.length) {
            picks.push({ questionId: q.id!, optionIds: chosen.map((o) => o.id) });
            labels.push(...chosen.map((o) => o.label));
          }
        }
        if (!picks.length) throw new Problem("bad_arguments", `None of "${wanted.join(" ")}" is an option of the question. The options are: ${(asked.pieces ?? []).flatMap((p) => (p.options ?? []).map((o) => `${o.id} (${o.label})`)).join(", ")}.`);
        const { chat, reply } = await sendAndWait(ctx, engine, chatId, { text: labels.join(", "), answer: { messageId: asked.id, picks } });
        const r = readReply(reply, await titlesOf(engine, chat.projectId));
        return { data: { chatId: chat.id, ...r }, text: replyText(r), exit: r.failed ? 1 : 0 };
      },
    },
    {
      thing: "chat",
      action: "list",
      summary: "the project's chats, most recently used first",
      flags: [PROJECT_FLAG],
      shape: "{ chats: [{ id, title?, messageCount, updatedAt, busySince? }] }",
      async run(ctx) {
        const { chats: list } = await connect(ctx).call<{ chats: Chat[] }>("GET", `/v1/projects/${encodeURIComponent(projectOf(ctx))}/chats`);
        return { data: { chats: list }, text: list.length ? table(list.map((c) => [c.id, c.title ?? "(untitled)", `${c.messageCount ?? 0} messages`])) : 'No chats yet. Ask something with "opensourcebook chat ask <question>".' };
      },
    },
    {
      thing: "chat",
      action: "show",
      summary: "a chat's messages, each reply with its cites",
      args: [{ name: "chat", help: "the chat's id" }],
      shape: "{ chat: Chat, messages: [{ role: \"user\", text } | { role: \"assistant\", running: boolean, ...Reply }] }",
      async run(ctx) {
        const engine = connect(ctx);
        const { chat, messages } = await engine.call<{ chat: Chat; messages: Message[] }>("GET", `/v1/chats/${encodeURIComponent(ctx.args.chat!)}`);
        const titles = await titlesOf(engine, chat.projectId);
        const shown = messages.map((m) => (m.role === "user" ? { role: "user", text: m.text } : { role: "assistant", running: m.state === "running", ...readReply(m, titles) }));
        const text = shown.map((m) => ("answer" in m ? `Open Sourcebook${m.running ? " (still writing)" : ""}:\n${replyText(m as unknown as Reply)}` : `You: ${m.text}`)).join("\n\n");
        return { data: { chat, messages: shown }, text: `${chat.title ?? "Chat"} (${chat.id})\n\n${text}` };
      },
    },
    {
      thing: "chat",
      action: "stop",
      summary: "stop a reply that is being written",
      args: [{ name: "chat", help: "the chat's id" }],
      shape: "{ stopped: boolean }",
      async run(ctx) {
        await connect(ctx).call("POST", `/v1/chats/${encodeURIComponent(ctx.args.chat!)}/stop`, { json: {} });
        return { data: { stopped: true }, text: "Stopped." };
      },
    },
  ],
};
