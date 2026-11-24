/**
 * Label a picture: a picture from the source whose parts carry marks of its
 * own (letters, numbers, arrows labelled A to E), and for each mark the
 * person picks what it is. The marks are the picture's, so nothing has to be
 * placed on it: the writer reads them from the source's text about the
 * picture (its caption, its key, the passage that explains it).
 *
 * Fields: `picture` `{ url, caption? }`, a picture the sources hold
 * (`/v1/assets/<id>`); `marks`, each `{ mark, answer }` (the mark as it is on
 * the picture and the name it stands for); `extra`, names that are on no
 * mark, offered beside the right ones (optional); `names`, every name offered,
 * in an order the engine chooses. Response: `{ "labels": [<names index> |
 * null, ...] }`, one per mark in order. Each mark named rightly earns its
 * share.
 */
import { isKeptPicture } from "../../../cards/pictures";
import { index, isRecord, listIssues, normalizeAnswer, permutation, text, texts, type KindIssue, type QuestionKind } from "../kinds";
import type { QuizQuestion } from "../schema";

const MIN_MARKS = 2;
const MAX_MARKS = 8;
const MAX_EXTRA = 4;
const MAX_MARK = 12;

export interface Mark {
  mark: string;
  answer: string;
}

const marks = (question: QuizQuestion): Mark[] => (Array.isArray(question.marks) ? (question.marks as Mark[]).filter(isRecord) : []);
const names = (question: QuizQuestion): string[] => (Array.isArray(question.names) ? (question.names as string[]) : []);
const picture = (question: QuizQuestion): { url?: unknown; caption?: unknown } => (isRecord(question.picture) ? question.picture : {});

/** For each mark, the name picked for it, or undefined when none was. */
function picked(question: QuizQuestion, response: unknown): Array<string | undefined> | undefined {
  if (!isRecord(response) || !Array.isArray(response.labels)) return undefined;
  const offered = names(question);
  return marks(question).map((_, at) => {
    const value = index((response.labels as unknown[])[at]);
    return value !== undefined ? offered[value] : undefined;
  });
}

const right = (mark: Mark, name: string | undefined) => name !== undefined && normalizeAnswer(name) === normalizeAnswer(mark.answer);

export const labelKind: QuestionKind = {
  id: "label",
  label: "Label a picture",
  description: "Name the marked parts of a picture from the source.",
  usesPicture: true,
  fields: {
    picture: {
      type: "object",
      properties: { url: { type: "string", description: "One of the sources' pictures, /v1/assets/<id>, exactly as listed." }, caption: { type: "string" } },
      required: ["url"],
      description: "The picture, from the sources' pictures.",
    },
    marks: {
      type: "array",
      minItems: MIN_MARKS,
      maxItems: MAX_MARKS,
      description: "The marks the picture itself carries (A, B, 1, 2...) and what each one is.",
      items: { type: "object", properties: { mark: { type: "string" }, answer: { type: "string" } }, required: ["mark", "answer"] },
    },
    extra: { type: "array", items: { type: "string" }, maxItems: MAX_EXTRA, description: "Optional: names on no mark, offered beside the right ones so the last mark is not found by elimination." },
  },
  guidance: `"kind":"label", "picture":{"url":"/v1/assets/<id>","caption":"..."} (one of the sources' pictures, exactly as listed), "marks":[{"mark":"A","answer":"..."}, ...] (${MIN_MARKS} to ${MAX_MARKS}: the marks as they are printed on the picture itself, and what each is), "extra":["..."] (optional, up to ${MAX_EXTRA} names that are on no mark). Use it only when the sources say what the picture's own marks stand for (a key, a caption, the passage explaining it): you cannot see the picture, so never guess a mark or describe where it is. The caption never gives an answer away. Open Sourcebook offers the names mixed.`,
  normalize(raw) {
    const shown = isRecord(raw.picture) ? raw.picture : {};
    const url = text(shown.url) ?? text(raw.url) ?? "";
    const caption = text(shown.caption);
    const list = (Array.isArray(raw.marks) ? raw.marks.filter(isRecord) : []).map((mark) => ({ mark: text(mark.mark) ?? "", answer: text(mark.answer) ?? "" }));
    const extra = texts(raw.extra);
    return {
      picture: { url, ...(caption ? { caption } : {}) },
      marks: list,
      ...(extra.length ? { extra } : {}),
      names: [...list.map((mark) => mark.answer), ...extra],
    };
  },
  check(question, context) {
    const issues: KindIssue[] = [];
    const url = picture(question).url;
    if (!isKeptPicture(url)) issues.push({ path: ".picture.url", code: "picture", message: "the picture must be one of the sources' pictures, /v1/assets/<id>, exactly as listed" });
    else if (context?.pictures && !context.pictures.has(url)) issues.push({ path: ".picture.url", code: "picture", message: "that picture is not one of this item's sources' pictures; use one exactly as listed" });
    const list = marks(question);
    if (!Array.isArray(question.marks) || list.length < MIN_MARKS || list.length > MAX_MARKS) {
      issues.push({ path: ".marks", code: "count", message: `needs ${MIN_MARKS} to ${MAX_MARKS} marks, each {"mark":"A","answer":"..."}` });
      return issues;
    }
    issues.push(...listIssues(list.map((mark) => mark.mark), "", MIN_MARKS, MAX_MARKS, "marks").map((issue) => ({ ...issue, path: `.marks${issue.path}.mark` })));
    list.forEach((mark, at) => {
      if (typeof mark.mark === "string" && mark.mark.length > MAX_MARK) issues.push({ path: `.marks[${at}].mark`, code: "too_long", message: `a mark is what is printed on the picture (A, 3, iv), at most ${MAX_MARK} characters` });
    });
    const extra = Array.isArray(question.extra) ? question.extra : [];
    if (extra.length > MAX_EXTRA) issues.push({ path: ".extra", code: "count", message: `at most ${MAX_EXTRA} extra names` });
    const all = [...list.map((mark) => mark.answer), ...extra];
    issues.push(...listIssues(all, "", MIN_MARKS, MAX_MARKS + MAX_EXTRA, "names").map((issue) => ({ ...issue, path: issue.path.replace(/^\[(\d+)\]$/, (_, at: string) => (Number(at) < list.length ? `.marks[${at}].answer` : `.extra[${Number(at) - list.length}]`)) || ".marks" })));
    const offered = names(question).map(normalizeAnswer).sort();
    if (offered.join("\n") !== all.map((name) => normalizeAnswer(String(name))).sort().join("\n")) {
      issues.push({ path: ".names", code: "names", message: "names must be the marks' answers and the extra names, each once" });
    }
    return issues;
  },
  arrange(question, random) {
    const offered = names(question);
    return { names: permutation(offered.length, random).map((from) => offered[from]) };
  },
  describeAnswer(question) {
    return marks(question).map((mark) => `${mark.mark}: ${mark.answer}`).join("; ");
  },
  grade(question, response) {
    const chosen = picked(question, response);
    if (!chosen || chosen.every((name) => name === undefined)) return { fraction: 0, answered: false };
    const list = marks(question);
    return { fraction: list.filter((mark, at) => right(mark, chosen[at])).length / list.length, answered: true };
  },
  describeShown(question) {
    const caption = text(picture(question).caption);
    return [
      `A picture from the source${caption ? ` ("${caption}")` : ""} with the marks ${marks(question).map((mark) => mark.mark).join(", ")}`,
      `Names to choose from: ${names(question).join("; ")}`,
    ];
  },
  describeResponse(question, response) {
    const chosen = picked(question, response);
    if (!chosen) return undefined;
    return marks(question).map((mark, at) => `${mark.mark}: ${chosen[at] ?? "(none)"} (${right(mark, chosen[at]) ? "right" : "wrong"})`).join("; ");
  },
};
