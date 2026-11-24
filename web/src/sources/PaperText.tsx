import { useMemo, type ReactNode, type Ref } from "react";
import { paperBlocks, type PaperBlock } from "./paperBlocks";

/**
 * A source's plain text as the reader draws it: its paragraphs apart, its
 * headings as headings, a quiet line where a page ends, and the cited spot
 * marked at its exact words (`mark` gets the first piece of it, to scroll to).
 */
export function PaperText({ text, marked, mark, title, cite }: { text: string; marked: [number, number] | undefined; mark: Ref<HTMLElement>; /** The reader's own title: a first heading that says the same is not said twice. */ title?: string; /** The cite number the marked spot was opened from, drawn beside it. */ cite?: number }) {
  const blocks = useMemo(() => {
    let page = 1;
    const all = paperBlocks(text).map((b) => ({ ...b, page: b.kind === "page" ? ++page : page }));
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    return all[0]?.kind === "heading" && title && same(text.slice(all[0].start, all[0].end), title) ? all.slice(1) : all;
  }, [text, title]);
  const on = (b: PaperBlock) => marked !== undefined && marked[1] > b.start && marked[0] < b.end;
  const firstOn = blocks.find(on);
  /** A block's words, with the part inside the marked span in a mark. */
  const words = (b: PaperBlock): ReactNode => {
    if (!marked || !on(b)) return text.slice(b.start, b.end);
    const from = Math.max(b.start, marked[0]);
    const to = Math.min(b.end, marked[1]);
    const ref = b === firstOn ? { ref: mark, ...(cite !== undefined ? { "data-cite": cite } : {}) } : {};
    return (
      <>
        {text.slice(b.start, from)}
        <mark className="spot" {...ref}>
          {text.slice(from, to)}
        </mark>
        {text.slice(to, b.end)}
      </>
    );
  };
  return (
    <div className="paper-text">
      {blocks.map((b) => {
        if (b.kind === "page")
          return (
            <p key={b.start} className="pg">
              Page {b.page}
            </p>
          );
        if (b.kind === "heading") {
          const Tag = b.level === 2 ? "h4" : "h5";
          return <Tag key={b.start}>{words(b)}</Tag>;
        }
        return (
          <p key={b.start} className="body">
            {words(b)}
          </p>
        );
      })}
    </div>
  );
}
