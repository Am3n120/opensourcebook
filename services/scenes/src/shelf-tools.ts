/**
 * The agent's tools for the shelf of pieces (src/shelf.ts): find_piece looks for pieces by what the agent wants to
 * show and answers with their lines, settings and pictures, or with every piece by name, or with one piece's program
 * to adapt; a search that finds nothing is noted in the data folder. save_piece keeps a program the agent wrote in a
 * beat on the person's own shelf, saying what would make it more reusable when code sees something.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { jpegBase64 } from "./scene.ts";
import { describe, matchPieces, noteMiss, pieceExample, programIn, savePiece, score, search, shelf, shelfSheet, usage } from "./shelf.ts";
import type { Tool, ToolAnswer } from "./tools.ts";
import { loadShelf, type LibraryEntry } from "../engine/language/library.ts";

const fail = (text: string): ToolAnswer => ({ text, isError: true });
const picture = (folder: string | undefined) => (folder && existsSync(join(folder, "still.jpg")) ? [{ mimeType: "image/jpeg", dataBase64: jpegBase64(join(folder, "still.jpg")) }] : []);

/**
 * The sheet of the whole shelf for this video's folder, made once for each set of pieces (a piece saved since makes a
 * new one), as an image an answer can carry. None when the shelf is empty or the sheet cannot be made.
 */
export async function sheetImage(pieces: LibraryEntry[], folder: string): Promise<{ mimeType: string; dataBase64: string } | undefined> {
  const key = createHash("sha1").update(pieces.map((p) => `${p.origin ?? ""}:${p.name}`).join("|")).digest("hex").slice(0, 10);
  try {
    const file = join(folder, "shelf", `sheet-${key}.jpg`);
    if (!existsSync(file) && !(await shelfSheet(pieces, file))) return undefined;
    return { mimeType: "image/jpeg", dataBase64: jpegBase64(file) };
  } catch {
    return undefined;
  }
}

/**
 * The picture of the whole shelf returned from `about_video` before beat 1, once per video when the sheet image
 * renders cleanly. Returns undefined when the shelf is empty or the sheet cannot be made.
 */
export async function shelfForIdea(folder: string): Promise<{ text: string; images: { mimeType: string; dataBase64: string }[] } | undefined> {
  const pieces = shelf();
  if (!pieces.length) return undefined;
  const sheet = await sheetImage(pieces, folder);
  if (!sheet) return undefined;
  return {
    text: `The shelf has ${pieces.length} pieces that draw themselves in this video's style and follow the voice: the picture below shows all of them, each with its name under it (find_piece with a name gives one's settings and program).`,
    images: [sheet],
  };
}

/** Concise runnable lines for the nearest pieces matching a beat's visual words. */
export function nearestPieceLines(query: string, n = 3): string[] {
  return matchPieces(query, shelf(), n).map(({ piece: p }) => `- ${p.name}: ${p.doc} — \`${usage(p)}\``);
}

export const findPiece: Tool = {
  name: "find_piece",
  description:
    "Look on the shelf of pieces: ready-made things that draw themselves in the video's style and follow the voice (charts, timelines, cycles, processes and flows with branches, maps, comparisons, sentences taken apart, physical motion and more), shipped with Open Sourcebook or saved by you in earlier videos. Say in plain words what you want to show (what, not the topic: \"a quantity growing over time\", \"two sides weighed against each other\", \"a process with stages\") and the few that fit come back with their line, how to write them, their settings and a picture of each, to choose by looking. With name, one piece in full: its settings, its built scene and its program, to adapt into a program of your own. With neither, every piece by name and line, and one picture of the whole shelf. A piece is a starting point: change its settings, or copy its program and change it.",
  inputSchema: {
    type: "object",
    properties: {
      want: { type: "string", description: "What you want to show, in plain words." },
      name: { type: "string", description: "One piece by name, to see it whole with its program." },
    },
  },
  async run(input, ctx) {
    const { pieces, broken } = loadShelf();
    const name = typeof input.name === "string" ? input.name.trim().toLowerCase() : "";
    const want = typeof input.want === "string" ? input.want.trim() : "";
    const brokenNote = broken.length ? `\n\nOn this person's shelf, left out because they cannot be read:\n- ${broken.join("\n- ")}` : "";
    if (name) {
      const p = pieces.find((x) => x.name === name);
      if (!p) return fail(`There is no piece called ${name}. The pieces: ${pieces.map((x) => x.name).join(", ")}.`);
      let example = "";
      try {
        const e = pieceExample(p);
        example = `\n\nA built scene that uses it (narration: "${e.narration}"; @N is its N-th word):\n${e.source}`;
      } catch {
        example = "";
      }
      const params = Object.entries(p.params).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
      return { text: `${describe(p)}${example}\n\nIts program, to adapt as your own (define it before the first state, then run it by your name):\nprogram my-${p.name} ${params}\n${p.source.trimEnd().split("\n").map((l) => `  ${l}`).join("\n")}\nend`, images: picture(p.folder) };
    }
    if (!want) {
      const sheet = await sheetImage(pieces, ctx.folder);
      return {
        text: `The shelf: ${pieces.length} pieces (find_piece with want shows the ones that fit with their pictures; with name, one in full).${sheet ? " The picture below shows every piece as its own small scene ends, with its name under it, in this order." : ""}\n${pieces.map((p) => `- ${p.name}${p.origin === "saved" ? " (saved)" : ""}: ${p.doc}`).join("\n")}${brokenNote}`,
        ...(sheet ? { images: [sheet] } : {}),
      };
    }
    const found = search(want, pieces);
    if (!found.length) {
      const nearest = pieces.map((piece) => ({ piece, score: score(piece, want) })).filter((f) => f.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
      noteMiss(want, nearest);
      return {
        text: `Nothing on the shelf fits "${want}" (no piece's name, tags or line meets most of those words${nearest.length ? `; nearest: ${nearest.map((f) => f.piece.name).join(", ")}` : ""}). It is noted, so the gaps show what to build next. Other words for the same thing may find one, and find_piece with no want lists every piece. Otherwise draw it yourself with a program; if it comes out good and general, save_piece keeps it for the next video.${brokenNote}`,
      };
    }
    const text = [
      `Pieces that fit "${want}", best first (shipped with Open Sourcebook and saved on this person's shelf together; the pictures below are in the same order, each the end of a small scene that uses it):`,
      ...found.map((f, i) => describe(f.piece, i + 1)),
      "",
      "Settings you leave out keep their defaults. find_piece with name shows a piece's program, to change it into your own.",
    ].join("\n");
    return { text: text + brokenNote, images: found.flatMap((f) => picture(f.piece.folder)) };
  },
};

export const savePieceTool: Tool = {
  name: "save_piece",
  description:
    "Keep a program you wrote in a beat on this person's shelf, so find_piece offers it in the next video. Worth it when it came out good and is general: what changes from one use to the next (labels, values, how many, when) comes in as settings, and it draws inside whatever box it is given. The answer says what code sees that would make it more reusable (words or numbers of this video in its code, no settings, sizes it breaks at); it is saved either way, with those notes.",
  inputSchema: {
    type: "object",
    properties: {
      beat: { type: "string", description: "The beat whose scene defines the program." },
      program: { type: "string", description: "The program's name in that scene." },
      name: { type: "string", description: "Its name on the shelf: lowercase letters, digits and hyphens." },
      about: { type: "string", description: "In a line: what it shows and when to use it, as a search would look for it." },
      tags: { type: "array", items: { type: "string" }, description: "Words someone looking for it might use." },
      params: { type: "object", additionalProperties: { type: "string" }, description: "What each setting means, by its name." },
      replace: { type: "boolean", description: "Save over a saved piece of the same name." },
    },
    required: ["beat", "program", "name", "about"],
  },
  async run(input, ctx) {
    const beat = String(input.beat ?? "").trim();
    const source = ctx.draft.scenes[beat]?.source;
    if (!source) return fail(`There is no beat "${beat}" with a scene.`);
    const program = programIn(source, String(input.program ?? "").trim());
    if (!program) return fail(`${beat}'s scene has no program called "${String(input.program ?? "")}".`);
    const params = typeof input.params === "object" && input.params !== null ? Object.fromEntries(Object.entries(input.params as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {};
    const tags = Array.isArray(input.tags) ? input.tags.map(String).slice(0, 30) : [];
    const r = await savePiece({ name: String(input.name ?? ""), about: String(input.about ?? ""), tags, params, program, style: ctx.request.style !== "auto" ? ctx.request.style : (ctx.draft.style ?? ctx.draft.script?.style ?? ctx.styles[0]!.id), replace: input.replace === true }, ctx.folder);
    if (!r.ok) return fail(r.text);
    return { text: r.text, ...(r.picture ? { images: [{ mimeType: "image/jpeg", dataBase64: jpegBase64(r.picture) }] } : {}) };
  },
};

export const SHELF_TOOLS: Tool[] = [findPiece, savePieceTool];
