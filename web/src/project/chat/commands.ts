import type { ChatCommand, Message } from "../../api/types";
import { splitCommand } from "../mentions";

/**
 * How the `/` list and the Tools list are grouped (engine/docs/api.md,
 * "Making one thing"): each command names its group, and its title and line
 * come from its own registry entry. Groups show in this order; inside one,
 * in the order the engine lists them.
 */
export const COMMAND_GROUPS: ReadonlyArray<{ id: ChatCommand["group"]; title: string; note: string }> = [
  { id: "make", title: "Make", note: "opens its sheet, filled in" },
  { id: "plan", title: "Plan", note: "opens a plan to look over before Start" },
  { id: "chat", title: "In the chat", note: "makes nothing" },
];

/** The commands a query finds, in group order: by the word after `/`, or by a word of the title. */
export function matchCommands(commands: readonly ChatCommand[], query = ""): ChatCommand[] {
  const q = query.trim().toLowerCase();
  const hit = (c: ChatCommand) => !q || c.command.toLowerCase().startsWith(q) || c.title.toLowerCase().split(/\W+/).some((w) => w.startsWith(q));
  return COMMAND_GROUPS.flatMap((g) => commands.filter((c) => c.group === g.id && hit(c)));
}

/**
 * What picking a command does with nothing else typed: a shape opens its
 * make sheet, a plan opens a new plan, and the rest go in the box for the
 * person to finish. With words after it, it is sent as a message.
 */
export function pickedAlone(c: ChatCommand): "sheet" | "plan" | "type" {
  if (c.group === "make" && c.format) return "sheet";
  if (c.group === "plan") return "plan";
  return "type";
}

/** A message that is only a command (`/video`), with nothing after it: the command. */
export function bareCommand(text: string, commands: readonly ChatCommand[]): ChatCommand | undefined {
  const m = /^\/(\S+)$/.exec(text.trim());
  return m ? commands.find((c) => c.command.toLowerCase() === m[1]!.toLowerCase()) : undefined;
}

/**
 * The chat command (one that answers in the chat) that led to a reply: the
 * skill the reply names, else the last command the person typed in the chat
 * before it. A reply the person's own agent wrote names no skill, and its
 * turn may answer a message with no command, such as the explanation sent
 * after `/teachback`.
 */
export function chatCommandOf(
  reply: Pick<Message, "id" | "skill">,
  messages: ReadonlyArray<{ id?: string; role?: Message["role"]; pending?: true; text: string }>,
  commands: readonly ChatCommand[],
): ChatCommand | undefined {
  const own = commands.filter((c) => c.group === "chat");
  if (reply.skill) return own.find((c) => c.skill === reply.skill);
  const at = messages.findIndex((m) => !m.pending && m.id === reply.id);
  for (let i = at - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!m.pending && m.role !== "user") continue;
    const said = splitCommand(m.text, commands);
    if (said) return own.includes(said.skill) ? said.skill : undefined;
  }
  return undefined;
}

/**
 * A command's line in a list: the first sentence of its registry text, whole,
 * its first letter a capital whatever the registry sends.
 * A colon or semicolon ends the lead too, since what follows it spells the
 * lead out.
 */
export function firstSentence(text: string): string {
  const m = /^[\s\S]*?[^\s][.!?:;](?=\s|$)/.exec(text.trim());
  const line = m ? m[0].replace(/[:;]$/, "").trim() : text.trim();
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * The card's quiet line: the kind once, then what the sheet says of it
 * without repeating the kind or naming "Your agent", then who would make it
 * by model and effort when a pick is known, then "not made yet".
 */
export function proposalLine(kind: string, plannedAs: string, maker: string | undefined): string {
  const said = kind.toLowerCase();
  const rest = plannedAs
    .split("·")
    .map((w) => w.trim())
    .filter((w) => w && w.toLowerCase() !== "your agent" && !said.includes(w.toLowerCase()));
  return [kind, ...rest, ...(maker ? [maker] : []), "not made yet"].join(" · ");
}
