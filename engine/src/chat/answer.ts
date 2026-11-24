/**
 * A plain reply: an answer grounded in the turn's sources, every claim cited
 * at its passage with a quote the engine has checked word for word
 * (engine/docs/flashcards.md, "Cite"). When the passages do not hold the answer,
 * the reply says so; it never answers from elsewhere. The reply is written
 * as blocks (blocks.ts), the same shape the person's own agent writes.
 */
import type { Cite } from "../cards/contract";
import { isRecord } from "../net";
import { renderPassages, type Passage } from "../sources/passages";
import type { StructuredProvider } from "../types/provider";
import { blockKinds, CiteBook, type BadQuote } from "./blocks";
import { renderHistory, renderMentions, type TurnContext } from "./context";
import { pickPassages } from "./retrieval";
import { question, say, type ReplyPiece } from "./pieces";
import type { ChatSkill, SkillReply } from "./skills";
import { blockGuide } from "./writing";
import type { Message } from "../studio/repositories";

export interface AnswerOptions {
  /** Most characters of passages one reply reads. */
  passageBudgetChars?: number;
  historyChars?: number;
}

const DEFAULT_PASSAGE_BUDGET = 48_000;
const DEFAULT_HISTORY_CHARS = 8_000;

export const ANSWER_SYSTEM_PROMPT = `You are Open Sourcebook, answering inside one project of someone's own sources.
Use only the numbered passages you are given. Never answer from general knowledge, and never invent a source.
Write in the language the person writes in. Be direct and clear; explain better than the source when you can, but claim nothing the passages do not say.
Write the reply as an ordered list of blocks.
${blockGuide("P3")}
Every block, list item or table row that states something from a passage cites it in its own "cites": {"passage": "<label, e.g. P3>", "quote": "<a few words copied exactly from that passage>"}. Copy quotes character for character; keep them short.
A block that only greets, asks back or connects ideas has no cites.
If the passages do not hold what was asked, say so plainly in the reply (and what the sources do cover, if useful), and set "covered" to false.
If the message asks nothing the sources would answer (a greeting, thanks), reply briefly and set "covered" to null.
Return only JSON: {"blocks": [{"kind": "paragraph", "text": "...", "cites": [{"passage": "P1", "quote": "..."}]}, {"kind": "bullets", "items": [{"text": "...", "cites": [...]}]}], "covered": true | false | null}`;

export async function answerFromSources(input: {
  text: string;
  history: Message[];
  context: TurnContext;
  provider: StructuredProvider;
  /** Skills Open Sourcebook may offer unasked at the end of the answer. */
  offers?: ChatSkill[];
  /** What a skill asks of this answer, said before the message; the passages are still found from the message alone. */
  ask?: string;
  options?: AnswerOptions;
}): Promise<SkillReply> {
  const { text, history, context, provider } = input;
  const offers = (input.offers ?? []).filter((skill) => skill.offerWhen);
  const historyText = renderHistory(history, input.options?.historyChars ?? DEFAULT_HISTORY_CHARS);
  const pick = pickPassages(context.sources, text, input.options?.passageBudgetChars ?? DEFAULT_PASSAGE_BUDGET, historyText);
  const userPrompt = answerPrompt(text, historyText, context, pick.passages, pick.total, offers, input.ask);

  let raw = await provider.generateJSON<unknown>({ systemPrompt: ANSWER_SYSTEM_PROMPT, userPrompt, task: "chat" });
  let read = readAnswer(raw, pick.passages, offers);
  if (read.badQuotes.length > 0) {
    raw = await provider.generateJSON<unknown>({
      systemPrompt: ANSWER_SYSTEM_PROMPT,
      userPrompt: `${userPrompt}\n\nYour last reply:\n${JSON.stringify(raw)}\n\nThese quotes are not word for word in the passage they cite:\n${read.badQuotes
        .map((bad) => `- ${bad.passage}: "${bad.quote}"`)
        .join("\n")}\nReturn the whole reply again with each quote copied exactly from its passage, or cite a passage that does say it, or drop the claim.`,
      task: "chat",
    });
    read = readAnswer(raw, pick.passages, offers);
  }
  return read.reply;
}

function answerPrompt(text: string, history: string, context: TurnContext, passages: Passage[], total: number, offers: ChatSkill[], ask?: string): string {
  const scope =
    context.scope === "mentioned" ? "the sources the person mentioned" : context.scope === "ticked" ? "the sources the person ticked" : "every source in the project";
  const lines = [
    `Sources read: ${scope}${passages.length < total ? ` (the ${passages.length} passages of ${total} that best match)` : ""}.`,
  ];
  if (context.unread.length > 0) lines.push(`Not readable yet (still extracting or failed): ${context.unread.map((source) => source.title).join(", ")}.`);
  const mentions = renderMentions(context);
  if (mentions) lines.push(mentions);
  if (history) lines.push(`Conversation so far:\n${history}`);
  lines.push(passages.length > 0 ? `Passages:\n${renderPassages(passages)}` : "Passages: none. The project has no readable source for this.");
  if (offers.length > 0) lines.push(offerPrompt(offers));
  if (ask) lines.push(ask);
  lines.push(`Message:\n${text}`);
  return lines.join("\n\n");
}

/** What Open Sourcebook may offer, and how, for the answer's prompt. */
function offerPrompt(offers: ChatSkill[]): string {
  return [
    "Open Sourcebook can also do these for the person:",
    ...offers.map((skill) => `- ${skill.id}: ${skill.about} Offer it when: ${skill.offerWhen}`),
    'If the conversation now gives enough to go on for one of these, the person has not asked for it, and Open Sourcebook has not just offered it, you may end the reply by offering it: add "offer": {"skill": "<id>", "question": "<the offer, in the person\'s language>", "accept": "<short label that accepts>", "decline": "<short label that declines>"}. Offer at most one, and only when it would help now.',
  ].join("\n");
}

export interface ReadAnswer {
  reply: SkillReply;
  /** Cites that failed the check; `unknown` when the passage label is not one there is. */
  badQuotes: BadQuote[];
  /** Blocks that could not be read (a table row wider than its header, a list with no items). */
  problems: string[];
}

export interface ReadOptions {
  /**
   * Every cite must name a passage there is and quote its words exactly; one
   * that does not is dropped, not kept as a cite of the whole passage, and a
   * block left with none is marked `unchecked`. A reply with no block is
   * left empty instead of saying it could not be written.
   */
  strict?: boolean;
  /** Cites the reply already uses (earlier calls of the reply tool); new ones go after them. */
  cites?: readonly Cite[];
}

/**
 * The model's reply as pieces and cites. `blocks` are read through the
 * block kinds (blocks.ts); `parts`, the older shape, read as paragraphs. An
 * unknown passage label is dropped; a quote not in its passage is reported,
 * and dropped from the cite, which still points at the passage. An offer of
 * a skill that may be offered ends the reply as a question whose accepting
 * option names it.
 */
export function readAnswer(raw: unknown, passages: Passage[], offers: ChatSkill[] = [], options: ReadOptions = {}): ReadAnswer {
  const book = new CiteBook(passages, options.strict === true, options.cites);
  const read = blockKinds.read(rawBlocks(raw), book);
  const covered = isRecord(raw) && typeof raw.covered === "boolean" ? raw.covered : undefined;
  const pieces: ReplyPiece[] = [...(read.blocks as ReplyPiece[])];
  if (pieces.length === 0 && !options.strict) pieces.push(say("I couldn't put an answer together from the sources. Try asking again, or more narrowly."));
  const offer = isRecord(raw) && isRecord(raw.offer) ? raw.offer : undefined;
  const offered = offer && typeof offer.skill === "string" ? offers.find((skill) => skill.id === offer.skill) : undefined;
  if (offer && offered) {
    const accept = typeof offer.accept === "string" && offer.accept.trim() ? offer.accept.trim() : undefined;
    const decline = typeof offer.decline === "string" && offer.decline.trim() ? offer.decline.trim() : undefined;
    const asked = accept ? question("q1", { text: offer.question, options: [accept, ...(decline ? [decline] : [])] }, (index) => (index === 0 ? offered.id : undefined)) : undefined;
    if (asked) pieces.push(asked);
  }
  return {
    reply: { pieces, ...(book.cites.length > 0 ? { cites: book.cites } : {}), ...(covered !== undefined ? { covered } : {}) },
    badQuotes: book.bad,
    problems: read.problems,
  };
}

/** The blocks as written: `blocks`, or the older `parts` (paragraphs), or one `text`. */
function rawBlocks(raw: unknown): unknown[] {
  if (!isRecord(raw)) return [];
  if (Array.isArray(raw.blocks)) return raw.blocks;
  if (Array.isArray(raw.parts)) return raw.parts.map((part) => (isRecord(part) && part.kind === undefined ? { ...part, kind: "paragraph" } : part));
  return typeof raw.text === "string" ? [{ kind: "paragraph", text: raw.text }] : [];
}
