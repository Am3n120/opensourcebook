/**
 * A small Markdown reader for sources written in it (an uploaded `.md`, pasted
 * notes): headings, paragraphs, lists, quotes, code and rules, each block with
 * the character span it came from, so a cited spot can still be marked.
 * Inline marks inside a block use the cards' grammar (player/inlineMarks.ts).
 * Nothing becomes HTML: blocks are data the reader draws as elements.
 */
export type MdBlock =
  | { kind: "heading"; level: number; text: string; start: number; end: number }
  | { kind: "paragraph" | "quote"; text: string; start: number; end: number }
  | { kind: "list"; ordered: boolean; items: string[]; start: number; end: number }
  | { kind: "code"; text: string; start: number; end: number }
  | { kind: "rule"; start: number; end: number };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

/** Whether a source reads as Markdown: named so, or text with Markdown headings. */
export function looksLikeMarkdown(name: string | undefined, kind: string, text: string): boolean {
  if (name && /\.(md|markdown)$/i.test(name.trim())) return true;
  return kind === "text" && /^#{1,6}\s+\S/m.test(text);
}

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines: Array<{ line: string; start: number; end: number }> = [];
  let at = 0;
  for (const line of text.split("\n")) {
    lines.push({ line, start: at, end: at + line.length });
    at += line.length + 1;
  }
  let i = 0;
  while (i < lines.length) {
    const { line, start } = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const fence = FENCE.exec(line)![1]!;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]!.line.trim().startsWith(fence)) body.push(lines[j++]!.line);
      const last = lines[Math.min(j, lines.length - 1)]!;
      blocks.push({ kind: "code", text: body.join("\n"), start, end: last.end });
      i = j + 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!, start, end: lines[i]!.end });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule", start, end: lines[i]!.end });
      i++;
      continue;
    }
    if (ITEM.test(line)) {
      const ordered = /\d/.test(ITEM.exec(line)![1]!);
      const items: string[] = [];
      let end = start;
      while (i < lines.length && lines[i]!.line.trim()) {
        const m = ITEM.exec(lines[i]!.line);
        if (m && /\d/.test(m[1]!) === ordered) items.push(m[2]!);
        else if (m || HEADING.test(lines[i]!.line)) break;
        // A line that continues the item above it.
        else if (items.length) items[items.length - 1] += ` ${lines[i]!.line.trim()}`;
        end = lines[i]!.end;
        i++;
      }
      blocks.push({ kind: "list", ordered, items, start, end });
      continue;
    }
    const quote = /^\s*>/.test(line);
    const parts: string[] = [];
    let end = start;
    while (i < lines.length) {
      const l = lines[i]!.line;
      if (!l.trim() || HEADING.test(l) || FENCE.test(l) || RULE.test(l) || (!quote && ITEM.test(l)) || /^\s*>/.test(l) !== quote) break;
      parts.push((quote ? l.replace(/^\s*>\s?/, "") : l).trim());
      end = lines[i]!.end;
      i++;
    }
    blocks.push({ kind: quote ? "quote" : "paragraph", text: parts.join(" "), start, end });
  }
  return blocks;
}
