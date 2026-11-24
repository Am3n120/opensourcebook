/**
 * A guide changed by hand (engine/docs/guide.md, "Changing it by hand"): the
 * person sends the whole guide as they now have it (title, sections, each
 * point's term and words) and it is laid over what is kept. A point they did
 * not touch keeps everything it had. A point whose words they changed is
 * theirs from then on: it keeps its cites, which still show where the
 * maker's words came from, and keeps the maker's words beside it so they can
 * go back. Words put back as the maker wrote them make the point the
 * maker's again. A point with no id is theirs, with no cites. A section or a
 * point left out is removed. Nothing a person sends adds a cite: a cite is
 * only ever a maker's, checked word for word when it was made.
 */
import type { EditResult } from "../../studio/types";
import { GUIDE_LIMITS, guideCitations, type GuidePayload, type GuidePoint, type GuideSection } from "./contract";

export type GuideEdit = EditResult<GuidePayload>;

export function editGuide(current: GuidePayload, edited: unknown, now: string): GuideEdit {
  if (!isRecord(edited)) return { ok: false, problems: ["Send the guide as an object with its title and sections."] };
  const problems: string[] = [];
  const title = typeof edited.title === "string" && edited.title.trim() ? clean(edited.title) : current.title;
  if (title.length > GUIDE_LIMITS.title) problems.push(`The title is longer than ${GUIDE_LIMITS.title} characters.`);
  if (!Array.isArray(edited.sections)) return { ok: false, problems: ["Send the guide's sections as a list."] };
  if (edited.sections.length > GUIDE_LIMITS.sections) problems.push(`A guide holds at most ${GUIDE_LIMITS.sections} sections.`);

  const known = new Map<string, GuidePoint>();
  for (const section of current.sections) for (const point of section.points) known.set(point.id, point);
  const knownSections = new Set(current.sections.map((section) => section.id));
  let nextPoint = maxNumber([...known.keys()], "p");
  let nextSection = maxNumber([...knownSections], "s");
  const usedPoints = new Set<string>();
  const usedSections = new Set<string>();

  const sections: GuideSection[] = [];
  edited.sections.forEach((raw, s) => {
    const where = `Section ${s + 1}`;
    if (!isRecord(raw)) return void problems.push(`${where} is not a section.`);
    const heading = typeof raw.title === "string" ? clean(raw.title) : "";
    if (!heading) problems.push(`${where} needs a heading.`);
    else if (heading.length > GUIDE_LIMITS.sectionTitle) problems.push(`${where}'s heading is longer than ${GUIDE_LIMITS.sectionTitle} characters.`);
    const rawPoints = Array.isArray(raw.points) ? raw.points : [];
    if (rawPoints.length > GUIDE_LIMITS.points) problems.push(`${where} holds more than ${GUIDE_LIMITS.points} points; split it.`);
    const sectionId = typeof raw.id === "string" && knownSections.has(raw.id) && !usedSections.has(raw.id) ? raw.id : `s${++nextSection}`;
    usedSections.add(sectionId);
    const points: GuidePoint[] = [];
    rawPoints.forEach((entry, p) => {
      if (!isRecord(entry)) return void problems.push(`${where}, point ${p + 1} is not a point.`);
      const text = typeof entry.text === "string" ? clean(entry.text) : "";
      const term = typeof entry.term === "string" ? clean(entry.term) : "";
      // A point emptied by hand is a point removed.
      if (!text && !term) return;
      if (!text) return void problems.push(`${where}, point ${p + 1} has a term but no words.`);
      if (text.length > GUIDE_LIMITS.pointText) return void problems.push(`${where}, point ${p + 1} is longer than ${GUIDE_LIMITS.pointText} characters; split it into points.`);
      if (term.length > GUIDE_LIMITS.term) return void problems.push(`${where}, point ${p + 1}'s term is longer than ${GUIDE_LIMITS.term} characters.`);
      const id = typeof entry.id === "string" ? entry.id : undefined;
      const before = id && !usedPoints.has(id) ? known.get(id) : undefined;
      if (before) {
        usedPoints.add(before.id);
        points.push(laidOver(before, term, text));
      } else {
        const fresh = `p${++nextPoint}`;
        usedPoints.add(fresh);
        points.push({ id: fresh, ...(term ? { term } : {}), text, background: false, cites: [], yours: true });
      }
    });
    sections.push({ id: sectionId, title: heading, points });
  });
  if (problems.length > 0) return { ok: false, problems };

  const payload: GuidePayload = { ...current, title, sections, editedAt: now };
  return { ok: true, payload, citations: guideCitations(sections), title };
}

/** A kept point with the person's term and words laid over it. */
function laidOver(before: GuidePoint, term: string, text: string): GuidePoint {
  const same = (words: { term?: string; text: string }) => (words.term ?? "") === term && words.text === text;
  if (same(before)) return before;
  const { yours: _yours, made, ...rest } = before;
  const base = { ...rest, ...(term ? { term } : {}), text };
  if (!term) delete base.term;
  // Put back as the maker wrote it: the maker's again.
  if (made && same(made)) return base;
  // A point the person added stays theirs, with nothing of a maker's to go back to.
  if (before.yours && !made) return { ...base, yours: true };
  return { ...base, yours: true, made: made ?? { ...(before.term ? { term: before.term } : {}), text: before.text } };
}

function maxNumber(ids: string[], prefix: string): number {
  return ids.reduce((top, id) => {
    const n = new RegExp(`^${prefix}(\\d+)$`).exec(id)?.[1];
    return n ? Math.max(top, Number(n)) : top;
  }, 0);
}

/** One line: what a person types, with runs of spaces and line breaks made one space. */
function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
