/**
 * Inline marks in a card's body text (engine/docs/flashcards.md, "Inline marks"):
 * **bold**, *italic*, `code`, [label](https://…) links and $math$. The same
 * small grammar as the phone's InlineMarkdown: not nested, and a marker with
 * no closing partner is shown as typed. A link opens only an http or https
 * address; anything else shows its label as plain text.
 */
export type InlineRun =
  | { kind: "text"; text: string }
  | { kind: "bold" | "italic" | "code" | "math"; text: string }
  | { kind: "link"; text: string; href: string }
  /** Words linked to a cited spot in a chat reply, `[words](cite:N)`: N indexes the reply's cites. */
  | { kind: "spot"; text: string; cite: number };

export function parseInline(source: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const push = (run: InlineRun) => {
    const last = runs[runs.length - 1];
    if (run.kind === "text" && last?.kind === "text") last.text += run.text;
    else runs.push(run);
  };
  let rest = source;
  while (rest.length > 0) {
    const pair = (open: string, kind: "bold" | "italic" | "code") => {
      if (!rest.startsWith(open)) return false;
      const close = rest.indexOf(open, open.length);
      if (close < 0) return false;
      push({ kind, text: rest.slice(open.length, close) });
      rest = rest.slice(close + open.length);
      return true;
    };
    if (pair("**", "bold") || pair("*", "italic") || pair("`", "code")) continue;
    if (rest.startsWith("$")) {
      const close = rest.indexOf("$", 1);
      const inner = close > 0 ? rest.slice(1, close) : "";
      // "$5 and $10" is money, not math: math has no space just inside its markers.
      if (inner && !/^\s/.test(inner) && !/\s$/.test(inner)) {
        push({ kind: "math", text: inner });
        rest = rest.slice(close + 1);
      } else {
        push({ kind: "text", text: "$" });
        rest = rest.slice(1);
      }
      continue;
    }
    if (rest.startsWith("[")) {
      const labelEnd = rest.indexOf("](");
      const urlEnd = labelEnd > 0 ? rest.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd > 0 && urlEnd > 0) {
        const href = rest.slice(labelEnd + 2, urlEnd);
        const text = rest.slice(1, labelEnd);
        const spot = /^cite:(\d+)$/.exec(href);
        push(spot ? { kind: "spot", text, cite: Number(spot[1]) } : /^https?:\/\/\S+$/i.test(href) ? { kind: "link", text, href } : { kind: "text", text });
        rest = rest.slice(urlEnd + 1);
        continue;
      }
    }
    const next = rest.slice(1).search(/[*`[$]/);
    const end = next < 0 ? rest.length : next + 1;
    push({ kind: "text", text: rest.slice(0, end) });
    rest = rest.slice(end);
  }
  return runs;
}

/**
 * A quote from a source as words to show and say: the source's own Markdown
 * (**, *, __, `, # headings, > quotes, list marks and link syntax) taken out.
 * A quote is a slice of the source, so a marker often has no partner; every
 * marker goes, paired or not. The raw quote still finds the spot in the source.
 */
export function quoteWords(quote: string): string {
  return quote
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^(?:[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-+*][ \t]+|\d+\.[ \t]+))+/gm, "")
    .replace(/\*+|_{2,}|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
