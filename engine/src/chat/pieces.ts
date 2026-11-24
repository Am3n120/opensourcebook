/**
 * A reply is an ordered list of pieces the client draws in order
 * (engine/docs/api.md, "Message"): its written blocks with their cites (a
 * paragraph, a list, a table, ...; blocks.ts), a plan card, a question with
 * options. Kinds are registered here; the chat core and the skills only
 * build pieces and ask the registry how one reads as words (for the plain
 * `text` of a reply and for the history a prompt shows). A new kind is a
 * registration, not a change to the chat core.
 */
import { isRecord } from "../net";
import type { JsonObject } from "../jobs/types";
import { blockKinds, type ReplyBlock } from "./blocks";

export interface TextPiece {
  kind: "text";
  /** A paragraph, with inline marks (blocks.ts). */
  text: string;
  /** Indexes into the reply's `cites`. */
  cites: number[];
  /** Set when the part cited the sources but no cite held up to the check: it is not shown as cited. */
  unchecked?: boolean;
  /** These are the words saying why a turn of the person's agent ended early (agent/turn.ts). */
  failure?: boolean;
}

export interface PlanPiece {
  kind: "plan";
  planId: string;
  action: "created" | "edited";
  /** In words: what an edit changed, and what it left as the person had it. */
  changes?: string[];
  /** A plan of one thing made at once (no card to approve), or a remake of one: drawn as that thing, not a card. */
  made?: "made" | "remade";
}

/**
 * One thing asked for in the chat, settled and checked but saved nowhere:
 * the make sheet, for the person to open filled in. Nothing is made until
 * they press the sheet's button (`POST /v1/projects/:id/make` with
 * `proposal`), which marks it `made`; Cancel marks it `closed`.
 */
export interface MakePiece {
  kind: "make";
  format: string;
  title: string;
  /** The brief, what the sheet's "What it covers" shows. */
  about: string;
  /** Source ids. */
  sources: string[];
  /** Settled as `/make/settle` settles them. */
  settings: JsonObject;
  /** What it will be, in the format's own words. */
  plannedAs: string;
  notices: string[];
  /** What would stop it now; the sheet keeps Make off while there are any. */
  issues: string[];
  /** A follow-up about something made: the thing it remakes. */
  remakes?: { planId: string; itemId: string };
  state: "open" | "made" | "closed";
  /** Once made from this piece. */
  planId?: string;
}

export interface QuestionOption {
  id: string;
  label: string;
  /** The skill the turn goes to when this option is picked. */
  skill?: string;
}

export interface QuestionPiece {
  kind: "question";
  id: string;
  text: string;
  options: QuestionOption[];
  multiple: boolean;
}

/** A piece of any kind, as stored; the registry may not know its kind. */
export interface OtherPiece {
  readonly kind: string;
}

type Fields = Record<string, unknown>;

/** What a reply is made of: its written blocks (blocks.ts), plan cards and questions. */
export type ReplyPiece = TextPiece | Exclude<ReplyBlock, { kind: "text" }> | PlanPiece | MakePiece | QuestionPiece;

export interface PieceKind {
  readonly kind: string;
  /** The piece in words, for the reply's plain text and for prompts. */
  asText(piece: Fields): string;
}

export class PieceRegistry {
  private readonly kinds = new Map<string, PieceKind>();

  register(kind: PieceKind): this {
    if (!/^[a-z][A-Za-z0-9]{0,39}$/.test(kind.kind)) throw new Error(`"${kind.kind}" is not a piece kind.`);
    if (this.kinds.has(kind.kind)) throw new Error(`Piece kind "${kind.kind}" is already registered.`);
    this.kinds.set(kind.kind, kind);
    return this;
  }

  has(kind: string): boolean {
    return this.kinds.has(kind);
  }

  /** A piece in words. A kind nobody registered reads as its `text`, if it has one. */
  asText(piece: OtherPiece): string {
    const fields = piece as unknown as Fields;
    const kind = this.kinds.get(piece.kind);
    if (kind) return kind.asText(fields);
    return typeof fields.text === "string" ? fields.text : "";
  }

  /** A reply's pieces as one plain text. */
  replyText(pieces: readonly OtherPiece[]): string {
    return pieces
      .map((piece) => this.asText(piece).trim())
      .filter(Boolean)
      .join("\n\n");
  }
}

export function createPieceKinds(): PieceRegistry {
  const registry = new PieceRegistry();
  // Every written block (a paragraph, a list, a table, ...) reads as its kind says.
  for (const kind of blockKinds.list()) registry.register({ kind: kind.kind, asText: (piece) => kind.asText(piece) });
  return registry
    .register({
      kind: "plan",
      asText: (piece) => {
        if (piece.made === "made" || piece.made === "remade") return `[${piece.made === "remade" ? "Remade" : "Made"} at once, shown as the thing itself (thing ${String(piece.planId)})]`;
        const changes = Array.isArray(piece.changes) ? piece.changes.filter((change): change is string => typeof change === "string") : [];
        return `[The plan card (${piece.action === "edited" ? "changed" : "new"})]${changes.length ? `\n${changes.map((change) => `- ${change}`).join("\n")}` : ""}`;
      },
    })
    .register({
      kind: "make",
      asText: (piece) => {
        const state = piece.state === "made" ? `made (thing ${String(piece.planId)})` : piece.state === "closed" ? "closed without making it" : "open for the person; nothing is made until they press its button";
        return `[The make sheet for "${String(piece.title ?? "")}" (${String(piece.plannedAs ?? piece.format ?? "")})${piece.remakes ? ", a remake" : ""}: ${state}]`;
      },
    })
    .register({
      kind: "question",
      asText: (piece) => {
        const options = Array.isArray(piece.options) ? piece.options.filter(isRecord).map((option) => String(option.label ?? "")) : [];
        return `${typeof piece.text === "string" ? piece.text : ""}${options.length ? `\n(options: ${options.join(" / ")})` : ""}`;
      },
    });
}

/** The pieces every chat uses. */
export const pieceKinds = createPieceKinds();

export function say(text: string, cites: number[] = []): TextPiece {
  return { kind: "text", text, cites };
}

/**
 * A question piece from the model's words: options get ids, empty ones are
 * dropped, and every option may name the skill picking it goes to.
 * Undefined when there is no question text.
 */
export function question(id: string, raw: unknown, skillOf: (index: number, label: string) => string | undefined): QuestionPiece | undefined {
  if (!isRecord(raw)) return undefined;
  const text = typeof raw.text === "string" ? raw.text.trim() : typeof raw.question === "string" ? raw.question.trim() : "";
  if (!text) return undefined;
  const labels = (Array.isArray(raw.options) ? raw.options : [])
    .map((option) => (typeof option === "string" ? option : isRecord(option) && typeof option.label === "string" ? option.label : ""))
    .map((label) => label.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 12);
  const options = [...new Set(labels)].map((label, index) => {
    const skill = skillOf(index, label);
    return { id: `o${index + 1}`, label, ...(skill ? { skill } : {}) };
  });
  return { kind: "question", id, text: text.slice(0, 1_000), options, multiple: raw.multiple === true && options.length > 1 };
}

export interface Picks {
  messageId: string;
  picks: Array<{ questionId: string; optionIds: string[] }>;
}

/**
 * Checks picks against the reply they answer. Returns the skills the
 * picked options name, or what is wrong with the picks.
 */
export function checkPicks(pieces: readonly OtherPiece[], picks: Picks["picks"]): { skills: string[] } | { problem: string } {
  const questions = new Map(pieces.filter((piece): piece is QuestionPiece => piece.kind === "question").map((piece) => [piece.id, piece]));
  if (picks.length === 0) return { problem: "answer.picks is empty" };
  const skills = new Set<string>();
  const seen = new Set<string>();
  for (const pick of picks) {
    const asked = questions.get(pick.questionId);
    if (!asked) return { problem: `That reply has no question "${pick.questionId}"` };
    if (seen.has(pick.questionId)) return { problem: `Question "${pick.questionId}" is picked twice` };
    seen.add(pick.questionId);
    if (pick.optionIds.length === 0) return { problem: `No option picked for question "${pick.questionId}"` };
    if (!asked.multiple && pick.optionIds.length > 1) return { problem: `Question "${pick.questionId}" takes one option` };
    for (const optionId of pick.optionIds) {
      const option = asked.options.find((candidate) => candidate.id === optionId);
      if (!option) return { problem: `Question "${pick.questionId}" has no option "${optionId}"` };
      if (option.skill) skills.add(option.skill);
    }
  }
  return { skills: [...skills] };
}
