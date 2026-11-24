import type { Json, JsonObject } from "../api/types";
import type { Cite } from "./blockData";

/** One point of a guide (engine/docs/guide.md, "Point"). */
export interface GuidePoint {
  id: string;
  term: string;
  text: string;
  /** The maker's own explanation, not the sources: never cited. */
  background: boolean;
  cites: Cite[];
  /** The person wrote or changed it by hand. */
  yours: boolean;
  /** What the maker wrote, when the person changed it. */
  made?: { term: string; text: string };
}

export interface GuideSection {
  id: string;
  title: string;
  points: GuidePoint[];
}

export interface Guide {
  title: string;
  about: string;
  lengthNote: string;
  editedAt: string;
  sections: GuideSection[];
}

const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const isObj = (v: Json | undefined): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

/** A guide payload read defensively; it never throws. A point with no words is dropped. */
export function asGuide(payload: JsonObject | undefined): Guide {
  const p = isObj(payload) ? payload : {};
  const sections = arr(p.sections)
    .filter(isObj)
    .map((s, i): GuideSection => ({
      id: str(s.id) || `s${i + 1}`,
      title: str(s.title),
      points: arr(s.points)
        .filter(isObj)
        .filter((x) => str(x.text) !== "")
        .map((x, j): GuidePoint => {
          const made = isObj(x.made) && typeof x.made.text === "string" ? { term: str(x.made.term), text: x.made.text } : undefined;
          return {
            id: str(x.id) || `s${i + 1}p${j + 1}`,
            term: str(x.term),
            text: str(x.text),
            background: x.background === true,
            cites: arr(x.cites).filter(isObj).filter((c) => typeof c.sourceId === "string") as unknown as Cite[],
            yours: x.yours === true,
            ...(made ? { made } : {}),
          };
        }),
    }));
  return { title: str(p.title), about: str(p.about), lengthNote: str(p.lengthNote), editedAt: str(p.editedAt), sections };
}

/** What the page is while the person changes it: words only, ids kept so the engine lays them over what it keeps. */
export interface DraftPoint {
  /** Absent for a point the person added. */
  id?: string;
  term: string;
  text: string;
  /** For putting the maker's words back. */
  made?: { term: string; text: string };
  /** The point was the maker's or had cites: shown with a note that its cite is the maker's. */
  cited: boolean;
}

export interface DraftSection {
  /** Absent for a section the person added. */
  id?: string;
  /** A key for drawing, stable while the draft is open. */
  key: string;
  title: string;
  points: Array<DraftPoint & { key: string }>;
}

export interface Draft {
  title: string;
  sections: DraftSection[];
}

let keys = 0;
export const newKey = () => `k${++keys}`;

export function draftOf(guide: Guide, title: string): Draft {
  return {
    title,
    sections: guide.sections.map((s) => ({
      id: s.id,
      key: newKey(),
      title: s.title,
      points: s.points.map((p) => ({ id: p.id, key: newKey(), term: p.term, text: p.text, cited: p.cites.length > 0, ...(p.made ? { made: p.made } : {}) })),
    })),
  };
}

/** The draft as the engine takes it (`PUT /v1/outputs/:id/payload`): the whole guide as the person now has it. */
export function editBody(draft: Draft): JsonObject {
  return {
    title: draft.title,
    sections: draft.sections.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      title: s.title,
      points: s.points.map((p) => ({ ...(p.id ? { id: p.id } : {}), ...(p.term.trim() ? { term: p.term } : {}), text: p.text })),
    })),
  };
}
