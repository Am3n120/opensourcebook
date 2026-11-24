import type { ComponentType, ReactNode } from "react";
import type { Answer, Cite, FailedReply, MakePiece, Message, Piece, PlanPiece, QuestionPiece, Source, TextPiece } from "../api/types";
import { BackgroundPieceView, CodePieceView, HeadingPieceView, ListPieceView, MathPieceView, NotePieceView, PlanPieceView, QuestionPieceView, TablePieceView, TextPieceView, UnknownPieceView } from "./pieceViews";
import { MakePieceView } from "./chat/MakeProposal";
import { MindMapPieceView } from "./chat/MindMap";
import { TeachBackPieceView } from "./chat/TeachBack";
import { VERDICT_GROUPS } from "./verdicts";

/** What a piece's view gets besides the piece itself. */
export interface PieceProps<P extends Piece = Piece> {
  piece: P;
  message: Message;
  /** Where the piece sits in its message. */
  index?: number;
  sourceById: Map<string, Source>;
  /** The chip number of each of the message's cites, in reading order. */
  citeNumber: Map<number, number>;
  /** Opens a cited source at its spot; `n` is the chip number it was opened from. */
  onOpenCite: (cite: Cite, n?: number) => void;
  /** The plan card, when this piece is where that plan is drawn. */
  planCard: (piece: PlanPiece) => ReactNode;
  /** The options picked so far in this question, or as it was answered. */
  picked: (question: QuestionPiece) => string[];
  /** Set when a later message of the person answered this reply. */
  answered?: Answer;
  onPick: (question: QuestionPiece, optionId: string) => void;
  disabled: boolean;
}

export interface PieceView {
  view: ComponentType<PieceProps>;
  /** Drawn on its own between the reply's text, not inside its bubble. */
  block?: boolean;
  /** The piece as plain text for the clipboard; without it, its `text`. Written blocks only: plan cards and questions are not copied. */
  copy?: (piece: Piece) => string;
}

/**
 * How each kind of reply piece is drawn (engine/docs/api.md, "Message").
 * A new kind is a registration here; the chat panel never names a kind.
 */
export class PieceViews {
  private readonly views = new Map<string, PieceView>();

  register(kind: string, view: PieceView): this {
    if (this.views.has(kind)) throw new Error(`Piece kind "${kind}" is already registered.`);
    this.views.set(kind, view);
    return this;
  }

  /** The view for a kind; a kind nobody registered is drawn honestly by `UnknownPieceView`. */
  get(kind: string): PieceView {
    return this.views.get(kind) ?? { view: UnknownPieceView };
  }

  /** Whether the kind is known here. */
  has(kind: string): boolean {
    return this.views.has(kind);
  }
}

/** Words as copied: a link to a spot keeps its words. */
const words = (piece: Piece) => (typeof piece.text === "string" ? piece.text.replace(/\[([^\]\n]+)\]\(cite:\d+\)/g, "$1") : "");

/** A teach-back as copied: each group under its heading, a list of its points. */
function teachBackCopy(piece: Piece): string {
  const items = Array.isArray(piece.items) ? (piece.items as Array<{ verdict?: unknown; text?: unknown }>) : [];
  const groups = VERDICT_GROUPS.flatMap(({ verdict, heading }) => {
    const points = items.filter((item) => item.verdict === verdict).map((item) => `- ${words({ kind: "text", text: String(item.text ?? "") })}`);
    return points.length ? [`${heading}:\n${points.join("\n")}`] : [];
  });
  return groups.length ? groups.join("\n\n") : words(piece);
}

/**
 * The written blocks of a reply (engine/docs/api.md, "Reply blocks"), then
 * plan cards and questions. A kind added later in the engine is drawn by
 * its `text` until it has a view here.
 */
export const pieceViews = new PieceViews()
  .register("text", { view: TextPieceView as ComponentType<PieceProps>, copy: words })
  .register("heading", { view: HeadingPieceView as ComponentType<PieceProps>, copy: words })
  .register("list", { view: ListPieceView as ComponentType<PieceProps> })
  .register("table", { view: TablePieceView as ComponentType<PieceProps> })
  .register("note", { view: NotePieceView as ComponentType<PieceProps>, copy: words })
  .register("math", { view: MathPieceView as ComponentType<PieceProps>, copy: (piece) => `$$${String(piece.text ?? "")}$$` })
  .register("background", { view: BackgroundPieceView as ComponentType<PieceProps>, copy: (piece) => `Background, not from the sources: ${words(piece)}` })
  .register("code", { view: CodePieceView as ComponentType<PieceProps>, copy: (piece) => `\`\`\`\n${String(piece.text ?? "")}\n\`\`\`` })
  .register("teachback", { view: TeachBackPieceView as ComponentType<PieceProps>, copy: teachBackCopy })
  .register("mindmap", { view: MindMapPieceView as ComponentType<PieceProps> })
  .register("make", { view: MakePieceView as ComponentType<PieceProps>, block: true, copy: () => "" })
  .register("plan", { view: PlanPieceView as ComponentType<PieceProps>, block: true, copy: () => "" })
  .register("question", { view: QuestionPieceView as ComponentType<PieceProps>, copy: () => "" });

export function isText(piece: Piece): piece is TextPiece {
  return piece.kind === "text" && typeof piece.text === "string";
}

/** Cite indexes a piece carries, in reading order: its items', rows' or a map's ideas', then its own. */
function citesIn(piece: Piece): number[] {
  const out: number[] = [];
  const add = (value: unknown) => Array.isArray(value) && value.forEach((c) => typeof c === "number" && out.push(c));
  for (const part of [...(Array.isArray(piece.items) ? piece.items : []), ...(Array.isArray(piece.rows) ? piece.rows : []), ...(Array.isArray(piece.nodes) ? piece.nodes : [])]) if (part && typeof part === "object") add((part as { cites?: unknown }).cites);
  add(piece.cites);
  return out;
}

/** The chip number of each cite of a reply, 1, 2, ... in the order a reader meets them. */
export function citeNumbers(pieces: Piece[]): Map<number, number> {
  const numbers = new Map<number, number>();
  for (const piece of pieces) for (const c of citesIn(piece)) if (!numbers.has(c)) numbers.set(c, numbers.size + 1);
  return numbers;
}

/** A reply as plain text for the clipboard: its written blocks, lists as lists, no cite numbers. */
export function copyText(pieces: Piece[]): string {
  return pieces
    .filter((piece) => !piece.failure)
    .map((piece) => {
      const view = pieceViews.has(piece.kind) ? pieceViews.get(piece.kind) : undefined;
      return (view?.copy ? view.copy(piece) : words(piece)).trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The blocks a turn of the person's agent showed before it ended early, then
 * its plan cards: everything but the words saying why, which the failure
 * line says. A reply stored before blocks stayed shows only its plans.
 */
export function shownBeforeFailure(message: Message): Piece[] {
  const pieces = piecesOf(message);
  if (!pieces.some((p) => p.failure)) return pieces.filter(isPlan);
  return pieces.filter((p) => !p.failure);
}

export function isPlan(piece: Piece): piece is PlanPiece {
  return piece.kind === "plan" && typeof piece.planId === "string";
}

export function isMake(piece: Piece): piece is MakePiece {
  return piece.kind === "make" && typeof piece.format === "string";
}

export function isQuestion(piece: Piece): piece is QuestionPiece {
  return piece.kind === "question" && typeof piece.id === "string" && Array.isArray(piece.options);
}

/** A message's pieces; a message with none reads as one text piece. */
export function piecesOf(message: Message): Piece[] {
  return message.pieces?.length ? message.pieces : [{ kind: "text", text: message.text, cites: [] }];
}

/**
 * Why a reply could not be written, from the engine's `failed` field
 * (engine/docs/api.md, "Message"). Undefined for an ordinary reply, including
 * one stored before the field existed.
 */
export function failedReply(message: Message): FailedReply | undefined {
  return message.role === "assistant" ? message.failed : undefined;
}

/** Whether sending the same message again may work: not when the model account or a limit stopped it. */
export function canRetry(failed: FailedReply): boolean {
  return failed.reason !== "outOfCredit" && failed.reason !== "keyRefused" && failed.reason !== "budget";
}

/**
 * What a reply that cannot be tried again says. The model account's reasons
 * use the engine's own words, which name the provider; a reply stopped by its
 * limit says so without the amount (the apps show no money).
 */
export function failedText(failed: FailedReply, text: string): string {
  if (failed.reason === "budget") return "Open Sourcebook stopped this reply: it reached the limit set for it.";
  const own = text.trim();
  if (own) return own;
  return failed.reason === "outOfCredit" ? "Open Sourcebook couldn't reply: the model account is out of credit." : "Open Sourcebook couldn't reply: the model account's key was refused.";
}

/** A reply the person's own agent is still writing. */
export function runningReply(message: Message): boolean {
  return message.role === "assistant" && message.state === "running";
}

/**
 * Why the person's agent wrote no reply, in calm words, and whether sending
 * the message again is the one useful thing to do. Reasons come from the
 * engine (engine/docs/api.md, "Your agent"); one this app does not know reads
 * as a plain failure.
 */
const AGENT_PROBLEMS: Record<string, { text: string; retry: boolean }> = {
  agentUnreachable: { text: "Open Sourcebook can't reach your agent. Start Open Sourcebook's connector on your computer, then try again.", retry: true },
  agentMissing: { text: "Open Sourcebook can't find your agent on your computer. Install it, then try again.", retry: true },
  agentSignedOut: { text: "Your agent isn't signed in. Sign in to it on your computer, then try again.", retry: true },
  agentLimit: { text: "Your agent's plan has reached its limit for now. Ask again once it is available again.", retry: true },
  timedOut: { text: "Your agent took too long, so Open Sourcebook stopped it.", retry: true },
  stopped: { text: "You stopped this reply.", retry: false },
};

export function agentProblem(message: Message): { text: string; retry: boolean } | undefined {
  const reason = message.role === "assistant" && message.agent ? message.failed?.reason : undefined;
  if (!reason) return undefined;
  const problem = AGENT_PROBLEMS[reason] ?? { text: "Your agent couldn't finish this reply.", retry: true };
  // Part of the reply was shown before it ended: it stays, and says it is cut short.
  return message.failed?.cutShort ? { ...problem, text: reason === "stopped" ? "You stopped this reply, so it is cut short." : `${problem.text} The reply above is cut short.` } : problem;
}

/** The words of a person's message that picks options: the labels, one line per question. */
export function answerText(message: Message, answer: Answer): string {
  const questions = new Map(piecesOf(message).filter(isQuestion).map((q) => [q.id, q]));
  return answer.picks
    .map((pick) => {
      const q = questions.get(pick.questionId);
      return pick.optionIds.map((id) => q?.options.find((o) => o.id === id)?.label ?? id).join(", ");
    })
    .join("\n");
}
