/**
 * A source's plain text cut into what the reader draws: paragraphs (a blank
 * line apart), headings (a paragraph opening with `## ` or `### `, as the
 * engine marks a PDF's larger lines) and page breaks (a form feed on its own
 * line). Each block keeps the character span it covers in the text, so a
 * cited spot is marked at its exact words wherever it falls.
 */
export type PaperBlock =
  | { kind: "paragraph"; start: number; end: number }
  | { kind: "heading"; level: 2 | 3; start: number; end: number }
  | { kind: "page"; start: number; end: number };

export function paperBlocks(text: string): PaperBlock[] {
  const blocks: PaperBlock[] = [];
  const part = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  for (let m = part.exec(text); m; m = part.exec(text)) {
    const raw = m[0];
    const start = m.index;
    if (raw.replace(/[ \t\r]/g, "") === "\f") {
      blocks.push({ kind: "page", start, end: start + raw.length });
      continue;
    }
    const lead = raw.length - raw.trimStart().length;
    const heading = /^(#{2,3}) (?=\S)/.exec(raw.trimStart());
    if (heading && !raw.includes("\n")) blocks.push({ kind: "heading", level: heading[1]!.length as 2 | 3, start: start + lead + heading[0].length, end: start + raw.length });
    else blocks.push({ kind: "paragraph", start, end: start + raw.length });
  }
  return blocks;
}
