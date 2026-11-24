import type { FormatDescriptor, JsonObject } from "../api/types";

/**
 * What a make sheet opens filled in with, when a chat proposal or a plan item
 * opens it: the chat's `make` piece (engine/docs/api.md, "Making one thing"),
 * with where that piece sits so the sheet can mark it made or closed. Every
 * field is optional; anything else is left alone.
 */
export interface MakePrefill {
  about?: string;
  title?: string;
  sources?: string[];
  settings?: JsonObject;
  issues?: string[];
  notices?: string[];
  remakes?: { planId: string; itemId: string };
  /** The chat, message and piece the proposal is. */
  chatId?: string;
  messageId?: string;
  piece?: number;
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

/** Reads a prefill handed over as loose data, keeping only fields of the right kind. */
export function readPrefill(raw: Record<string, unknown> | undefined): MakePrefill {
  if (!raw) return {};
  const out: MakePrefill = {};
  if (typeof raw.about === "string") out.about = raw.about;
  if (typeof raw.title === "string") out.title = raw.title;
  const sources = strings(raw.sources);
  if (sources) out.sources = sources;
  if (raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) out.settings = raw.settings as JsonObject;
  const issues = strings(raw.issues);
  if (issues) out.issues = issues;
  const notices = strings(raw.notices);
  if (notices) out.notices = notices;
  const remakes = raw.remakes as { planId?: unknown; itemId?: unknown } | undefined;
  if (remakes && typeof remakes.planId === "string" && typeof remakes.itemId === "string") out.remakes = { planId: remakes.planId, itemId: remakes.itemId };
  if (typeof raw.chatId === "string") out.chatId = raw.chatId;
  if (typeof raw.messageId === "string") out.messageId = raw.messageId;
  if (typeof raw.piece === "number") out.piece = raw.piece;
  return out;
}

/** The proposal a prefill came from, when it says where it sits. */
export function proposalOf(p: MakePrefill): { chatId: string; messageId: string; piece: number } | undefined {
  return p.chatId && p.messageId && p.piece !== undefined ? { chatId: p.chatId, messageId: p.messageId, piece: p.piece } : undefined;
}

/** "Make a video", "Make an audio": from the shape's own words. */
export function sheetTitle(format: FormatDescriptor): string {
  const one = format.singular ?? format.label;
  return `Make ${/^[aeiou]/i.test(one) ? "an" : "a"} ${one}`;
}

/** "Make the video", "Make the flashcards". */
export function makeLabel(format: FormatDescriptor): string {
  return `Make the ${format.label}`;
}
